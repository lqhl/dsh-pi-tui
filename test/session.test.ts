import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  forkSession,
  listSessions,
  persistedSummary,
  persistedTitle,
  readSessionEvents,
  reconcileWorkspaceAttachments,
  resolveAgent,
  resumeCommand,
  sessionSummaries,
  sessionTitles,
  type SessionMeta,
} from '../src/core/session.js'

const OPTIONS: AgentOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const META: SessionMeta = { cwd: '/tmp/pi-tui-test' }

const fakeAgent = (id: string): Agent => ({ id }) as unknown as Agent
const fakeHandle = (id: string): AgentHandle => ({
  agent: fakeAgent(id),
  dispose: async () => {},
})

/**
 * A stored session as `ctx.sessionPersistence.list()` actually reports it
 * since 0.2.0-rc.2: a `{ header, revision }` snapshot, NOT a bare header.
 * Mocks that returned bare headers hid the `undefined · Invalid Date` bug.
 */
const snapshot = (id: string, extra: Partial<SessionHeader> = {}): { header: SessionHeader } => ({
  header: { version: 4, id, createdAt: 1, isSeeded: false, ...extra } as SessionHeader,
})

/**
 * Fake persistence store keyed by session id. `list()` hands out snapshots and
 * `open(id, 'read')` a handle; `closed` records teardown.
 */
function fakeStore(
  headers: readonly { header: SessionHeader }[],
  logs: Record<string, readonly SessionEvent[]> = {},
  closed: string[] = [],
): {
  list: () => Promise<readonly { header: SessionHeader }[]>
  open: (
    id: string,
    access: string,
  ) => Promise<{
    header: SessionHeader
    read: () => Promise<{ events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }>
} {
  return {
    list: async () => headers,
    open: async (id, access) => {
      assert.equal(access, 'read', 'the TUI must never claim write ownership of a stored session')
      const found = headers.find((entry) => String(entry.header.id) === String(id))
      if (found === undefined) throw new Error(`session "${String(id)}" not found`)
      return {
        header: found.header,
        read: async () => ({ events: logs[String(id)] ?? [] }),
        close: async () => {
          closed.push(String(id))
        },
      }
    },
  }
}

const event = (type: string, data: unknown): SessionEvent =>
  ({ type, seq: 0, time: 0, data }) as unknown as SessionEvent

interface FakeAgents {
  get: (id: unknown) => Agent | undefined
  resume: (opts: unknown) => Promise<AgentHandle>
  create: (opts: unknown) => Promise<AgentHandle>
}

function makeCtx(
  agents: FakeAgents,
  services: Record<string, unknown> = {},
  warn: (msg: string) => void = () => {},
  on: (event: string, cb: (session: { id: unknown }) => void) => () => void = () => () => {},
): Context {
  const ctx = {
    agents,
    // `info` falls back to the warn sink so success-path logging does not
    // blow up the mock (reconcileWorkspaceAttachments logs on success).
    logger: { warn, info: warn },
    get: (name: string) => services[name],
    on,
  }
  return ctx as unknown as Context
}

/** Capture the deferred `session/event` attach listener and fire it in tests. */
function captureOn(): {
  on: (event: string, cb: (session: { id: unknown }) => void) => () => void
  fire: (id: unknown) => Promise<void>
} {
  let listener: ((session: { id: unknown }) => void) | undefined
  return {
    on: (event, cb) => {
      if (event === 'session/event') listener = cb
      return () => {}
    },
    fire: async (id) => {
      if (listener === undefined) throw new Error('session/event listener not registered')
      listener({ id })
      // Let the fire-and-forget attachToWorkspace promise chain settle.
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('returns an already-live agent without resume/create', async () => {
  const live = fakeAgent('live-1')
  const ctx = makeCtx({
    get: () => live,
    resume: async () => {
      throw new Error('resume should not run')
    },
    create: async () => {
      throw new Error('create should not run')
    },
  })
  const resolved = await resolveAgent(ctx, 'live-1', OPTIONS, META)
  assert.equal(resolved.agent, live)
  assert.equal(resolved.handle, undefined)
})

test('resumes a persisted session with its recorded preset', async () => {
  const resumed = fakeHandle('resumed-1')
  let resumeArgs: { agentOptions: unknown; setup?: unknown } | undefined
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async (opts) => {
        resumeArgs = opts as typeof resumeArgs
        return resumed
      },
      create: async () => {
        throw new Error('create should not run')
      },
    },
    {
      sessionPersistence: fakeStore([snapshot('resumed-1', { agentPreset: 'standard' })], {
        'resumed-1': [event('agent-preset/selected', { agentPreset: 'standard' })],
      }),
      agentPresets: {
        resolve: async (id?: string) => ({ id: id ?? 'default' }),
        mount: async () => {},
      },
    },
  )
  const resolved = await resolveAgent(ctx, 'resumed-1', OPTIONS, META)
  assert.equal(resolved.agent, resumed.agent)
  assert.equal(resolved.handle, resumed)
  assert.equal(resumeArgs?.agentOptions, OPTIONS)
  assert.ok(resumeArgs?.setup !== undefined, 'setup composed from the recorded preset')
})

test('falls back to a fresh session when resume fails', async () => {
  const created = fakeHandle('created-1')
  const warns: string[] = []
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('boom')
      },
      create: async () => created,
    },
    {},
    (msg) => warns.push(msg),
  )
  const resolved = await resolveAgent(ctx, 'resumed-1', OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(resolved.handle, created)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('resume of "resumed-1" failed'))
})

test('throws a loud error when create fails', async () => {
  const ctx = makeCtx({
    get: () => undefined,
    resume: async () => {
      throw new Error('unused')
    },
    create: async () => {
      throw new Error('no factory')
    },
  })
  await assert.rejects(
    resolveAgent(ctx, undefined, OPTIONS, META),
    /failed to create agent \(provider=deepseek-official\): no factory/,
  )
})

test('defers workspace attach for a fresh session until its first event', async () => {
  const created = fakeHandle('created-ws')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
  const on = captureOn()
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unused')
      },
      create: async (opts) => {
        createOpts = opts as typeof createOpts
        return created
      },
    },
    {
      workspaceRegistry: {
        resolveByPath: async () => workspace,
        create: async () => {
          throw new Error('create should not run when resolveByPath matches')
        },
      },
    },
    () => {},
    on.on,
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(attached.length, 0, 'no attach before the first event')
  await on.fire(createOpts?.sessionId)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})

test('creates the workspace on the first event when the cwd is not yet registered', async () => {
  const created = fakeHandle('created-ws2')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  let createdPath: string | undefined
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
  const on = captureOn()
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unused')
      },
      create: async (opts) => {
        createOpts = opts as typeof createOpts
        return created
      },
    },
    {
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async (path: string) => {
          createdPath = path
          return workspace
        },
      },
    },
    () => {},
    on.on,
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(createdPath, undefined, 'workspace not created before the first event')
  assert.equal(attached.length, 0)
  await on.fire(createOpts?.sessionId)
  assert.equal(createdPath, META.cwd)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})

test('warns after the first event when the deferred workspace attach fails', async () => {
  const created = fakeHandle('created-ws3')
  let createOpts: { sessionId: unknown } | undefined
  const warns: string[] = []
  const on = captureOn()
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unused')
      },
      create: async (opts) => {
        createOpts = opts as typeof createOpts
        return created
      },
    },
    {
      workspaceRegistry: {
        resolveByPath: async () => {
          throw new Error('no such directory')
        },
        create: async () => {
          throw new Error('unused')
        },
      },
    },
    (msg) => warns.push(msg),
    on.on,
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(warns.length, 0, 'no attach attempt before the first event')
  await on.fire(createOpts?.sessionId)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('workspace attach for'))
})

test('defers workspace attach for a forked session until its first event', async () => {
  const created = fakeHandle('forked-ws')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
  const source = { session: { id: 'parent-1', events: [] }, ctx: {} } as unknown as Agent
  const on = captureOn()
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unused')
      },
      create: async (opts) => {
        createOpts = opts as typeof createOpts
        return created
      },
    },
    {
      sessions: { fork: () => ({ snapshotEvents: () => [] }) },
      workspaceRegistry: {
        resolveByPath: async () => workspace,
        create: async () => {
          throw new Error('create should not run when resolveByPath matches')
        },
      },
    },
    () => {},
    on.on,
  )
  const resolved = await forkSession(ctx, source, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(attached.length, 0, 'no attach before the first event')
  await on.fire(createOpts?.sessionId)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})

test('formats a copy-pasteable resume command', () => {
  assert.equal(resumeCommand('abc-123'), 'dsh --profile pi-tui --resume abc-123')
})

test('reconcileWorkspaceAttachments re-attaches missing sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tui-reconcile-'))
  try {
    const attached: string[] = []
    const headers = [
      snapshot('aaa-1', { cwd: dir, createdAt: 1 }),
      snapshot('bbb-2', { cwd: dir, createdAt: 2 }),
      snapshot('ccc-3', { cwd: dir, createdAt: 3 }),
      snapshot('ddd-4', { cwd: '/tmp/pi-tui-other', createdAt: 4 }), // no workspace
      snapshot('eee-5', { createdAt: 5 }), // no cwd — skipped
    ]
    // resolveByPath canonicalizes; report the canonical path like the real
    // registry does.
    const canonical = await realpath(dir)
    const workspace = {
      path: canonical,
      sessionIds: ['bbb-2'], // aaa-1 and ccc-3 were pruned
      attachSession: async (id: unknown) => {
        attached.push(String(id))
      },
    }
    const ctx = makeCtx(
      {
        get: () => undefined,
        resume: async () => undefined as never,
        create: async () => undefined as never,
      },
      {
        workspaceRegistry: {
          resolveByPath: async (path: string) => (path === canonical ? workspace : undefined),
          create: async () => {
            throw new Error('reconcile must not create workspaces')
          },
        },
        sessionPersistence: fakeStore(headers),
      },
    )
    const repaired = await reconcileWorkspaceAttachments(ctx)
    assert.equal(repaired, 2)
    assert.deepEqual(attached, ['aaa-1', 'ccc-3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconcileWorkspaceAttachments skips unresolvable cwds and unknown workspaces', async () => {
  const attached: string[] = []
  const headers = [
    snapshot('fff-1', { cwd: '/no/such/dir/anywhere', createdAt: 1 }), // does not resolve
    snapshot('ggg-2', { cwd: '/tmp/unowned-workspace', createdAt: 2 }), // no workspace
  ]
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        create: async () => {
          throw new Error('reconcile must not create workspaces')
        },
      },
      sessionPersistence: fakeStore(headers),
    },
  )
  const repaired = await reconcileWorkspaceAttachments(ctx)
  assert.equal(repaired, 0)
  assert.equal(attached.length, 0)
})

test('reconcileWorkspaceAttachments is a no-op without the services', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {},
  )
  assert.equal(await reconcileWorkspaceAttachments(ctx), 0)
})

// ── stored-session reads (`/resume` picker, Ctrl+R search, titles) ──────────

test('listSessions unwraps list() snapshots into real headers, newest first', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: fakeStore([
        snapshot('older', { createdAt: 10, cwd: '/tmp/a' }),
        snapshot('newer', { createdAt: 30, cwd: '/tmp/b' }),
        snapshot('middle', { createdAt: 20 }),
      ]),
    },
  )
  const headers = await listSessions(ctx)
  assert.deepEqual(
    headers.map((header) => String(header.id)),
    ['newer', 'middle', 'older'],
    'headers carry the id the picker resumes with',
  )
  assert.deepEqual(
    headers.map((header) => header.createdAt),
    [30, 20, 10],
    'createdAt is the header field, never undefined (which renders Invalid Date)',
  )
  assert.equal(headers[0]?.cwd, '/tmp/b')
})

test('listSessions survives a failing store', async () => {
  const warns: string[] = []
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: {
        list: async () => {
          throw new Error('store unavailable')
        },
      },
    },
    (msg) => warns.push(msg),
  )
  assert.deepEqual(await listSessions(ctx), [])
  assert.match(warns[0] ?? '', /store unavailable/)
})

test('persistedTitle reads the log through a read handle and closes it', async () => {
  const closed: string[] = []
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: fakeStore(
        [snapshot('titled-1')],
        {
          'titled-1': [
            event('session/title', { title: 'first title' }),
            event('user/message', {}),
            event('session/title', { title: 'latest title' }),
          ],
        },
        closed,
      ),
    },
  )
  assert.equal(await persistedTitle(ctx, 'titled-1'), 'latest title')
  assert.deepEqual(closed, ['titled-1'], 'the read handle is released')
})

test('readSessionEvents returns the log and rejects an unreadable session', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: fakeStore([snapshot('known-1')], {
        'known-1': [event('user/message', { text: 'hi' })],
      }),
    },
  )
  assert.equal((await readSessionEvents(ctx, 'known-1')).length, 1)
  await assert.rejects(() => readSessionEvents(ctx, 'missing-1'))
})

test('sessionTitles keys titles by session id and releases every handle', async () => {
  const closed: string[] = []
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: fakeStore(
        [snapshot('titled-1'), snapshot('plain-2')],
        {
          'titled-1': [event('session/title', { title: 'Titled' })],
          'plain-2': [event('user/message', {})],
        },
        closed,
      ),
    },
  )
  const headers = await listSessions(ctx)
  const titles = await sessionTitles(ctx, headers)
  assert.deepEqual([...titles.entries()], [['titled-1', 'Titled']])
  assert.deepEqual(closed.sort(), ['plain-2', 'titled-1'], 'both handles are released')
})

// ── a failed resume must be reported, never silently replaced ───────────────

test('resolveAgent reports a failed resume instead of quietly creating a session', async () => {
  const warns: string[] = []
  const created = fakeHandle('fresh-1')
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('session "wanted-1" is already owned by another process')
      },
      create: async () => created,
    },
    { sessionPersistence: fakeStore([snapshot('wanted-1')]) },
    (msg) => warns.push(msg),
  )
  const resolved = await resolveAgent(ctx, 'wanted-1', OPTIONS, META)
  assert.equal(resolved.agent, created.agent, 'the TUI still starts on a fresh session')
  assert.deepEqual(resolved.resumeFailure, {
    requestedId: 'wanted-1',
    reason: 'session "wanted-1" is already owned by another process',
  })
  assert.match(warns[0] ?? '', /wanted-1/)
})

test('a successful resume carries no resumeFailure', async () => {
  const resumed = fakeHandle('resumed-2')
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => resumed,
      create: async () => {
        throw new Error('create should not run')
      },
    },
    { sessionPersistence: fakeStore([snapshot('resumed-2')]) },
  )
  const resolved = await resolveAgent(ctx, 'resumed-2', OPTIONS, META)
  assert.equal(resolved.agent, resumed.agent)
  assert.equal(resolved.resumeFailure, undefined)
})

test('a fresh session (no requested id) carries no resumeFailure', async () => {
  const created = fakeHandle('fresh-2')
  const ctx = makeCtx({
    get: () => undefined,
    resume: async () => {
      throw new Error('resume should not run')
    },
    create: async () => created,
  })
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.resumeFailure, undefined)
})

// ── pickers must tell an empty stored session from a real one ───────────────

test('sessionSummaries flags sessions that hold no conversation', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    {
      sessionPersistence: fakeStore(
        [snapshot('boot-1'), snapshot('real-2'), snapshot('titled-3')],
        {
          // What the TUI leaves behind when someone quits without prompting.
          'boot-1': [
            event('permission/preset', { preset: 'workspace-write' }),
            event('sandbox/mode', { mode: 'workspace-write' }),
            event('approval/policy', { policy: 'ask' }),
          ],
          // Injected context alone is still not a conversation.
          'real-2': [event('user/message', { source: { kind: 'agent-instructions' } })],
          'titled-3': [
            event('user/message', {
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'hi' }],
            }),
            event('assistant/message', {}),
            event('session/title', { title: 'Greeting' }),
          ],
        },
      ),
    },
  )
  const summaries = await sessionSummaries(ctx, await listSessions(ctx))
  assert.deepEqual(summaries.get('boot-1'), { hasContent: false })
  assert.deepEqual(summaries.get('real-2'), { hasContent: false })
  assert.deepEqual(summaries.get('titled-3'), { hasContent: true, title: 'Greeting' })
})

test('an unreadable log is not reported as an empty session', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    // `list()` knows a session the store can no longer open: a vanished log
    // must not be labelled "empty", which would invite a pointless resume.
    { sessionPersistence: fakeStore([snapshot('other-1')]) },
  )
  assert.deepEqual(await persistedSummary(ctx, 'gone-1'), { hasContent: true })
})

test('a readable but event-less session is reported as empty', async () => {
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => undefined as never,
      create: async () => undefined as never,
    },
    { sessionPersistence: fakeStore([snapshot('blank-1')], { 'blank-1': [] }) },
  )
  assert.deepEqual(await persistedSummary(ctx, 'blank-1'), { hasContent: false })
})
