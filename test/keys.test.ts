import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ctrlC, cycleEffort, parseSlash, type ExitArm } from '../src/core/keys.js'

test('Ctrl+C: working → cancel, never arms', () => {
  const state: ExitArm = { lastPressAt: 0 }
  const result = ctrlC(state, true, false, 1000)
  assert.equal(result.action, 'cancel')
  assert.equal(result.state, state)
  assert.equal(result.arm, false)
})

test('Ctrl+C: clear arms the timer; second press inside 500ms exits', () => {
  const cleared = ctrlC({ lastPressAt: 0 }, false, true, 1000)
  assert.equal(cleared.action, 'clear')
  assert.equal(cleared.arm, true)
  assert.equal(cleared.state.lastPressAt, 1000)
  const second = ctrlC(cleared.state, false, false, 1300)
  assert.equal(second.action, 'exit')
  assert.equal(second.state.lastPressAt, 0)
  assert.equal(second.arm, false)
})

test('Ctrl+C: idle empty → arm; window lapse re-arms instead of exiting', () => {
  const first = ctrlC({ lastPressAt: 0 }, false, false, 1000)
  assert.equal(first.action, 'arm')
  assert.equal(first.state.lastPressAt, 1000)
  const late = ctrlC(first.state, false, false, 2000)
  assert.equal(late.action, 'arm')
  assert.equal(late.state.lastPressAt, 2000)
})

test('cycleEffort walks the ordered list and wraps', () => {
  const efforts = [{ id: 'off' }, { id: 'high' }, { id: 'max' }]
  assert.equal(cycleEffort(efforts, undefined), 'off')
  assert.equal(cycleEffort(efforts, 'off'), 'high')
  assert.equal(cycleEffort(efforts, 'max'), 'off')
  assert.equal(cycleEffort(efforts, 'bogus'), 'off')
  assert.equal(cycleEffort([], 'off'), undefined)
})

test('parseSlash splits name and raw input', () => {
  assert.deepEqual(parseSlash('/model'), { name: 'model', raw: '' })
  // Raw input includes the separator whitespace, matching dsh parseCommand.
  assert.deepEqual(parseSlash('/model  v4'), { name: 'model', raw: '  v4' })
  assert.deepEqual(parseSlash('/MODEL'), { name: 'model', raw: '' })
  assert.equal(parseSlash('no slash'), undefined)
  assert.equal(parseSlash(''), undefined)
})
