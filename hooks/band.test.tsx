import type { On, TurnCompleteInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'gmdi-token-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 9, 29, 12)
const LIMITS = [
  { kind: 'seven_day', percentUsed: 38, resetsAt: new Date(NOW + (4 * 24 + 12) * 3_600_000 + 30_000).toISOString() },
  { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(NOW + 17 * 60_000).toISOString() },
]

// A main-loop turn the API answered, and one that died on an API error with nothing counted.
const ANSWERED: TurnCompleteInput = {
  turnId: 't1',
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  reason: 'answer',
  usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 207_000 },
}
const FAILED: TurnCompleteInput = { turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'error' }

// A store the test reads back: each key the plugin writes lands in `saved`.
const storeIn = (on: On, saved: Record<string, unknown>) => {
  on('store.keys', () => ({ value: Object.keys(saved) }))
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
}

// The engine beneath the plugin for one session: its clock, usage figures and model.
// The prompts the plugin submits (the warmer's) land in `sent`.
const session = (on: On, usage: { tokens?: number; limits?: typeof LIMITS; sent?: string[]; model?: string; breakdown?: object }) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    usage.sent?.push(e.text)
    return { text: e.text }
  })
  on('session.model', () => ({ value: usage.model ?? 'claude-opus-5-5' }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: NOW,
      context: { tokens: usage.tokens, window: 1_000_000, ...(e?.breakdown && usage.breakdown ? { breakdown: usage.breakdown as never } : {}) },
      rateLimits: usage.limits ?? [],
    },
  }))
  on('turn.complete', () => ({ text: 'ok' }))
}

test('the band shows both limits and a cold cache before any reply, in Ukrainian by default', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /^ЛІМІТИ$/ }))?.text).toBe('ЛІМІТИ')
    expect((await ui.find({ type: 'Text', text: /62%/ }))?.text).toBe('62% вільно')
    expect((await ui.find({ type: 'Text', text: /97%/ }))?.text).toBe('97% вільно')
    expect((await ui.find({ type: 'Text', text: /4д 12г/ }))?.text).toBe('· 4д 12г')
    expect((await ui.find({ type: 'Text', text: /17хв/ }))?.text).toBe('· 17хв')
    expect((await ui.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
    expect(await ui.find({ type: 'Text', text: /Тиждень/ })).toBeUndefined()

    await ui.press({ key: 'toggle' })
    const expanded = await $.ui.mount({ ...BAND, surface })
    expect((await expanded.find({ type: 'Text', text: /^Тиждень$/ }))?.text).toBe('Тиждень')
    expect((await expanded.find({ type: 'Text', text: /^38% використано · скидання / }))?.text).toMatch(/, через 4д 12г · прогноз на кінець ≈106% ⚠$/)
    expect((await expanded.find({ type: 'Text', text: /^5 годин$/ }))?.text).toBe('5 годин')
    expect((await expanded.find({ type: 'Text', text: /^3% використано/ }))?.text).toBe('3% використано · скидання 14:17, через 17хв · прогноз на кінець ≈3%')
    expect((await expanded.find({ type: 'Text', text: /^Кеш$/ }))?.text).toBe('Кеш')
    expect((await expanded.find({ type: 'Text', text: /^холодний · / }))?.text).toBe('холодний · відповідей після завантаження мода ще не було')
    expect((await expanded.find({ type: 'Text', text: /^opus-5-5 · / }))?.text).toMatch(/^opus-5-5 · з /)

    await expanded.press({ key: 'toggle' })
    await ui.unmount()
    await expanded.unmount()
  }
})

test('an answered turn warms the cache for an hour, then it cools', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { tokens: 207_000 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ТЕПЛО/ }))?.text).toBe(' ТЕПЛО ')
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')
  expect((await ui.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $1.66')
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^теплий до / }))?.text).toMatch(/ · остання відповідь .*, TTL 1h$/)
  expect((await details.find({ type: 'Text', text: /^зараз \$/ }))?.text).toBe('зараз $0.041 · після охолодження $1.66 · у 40 разів дорожче · ціни API')
  expect((await details.find({ type: 'Text', text: /^Моделі$/ }))?.text).toBe('Моделі')
  expect((await details.find({ type: 'Text', text: /^Fable / }))?.text).toBe('Fable $4.14 · Opus $1.66 (зараз) · Sonnet $0.83 · Haiku $0.21 · перший запит на моделі')
  await details.press({ key: 'toggle' })
  await details.unmount()

  // One band stays mounted while the clock runs: only the mod's timer can redraw it.
  const open = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(43 * 60_000)
  expect((await open.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 17хв')

  await clock.advance(20 * 60_000)
  expect((await open.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  expect((await open.find({ type: 'Text', text: /продовження/ }))?.text).toBe('продовження $1.66')
  // Cold, the timer counts the idle time since the reply, and keeps counting.
  expect((await open.find({ type: 'Text', text: /^простій / }))?.text).toBe('простій 1г 03хв')
  await clock.advance(2 * 3_600_000)
  expect((await open.find({ type: 'Text', text: /^простій / }))?.text).toBe('простій 3г 03хв')
  await open.unmount()
})

test('a turn that failed without a response leaves the cache cold, and work shows as «працює»', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { tokens: 207_000 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(FAILED)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  expect(await ui.find({ type: 'Text', text: /^ще / })).toBeUndefined()
  // No reply yet: no idle time to count either.
  expect(await ui.find({ type: 'Text', text: /^простій / })).toBeUndefined()
  await ui.unmount()

  const working = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } })
  expect((await working.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  expect((await working.find({ type: 'Text', text: /^працює$/ }))?.text).toBe('працює')
  await working.unmount()
})

test('with a 5-minute TTL the write costs × 1.25 and the cache cools after 5 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { settings: { lang: 'uk', ttl: '5m' } })
  session(on, { tokens: 200_000 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 5хв')
  expect((await ui.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $1.00')
  await ui.unmount()

  await clock.advance(6 * 60_000)
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cold.find({ type: 'Text', text: /продовження/ }))?.text).toBe('продовження $1.00')
  await cold.unmount()
})

test('an API-key login gives the 5-minute TTL, a subscription keeps the hour', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { tokens: 200_000 })
  let kind: 'api-key' | 'bearer' = 'api-key'
  on('session.authorize', () => ({ value: { handle: 'h', kind } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  const key = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await key.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 5хв')
  await key.unmount()

  kind = 'bearer'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const sub = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await sub.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')
  await sub.unmount()
})

test('a TTL picked in ⚙ wins over the one the login gives', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { ttl: '1h' })
  session(on, { tokens: 200_000 })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')
  await ui.unmount()
})

test('stored settings come back in a new session, and damaged values fall back to the defaults', async ($, on) => {
  mock.clock(on, { now: NOW })
  // An older or damaged store: a string for a flag, a null, an unknown language field kept.
  mock.store(on, { settings: { lang: 'en', show: { week: 'false', cache: null, words: false, extra: 1 } } })
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^USAGE$/ }))?.text).toBe('USAGE')
  expect((await ui.find({ type: 'Text', text: /^7D$/ }))?.text).toBe('7D')
  expect((await ui.find({ type: 'Text', text: /^62%$/ }))?.text).toBe('62%')
  expect((await ui.find({ type: 'Text', text: /COLD/ }))?.text).toBe(' COLD ')
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^Week$/ }))?.text).toBe('Week')
  expect((await details.find({ type: 'Text', text: /^38% used · resets / }))?.text).toMatch(/, in 4d 12h · ≈106% by the end ⚠$/)
  expect((await details.find({ type: 'Text', text: /^cold · / }))?.text).toBe('cold · no reply since the mod loaded')
  await details.unmount()
})

test('two quick presses both land, and the store gets the final settings', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'open-settings' })
  await Promise.all([ui.press({ key: 'lang-en' }), ui.press({ key: 'show-week' }), ui.press({ key: 'show-words' })])
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^USAGE$/ }))?.text).toBe('USAGE')
  expect(await band.find({ type: 'Text', text: /^7D$/ })).toBeUndefined()
  expect((await band.find({ type: 'Text', text: /^97%$/ }))?.text).toBe('97%')
  await band.unmount()

  // Only the three changed keys are written, each under its own name.
  expect(saved).toEqual({ lang: 'en', 'show.week': false, 'show.words': false })
})

test('a change here keeps what another session saved under the other keys', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Another open session switches to English after this one has started in Ukrainian.
  saved['lang'] = 'en'

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'open-settings' })
  await ui.press({ key: 'show-week' })
  await ui.unmount()

  expect(saved).toEqual({ lang: 'en', 'show.week': false })
})

test('a store that cannot be read leaves the defaults, a toast, and a band that keeps counting down', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('store.keys', () => {
    throw new Error('locked')
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  session(on, { tokens: 207_000, limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^Налаштування смуги не прочитано: .+\. Показую типові\.$/)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^ЛІМІТИ$/ }))?.text).toBe('ЛІМІТИ')
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')

  // The timer runs despite the store: the same mounted band counts down by itself.
  await clock.advance(30 * 60_000)
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 30хв')
  await ui.unmount()
})

test('a narrow band gives up words, then reset times, then dots, to stay on one line', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // 60 columns: without the words and the reset times the line is 54 cells.
  const narrow = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 60 } })
  expect((await narrow.find({ type: 'Text', text: /^62%$/ }))?.text).toBe('62%')
  expect(await narrow.find({ type: 'Text', text: /4д 12г/ })).toBeUndefined()
  expect((await narrow.find({ type: 'Text', text: /^ЛІМІТИ$/ }))?.text).toBe('ЛІМІТИ')
  await narrow.unmount()

  // 45 columns: five dots a meter as well.
  const tight = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 45 } })
  expect((await tight.find({ type: 'Text', text: /^●+$/ }))?.text).toBe('●●●')
  await tight.unmount()
})

test('on a narrow band with a price the timer, then the price give way, so the line still fits', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { tokens: 207_000, limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  // 45 columns, warm: no label, five dots, no countdown — the price stays (45 cells).
  const warm = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 45 } })
  expect(await warm.find({ type: 'Text', text: /^ЛІМІТИ$/ })).toBeUndefined()
  expect(await warm.find({ type: 'Text', text: /^ще / })).toBeUndefined()
  expect((await warm.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $1.66')
  await warm.unmount()

  // Cold, the resume price is longer and goes to the details.
  await clock.advance(61 * 60_000)
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 45 } })
  expect((await cold.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  expect(await cold.find({ type: 'Text', text: /продовження/ })).toBeUndefined()
  await cold.unmount()

  // 30 columns: no dots at all, just the percentages and the badge.
  const bare = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 30 } })
  expect(await bare.findAll({ type: 'Text', text: /^●+$/ })).toHaveLength(0)
  expect((await bare.find({ type: 'Text', text: /^62%$/ }))?.text).toBe('62%')
  await bare.unmount()
})

test('the price follows a model switch before the next reply', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let current = 'claude-opus-5-5'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: current }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 207_000, window: 1_000_000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  const opus = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await opus.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $1.66')
  await opus.unmount()

  // /model sonnet-5: within the timer's 30 seconds the price is Sonnet's ($2/M × 2),
  // and due on the next request, as Sonnet has no cache of this context yet.
  current = 'claude-sonnet-5'
  await clock.advance(30_000)
  const sonnet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await sonnet.find({ type: 'Text', text: /^продовження / }))?.text).toBe('продовження $0.83')
  await sonnet.unmount()
})

test('a model switch leaves the cache cold until that model replies, so the warmer keeps still', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  let current = 'claude-opus-5-5'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.model', () => ({ value: current }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 207_000, window: 1_000_000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ТЕПЛО/ }))?.text).toBe(' ТЕПЛО ')

  // /model sonnet-5 with no reply from it: Sonnet's cache is cold, and no warm-up is due.
  current = 'claude-sonnet-5'
  await clock.advance(30_000)
  expect((await ui.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  await clock.advance(55 * 60_000)
  expect(sent).toEqual([])

  // Sonnet replies (the API names it with a date): its cache is warm from now on.
  await $.turn.complete({ ...ANSWERED, usage: { ...ANSWERED.usage!, model: 'claude-sonnet-5-20261001' } })
  await clock.advance(1_000)
  expect((await ui.find({ type: 'Text', text: /ТЕПЛО/ }))?.text).toBe(' ТЕПЛО ')
  await ui.unmount()
})

test('a reply from a fallback model warms its cache, not the picked one\'s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('session.model', () => ({ value: 'claude-sonnet-5' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 207_000, window: 1_000_000 }, rateLimits: [] } }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Sonnet is picked, Opus answered: the next request, on Sonnet, has no cache to read.
  await $.turn.complete(ANSWERED)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  await clock.advance(56 * 60_000)
  expect(sent).toEqual([])
  await ui.unmount()
})

test('a failed store write is told in a toast, and the change still holds for the session', async ($, on) => {
  mock.clock(on, { now: NOW })
  const toasts: string[] = []
  on('store.keys', () => ({ value: [] }))
  on('store.set', () => {
    throw new Error('disk full')
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  session(on, { limits: LIMITS })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'open-settings' })
  await ui.press({ key: 'lang-en' })
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  expect(toasts).toHaveLength(1)
  // The kit skips a throwing hook and names the missing answer instead: any reason will do.
  expect(toasts[0]).toMatch(/^Band settings were not saved: .+\. They hold for this session only\.$/)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^USAGE$/ }))?.text).toBe('USAGE')
  await band.unmount()
})

test('Haiku 5.5 past 100K tokens pays the dearer tier, at 100K and below the cheaper one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let tokens = 149_000
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens, window: 1_000_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ ...ANSWERED, usage: { ...ANSWERED.usage!, model: 'claude-haiku-5-5' } })

  // 149k: $0.50/M × 2 for the write.
  const long = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await long.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $0.15')
  await long.press({ key: 'toggle' })
  await long.unmount()
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^Fable / }))?.text).toBe('Fable $2.98 · Opus $1.19 · Sonnet $0.60 · Haiku $0.15 (зараз) · перший запит на моделі')
  await details.press({ key: 'toggle' })
  await details.unmount()

  // 100k: still the cheaper tier, $0.10/M × 2.
  tokens = 100_000
  await $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  await clock.advance(1_000)
  const short = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await short.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $0.020')
  await short.unmount()
})

// The warmer's own turn, as the engine runs the prompt it submitted: started, then answered.
const warmTurn = async ($: Engine, id: string) => {
  await $.turn.start({ text: 'warm', turnId: id })
  await $.turn.complete({ ...ANSWERED, turnId: id })
}

test('five minutes before the cache cools the warmer sends one short prompt, and its answer keeps the cache warm', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  session(on, { tokens: 207_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^↻/ }))?.text).toBe('↻4')

  await clock.advance(54 * 60_000)
  expect(sent).toEqual([])
  await clock.advance(60_000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/^Автоматичний прогрів кешу 1\/4, .*відповідай одним словом: ок$/)

  // While its prompt waits for a turn, the next ticks send nothing more.
  await clock.advance(2 * 60_000)
  expect(sent.length).toBe(1)

  await warmTurn($, 'w1')
  expect((await ui.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')
  expect((await ui.find({ type: 'Text', text: /^↻/ }))?.text).toBe('↻3')
  await ui.press({ key: 'toggle' })
  await ui.unmount()

  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^Прогрів$/ }))?.text).toBe('Прогрів')
  expect((await details.find({ type: 'Text', text: /^наступний о / }))?.text).toMatch(/^наступний о \d\d:\d\d · зроблено 1 з 4 · \$0\.041 замість \$1\.66$/)
  await details.unmount()
})

test('the warmer stops after four in a row, and the person\'s next prompt starts the count again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  session(on, { tokens: 207_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  for (let i = 1; i <= 4; i++) {
    await clock.advance(55 * 60_000)
    expect(sent.length).toBe(i)
    await warmTurn($, `w${i}`)
  }
  expect(sent[3]).toMatch(/^Автоматичний прогрів кешу 4\/4/)

  await clock.advance(55 * 60_000)
  expect(sent.length).toBe(4)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^↻/ })).toBeUndefined()
  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^зроблено всі 4/ }))?.text).toBe('зроблено всі 4 · далі кеш охолоне; ваше повідомлення почне відлік знову')

  await clock.advance(10 * 60_000)
  expect((await details.find({ type: 'Text', text: /^кеш охолов/ }))?.text).toBe('кеш охолов, прогрівів було 4')

  await $.prompt.submit({ text: 'далі', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'далі', turnId: 'p1' })
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(55 * 60_000)
  expect(sent[sent.length - 1]).toMatch(/^Автоматичний прогрів кешу 1\/4/)
})

test('no warm-up with little of a limit left, and the details say which', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  const low = [LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 95, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() }]
  session(on, { tokens: 207_000, limits: low, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(56 * 60_000)
  expect(sent).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^призупинено/ }))?.text).toBe('призупинено: мало ліміту 5Г')
})

test('a small context never needs a warm-up', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  session(on, { tokens: 10_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(56 * 60_000)
  expect(sent).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^не потрібен/ }))?.text).toBe('не потрібен: контекст менше 20k')
})

test('a turn still running at the due time gets no warm-up on top of it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const sent: string[] = []
  session(on, { tokens: 207_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await $.turn.start({ text: 'довга задача', turnId: 'long' })
  await clock.advance(58 * 60_000)
  expect(sent).toEqual([])
})

test('the pause button keeps this session cold, and ⚙ turns the warmer off for every session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  const sent: string[] = []
  session(on, { tokens: 207_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await details.press({ key: 'warm-pause' })
  expect((await details.find({ type: 'Text', text: /^на паузі/ }))?.text).toBe('на паузі в цій сесії')
  await clock.advance(56 * 60_000)
  expect(sent).toEqual([])
  // Paused, the band shows no ↻ either.
  await details.press({ key: 'toggle' })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /^↻/ })).toBeUndefined()
  await band.press({ key: 'toggle' })

  const open = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await open.press({ key: 'open-settings' })
  const settingsView = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await settingsView.press({ key: 'warm-0' })
  expect(saved).toEqual({ 'warm.max': 0 })
  await settingsView.press({ key: 'warm-8' })
  expect(saved).toEqual({ 'warm.max': 8 })
})

test('a warmer turned off in another session stays off here, and its details say where to turn it on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  const sent: string[] = []
  session(on, { tokens: 207_000, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(56 * 60_000)
  expect(sent).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^вимкнено/ }))?.text).toBe('вимкнено · увімкнути в ⚙')
  expect(await details.find({ key: 'warm-pause' })).toBeUndefined()
})

// ---- Warnings: limit windows and paid usage, for every kind of sign-in ----

// The usage endpoint as a subscription reads it: extra usage in cents.
const usageEndpoint = (on: On, extraUsage: Record<string, unknown> | null, calls: string[] = []) => {
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', (_, e) => {
    calls.push(`${e.url} auth=${e.init?.auth ?? ''}`)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ five_hour: null, extra_usage: extraUsage }) } }
  })
}

const toastsOf = (on: On) => {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

// The week of 29.10 12:00 UTC began on 25.10 12:00 (4 days in), resets on 01.11 12:00.
const WEEK_84 = [
  { kind: 'seven_day', percentUsed: 84, resetsAt: new Date(NOW + 3 * 24 * 3_600_000).toISOString() },
  { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() },
]

test('a subscription with extra usage on: the band shows what is paid of the cap, the details its steps, one toast per step', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 100_000, limits: WEEK_84 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const calls: string[] = []
  usageEndpoint(on, { is_enabled: true, monthly_limit: 15_000, used_credits: 5_200, utilization: 34.7, currency: 'USD' }, calls)
  const toasts = toastsOf(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(calls).toEqual(['https://api.anthropic.com/api/oauth/usage auth=h'])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 160 } })
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $52/$150')
  // 84 % of the week is past the 80 % step: the meter carries the mark.
  expect((await ui.find({ type: 'Text', text: /^⚠$/ }))?.text).toBe('⚠')
  await ui.unmount()
  // At 120 columns the word goes first, the sum stays.
  const narrow = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await narrow.find({ type: 'Text', text: /^\$52/ }))?.text).toBe('$52/$150')
  await narrow.press({ key: 'toggle' })
  await narrow.unmount()

  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^Доплати$/ }))?.text).toBe('Доплати')
  expect((await details.find({ type: 'Text', text: /^\$52 з / }))?.text).toBe(
    '$52 з $150 (35%) · стеля організації · попередження $50/$100/$140 · за розрахунковий місяць',
  )
  await details.unmount()

  // The week at 84 %, four days of seven in: 21 %/day, so it runs out in about 0.76 day.
  expect(toasts).toHaveLength(2)
  expect(toasts[0]).toMatch(/^⚠ Тиждень: використано 84% · за поточного темпу закінчиться ≈.+ · скидання .+$/)
  expect(toasts[1]).toBe('💲 Доплати: $52 з $150 (35%) за місяць')

  // Nothing new: the timer and another measure stay quiet; the endpoint is read again after 5 minutes.
  await clock.advance(6 * 60_000)
  await $.session.measure({ context: { tokens: 100_000, window: 1_000_000 }, rateLimits: WEEK_84, changed: ['rateLimits'] })
  expect(toasts).toHaveLength(2)
  expect(calls).toHaveLength(2)

  // A reload (another session.start) reads the store: still quiet.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts).toHaveLength(2)
})

test('the week past 95 % with extra usage off says that work stops; the details say extra usage is off', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const limits = [{ kind: 'seven_day', percentUsed: 96, resetsAt: new Date(NOW + 3 * 24 * 3_600_000).toISOString() }]
  session(on, { tokens: 100_000, limits })
  usageEndpoint(on, { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: 'USD' })
  const toasts = toastsOf(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^⚠ Тиждень: використано 96% · .* · далі робота зупиниться до скидання \(доплати вимкнено\)$/)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^доплати / })).toBeUndefined()
  await ui.press({ key: 'toggle' })
  await ui.unmount()
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^вимкнено · після/ }))?.text).toBe('вимкнено · після вичерпання ліміту робота зупиниться до скидання')
  await details.unmount()
})

test('a budget in ⚙ below the organization cap is the cap the band warns against; reaching it says charges go on', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, { 'money.budget': 100 })
  session(on, { tokens: 100_000, limits: [] })
  usageEndpoint(on, { is_enabled: true, monthly_limit: 20_000, used_credits: 10_300, utilization: 51.5, currency: 'USD' })
  const toasts = toastsOf(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts).toEqual(['💲 Ваш бюджет доплат $100 вичерпано (стеля організації вища — гроші й далі списуються)'])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $103/$100')
  await ui.press({ key: 'toggle' })
  await ui.unmount()
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^\$103 з / }))?.text).toBe(
    '$103 з $100 (103%) · стеля ваша (⚙) · попередження $33/$67/$93 · за розрахунковий місяць',
  )
  await details.unmount()
})

test('an API key counts its own month from the session cost and warns at the shares of the budget', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'money.budget': 50, 'spend.2026-10': 10 }
  storeIn(on, saved)
  let cost = 2
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], cost: { usd: cost } } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'api-key' as const } }))
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return { value: { status: 500, ok: false, headers: {}, text: '' } }
  })
  const toasts = toastsOf(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // An API key has no usage endpoint to read; $10 of $50 is under a third.
  expect(fetched).toEqual([])
  expect(toasts).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $10/$50')

  // The session spends $8 more: $18 of $50 passes the first third.
  cost = 10
  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [], cost: { usd: cost }, changed: ['cost'] })
  expect(saved['spend.2026-10']).toBe(18)
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $18/$50')
  expect(toasts).toEqual(['💲 Доплати: $18 з $50 (36%) за місяць'])
  await ui.unmount()
})

test('a gateway spend limit gets a meter and a warning of its own; warnings off in ⚙ keep everything quiet', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  const limits = [{ kind: 'spend_limit', percentUsed: 82, resetsAt: new Date(NOW + 10 * 24 * 3_600_000).toISOString() }]
  session(on, { tokens: 50_000, limits })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: null }))
  const toasts = toastsOf(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^⚠ Ліміт витрат: використано 82%$/)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Ліміт витрат$/ }))?.text).toBe('Ліміт витрат')
  expect((await ui.find({ type: 'Text', text: /^18% вільно$/ }))?.text).toBe('18% вільно')

  // ⚙ → «Попереджати з: вимк»: no mark, and a higher reading stays quiet.
  await ui.press({ key: 'toggle' })
  await ui.unmount()
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await details.press({ key: 'open-settings' })
  await details.unmount()
  const settingsView = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await settingsView.press({ key: 'warn-0' })
  await settingsView.unmount()
  expect(saved['warn.at']).toBe(0)
  const quiet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await quiet.find({ type: 'Text', text: /^⚠$/ })).toBeUndefined()
  await quiet.unmount()
  await $.session.measure({
    context: { tokens: 50_000, window: 1_000_000 },
    rateLimits: [{ kind: 'spend_limit', percentUsed: 97, resetsAt: limits[0]!.resetsAt }],
    changed: ['rateLimits'],
  })
  expect(toasts).toHaveLength(1)
})

test('the sessions share one usage reading, and a 429 waits for its Retry-After', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Another session read the endpoint two minutes ago: its reading is used, nothing is fetched.
  const saved: Record<string, unknown> = {
    'usage.shared': {
      extra: { enabled: true, limit: 150, used: 12, currency: 'USD', at: NOW - 2 * 60_000 },
      next: NOW + 3 * 60_000,
    },
  }
  storeIn(on, saved)
  session(on, { tokens: 50_000, limits: [] })
  let status = 429
  const calls: number[] = []
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('http.fetch', () => {
    calls.push(calls.length + 1)
    const headers: Record<string, string> = status === 429 ? { 'retry-after': '600' } : {}
    return status === 429
      ? { value: { status, ok: false, headers, text: '{"error":{"type":"rate_limit_error"}}' } }
      : { value: { status, ok: true, headers, text: JSON.stringify({ extra_usage: { is_enabled: true, monthly_limit: 15_000, used_credits: 2_000, currency: 'USD' } }) } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(calls).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $12/$150')

  // Past `next` this session reads, gets a 429 and leaves the next read 10 minutes away for everyone.
  await clock.advance(4 * 60_000)
  expect(calls).toHaveLength(1)
  // Read at the first tick past `next` (3 minutes in), so the next one is 10 minutes after that.
  expect((saved['usage.shared'] as { next: number }).next).toBe(NOW + 3 * 60_000 + 600_000)
  await clock.advance(8 * 60_000)
  expect(calls).toHaveLength(1)

  status = 200
  await clock.advance(2 * 60_000)
  expect(calls).toHaveLength(2)
  expect((await ui.find({ type: 'Text', text: /^доплати / }))?.text).toBe('доплати $20/$150')
  expect((saved['usage.shared'] as { extra: { used: number } }).extra.used).toBe(20)
  await ui.unmount()
})

// Compacting while the cache is warm. 804k tokens on Opus 5.5, 1h TTL: a cold start writes
// 804k × $4 × 2 = $6.43; compacting reads it warm ($0.16) and writes an 8k summary ($0.16),
// and the cold start after it rewrites about 70k ($0.56).
const BIG = 804_000

// The engine's compaction beneath the plugin: each call lands in `calls`, answered by `answer`.
const SUMMARY = [{ role: 'user' as const, text: 'Підсумок розмови', toolUses: [] }]
const compactor = (on: On, calls: { trigger: string; instructions?: string }[], answer: () => object) => {
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('session.compact', (_, e) => {
    calls.push({ trigger: e.trigger, instructions: e.instructions })
    return answer() as never
  })
}
const COMPACTED = () => ({
  messages: SUMMARY,
  tokensBefore: BIG,
  tokensAfter: 62_000,
  usage: { input_tokens: 10, output_tokens: 6_000, cache_read_input_tokens: BIG, cache_creation_input_tokens: 0 },
})

const toastsIn = (on: On, toasts: string[]) =>
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

test('with the warmer off, 15 minutes before the cache cools the band offers to compact, and the button compacts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'warm.max': 0 }
  storeIn(on, saved)
  const usage = { tokens: BIG as number | undefined }
  session(on, usage)
  const calls: { trigger: string }[] = []
  compactor(on, calls, COMPACTED)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(44 * 60_000)
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()

  // The same band, redrawn by the timer alone.
  await clock.advance(2 * 60_000)
  expect((await band.find({ type: 'Text', text: /^⚠ / }))?.text).toBe('⚠ кеш охолоне за 14хв: стиснути зараз ≈$0.32, потім охолодження ≈$0.56 замість $6.43')
  expect(await band.find({ type: 'Text', text: /^авто о/ })).toBeUndefined()

  // Two quick presses start one compaction.
  await Promise.all([band.press({ key: 'compact-band' }), band.press({ key: 'compact-band' })])
  expect(calls.length).toBe(1)
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  // The context is the summary now: a warm cache of 62k, $0.50 to write again once cold.
  expect((await band.find({ type: 'Text', text: /^ще / }))?.text).toBe('ще 1г 00хв')
  expect((await band.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $0.50')
  expect(saved['compact.learned.out']).toBe(6_000)
  // The engine said how large the summary is: kept at once.
  expect(saved['compact.learned.after']).toBe(62_000)

  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^Стиснення$/ }))?.text).toBe('Стиснення')
  expect((await band.find({ type: 'Text', text: /^стиснуто о / }))?.text).toMatch(/^стиснуто о \d\d:\d\d: 804k → 62k · наступний запит закешує новий, менший контекст$/)

  // With the engine's own size known, the next reply does not overwrite it.
  usage.tokens = 65_000
  await $.turn.start({ text: 'далі', turnId: 'p1' })
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  expect(saved['compact.learned.after']).toBe(62_000)
  await band.unmount()
})

// The desktop app refuses $.session.compact(): the mod runs /compact, as the person would.
const desktopCompactor = (on: On, calls: string[], answer: () => object | Promise<object>) => {
  on('session.messages', () => ({ value: SUMMARY }) as never)
  // The mod's own call has no answer here, so it fails, as the desktop app's refusal does.
  on('session.compact', (_, e) => {
    if (e.trigger !== 'manual') throw new Error('not available in a headless (-p / SDK) session yet')
    return { ...COMPACTED(), tokensAfter: 58_000 } as never
  })
  on('command.run', { command: 'compact' }, async (_, e) => {
    calls.push(`${e.origin.kind}:${e.command}`)
    return (await answer()) as never
  })
}

test('in the desktop app the button runs /compact; the engine sizes are kept when the mod hears them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: string[] = []
  // The command stays open until the test has raised the engine's compaction inside it.
  let done = () => {}
  const open = new Promise<void>(resolve => (done = resolve))
  desktopCompactor(on, calls, async () => {
    await open
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const presses = Promise.all([band.press({ key: 'compact-band' }), band.press({ key: 'compact-band' })])
  for (let i = 0; i < 1000 && !calls.length; i++) await clock.advance(0)
  expect(calls).toEqual(['plugin:compact'])
  // The engine's compaction, as the mod's session.compact hook hears it during the command.
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  done()
  await presses
  expect(calls).toEqual(['plugin:compact'])
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стиснуто о / }))?.text).toMatch(/: 804k → 58k · /)
  await band.unmount()
})

test('in the desktop app a quiet /compact counts on the estimate, and a refusal it prints is told', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: string[] = []
  const answers = [{ text: 'Not enough messages to compact.' }, {}]
  desktopCompactor(on, calls, () => answers.shift() ?? {})
  const toasts: string[] = []
  toastsIn(on, toasts)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'compact-band' })
  expect(calls.length).toBe(1)
  expect(toasts).toContain('Стиснення не вдалося: Not enough messages to compact.')
  await band.press({ key: 'compact-band' })
  expect(calls.length).toBe(2)
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стиснуто о / }))?.text).toMatch(/: 804k → \d+k · /)
  await band.unmount()
})

test('the offer shortens on a narrow band, and «не зараз» hides it for this cache', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: { trigger: string }[] = []
  compactor(on, calls, COMPACTED)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)

  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 80 }, surface: 'desktop' })
  expect((await narrow.find({ type: 'Text', text: /^⚠ / }))?.text).toBe('⚠ охолоне за 10хв: стиснути ≈$0.32 замість $6.43')
  await narrow.unmount()
  const tiny = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 }, surface: 'desktop' })
  expect((await tiny.find({ type: 'Text', text: /^⚠ / }))?.text).toBe('⚠ охолоне за 10хв')
  await tiny.unmount()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'compact-dismiss' })
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  expect(calls).toEqual([])
  // The details still offer it.
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^зараз ≈/ }))?.text).toBe(
    'зараз ≈$0.32 · далі охолодження ≈$0.56 замість $6.43 · запит $0.014 замість $0.16 · вигідніше стиснути: прогрівач вимкнено · подробиці розмови замінить підсумок',
  )
  await band.press({ key: 'compact-now' })
  expect(calls.length).toBe(1)
  await band.unmount()
})

test('while the warmer keeps the cache there is no offer; the details say which pays for how long a break', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  session(on, { tokens: BIG })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  await band.press({ key: 'toggle' })
  // Compacting costs 5.5 warm-ups, but four are left: the cache keeps 10 min, then each warm-up
  // (5 min before it would cool) adds 55 min, so warming wins for a break up to 10 min + 4 × 55 min.
  expect((await band.find({ type: 'Text', text: /^зараз ≈/ }))?.text).toBe(
    'зараз ≈$0.32 · далі охолодження ≈$0.56 замість $6.43 · запит $0.014 замість $0.16 · прогрів дешевший, якщо перерва до ≈3г 50хв; довша — стиснути · подробиці розмови замінить підсумок',
  )
  expect(await band.find({ key: 'compact-now' })).toBeDefined()
  await band.unmount()
})

// Warm-ups are paid whole: compacting costs 5.5 of them, so warming wins until the sixth is due.
for (const [ttl, after, warmMax, span] of [
  ['1h', 50, 8, '4г 40хв'], // 10 min left: the 6th warm-up comes 5 min before cooling + 5 × 55 min
  ['1h', 50, 2, '2г 00хв'], // only 2 left: the cache holds 10 min + 2 × 55 min, then cools
  ['5m', 2, 8, '18хв'], // 5m: compacting costs 4.2 warm-ups; the 5th comes 3 − 1 + 4 × 4 min on
] as const) {
  test(`with ${warmMax} warm-ups on a ${ttl} cache, warming wins for a break up to ${span}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on, { 'warm.max': warmMax, ttl })
    session(on, { tokens: BIG })

    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.turn.complete(ANSWERED)
    await clock.advance(after * 60_000)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.press({ key: 'toggle' })
    expect((await band.find({ type: 'Text', text: /^зараз ≈/ }))?.text).toContain(`прогрів дешевший, якщо перерва до ≈${span};`)
    await band.unmount()
  })
}

test('with the warmer standing down on a low weekly limit the band offers compacting and says why', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const low = [{ ...LIMITS[0]!, percentUsed: 97 }, LIMITS[1]!]
  session(on, { tokens: BIG, limits: low })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^⚠ кеш/ }))?.text).toMatch(/^⚠ кеш охолоне за 10хв: /)
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^зараз ≈/ }))?.text).toMatch(/ · вигідніше стиснути: прогрівач стоїть, мало ліміту 7Д · /)
  await band.unmount()
})

test('auto-compact, when on, compacts an idle session five minutes before the cache cools, once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0, 'compact.auto': true })
  session(on, { tokens: BIG })
  const calls: { trigger: string }[] = []
  compactor(on, calls, COMPACTED)
  const toasts: string[] = []
  toastsIn(on, toasts)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await clock.advance(50 * 60_000)
  expect((await band.find({ type: 'Text', text: /^авто о/ }))?.text).toMatch(/^авто о \d\d:\d\d$/)
  await clock.advance(4 * 60_000)
  expect(calls).toEqual([])

  await clock.advance(60_000)
  expect(calls.length).toBe(1)
  expect(toasts.some(x => x.startsWith('⇲ Сесію стиснуто автоматично, поки кеш був теплий: 804k → 62k'))).toBe(true)
  await clock.advance(10 * 60_000)
  expect(calls.length).toBe(1)
  await band.unmount()
})

test('auto-compact keeps still while a turn runs and after «не зараз»', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0, 'compact.auto': true })
  session(on, { tokens: BIG })
  const calls: { trigger: string }[] = []
  compactor(on, calls, COMPACTED)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await $.turn.start({ text: 'довга задача', turnId: 'long' })
  await clock.advance(58 * 60_000)
  expect(calls).toEqual([])
  await $.turn.complete({ ...ANSWERED, turnId: 'long' })

  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'compact-dismiss' })
  await clock.advance(8 * 60_000)
  expect(calls).toEqual([])
  await band.unmount()
})

test('auto-compact is off by default: the offer shows, nothing compacts on its own', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: { trigger: string }[] = []
  compactor(on, calls, COMPACTED)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(58 * 60_000)
  expect(calls).toEqual([])
})

test('a press while a turn runs says so; a veto is told in a toast and in the details', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: { trigger: string }[] = []
  compactor(on, calls, () => ({ skip: 'заборонено хуком' }))
  const toasts: string[] = []
  toastsIn(on, toasts)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await $.turn.start({ text: 'ще одне', turnId: 'busy' })
  await band.press({ key: 'compact-band' })
  expect(calls).toEqual([])
  expect(toasts).toContain('Стиснення не запущено: Claude зараз працює. Спробуйте, коли відповідь закінчиться.')
  await $.turn.complete({ ...FAILED, turnId: 'busy' })

  await band.press({ key: 'compact-band' })
  expect(calls.length).toBe(1)
  expect(toasts).toContain('Стиснення не вдалося: заборонено хуком')
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^не вдалося/ }))?.text).toMatch(/^не вдалося: заборонено хуком · зараз ≈\$0\.32 · /)
  await band.unmount()
})

test('a small context, a cheap cold start and a cold cache are not worth an offer', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = { 'warm.max': 0 }
  storeIn(on, store)
  const usage = { tokens: 120_000 as number | undefined }
  session(on, usage)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^не потрібне/ }))?.text).toBe('не потрібне: контекст ще малий')
  expect(await band.find({ key: 'compact-now' })).toBeUndefined()
  await band.unmount()
})

test('the person\'s own /compact is followed too, and ⚙ sets the offer, its threshold and auto-compact', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: BIG })
  compactor(on, [], COMPACTED)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $0.50')
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стиснуто о / }))?.text).toMatch(/: 804k → 62k · /)

  await band.press({ key: 'open-settings' })
  await band.press({ key: 'compact-at-0' })
  await band.press({ key: 'compact-min-2' })
  await band.press({ key: 'compact-auto-on' })
  expect(saved).toEqual({ 'compact.learned.after': 62_000, 'compact.learned.out': 6_000, 'compact.at': 0, 'compact.min': 2, 'compact.auto': true })
  await band.unmount()
})

test('the offer and its details read in English', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0, lang: 'en' })
  session(on, { tokens: BIG })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^⚠ / }))?.text).toBe('⚠ cache cools in 10m: compact now ≈$0.32, then a cold start ≈$0.56 instead of $6.43')
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^now ≈/ }))?.text).toMatch(/ · compacting pays: the warmer is off · a summary replaces the conversation in detail$/)
  await band.unmount()
})

test('a window whose reset has passed counts as unused before the next reply: no ⚠, the warmer resumes, the details say it reset', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const toasts = toastsOf(on)
  const sent: string[] = []
  const spent = [LIMITS[0]!, { ...LIMITS[1]!, percentUsed: 97 }]
  session(on, { tokens: 207_000, limits: spent, sent })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  expect(toasts.filter(x => x.includes('5 годин'))).toHaveLength(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /вільно$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^3% вільно$/ }))?.text).toBe('3% вільно')
  expect((await ui.find({ type: 'Text', text: /^⚠$/ }))?.text).toBe('⚠')

  // 14:17 Kyiv passes with the session idle: the engine sends nothing new, the mod knows the window is fresh.
  await clock.advance(18 * 60_000)
  expect((await ui.find({ type: 'Text', text: /^3% вільно$/ }))).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^100% вільно$/ }))?.text).toBe('100% вільно')
  expect(await ui.find({ type: 'Text', text: /^⚠$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /17хв/ }))).toBeUndefined()

  await ui.press({ key: 'toggle' })
  const details = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await details.find({ type: 'Text', text: /^0% використано/ }))?.text).toBe('0% використано · скинуто 14:17, точні дані — з наступною відповіддю')

  // The low 5-hour share had held the warmer back; with the window fresh it warms on time.
  await clock.advance(38 * 60_000)
  expect(sent).toHaveLength(1)
  expect(toasts.filter(x => x.includes('5 годин'))).toHaveLength(1)
})

test('in the desktop app a /compact another hook vetoes is told, and the context stays as it was', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: string[] = []
  const toasts: string[] = []
  toastsIn(on, toasts)
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('session.compact', (_, e) => {
    if (e.trigger !== 'manual') throw new Error('not available in a headless (-p / SDK) session yet')
    return { skip: 'заборонено хуком' } as never
  })
  // The command stays open until the test has raised the (vetoed) compaction inside it; it prints nothing.
  let done = () => {}
  const open = new Promise<void>(resolve => (done = resolve))
  on('command.run', { command: 'compact' }, async (_, e) => {
    calls.push(e.command)
    await open
    return {} as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const press = band.press({ key: 'compact-band' })
  for (let i = 0; i < 1000 && !calls.length; i++) await clock.advance(0)
  expect(calls).toEqual(['compact'])
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  done()
  await press
  // Still the large context, still the cold start it costs.
  expect((await band.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $6.43')
  await band.press({ key: 'toggle' })
  expect(toasts).toContain('Стиснення не вдалося: заборонено хуком')
  expect((await band.find({ type: 'Text', text: /^не вдалося/ }))?.text).toMatch(/^не вдалося: заборонено хуком/)
  expect(await band.find({ type: 'Text', text: /^стиснуто о / })).toBeUndefined()
  await band.unmount()
})

test('a turn that begins while the compaction gets ready stops it before /compact runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: string[] = []
  const toasts: string[] = []
  toastsIn(on, toasts)
  desktopCompactor(on, calls, () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The person sends a prompt while the press is still on its way to /compact.
  const press = band.press({ key: 'compact-band' })
  await $.turn.start({ text: 'нове питання', turnId: 'race' })
  await press
  expect(calls).toEqual([])
  expect(toasts).toContain('Стиснення не запущено: Claude зараз працює. Спробуйте, коли відповідь закінчиться.')
  await band.press({ key: 'toggle' })
  expect(await band.find({ type: 'Text', text: /^не вдалося/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^стиснуто о / })).toBeUndefined()
  await band.unmount()
})

test('in the terminal a refusal other than «headless» is told, not retried as /compact', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0 })
  session(on, { tokens: BIG })
  const calls: string[] = []
  const toasts: string[] = []
  toastsIn(on, toasts)
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('session.compact', () => {
    throw new Error('compaction is already running')
  })
  on('command.run', { command: 'compact' }, (_, e) => {
    calls.push(e.command)
    return {} as never
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'compact-band' })
  expect(calls).toEqual([])
  expect(toasts.some(x => x.startsWith('Стиснення не вдалося: '))).toBe(true)
  await band.unmount()
})

test('after a compaction a switch to another model leaves the cache cold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const usage = { tokens: BIG as number | undefined, model: 'claude-opus-5-5' }
  session(on, usage)
  compactor(on, [], COMPACTED)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /ТЕПЛО/ }))?.text).toBe(' ТЕПЛО ')

  // /model sonnet: the summary was cached for Opus, so the next request writes it again.
  usage.model = 'claude-sonnet-5-5'
  await clock.advance(60_000)
  expect((await band.find({ type: 'Text', text: /ХОЛОД/ }))?.text).toBe(' ХОЛОД ')
  await band.unmount()
})

test('a large summary the engine reports is kept for later estimates', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: BIG })
  compactor(on, [], () => ({ ...COMPACTED(), tokensAfter: 500_000 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(saved['compact.learned.after']).toBe(500_000)
})

test('without the engine\'s size, the reply to the next turn teaches it, however large, and no losing offer follows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'warm.max': 0, 'compact.auto': true }
  storeIn(on, saved)
  const usage = { tokens: BIG as number | undefined }
  session(on, usage)
  const calls: { trigger: string }[] = []
  // The engine compacted but named no size afterwards.
  compactor(on, calls, () => {
    const { tokensAfter: _, ...rest } = COMPACTED()
    return rest
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'compact-band' })
  expect(calls.length).toBe(1)
  expect(saved['compact.learned.after']).toBeUndefined()

  // A turn that ends without having begun after the compaction (the compacting turn's own) teaches nothing.
  await $.turn.complete({ ...ANSWERED, turnId: 'c0' })
  expect(saved['compact.learned.after']).toBeUndefined()

  // The next turn's reply: the context stayed large, and that is what is kept.
  usage.tokens = 750_000
  await $.turn.start({ text: 'далі', turnId: 'p1' })
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  expect(saved['compact.learned.after']).toBe(750_000)

  // 55 minutes on, compacting 750k again would cost as much as the cold start: no offer, no auto-compact.
  await clock.advance(55 * 60_000)
  expect(await band.find({ type: 'Text', text: /^⚠ / })).toBeUndefined()
  expect(calls.length).toBe(1)
  await band.unmount()
})

test('«не зараз» pressed while an auto-compaction gets ready stops it before /compact runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'warm.max': 0, 'compact.auto': true })
  session(on, { tokens: BIG })
  const calls: string[] = []
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('command.run', { command: 'compact' }, (_, e) => {
    calls.push(e.command)
    return {} as never
  })
  // The person presses «не зараз» just as the mod, having decided to compact, marks it as running:
  // the offer is still drawn, /compact has not been raised yet.
  let press: (() => Promise<unknown>) | null = null
  let pressed = false
  on('state.set', async (_, e, next) => {
    const v = e.value as { state?: string; auto?: boolean } | null
    if (!pressed && e.key === 'compaction' && v?.state === 'running' && v.auto) {
      pressed = true
      await press?.()
    }
    return next(e)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(ANSWERED)
  await clock.advance(50 * 60_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  press = () => band.press({ key: 'compact-dismiss' })
  await clock.advance(8 * 60_000)
  expect(pressed).toBe(true)
  expect(calls).toEqual([])
  await band.press({ key: 'toggle' })
  expect(await band.find({ type: 'Text', text: /^стиснуто о / })).toBeUndefined()
  // Nothing more on its own for this cache.
  await clock.advance(60_000)
  expect(calls).toEqual([])
  await band.unmount()
})

// The engine's auto-compact window: /autocompact beneath the plugin, its context breakdown.
const autocompact = (on: On, calls: string[], answer: (args: string) => string) =>
  on('command.run', { command: 'autocompact' }, (_, e) => {
    calls.push(String(e.args))
    return { text: answer(String(e.args)) } as never
  })
const SET = (args: string) => `Auto-compact window for claude-opus-5-5 set to ${args} tokens`
const breakdownAt = (window: number, source = 'settings', enabled = true) => ({
  categories: [],
  totalTokens: 0,
  rawMaxTokens: window,
  maxTokens: window,
  percentage: 0,
  model: 'claude-opus-5-5',
  autocompactSource: source,
  autoCompactThreshold: window - 33_000,
  isAutoCompactEnabled: enabled,
})

test('⚙ sets the auto-compact window with /autocompact at once, and a refusal is told without a record', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  const usage = { tokens: 120_000, breakdown: breakdownAt(1_000_000, 'model-default') as object }
  session(on, usage)
  const toasts: string[] = []
  toastsIn(on, toasts)
  const calls: string[] = []
  let refuse = false
  autocompact(on, calls, args => (refuse ? 'CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence' : SET(args)))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  expect((await band.find({ type: 'Text', text: /^Поріг автостиснення:$/ }))?.text).toBe('Поріг автостиснення:')

  usage.breakdown = breakdownAt(200_000)
  await band.press({ key: 'window-200000' })
  expect(calls).toEqual(['200000'])
  expect(toasts).toContain('Поріг автостиснення: Auto-compact window for claude-opus-5-5 set to 200000 tokens')
  expect(saved['compact.window']).toBe(200_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(200_000)

  // «як у рушія» hands the window back to the engine and forgets the record.
  await band.press({ key: 'window-0' })
  expect(calls).toEqual(['200000', 'auto'])
  expect(saved['compact.window']).toBe(0)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(0)

  // A refusal is told and changes nothing: neither the pick nor the record.
  refuse = true
  await band.press({ key: 'window-300000' })
  expect(calls).toEqual(['200000', 'auto', '300000'])
  expect(toasts).toContain('Поріг автостиснення не змінено: CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence')
  expect(saved['compact.window']).toBe(0)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(0)
  await band.unmount()
})

test('a window picked in another session is set here by the timer, once per model, not while a turn runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'compact.window': 400_000 }
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await clock.advance(31_000)
  expect(calls).toEqual([])
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(30_000)
  expect(calls).toEqual(['400000'])
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await clock.advance(5 * 60_000)
  expect(calls).toEqual(['400000'])
})

test('a session started before another one picked a window takes the new pick, not its own old one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  autocompact(on, calls, SET)

  // This session starts with «як у рушія»; another one then sets 400k for the same model.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  saved['compact.window'] = 400_000
  saved['compact.window.model.claude-opus-5-5'] = 400_000
  await clock.advance(31_000)
  expect(calls).toEqual([])
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  expect((await band.find({ type: 'Text', text: /^Поріг автостиснення:$/ }))?.text).toBe('Поріг автостиснення:')
  await band.unmount()
})

test('a pick the session cannot set while busy waits for the timer, and is saved only once the engine took it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const toasts: string[] = []
  toastsIn(on, toasts)
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await band.press({ key: 'window-300000' })
  expect(calls).toEqual([])
  expect(toasts).toContain('Поріг застосую, щойно Claude закінчить відповідь')
  expect(saved['compact.window']).toBeUndefined()
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(31_000)
  expect(calls).toEqual(['300000'])
  expect(saved['compact.window']).toBe(300_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(300_000)
  await clock.advance(5 * 60_000)
  expect(calls).toEqual(['300000'])
  await band.unmount()
})

test('a pick left for the timer and then refused keeps the earlier pick, and is not tried again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'compact.window': 200_000, 'compact.window.model.claude-opus-5-5': 200_000 }
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const toasts: string[] = []
  toastsIn(on, toasts)
  const calls: string[] = []
  autocompact(on, calls, () => 'CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await band.press({ key: 'window-300000' })
  expect(calls).toEqual([])
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(31_000)
  expect(calls).toEqual(['300000'])
  expect(toasts).toContain('Поріг автостиснення не змінено: CLAUDE_CODE_AUTO_COMPACT_WINDOW takes precedence')
  expect(saved['compact.window']).toBe(200_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(200_000)
  await clock.advance(5 * 60_000)
  expect(calls).toEqual(['300000'])
  await band.unmount()
})

test('a pick left for the timer gives way to a newer pick from another session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await band.press({ key: 'window-300000' })
  // Another session, idle, sets 400k meanwhile.
  saved['compact.window'] = 400_000
  saved['compact.window.model.claude-opus-5-5'] = 400_000
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(31_000)
  await clock.advance(31_000)
  expect(calls).toEqual([])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await band.unmount()
})

test('a pick left for the timer gives way to a pick another session made later, even one changed back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'compact.window': 200_000, 'compact.window.model.claude-opus-5-5': 200_000 }
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await band.press({ key: 'window-300000' })
  // Another session picks 400k, then 200k again, after the press here.
  await clock.advance(1_000)
  saved['compact.window'] = 200_000
  saved['compact.window.at'] = NOW + 1_000
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  await clock.advance(31_000)
  await clock.advance(31_000)
  expect(calls).toEqual([])
  expect(saved['compact.window']).toBe(200_000)
  await band.unmount()
})

test('a pick pressed while the timer sets an earlier one goes next, and is the one saved', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  let pressDuring: (() => Promise<unknown>) | null = null
  on('command.run', { command: 'autocompact' }, async (_, e) => {
    calls.push(String(e.args))
    const press = pressDuring
    pressDuring = null
    if (press) await press()
    return { text: SET(String(e.args)) } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await $.turn.start({ text: 'працюй', turnId: 'p1' })
  await band.press({ key: 'window-300000' })
  await $.turn.complete({ ...ANSWERED, turnId: 'p1' })
  pressDuring = () => band.press({ key: 'window-400000' })
  await clock.advance(31_000)
  expect(calls).toEqual(['300000'])
  expect(saved['compact.window']).toBeUndefined()
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await band.unmount()
})

test('a pick pressed while an earlier press is still being set goes next, and is the one saved', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  let pressDuring: (() => Promise<unknown>) | null = null
  on('command.run', { command: 'autocompact' }, async (_, e) => {
    calls.push(String(e.args))
    const press = pressDuring
    pressDuring = null
    if (press) await press()
    return { text: SET(String(e.args)) } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  pressDuring = () => band.press({ key: 'window-400000' })
  await band.press({ key: 'window-300000' })
  expect(calls).toEqual(['300000'])
  expect(saved['compact.window']).toBeUndefined()
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  await band.unmount()
})

test('a pick set here while another session saved a newer one is not saved over it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  on('command.run', { command: 'autocompact' }, (_, e) => {
    calls.push(String(e.args))
    if (calls.length === 1) {
      // Another session sets and saves 400k while this command runs.
      saved['compact.window'] = 400_000
      saved['compact.window.at'] = NOW + 1
      saved['compact.window.model.claude-opus-5-5'] = 400_000
    }
    return { text: SET(String(e.args)) } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  await band.press({ key: 'window-300000' })
  expect(saved['compact.window']).toBe(400_000)
  // The engine now has 300k from here: the timer sets the saved 400k again.
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await band.unmount()
})

test('a pick pressed while an earlier one is being saved wins over it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  let pressDuring: (() => Promise<unknown>) | null = null
  on('store.keys', () => ({ value: Object.keys(saved) }))
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', async (_, e) => {
    if (e.key === 'compact.window.at' && pressDuring) {
      const press = pressDuring
      pressDuring = null
      await press()
    }
    saved[e.key] = e.value
    return { value: undefined }
  })
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  pressDuring = () => band.press({ key: 'window-400000' })
  await band.press({ key: 'window-300000' })
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await band.unmount()
})

test('a pick pressed while an earlier one is being written wins, and its own earlier save does not stop it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'compact.window': 200_000, 'compact.window.model.claude-opus-5-5': 200_000 }
  let pressDuring: (() => Promise<unknown>) | null = null
  let later: Promise<unknown> = Promise.resolve()
  // The newer press reads the shared pick (still 200k) and starts its command; only then does the
  // older 300k reach the store, and the newer command ends after that.
  let entered = (): void => {}
  let written = (): void => {}
  const inCommand = new Promise<void>(r => (entered = r))
  const afterWrite = new Promise<void>(r => (written = r))
  on('store.keys', () => ({ value: Object.keys(saved) }))
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', async (_, e) => {
    if (e.key === 'compact.window' && pressDuring) {
      const press = pressDuring
      pressDuring = null
      later = press()
      await inCommand
    }
    saved[e.key] = e.value
    if (e.key === 'compact.window') written()
    return { value: undefined }
  })
  session(on, { tokens: 120_000 })
  const calls: string[] = []
  on('command.run', { command: 'autocompact' }, async (_, e) => {
    calls.push(String(e.args))
    if (String(e.args) === '400000') {
      entered()
      await afterWrite
    }
    return { text: SET(String(e.args)) } as never
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  await band.press({ key: 'open-settings' })
  pressDuring = () => band.press({ key: 'window-400000' })
  await band.press({ key: 'window-300000' })
  await later
  expect(saved['compact.window']).toBe(400_000)
  await clock.advance(31_000)
  await clock.advance(31_000)
  expect(calls).toEqual(['300000', '400000'])
  expect(saved['compact.window']).toBe(400_000)
  expect(saved['compact.window.model.claude-opus-5-5']).toBe(400_000)
  await band.unmount()
})

test('a threshold that fails to read after the window changed is hidden, and read again on the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let fail = false
  let bd: object = breakdownAt(1_000_000, 'model-default')
  const usage = {
    tokens: 100_000,
    model: 'claude-opus-5-5',
    get breakdown(): object {
      if (fail) throw new Error('API')
      return bd
    },
  }
  session(on, usage)
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 967k/)
  fail = true
  bd = breakdownAt(200_000)
  await band.press({ key: 'open-settings' })
  await band.press({ key: 'window-200000' })
  expect(calls).toEqual(['200000'])
  await band.press({ key: 'open-details' })
  expect(await band.find({ type: 'Text', text: /^стисне на 967k/ })).toBeUndefined()
  fail = false
  await clock.advance(31_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 167k/)
  await band.unmount()
})

test('a threshold the engine does not give after a switch of model is hidden and read again later', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const usage: { tokens: number; model: string; breakdown?: object } = { tokens: 100_000, model: 'claude-opus-5-5', breakdown: breakdownAt(200_000) }
  session(on, usage)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 167k/)

  usage.model = 'claude-sonnet-5-5'
  usage.breakdown = undefined
  await clock.advance(31_000)
  expect(await band.find({ type: 'Text', text: /^стисне на / })).toBeUndefined()
  usage.breakdown = breakdownAt(1_000_000, 'model-default')
  await clock.advance(31_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 967k/)
  await band.unmount()
})

test('a threshold read that fails after a switch of model hides the old one and is tried again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  let fail = false
  let bd: object = breakdownAt(200_000)
  const usage = {
    tokens: 100_000,
    model: 'claude-opus-5-5',
    get breakdown(): object {
      if (fail) throw new Error('API')
      return bd
    },
  }
  session(on, usage)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 167k/)

  fail = true
  usage.model = 'claude-sonnet-5-5'
  bd = breakdownAt(1_000_000, 'model-default')
  await clock.advance(31_000)
  expect(await band.find({ type: 'Text', text: /^стисне на / })).toBeUndefined()
  fail = false
  await clock.advance(31_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 967k/)
  await band.unmount()
})

test('a switch of model brings the threshold of the new model into the details', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const usage: { tokens: number; model?: string; breakdown: object } = { tokens: 100_000, breakdown: breakdownAt(200_000) }
  session(on, usage)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 167k/)

  // /model: no reply yet, the timer notices the new model.
  usage.model = 'claude-sonnet-5-5'
  usage.breakdown = breakdownAt(1_000_000, 'model-default')
  await clock.advance(31_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/^стисне на 967k/)
  await band.unmount()
})

test('the details show where the engine compacts and in about how many turns', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  const usage = { tokens: 100_000, breakdown: breakdownAt(200_000) as object }
  session(on, usage)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // A reply as the app tells it: the turn ends, then the engine measures the new context.
  const reply = async (turnId: string, tokens: number) => {
    usage.tokens = tokens
    await $.turn.complete({ ...ANSWERED, turnId })
    await $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await reply('t1', 100_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'toggle' })
  expect((await band.find({ type: 'Text', text: /^Поріг$/ }))?.text).toBe('Поріг')
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toBe('стисне на 167k (84% вікна) · вікно 200k, з налаштувань')

  // Two replies 20k apart: (167k − 120k) / 20k ≈ 3 turns.
  await reply('t3', 120_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toBe('стисне на 167k (84% вікна) · ≈ через 3 ходи · вікно 200k, з налаштувань')

  await reply('t4', 170_000)
  expect((await band.find({ type: 'Text', text: /^стисне на / }))?.text).toMatch(/· уже на порозі: стисне найближчим часом ·/)

  usage.breakdown = breakdownAt(200_000, 'settings', false)
  await reply('t5', 170_000)
  expect((await band.find({ type: 'Text', text: /^автостиснення рушія/ }))?.text).toBe('автостиснення рушія вимкнено · autoCompactEnabled у налаштуваннях')
  await band.unmount()
})

const ownPlugin = (on: On, version: string) =>
  on('fs.read', (_, e) => {
    if (!String(e.path).endsWith('plugin.json')) throw new Error('not here')
    return { value: JSON.stringify({ name: 'gmdi-token-meter', version }) } as never
  })

test('a first install opens the pages; the recommended choice sets 200k and every setting, then closes', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 50_000, breakdown: breakdownAt(200_000, 'model-default') })
  ownPlugin(on, '0.5.0')
  const toasts: string[] = []
  toastsIn(on, toasts)
  const calls: string[] = []
  autocompact(on, calls, SET)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Вітаю!/ }))?.text).toMatch(/^Вітаю! Це смуга/)
  expect((await band.find({ type: 'Text', text: /знайомство$/ }))?.text).toBe('ⓘ gmdi-token-meter 0.5.0 — знайомство')
  expect((await band.find({ type: 'Text', text: /^1\/5$/ }))?.text).toBe('1/5')

  await band.press({ key: 'intro-next' })
  expect((await band.find({ type: 'Text', text: /^Смуга$/ }))?.text).toBe('Смуга')
  await band.press({ key: 'intro-next' })
  await band.press({ key: 'intro-next' })
  expect((await band.find({ type: 'Text', text: /^• 200k ★/ }))?.text).toMatch(/рекомендовано/)
  expect((await band.find({ type: 'Text', text: /^зараз у цій сесії/ }))?.text).toBe('зараз у цій сесії: стисне на 167k (84% вікна)')
  await band.press({ key: 'intro-next' })
  expect((await band.find({ type: 'Text', text: /^Які налаштування/ }))?.text).toBe('Які налаштування обираєте?')

  await band.press({ key: 'intro-recommended' })
  expect(saved['intro.seen']).toBe('0.5.0')
  expect(saved['compact.window']).toBe(200_000)
  expect(saved['warm.max']).toBe(4)
  expect(saved['compact.at']).toBe(15)
  expect(saved['show.week']).toBe(true)
  expect(calls).toEqual(['200000'])
  expect(toasts).toContain('★ Рекомендовані налаштування застосовано')
  expect(await band.find({ type: 'Text', text: /^Які налаштування/ })).toBeUndefined()
  await band.unmount()
})

test('after an update the pages say what is new; «Пізніше» leaves them for next time, «Свої» opens ⚙', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { lang: 'uk', 'warm.max': 2 }
  storeIn(on, saved)
  session(on, { tokens: 50_000 })
  ownPlugin(on, '0.5.0')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Мод оновлено/ }))?.text).toBe('Мод оновлено до 0.5.0. Що нового:')
  await band.press({ key: 'intro-later' })
  expect(await band.find({ type: 'Text', text: /^Мод оновлено/ })).toBeUndefined()
  expect(saved['intro.seen']).toBeUndefined()

  // «ⓘ Про мод» brings them back; «До вибору», then «Свої» keeps the person's settings.
  await band.press({ key: 'toggle' })
  await band.press({ key: 'about' })
  expect((await band.find({ type: 'Text', text: /^Вітаю!/ }))?.text).toMatch(/^Вітаю!/)
  await band.press({ key: 'intro-skip' })
  await band.press({ key: 'intro-own' })
  expect(saved['intro.seen']).toBe('0.5.0')
  expect(saved['warm.max']).toBe(2)
  expect((await band.find({ type: 'Text', text: /^Поріг автостиснення:$/ }))?.text).toBe('Поріг автостиснення:')
  await band.unmount()
})

test('the pages seen for this version stay closed, and in English they read in English', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  storeIn(on, { 'intro.seen': '0.5.0', lang: 'en' })
  session(on, { tokens: 50_000 })
  ownPlugin(on, '0.5.0')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /getting started$/ })).toBeUndefined()
  await band.press({ key: 'toggle' })
  await band.press({ key: 'about' })
  expect((await band.find({ type: 'Text', text: /getting started$/ }))?.text).toBe('ⓘ gmdi-token-meter 0.5.0 — getting started')
  // Opened by hand: the timer leaves it open until the person closes it.
  await clock.advance(2 * 60_000)
  expect((await band.find({ type: 'Text', text: /getting started$/ }))?.text).toBe('ⓘ gmdi-token-meter 0.5.0 — getting started')
  await band.unmount()
})

test('any key an older mod stored means an update; a first install marks itself and greets again later', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = { 'usage.shared': { next: 0 } }
  storeIn(on, saved)
  session(on, { tokens: 50_000 })
  ownPlugin(on, '0.5.0')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Мод оновлено/ }))?.text).toBe('Мод оновлено до 0.5.0. Що нового:')
  expect(saved['intro.new']).toBeUndefined()
  await band.unmount()
})

test('a first install left for later still greets in the next session, though the mod stored more by then', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved: Record<string, unknown> = {}
  storeIn(on, saved)
  session(on, { tokens: 50_000 })
  ownPlugin(on, '0.5.0')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(saved['intro.new']).toBe('0.5.0')
  saved['usage.shared'] = { next: 0 }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Вітаю!/ }))?.text).toMatch(/^Вітаю! Це смуга/)
  await band.unmount()
})

test('a first install left for later, then updated, says what is new rather than greeting', async ($, on) => {
  mock.clock(on, { now: NOW })
  storeIn(on, { 'intro.new': '0.5.0', 'usage.shared': { next: 0 } })
  session(on, { tokens: 50_000 })
  ownPlugin(on, '0.6.0')

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Мод оновлено/ }))?.text).toBe('Мод оновлено до 0.6.0. Що нового:')
  expect(await band.find({ type: 'Text', text: /^Вітаю!/ })).toBeUndefined()
  await band.unmount()
})
