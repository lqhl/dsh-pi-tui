/**
 * dsh agent/session plumbing: resolve-or-create an agent, list persisted
 * sessions. Mirrors cc-tui's resolveAgent semantics — resume falls back to
 * a fresh session and stays loud in the log.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

export interface ResolvedAgent {
  agent: Agent
  handle?: AgentHandle
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

/** The preset a persisted session runs (last selection event, else header). */
async function persistedPreset(ctx: Context, id: string): Promise<string | undefined> {
  try {
    const persistence = ctx.get('sessionPersistence') as
      | {
          load(id: unknown): Promise<{
            header?: { agentPreset?: string }
            events: readonly { type?: string; data?: { agentPreset?: string } }[]
          }>
        }
      | undefined
    const loaded = await persistence?.load(SessionId(id))
    if (loaded === undefined) return undefined
    for (let index = loaded.events.length - 1; index >= 0; index -= 1) {
      const event = loaded.events[index]
      if (event.type === 'agent-preset/selected' && event.data?.agentPreset !== undefined) {
        return event.data.agentPreset
      }
    }
    return loaded.header?.agentPreset
  } catch {
    return undefined
  }
}

export async function resolveAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  agentOptions: AgentOptions,
  meta: SessionMeta,
): Promise<ResolvedAgent> {
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
      ctx.logger.warn(
        `pi-tui: resume of "${requestedSessionId}" failed, starting fresh: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  try {
    const composition = await composeSetup(ctx, meta.agentPreset)
    const created = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: {
        ...meta,
        ...(composition.agentPreset !== undefined ? { agentPreset: composition.agentPreset } : {}),
      },
      agentOptions,
      ...(composition.setup !== undefined ? { setup: composition.setup } : {}),
    })
    return { agent: created.agent, handle: created }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `pi-tui: failed to create agent (provider=${agentOptions.provider ?? 'deepseek-official'}): ${message}`,
    )
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
    | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
    | undefined
  if (sessions === undefined) {
    throw new Error('pi-tui: sessions service unavailable for fork')
  }
  const seed = sessions.fork(source.session).events
  const presets = ctx.get('agentPresets') as
    | { composedPreset(agentCtx: Context): string | undefined }
    | undefined
  const composition = await composeSetup(
    ctx,
    meta.agentPreset ?? presets?.composedPreset(source.ctx),
  )
  const created = await ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    seed,
    meta: {
      ...meta,
      parentSession: source.session.id,
      ...(composition.agentPreset !== undefined ? { agentPreset: composition.agentPreset } : {}),
    },
    agentOptions,
    ...(composition.setup !== undefined ? { setup: composition.setup } : {}),
  })
  return { agent: created.agent, handle: created }
}

/** Persisted session headers, newest first (dsh's own persistence backend). */
export async function listSessions(ctx: Context): Promise<SessionHeader[]> {
  const persistence = ctx.get('sessionPersistence') as
    | { list(signal?: AbortSignal): Promise<readonly SessionHeader[]> }
    | undefined
  if (persistence === undefined) return []
  try {
    const headers = await persistence.list()
    return [...headers].sort((a, b) => b.createdAt - a.createdAt)
  } catch (error) {
    ctx.logger.warn(
      `pi-tui: listing persisted sessions failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return []
  }
}

export interface PresetInfo {
  id: string
  name?: string
  description?: string
  broken?: string
}

/** The agent-preset roster (标准/PTC 模式/极简/…), name-sorted. */
export async function listPresets(ctx: Context): Promise<PresetInfo[]> {
  const presets = ctx.get('agentPresets') as
    | { list(): Promise<readonly PresetInfo[]> }
    | undefined
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
