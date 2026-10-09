/**
 * dsh agent/session plumbing: resolve-or-create an agent, list persisted
 * sessions. Mirrors cc-tui's resolveAgent semantics — resume falls back to
 * a fresh session and stays loud in the log.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  SessionPersistenceService,
  StoredSessionHandle,
  WorkspaceRegistryService,
} from './services.js'

export interface ResolvedAgent {
  agent: Agent
  handle?: AgentHandle
  /**
   * Set when an explicitly requested session could NOT be resumed and a brand
   * new session took its place instead. Resuming fails when the stored session
   * is gone, unreadable, or still write-owned by another live process — and a
   * silent fallback is indistinguishable from "the session had no history",
   * which is exactly how it was reported. Callers MUST surface this.
   */
  resumeFailure?: { requestedId: string; reason: string }
}

/** `ctx.sessionPersistence`, or undefined when durable sessions are not mounted. */
function persistenceOf(ctx: Context): SessionPersistenceService | undefined {
  return ctx.get('sessionPersistence') as SessionPersistenceService | undefined
}

/** Release a read handle without masking the read result with a close failure. */
async function closeQuietly(handle: StoredSessionHandle): Promise<void> {
  await handle.close().catch(() => {
    // Best effort: the log this handle served is already in hand.
  })
}

/**
 * Open one stored session for reading. A read handle never claims write
 * ownership, so this works on a session that is live in this process or in
 * another one. Callers MUST close the handle.
 */
async function openStoredSession(
  ctx: Context,
  id: string,
): Promise<StoredSessionHandle | undefined> {
  const persistence = persistenceOf(ctx)
  if (persistence === undefined) return undefined
  return persistence.open(SessionId(id), 'read')
}

/**
 * Read one stored session's contiguous event log through a `read` handle.
 * Rejects when the stored session is missing or unreadable; the handle is
 * always closed.
 */
export async function readSessionEvents(
  ctx: Context,
  id: string,
): Promise<readonly SessionEvent[]> {
  const handle = await openStoredSession(ctx, id)
  if (handle === undefined) return []
  try {
    return (await handle.read()).events
  } finally {
    await closeQuietly(handle)
  }
}

/** Session-creation metadata the TUI passes (cwd + optional agent preset). */
export interface SessionMeta {
  cwd: string
  agentPreset?: string
}

/**
 * Attach to an existing agent, resume a persisted session, or create a
 * fresh one.
 */
/**
 * Resolve the agent-preset composition for one agent: mount the named (or
 * default) preset's standing composition through the creation/resume setup
 * callback — the ONLY supported call site, mirroring the web host.
 */
async function composeSetup(
  ctx: Context,
  presetId: string | undefined,
): Promise<{ agentPreset?: string; setup?: (agentCtx: Context) => Promise<void> }> {
  const presets = ctx.get('agentPresets') as
    | {
        resolve(id?: string): Promise<{ id: string }>
        mount(agentCtx: Context, id: string): Promise<unknown>
      }
    | undefined
  if (presets === undefined) return {}
  try {
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, resolvedId)
      },
    }
  } catch {
    return {}
  }
}

/**
 * Attach a freshly created session to the workspace owning its cwd, creating
 * the workspace when the directory is not registered yet. The web host does
 * this inside its `create`/`fork` RPC handlers (`workspace.attachSession`);
 * the TUI creates agents in-process through `ctx.agents.create` and bypasses
 * that layer, so without this the session's cwd never enters any workspace's
 * `sessionIds` account and the web sidebar files it under "Ungrouped".
 *
 * Best-effort: missing registry or a failed attach logs a warning instead of
 * failing session creation.
 */
async function attachToWorkspace(
  ctx: Context,
  sessionId: SessionId,
  cwd: string | undefined,
): Promise<void> {
  if (cwd === undefined || cwd === '') return
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  if (registry === undefined) return
  try {
    const workspace = (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd))
    await workspace.attachSession(sessionId)
  } catch (error) {
    ctx.logger.warn(
      `pi-tui: workspace attach for "${String(sessionId)}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/** Copy-pasteable resume command for a persisted session. */
export function resumeCommand(sessionId: string): string {
  return `dsh --profile pi-tui --resume ${sessionId}`
}

/**
 * Attach a freshly created/forked session to its cwd's workspace on the
 * FIRST durable event instead of at creation. A session that never produces
 * any event leaves nothing behind: the persistence backend already skips
 * zero-event sessions in `list()`, and this keeps the workspace record
 * empty too. `attachToWorkspace` still swallows its own errors.
 */
export function attachWorkspaceOnFirstEvent(
  ctx: Context,
  sessionId: SessionId,
  cwd: string | undefined,
): void {
  if (cwd === undefined || cwd === '') return
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  if (registry === undefined) return
  const off = ctx.on('session/event', (session) => {
    if (session.id !== sessionId) return
    off()
    void attachToWorkspace(ctx, sessionId, cwd)
  })
}

/**
 * Heal workspace grouping after the harness's cross-process index staleness.
 *
 * dsh-workspace builds its session→canonical-cwd index ONCE per process and
 * filters/prunes workspace membership against it. A web host that started
 * before the TUI created a session therefore:
 *   1. hides that session from the web sidebar (it lands in "Ungrouped")
 *      even though `attachWorkspaceOnFirstEvent` wrote it to the workspace's
 *      raw sessionIds, and
 *   2. DURABLY prunes it from the raw list on its next workspace write
 *      (rename/archive/attach), permanently orphaning it.
 *
 * Run at TUI boot: for every persisted session whose canonical cwd resolves
 * to an existing workspace but is missing from it, re-attach it. Additive
 * only — no workspaces are created, no entries are pruned — so it can only
 * repair, never destroy. The web host's own VIEW still needs a restart to
 * rebuild its index; this heals the durable data loss that would otherwise
 * be unrecoverable.
 */
export async function reconcileWorkspaceAttachments(ctx: Context): Promise<number> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  const persistence = persistenceOf(ctx)
  if (registry === undefined || persistence === undefined) return 0
  try {
    const snapshots = await persistence.list()
    let repaired = 0
    for (const { header } of snapshots) {
      if (header.cwd === undefined || header.cwd === '') continue
      let canonical: string
      try {
        canonical = await realpath(header.cwd)
      } catch {
        continue // unresolvable cwd — no workspace can own it
      }
      // resolveByPath canonicalizes internally and returns the workspace
      // whose stored path equals this session's cwd, or undefined.
      const workspace = await registry.resolveByPath(canonical)
      if (workspace === undefined) continue
      // The entity's filtered view is accurate in THIS process (fresh index),
      // so a miss means the raw list lost the session — re-attach it.
      if (workspace.sessionIds.includes(String(header.id))) continue
      await workspace.attachSession(header.id)
      repaired += 1
    }
    if (repaired > 0) {
      ctx.logger.info(`pi-tui: re-attached ${repaired} session(s) to their cwd workspace`)
    }
    return repaired
  } catch (error) {
    ctx.logger.warn(
      `pi-tui: workspace reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return 0
  }
}

/**
 * Event envelope for scans by event-type name. `SessionEvent`'s mapped union
 * only covers the types THIS bundle links (dsh-session plus the packages it
 * imports); `session/title` and `agent-preset/selected` are declared by other
 * bundles, so those scans narrow through this structural view.
 */
type ScanEvent = { readonly type?: string; readonly data?: Record<string, unknown> }

/** The preset a persisted session runs (last selection event, else header). */
async function persistedPreset(ctx: Context, id: string): Promise<string | undefined> {
  let handle: StoredSessionHandle | undefined
  try {
    handle = await openStoredSession(ctx, id)
    if (handle === undefined) return undefined
    const { events } = await handle.read()
    const scanned = events as readonly ScanEvent[]
    for (let index = scanned.length - 1; index >= 0; index -= 1) {
      const event = scanned[index]
      if (event?.type === 'agent-preset/selected') {
        const preset = event.data?.agentPreset
        if (typeof preset === 'string') return preset
      }
    }
    return handle.header.agentPreset
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) await closeQuietly(handle)
  }
}

export async function resolveAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  agentOptions: AgentOptions,
  meta: SessionMeta,
): Promise<ResolvedAgent> {
  let resumeFailure: ResolvedAgent['resumeFailure']
  if (requestedSessionId !== undefined) {
    const resumeId = SessionId(requestedSessionId)
    const existing = ctx.agents.get(resumeId)
    if (existing !== undefined) return { agent: existing }
    try {
      // Only mount a preset composition when the persisted session records
      // one — a failed probe must not silently re-compose a preset-less
      // session under the default.
      const sessionPreset = await persistedPreset(ctx, requestedSessionId)
      const composition = sessionPreset !== undefined ? await composeSetup(ctx, sessionPreset) : {}
      const resumed = await ctx.agents.resume({
        resumeSessionId: resumeId,
        agentOptions,
        ...(composition.setup !== undefined ? { setup: composition.setup } : {}),
      })
      return { agent: resumed.agent, handle: resumed }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`pi-tui: resume of "${requestedSessionId}" failed, starting fresh: ${reason}`)
      resumeFailure = { requestedId: requestedSessionId, reason }
    }
  }
  const composition = await composeSetup(ctx, meta.agentPreset)
  const sessionId = SessionId(randomUUID())
  let created: AgentHandle
  try {
    created = await ctx.agents.create({
      sessionId,
      meta: {
        ...meta,
        ...(composition.agentPreset !== undefined ? { agentPreset: composition.agentPreset } : {}),
      },
      agentOptions,
      ...(composition.setup !== undefined ? { setup: composition.setup } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `pi-tui: failed to create agent (provider=${agentOptions.provider ?? 'deepseek-official'}): ${message}`,
      { cause: error },
    )
  }
  // Workspace grouping is deferred to the first durable event: a failed attach
  // must never be reported as an agent-create failure, and an empty session
  // (never any event) should leave no workspace record behind.
  attachWorkspaceOnFirstEvent(ctx, sessionId, meta.cwd)
  return {
    agent: created.agent,
    handle: created,
    ...(resumeFailure !== undefined ? { resumeFailure } : {}),
  }
}

/**
 * Fork the agent's session at its current end and open a NEW agent over the
 * forked log (cc-tui's rewind pattern): lineage recorded, transcript kept,
 * fresh session id.
 */
export async function forkSession(
  ctx: Context,
  source: Agent,
  agentOptions: AgentOptions,
  meta: SessionMeta,
): Promise<ResolvedAgent> {
  const sessions = ctx.get('sessions') as
    | { fork(source: unknown, boundary?: number): { snapshotEvents(): readonly SessionEvent[] } }
    | undefined
  if (sessions === undefined) {
    throw new Error('pi-tui: sessions service unavailable for fork')
  }
  const seed = sessions.fork(source.session).snapshotEvents()
  const presets = ctx.get('agentPresets') as
    { composedPreset(agentCtx: Context): string | undefined } | undefined
  const composition = await composeSetup(
    ctx,
    meta.agentPreset ?? presets?.composedPreset(source.ctx),
  )
  const childId = SessionId(randomUUID())
  const created = await ctx.agents.create({
    sessionId: childId,
    seed,
    meta: {
      ...meta,
      parentSession: source.session.id,
      ...(composition.agentPreset !== undefined ? { agentPreset: composition.agentPreset } : {}),
    },
    agentOptions,
    ...(composition.setup !== undefined ? { setup: composition.setup } : {}),
  })
  attachWorkspaceOnFirstEvent(ctx, childId, meta.cwd)
  return { agent: created.agent, handle: created }
}

/**
 * Persisted session headers, newest first (dsh's own persistence backend).
 *
 * `list()` observes stored sessions as `{ header, revision }` snapshots — the
 * header supplies the id/cwd/createdAt the pickers render.
 */
export async function listSessions(ctx: Context): Promise<SessionHeader[]> {
  const persistence = persistenceOf(ctx)
  if (persistence === undefined) return []
  try {
    const snapshots = await persistence.list()
    return snapshots.map((snapshot) => snapshot.header).sort((a, b) => b.createdAt - a.createdAt)
  } catch (error) {
    ctx.logger.warn(
      `pi-tui: listing persisted sessions failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return []
  }
}

/**
 * What a picker needs to know about one stored session, folded from a single
 * read of its log: its latest title, and whether it holds any conversation at
 * all. `hasContent` matters because a session the harness created but nobody
 * ever prompted (the TUI makes one on every boot) resumes to an empty
 * transcript, which is indistinguishable from a broken resume.
 */
export interface SessionSummary {
  title?: string
  hasContent: boolean
}

/** Fold one persisted log into its {@link SessionSummary}. */
function summarize(events: readonly ScanEvent[]): SessionSummary {
  let title: string | undefined
  let hasContent = false
  for (const event of events) {
    if (event?.type === 'session/title') {
      const value = event.data?.title
      if (typeof value === 'string' && value !== '') title = value
    } else if (event?.type === 'assistant/message') {
      hasContent = true
    } else if (event?.type === 'user/message') {
      // Only a direct human prompt counts; injected context (agent
      // instructions, runtime snapshots, goal/skill bodies) does not make a
      // session look like it has a conversation.
      const source = event.data?.source as { kind?: unknown } | undefined
      if (source?.kind === 'user') hasContent = true
    }
  }
  return title !== undefined ? { title, hasContent } : { hasContent }
}

/**
 * Summary for one persisted session. Reading the whole log is I/O, so callers
 * bound how many sessions they ask about (see {@link sessionSummaries}).
 */
export async function persistedSummary(ctx: Context, id: string): Promise<SessionSummary> {
  try {
    const events = (await readSessionEvents(ctx, id)) as readonly ScanEvent[]
    return summarize(events)
  } catch {
    // An unreadable log is not an empty one; claim content so the picker does
    // not mislabel it as resumable-but-empty.
    return { hasContent: true }
  }
}

/**
 * Last `session/title` value in a persisted session's log, or undefined.
 * Mirrors `persistedPreset`'s bounded scan; the picker shows titles instead
 * of bare `basename(cwd)` labels.
 */
export async function persistedTitle(ctx: Context, id: string): Promise<string | undefined> {
  return (await persistedSummary(ctx, id)).title
}

/**
 * Summaries for the newest `limit` headers, keyed by session id. Loading full
 * logs is I/O, so callers bound it — boot/resume pickers pass the
 * already-sorted, already-capped header list.
 */
export async function sessionSummaries(
  ctx: Context,
  headers: readonly SessionHeader[],
  limit = 15,
): Promise<Map<string, SessionSummary>> {
  const summaries = new Map<string, SessionSummary>()
  for (const header of headers.slice(0, limit)) {
    const id = String(header.id)
    summaries.set(id, await persistedSummary(ctx, id))
  }
  return summaries
}

/**
 * Titles for the newest `limit` headers, keyed by session id (sessions with
 * no title are absent).
 */
export async function sessionTitles(
  ctx: Context,
  headers: readonly SessionHeader[],
  limit = 15,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (const [id, summary] of await sessionSummaries(ctx, headers, limit)) {
    if (summary.title !== undefined) titles.set(id, summary.title)
  }
  return titles
}

export interface PresetInfo {
  id: string
  name?: string
  description?: string
  broken?: string
}

/** The agent-preset roster (标准/PTC 模式/极简/…), name-sorted. */
export async function listPresets(ctx: Context): Promise<PresetInfo[]> {
  const presets = ctx.get('agentPresets') as { list(): Promise<readonly PresetInfo[]> } | undefined
  if (presets === undefined) return []
  try {
    const all = await presets.list()
    return [...all]
      .filter((preset) => preset.broken === undefined)
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
  } catch {
    return []
  }
}
