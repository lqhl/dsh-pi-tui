/**
 * Status-bar projection parsing: fold the sessionProjections snapshot values
 * into the status line's read models. Pure and unit-testable.
 */
import { contextPctOf } from './format.js'

export interface ProjectionSnapshot {
  tokens: { input: number; output: number }
  todos?: { done: number; total: number }
  planActive?: boolean
  goalPhase?: string
  contextPct?: number
  contextUsed?: number
  contextTotal?: number
}

/**
 * Parse one projection snapshot's values. The caller owns the single
 * snapshot() call; this folds it into the status-bar fields, falling back
 * to the locally counted tokens when the projection is absent.
 */
export function collectProjection(
  values: Record<string, unknown> | undefined,
  fallbackTokens: { input: number; output: number },
): ProjectionSnapshot {
  const snapshot: ProjectionSnapshot = { tokens: fallbackTokens }
  const usage = (
    values?.tokenUsage as
    | { totals?: { uncachedInputTokens: number; outputTokens: number } }
    | undefined
  )?.totals
  if (usage !== undefined) {
    snapshot.tokens = { input: usage.uncachedInputTokens, output: usage.outputTokens }
  }
  const todoList = values?.todos as { status: string }[] | null | undefined
  if (Array.isArray(todoList)) {
    snapshot.todos = {
      done: todoList.filter((entry) => entry.status === 'completed').length,
      total: todoList.length,
    }
  }
  snapshot.planActive = (values?.plan as { active?: boolean } | undefined)?.active === true
  snapshot.goalPhase = (
    values?.goal as { goal?: { phase?: string } } | null | undefined
  )?.goal?.phase
  const pressure = values?.contextPressure as
    | { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
    | undefined
  snapshot.contextPct = contextPctOf(pressure)
  if (pressure?.contextWindow !== undefined && pressure.contextWindow > 0) {
    snapshot.contextTotal = pressure.contextWindow
    const used = pressure.projectedTokens ?? pressure.pressureTokens
    if (used !== undefined) snapshot.contextUsed = used
  }
  return snapshot
}
