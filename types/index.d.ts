export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Context = { tokens?: number; window: number; percent?: number }

export type Lang = 'uk' | 'en'

// Which blocks the band and its details draw; every one is on by default.
export type Blocks = {
  label: boolean
  week: boolean
  fiveHour: boolean
  reset: boolean
  words: boolean
  cache: boolean
  price: boolean
  forecast: boolean
  priceDetails: boolean
  models: boolean
  session: boolean
  money: boolean
}

// How many times in a row the warmer may refresh an idle session's cache; 0 is off.
export type WarmMax = 0 | 2 | 4 | 8

// From what share of a limit window the band warns (95 % is always the second step); 0 is off.
export type WarnAt = 0 | 70 | 80 | 90

// The person's own monthly cap on paid usage, in dollars; 0 leaves only the organization's.
export type Budget = 0 | 50 | 100 | 150 | 200 | 500

// How many minutes before the cache cools the band offers to compact the session; 0 is off.
export type CompactAt = 0 | 10 | 15 | 20

// The least a cold restart must cost, in dollars, before compacting is offered.
export type CompactMin = 0.5 | 1 | 2 | 5

// The engine's auto-compact window the mod sets with /autocompact, in tokens; 0 leaves the engine's own.
// The engine compacts at the window less a fixed 33k buffer: 200k compacts at 167k.
export type CompactWindow = 0 | 100000 | 200000 | 300000 | 400000

export type Settings = {
  lang: Lang
  ttl: '1h' | '5m'
  warmMax: WarmMax
  warnAt: WarnAt
  budget: Budget
  compactAt: CompactAt
  compactMin: CompactMin
  // Compact on its own once the cache is about to cool and the session is idle; off by default.
  compactAuto: boolean
  compactWindow: CompactWindow
  show: Blocks
}

// How the session is signed in: a subscription (Free/Pro/Max/Team/Enterprise), an API key,
// none the engine names (a gateway, Bedrock, Vertex), or not asked yet.
export type Plan = 'bearer' | 'api-key' | 'other' | 'unknown'

// Extra usage (overage) of a subscription for the billing period, as the usage endpoint
// reports it, in major units (dollars): `limit` null is no monthly cap.
export type Extra = { enabled: boolean; limit: number | null; used: number | null; currency: string; at: number }

export type View = 'closed' | 'details' | 'settings' | 'intro'

// The warmer in this session: paused by the person, and how many prompts it sent since their last one.
export type Warm = { paused: boolean; done: number; lastAt: number | null }

// The last compaction of this session as the mod saw it: running, done (sizes in tokens) or failed.
// `dismissedFor` / `autoFor`: the cache (its reply time) the offer was dismissed or auto-compacted for.
export type Compaction = {
  state: 'idle' | 'running' | 'done' | 'failed'
  at: number | null
  before: number | null
  after: number | null
  reason: string | null
  auto: boolean
  dismissedFor: number | null
  autoFor: number | null
}

// The engine's auto-compact threshold for the session's model, read from its context breakdown:
// `at` is null when auto-compaction is off; `window` is what it is measured against.
export type Threshold = { at: number | null; window: number; source: string }

// How the context grew per answered turn, for the «compacts in ≈N turns» forecast.
export type Growth = { last: number | null; avg: number | null }

// The getting-to-know-the-mod pages: shown once per version, on install and on every update.
// `from` is the version seen before ('old' for one before 0.5.0, null for a first install).
export type Intro = { version: string | null; from: string | null; page: number; manual: boolean }

// What earlier compactions on this computer came to: the context after one, the summary's length.
export type Learned = { after: number | null; out: number | null }

declare module 'claude-code' {
  interface PluginState {
    'gmdi-token-meter': {
      limits: Limit[]
      context: Context | null
      costUsd: number | null
      startedAt: number | null
      lastReplyAt: number | null
      replyModel: string | null
      model: string | null
      settings: Settings | null
      view: View
      tick: number
      warm: Warm
      plan: Plan
      extra: Extra | null
      spend: number | null
      compaction: Compaction
      learned: Learned
      threshold: Threshold | null
      growth: Growth
      intro: Intro
    }
  }
}
