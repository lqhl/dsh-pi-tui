import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { openFindOverlay } from '../src/ui/overlays.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function bootFind(initialQuery = '') {
  const terminal = new MockTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()
  const calls: { kind: 'search' | 'jump'; query?: string; index?: number }[] = []
  const promise = openFindOverlay(tui, {
    initialQuery,
    search: (query) => {
      calls.push({ kind: 'search', query })
      return query === '' ? 0 : query === 'err' ? 0 : 3
    },
    jump: (index) => {
      calls.push({ kind: 'jump', index })
    },
  })
  return { tui, terminal, promise, calls }
}

const press = (terminal: MockTerminal, data: string): void => {
  assert.ok(terminal.onInput !== undefined, 'terminal input callback must be wired')
  terminal.onInput(data)
}

test('find overlay runs the search on open and on every keystroke', async () => {
  const { terminal, calls } = bootFind()
  await tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { kind: 'search', query: '' })
  press(terminal, 't')
  press(terminal, 'o')
  assert.equal(calls.filter((call) => call.kind === 'search').length, 3)
})

test('find overlay jumps to the first match after typing', async () => {
  const { terminal, calls } = bootFind()
  await tick()
  press(terminal, 'x')
  const jumps = calls.filter((call) => call.kind === 'jump')
  assert.ok(jumps.length >= 1)
  assert.equal(jumps[0]?.index, 0)
})

test('down/up cycle match index', async () => {
  const { terminal, calls } = bootFind()
  await tick()
  press(terminal, 'x')
  press(terminal, '\x1b[B') // down
  press(terminal, '\x1b[B') // down
  press(terminal, '\x1b[A') // up
  const jumps = calls.filter((call) => call.kind === 'jump')
  // 0 (initial) → 1 → 2 → 1
  assert.deepEqual(
    jumps.map((jump) => jump.index),
    [0, 1, 2, 1],
  )
})

test('esc closes the find overlay', async () => {
  const { terminal, promise } = bootFind()
  await tick()
  press(terminal, '\x1b')
  await promise
})

test('no matches stops jumping', async () => {
  const { terminal, calls } = bootFind()
  await tick()
  press(terminal, 'e')
  press(terminal, 'r')
  press(terminal, 'r')
  press(terminal, '\r')
  const searches = calls.filter((call) => call.kind === 'search')
  assert.equal(searches.at(-1)?.query, 'err')
  // 'e' and 'er' each matched 3 and jumped once; 'err' matched nothing, so
  // the total jump count stays at 2 and Enter is a no-op.
  const jumps = calls.filter((call) => call.kind === 'jump')
  assert.equal(jumps.length, 2)
})
