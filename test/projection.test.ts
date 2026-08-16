import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectProjection } from '../src/core/projection.js'

test('undefined values fall back to the local tokens', () => {
  const s = collectProjection(undefined, { input: 10, output: 2 })
  assert.deepEqual(s.tokens, { input: 10, output: 2 })
  assert.equal(s.todos, undefined)
  assert.equal(s.planActive, false)
  assert.equal(s.goalPhase, undefined)
  assert.equal(s.contextPct, undefined)
  assert.equal(s.contextUsed, undefined)
  assert.equal(s.contextTotal, undefined)
})

test('tokenUsage overrides the fallback tokens', () => {
  const s = collectProjection(
    { tokenUsage: { totals: { uncachedInputTokens: 100, outputTokens: 20 } } },
    { input: 0, output: 0 },
  )
  assert.deepEqual(s.tokens, { input: 100, output: 20 })
})

test('todos count completed items', () => {
  const s = collectProjection(
    { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'completed' }] },
    { input: 0, output: 0 },
  )
  assert.deepEqual(s.todos, { done: 2, total: 3 })
})

test('plan/goal/context parse from the snapshot', () => {
  const s = collectProjection(
    {
      plan: { active: true },
      goal: { goal: { phase: 'active' } },
      contextPressure: { projectedTokens: 450, contextWindow: 1000 },
    },
    { input: 0, output: 0 },
  )
  assert.equal(s.planActive, true)
  assert.equal(s.goalPhase, 'active')
  assert.equal(s.contextPct, 45)
  assert.equal(s.contextUsed, 450)
  assert.equal(s.contextTotal, 1000)
})

test('null todos leave todos unset; absent plan is false', () => {
  const s = collectProjection({ todos: null }, { input: 0, output: 0 })
  assert.equal(s.todos, undefined)
  assert.equal(s.planActive, false)
})
