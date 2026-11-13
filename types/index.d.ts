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

export type Settings = { lang: Lang; ttl: '1h' | '5m'; warmMax: WarmMax; warnAt: WarnAt; budget: Budget; show: Blocks }

// How the session is signed in: a subscription (Free/Pro/Max/Team/Enterprise), an API key,
// none the engine names (a gateway, Bedrock, Vertex), or not asked yet.
export type Plan = 'bearer' | 'api-key' | 'other' | 'unknown'

// Extra usage (overage) of a subscription for the billing period, as the usage endpoint
// reports it, in major units (dollars): `limit` null is no monthly cap.
export type Extra = { enabled: boolean; limit: number | null; used: number | null; currency: string; at: number }

export type View = 'closed' | 'details' | 'settings'

// The warmer in this session: paused by the person, and how many prompts it sent since their last one.
export type Warm = { paused: boolean; done: number; lastAt: number | null }

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
    }
  }
}
