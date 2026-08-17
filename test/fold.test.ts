import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldWindow, visibleItemsBefore } from '../src/core/fold.js'

test('foldWindow stays open below the threshold', () => {
  assert.deepEqual(foldWindow(10, false, 200), { key: 'none', boundary: 0 })
  assert.deepEqual(foldWindow(200, false, 200), { key: 'none', boundary: 0 })
})

test('foldWindow folds once the transcript passes the threshold', () => {
  const window = foldWindow(500, false, 200)
  assert.equal(window.key, 'folded:300')
  assert.equal(window.boundary, 300)
  // Boundary + threshold equals the transcript length.
  assert.equal(window.boundary + 200, 500)
})

test('foldWindow tracks the fold count as items grow', () => {
  assert.equal(foldWindow(201, false, 200).key, 'folded:1')
  assert.equal(foldWindow(202, false, 200).key, 'folded:2')
})

test('foldWindow expansion lifts the fold entirely', () => {
  assert.deepEqual(foldWindow(500, true, 200), { key: 'all', boundary: 0 })
})

test('visibleItemsBefore sums only visible views when folded', () => {
  // 500 items, threshold 200 → hidden ids 0..299, visible 300..499.
  const window = foldWindow(500, false, 200)
  const heights = (_id: number): number => 2
  // Target 400: notice (1) + views 300..399 (100 × 2).
  assert.equal(visibleItemsBefore(400, window, heights), 1 + 100 * 2)
  // Target 500 (past the end): notice + all 200 visible views.
  assert.equal(visibleItemsBefore(500, window, heights), 1 + 200 * 2)
})

test('visibleItemsBefore counts everything when not folded', () => {
  assert.equal(
    visibleItemsBefore(10, { key: 'none', boundary: 0 }, (id) => id + 1),
    55,
  )
})

test('visibleItemsBefore counts everything when expanded', () => {
  const window = foldWindow(500, true, 200)
  // Expanded: no notice, boundary 0 — full sum.
  assert.equal(
    visibleItemsBefore(3, window, (_id) => 5),
    15,
  )
})
