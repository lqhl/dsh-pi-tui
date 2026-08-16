import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { seedModelSelection } from '../src/core/selection.js'

test('empty input falls back to the hard-coded route', () => {
  const s = seedModelSelection({})
  assert.equal(s.provider, 'deepseek-official')
  assert.equal(s.model, 'deepseek-v4-flash')
  assert.equal(s.reasoningEffort, undefined)
})

test('persisted header wins over every other source', () => {
  const s = seedModelSelection({
    header: { provider: 'h', model: 'hm', reasoningEffort: 'max' },
    config: { provider: 'c', model: 'cm' },
    agentOptions: { provider: 'a', model: 'am' },
    defaults: { provider: 'd', model: 'dm', reasoningEffort: 'high' },
    prior: { provider: 'p', model: 'pm', reasoningEffort: ReasoningEffortId('off') },
  })
  assert.equal(s.provider, 'h')
  assert.equal(s.model, 'hm')
  assert.equal(s.reasoningEffort, ReasoningEffortId('max'))
})

test('row config beats agent options and defaults', () => {
  const s = seedModelSelection({
    config: { provider: 'c', model: 'cm' },
    agentOptions: { provider: 'a', model: 'am' },
    defaults: { provider: 'd', model: 'dm' },
  })
  assert.equal(s.provider, 'c')
  assert.equal(s.model, 'cm')
})

test('agent options beat the harness default', () => {
  const s = seedModelSelection({
    agentOptions: { provider: 'a', model: 'am' },
    defaults: { provider: 'd', model: 'dm' },
  })
  assert.equal(s.provider, 'a')
  assert.equal(s.model, 'am')
})

test('harness default beats the hard-coded route', () => {
  const s = seedModelSelection({ defaults: { provider: 'd', model: 'dm' } })
  assert.equal(s.provider, 'd')
  assert.equal(s.model, 'dm')
})

test('reasoning effort carries over from the prior selection', () => {
  const s = seedModelSelection({
    config: { provider: 'c', model: 'cm' },
    prior: { provider: 'p', model: 'pm', reasoningEffort: ReasoningEffortId('max') },
  })
  assert.equal(s.reasoningEffort, ReasoningEffortId('max'))
  // provider/model still follow config, not the prior.
  assert.equal(s.provider, 'c')
  assert.equal(s.model, 'cm')
})

test('header effort beats the prior effort', () => {
  const s = seedModelSelection({
    header: { provider: 'h', model: 'hm', reasoningEffort: 'off' },
    prior: { provider: 'p', model: 'pm', reasoningEffort: ReasoningEffortId('high') },
  })
  assert.equal(s.reasoningEffort, ReasoningEffortId('off'))
})

test('no prior effort leaves effort absent (adapter default)', () => {
  const s = seedModelSelection({ prior: { provider: 'p', model: 'pm' } })
  assert.equal(s.reasoningEffort, undefined)
})
