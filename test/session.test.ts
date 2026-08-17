import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { forkSession, resolveAgent, resumeCommand, type SessionMeta } from '../src/core/session.js'

const OPTIONS: AgentOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const META: SessionMeta = { cwd: '/tmp/pi-tui-test' }

const fakeAgent = (id: string): Agent => ({ id }) as unknown as Agent
const fakeHandle = (id: string): AgentHandle => ({
  agent: fakeAgent(id),
  dispose: async () => {},
})

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
    logger: { warn },
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
      sessionPersistence: {
        load: async () => ({ header: { agentPreset: 'standard' }, events: [] }),
      },
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
      sessions: { fork: () => ({ events: [] }) },
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
