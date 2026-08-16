/**
 * Minimal surfaces of the dsh services this plugin consumes through
 * `ctx.get(...)`. Centralized so a shape drift in a dsh rc upgrade is fixed
 * in one place instead of scattered inline `as` casts.
 */

export interface SessionProjectionsService {
  snapshot(session: unknown): { values: Record<string, unknown> }
}

export interface JobsService {
  list(caller?: unknown): readonly {
    id: string
    kind: string
    label: string
    status: string
  }[]
}

export interface AgentDefaultModelService {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
  saveSelection(next: unknown): Promise<void>
}
