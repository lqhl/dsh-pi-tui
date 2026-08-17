import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readGitState } from '../src/core/git.js'

test('readGitState reads the branch of the repo itself', async () => {
  // This package lives in a git work tree; the branch may be detached in CI,
  // but the state must resolve with a non-empty branch.
  const state = await readGitState(process.cwd())
  assert.ok(state !== undefined)
  assert.ok(state.branch.length > 0)
  assert.equal(typeof state.dirty, 'boolean')
})

test('readGitState resolves undefined outside a git work tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-tui-git-'))
  try {
    const state = await readGitState(dir)
    assert.equal(state, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
