import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { StatusBar } from '../src/ui/views.js'
import { MockTerminal } from './mock-terminal.js'

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

test('status bar composes plan/goal/context/preset/jobs fields', async () => {
  const terminal = new MockTerminal()
  terminal.width = 200
  const bar = new StatusBar()
  bar.update({
    model: 'deepseek-v4-flash·max',
    preset: 'standard',
    planActive: true,
    goalPhase: 'active',
    sessionId: 'abc12345-xxxx',
    cwd: 'repo',
    tokens: { input: 100, output: 20 },
    contextPct: 45,
    todos: { done: 2, total: 5 },
    jobsRunning: 3,
    title: '评审会话',
  })
  const output = stripAnsi(bar.render(terminal.width)[0])
  assert.ok(output.includes('deepseek-v4-flash·max'))
  assert.ok(output.includes('standard'))
  assert.ok(output.includes('⌘plan'))
  assert.ok(output.includes('◈active'))
  assert.ok(output.includes('abc12345'))
  assert.ok(output.includes('in 100 out 20'))
  assert.ok(output.includes('ctx 45%'))
  assert.ok(output.includes('☐ 2/5'))
  assert.ok(output.includes('⚙ 3'))
  assert.ok(output.includes('评审会话'))
  assert.ok(visibleWidth(bar.render(terminal.width)[0]) <= terminal.width)
})

test('status bar hides absent optional segments', async () => {
  const terminal = new MockTerminal()
  terminal.width = 200
  const bar = new StatusBar()
  bar.update({ model: 'deepseek-v4-flash', sessionId: 'abc12345-xxxx', cwd: 'repo' })
  const output = stripAnsi(bar.render(terminal.width)[0])
  assert.ok(!output.includes('⌘plan'))
  assert.ok(!output.includes('◈'))
  assert.ok(!output.includes('ctx '))
  assert.ok(!output.includes('⚙'))
})
