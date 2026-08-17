/**
 * Minimal surfaces of the dsh services this plugin consumes through
 * `ctx.get(...)`. Centralized so a shape drift in a dsh rc upgrade is fixed
 * in one place instead of scattered inline `as` casts.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'

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

/** Minimal dsh-workspace entity surface (the value `resolveByPath`/`create` return). */
export interface WorkspaceService {
  /** Canonical workspace path (registry-stored). */
  readonly path: string
  /**
   * Sessions visible in this workspace: raw `sessionIds` filtered by the
   * registry's per-process canonical-cwd index. The web host's index is a
   * startup snapshot, so TUI-created sessions can be hidden here even when
   * attached (see `reconcileWorkspaceAttachments` in core/session.ts).
   */
  readonly sessionIds: readonly string[]
  attachSession(sessionId: SessionId): Promise<void>
}

/** Minimal `ctx.workspaceRegistry` surface: resolve-or-create by directory path. */
export interface WorkspaceRegistryService {
  resolveByPath(path: string): Promise<WorkspaceService | undefined>
  create(path: string, title?: string): Promise<WorkspaceService>
}
