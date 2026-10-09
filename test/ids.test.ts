import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortSessionId } from '../src/core/ids.js'

test('shortSessionId shows the identifying half of a TUI-minted uuid', () => {
  assert.equal(shortSessionId('81163699-fbe8-4f7f-a1ca-8de2fc649af3'), '81163699')
})

test('shortSessionId skips the store prefix instead of rendering "session-"', () => {
  assert.equal(shortSessionId('session-ce54f698-ce78-45cd-8767-f40c13519ecd'), 'ce54f698')
  assert.equal(shortSessionId('session-5b498b71-ce10-46aa-8c2f-1b6843050c67'), '5b498b71')
})

test('shortSessionId keeps a prefix-only or short id usable', () => {
  assert.equal(shortSessionId('session-'), 'session-')
  assert.equal(shortSessionId('session-5'), '5')
  assert.equal(shortSessionId('abc'), 'abc')
  assert.equal(shortSessionId(''), '')
})

test('shortSessionId never exceeds eight characters', () => {
  for (const id of ['81163699-fbe8', 'session-ce54f698-ce78', 'a'.repeat(64)]) {
    assert.ok(shortSessionId(id).length <= 8, `${id} -> ${shortSessionId(id)}`)
  }
})
