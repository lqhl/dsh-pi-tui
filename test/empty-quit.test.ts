import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { quitAndExit } from '../src/app.js'
import {
  discardEmptySession,
  discardEmptySessionOnQuit,
  isHumanUserMessage,
  sessionHasHumanPrompt,
  type EmptyQuitSession,
} from '../src/core/empty-quit.js'
import type { ResolvedAgent } from '../src/core/session.js'

function event(type: string, data?: unknown): { type: string; data?: unknown } {
  return data === undefined ? { type } : { type, data }
}

function header(id: string, cwd?: string): SessionHeader {
  return {
    version: 0,
    id: id as SessionHeader['id'],
    createdAt: 1,
    ...(cwd !== undefined ? { cwd } : {}),
  }
}

function sessionOf(
  id: string,
  events: readonly { type?: string; data?: unknown }[],
  cwd?: string,
): EmptyQuitSession {
  return { id, header: header(id, cwd), events }
}

function makeCtx(
  services: Record<string, unknown>,
  warn: (msg: string) => void = () => {},
): Context {
  return {
    logger: { warn, info: warn },
    get: (name: string) => services[name],
  } as unknown as Context
}

async function withTrashEnv<T>(trashDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_SESSION_TRASH_DIR
  process.env.DSH_SESSION_TRASH_DIR = trashDir
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_SESSION_TRASH_DIR
    else process.env.DSH_SESSION_TRASH_DIR = previous
  }
}

test('isHumanUserMessage: user/message + source.kind === user', () => {
  assert.equal(
    isHumanUserMessage(event('user/message', { source: { kind: 'user' }, content: [] })),
    true,
  )
})

test('isHumanUserMessage: missing source is treated as human', () => {
  assert.equal(isHumanUserMessage(event('user/message', { content: [] })), true)
  assert.equal(isHumanUserMessage(event('user/message', { source: null, content: [] })), true)
})

test('isHumanUserMessage: inject and other non-user sources are excluded', () => {
  assert.equal(
    isHumanUserMessage(event('user/message', { source: { kind: 'inject' }, content: [] })),
    false,
  )
  assert.equal(
    isHumanUserMessage(
      event('user/message', { source: { kind: 'plugin', plugin: 'pi-tui' }, content: [] }),
    ),
    false,
  )
  assert.equal(
    isHumanUserMessage(event('user/message', { source: { kind: 'goal' }, content: [] })),
    false,
  )
})

test('isHumanUserMessage: non user/message events are never human', () => {
  assert.equal(isHumanUserMessage(event('turn/start', { turn: 1 })), false)
  assert.equal(isHumanUserMessage(event('session/end-seed', {})), false)
  assert.equal(isHumanUserMessage(event('assistant/message', { source: { kind: 'user' } })), false)
})

test('sessionHasHumanPrompt: empty / header-only / inject-only are empty', () => {
  assert.equal(sessionHasHumanPrompt({ events: [] }), false)
  assert.equal(
    sessionHasHumanPrompt({
      events: [
        event('session/end-seed', {}),
        event('request/header', { header: {} }),
        event('turn/start', { turn: 1 }),
      ],
    }),
    false,
  )
  assert.equal(
    sessionHasHumanPrompt({
      events: [event('user/message', { source: { kind: 'inject' }, content: [] })],
    }),
    false,
  )
})

test('sessionHasHumanPrompt: one human line, or a /nav fork seed, is kept', () => {
  assert.equal(
    sessionHasHumanPrompt({
      events: [event('user/message', { source: { kind: 'user' }, content: [{ type: 'text' }] })],
    }),
    true,
  )
  assert.equal(
    sessionHasHumanPrompt({
      events: [
        event('user/message', {
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
        }),
        event('session/end-seed', {}),
        event('turn/start', { turn: 1 }),
      ],
    }),
    true,
  )
})

test('discardEmptySession: locate+rename only for a session with no human prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tui-empty-quit-'))
  const emptyDir = join(root, 'sess-empty')
  const keptDir = join(root, 'sess-kept')
  const trash = join(root, 'trash')
  await mkdir(emptyDir)
  await mkdir(keptDir)
  await mkdir(trash)
  await writeFile(join(emptyDir, 'session.jsonl'), '{"type":"session"}\n')
  await writeFile(join(keptDir, 'session.jsonl'), '{"type":"session"}\n')

  const located: string[] = []
  const deleted: string[] = []
  const detached: string[] = []
  const persistence = {
    locate: (meta: SessionHeader) => {
      located.push(String(meta.id))
      const dir = String(meta.id) === 'sess-empty' ? emptyDir : keptDir
      return { kind: 'jsonl', path: join(dir, 'session.jsonl') }
    },
  }
  const sessions = {
    store: {
      delete: (id: string) => {
        deleted.push(id)
      },
    },
  }
  const workspace = {
    path: '/tmp',
    sessionIds: [] as string[],
    attachSession: async () => {},
    detachSession: async (id: unknown) => {
      detached.push(String(id))
    },
  }
  const ctx = makeCtx({
    sessionPersistence: persistence,
    sessions,
    workspaceRegistry: {
      resolveByPath: async (path: string) => (path === '/tmp' ? workspace : undefined),
    },
  })

  await withTrashEnv(trash, async () => {
    const empty = await discardEmptySession(
      ctx,
      sessionOf('sess-empty', [event('turn/start')], '/tmp'),
    )
    assert.equal(empty.discarded, true)
    assert.equal(empty.detached, true)
    assert.equal(empty.workspaceDetached, true)
    assert.equal(existsSync(emptyDir), false)
    assert.equal(existsSync(join(trash, 'sess-empty', 'session.jsonl')), true)

    const kept = await discardEmptySession(
      ctx,
      sessionOf('sess-kept', [event('user/message', { source: { kind: 'user' } })], '/tmp'),
    )
    assert.equal(kept.discarded, false)
    assert.equal(kept.reason, 'has-human-prompt')
    assert.equal(existsSync(keptDir), true)
  })

  assert.deepEqual(located, ['sess-empty'])
  assert.deepEqual(deleted, ['sess-empty'])
  assert.deepEqual(detached, ['sess-empty'])
  await rm(root, { recursive: true, force: true })
})

test('discardEmptySessionOnQuit: disabled or human prompt leaves the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tui-empty-quit-off-'))
  const sessionDir = join(root, 'sess-live')
  const trash = join(root, 'trash')
  await mkdir(sessionDir)
  await mkdir(trash)
  await writeFile(join(sessionDir, 'session.jsonl'), '{"type":"session"}\n')

  let locateCalls = 0
  const ctx = makeCtx({
    sessionPersistence: {
      locate: () => {
        locateCalls += 1
        return { kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }
      },
    },
  })
  const empty = sessionOf('sess-live', [event('turn/start')])
  const human = sessionOf('sess-live', [event('user/message', { source: { kind: 'user' } })])

  await withTrashEnv(trash, async () => {
    assert.equal(await discardEmptySessionOnQuit(ctx, empty, false), false)
    assert.equal(await discardEmptySessionOnQuit(ctx, human, true), false)
    assert.equal(existsSync(sessionDir), true)
    assert.equal(locateCalls, 0)

    assert.equal(await discardEmptySessionOnQuit(ctx, empty, true), true)
    assert.equal(existsSync(sessionDir), false)
    assert.equal(locateCalls, 1)
  })
  await rm(root, { recursive: true, force: true })
})

function resolved(session: EmptyQuitSession): ResolvedAgent {
  return { agent: { session } } as unknown as ResolvedAgent
}

async function captureQuit(
  ctx: Context,
  session: EmptyQuitSession,
  enabled: boolean,
  hint: string | undefined,
): Promise<{ exits: number[]; writes: string[] }> {
  const exits: number[] = []
  const writes: string[] = []
  mock.method(process, 'exit', ((code?: number) => {
    exits.push(code ?? 0)
  }) as typeof process.exit)
  mock.method(process.stdout, 'write', ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  const quitCtx = {
    ...ctx,
    logger: ctx.logger,
    get: ctx.get.bind(ctx),
    root: { fiber: { dispose: async () => {} } },
  } as unknown as Context
  try {
    await quitAndExit(quitCtx, resolved(session), enabled, hint)
    await new Promise((resolve) => setImmediate(resolve))
    return { exits, writes }
  } finally {
    mock.restoreAll()
  }
}

async function sessionOnDisk(id: string): Promise<{
  root: string
  sessionDir: string
  trash: string
  ctx: Context
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-tui-quit-${id}-`))
  const sessionDir = join(root, id)
  const trash = join(root, 'trash')
  await mkdir(sessionDir)
  await mkdir(trash)
  await writeFile(join(sessionDir, 'session.jsonl'), '{"type":"session"}\n')
  const ctx = makeCtx({
    sessionPersistence: {
      locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
    },
  })
  return { root, sessionDir, trash, ctx }
}

test('quitAndExit: empty session is trashed and resume hint is suppressed', async () => {
  const { root, sessionDir, trash, ctx } = await sessionOnDisk('sess-empty')
  await withTrashEnv(trash, async () => {
    const { exits, writes } = await captureQuit(
      ctx,
      sessionOf('sess-empty', [event('turn/start')]),
      true,
      'resume: dsh --profile pi-tui --resume sess-empty',
    )
    assert.deepEqual(exits, [0])
    assert.equal(
      writes.some((write) => write.includes('resume:')),
      false,
    )
    assert.equal(existsSync(sessionDir), false)
    assert.equal(existsSync(join(trash, 'sess-empty', 'session.jsonl')), true)
  })
  await rm(root, { recursive: true, force: true })
})

test('quitAndExit: discardEmptyOnQuit false preserves the session and resume hint', async () => {
  const { root, sessionDir, trash, ctx } = await sessionOnDisk('sess-keep-off')
  const hint = 'resume: dsh --profile pi-tui --resume sess-keep-off'
  await withTrashEnv(trash, async () => {
    const { exits, writes } = await captureQuit(
      ctx,
      sessionOf('sess-keep-off', [event('turn/start')]),
      false,
      hint,
    )
    assert.deepEqual(exits, [0])
    assert.equal(
      writes.some((write) => write.includes(hint)),
      true,
    )
    assert.equal(existsSync(sessionDir), true)
  })
  await rm(root, { recursive: true, force: true })
})

test('quitAndExit: human or legacy user event preserves the session', async () => {
  const { root, sessionDir, trash, ctx } = await sessionOnDisk('sess-human')
  const hint = 'resume: dsh --profile pi-tui --resume sess-human'
  await withTrashEnv(trash, async () => {
    const human = await captureQuit(
      ctx,
      sessionOf('sess-human', [event('user/message', { source: { kind: 'user' } })]),
      true,
      hint,
    )
    assert.deepEqual(human.exits, [0])
    assert.equal(
      human.writes.some((write) => write.includes(hint)),
      true,
    )
    assert.equal(existsSync(sessionDir), true)

    const legacy = await captureQuit(
      ctx,
      sessionOf('sess-human', [event('user/message', { content: [] })]),
      true,
      hint,
    )
    assert.deepEqual(legacy.exits, [0])
    assert.equal(
      legacy.writes.some((write) => write.includes(hint)),
      true,
    )
    assert.equal(existsSync(sessionDir), true)
  })
  await rm(root, { recursive: true, force: true })
})

test('discardEmptySession: locate failure leaves the directory and is not discarded', async () => {
  const { root, sessionDir, trash } = await sessionOnDisk('sess-locate-fail')
  const ctx = makeCtx({
    sessionPersistence: {
      locate: () => {
        throw new Error('locate failed')
      },
    },
  })
  await withTrashEnv(trash, async () => {
    const result = await discardEmptySession(
      ctx,
      sessionOf('sess-locate-fail', [event('turn/start')]),
    )
    assert.equal(result.discarded, false)
    assert.equal(existsSync(sessionDir), true)
    assert.equal(
      await discardEmptySessionOnQuit(
        ctx,
        sessionOf('sess-locate-fail', [event('turn/start')]),
        true,
      ),
      false,
    )
  })
  await rm(root, { recursive: true, force: true })
})

test('discardEmptySession: human prompt arriving during detach is not trashed', async () => {
  const { root, sessionDir, trash } = await sessionOnDisk('sess-race')
  const events: { type?: string; data?: unknown }[] = [event('turn/start')]
  const session = { id: 'sess-race', header: header('sess-race', '/tmp'), events }
  const ctx = makeCtx({
    sessionPersistence: {
      locate: () => ({ kind: 'jsonl', path: join(sessionDir, 'session.jsonl') }),
    },
    workspaceRegistry: {
      resolveByPath: async () => ({
        path: '/tmp',
        sessionIds: [],
        attachSession: async () => {},
        detachSession: async () => {
          events.push(event('user/message', { source: { kind: 'user' } }))
        },
      }),
    },
  })
  await withTrashEnv(trash, async () => {
    const result = await discardEmptySession(ctx, session)
    assert.equal(result.discarded, false)
    assert.equal(result.reason, 'has-human-prompt')
    assert.equal(existsSync(sessionDir), true)
  })
  await rm(root, { recursive: true, force: true })
})

test('quitAndExit: cleanup failure still disposes the root with the resume hint', async () => {
  const { root, sessionDir, trash } = await sessionOnDisk('sess-fail')
  const hint = 'resume: dsh --profile pi-tui --resume sess-fail'
  const ctx = makeCtx({
    sessionPersistence: {
      locate: () => {
        throw new Error('locate failed')
      },
    },
    workspaceRegistry: {
      resolveByPath: async () => {
        throw new Error('workspace resolve failed')
      },
    },
  })
  await withTrashEnv(trash, async () => {
    const { exits, writes } = await captureQuit(
      ctx,
      sessionOf('sess-fail', [event('turn/start')], '/tmp'),
      true,
      hint,
    )
    assert.deepEqual(exits, [0])
    assert.equal(
      writes.some((write) => write.includes(hint)),
      true,
    )
    assert.equal(existsSync(sessionDir), true)
  })
  await rm(root, { recursive: true, force: true })
})
