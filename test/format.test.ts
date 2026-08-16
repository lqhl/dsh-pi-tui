import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { contextPctOf, renderContextBar, sandboxShort, shortTokens } from '../src/core/format.js'

test('sandboxShort maps modes to compact labels', () => {
  assert.equal(sandboxShort('workspace-write'), 'ws-write')
  assert.equal(sandboxShort('read-only'), 'read-only')
  assert.equal(sandboxShort('danger-full-access'), 'danger')
  assert.equal(sandboxShort('custom-mode'), 'custom-mode')
  assert.equal(sandboxShort(undefined), undefined)
})

test('shortTokens abbreviates human-readably', () => {
  assert.equal(shortTokens(999), '999')
  assert.equal(shortTokens(1000), '1k')
  assert.equal(shortTokens(12345), '12.3k')
  assert.equal(shortTokens(1_000_000), '1M')
  assert.equal(shortTokens(1_500_000), '1.5M')
})

test('contextPctOf computes pressure percentage with clamps', () => {
  assert.equal(contextPctOf({ projectedTokens: 450, contextWindow: 1000 }), 45)
  assert.equal(contextPctOf({ pressureTokens: 2000, contextWindow: 1000 }), 100)
  assert.equal(contextPctOf({ contextWindow: 1000 }), undefined)
  assert.equal(contextPctOf(undefined), undefined)
})

test('renderContextBar fills 10 cells and handles unknowns', () => {
  assert.equal(renderContextBar(undefined, 1000), undefined)
  assert.equal(renderContextBar(500, 0), undefined)
  const bar = renderContextBar(500, 1000)
  assert.ok(bar !== undefined)
  // ANSI color codes count toward string length; assert the VISIBLE width.
  assert.equal(visibleWidth(bar), 10)
  const red = renderContextBar(950, 1000)
  const yellow = renderContextBar(800, 1000)
  const green = renderContextBar(500, 1000)
  assert.notEqual(red, green)
  assert.notEqual(yellow, green)
})
