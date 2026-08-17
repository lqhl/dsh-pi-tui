/**
 * Regression guard for the alt-screen layout: streaming + content shrink
 * (reasoning collapsing at seal) must stay differential. TuiMainScreen used
 * to full-redraw (`\x1b[2J\x1b[H\x1b[3J`, clearing scrollback) whenever a
 * change sat above the viewport; the alternate-screen renderer diffs rows
 * in place and never clears scrollback.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Container, ScrollView, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'
import { AssistantMessageView, ReasoningView } from '../src/ui/views.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 16): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The app's transcript + pinned-footer layout (editor/status elided). */
function tuiWithLayout(): { tui: TuiAltScreen; terminal: MockTerminal; messages: Container } {
  const terminal = new MockTerminal()
  terminal.width = 80
  terminal.height = 24
  const tui = new TuiAltScreen(terminal)
  const messages = new Container()
  for (let i = 0; i < 30; i++) {
    messages.addChild(new Text(`prior transcript line ${i}`, 1, 0))
  }
  tui.setLayoutRoot(
    new VStack([
      {
        component: new ScrollView(messages, {
          follow: 'end',
          primary: true,
          overscroll: 'chain',
        }),
        basis: 0,
        grow: 1,
        minSize: 1,
      },
      { component: new Text('status bar', 1, 0), basis: 'auto', shrink: 1, minSize: 1 },
    ]),
  )
  return { tui, terminal, messages }
}

test('reasoning collapse at seal does not full-redraw or clear scrollback', async () => {
  const { tui, terminal, messages } = tuiWithLayout()
  const reasoning = { id: 0, kind: 'reasoning' as const, text: '', streaming: true }
  const rv = new ReasoningView(reasoning)
  messages.addChild(rv)
  const assistant = { id: 1, kind: 'assistant' as const, text: '', streaming: true }
  const av = new AssistantMessageView(assistant)
  messages.addChild(av)

  tui.start()
  await tick(30)

  // Stream a long reasoning body (lands above the viewport), then seal.
  let text = ''
  for (let i = 0; i < 60; i++) {
    text += `thinking line ${i} lorem ipsum dolor sit amet\n`
    reasoning.text = text
    rv.updateFromItem(false)
    tui.requestRender()
    await tick(5)
  }
  assistant.text = 'the final answer'
  av.updateFromItem()
  tui.requestRender()
  await tick(10)

  const redrawsBeforeSeal = tui.fullRedraws
  reasoning.streaming = false
  rv.updateFromItem(false)
  assistant.streaming = false
  av.updateFromItem()
  tui.requestRender()
  await tick(30)

  // Only the first frame counts as a full redraw; the collapse must not.
  assert.equal(tui.fullRedraws, redrawsBeforeSeal, 'collapse triggered a full redraw')
  assert.equal(
    tui.fullRedraws,
    1,
    `expected exactly the first-frame full redraw (got ${tui.fullRedraws})`,
  )
  // The whole point: never wipe the terminal scrollback.
  assert.equal((terminal.output.match(/\x1b\[3J/g) ?? []).length, 0, 'scrollback was cleared')
  tui.stop()
})
