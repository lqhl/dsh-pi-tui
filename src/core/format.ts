/**
 * Status-bar formatting helpers: permission short names, token shortening,
 * and the context-pressure mini bar. Pure and unit-testable.
 */
import chalk from 'chalk'

const SANDBOX_SHORT: Record<string, string> = {
  'workspace-write': 'ws-write',
  'read-only': 'read-only',
  'danger-full-access': 'danger',
}

/** Short display name for a sandbox mode. */
export function sandboxShort(mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined
  return SANDBOX_SHORT[mode] ?? mode
}

/** Human-readable token count (12345 → '12k', 1234567 → '1.2M'). */
export function shortTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`
  return String(tokens)
}

/**
 * 10-cell context bar colored by pressure: green <70%, yellow 70-90%,
 * red ≥90%. Empty when the total is unknown.
 */
export function renderContextBar(
  used: number | undefined,
  total: number | undefined,
): string | undefined {
  if (used === undefined || total === undefined || total <= 0) return undefined
  const pct = Math.min(100, (100 * used) / total)
  const filled = Math.round(pct / 10)
  const fill = pct >= 90 ? chalk.red('▓') : pct >= 70 ? chalk.yellow('▓') : chalk.green('▓')
  const empty = chalk.dim('░')
  return `${fill.repeat(filled)}${empty.repeat(10 - filled)}`
}

/** Context pressure percentage (0-100), or undefined when unknown. */
export function contextPctOf(
  pressure:
    { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | undefined,
): number | undefined {
  if (pressure?.contextWindow === undefined || pressure.contextWindow <= 0) return undefined
  const tokens = pressure.projectedTokens ?? pressure.pressureTokens
  if (tokens === undefined) return undefined
  return Math.min(100, Math.round((100 * tokens) / pressure.contextWindow))
}
