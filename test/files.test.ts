import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isHiddenPath, parseRgFiles, shouldShowPath } from '../src/core/files.js'

test('parseRgFiles splits and cleans rg --files output', () => {
  assert.deepEqual(parseRgFiles('a.ts\n\n  b.ts  \n'), ['a.ts', 'b.ts'])
  assert.deepEqual(parseRgFiles(''), [])
})

test('isHiddenPath flags any dot segment', () => {
  assert.equal(isHiddenPath('.DS_Store'), true)
  assert.equal(isHiddenPath('.agents/skills/x/SKILL.md'), true)
  assert.equal(isHiddenPath('.github/workflows/ci.yml'), true)
  assert.equal(isHiddenPath('src/app.ts'), false)
  assert.equal(isHiddenPath('src/.hidden/file.ts'), true)
})

test('shouldShowPath follows the dot-query policy', () => {
  assert.equal(shouldShowPath('', '.DS_Store'), false)
  assert.equal(shouldShowPath('', 'src/app.ts'), true)
  assert.equal(shouldShowPath('.', '.env'), true)
  assert.equal(shouldShowPath('.env', '.env.local'), true)
})
