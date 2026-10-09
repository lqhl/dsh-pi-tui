/**
 * Minimal surfaces of the dsh services this plugin consumes through
 * `ctx.get(...)`. Centralized so a shape drift in a dsh rc upgrade is fixed
 * in one place instead of scattered inline `as` casts.
 */
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

export interface SessionProjectionsService {
  snapshot(session: unknown): { values: Record<string, unknown> }
}

/**
 * One stored-session observation from `ctx.sessionPersistence` (`list`/`stat`).
 * Since 0.2.0-rc.2 the backend pairs the validated {@link SessionHeader} with
 * an opaque `revision` (plus optional `eventCount`/`sizeBytes`) instead of
 * returning bare headers — reading `snapshot.id`/`snapshot.createdAt` is the
 * drift that rendered every persisted session as `undefined · Invalid Date`.
 */
export interface StoredSessionSnapshot {
  readonly header: SessionHeader
}

/**
 * Read side of one stored session opened through
 * {@link SessionPersistenceService.open}: `header` is the validated stored
 * header, `read()` yields the contiguous event log, and `close()` releases the
 * handle (always, even after a failed read).
 */
export interface StoredSessionHandle {
  readonly header: SessionHeader
  read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>
  close(): Promise<void>
}

/**
 * Minimal `ctx.sessionPersistence` surface this plugin consumes. Opening is
 * the only way to read a persisted log — 0.2.0-rc.2 dropped the old
 * header-plus-log `load()` in favour of `open(id, access)` handles.
 */
export interface SessionPersistenceService {
  list(options?: { signal?: AbortSignal }): Promise<readonly StoredSessionSnapshot[]>
  open(
    id: SessionId,
    access: 'read' | 'write',
    options?: { signal?: AbortSignal },
  ): Promise<StoredSessionHandle>
}

/**
 * Minimal `ctx.jobs` (`@deepseek-ai/dsh-jobs`) surface. `list` takes a
 * {@link SessionId} caller: the implementation keeps a job visible when it is
 * unowned or owned by exactly that session id, so passing an Agent object
 * silently hides the session's own jobs from `/jobs` and the status bar.
 */
export interface JobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: string
  readonly owner?: SessionId
}

export interface JobsService {
  list(caller?: SessionId): readonly JobView[]
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

/**
 * Minimal `ctx.shell` (`@deepseek-ai/dsh-shell`) surface. 0.2.0-rc.2 replaced
 * the old `start()`/`run()` convenience methods with an explicit
 * resolve-then-execute seam: {@link resolve} applies the executor's defaults,
 * {@link execute} prepares and spawns, and the returned handle carries both
 * the incremental read cursor and the foreground `result()` projection.
 */
export interface ShellExecRequest {
  command: string
  /** Working directory override (the executor fills its configured default). */
  workdir?: string
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number
  /** Deadline policy at `timeoutMs` expiry; defaults to `'kill'`. */
  onExpiry?: 'kill' | 'none'
  /** Abort signal — the executor kills the command when it fires. */
  signal?: AbortSignal
  /** Fully resolved per-call sandbox policy. */
  sandboxPolicy?: { mode: string; workspaceRoot: string }
}

/** A resolved execution spec — `workdir` and `timeoutMs` are filled and capped. */
export type ShellExecSpec = ShellExecRequest & { workdir: string; timeoutMs: number }

/** The outcome of one foreground run. */
export interface ShellRunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
}

/** One incremental `readOutput()` read: stderr arrives in a marked section. */
export interface ShellProcessRead {
  delta: string
  lossy: boolean
}

/** A live process handle: the only access path, readable after exit. */
export interface ShellProcess {
  readonly status: 'running' | 'completed' | 'killed'
  readonly exitCode: number | null
  readonly signal: string | null
  /** Settles when the process closes; never rejects. */
  readonly done: Promise<void>
  readOutput(): ShellProcessRead
  /** Terminate the process; false when it had already finished. */
  kill(): boolean
}

/** The handle `execute()` returns: the process plus its foreground projection. */
export interface ShellExecution extends ShellProcess {
  result(): Promise<ShellRunResult>
}

export interface ShellService {
  resolve(request: ShellExecRequest): ShellExecSpec
  execute(spec: ShellExecSpec): Promise<ShellExecution>
}
