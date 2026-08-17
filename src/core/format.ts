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

/**
 * Truncate text to `maxWidth` characters, appending a single-character
 * ellipsis when it overflows. `maxWidth <= 0` yields an empty string.
 */
export function ellipsize(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (text.length <= maxWidth) return text
  if (maxWidth === 1) return '…'
  return `${text.slice(0, maxWidth - 1)}…`
}

/**
 * Wrap every case-insensitive occurrence of `query` in `text` with a
 * yellow-underline highlight (the transcript-search marker). A blank query
 * returns the text unchanged; used by the views only while a find is active.
 */
export function highlightMatches(text: string, query: string): string {
  const needle = query.trim().toLowerCase()
  if (needle === '' || text === '') return text
  const lower = text.toLowerCase()
  const out: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    const at = lower.indexOf(needle, cursor)
    if (at === -1) {
      out.push(text.slice(cursor))
      break
    }
    if (at > cursor) out.push(text.slice(cursor, at))
    out.push(chalk.underline.yellow(text.slice(at, at + needle.length)))
    cursor = at + needle.length
  }
  return out.join('')
}

/** Status-bar git segment: `git:main*` (star = dirty working tree). */
export function gitLabel(branch: string, dirty: boolean): string {
  return `git:${branch}${dirty ? '*' : ''}`
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
