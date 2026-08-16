import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from '../src/args.js'

test('parses --resume with an id', () => {
  const args = parseArgs(['--resume', 'abc-123'])
  assert.equal(args.resumeId, 'abc-123')
  assert.equal(args.pickSession, false)
  assert.equal(args.help, false)
})

test('parses bare --resume as picker request', () => {
  const args = parseArgs(['--resume'])
  assert.equal(args.resumeId, undefined)
  assert.equal(args.pickSession, true)
})

test('parses --help and collects unknown tokens', () => {
  const args = parseArgs(['--help', '--bogus'])
  assert.equal(args.help, true)
  assert.deepEqual(args.unknown, ['--bogus'])
})

test('empty argv yields defaults', () => {
  const args = parseArgs([])
  assert.deepEqual(args, { pickSession: false, pickPreset: false, help: false, unknown: [] })
  assert.equal(args.resumeId, undefined)
  assert.equal(args.preset, undefined)
})

test('parses --preset with an id and bare --preset', () => {
  const withId = parseArgs(['--preset', 'minimal'])
  assert.equal(withId.preset, 'minimal')
  assert.equal(withId.pickPreset, false)
  const bare = parseArgs(['--preset'])
  assert.equal(bare.preset, undefined)
  assert.equal(bare.pickPreset, true)
})
