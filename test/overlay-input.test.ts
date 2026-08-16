import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { pickFromListWithSearch } from '../src/ui/overlays.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function bootOverlay(items: { value: string; label: string }[]) {
  const terminal = new MockTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.start()
  const promise = pickFromListWithSearch(tui, { title: 'pick', items })
  return { tui, terminal, promise }
}

const press = (terminal: MockTerminal, data: string): void => {
  assert.ok(terminal.onInput !== undefined, 'terminal input callback must be wired')
  terminal.onInput(data)
}

test('Enter on the first item resolves the picked value', async () => {
  const { terminal, promise } = bootOverlay([
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ])
  await tick()
  press(terminal, '\r')
  assert.equal(await promise, 'a')
})

test('Esc cancels and resolves undefined', async () => {
  const { terminal, promise } = bootOverlay([
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ])
  await tick()
  press(terminal, '\x1b')
  assert.equal(await promise, undefined)
})

test('typing narrows the list, then Enter picks the top match', async () => {
  const { terminal, promise } = bootOverlay([
    { value: 'alpha', label: 'alpha' },
    { value: 'beta', label: 'beta' },
    { value: 'alphabet', label: 'alphabet' },
  ])
  await tick()
  press(terminal, 'a')
  press(terminal, 'l')
  press(terminal, 'p')
  press(terminal, 'h')
  await tick()
  press(terminal, '\r')
  assert.equal(await promise, 'alpha')
})
