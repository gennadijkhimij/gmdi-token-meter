import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionCompacted,
  SessionCompactInput,
  SessionCompactResult,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type {
  Blocks,
  Budget,
  CompactAt,
  CompactMin,
  Compaction,
  CompactWindow,
  Context,
  Extra,
  Growth,
  Intro,
  Lang,
  Learned,
  Limit,
  Plan,
  Settings,
  Threshold,
  View,
  Warm,
  WarmMax,
  WarnAt,
} from '../types'
import { LANG_NAMES, TEXT } from './i18n'
import type { Strings } from './i18n'

const limits = atom({ plugin: 'gmdi-token-meter', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'gmdi-token-meter', key: 'context' } as const, null as Context | null)
const costUsd = atom({ plugin: 'gmdi-token-meter', key: 'costUsd' } as const, null as number | null)
const startedAt = atom({ plugin: 'gmdi-token-meter', key: 'startedAt' } as const, null as number | null)
const lastReplyAt = atom({ plugin: 'gmdi-token-meter', key: 'lastReplyAt' } as const, null as number | null)
// The model that gave that reply: the prompt cache is per model, so another one starts cold.
const replyModel = atom({ plugin: 'gmdi-token-meter', key: 'replyModel' } as const, null as string | null)
const model = atom({ plugin: 'gmdi-token-meter', key: 'model' } as const, null as string | null)
// The person's choices; null until session.start has read them from the store.
const settings = atom({ plugin: 'gmdi-token-meter', key: 'settings' } as const, null as Settings | null)
const view = atom({ plugin: 'gmdi-token-meter', key: 'view' } as const, 'closed' as View)
// Bumped by a timer so the countdowns redraw while the session is idle.
const tick = atom({ plugin: 'gmdi-token-meter', key: 'tick' } as const, 0)
const warm = atom({ plugin: 'gmdi-token-meter', key: 'warm' } as const, { paused: false, done: 0, lastAt: null } as Warm)
// How the session is signed in, which says where paid usage is read from.
const plan = atom({ plugin: 'gmdi-token-meter', key: 'plan' } as const, 'unknown' as Plan)
// A subscription's extra usage from the usage endpoint; null until read, or where there is none.
const extra = atom({ plugin: 'gmdi-token-meter', key: 'extra' } as const, null as Extra | null)
// An API key's spend this month on this computer, as the mod has counted it.
const spend = atom({ plugin: 'gmdi-token-meter', key: 'spend' } as const, null as number | null)
const NO_COMPACTION: Compaction = { state: 'idle', at: null, before: null, after: null, reason: null, auto: false, dismissedFor: null, autoFor: null }
// This session's last compaction, and what compactions on this computer came to (from the store).
const compaction = atom({ plugin: 'gmdi-token-meter', key: 'compaction' } as const, NO_COMPACTION)
const learned = atom({ plugin: 'gmdi-token-meter', key: 'learned' } as const, { after: null, out: null } as Learned)
// The engine's auto-compact threshold and how fast the context grows toward it.
const threshold = atom({ plugin: 'gmdi-token-meter', key: 'threshold' } as const, null as Threshold | null)
const growth = atom({ plugin: 'gmdi-token-meter', key: 'growth' } as const, { last: null, avg: null } as Growth)
// The getting-to-know-the-mod pages: this version, the one seen before, the page open.
const intro = atom({ plugin: 'gmdi-token-meter', key: 'intro' } as const, { version: null, from: null, page: 0, manual: false } as Intro)

// A details fact: colored, plain (strong) or dim.
type Fact = { text: string; color?: string; strong?: boolean }

// Each setting has a store key of its own ('lang', 'ttl', 'show.week', …), so a
// change in one session never overwrites what another session changed. The one
// object under 'settings' is how 0.1 kept them: read as the base, never written.
const LEGACY_KEY = 'settings'
type SettingKey = 'lang' | 'ttl' | 'warm.max' | 'warn.at' | 'money.budget' | 'compact.at' | 'compact.min' | 'compact.auto' | 'compact.window' | `show.${keyof Blocks}`
const DOTS = 10
const DIM = '#5b5b5b'
// The details' label column, in cells: fits «Тиждень» / «Session» and a gap.
const LABEL_WIDTH = 9
const WINDOWS: Record<string, { strings: 'week' | 'fiveHour'; ms: number }> = {
  seven_day: { strings: 'week', ms: 7 * 24 * 3_600_000 },
  five_hour: { strings: 'fiveHour', ms: 5 * 3_600_000 },
}
const BAND_BLOCKS: readonly (keyof Blocks)[] = ['label', 'week', 'fiveHour', 'reset', 'words', 'cache', 'price', 'money']
const DETAIL_BLOCKS: readonly (keyof Blocks)[] = ['forecast', 'priceDetails', 'models', 'session']

// The warmer: a short prompt a few minutes before the cache would cool reads the whole
// context from the cache, which keeps it warm for another TTL at a fraction of a rewrite.
const WARM_CHOICES: readonly WarmMax[] = [0, 2, 4, 8]
// A context this small is cheap to cache again: warming it is not worth a turn.
const WARM_MIN_TOKENS = 20_000
// Below these shares left the warmer stands down: the plan's limits matter more than the cache.
const WARM_FLOOR: Record<string, number> = { five_hour: 10, seven_day: 5 }

// Warnings. A limit window warns from the share picked in ⚙ and again at CRITICAL;
// paid usage warns once it starts, at a third, two thirds and 14/15 of its cap
// ($50 / $100 / $140 of $150) and at the cap. Each step is told once, in one session.
const WARN_CHOICES: readonly WarnAt[] = [0, 70, 80, 90]
const BUDGET_CHOICES: readonly Budget[] = [0, 50, 100, 150, 200, 500]
const CRITICAL = 95
const MONEY_SHARES: readonly number[] = [1 / 3, 2 / 3, 14 / 15]
// The endpoint Claude Code's own /usage reads: a subscription's windows and its extra usage.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_EVERY = 5 * 60_000

// Compacting while the cache is warm: the summarizer reads the context once at the cache price
// and writes a summary, so the next cold start rewrites only that summary and the system prompt.
const COMPACT_AT_CHOICES: readonly CompactAt[] = [0, 10, 15, 20]
const COMPACT_MIN_CHOICES: readonly CompactMin[] = [0.5, 1, 2, 5]
// Until a compaction on this computer has shown better: the context after one (system prompt,
// tools and summary) and the summary's length, in tokens.
const COMPACT_AFTER = 70_000
const COMPACT_OUT = 8_000
// The offer shows only where compacting and its cold start cost at most this share of a cold start.
const COMPACT_GAIN = 0.5
const STORE_AFTER = 'compact.learned.after'
const STORE_OUT = 'compact.learned.out'

// The engine's auto-compact window, set with its own /autocompact for the session's model (live, saved
// in the user's settings under modelSettings). It compacts at the window less a fixed 33k buffer;
// a window past the model's limit is capped to it. 0 leaves the engine's own.
const COMPACT_WINDOW_CHOICES: readonly CompactWindow[] = [0, 100_000, 200_000, 300_000, 400_000]
const RECOMMENDED_WINDOW: CompactWindow = 200_000
const COMPACT_BUFFER = 33_000
// The window the mod set for a model: 'compact.window.model.<model>' = 200000 (0: none). A key per
// model, so two sessions setting different models never overwrite each other's record.
const STORE_WINDOWS = 'compact.window.model.'
// The version whose getting-to-know pages the person has been through.
const STORE_INTRO = 'intro.seen'
// The version first installed, set before the mod stores anything else: tells a later version that
// it is an update, even when the pages were left for later.
const STORE_INTRO_NEW = 'intro.new'
// The getting-to-know pages: welcome or what is new, the band, cache and compacting, the threshold, the choice.
const INTRO_LAST = 4

const defaults = (ttl: '1h' | '5m'): Settings => ({
  lang: 'uk',
  ttl,
  warmMax: 4,
  warnAt: 80,
  budget: 0,
  compactAt: 15,
  compactMin: 1,
  compactAuto: false,
  compactWindow: 0,
  show: { label: true, week: true, fiveHour: true, reset: true, words: true, cache: true, price: true, money: true, forecast: true, priceDetails: true, models: true, session: true },
})

// A stored value may come from an older version or be damaged: every field is
// checked, and one that is missing or of the wrong type falls back to the default.
const withDefaults = (stored: unknown, ttl: '1h' | '5m'): Settings => {
  const base = defaults(ttl)
  if (!stored || typeof stored !== 'object') return base
  const s = stored as {
    lang?: unknown
    ttl?: unknown
    warmMax?: unknown
    warnAt?: unknown
    budget?: unknown
    compactAt?: unknown
    compactMin?: unknown
    compactAuto?: unknown
    compactWindow?: unknown
    show?: unknown
  }
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
    warnAt: WARN_CHOICES.find(n => n === s.warnAt) ?? base.warnAt,
    budget: BUDGET_CHOICES.find(n => n === s.budget) ?? base.budget,
    compactAt: COMPACT_AT_CHOICES.find(n => n === s.compactAt) ?? base.compactAt,
    compactMin: COMPACT_MIN_CHOICES.find(n => n === s.compactMin) ?? base.compactMin,
    compactAuto: typeof s.compactAuto === 'boolean' ? s.compactAuto : base.compactAuto,
    compactWindow: COMPACT_WINDOW_CHOICES.find(n => n === s.compactWindow) ?? base.compactWindow,
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

// List prices, $ per million tokens: a plain input and a cache read; output is five times the input.
// A cache write costs the input price × 2 with the 1h TTL, × 1.25 with 5m.
// `above`: the dearer tier for a prompt longer than its `tokens` (Haiku 5.5 past 100K).
// First match wins, so a longer id comes before its prefix.
type Rate = { input: number; read: number }
const OUTPUT_MULT = 5
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

// A limit row as it stands at `now`. The engine's figures come with each response, so a session
// left idle past a window's reset still holds the old share: that window has started afresh,
// and it counts as unused (with no next reset known) until the next response brings real ones.
type Row = Limit & { renewedAt?: number }
const liveRows = (rows: readonly Limit[], now: number): Row[] =>
  rows.map(r => {
    const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    return Number.isFinite(at) && now >= at ? { kind: r.kind, percentUsed: 0, renewedAt: at } : r
  })

async function readRows($: EngineInterface, now: number): Promise<Row[]> {
  return liveRows(await read($, limits), now)
}

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
  return { kind: 'armed', at: replyAt + ttlMs - warmLeadMs(s) }
}

// The warmer fires this long before the cache would cool; each warm-up so keeps it one TTL less this lead.
const warmLeadMs = (s: Settings): number => (s.ttl === '5m' ? 60_000 : 5 * 60_000)

// What compacting now costs and what it leaves, for `ctx` tokens on model `id`: `now` is the
// summarizer's request (the context read from a warm cache, the summary written out), `post` the
// cold start after it (the smaller context written to the cache), `warm` / `cold` the same without it.
type CompactCost = { now: number; post: number; postWarm: number; postTokens: number; warm: number; cold: number }

const compactCost = (id: string | null, ctx: number, ttl: '1h' | '5m', l: Learned): CompactCost => {
  const writeMult = ttl === '5m' ? 1.25 : 2
  const r = rateOf(id, ctx)
  const postTokens = Math.min(l.after ?? COMPACT_AFTER, ctx)
  const pr = rateOf(id, postTokens)
  return {
    now: (ctx * r.read + (l.out ?? COMPACT_OUT) * r.input * OUTPUT_MULT) / 1e6,
    post: (postTokens * pr.input * writeMult) / 1e6,
    postWarm: (postTokens * pr.read) / 1e6,
    postTokens,
    warm: (ctx * r.read) / 1e6,
    cold: (ctx * r.input * writeMult) / 1e6,
  }
}

// What the mod makes of compacting this session now. `offer`: the cache cools soon and nothing
// keeps it, so the band offers it (and auto-compact acts from `autoAt`); `later`: worth it, offered
// from `at`; `covered`: the warmer keeps the cache, and warming beats compacting for a break up to
// `breakEvenMs`; `cheap`: a cold start costs too little to bother.
type CompactStatus =
  | { kind: 'running' }
  | { kind: 'small' }
  | { kind: 'cold' }
  | { kind: 'cheap' }
  | { kind: 'covered'; breakEvenMs: number }
  | { kind: 'later'; at: number }
  | { kind: 'offer'; left: number; autoAt: number }

const compactStatus = (s: Settings, c: Compaction, cacheAt: number | null, now: number, ctx: number, cost: CompactCost, w: WarmStatus, warmLeft: number): CompactStatus => {
  if (c.state === 'running') return { kind: 'running' }
  if (ctx <= 0 || ctx < 2 * cost.postTokens) return { kind: 'small' }
  const ttlMs = ttlMsOf(s)
  if (cacheAt === null || now >= cacheAt + ttlMs) return { kind: 'cold' }
  if (cost.cold < s.compactMin || cost.now + cost.post > cost.cold * COMPACT_GAIN) return { kind: 'cheap' }
  const end = cacheAt + ttlMs
  // The cache stays warm until `end`; the warmer pays one whole context read `lead` before each
  // cooling, and each read keeps it a TTL less that lead longer. Warming beats compacting for a
  // break that ends before the first warm-up compacting would not pay for; past the last warm-up
  // the cache cools all the same.
  if (w.kind === 'armed') {
    const lead = warmLeadMs(s)
    const step = ttlMs - lead
    const paid = Math.floor((cost.now + cost.post) / Math.max(cost.warm, 1e-9))
    const breakEven = paid >= warmLeft ? end - now + warmLeft * step : end - lead - now + paid * step
    return { kind: 'covered', breakEvenMs: Math.max(0, breakEven) }
  }
  // The offer comes at most `compactAt` minutes ahead, and never earlier than 40 % of the TTL.
  const from = s.compactAt === 0 ? Infinity : end - Math.min(s.compactAt * 60_000, ttlMs * 0.4)
  if (now < from) return { kind: 'later', at: from }
  return { kind: 'offer', left: end - now, autoAt: end - warmLeadMs(s) }
}

const usd = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const tone = (left: number): string => (left >= 80 ? '#f5c518' : left >= 40 ? '#f07a1a' : '#e5484d')

const save = async (
  $: EngineInterface,
  figures: { rateLimits: readonly SessionRateLimit[]; context: SessionContextUsage; cost?: SessionCost },
) => {
  await update($, limits, () => figures.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })))
  // Right after a compaction the engine has no count until the next response: the mod keeps its own.
  const compacted = ((await read($, compaction)) as Compaction).state === 'done'
  await update($, context, prev =>
    figures.context.tokens === undefined && compacted && prev?.tokens !== undefined
      ? { ...prev, window: figures.context.window }
      : { tokens: figures.context.tokens, window: figures.context.window, percent: figures.context.percent },
  )
  await update($, costUsd, () => figures.cost?.usd ?? null)
}

const valueOf = (s: Settings, key: SettingKey): unknown =>
  key === 'lang'
    ? s.lang
    : key === 'ttl'
      ? s.ttl
      : key === 'warm.max'
        ? s.warmMax
        : key === 'warn.at'
          ? s.warnAt
          : key === 'money.budget'
            ? s.budget
            : key === 'compact.at'
              ? s.compactAt
              : key === 'compact.min'
                ? s.compactMin
                : key === 'compact.auto'
                  ? s.compactAuto
                  : key === 'compact.window'
                    ? s.compactWindow
                    : s.show[key.slice('show.'.length) as keyof Blocks]

const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Reads the settings: the legacy object first, each own key over it, every field checked.
// The store failing leaves the defaults and a toast; the band works on regardless.
async function loadSettings($: EngineInterface, ttl: '1h' | '5m'): Promise<Settings> {
  try {
    const keys = new Set(await $.store.keys())
    const legacy = keys.has(LEGACY_KEY) ? await $.store.get(LEGACY_KEY) : undefined
    const raw: Record<string, unknown> & { show: Record<string, unknown> } = {
      ...(legacy && typeof legacy === 'object' ? (legacy as object) : {}),
      show: { ...((legacy as { show?: object } | undefined)?.show ?? {}) },
    }
    if (keys.has('lang')) raw.lang = await $.store.get('lang')
    if (keys.has('ttl')) raw.ttl = await $.store.get('ttl')
    if (keys.has('warm.max')) raw.warmMax = await $.store.get('warm.max')
    if (keys.has('warn.at')) raw.warnAt = await $.store.get('warn.at')
    if (keys.has('money.budget')) raw.budget = await $.store.get('money.budget')
    if (keys.has('compact.at')) raw.compactAt = await $.store.get('compact.at')
    if (keys.has('compact.min')) raw.compactMin = await $.store.get('compact.min')
    if (keys.has('compact.auto')) raw.compactAuto = await $.store.get('compact.auto')
    if (keys.has('compact.window')) raw.compactWindow = await $.store.get('compact.window')
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

// Changes several settings at once (the developer's recommended set): one redraw, every key written.
async function changeAll($: EngineInterface, ttl: '1h' | '5m', keys: readonly SettingKey[], fn: (s: Settings) => Settings) {
  await update($, settings, s => fn((s as Settings | null) ?? defaults(ttl)))
  saving = saving.then(() => persist($, keys))
  await saving
}

// The model whose threshold the «Поріг» row shows (module state): another model's is never shown,
// and a failed read is tried again on the next tick.
let thresholdModel: string | null = null

// The engine's auto-compact threshold for the session's model, from its context breakdown.
// An engine without the breakdown leaves the last reading (or none: the details skip the row).
async function refreshThreshold($: EngineInterface) {
  let id: string | null = null
  try {
    id = await $.session.model()
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!b) {
      // No reading yet: another model's is hidden, and the next tick tries again.
      if (thresholdModel !== id) {
        await update($, threshold, () => null)
        thresholdModel = null
      }
      return
    }
    await update($, threshold, () => ({
      at: b.isAutoCompactEnabled && typeof b.autoCompactThreshold === 'number' ? b.autoCompactThreshold : null,
      window: b.rawMaxTokens,
      source: b.autocompactSource,
    }))
    thresholdModel = id
  } catch {
    // A reading for this model and window stays; any other is hidden until read again.
    if (thresholdModel !== id) {
      await update($, threshold, () => null)
      thresholdModel = null
    }
  }
}

// The window this mod set for a model, shared by every session on this computer; 0 when none.
async function readWindow($: EngineInterface, id: string): Promise<number> {
  const stored = await $.store.get(STORE_WINDOWS + modelKey(id))
  return typeof stored === 'number' ? stored : 0
}

async function markWindow($: EngineInterface, id: string, n: CompactWindow) {
  try {
    await $.store.set(STORE_WINDOWS + modelKey(id), n)
  } catch {
    // Without a store the next session sets the window again: harmless.
  }
}

// The window as picked in any session, read fresh: a session started earlier must not act on an
// old pick. null when the store cannot be read or holds something else.
async function sharedWindow($: EngineInterface): Promise<CompactWindow | null> {
  try {
    const stored = await $.store.get('compact.window')
    if (stored === undefined || stored === null) return 0
    return COMPACT_WINDOW_CHOICES.find(n => n === stored) ?? null
  } catch {
    return null
  }
}

// Setting the window runs the engine's own /autocompact, which saves it for the session's model
// (modelSettings in the user's settings) and applies it at once. Module state, like `busy`.
let applying = false
// The model and window this session has already checked against the store.
let checkedWindow: string | null = null
// A window the person picked here while the session was busy: the timer sets it once idle, and only
// then is it saved as the pick; a refusal drops it, and the earlier pick stays.
// `base` and `at`: the shared pick when it was pressed, and the time; a pick saved by another
// session after that drops it (by time, so a pick changed and changed back counts too).
let pendingWindow: Press | null = null

// One press of a threshold in this session: `press` counts the presses here, `base` and `at` say
// which shared pick it saw. Only the newest press here, with no pick saved elsewhere since, is saved.
type Press = { n: CompactWindow; ttl: '1h' | '5m'; base: CompactWindow | null; at: number; press: number }
let presses = 0

// When the shared pick was last saved (0: never, or a mod before 0.5.0).
async function pickedAt($: EngineInterface): Promise<number> {
  try {
    const stored = await $.store.get('compact.window.at')
    return typeof stored === 'number' ? stored : 0
  } catch {
    return 0
  }
}

// The shared pick is still the one this press saw: no other session picked since.
// This session's own save of an older press counts as no change for a newer press here.
async function stillBase($: EngineInterface, p: Press): Promise<boolean> {
  const at = await pickedAt($)
  if (ownSave && at === ownSave.at && ownSave.press < p.press) return true
  return (await sharedWindow($)) === p.base && at <= p.at
}

// The last pick this session saved: its time in the store and its press.
let ownSave: { at: number; press: number } | null = null

// 'ok': the engine took it; 'later': the session is busy (or another setting is under way), so the
// timer sets it once idle; 'no': refused or failed, and told.
type Applied = 'ok' | 'later' | 'no'

// Sets the engine's window to `n` (0: back to the engine's own). `told`: the person pressed it,
// so the result is told either way; on its own the mod speaks only of a failure.
async function applyWindow($: EngineInterface, n: CompactWindow, told: boolean): Promise<Applied> {
  const cfg: Settings = ((await read($, settings)) as Settings | null) ?? defaults('1h')
  const t: Strings = TEXT[cfg.lang]
  if (applying) return 'later'
  applying = true
  let result: Applied = 'no'
  try {
    const id = await $.session.model()
    // Checked after the last wait, with none between it and the command: a turn may have begun meanwhile.
    if (busy || warming || compacting) {
      checkedWindow = null
      if (told) $.ui.toast(t.windowLater)
      return 'later'
    }
    const out = await $.command.run({ command: 'autocompact', args: n === 0 ? 'auto' : String(n) })
    const text = out.text?.trim() ?? ''
    // «Auto-compact window for <model> set to <N> tokens», or back to auto; anything else is a refusal
    // (the env variable overrides it, an engine without the command).
    const ok = /^auto-compact window for/i.test(text) || (n === 0 && /\bauto\b/i.test(text) && !/precedence|unknown|error/i.test(text))
    if (ok) {
      await markWindow($, id, n)
      // The reading before is of the old window: read again below, and on every tick until it reads.
      thresholdModel = null
      result = 'ok'
    }
    if (told || !ok) $.ui.toast(ok ? t.windowToast(text) : t.windowFailed(text || '—'))
  } catch (err) {
    $.ui.toast(t.windowFailed(why(err)))
  } finally {
    applying = false
  }
  await refreshThreshold($)
  return result
}

// The window picked in ⚙ goes to every model the session uses: checked once per model and pick,
// against the record of what the mod has set (so it never fights a window set by hand meanwhile).
async function maybeApplyWindow($: EngineInterface) {
  if (busy || warming || compacting || applying) return
  const cfg = (await read($, settings)) as Settings | null
  if (!cfg) return
  // This session's person picked one while the session was busy: it goes first.
  const pending = pendingWindow
  if (pending) {
    // Another session picked after this one was pressed: the newer pick wins, this one is dropped.
    if (!(await stillBase($, pending))) {
      if (pendingWindow === pending) pendingWindow = null
      checkedWindow = null
      return
    }
    const result = await applyWindow($, pending.n, false)
    if (result === 'later') return
    // Pressed again here while the command ran: that newer pick goes next, this one is not saved.
    if (pendingWindow !== pending) {
      checkedWindow = null
      return
    }
    pendingWindow = null
    if (result === 'ok') await savePick($, pending)
    return
  }
  // The pick as the store has it now: another session may have changed it since this one started.
  const pick = await sharedWindow($)
  if (pick === null) return
  if (pick !== cfg.compactWindow) {
    await update($, settings, s => ({ ...(s as Settings), compactWindow: pick }))
    await refreshThreshold($)
  }
  const id = (await read($, model)) ?? (await $.session.model())
  if (!id) return
  const key = `${modelKey(id)}:${pick}`
  if (checkedWindow === key) return
  checkedWindow = key
  let have: number
  try {
    have = await readWindow($, id)
  } catch {
    checkedWindow = null
    return
  }
  // «рушій» (0): only a window this mod set is taken back.
  if (have === pick) return
  // Read again just before the command: another session may have picked meanwhile.
  if ((await sharedWindow($)) !== pick) {
    checkedWindow = null
    return
  }
  const result = await applyWindow($, pick, false)
  if (result === 'later') checkedWindow = null
  // Another session picked while the command ran: the next tick sets its pick instead.
  else if (result === 'ok' && (await sharedWindow($)) !== pick) checkedWindow = null
}

// How the context grows per answered turn of the person's (the warmer's turns left out): a moving
// average for the «compacts in ≈N turns» forecast. A smaller context is a compaction: it starts over.
async function learnGrowth($: EngineInterface) {
  let size: number | undefined
  try {
    size = (await $.session.usage()).context.tokens
  } catch {
    return
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return
  const now = size
  await update($, growth, g => {
    const prev = g as Growth
    if (prev.last === null || now <= prev.last) return { last: now, avg: prev.avg }
    const delta = now - prev.last
    return { last: now, avg: prev.avg === null ? delta : 0.7 * prev.avg + 0.3 * delta }
  })
}

// This mod's version, from its own plugin.json; null where it cannot be read (the tests).
async function ownVersion($: EngineInterface): Promise<string | null> {
  try {
    const raw = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    const v = (JSON.parse(typeof raw === 'string' ? raw : '{}') as { version?: unknown }).version
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

// The getting-to-know pages open on their own once per version: after an install and after every
// update, in each session open then, until one of them is gone through (or «пізніше» each time).
async function setupIntro($: EngineInterface) {
  const version = await ownVersion($)
  if (version === null) return
  let seen: unknown
  let keys: string[]
  try {
    seen = await $.store.get(STORE_INTRO)
    keys = await $.store.keys()
  } catch {
    return
  }
  if (seen === version) return
  // No version gone through yet. A first install marks itself with its version, so a later session
  // of it (after «пізніше») still greets, and a later version says «оновлено». Anything else the mod
  // ever stored, with no such mark: a mod from before 0.5.0 worked here.
  let from: string | null = typeof seen === 'string' ? seen : null
  if (from === null) {
    let first: unknown
    try {
      first = keys.includes(STORE_INTRO_NEW) ? await $.store.get(STORE_INTRO_NEW) : undefined
    } catch {
      return
    }
    if (typeof first === 'string') from = first === version ? null : first
    else if (first !== undefined) from = null
    else if (keys.some(k => !k.startsWith('intro.'))) from = 'old'
    else {
      try {
        await $.store.set(STORE_INTRO_NEW, version)
      } catch {
        // Without a store the next session greets the same way.
      }
    }
  }
  await update($, intro, () => ({ version, from, page: 0, manual: false }))
  await update($, view, () => 'intro')
}

async function markIntroSeen($: EngineInterface) {
  const it = (await read($, intro)) as Intro
  await update($, view, () => 'closed')
  if (it.version === null) return
  try {
    await $.store.set(STORE_INTRO, it.version)
  } catch {
    // Without a store the pages come again next session.
  }
}

// Another session's person went through the pages: this one closes them too.
async function syncIntro($: EngineInterface) {
  if ((await read($, view)) !== 'intro') return
  const it = (await read($, intro)) as Intro
  // Opened with «ⓘ Про мод»: the person closes it.
  if (it.version === null || it.manual) return
  try {
    if ((await $.store.get(STORE_INTRO)) === it.version) await update($, view, () => 'closed')
  } catch {
    // Stays open.
  }
}

// The developer's recommended set: the person's language, TTL and budget stay as they are.
// The window (★ 200k) is set apart, by setWindow: it is saved only once the engine takes it.
const RECOMMENDED_KEYS: readonly SettingKey[] = [
  'warm.max',
  'warn.at',
  'compact.at',
  'compact.min',
  'compact.auto',
  ...([...BAND_BLOCKS, ...DETAIL_BLOCKS].map(b => `show.${b}` as const)),
]

async function applyRecommended($: EngineInterface, ttl: '1h' | '5m') {
  await changeAll($, ttl, RECOMMENDED_KEYS, s => ({
    ...s,
    warmMax: 4,
    warnAt: 80,
    compactAt: 15,
    compactMin: 1,
    compactAuto: false,
    show: defaults(ttl).show,
  }))
  await markIntroSeen($)
  const cfg = ((await read($, settings)) as Settings | null) ?? defaults(ttl)
  $.ui.toast(TEXT[cfg.lang].introDone)
  // The window is saved as picked only once the engine took it (or will, when the session is idle).
  await setWindow($, ttl, RECOMMENDED_WINDOW)
}

async function chooseOwn($: EngineInterface) {
  await markIntroSeen($)
  await update($, view, () => 'settings')
}

async function openIntro($: EngineInterface) {
  const version = ((await read($, intro)) as Intro).version ?? (await ownVersion($))
  await update($, intro, () => ({ version, from: null, page: 0, manual: true }))
  await update($, view, () => 'intro')
}

// A pick is saved (and shown as picked) only once the engine took it. While the session is busy it
// waits in this session (pendingWindow) for the timer; a refusal leaves the earlier pick as it was.
// A press answered after a newer one here neither saves nor waits: the newer pick goes in,
// on whichever path it took.
async function setWindow($: EngineInterface, ttl: '1h' | '5m', n: CompactWindow) {
  const press = ++presses
  checkedWindow = null
  pendingWindow = null
  const base = await sharedWindow($)
  const at = await $.clock.now()
  const result = await applyWindow($, n, true)
  if (press !== presses) {
    checkedWindow = null
    return
  }
  const mine: Press = { n, ttl, base, at, press }
  if (result === 'later') pendingWindow = mine
  else if (result === 'ok') await savePick($, mine)
}

// The time goes first: a session that reads the new pick reads its time too. Two sessions saving
// within the same moment end with whichever wrote last, and every session then follows that one.
// Checked again after every wait: a newer press here, or a pick saved by another session while the
// command ran, wins; this one is not saved, and the timer then sets the newer one.
async function savePick($: EngineInterface, p: Press) {
  checkedWindow = null
  const now = await $.clock.now()
  if (p.press !== presses || !(await stillBase($, p))) return
  ownSave = { at: now, press: p.press }
  try {
    await $.store.set('compact.window.at', now)
  } catch {
    // The pick itself is still saved below, and a failure there is told.
  }
  if (p.press !== presses) return
  // Checked once more at the write itself: a newer press keeps its own pick.
  await change($, p.ttl, 'compact.window', s => (p.press === presses ? { ...s, compactWindow: p.n } : s))
  checkedWindow = null
}

// The main loop got a response: the prompt cache was read or written just now, for the model
// that answered (a fallback can answer for the one picked), or the session's when the reply names none.
async function touch($: EngineInterface, answered: string | undefined) {
  const now = await $.clock.now()
  const id = answered || (await $.session.model())
  await update($, lastReplyAt, () => now)
  await update($, replyModel, () => id)
}

// One model under its ids: the session's and the API's may differ by a context tag or a date.
const modelKey = (id: string): string => id.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

// When the cache the next request would read was last written: none once the session
// has switched to a model other than the one that replied (state from before 0.2.1 has no model).
const cacheFrom = (replyAt: number | null, replyId: string | null, modelId: string | null): number | null =>
  replyAt !== null && (replyId === null || (modelId !== null && modelKey(replyId) === modelKey(modelId))) ? replyAt : null

// The model the next request goes to (a /model switch included): the price follows it.
// A switch of model (/model) changes the engine's threshold too: the «Поріг» row follows at once,
// and a read that failed is tried again on the next tick.
async function refreshModel($: EngineInterface) {
  const id = await $.session.model()
  await update($, model, () => id)
  if (thresholdModel !== id) await refreshThreshold($)
}

// The main loop's turn is running; the warmer's prompt is waiting for its turn to end.
// Module state: a reload clears both, and the next turn.start or turn.complete sets them right.
let busy = false
let warming = false

// Sends the warmer's prompt once the session is idle and its next warm-up is due.
async function maybeWarm($: EngineInterface) {
  if (busy || warming || compacting) return
  const cfg = (await read($, settings)) as Settings | null
  if (!cfg) return
  const now = await $.clock.now()
  const w = (await read($, warm)) as Warm
  const cacheAt = cacheFrom(await read($, lastReplyAt), await read($, replyModel), await read($, model))
  const status = warmStatus(cfg, w, cacheAt, now, (await read($, context))?.tokens ?? 0, await readRows($, now))
  // A compaction may have started while this was reading: it goes first.
  if (status.kind !== 'armed' || now < status.at || compacting) return

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

// A compaction this mod started is running (module state, like `busy`). After a compaction whose size
// the engine did not give, the reply to the next turn teaches the mod how large the context then is:
// 'armed' until that turn starts ('next'), so the compacting turn's own end is never taken for it.
let compacting = false
let learnAfter: 'no' | 'armed' | 'next' = 'no'
// The engine's own compaction, when this mod's /compact command raised it and the mod's hook heard it:
// its sizes, or the veto another hook gave it.
let heard: SessionCompactResult | null = null
// A session outside the terminal REPL (the desktop app is an SDK session) cannot take
// $.session.compact(): set at session start, or once the call said so; then compactions go straight to /compact.
let viaCommand = false

async function compactNow($: EngineInterface): Promise<{ cfg: Settings; status: CompactStatus; cost: CompactCost; cacheAt: number | null }> {
  const cfg: Settings = ((await read($, settings)) as Settings | null) ?? defaults('1h')
  const now = await $.clock.now()
  const modelId = await read($, model)
  const cacheAt = cacheFrom(await read($, lastReplyAt), await read($, replyModel), modelId)
  const ctx = (await read($, context))?.tokens ?? 0
  const cost = compactCost(modelId, ctx, cfg.ttl, (await read($, learned)) as Learned)
  const w = warmStatus(cfg, (await read($, warm)) as Warm, cacheAt, now, ctx, await readRows($, now))
  const left = cfg.warmMax - ((await read($, warm)) as Warm).done
  return { cfg, status: compactStatus(cfg, (await read($, compaction)) as Compaction, cacheAt, now, ctx, cost, w, left), cost, cacheAt }
}

// A compaction stood (this mod's, the person's /compact or the engine's own): the context is
// the summary now, the summarizer has just read the cache, and its sizes are worth keeping.
async function compacted($: EngineInterface, result: Omit<SessionCompacted, 'messages'>, auto: boolean, before: number | null, estimate: number) {
  const now = await $.clock.now()
  const after = result.tokensAfter ?? estimate
  const was = result.tokensBefore ?? before
  await update($, compaction, (c): Compaction => ({ ...(c as Compaction), state: 'done', at: now, before: was, after, reason: null, auto }))
  await update($, context, c => (c ? { ...c, tokens: after, percent: c.window ? (after / c.window) * 100 : c.percent } : c))
  await update($, lastReplyAt, () => now)
  // The summarizer ran on the session's model: its cache serves that model only.
  const id = await $.session.model()
  await update($, replyModel, () => id)
  const real = result.tokensAfter
  if (typeof real === 'number' && Number.isFinite(real) && real > 0) {
    learnAfter = 'no'
    await keepAfter($, real)
  } else {
    learnAfter = 'armed'
  }
  const out = result.usage?.output_tokens
  if (typeof out === 'number' && out > 0) {
    await update($, learned, l => ({ ...(l as Learned), out }))
    try {
      await $.store.set(STORE_OUT, out)
    } catch {
      // Without a store the length holds for this session.
    }
  }
  const cfg = (await read($, settings)) as Settings | null
  if (auto) $.ui.toast(TEXT[cfg?.lang ?? 'uk'].compactToastAuto(was === null ? '?' : tokens(was), tokens(after)))
}

// Compacts the session (the button, or auto-compact): never on top of a running turn, a warm-up
// on its way or another compaction. A veto or a rejection is told in the details and a toast.
// `seen` (auto-compact only): the «не зараз» count when it decided; a press since stops it.
async function runCompact($: EngineInterface, auto: boolean, seen = dismissals) {
  // The flags are checked and set before the first await: two quick presses start one compaction.
  if (compacting) return
  if (busy || warming) {
    if (!auto) $.ui.toast(TEXT[(((await read($, settings)) as Settings | null) ?? defaults('1h')).lang].compactBusy)
    return
  }
  compacting = true
  try {
    const { cfg, cost, cacheAt } = await compactNow($)
    const t: Strings = TEXT[cfg.lang]
    const now = await $.clock.now()
    const before = (await read($, context))?.tokens ?? null
    const prev = (await read($, compaction)) as Compaction
    await update($, compaction, (c): Compaction => ({ ...(c as Compaction), state: 'running', at: now, before, after: null, reason: null, auto, autoFor: auto ? cacheAt : (c as Compaction).autoFor }))
    if (!(await compactRun($, t, auto, before, cost.postTokens, () => busy || warming || (auto && dismissals !== seen)))) {
      // A turn began, or «не зараз» came, while this was getting ready: nothing ran, the details
      // stay as they were (but for a «не зараз» given meanwhile).
      await update($, compaction, (c): Compaction => ({ ...prev, dismissedFor: (c as Compaction).dismissedFor }))
      if (!auto) $.ui.toast(t.compactBusy)
    }
  } finally {
    compacting = false
  }
}

// In a terminal session the engine compacts on $.session.compact(). The desktop app (an SDK
// session) refuses that call: there compaction runs inside a turn, as the /compact command,
// which $.command.run raises as the person's own (probed 15.11.2026, Claude Code 2.1.321).
// False when `stop` held right before the call (a turn began, or «не зараз» stopped an auto-compaction):
// then nothing ran. The check sits right before each call, with no await between them.
async function compactRun($: EngineInterface, t: Strings, auto: boolean, before: number | null, estimate: number, stop: () => boolean): Promise<boolean> {
  if (!viaCommand) {
    if (stop()) return false
    try {
      const result = await $.session.compact()
      if (result.skip !== undefined) await compactFailed($, t, result.skip)
      else await compacted($, result, auto, before, estimate)
      return true
    } catch (err) {
      // Only «not available in a headless (-p / SDK) session» leaves /compact as the way;
      // any other refusal (a turn running, an engine error) is the person's to know.
      if (!/headless|SDK/.test(why(err))) {
        await compactFailed($, t, why(err))
        return true
      }
      viaCommand = true
    }
  }
  if (stop()) return false
  heard = null
  try {
    const out = await $.command.run({ command: 'compact' })
    const got = heard as SessionCompactResult | null
    // A hook vetoed the engine's compaction: the command may still print nothing.
    if (got?.skip !== undefined) await compactFailed($, t, got.skip)
    else {
      // Success prints nothing (the desktop app) or «Compacted…»; anything else is the reason it did not.
      const text = out.text?.trim()
      if (text && !/compacted/i.test(text)) await compactFailed($, t, text)
      else await compacted($, got ?? {}, auto, before, estimate)
    }
  } catch (err) {
    await compactFailed($, t, why(err))
  } finally {
    heard = null
  }
  return true
}

async function compactFailed($: EngineInterface, t: Strings, reason: string) {
  await update($, compaction, (c): Compaction => ({ ...(c as Compaction), state: 'failed', reason }))
  $.ui.toast(t.compactToastFailed(reason))
}

// «не зараз»: the offer stays hidden, and auto-compact keeps still, until the next reply.
// The count goes up before any await: an auto-compaction getting ready sees it right before its call.
let dismissals = 0
async function dismissCompact($: EngineInterface, cacheAt: number | null) {
  dismissals++
  await update($, compaction, (c): Compaction => ({ ...(c as Compaction), dismissedFor: cacheAt }))
}

// Auto-compact, when the person turned it on: the cache is about to cool, nothing keeps it warm,
// the session is idle, and this cache has not been compacted or the offer dismissed already.
async function maybeCompact($: EngineInterface) {
  if (busy || warming || compacting) return
  const seen = dismissals
  const { cfg, status, cacheAt } = await compactNow($)
  if (!cfg.compactAuto || status.kind !== 'offer' || cacheAt === null) return
  const c = (await read($, compaction)) as Compaction
  if (c.autoFor === cacheAt || c.dismissedFor === cacheAt) return
  if ((await $.clock.now()) < status.autoAt) return
  await runCompact($, true, seen)
}

// The first reply to a turn begun after a compaction says how large the compacted context is,
// however large: kept for the estimates of later compactions on this computer.
async function learnSize($: EngineInterface) {
  if (learnAfter !== 'next') return
  const size = (await $.session.usage()).context.tokens
  // No count yet: the next reply tells it.
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return
  learnAfter = 'no'
  await keepAfter($, size)
}

// The size a compacted context really had, large or small: a large one rightly makes later offers rarer.
async function keepAfter($: EngineInterface, size: number) {
  await update($, learned, l => ({ ...(l as Learned), after: size }))
  try {
    await $.store.set(STORE_AFTER, size)
  } catch {
    // Without a store the size holds for this session.
  }
}

async function loadLearned($: EngineInterface) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  try {
    const after = num(await $.store.get(STORE_AFTER))
    const out = num(await $.store.get(STORE_OUT))
    await update($, learned, () => ({ after, out }))
  } catch {
    // The estimates stay the built-in ones.
  }
}

// The person's /compact or the engine's own at its threshold: the band follows them too.
// (This mod's own compaction is handled where it is called: $.session.compact() skips this hook,
// and a /compact it runs is passed through here with its sizes kept for compactRun.)
async function watchCompact($: EngineInterface, e: SessionCompactInput, next: (e: SessionCompactInput) => Promise<SessionCompactResult>) {
  if (e.agentId || (e.trigger !== 'manual' && e.trigger !== 'auto')) return next(e)
  if (compacting) {
    // This mod's own /compact: compactRun records it, with the engine's real sizes.
    const result = await next(e)
    heard = result
    return result
  }
  const before = (await read($, context))?.tokens ?? null
  const prev = (await read($, compaction)) as Compaction
  await update($, compaction, (c): Compaction => ({ ...(c as Compaction), state: 'running', at: null, before, after: null, reason: null, auto: false }))
  let result: SessionCompactResult
  try {
    result = await next(e)
  } catch (err) {
    await update($, compaction, () => prev)
    throw err
  }
  if (result.skip !== undefined) await update($, compaction, () => prev)
  else await compacted($, result, false, before, (await compactNow($)).cost.postTokens)
  return result
}

// The timer's work: a fresh model, a redraw for the countdowns, the warmer, compacting and paid usage.
async function onTick($: EngineInterface) {
  await refreshModel($)
  await update($, tick, n => n + 1)
  await maybeWarm($)
  await maybeCompact($)
  await maybeApplyWindow($)
  await syncIntro($)
  await refreshExtra($)
  await checkWarnings($)
}

// How the session is signed in: a subscription token, an API key, or neither (a gateway,
// Bedrock, Vertex); the engine refusing to tell is 'unknown'.
async function detectPlan($: EngineInterface): Promise<Plan> {
  try {
    const auth = await $.session.authorize()
    return auth === null ? 'other' : auth.kind === 'api-key' ? 'api-key' : 'bearer'
  } catch {
    return 'unknown'
  }
}

// The TTL the login gives: an API key caches for 5 minutes, a subscription for an hour.
const loginTtl = (p: Plan, configured: '1h' | '5m'): '1h' | '5m' => (p === 'api-key' ? '5m' : configured)

// Paid usage as the band shows it: a subscription's extra usage, or an API key's own spend.
// `cap` is the stricter of the organization's monthly limit and the person's budget in ⚙.
type Money = { source: 'extra' | 'api'; enabled: boolean; used: number; cap: number | null; own: boolean; currency: string }

const moneyOf = (cfg: Settings, p: Plan, x: Extra | null, spent: number | null): Money | null => {
  const own = cfg.budget > 0 ? cfg.budget : null
  if (x) {
    const cap = own !== null && (x.limit === null || own < x.limit) ? own : x.limit
    return { source: 'extra', enabled: x.enabled, used: x.used ?? 0, cap, own: own !== null && cap === own && own !== x.limit, currency: x.currency }
  }
  if (p === 'api-key' && spent !== null) return { source: 'api', enabled: true, used: spent, cap: own, own: true, currency: 'USD' }
  return null
}

// 0 nothing paid, 1 started, 2–4 a share of the cap passed, 5 the cap reached.
const moneyLevel = (m: Money): number => {
  if (m.used <= 0) return 0
  if (m.cap === null) return 1
  const share = m.used / m.cap
  if (share >= 1) return 5
  return MONEY_SHARES.reduce((level, s, i) => (share >= s ? i + 2 : level), 1)
}

const money = (n: number, currency = 'USD'): string => {
  const figure = n >= 100 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2)
  return currency === 'USD' ? `$${figure}` : `${figure} ${currency}`
}

const moneySteps = (cap: number, currency: string): string => MONEY_SHARES.map(s => money(Math.round(cap * s), currency)).join('/')

// 0 quiet, 1 past the share picked in ⚙, 2 past CRITICAL.
const windowLevel = (warnAt: WarnAt, used: number): number => (warnAt === 0 ? 0 : used >= CRITICAL ? 2 : used >= warnAt ? 1 : 0)

// The usage endpoint's extra usage, amounts in minor units (`decimal_places` of them, cents
// by default), or null when it has none. A cap reached reads as the whole cap spent.
const parseExtra = (text: string, now: number): Extra | null => {
  const data = JSON.parse(text) as { extra_usage?: unknown }
  const x = data?.extra_usage as Record<string, unknown> | null | undefined
  if (!x || typeof x !== 'object') return null
  const places = typeof x.decimal_places === 'number' && Number.isInteger(x.decimal_places) && x.decimal_places >= 0 && x.decimal_places <= 4 ? x.decimal_places : 2
  const minor = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v / 10 ** places : null)
  const currency = typeof x.currency === 'string' && /^[A-Za-z]{3}$/.test(x.currency) ? x.currency.toUpperCase() : 'USD'
  const limit = minor(x.monthly_limit)
  const used = x.spend_limit_reached === true && limit !== null ? Math.max(minor(x.used_credits) ?? 0, limit) : minor(x.used_credits)
  return { enabled: x.is_enabled === true, limit, used, currency, at: now }
}

// Reads a subscription's extra usage at most every USAGE_EVERY. A failure (an old engine,
// no network, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) leaves the last reading.
// A reading from the store: every field checked, anything else is no reading.
const asExtra = (v: unknown): Extra | null => {
  if (!v || typeof v !== 'object') return null
  const x = v as Record<string, unknown>
  const amount = (n: unknown) => (n === null || (typeof n === 'number' && Number.isFinite(n)) ? (n as number | null) : undefined)
  const limit = amount(x.limit)
  const used = amount(x.used)
  if (typeof x.enabled !== 'boolean' || limit === undefined || used === undefined || typeof x.currency !== 'string' || typeof x.at !== 'number') return null
  return { enabled: x.enabled, limit, used, currency: x.currency, at: x.at }
}

// Every open session runs the mod, and the endpoint (shared with the app's own usage card)
// answers 429 to a caller that asks too often. So the sessions share one reading in the
// store, 'usage.shared' = { extra, next }: the one that finds `next` passed claims the read
// and fetches; the rest take its reading. A 429 waits for Retry-After, or twice the last
// wait, up to USAGE_MAX_WAIT. Each session looks at the store at most once a minute.
const USAGE_SHARED = 'usage.shared'
const USAGE_MAX_WAIT = 30 * 60_000
let usageReadAt = 0
let usageWait = USAGE_EVERY
async function refreshExtra($: EngineInterface) {
  if ((await read($, plan)) !== 'bearer') return
  const now = await $.clock.now()
  if (now - usageReadAt < 60_000) return
  usageReadAt = now

  let shared: { extra?: unknown; next?: unknown } = {}
  try {
    const stored = await $.store.get(USAGE_SHARED)
    if (stored && typeof stored === 'object') shared = stored as typeof shared
  } catch {
    // No store: this session reads for itself.
  }
  const known = asExtra(shared.extra)
  if (known && known.at > (((await read($, extra)) as Extra | null)?.at ?? -1)) await update($, extra, () => known)
  if (typeof shared.next === 'number' && now < shared.next) return

  const claim = async (next: number, reading: Extra | null) => {
    try {
      await $.store.set(USAGE_SHARED, { extra: reading, next })
    } catch {
      // Without a store the wait holds for this session only.
    }
  }
  await claim(now + USAGE_EVERY, known)
  try {
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') return
    const res = await $.http.fetch(USAGE_URL, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: auth.handle })
    if (res.status === 429) {
      const after = Number(res.headers['retry-after'])
      usageWait = Number.isFinite(after) && after > 0 ? Math.min(Math.max(after * 1000, USAGE_EVERY), USAGE_MAX_WAIT) : Math.min(usageWait * 2, USAGE_MAX_WAIT)
      await claim(now + usageWait, known)
      return
    }
    usageWait = USAGE_EVERY
    if (!res.ok) return
    const parsed = parseExtra(res.text, now)
    await update($, extra, () => parsed)
    await claim(now + USAGE_EVERY, parsed)
  } catch {
    // The details show what was last read, or no row at all.
  }
}

// An API key pays for every request: the session's cost growth is added to this month's
// total under its own store key, shared by the sessions of this computer.
const spendKey = (now: number) => `spend.${new Date(now).toISOString().slice(0, 7)}`
let lastCost: number | null = null
let spending: Promise<void> = Promise.resolve()

async function loadSpend($: EngineInterface) {
  const key = spendKey(await $.clock.now())
  let total = 0
  try {
    const stored = await $.store.get(key)
    if (typeof stored === 'number' && Number.isFinite(stored)) total = stored
  } catch {
    // No store: count this session only.
  }
  await update($, spend, () => total)
}

async function addSpend($: EngineInterface, cost: number | undefined) {
  if (cost === undefined) return
  const prev = lastCost
  lastCost = cost
  if (prev === null || cost <= prev || (await read($, plan)) !== 'api-key') return
  const delta = cost - prev
  spending = spending.then(async () => {
    const key = spendKey(await $.clock.now())
    try {
      const stored = await $.store.get(key)
      const total = (typeof stored === 'number' && Number.isFinite(stored) ? stored : 0) + delta
      await $.store.set(key, total)
      await update($, spend, () => total)
    } catch {
      await update($, spend, s => (s ?? 0) + delta)
    }
  })
  await spending
}

// Tells a step once: the store keeps the last step told for each window and for the month,
// so other sessions and a reload stay quiet. Without a store, this module remembers.
const told = new Map<string, number>()
async function firstTime($: EngineInterface, key: string, mark: string, level: number, used?: number): Promise<boolean> {
  try {
    const prev = (await $.store.get(key)) as { mark?: unknown; level?: unknown; used?: unknown } | undefined
    // Paid usage that went down started a new billing period: its steps count again.
    const reset = used !== undefined && typeof prev?.used === 'number' && used < prev.used - 0.005
    if (!reset && prev?.mark === mark && typeof prev.level === 'number' && prev.level >= level) return false
    await $.store.set(key, { mark, level, ...(used !== undefined ? { used } : {}) })
    return true
  } catch {
    const memo = `${key}|${mark}`
    if ((told.get(memo) ?? 0) >= level) return false
    told.set(memo, level)
    return true
  }
}

// A limit window past a warning step, or paid usage past one: a toast, once per step.
async function checkWarnings($: EngineInterface) {
  const cfg = (await read($, settings)) as Settings | null
  if (!cfg) return
  const t: Strings = TEXT[cfg.lang]
  const now = await $.clock.now()
  const p = await read($, plan)
  const x = (await read($, extra)) as Extra | null

  for (const r of await readRows($, now)) {
    const level = windowLevel(cfg.warnAt, r.percentUsed)
    if (level === 0) continue
    const resetAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    const mark = Number.isFinite(resetAt) ? String(Math.round(resetAt / 3_600_000)) : 'none'
    if (!(await firstTime($, `warned.${r.kind}`, mark, level))) continue
    const win = WINDOWS[r.kind]
    const parts = [t.warnWindow(win ? t[win.strings].name : t.windowName(r.kind), Math.round(r.percentUsed))]
    if (win && Number.isFinite(resetAt)) {
      const elapsed = now - (resetAt - win.ms)
      if (elapsed > 0 && r.percentUsed > 0 && r.percentUsed < 100) {
        const runsOut = now + ((100 - r.percentUsed) * elapsed) / r.percentUsed
        if (runsOut < resetAt) parts.push(t.warnRunsOut(clockTime(runsOut, t, true)))
      }
      parts.push(t.warnResets(clockTime(resetAt, t, true)))
    }
    if (level === 2 && x) parts.push(x.enabled ? t.warnThenPaid : t.warnThenStop)
    $.ui.toast(parts.join(' · '))
  }

  const m = moneyOf(cfg, p, x, await read($, spend))
  if (!m) return
  const level = moneyLevel(m)
  // An API key pays from the first request: only the shares of its budget are news.
  if (level === 0 || (m.source === 'api' && level < 2)) return
  if (!(await firstTime($, `warned.money.${m.source}`, new Date(now).toISOString().slice(0, 7), level, m.used))) return
  const used = money(m.used, m.currency)
  const cap = m.cap === null ? null : money(m.cap, m.currency)
  const pct = m.cap ? Math.round((m.used / m.cap) * 100) : 0
  $.ui.toast(
    level === 1 || cap === null
      ? t.moneyStarted(used)
      : level < 5 || m.source === 'api'
        ? t.moneyWarn(used, cap, pct)
        : m.own
          ? t.moneyCapOwnHit(cap)
          : t.moneyCapHit(cap),
  )
}

export const register: Register = (on, options) => {
  const configuredTtl = options.cache_ttl === '5m' ? '5m' : '1h'
  let defaultTtl: '1h' | '5m' = configuredTtl

  // The timer starts first: a store or an engine call that fails must not leave the band frozen.
  // A TTL picked in ⚙ (the store's 'ttl') still wins over the one the login gives.
  on('session.start', async ($, e, next) => {
    $.clock.every(30_000, () => void onTick($))
    viaCommand = e.surface !== 'terminal'
    const signedIn = await detectPlan($)
    await update($, plan, () => signedIn)
    defaultTtl = loginTtl(signedIn, configuredTtl)
    const loaded = await loadSettings($, defaultTtl)
    await update($, settings, () => loaded)
    const usage = await $.session.usage()
    await save($, usage)
    await update($, startedAt, () => usage.startedAt)
    // The cost so far was counted before a reload or belongs to an earlier run.
    lastCost = usage.cost?.usd ?? null
    if (signedIn === 'api-key') await loadSpend($)
    await loadLearned($)
    await refreshModel($)
    await refreshThreshold($)
    await setupIntro($)
    usageReadAt = 0
    await refreshExtra($)
    await checkWarnings($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await save($, e)
    await refreshModel($)
    await addSpend($, e.cost?.usd)
    await checkWarnings($)

    return next(e)
  })

  // Only a turn the API answered warms the cache: an interrupt or an API error
  // carries no usage, and leaves the cache as it was.
  on('turn.complete', async ($, e, next) => {
    // The warmer's own turn says nothing of how the person's work grows the context.
    const wasWarming = warming
    if (!e.agentId) {
      busy = false
      warming = false
    }
    if (!e.agentId && e.usage) {
      await touch($, e.usage.model)
      await refreshModel($)
      await learnSize($)
      if (!wasWarming) await learnGrowth($)
      await refreshThreshold($)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      busy = true
      if (learnAfter === 'armed') learnAfter = 'next'
    }

    return next(e)
  })

  // Every prompt but the warmer's own (a plugin's submit skips its own hooks) means
  // the session is in use again: the warm-ups start counting from zero.
  on('prompt.submit', async ($, e, next) => {
    await update($, warm, s => (s.done === 0 ? s : { ...s, done: 0 }))

    return next(e)
  })

  on('session.compact', ($, e, next) => watchCompact($, e, next))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    await read($, tick)
    const cfg: Settings = ((await read($, settings)) as Settings | null) ?? defaults(defaultTtl)
    const t: Strings = TEXT[cfg.lang]
    const show: Blocks = cfg.show
    const now = await $.clock.now()
    const rows = await readRows($, now)
    const replyAt = await read($, lastReplyAt)
    const mode = await read($, view)
    const { Box, Button, Text } = $.ui.resolve(e)
    const ttlMs = ttlMsOf(cfg)

    const ctx = await read($, context)
    const modelId = await read($, model)
    const ctxTokens = ctx?.tokens ?? 0
    const w = (await read($, warm)) as Warm
    const cacheAt = cacheFrom(replyAt, await read($, replyModel), modelId)
    const warmNow = warmStatus(cfg, w, cacheAt, now, ctxTokens, rows)
    const comp = (await read($, compaction)) as Compaction
    const cc = compactCost(modelId, ctxTokens, cfg.ttl, (await read($, learned)) as Learned)
    const compactNowStatus = compactStatus(cfg, comp, cacheAt, now, ctxTokens, cc, warmNow, cfg.warmMax - w.done)

    const cacheLeft = cacheAt === null ? 0 : cacheAt + ttlMs - now
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

    // Paid usage: shown on the line once something is paid, or an API key has a budget.
    const signedIn = await read($, plan)
    const paid = moneyOf(cfg, signedIn, (await read($, extra)) as Extra | null, await read($, spend))
    const paidShare = paid && paid.cap ? paid.used / paid.cap : null
    const paidColor = paidShare === null ? '#f07a1a' : tone(100 - paidShare * 100)
    const onLine = show.money && paid !== null && (paid.used > 0 || (paid.source === 'api' && paid.cap !== null))
    const moneyText = (words: boolean) =>
      paid && onLine ? t.moneyBand(money(paid.used, paid.currency), paid.cap === null ? null : money(paid.cap, paid.currency), words) : null

    // A window the band has no name for (a gateway's spend limit) gets a meter of its own.
    const otherKinds = rows.map(r => r.kind).filter(k => !WINDOWS[k])
    const shortOf = (kind: string) => (WINDOWS[kind] ? t[WINDOWS[kind]!.strings].short : t.windowName(kind))

    // Width of the line in cells for a given fit, as the layout below draws it.
    const meterWidth = (kind: string, fit: Fit) => {
      const label = shortOf(kind)
      const limit = rows.find(r => r.kind === kind)
      if (!limit) return label.length + 2
      const left = Math.max(0, Math.round(100 - limit.percentUsed))
      const resetIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
      const reset = fit.reset && Number.isFinite(resetIn) ? 1 + `· ${span(resetIn, t)}`.length : 0
      const mark = windowLevel(cfg.warnAt, limit.percentUsed) > 0 ? 1 + t.warnMark.length : 0
      return label.length + (fit.dots > 0 ? 1 + fit.dots : 0) + 1 + t.left(left, fit.words).length + mark + reset
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
        ...otherKinds.map(k => meterWidth(k, fit)),
        moneyText(fit.words)?.length ?? 0,
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
      const label = shortOf(kind)
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
          {windowLevel(cfg.warnAt, limit.percentUsed) > 0 ? <Text color={color} weight="bold">{t.warnMark}</Text> : null}
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
        {otherKinds.map(meter)}
        {moneyText(fit.words) ? (
          <Text key="money" color={paidColor} weight="semibold" tabular>{moneyText(fit.words)}</Text>
        ) : null}
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

    // The offer to compact: the cache cools soon, nothing keeps it warm, and a cold start would cost
    // far more than compacting now. A second row, only while it stands; «не зараз» hides it for this cache.
    const compactRow = (() => {
      if (compactNowStatus.kind === 'running') {
        return (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text color="#f07a1a" weight="semibold">{t.compactRunning}</Text>
          </Box>
        )
      }
      if (compactNowStatus.kind !== 'offer' || comp.dismissedFor === cacheAt || e.props.isWorking) return null
      const left = span(compactNowStatus.left, t)
      const autoText = cfg.compactAuto ? t.compactAutoAt(clockTime(compactNowStatus.autoAt, t)) : null
      const buttons = t.compactButton.length + 2 + 1 + t.compactDismiss.length + 2
      const texts = [t.compactAlert(left, usd(cc.now), usd(cc.post), usd(cc.cold)), t.compactAlertShort(left, usd(cc.now), usd(cc.cold)), t.compactAlertMin(left)]
      const text = texts.find(x => x.length + 1 + buttons + (autoText ? 1 + autoText.length : 0) <= e.props.bodyColumns) ?? texts[texts.length - 1]!
      const withAuto = autoText !== null && text.length + 1 + buttons + 1 + autoText.length <= e.props.bodyColumns
      return (
        <Box flexDirection="row" alignItems="center" columnGap={1} rowGap={0} flexWrap="wrap">
          <Text color="#f07a1a" weight="semibold" tabular>{text}</Text>
          {withAuto ? <Text dimColor tabular>{autoText}</Text> : null}
          <Button key="compact-band" label={t.compactButton} onPress={() => void runCompact($, false)} />
          <Button key="compact-dismiss" plain dimColor label={t.compactDismiss} onPress={() => void dismissCompact($, cacheAt)} />
        </Box>
      )
    })()
    const head = compactRow ? (
      <Box flexDirection="column">
        {line}
        {compactRow}
      </Box>
    ) : (
      line
    )

    if (mode === 'closed') {
      return head
    }

    const choice = (key: string, label: string, isOn: boolean, onPress: () => void) => (
      <Button key={key} plain dimColor={!isOn} label={`${isOn ? '●' : '○'} ${label}`} onPress={onPress} />
    )
    const row = (title: string, items: RenderChildren[]) => (
      <Box flexDirection="row" alignItems="center" columnGap={1} rowGap={0} flexWrap="wrap">
        <Text dimColor size="footnote">{`${title}:`}</Text>
        {items}
      </Box>
    )
    const th = (await read($, threshold)) as Threshold | null
    const pctOf = (at: number, of: number) => Math.round((at / Math.max(of, 1)) * 100)
    const windowLabel = (n: CompactWindow) => (n === 0 ? t.windowEngine : `${tokens(n)}${n === RECOMMENDED_WINDOW ? ' ★' : ''}`)

    // Getting to know the mod: a few pages, then the choice of the developer's settings or one's own.
    if (mode === 'intro') {
      const it = (await read($, intro)) as Intro
      const page = Math.min(Math.max(it.page, 0), INTRO_LAST)
      const go = (p: number) => void update($, intro, s => ({ ...(s as Intro), page: p }))
      const line = (key: string, text: string, strong = false) => (
        <Text key={key} size="footnote" dimColor={!strong} weight={strong ? 'semibold' : undefined}>{text}</Text>
      )
      const body: RenderChildren[] = []
      if (page === 0) {
        if (it.from === null) {
          body.push(line('w-title', t.introWelcomeTitle, true), ...t.introWelcome.map((x, i) => line(`w-${i}`, x)))
        } else {
          body.push(line('n-title', t.introNewTitle(it.version ?? ''), true), ...t.introNew.map((x, i) => line(`n-${i}`, `• ${x}`)))
          body.push(...t.introWelcome.slice(1).map((x, i) => line(`w-${i}`, x)))
        }
        body.push(row(t.introHint, (['uk', 'en'] as Lang[]).map(l => choice(`intro-lang-${l}`, LANG_NAMES[l], cfg.lang === l, () => void change($, defaultTtl, 'lang', s => ({ ...s, lang: l }))))))
      } else if (page < INTRO_LAST) {
        const p = t.introPages[page - 1]!
        body.push(line(`p-title`, p.title, true), ...p.lines.map((x, i) => line(`p-${i}`, x)))
        if (page === INTRO_LAST - 1) {
          body.push(...t.introWindowLines.map((x, i) => line(`win-${i}`, `• ${x}`)))
          if (th && th.at !== null) body.push(line('win-now', t.introNow(tokens(th.at), pctOf(th.at, th.window)), true))
        }
      } else {
        body.push(
          line('c-title', t.introChoiceTitle, true),
          <Box key="c-rec" flexDirection="row" columnGap={1}>
            <Button key="intro-recommended" label={t.introRecommended} onPress={() => void applyRecommended($, defaultTtl)} />
          </Box>,
          ...t.introRecommendedLines.map((x, i) => line(`c-rec-${i}`, `  ${x}`)),
          <Box key="c-own" flexDirection="row" columnGap={1}>
            <Button key="intro-own" plain label={t.introOwn} onPress={() => void chooseOwn($)} />
          </Box>,
          line('c-own-note', `  ${t.introOwnNote}`),
        )
      }
      return (
        <Box flexDirection="column">
          {head}
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Text weight="semibold" size="footnote">{t.introTitle(it.version)}</Text>
            <Text dimColor size="footnote" tabular>{`${page + 1}/${INTRO_LAST + 1}`}</Text>
          </Box>
          {body}
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            {page > 0 ? <Button key="intro-back" plain dimColor label={t.introBack} onPress={() => go(page - 1)} /> : null}
            {page < INTRO_LAST ? <Button key="intro-next" plain label={t.introNext} onPress={() => go(page + 1)} /> : null}
            {page < INTRO_LAST - 1 ? <Button key="intro-skip" plain dimColor label={t.introToChoice} onPress={() => go(INTRO_LAST)} /> : null}
            <Button key="intro-later" plain dimColor label={t.introLater} onPress={() => void update($, view, () => 'closed')} />
          </Box>
        </Box>
      )
    }

    if (mode === 'settings') {
      const check = (block: keyof Blocks) => (
        <Button
          key={`show-${block}`}
          plain
          dimColor={!show[block]}
          label={`${show[block] ? '☑' : '☐'} ${t.blocks[block]}`}
          onPress={() => void change($, defaultTtl, `show.${block}`, s => ({ ...s, show: { ...s.show, [block]: !s.show[block] } }))}
        />
      )

      return (
        <Box flexDirection="column">
          {head}
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Button key="open-details" plain dimColor label={t.backToDetails} onPress={() => void update($, view, () => 'details')} />
            <Text weight="semibold" size="footnote">{t.settingsTitle}</Text>
          </Box>
          {row(t.langRow, (['uk', 'en'] as Lang[]).map(l => choice(`lang-${l}`, LANG_NAMES[l], cfg.lang === l, () => void change($, defaultTtl, 'lang', s => ({ ...s, lang: l })))))}
          {row(t.ttlRow, (['1h', '5m'] as const).map(v => choice(`ttl-${v}`, v, cfg.ttl === v, () => void change($, defaultTtl, 'ttl', s => ({ ...s, ttl: v })))))}
          {row(t.warmRow, WARM_CHOICES.map(n => choice(`warm-${n}`, n === 0 ? t.warmChoiceOff : String(n), cfg.warmMax === n, () => void change($, defaultTtl, 'warm.max', s => ({ ...s, warmMax: n })))))}
          {row(t.warnRow, WARN_CHOICES.map(n => choice(`warn-${n}`, n === 0 ? t.warmChoiceOff : `${n}%`, cfg.warnAt === n, () => void change($, defaultTtl, 'warn.at', s => ({ ...s, warnAt: n })))))}
          {row(t.budgetRow, BUDGET_CHOICES.map(n => choice(`budget-${n}`, n === 0 ? t.budgetNone : `$${n}`, cfg.budget === n, () => void change($, defaultTtl, 'money.budget', s => ({ ...s, budget: n })))))}
          {row(t.compactAtRow, [
            ...COMPACT_AT_CHOICES.map(n => choice(`compact-at-${n}`, n === 0 ? t.warmChoiceOff : t.minutes(n), cfg.compactAt === n, () => void change($, defaultTtl, 'compact.at', s => ({ ...s, compactAt: n })))),
            <Text key="compact-min-label" dimColor size="footnote">{`${t.compactMinRow}:`}</Text>,
            ...COMPACT_MIN_CHOICES.map(n => choice(`compact-min-${n}`, `$${n}`, cfg.compactMin === n, () => void change($, defaultTtl, 'compact.min', s => ({ ...s, compactMin: n })))),
          ])}
          {row(t.compactAutoRow, ([false, true] as const).map(v => choice(`compact-auto-${v ? 'on' : 'off'}`, v ? t.compactAutoOn : t.warmChoiceOff, cfg.compactAuto === v, () => void change($, defaultTtl, 'compact.auto', s => ({ ...s, compactAuto: v })))))}
          {row(t.windowRow, COMPACT_WINDOW_CHOICES.map(n => choice(`window-${n}`, windowLabel(n), cfg.compactWindow === n, () => void setWindow($, defaultTtl, n))))}
          <Text dimColor size="footnote">{`  ${t.windowNote}`}</Text>
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
      const window = WINDOWS[kind]
      const label = window ? t[window.strings].name : t.windowName(kind)
      const limit = rows.find(r => r.kind === kind)
      if (!limit) {
        return detail(kind, label, [{ text: t.noData }])
      }

      const used = Math.round(limit.percentUsed)
      const resetAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
      const facts: Fact[] = [{ text: t.used(used), color: tone(100 - used) }]

      if (limit.renewedAt !== undefined) {
        facts.push({ text: t.renewed(clockTime(limit.renewedAt, t, now - limit.renewedAt >= 24 * 3_600_000)) })
      } else if (Number.isFinite(resetAt)) {
        // Within a day «через …» says which day it is, so the time is enough.
        facts.push({ text: t.reset(clockTime(resetAt, t, resetAt - now >= 24 * 3_600_000), span(resetAt - now, t)) })
        const elapsed = window ? (now - (resetAt - window.ms)) / window.ms : NaN
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

    // Compacting: what it costs now, what a cold start costs after it, and which of it and the warmer pays.
    const whyCompact = (): string =>
      warmNow.kind === 'off'
        ? t.compactWhy.off
        : warmNow.kind === 'paused'
          ? t.compactWhy.paused
          : warmNow.kind === 'spent'
            ? t.compactWhy.spent
            : warmNow.kind === 'limits'
              ? t.compactWhy.limits(t[warmNow.window].short)
              : t.compactWhy.cold
    const compactCosts: Fact[] = [
      { text: t.compactNow(usd(cc.now)), strong: true },
      { text: t.compactThen(usd(cc.post), usd(cc.cold)), color: '#f07a1a' },
      { text: t.compactPerTurn(usd(cc.postWarm), usd(cc.warm)) },
    ]
    const k = compactNowStatus.kind
    const compactFacts: Fact[] = [
      ...(comp.state === 'failed' && comp.reason ? [{ text: t.compactFailed(comp.reason), color: '#e5484d' }] : []),
      ...(k === 'running'
        ? [{ text: t.compactRunning, color: '#f07a1a' }]
        : k === 'small'
          ? comp.state === 'done' && comp.at !== null && comp.after !== null
            ? [
                { text: t.compactDone(clockTime(comp.at, t), comp.before === null ? '?' : tokens(comp.before), tokens(comp.after)), strong: true },
                { text: t.compactDoneNote },
              ]
            : [{ text: t.compactSmall }]
          : k === 'cold'
            ? [{ text: t.compactCold }]
            : k === 'cheap'
              ? [{ text: t.compactNotWorth(usd(cc.cold)) }]
              : k === 'covered'
                ? [...compactCosts, { text: t.compactBetterWarm(span(compactNowStatus.breakEvenMs, t)) }, { text: t.compactNote }]
                : [
                    ...compactCosts,
                    { text: t.compactBetter(whyCompact()), color: '#e5484d' },
                    ...(k === 'offer' && cfg.compactAuto ? [{ text: t.compactAutoAt(clockTime(compactNowStatus.autoAt, t)) }] : []),
                    { text: t.compactNote },
                  ]),
    ]
    const canCompact = (k === 'offer' || k === 'later' || k === 'covered') && !e.props.isWorking

    // Paid usage: a subscription's extra usage (on or off) or an API key's month.
    const moneyFacts: Fact[] | null = !paid
      ? null
      : paid.source === 'extra' && !paid.enabled && paid.used <= 0
        ? [{ text: t.moneyOff, strong: true }, { text: t.moneyOffNote }]
        : [
            paid.source === 'api'
              ? { text: t.moneyApi(money(paid.used), paid.cap === null ? null : money(paid.cap)), color: paidColor }
              : {
                  text: t.moneyUsed(
                    money(paid.used, paid.currency),
                    paid.cap === null ? null : money(paid.cap, paid.currency),
                    paidShare === null ? null : Math.round(paidShare * 100),
                  ),
                  color: paidColor,
                },
            ...(paid.source === 'extra' && paid.cap !== null ? [{ text: paid.own ? t.moneyCapOwn : t.moneyCapOrg }] : []),
            ...(paid.cap !== null ? [{ text: t.moneySteps(moneySteps(paid.cap, paid.currency)) }] : []),
            { text: paid.source === 'api' ? t.moneyApiNote : t.moneyMonth },
          ]

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

    // The engine's own threshold: where it compacts, in about how many turns, and what sets it.
    const g = (await read($, growth)) as Growth
    const thresholdFacts: Fact[] | null = !th
      ? null
      : th.at === null
        ? [{ text: t.thresholdOff, strong: true }, { text: t.thresholdOffNote }]
        : [
            { text: t.thresholdAt(tokens(th.at), pctOf(th.at, th.window)), strong: true },
            ...(ctxTokens >= th.at
              ? [{ text: t.thresholdNear, color: '#f07a1a' }]
              : g.avg !== null && g.avg >= 500 && ctxTokens > 0
                ? [{ text: t.thresholdIn(Math.max(1, Math.ceil((th.at - ctxTokens) / g.avg))) }]
                : []),
            { text: t.thresholdWindow(tokens(th.window), (t.sources as Record<string, string>)[th.source] ?? th.source) },
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
        {head}
        {limitRow('seven_day')}
        {limitRow('five_hour')}
        {otherKinds.map(limitRow)}
        {show.money && moneyFacts ? detail('money', t.rowsMoney, moneyFacts) : null}
        {detail('cache', t.rows.cache, cacheFacts)}
        {detail('warm', t.rows.warm, warmFacts)}
        {ctxTokens > 0 || comp.state !== 'idle' ? detail('compact', t.rows.compact, compactFacts) : null}
        {thresholdFacts ? detail('threshold', t.thresholdRow, thresholdFacts) : null}
        {show.priceDetails && ctxTokens > 0 ? detail('price', t.rows.price, priceFacts) : null}
        {show.models && ctxTokens > 0 ? detail('models', t.rows.models, modelFacts) : null}
        {show.session ? detail('session', t.rows.session, sessionFacts) : null}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Button key="open-settings" plain dimColor label={t.openSettings} onPress={() => void update($, view, () => 'settings')} />
          {cfg.warmMax > 0 ? <Button key="warm-pause" plain dimColor label={w.paused ? t.warmResume : t.warmPause} onPress={toggleWarm} /> : null}
          {canCompact ? <Button key="compact-now" plain label={t.compactButton} onPress={() => void runCompact($, false)} /> : null}
          <Button key="about" plain dimColor label={t.aboutButton} onPress={() => void openIntro($)} />
        </Box>
      </Box>
    )
  })
}
