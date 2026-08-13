/**
 * Pure key-semantics helpers, unit-testable without a terminal.
 *
 * The Ctrl+C state machine mirrors the pi / Claude Code convention:
 * running → interrupt; idle with editor text → clear; idle empty → arm,
 * and a second press inside the window exits.
 */
export type CtrlCAction = 'cancel' | 'clear' | 'arm' | 'exit'

export interface ExitArm {
  lastPressAt: number
}

export function ctrlC(
  state: ExitArm,
  working: boolean,
  editorHasText: boolean,
  now: number,
): { action: CtrlCAction; state: ExitArm; arm: boolean } {
  if (working) return { action: 'cancel', state, arm: false }
  if (editorHasText) {
    // Clearing also arms the timer (pi semantics): the next press inside
    // the window exits.
    return { action: 'clear', state: { lastPressAt: now }, arm: true }
  }
  if (now - state.lastPressAt < 500) {
    return { action: 'exit', state: { lastPressAt: 0 }, arm: false }
  }
  return { action: 'arm', state: { lastPressAt: now }, arm: true }
}

/** Next effort in the model's ordered list, wrapping around. */
export function cycleEffort(
  efforts: readonly { id: string }[],
  current: string | undefined,
): string | undefined {
  if (efforts.length === 0) return undefined
  const index = efforts.findIndex((effort) => effort.id === current)
  if (index === -1) return efforts[0].id
  return efforts[(index + 1) % efforts.length].id
}

/** Split a slash line into its lower-case command name and raw input. */
export function parseSlash(line: string): { name: string; raw: string } | undefined {
  if (!line.startsWith('/')) return undefined
  const rest = line.slice(1)
  const space = rest.search(/\s/)
  if (space === -1) return { name: rest.toLowerCase(), raw: '' }
  return { name: rest.slice(0, space).toLowerCase(), raw: rest.slice(space) }
}
