import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyEvent, createModel, pushNotice, textOf } from '../src/core/model.js'

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
      source: { kind: 'goal' },
      content: [{ type: 'text', text: 'goal snapshot' }],
    }),
  )
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'plugin', plugin: 'skill' },
      content: [{ type: 'text', text: 'skill content' }],
    }),
  )
  assert.equal(model.items.length, 0)
})

test('injected ! command context (plugin pi-tui) is not a user bubble', () => {
  const model = createModel()
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'plugin', plugin: 'pi-tui' },
      content: [{ type: 'text', text: '$ ls\nfile.txt' }],
    }),
  )
  // The visible record is the local notice card; the injected context must
  // not render a second user bubble.
  assert.equal(model.items.length, 0)
})

test('streams text and reasoning deltas into separate items, seals on message', () => {
  const model = createModel()
  applyEvent(
    model,
    event(
      'assistant/chunk',
      { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking' } },
      1,
    ),
  )
  applyEvent(
    model,
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi ' } }, 2),
  )
  applyEvent(
    model,
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'there' } }, 3),
  )
  assert.equal(model.items.length, 2)
  assert.equal(model.items[0].kind, 'reasoning')
  assert.equal(model.items[0].text, 'thinking')
  assert.equal(model.items[1].kind, 'assistant')
  assert.equal(model.items[1].text, 'hi there')
  assert.equal(model.items[1].streaming, true)

  applyEvent(
    model,
    event(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there!' }] },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      4,
    ),
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
    event(
      'tool/call',
      { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      1,
    ),
  )
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].kind, 'tool')
  assert.equal(model.items[0].tool?.status, 'running')
  assert.equal(model.items[0].tool?.argsPreview, '{"command":"ls"}')

  applyEvent(
    model,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'c1' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: 'file.txt' }] }],
        },
      },
      2,
    ),
  )
  assert.equal(model.items[0].tool?.status, 'ok')
  assert.equal(model.items[0].tool?.resultPreview, 'file.txt')

  // Error path on a second call.
  applyEvent(
    model,
    event(
      'tool/call',
      { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"nope"}' },
      3,
    ),
  )
  applyEvent(
    model,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { role: 'tool', source: { callId: 'c2' }, content: [] },
        error: { name: 'SandboxError', code: 'DENIED' },
      },
      4,
    ),
  )
  const failed = model.items.find((item) => item.tool?.callId === 'c2')
  assert.equal(failed?.tool?.status, 'error')
  assert.equal(failed?.tool?.errorText, 'SandboxError: DENIED')
})

test('skips ask_user_question tool cards (provider renders them)', () => {
  const model = createModel()
  applyEvent(
    model,
    event(
      'tool/call',
      { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{}' },
      1,
    ),
  )
  assert.equal(model.items.length, 0)
})

test('exit_plan_mode previews the plan title instead of the raw plan JSON', () => {
  const model = createModel()
  applyEvent(
    model,
    event(
      'tool/call',
      {
        turn: 1,
        step: 1,
        callId: 'p1',
        name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# Ship the widget\n\nA long body.' }),
      },
      1,
    ),
  )
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].tool?.argsPreview, 'Ship the widget')

  // A plan with no heading falls back to a compact placeholder.
  const noHeading = createModel()
  applyEvent(
    noHeading,
    event(
      'tool/call',
      {
        turn: 1,
        step: 1,
        callId: 'p2',
        name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: 'just some text' }),
      },
      1,
    ),
  )
  assert.equal(noHeading.items[0].tool?.argsPreview, 'plan')

  // Other tools keep the raw whitespace-collapsed JSON preview.
  const other = createModel()
  applyEvent(
    other,
    event(
      'tool/call',
      { turn: 1, step: 1, callId: 'b1', name: 'bash', arguments: '{"command":"ls"}' },
      1,
    ),
  )
  assert.equal(other.items[0].tool?.argsPreview, '{"command":"ls"}')
})

test('exit_plan_mode carries its full plan on the tool card', () => {
  const model = createModel()
  applyEvent(
    model,
    event(
      'tool/call',
      {
        turn: 1,
        step: 1,
        callId: 'p1',
        name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# Ship the widget\n\nA long body.' }),
      },
      1,
    ),
  )
  assert.equal(model.items[0].tool?.planText, '# Ship the widget\n\nA long body.')

  // Other tools never carry a plan.
  const other = createModel()
  applyEvent(
    other,
    event('tool/call', { turn: 1, step: 1, callId: 'b1', name: 'bash', arguments: '{}' }, 1),
  )
  assert.equal(other.items[0].tool?.planText, undefined)
})

test('exit_plan_mode review decisions render as neutral, not errors', () => {
  const model = createModel()
  applyEvent(
    model,
    event(
      'tool/call',
      {
        turn: 1,
        step: 1,
        callId: 'p1',
        name: 'exit_plan_mode',
        arguments: JSON.stringify({ plan: '# Ship the widget' }),
      },
      1,
    ),
  )
  applyEvent(
    model,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'p1' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'p1',
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'Error: The user chose to keep planning; revise the plan and present it again.',
                },
              ],
            },
          ],
        },
      },
      2,
    ),
  )
  const card = model.items[0].tool
  assert.equal(card?.status, 'rejected')
  assert.equal(card?.resultPreview, 'Plan not approved — still in plan mode')
  assert.equal(card?.errorText, undefined)
})

test('plain tool errors (non-HarnessError) render as errors', () => {
  const model = createModel()
  applyEvent(
    model,
    event('tool/call', { turn: 1, step: 1, callId: 'b1', name: 'bash', arguments: '{}' }, 1),
  )
  applyEvent(
    model,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'b1' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'b1',
              isError: true,
              content: [{ type: 'text', text: 'Error: command not found' }],
            },
          ],
        },
      },
      2,
    ),
  )
  const card = model.items[0].tool
  assert.equal(card?.status, 'error')
  assert.equal(card?.errorText, 'command not found')
})

test('turn boundaries drive the working flag and fold reasoning', () => {
  const model = createModel()
  assert.equal(model.working, false)
  applyEvent(model, event('turn/start', { turn: 1 }, 1))
  assert.equal(model.working, true)
  applyEvent(
    model,
    event(
      'assistant/chunk',
      { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'r' } },
      2,
    ),
  )
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

test('compact checkpoints render as notices, not bubbles', () => {
  const model = createModel()
  applyEvent(
    model,
    event('user/message', {
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'earlier conversation summarized' }],
    }),
  )
  assert.equal(model.items.length, 2)
  assert.equal(model.items[0].kind, 'notice')
  assert.equal(model.items[0].notice, 'compact')
  assert.equal(model.items[0].text, 'Conversation compacted')
  assert.equal(model.items[1].kind, 'notice')
  assert.equal(model.items[1].text, 'earlier conversation summarized')
})

test('failed turns produce error notices', () => {
  const model = createModel()
  applyEvent(model, event('turn/start', { turn: 1 }, 1))
  applyEvent(
    model,
    event(
      'turn/end',
      { turn: 1, reason: { kind: 'error', error: { code: 'UNAUTHORIZED', message: 'bad key' } } },
      2,
    ),
  )
  const notice = model.items.find((item) => item.kind === 'notice')
  assert.ok(notice !== undefined)
  assert.equal(notice.notice, 'error')
  assert.ok(notice.text.includes('UNAUTHORIZED'))
  assert.ok(notice.text.includes('bad key'))

  // Completed turns stay silent.
  const quiet = createModel()
  applyEvent(quiet, event('turn/start', { turn: 1 }, 1))
  applyEvent(quiet, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2))
  assert.equal(quiet.items.length, 0)
})

test('pushNotice appends a UI-side notice', () => {
  const model = createModel()
  pushNotice(model, 'done', 'info')
  assert.equal(model.items.length, 1)
  assert.equal(model.items[0].kind, 'notice')
  assert.equal(model.items[0].notice, 'info')
  assert.equal(model.items[0].text, 'done')
})

test('request/header reads back the dispatched route and effort', () => {
  const model = createModel()
  applyEvent(
    model,
    event('request/header', {
      header: {
        config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      },
      reason: 'initial',
    }),
  )
  assert.deepEqual(model.route, { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(model.effort, 'max')
})

test('tool results keep the full text for expansion', () => {
  const model = createModel()
  const long = 'line one\nline two\nline three'
  applyEvent(
    model,
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, 1),
  )
  applyEvent(
    model,
    event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { callId: 'c1' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: long }] }],
        },
      },
      2,
    ),
  )
  const card = model.items[0].tool
  assert.equal(card?.resultFull, long)
  assert.ok((card?.resultPreview ?? '').length <= long.length)
})
