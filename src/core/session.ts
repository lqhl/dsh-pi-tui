/**
 * dsh agent/session plumbing: resolve-or-create an agent, list persisted
 * sessions. Mirrors cc-tui's resolveAgent semantics — resume falls back to
 * a fresh session and stays loud in the log.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'

export interface ResolvedAgent {
  agent: Agent
  handle?: AgentHandle
}

/**
 * Attach to an existing agent, resume a persisted session, or create a
 * fresh one.
 */
export async function resolveAgent(
  ctx: Context,
  requestedSessionId: string | undefined,
  agentOptions: AgentOptions,
  meta: { cwd: string },
): Promise<ResolvedAgent> {
  if (requestedSessionId !== undefined) {
    const resumeId = SessionId(requestedSessionId)
    const existing = ctx.agents.get(resumeId)
    if (existing !== undefined) return { agent: existing }
    try {
      const resumed = await ctx.agents.resume({ resumeSessionId: resumeId, agentOptions })
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
    const created = await ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta,
      agentOptions,
    })
    return { agent: created.agent, handle: created }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `pi-tui: failed to create agent (provider=${agentOptions.provider ?? 'deepseek-official'}): ${message}`,
    )
  }
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
