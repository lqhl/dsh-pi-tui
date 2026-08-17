import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { forkSession, resolveAgent, type SessionMeta } from '../src/core/session.js'

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
): Context {
  const ctx = {
    agents,
    logger: { warn },
    get: (name: string) => services[name],
  }
  return ctx as unknown as Context
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

test('attaches a fresh session to the workspace at its cwd', async () => {
  const created = fakeHandle('created-ws')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
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
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})

test('creates the workspace when the cwd is not yet registered', async () => {
  const created = fakeHandle('created-ws2')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  let createdPath: string | undefined
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
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
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(createdPath, META.cwd)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})

test('warns but still resolves when the workspace attach fails', async () => {
  const created = fakeHandle('created-ws3')
  const warns: string[] = []
  const ctx = makeCtx(
    {
      get: () => undefined,
      resume: async () => {
        throw new Error('unused')
      },
      create: async () => created,
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
  )
  const resolved = await resolveAgent(ctx, undefined, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('workspace attach for'))
})

test('attaches a forked session to the workspace at its cwd', async () => {
  const created = fakeHandle('forked-ws')
  let createOpts: { sessionId: unknown } | undefined
  const attached: unknown[] = []
  const workspace = {
    attachSession: async (id: unknown) => {
      attached.push(id)
    },
  }
  const source = { session: { id: 'parent-1', events: [] }, ctx: {} } as unknown as Agent
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
  )
  const resolved = await forkSession(ctx, source, OPTIONS, META)
  assert.equal(resolved.agent, created.agent)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], createOpts?.sessionId)
})
