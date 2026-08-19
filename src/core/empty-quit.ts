/**
 * Discard an unused live session on TUI quit.
 *
 * Persistence already omits zero-event sessions from `list()`, but a header /
 * turn / start event materializes a file. The keep/drop rule is a human
 * prompt — `user/message` with `source.kind === 'user'` (a missing source is
 * treated as human; inject and other non-user sources are not).
 *
 * Runs on the quit path (before `disposeRootAndExit`), not in an `apply()`
 * disposer: those fire too late or mutate the host after teardown. Trash is a
 * rename into macOS Trash or `~/.dsh/sessions-trash` — never a permanent unlink.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  SessionPersistenceLocateService,
  SessionsDetachService,
  WorkspaceRegistryService,
} from './services.js'

/** The live session fields the quit path needs (agent.session). */
export interface EmptyQuitSession {
  id: unknown
  header: SessionHeader
  events: readonly { type?: string; data?: unknown }[]
}

export interface DiscardEmptyResult {
  discarded: boolean
  reason?: 'has-human-prompt'
  trashed?: string
  detached?: boolean
  workspaceDetached?: boolean
}

/**
 * A durable human prompt: `user/message` whose source is `user`, or whose
 * source is absent (legacy / imported logs). `inject` and every other kind
 * are skipped.
 */
export function isHumanUserMessage(event: { type?: string; data?: unknown }): boolean {
  if (event.type !== 'user/message') return false
  if (event.data === null || typeof event.data !== 'object') return false
  const source = (event.data as { source?: unknown }).source
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as { kind?: unknown }).kind === 'user'
}

/** True when the session log contains at least one human prompt. */
export function sessionHasHumanPrompt(session: {
  events: readonly { type?: string; data?: unknown }[]
}): boolean {
  return session.events.some(isHumanUserMessage)
}

/**
 * Quit-path entry: trash the live session only when the feature is on and
 * the log has no human prompt. Returns whether the session was discarded
 * (so the caller can suppress the resume hint).
 */
export async function discardEmptySessionOnQuit(
  ctx: Context,
  session: EmptyQuitSession,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false
  if (sessionHasHumanPrompt(session)) return false
  const result = await discardEmptySession(ctx, session)
  return result.discarded
}

/**
 * Trash + detach one empty session. Refuses a log that already has a human
 * prompt (defense in depth — the quit helper also checks).
 */
export async function discardEmptySession(
  ctx: Context,
  session: EmptyQuitSession,
): Promise<DiscardEmptyResult> {
  if (sessionHasHumanPrompt(session)) {
    return { discarded: false, reason: 'has-human-prompt' }
  }

  // Detach first: workspace.sessionIds hides ids whose header is already
  // gone, and a still-attached write-behind must not recreate the file
  // after the rename.
  const detached = detachLiveSession(ctx, session)
  const workspaceDetached = await detachFromWorkspaces(ctx, session)

  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLocateService | undefined
  let trashed: string | undefined
  let leftover = false
  try {
    const location = persistence?.locate(session.header)
    if (location?.path !== undefined && location.path !== '') {
      const sessionDir = dirname(location.path)
      if (existsSync(sessionDir)) {
        trashed = trashByRename(sessionDir)
        leftover = trashed === undefined && existsSync(sessionDir)
      }
    }
  } catch (error) {
    leftover = true
    ctx.logger.warn(
      `pi-tui: trash of empty session "${String(session.id)}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return {
    discarded: !leftover,
    ...(trashed !== undefined ? { trashed } : {}),
    detached,
    workspaceDetached,
  }
}

/** Rename `targetPath` into Trash / sessions-trash. Never unlinks. */
export function trashByRename(targetPath: string): string | undefined {
  if (!existsSync(targetPath)) return undefined
  for (const trashDir of trashDestinations()) {
    try {
      mkdirSync(trashDir, { recursive: true })
      const destination = uniqueName(trashDir, basename(targetPath) || 'session')
      renameSync(targetPath, destination)
      if (!existsSync(targetPath)) return destination
    } catch {
      // Cross-device rename or a missing Trash dir: try the next destination.
    }
  }
  return undefined
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function trashDestinations(): string[] {
  if (process.env.DSH_SESSION_TRASH_DIR !== undefined && process.env.DSH_SESSION_TRASH_DIR !== '') {
    return [process.env.DSH_SESSION_TRASH_DIR]
  }
  const destinations: string[] = []
  if (process.platform === 'darwin') {
    const macosTrash = join(homedir(), '.Trash')
    if (existsSync(macosTrash)) destinations.push(macosTrash)
  }
  destinations.push(join(dshHome(), 'sessions-trash'))
  return destinations
}

function uniqueName(directory: string, base: string): string {
  let destination = join(directory, base)
  let suffix = 1
  while (existsSync(destination)) {
    destination = join(directory, `${base} ${suffix}`)
    suffix += 1
  }
  return destination
}

function detachLiveSession(ctx: Context, session: EmptyQuitSession): boolean {
  const sessions = ctx.get('sessions') as SessionsDetachService | undefined
  if (sessions === undefined) return false
  const id = String(session.id)
  try {
    const store = sessions.store
    const entry = store?.get?.(id)
    if (entry !== undefined && typeof sessions.detachEntered === 'function') {
      sessions.detachEntered(entry)
      return true
    }
    if (store !== undefined && typeof store.delete === 'function') {
      store.delete(id)
      return true
    }
  } catch (error) {
    ctx.logger.warn(
      `pi-tui: detach of empty session "${id}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return false
}

async function detachFromWorkspaces(ctx: Context, session: EmptyQuitSession): Promise<boolean> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
  if (registry?.list === undefined) return false
  const id = String(session.id)
  let detached = false
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.some((candidate) => String(candidate) === id)) continue
    if (workspace.detachSession === undefined) continue
    try {
      await workspace.detachSession(SessionId(String(session.id)))
      detached = true
    } catch (error) {
      ctx.logger.warn(
        `pi-tui: workspace detach of empty session "${id}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return detached
}
