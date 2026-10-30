export type Limit = { percent: number; resetsAt?: string }

export type Usage = {
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  fiveHour?: Limit
  sevenDay?: Limit
  hitPercent?: number
  lastResponseAt?: number
  coldRewrite?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-usage': { usage: Usage; now: number }
  }
}
