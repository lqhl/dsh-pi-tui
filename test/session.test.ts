import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { resolveAgent, type SessionMeta } from '../src/core/session.js'

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
