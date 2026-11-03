import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Blocks, Context, Lang, Limit, Settings, View, Warm, WarmMax } from '../types'
import { LANG_NAMES, TEXT } from './i18n'
import type { Strings } from './i18n'

const limits = atom({ plugin: 'gmdi-token-meter', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'gmdi-token-meter', key: 'context' } as const, null as Context | null)
const costUsd = atom({ plugin: 'gmdi-token-meter', key: 'costUsd' } as const, null as number | null)
const startedAt = atom({ plugin: 'gmdi-token-meter', key: 'startedAt' } as const, null as number | null)
const lastReplyAt = atom({ plugin: 'gmdi-token-meter', key: 'lastReplyAt' } as const, null as number | null)
const model = atom({ plugin: 'gmdi-token-meter', key: 'model' } as const, null as string | null)
// The person's choices; null until session.start has read them from the store.
const settings = atom({ plugin: 'gmdi-token-meter', key: 'settings' } as const, null as Settings | null)
const view = atom({ plugin: 'gmdi-token-meter', key: 'view' } as const, 'closed' as View)
// Bumped by a timer so the countdowns redraw while the session is idle.
const tick = atom({ plugin: 'gmdi-token-meter', key: 'tick' } as const, 0)
const warm = atom({ plugin: 'gmdi-token-meter', key: 'warm' } as const, { paused: false, done: 0, lastAt: null } as Warm)

// A details fact: colored, plain (strong) or dim.
type Fact = { text: string; color?: string; strong?: boolean }

// Each setting has a store key of its own ('lang', 'ttl', 'show.week', …), so a
// change in one session never overwrites what another session changed. The one
// object under 'settings' is how 0.1 kept them: read as the base, never written.
const LEGACY_KEY = 'settings'
type SettingKey = 'lang' | 'ttl' | 'warm.max' | `show.${keyof Blocks}`
const DOTS = 10
const DIM = '#5b5b5b'
// The details' label column, in cells: fits «Тиждень» / «Session» and a gap.
const LABEL_WIDTH = 9
const WINDOWS: Record<string, { strings: 'week' | 'fiveHour'; ms: number }> = {
  seven_day: { strings: 'week', ms: 7 * 24 * 3_600_000 },
  five_hour: { strings: 'fiveHour', ms: 5 * 3_600_000 },
}
const BAND_BLOCKS: readonly (keyof Blocks)[] = ['label', 'week', 'fiveHour', 'reset', 'words', 'cache', 'price']
const DETAIL_BLOCKS: readonly (keyof Blocks)[] = ['forecast', 'priceDetails', 'models', 'session']

// The warmer: a short prompt a few minutes before the cache would cool reads the whole
// context from the cache, which keeps it warm for another TTL at a fraction of a rewrite.
const WARM_CHOICES: readonly WarmMax[] = [0, 2, 4, 8]
// A context this small is cheap to cache again: warming it is not worth a turn.
const WARM_MIN_TOKENS = 20_000
// Below these shares left the warmer stands down: the plan's limits matter more than the cache.
const WARM_FLOOR: Record<string, number> = { five_hour: 10, seven_day: 5 }

const defaults = (ttl: '1h' | '5m'): Settings => ({
  lang: 'uk',
  ttl,
  warmMax: 4,
  show: { label: true, week: true, fiveHour: true, reset: true, words: true, cache: true, price: true, forecast: true, priceDetails: true, models: true, session: true },
})

// A stored value may come from an older version or be damaged: every field is
// checked, and one that is missing or of the wrong type falls back to the default.
const withDefaults = (stored: unknown, ttl: '1h' | '5m'): Settings => {
  const base = defaults(ttl)
  if (!stored || typeof stored !== 'object') return base
  const s = stored as { lang?: unknown; ttl?: unknown; warmMax?: unknown; show?: unknown }
  const shown = s.show && typeof s.show === 'object' ? (s.show as Record<string, unknown>) : {}
  const show = { ...base.show }
  for (const key of Object.keys(show) as (keyof Blocks)[]) {
    const value = shown[key]
    if (typeof value === 'boolean') show[key] = value
  }
  return {
    lang: s.lang === 'en' || s.lang === 'uk' ? s.lang : base.lang,
    ttl: s.ttl === '5m' || s.ttl === '1h' ? s.ttl : base.ttl,
    warmMax: WARM_CHOICES.find(n => n === s.warmMax) ?? base.warmMax,
    show,
  }
}

// What the one-line band draws, cut down step by step until it fits the width:
// the least useful first, down to bare percentages and the cache badge.
type Fit = { label: boolean; words: boolean; reset: boolean; dots: number; timer: boolean; price: boolean }

const FIT_STEPS: readonly Partial<Fit>[] = [
  {},
  { words: false },
  { reset: false },
  { dots: 5 },
  { label: false },
  { timer: false },
  { price: false },
  { dots: 0 },
]

const span = (ms: number, t: Strings): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const u = t.units

  if (days > 0) return `${days}${u.d} ${hours}${u.h}`
  if (hours > 0) return `${hours}${u.h} ${String(mins).padStart(2, '0')}${u.m}`
  return `${mins}${u.m}`
}

// Local time in Kyiv; plain UTC where the environment has no time zones.
const clockTime = (ms: number, t: Strings, withDay = false): string => {
  try {
    return new Intl.DateTimeFormat(t.locale, {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      minute: '2-digit',
      ...(withDay ? { weekday: 'short', day: '2-digit', month: '2-digit' } : {}),
    }).format(ms)
  } catch {
    const iso = new Date(ms).toISOString()
    return withDay ? `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)} UTC` : `${iso.slice(11, 16)} UTC`
  }
}

// List prices, $ per million input tokens: a plain input and a cache read.
// A cache write costs the input price × 2 with the 1h TTL, × 1.25 with 5m.
// `above`: the dearer tier for a prompt longer than its `tokens` (Haiku 5.5 past 100K).
// First match wins, so a longer id comes before its prefix.
type Rate = { input: number; read: number }
const PRICES: readonly ({ match: string; above?: Rate & { tokens: number } } & Rate)[] = [
  { match: 'fable', input: 10, read: 0.25 },
  { match: 'mythos', input: 10, read: 0.25 },
  { match: 'opus-5-5', input: 4, read: 0.2 },
  { match: 'opus', input: 5, read: 0.5 },
  { match: 'sonnet-5', input: 2, read: 0.2 },
  { match: 'sonnet', input: 3, read: 0.3 },
  { match: 'haiku-5-5', input: 0.1, read: 0.01, above: { tokens: 100_000, input: 0.5, read: 0.05 } },
  { match: 'haiku', input: 1, read: 0.1 },
]

const priceOf = (id: string | null) => PRICES.find(p => (id ?? 'opus-5-5').toLowerCase().includes(p.match)) ?? PRICES[2]!

// The rate a prompt of `tokens` pays on model `id`.
const rateOf = (id: string | null, tokens: number): Rate => {
  const p = priceOf(id)
  return p.above && tokens > p.above.tokens ? p.above : p
}

// The current models the details compare: what the context costs to cache on each.
const COMPARE: readonly { id: string; name: string }[] = [
  { id: 'claude-fable-5-1', name: 'Fable' },
  { id: 'claude-opus-5-5', name: 'Opus' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet' },
  { id: 'claude-haiku-5-5', name: 'Haiku' },
]

const ttlMsOf = (s: Settings): number => (s.ttl === '5m' ? 5 * 60_000 : 60 * 60_000)

// What the warmer does about this session now; `armed` with the time of its next prompt.
type WarmStatus =
  | { kind: 'off' }
  | { kind: 'paused' }
  | { kind: 'cold' }
  | { kind: 'spent' }
  | { kind: 'small' }
  | { kind: 'limits'; window: 'week' | 'fiveHour' }
  | { kind: 'armed'; at: number }

const warmStatus = (s: Settings, w: Warm, replyAt: number | null, now: number, ctxTokens: number, rows: readonly Limit[]): WarmStatus => {
  if (s.warmMax === 0) return { kind: 'off' }
  if (w.paused) return { kind: 'paused' }
  const ttlMs = ttlMsOf(s)
  // A cache already cold has nothing left to keep: the next request rewrites it anyway.
  if (replyAt === null || now >= replyAt + ttlMs) return { kind: 'cold' }
  if (w.done >= s.warmMax) return { kind: 'spent' }
  if (ctxTokens < WARM_MIN_TOKENS) return { kind: 'small' }
  for (const r of rows) {
    const floor = WARM_FLOOR[r.kind]
    if (floor !== undefined && 100 - r.percentUsed < floor) return { kind: 'limits', window: WINDOWS[r.kind]!.strings }
  }
  return { kind: 'armed', at: replyAt + ttlMs - (s.ttl === '5m' ? 60_000 : 5 * 60_000) }
}

const usd = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const tone = (left: number): string => (left >= 80 ? '#f5c518' : left >= 40 ? '#f07a1a' : '#e5484d')

const save = async (
  $: EngineInterface,
  figures: { rateLimits: readonly SessionRateLimit[]; context: SessionContextUsage; cost?: SessionCost },
) => {
  await update($, limits, () => figures.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })))
  await update($, context, () => ({ tokens: figures.context.tokens, window: figures.context.window, percent: figures.context.percent }))
  await update($, costUsd, () => figures.cost?.usd ?? null)
}

const valueOf = (s: Settings, key: SettingKey): unknown =>
  key === 'lang' ? s.lang : key === 'ttl' ? s.ttl : key === 'warm.max' ? s.warmMax : s.show[key.slice('show.'.length) as keyof Blocks]

const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Reads the settings: the legacy object first, each own key over it, every field checked.
// The store failing leaves the defaults and a toast; the band works on regardless.
async function loadSettings($: EngineInterface, ttl: '1h' | '5m'): Promise<Settings> {
  try {
    const keys = new Set(await $.store.keys())
    const legacy = keys.has(LEGACY_KEY) ? await $.store.get(LEGACY_KEY) : undefined
    const raw: { lang?: unknown; ttl?: unknown; warmMax?: unknown; show: Record<string, unknown> } = {
      ...(legacy && typeof legacy === 'object' ? (legacy as object) : {}),
      show: { ...((legacy as { show?: object } | undefined)?.show ?? {}) },
    }
    if (keys.has('lang')) raw.lang = await $.store.get('lang')
    if (keys.has('ttl')) raw.ttl = await $.store.get('ttl')
    if (keys.has('warm.max')) raw.warmMax = await $.store.get('warm.max')
    for (const block of Object.keys(defaults(ttl).show)) {
      if (keys.has(`show.${block}`)) raw.show[block] = await $.store.get(`show.${block}`)
    }
    return withDefaults(raw, ttl)
  } catch (err) {
    $.ui.toast(TEXT.uk.loadFailed(why(err)))
    return defaults(ttl)
  }
}

// Store writes, one after another, so an older value never lands last.
let saving: Promise<void> = Promise.resolve()

// Writes the changed keys, as the band now shows them, for later sessions. A failed
// write is told in a toast: the band keeps the change for this session only.
async function persist($: EngineInterface, keys: readonly SettingKey[]) {
  const latest = (await read($, settings)) as Settings | null
  if (!latest) return
  try {
    for (const key of keys) await $.store.set(key, valueOf(latest, key))
  } catch (err) {
    $.ui.toast(TEXT[latest.lang].saveFailed(why(err)))
  }
}

// Changes one setting and redraws the band with it. `fn` runs on the value as it
// stands at the write (update retries on a conflict), so two quick presses both land.
async function change($: EngineInterface, ttl: '1h' | '5m', key: SettingKey, fn: (s: Settings) => Settings) {
  await update($, settings, s => fn((s as Settings | null) ?? defaults(ttl)))
  saving = saving.then(() => persist($, [key]))
  await saving
}

// The main loop got a response: the prompt cache was read or written just now.
async function touch($: EngineInterface) {
  const now = await $.clock.now()
  await update($, lastReplyAt, () => now)
}

// The model the next request goes to (a /model switch included): the price follows it.
async function refreshModel($: EngineInterface) {
  const id = await $.session.model()
  await update($, model, () => id)
}

// The main loop's turn is running; the warmer's prompt is waiting for its turn to end.
// Module state: a reload clears both, and the next turn.start or turn.complete sets them right.
let busy = false
let warming = false

// Sends the warmer's prompt once the session is idle and its next warm-up is due.
async function maybeWarm($: EngineInterface) {
  if (busy || warming) return
  const cfg = (await read($, settings)) as Settings | null
  if (!cfg) return
  const now = await $.clock.now()
  const w = (await read($, warm)) as Warm
  const status = warmStatus(cfg, w, await read($, lastReplyAt), now, (await read($, context))?.tokens ?? 0, await read($, limits))
  if (status.kind !== 'armed' || now < status.at) return

  warming = true
  let n = w.done + 1
  await update($, warm, s => {
    n = s.done + 1
    return { ...s, done: n, lastAt: now }
  })
  const t: Strings = TEXT[cfg.lang]
  try {
    const sent = await $.prompt.submit({ text: t.warmPrompt(n, cfg.warmMax) })
    if (sent.drop !== undefined) warming = false
  } catch (err) {
    warming = false
    $.ui.toast(t.warmFailed(why(err)))
  }
}

// The timer's work: a fresh model, a redraw for the countdowns, and the warmer.
async function onTick($: EngineInterface) {
  await refreshModel($)
  await update($, tick, n => n + 1)
  await maybeWarm($)
}

// The TTL the login gives: an API key caches for 5 minutes, a subscription for an hour.
// No first-party login, or the engine refusing to tell, leaves the configured one.
async function loginTtl($: EngineInterface, configured: '1h' | '5m'): Promise<'1h' | '5m'> {
  if (configured === '5m') return '5m'
  try {
    return (await $.session.authorize())?.kind === 'api-key' ? '5m' : configured
  } catch {
    return configured
  }
}

export const register: Register = (on, options) => {
  const configuredTtl = options.cache_ttl === '5m' ? '5m' : '1h'
  let defaultTtl: '1h' | '5m' = configuredTtl

  // The timer starts first: a store or an engine call that fails must not leave the band frozen.
  // A TTL picked in ⚙ (the store's 'ttl') still wins over the one the login gives.
  on('session.start', async ($, e, next) => {
    $.clock.every(30_000, () => void onTick($))
    defaultTtl = await loginTtl($, configuredTtl)
    const loaded = await loadSettings($, defaultTtl)
    await update($, settings, () => loaded)
    const usage = await $.session.usage()
    await save($, usage)
    await update($, startedAt, () => usage.startedAt)
    await refreshModel($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await save($, e)
    await refreshModel($)

    return next(e)
  })

  // Only a turn the API answered warms the cache: an interrupt or an API error
  // carries no usage, and leaves the cache as it was.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      busy = false
      warming = false
    }
    if (!e.agentId && e.usage) {
      await touch($)
      await refreshModel($)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) busy = true

    return next(e)
  })

  // Every prompt but the warmer's own (a plugin's submit skips its own hooks) means
  // the session is in use again: the warm-ups start counting from zero.
  on('prompt.submit', async ($, e, next) => {
    await update($, warm, s => (s.done === 0 ? s : { ...s, done: 0 }))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    await read($, tick)
    const cfg: Settings = ((await read($, settings)) as Settings | null) ?? defaults(defaultTtl)
    const t: Strings = TEXT[cfg.lang]
    const show: Blocks = cfg.show
    const rows = await read($, limits)
    const replyAt = await read($, lastReplyAt)
    const mode = await read($, view)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)
    const ttlMs = ttlMsOf(cfg)

    const ctx = await read($, context)
    const modelId = await read($, model)
    const ctxTokens = ctx?.tokens ?? 0
    const w = (await read($, warm)) as Warm
    const warmNow = warmStatus(cfg, w, replyAt, now, ctxTokens, rows)

    const cacheLeft = replyAt === null ? 0 : replyAt + ttlMs - now
    const isWarm = cacheLeft > 0
    const cacheColor = isWarm ? '#e5484d' : '#4c8dff'
    // While Claude works its requests write the cache, so the countdown gives way to «working».
    // Cold after a reply, the timer counts the idle time since that reply.
    const fullTimer = !show.cache
      ? null
      : e.props.isWorking
        ? t.working
        : isWarm
          ? t.timeLeft(span(cacheLeft, t))
          : replyAt !== null
            ? t.idle(span(now - replyAt, t))
            : null

    // What the next request's input costs: the context read from a warm cache,
    // or written to it again once it has gone cold.
    const writeMult = cfg.ttl === '5m' ? 1.25 : 2
    const price = rateOf(modelId, ctxTokens)
    const warmUsd = (ctxTokens * price.read) / 1e6
    const coldUsd = (ctxTokens * price.input * writeMult) / 1e6
    // The line shows only what a long pause will cost (after the arrow); the details show both.
    const fullPrice = !show.price || ctxTokens === 0 ? null : isWarm ? `→ ${usd(coldUsd)}` : t.resume(usd(coldUsd))
    // ↻N beside the timer: the warmer will keep this cache warm N more times. It goes with the timer.
    const fullMark = show.cache && isWarm && warmNow.kind === 'armed' ? t.warmMark(cfg.warmMax - w.done) : null

    // Width of the line in cells for a given fit, as the layout below draws it.
    const meterWidth = (kind: string, fit: Fit) => {
      const label = t[WINDOWS[kind]!.strings].short
      const limit = rows.find(r => r.kind === kind)
      if (!limit) return label.length + 2
      const left = Math.max(0, Math.round(100 - limit.percentUsed))
      const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
      const reset = fit.reset && Number.isFinite(resetIn) ? 1 + `· ${span(resetIn, t)}`.length : 0
      return label.length + (fit.dots > 0 ? 1 + fit.dots : 0) + 1 + t.left(left, fit.words).length + reset
    }
    const lineWidth = (fit: Fit) => {
      const timer = fit.timer ? fullTimer : null
      const mark = fit.timer ? fullMark : null
      const price = fit.price ? fullPrice : null
      const cache =
        (show.cache ? (isWarm ? t.warm : t.cold).length : 0) +
        (timer ? 1 + timer.length : 0) +
        (mark ? 1 + mark.length : 0) +
        (price ? 1 + price.length : 0)
      const items = [
        3,
        fit.label ? t.label.length : 0,
        show.week ? meterWidth('seven_day', fit) : 0,
        show.fiveHour ? meterWidth('five_hour', fit) : 0,
        cache,
      ].filter(w => w > 0)
      return items.reduce((sum, w) => sum + w, 0) + items.length - 1
    }
    // The person's choices first; each step then gives up one more thing until the line fits.
    // Below the last step (about 25 columns) the line wraps: nothing more is worth dropping.
    let fit: Fit = { label: show.label, words: show.words, reset: show.reset, dots: DOTS, timer: true, price: true }
    for (const step of FIT_STEPS) {
      fit = {
        label: fit.label && step.label !== false,
        words: fit.words && step.words !== false,
        reset: fit.reset && step.reset !== false,
        dots: step.dots ?? fit.dots,
        timer: fit.timer && step.timer !== false,
        price: fit.price && step.price !== false,
      }
      if (lineWidth(fit) <= e.props.bodyColumns) break
    }
    const timerText = fit.timer ? fullTimer : null
    const markText = fit.timer ? fullMark : null
    const priceText = fit.price ? fullPrice : null

    const meter = (kind: string) => {
      const label = t[WINDOWS[kind]!.strings].short
      const limit = rows.find(r => r.kind === kind)

      if (!limit) {
        return (
          <Box key={kind} flexDirection="row" gap={1}>
            <Text dimColor>{label}</Text>
            <Text color={DIM}>—</Text>
          </Box>
        )
      }

      const left = Math.max(0, Math.round(100 - limit.percentUsed))
      const filled = Math.round((left / 100) * fit.dots)
      const color = tone(left)
      const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN

      return (
        <Box key={kind} flexDirection="row" gap={1}>
          <Text dimColor>{label}</Text>
          {fit.dots > 0 ? (
            <Text>
              <Text color={color}>{'●'.repeat(filled)}</Text>
              <Text color={DIM}>{'·'.repeat(fit.dots - filled)}</Text>
            </Text>
          ) : null}
          <Text color={color} weight="semibold" tabular>{t.left(left, fit.words)}</Text>
          {fit.reset && Number.isFinite(resetIn) ? <Text dimColor tabular>{`· ${span(resetIn, t)}`}</Text> : null}
        </Box>
      )
    }

    const toggleView = () => void update($, view, v => (v === 'closed' ? 'details' : 'closed'))

    // The desktop draws a Button's children without their colors, so only the
    // leading arrow is the toggle (first, so a wrap never strands it) and the meters stay plain Text.
    const line = (
      <Box flexDirection="row" alignItems="center" columnGap={1} rowGap={0} flexWrap="wrap">
        <Button key="toggle" plain dimColor label={mode === 'closed' ? '▾' : '▴'} onPress={toggleView} />
        {fit.label ? <Text weight="bold" dimColor>{t.label}</Text> : null}
        {show.week ? meter('seven_day') : null}
        {show.fiveHour ? meter('five_hour') : null}
        {show.cache || priceText ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            {show.cache ? <Text backgroundColor={cacheColor} color="#ffffff" weight="bold">{isWarm ? t.warm : t.cold}</Text> : null}
            {timerText ? <Text color={e.props.isWorking ? DIM : cacheColor} tabular>{timerText}</Text> : null}
            {markText ? <Text dimColor tabular>{markText}</Text> : null}
            {priceText ? <Text dimColor tabular>{priceText}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )

    if (mode === 'closed') {
      return line
    }

    if (mode === 'settings') {
      const choice = (key: string, label: string, isOn: boolean, onPress: () => void) => (
        <Button key={key} plain dimColor={!isOn} label={`${isOn ? '●' : '○'} ${label}`} onPress={onPress} />
      )
      const check = (block: keyof Blocks) => (
        <Button
          key={`show-${block}`}
          plain
          dimColor={!show[block]}
          label={`${show[block] ? '☑' : '☐'} ${t.blocks[block]}`}
          onPress={() => void change($, defaultTtl, `show.${block}`, s => ({ ...s, show: { ...s.show, [block]: !s.show[block] } }))}
        />
      )
      const row = (title: string, items: RenderChildren[]) => (
        <Box flexDirection="row" alignItems="center" columnGap={1} rowGap={0} flexWrap="wrap">
          <Text dimColor size="footnote">{`${title}:`}</Text>
          {items}
        </Box>
      )

      return (
        <Box flexDirection="column">
          {line}
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Button key="open-details" plain dimColor label={t.backToDetails} onPress={() => void update($, view, () => 'details')} />
            <Text weight="semibold" size="footnote">{t.settingsTitle}</Text>
          </Box>
          {row(t.langRow, (['uk', 'en'] as Lang[]).map(l => choice(`lang-${l}`, LANG_NAMES[l], cfg.lang === l, () => void change($, defaultTtl, 'lang', s => ({ ...s, lang: l })))))}
          {row(t.ttlRow, (['1h', '5m'] as const).map(v => choice(`ttl-${v}`, v, cfg.ttl === v, () => void change($, defaultTtl, 'ttl', s => ({ ...s, ttl: v })))))}
          {row(t.warmRow, WARM_CHOICES.map(n => choice(`warm-${n}`, n === 0 ? t.warmChoiceOff : String(n), cfg.warmMax === n, () => void change($, defaultTtl, 'warm.max', s => ({ ...s, warmMax: n })))))}
          {row(t.bandRow, BAND_BLOCKS.map(check))}
          {row(t.detailsRow, DETAIL_BLOCKS.map(check))}
        </Box>
      )
    }

    const cost = await read($, costUsd)
    const since = await read($, startedAt)

    // One details row: a fixed-width label, then facts joined by « · ».
    const detail = (key: string, label: string, facts: readonly (Fact | null)[]) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text dimColor size="footnote" weight="semibold">{label}</Text>
        </Box>
        <Text size="footnote">
          {facts.filter((f): f is Fact => f !== null).map((f, i) => (
            <Text key={String(i)}>
              {i > 0 ? <Text color={DIM}>{' · '}</Text> : null}
              {f.color ? <Text color={f.color} tabular>{f.text}</Text> : <Text dimColor={!f.strong} tabular>{f.text}</Text>}
            </Text>
          ))}
        </Text>
      </Box>
    )

    const limitRow = (kind: string) => {
      const window = WINDOWS[kind]!
      const label = t[window.strings].name
      const limit = rows.find(r => r.kind === kind)
      if (!limit) {
        return detail(kind, label, [{ text: t.noData }])
      }

      const used = Math.round(limit.percentUsed)
      const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
      const facts: Fact[] = [{ text: t.used(used), color: tone(100 - used) }]

      if (Number.isFinite(resetAt)) {
        // Within a day «через …» says which day it is, so the time is enough.
        facts.push({ text: t.reset(clockTime(resetAt, t, resetAt - now >= 24 * 3_600_000), span(resetAt - now, t)) })
        const elapsed = (now - (resetAt - window.ms)) / window.ms
        if (show.forecast && elapsed >= 0.05 && elapsed < 1) {
          const projected = Math.round(limit.percentUsed / elapsed)
          facts.push(projected >= 100 ? { text: `${t.forecast(projected)} ⚠`, color: tone(0) } : { text: t.forecast(projected) })
        }
      }

      return detail(kind, label, facts)
    }

    const cacheFacts: Fact[] = [
      ...(replyAt === null
        ? [{ text: t.cacheNone[0], color: cacheColor }, { text: t.cacheNone[1] }]
        : isWarm
          ? [{ text: t.cacheWarm(clockTime(replyAt + ttlMs, t)), color: cacheColor }, { text: t.cacheWarmNote(clockTime(replyAt, t), cfg.ttl) }]
          : [{ text: t.cacheCold(clockTime(replyAt + ttlMs, t)), color: cacheColor }, { text: t.cacheColdNote }]),
      ...(e.props.isWorking ? [{ text: t.cacheWorking }] : []),
    ]

    const warmFacts: Fact[] =
      warmNow.kind === 'off'
        ? [{ text: t.warmOff, strong: true }, { text: t.warmOffNote }]
        : warmNow.kind === 'paused'
          ? [{ text: t.warmPaused, strong: true }]
          : warmNow.kind === 'cold'
            ? [{ text: w.done > 0 ? t.warmColdAfter(w.done) : t.warmCold }]
            : warmNow.kind === 'spent'
              ? [{ text: t.warmSpent(cfg.warmMax), color: '#f07a1a' }, { text: t.warmSpentNote }]
              : warmNow.kind === 'small'
                ? [{ text: t.warmSmall }]
                : warmNow.kind === 'limits'
                  ? [{ text: t.warmLimits(t[warmNow.window].short), color: '#f07a1a' }]
                  : [
                      { text: t.warmNext(clockTime(warmNow.at, t)), color: '#e5484d' },
                      { text: t.warmDone(w.done, cfg.warmMax), strong: true },
                      { text: t.warmCost(usd(warmUsd), usd(coldUsd)) },
                    ]
    const toggleWarm = () => void update($, warm, s => ({ ...s, paused: !(s as Warm).paused }))

    const priceFacts: Fact[] = isWarm
      ? [
          { text: t.priceNow(usd(warmUsd)), strong: true },
          { text: t.priceLater(usd(coldUsd)), color: '#f07a1a' },
          { text: t.priceTimes(Math.round(coldUsd / Math.max(warmUsd, 1e-9))) },
          { text: t.priceNote },
        ]
      : [{ text: t.priceFirst(usd(coldUsd)), color: '#f07a1a' }, { text: t.priceIfWarm(usd(warmUsd)) }, { text: t.priceNote }]

    // Each model keeps a cache of its own: its first request writes the whole context.
    const current = priceOf(modelId)
    const modelFacts: Fact[] = [
      ...COMPARE.map(m => {
        const writeUsd = (ctxTokens * rateOf(m.id, ctxTokens).input * writeMult) / 1e6
        return priceOf(m.id) === current
          ? { text: `${m.name} ${usd(writeUsd)} ${t.modelsCurrent}`, color: '#f07a1a' }
          : { text: `${m.name} ${usd(writeUsd)}`, strong: true }
      }),
      { text: t.modelsNote },
    ]

    const sessionFacts: (Fact | null)[] = [
      { text: (modelId ?? 'claude-opus-5-5').replace(/^claude-/, '') },
      ctx?.tokens !== undefined
        ? { text: t.context(tokens(ctx.tokens), tokens(ctx.window), ctx.percent !== undefined ? ` (${Math.round(ctx.percent)}%)` : '') }
        : null,
      since !== null ? { text: t.since(clockTime(since, t, true)) } : null,
      cost !== null ? { text: t.cost(`$${cost.toFixed(2)}`), strong: true } : null,
    ]

    return (
      <Box flexDirection="column">
        {line}
        {limitRow('seven_day')}
        {limitRow('five_hour')}
        {detail('cache', t.rows.cache, cacheFacts)}
        {detail('warm', t.rows.warm, warmFacts)}
        {show.priceDetails && ctxTokens > 0 ? detail('price', t.rows.price, priceFacts) : null}
        {show.models && ctxTokens > 0 ? detail('models', t.rows.models, modelFacts) : null}
        {show.session ? detail('session', t.rows.session, sessionFacts) : null}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Button key="open-settings" plain dimColor label={t.openSettings} onPress={() => void update($, view, () => 'settings')} />
          {cfg.warmMax > 0 ? <Button key="warm-pause" plain dimColor label={w.paused ? t.warmResume : t.warmPause} onPress={toggleWarm} /> : null}
        </Box>
      </Box>
    )
  })
}
