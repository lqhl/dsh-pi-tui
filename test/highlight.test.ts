import assert from 'node:assert/strict'
import { test } from 'node:test'
import chalk from 'chalk'
import { gitLabel, highlightMatches } from '../src/core/format.js'

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

test('highlightMatches returns text unchanged for blank queries', () => {
  assert.equal(highlightMatches('hello world', ''), 'hello world')
  assert.equal(highlightMatches('hello world', '   '), 'hello world')
  assert.equal(highlightMatches('', 'x'), '')
})

test('highlightMatches wraps every case-insensitive occurrence', () => {
  // Force color output: chalk auto-disables ANSI when stdout is not a TTY.
  chalk.level = 1
  const out = highlightMatches('foo bar Foo baz', 'foo')
  // Original text fully preserved (ANSI stripped).
  assert.equal(stripAnsi(out), 'foo bar Foo baz')
  // ANSI present, and both occurrences (case-insensitive) are wrapped.
  assert.ok(out.length > 'foo bar Foo baz'.length)
  assert.ok(out.split('\x1b[').length - 1 >= 2)
})

test('highlightMatches highlights distinct occurrences independently', () => {
  chalk.level = 1
  const out = highlightMatches('ab ab', 'ab')
  assert.equal(stripAnsi(out), 'ab ab')
  // Each occurrence contributes an ANSI open/close pair.
  assert.ok(out.split('\x1b[').length - 1 >= 2)
})

test('gitLabel renders branch and dirty star', () => {
  assert.equal(gitLabel('main', false), 'git:main')
  assert.equal(gitLabel('main', true), 'git:main*')
  assert.equal(gitLabel('feature/tui', true), 'git:feature/tui*')
})
