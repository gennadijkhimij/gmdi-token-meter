import type { On, TurnCompleteInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'gmdi-token-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
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
const session = (on: On, usage: { tokens?: number; limits?: typeof LIMITS; sent?: string[] }) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => {
    usage.sent?.push(e.text)
    return { text: e.text }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: usage.tokens, window: 1_000_000 }, rateLimits: usage.limits ?? [] },
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
  expect((await details.find({ type: 'Text', text: /^зараз / }))?.text).toBe('зараз $0.041 · після охолодження $1.66 · у 40 разів дорожче · ціни API')
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

  // /model sonnet-5: within the timer's 30 seconds the price is Sonnet's ($2/M × 2).
  current = 'claude-sonnet-5'
  await clock.advance(30_000)
  const sonnet = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await sonnet.find({ type: 'Text', text: /→/ }))?.text).toBe('→ $0.83')
  await sonnet.unmount()
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
  await $.turn.complete(ANSWERED)

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
