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
}

// How many times in a row the warmer may refresh an idle session's cache; 0 is off.
export type WarmMax = 0 | 2 | 4 | 8

export type Settings = { lang: Lang; ttl: '1h' | '5m'; warmMax: WarmMax; show: Blocks }

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
      model: string | null
      settings: Settings | null
      view: View
      tick: number
      warm: Warm
    }
  }
}
