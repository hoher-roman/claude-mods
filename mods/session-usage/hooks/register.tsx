import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

// The engine does not tell a mod the prompt cache's TTL: this session's main
// thread caches for an hour (5 minutes once the account is in usage overage).
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_MS = 5 * 60 * 1000
const TICK_MS = 5000
const WARN_PERCENT = 80
const CAUTION_PERCENT = 60

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const usageAtom = atom({ plugin: 'session-usage', key: 'usage' } as const, { ctxWindow: 0 })
const nowAtom = atom({ plugin: 'session-usage', key: 'now' } as const, 0)

type Measurement = {
  context: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
}

// Toasts already shown; they start over on a reload.
const warned = {
  cacheFor: undefined as number | undefined,
  context: false,
  fiveHourFor: undefined as string | undefined,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    $.ui.status(undefined)
    await measure($, await $.session.usage())
    await tick($)
    $.clock.every(TICK_MS, () => void tick($))

    return result
  })

  on('session.measure', async ($, e, next) => {
    await measure($, e)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage

    if (e.agentId === undefined && usage) {
      const cached = usage.cache_read_input_tokens
      const written = usage.cache_creation_input_tokens
      const input = usage.input_tokens + cached + written
      const now = await $.clock.now()

      await update($, usageAtom, last => ({
        ...last,
        hitPercent: input > 0 ? Math.round((cached / input) * 100) : undefined,
        // A response that read less back than it wrote anew found the cache cold.
        coldRewrite: last.lastResponseAt !== undefined && cached < written ? written : undefined,
        lastResponseAt: now,
      }))
      await update($, nowAtom, () => now)
    }

    return response
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const usage = await read($, usageAtom)
    const now = await read($, nowAtom)
    const { Box, Text } = $.ui.resolve(e)

    const left = usage.lastResponseAt === undefined ? undefined : usage.lastResponseAt + CACHE_TTL_MS - now
    const isCold = left !== undefined && left <= 0
    const ctx = usage.ctxPercent ?? 0

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Box key="ctx" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={0} columnGap={1} flexGrow={1} justifyContent="center">
          <Text bold dimColor>CTX</Text>
          <Text mono tabular color={level(ctx)}>{percent(usage.ctxPercent)}</Text>
          <Text mono tabular dimColor>
            {usage.ctxTokens === undefined ? '   –/–   ' : `${kilo(usage.ctxTokens)}/${kilo(usage.ctxWindow)}`}
          </Text>
        </Box>
        <Box key="cache" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={0} columnGap={1} flexGrow={1} justifyContent="center">
          <Text bold dimColor>CACHE</Text>
          <Text mono tabular color={usage.hitPercent === undefined || usage.hitPercent >= WARN_PERCENT ? 'success' : 'warning'}>
            {percent(usage.hitPercent)}
          </Text>
          <Text mono tabular color={isCold ? 'error' : left !== undefined && left <= CACHE_WARN_MS ? 'warning' : 'text'}>
            {left === undefined ? '⏳  –:––' : isCold ? '❄ cold' : `⏳ ${countdown(left)}`}
          </Text>
          {usage.coldRewrite === undefined ? null : (
            <Text mono tabular dimColor>{`↻ ${kilo(usage.coldRewrite)}`}</Text>
          )}
        </Box>
        <Box key="5h" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={0} columnGap={1} flexGrow={1} justifyContent="center">
          <Text bold dimColor>5H</Text>
          <Text mono tabular color={level(usage.fiveHour?.percent ?? 0)}>{percent(usage.fiveHour?.percent)}</Text>
          <Text mono tabular dimColor>{usage.fiveHour?.resetsAt ? `↺ ${until(usage.fiveHour.resetsAt, now)}` : '↺ –h ––m'}</Text>
        </Box>
        <Box key="7d" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={0} columnGap={1} flexGrow={1} justifyContent="center">
          <Text bold dimColor>7D</Text>
          <Text mono tabular color={level(usage.sevenDay?.percent ?? 0)}>{percent(usage.sevenDay?.percent)}</Text>
          <Text mono tabular dimColor>{usage.sevenDay?.resetsAt ? `↺ ${weekday(usage.sevenDay.resetsAt)}` : '↺ –– ––:––'}</Text>
        </Box>
      </Box>
    )
  })
}

async function measure($: EngineInterface, measurement: Measurement) {
  const context = measurement.context
  const fiveHour = limit(measurement.rateLimits, 'five_hour')
  const sevenDay = limit(measurement.rateLimits, 'seven_day')

  await update($, usageAtom, last => ({
    ...last,
    ctxTokens: context.tokens,
    ctxWindow: context.window,
    ctxPercent: context.percent,
    fiveHour,
    sevenDay,
  }))

  const ctx = context.percent ?? 0
  if (ctx >= WARN_PERCENT && !warned.context) {
    warned.context = true
    $.ui.toast(`Context is ${ctx}% full`, { timeoutMs: 8000 })
  } else if (ctx < WARN_PERCENT) {
    warned.context = false
  }

  const window = fiveHour?.resetsAt ?? 'unknown'
  if (fiveHour && fiveHour.percent >= WARN_PERCENT && warned.fiveHourFor !== window) {
    warned.fiveHourFor = window
    const reset = fiveHour.resetsAt ? `, resets at ${clock(fiveHour.resetsAt)}` : ''
    $.ui.toast(`5h limit is at ${fiveHour.percent}%${reset}`, { timeoutMs: 8000 })
  }
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const usage = await read($, usageAtom)

  if (usage.lastResponseAt !== undefined && warned.cacheFor !== usage.lastResponseAt) {
    const left = usage.lastResponseAt + CACHE_TTL_MS - now
    if (left > 0 && left <= CACHE_WARN_MS) {
      warned.cacheFor = usage.lastResponseAt
      $.ui.toast('Prompt cache expires in 5 min', { timeoutMs: 8000 })
    }
  }

  await update($, nowAtom, () => now)
}

function limit(rateLimits: readonly SessionRateLimit[], kind: string): Limit | undefined {
  const found = rateLimits.find(r => r.kind === kind)

  return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : undefined
}

function level(value: number) {
  return value >= WARN_PERCENT ? 'error' : value >= CAUTION_PERCENT ? 'warning' : 'success'
}

function percent(value: number | undefined) {
  return value === undefined ? '  –%' : `${String(Math.round(value)).padStart(3)}%`
}

function kilo(tokens: number) {
  const text = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`

  return text.padStart(4)
}

function countdown(ms: number) {
  const seconds = Math.ceil(ms / 1000)

  return `${String(Math.floor(seconds / 60)).padStart(2)}:${String(seconds % 60).padStart(2, '0')}`
}

function clock(iso: string) {
  const at = new Date(iso)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function until(iso: string, now: number) {
  const minutes = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000))

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function weekday(iso: string) {
  return `${DAYS[new Date(iso).getDay()]} ${clock(iso)}`
}
