import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeOsc52, osc52Encode } from '../src/core/clipboard.js'

function osc52(text: string, selection = 'c'): string {
  return `\x1b]52;${selection};${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

test('decodeOsc52 returns nothing for plain output', () => {
  assert.deepEqual(decodeOsc52('some rendered line\r\n'), [])
})

test('decodeOsc52 decodes a single clipboard payload', () => {
  assert.deepEqual(decodeOsc52(osc52('hello world')), ['hello world'])
})

test('decodeOsc52 handles UTF-8 and multi-byte text', () => {
  assert.deepEqual(decodeOsc52(osc52('中文 · emoji 🎉')), ['中文 · emoji 🎉'])
})

test('decodeOsc52 decodes multiple sequences in one write', () => {
  const data = osc52('first') + 'noise' + osc52('second')
  assert.deepEqual(decodeOsc52(data), ['first', 'second'])
})

test('decodeOsc52 skips empty payloads', () => {
  assert.deepEqual(decodeOsc52(`\x1b]52;c;\x07`), [])
})

test('osc52Encode round-trips through decodeOsc52', () => {
  assert.deepEqual(decodeOsc52(osc52Encode('hello world')), ['hello world'])
})

test('osc52Encode round-trips UTF-8', () => {
  const text = '中文 · emoji 🎉'
  assert.deepEqual(decodeOsc52(osc52Encode(text)), [text])
})

test('osc52Encode targets the default clipboard selection', () => {
  const encoded = osc52Encode('x')
  assert.ok(encoded.startsWith('\x1b]52;c;'))
  assert.ok(encoded.endsWith('\x07'))
})
