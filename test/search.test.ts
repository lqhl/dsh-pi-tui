import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSearchIndex,
  itemSearchText,
  snippetOf,
  type TranscriptSearchMatch,
} from '../src/core/search.js'
import { createModel, pushNotice, type ChatItem } from '../src/core/model.js'

function item(kind: ChatItem['kind'], text: string, tool?: ChatItem['tool']): ChatItem {
  return { id: 0, kind, text, streaming: false, tool }
}

test('itemSearchText covers user/assistant/reasoning/notice text', () => {
  assert.equal(itemSearchText(item('user', 'hello')), 'hello')
  assert.equal(itemSearchText(item('assistant', 'world')), 'world')
  assert.equal(itemSearchText(item('reasoning', 'think')), 'think')
  assert.equal(itemSearchText(item('notice', 'note')), 'note')
})

test('itemSearchText folds tool name, args, and full result', () => {
  const card = item('tool', '', {
    callId: 'c1',
    name: 'write',
    argsPreview: '{"path":"src/main.ts"}',
    status: 'ok',
    resultPreview: 'preview only',
    resultFull: 'full result body',
  })
  const text = itemSearchText(card)
  assert.ok(text.includes('write'))
  assert.ok(text.includes('src/main.ts'))
  assert.ok(text.includes('full result body'))
})

test('buildSearchIndex is case-insensitive and returns one entry per item', () => {
  const items = [
    item('user', 'First prompt about tokens'),
    item('assistant', 'Here is the TOKENS summary'),
    item('user', 'unrelated'),
  ].map((entry, id) => ({ ...entry, id }))
  const matches = buildSearchIndex(items, 'tokens')
  assert.equal(matches.length, 2)
  assert.deepEqual(
    matches.map((match) => match.itemId),
    [0, 1],
  )
})

test('buildSearchIndex searches tool results and notice text', () => {
  const items = [
    item('tool', '', {
      callId: 'c1',
      name: 'bash',
      argsPreview: '{}',
      status: 'ok',
      resultPreview: 'exit 0',
      resultFull: 'claude-code found the needle here',
    }),
    item('notice', 'compacted the conversation'),
  ].map((entry, id) => ({ ...entry, id }))
  const matches = buildSearchIndex(items, 'needle')
  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.itemId, 0)
  assert.equal(buildSearchIndex(items, 'compacted')[0]?.itemId, 1)
})

test('buildSearchIndex matches nothing for blank query', () => {
  const items = [item('user', 'anything')]
  assert.deepEqual(buildSearchIndex(items, ''), [])
  assert.deepEqual(buildSearchIndex(items, '  '), [])
})

test('snippetOf collapses whitespace and caps length', () => {
  assert.equal(snippetOf('  a   b  '), 'a b')
  assert.ok(snippetOf('x'.repeat(200)).length <= 91)
})

test('matches flow from a folded model transcript', () => {
  const model = createModel()
  // Emulate the model fold: user text + notice + tool card (sequential ids).
  model.items.push({ ...item('user', 'find me in the transcript'), id: 0 })
  pushNotice(model, 'a notice to search')
  model.items.push({
    ...item('tool', '', {
      callId: 'c2',
      name: 'read',
      argsPreview: '{}',
      status: 'ok',
      resultFull: 'answer 42',
    }),
    id: 2,
  })
  const byId = new Map<number, TranscriptSearchMatch>(
    buildSearchIndex(model.items, 'answer').map((match) => [match.itemId, match]),
  )
  assert.equal(byId.size, 1)
  assert.ok(byId.has(2))
})
