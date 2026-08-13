import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyEvent, createModel, textOf } from '../src/core/model.js'

function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { seq, time: Date.now(), type, data } as unknown as SessionEvent
}

test('folds a direct user prompt into a user bubble', () => {
  const model = createModel()
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }),
  )
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].kind, 'user')
  assert.equal(model.items[0].text, 'hello')
})

test('skips injected (non-user) context', () => {
  const model = createModel()
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'summary' }],
    }),
  )
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'goal' },
      content: [{ type: 'text', text: 'goal snapshot' }],
    }),
  )
  assert.equal(model.items.length, 0)
})

test('streams text and reasoning deltas into separate items, seals on message', () => {
  const model = createModel()
  applyEvent(model, event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking' } }, 1))
  applyEvent(model, event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi ' } }, 2))
  applyEvent(model, event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'there' } }, 3))
  assert.equal(model.items.length, 2)
  assert.equal(model.items[0].kind, 'reasoning')
  assert.equal(model.items[0].text, 'thinking')
  assert.equal(model.items[1].kind, 'assistant')
  assert.equal(model.items[1].text, 'hi there')
  assert.equal(model.items[1].streaming, true)

  applyEvent(
    model,
    event('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there!' }] },
      usage: { inputTokens: 10, outputTokens: 2 },
    }, 4),
  )
  assert.equal(model.items[1].text, 'hi there!')
  assert.equal(model.items[1].streaming, false)
  assert.equal(model.items[0].streaming, false)
  assert.deepEqual(model.tokens, { input: 10, output: 2 })
})

test('tracks tool cards from call to settled result', () => {
  const model = createModel()
  applyEvent(
    model,
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, 1),
  )
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].kind, 'tool')
  assert.equal(model.items[0].tool?.status, 'running')
  assert.equal(model.items[0].tool?.argsPreview, '{"command":"ls"}')

  applyEvent(
    model,
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { callId: 'c1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file.txt' }] }],
      },
    }, 2),
  )
  assert.equal(model.items[0].tool?.status, 'ok')
  assert.equal(model.items[0].tool?.resultPreview, 'file.txt')

  // Error path on a second call.
  applyEvent(
    model,
    event('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"nope"}' }, 3),
  )
  applyEvent(
    model,
    event('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { callId: 'c2' }, content: [] },
      error: { name: 'SandboxError', code: 'DENIED' },
    }, 4),
  )
  const failed = model.items.find((item) => item.tool?.callId === 'c2')
  assert.equal(failed?.tool?.status, 'error')
  assert.equal(failed?.tool?.errorText, 'SandboxError: DENIED')
})

test('skips ask_user_question tool cards (provider renders them)', () => {
  const model = createModel()
  applyEvent(
    model,
    event('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{}' }, 1),
  )
  assert.equal(model.items.length, 0)
})

test('turn boundaries drive the working flag and fold reasoning', () => {
  const model = createModel()
  assert.equal(model.working, false)
  applyEvent(model, event('turn/start', { turn: 1 }, 1))
  assert.equal(model.working, true)
  applyEvent(model, event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'r' } }, 2))
  applyEvent(model, event('turn/end', { turn: 1, reason: 'completed' }, 3))
  assert.equal(model.working, false)
  assert.equal(model.items[0].streaming, false)
})

test('textOf joins text blocks only', () => {
  assert.equal(
    textOf([
      { type: 'text', text: 'a' },
      { type: 'text', text: ' b ' },
    ]),
    'a b',
  )
  assert.equal(textOf([]), '')
  assert.equal(textOf(undefined), '')
})
