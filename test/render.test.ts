import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiMainScreen, Text } from '@earendil-works/pi-tui'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('renders a frame headlessly through the mock terminal', async () => {
  const terminal = new MockTerminal()
  const tui = new TuiMainScreen(terminal)
  tui.addChild(new Text('hello dsh-pi-tui'))
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  assert.ok(output.includes('hello dsh-pi-tui'), `unexpected output: ${output}`)
  tui.stop()
})

test('renders narrow widths without error', async () => {
  const terminal = new MockTerminal()
  terminal.width = 20
  const tui = new TuiMainScreen(terminal)
  tui.addChild(new Text('this is a line longer than twenty columns for sure'))
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  assert.ok(output.length > 0)
  tui.stop()
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}
