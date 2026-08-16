/**
 * Startup banner: a hand-drawn ASCII whale in the pi brand blue, plus the
 * product line, session facts, and one-line key hints. Shown on boot and on
 * every session switch.
 */
import chalk from 'chalk'

const BLUE = chalk.hex('#4fc1ff')
const MUTED = chalk.dim

/** DeepSeek-whale silhouette (splash + body + tail), 40 columns wide. */
export const WHALE_ART = [
  '            .',
  "          .:'.",
  "       .-'  ':'  '-.",
  "     .'    : : :    '.",
  '    /      : : :      \\',
  '   |    o   : :   o    |',
  '   |        : :        |',
  "    \\       \\_/       /",
  "     '._           _.'",
  "        '-..__ __..-'",
  "            '-..-'",
  ' ~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^',
].join('\n')

export interface BannerInfo {
  cwd?: string
  preset?: string
  model?: string
}

/** Compose the welcome block (pre-colored; the view renders it verbatim). */
export function buildBanner(info: BannerInfo): string {
  const lines: string[] = [BLUE(WHALE_ART), '', `${BLUE('dsh-pi-tui')} · DeepSeek Harness Terminal UI`]
  const facts: string[] = []
  if (info.model !== undefined) facts.push(`model: ${info.model}`)
  if (info.preset !== undefined) facts.push(`preset: ${info.preset}`)
  if (info.cwd !== undefined) facts.push(`cwd: ${info.cwd}`)
  if (facts.length > 0) lines.push(MUTED(facts.join(' · ')))
  lines.push(MUTED('Esc 中断 · Ctrl+C 退出 · /hotkeys 全部键位'))
  return lines.join('\n')
}
