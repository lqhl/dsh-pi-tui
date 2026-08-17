/**
 * Regression guard: streaming markdown must not trigger repeated full-screen
 * redraws (the "crazy flicker"). TuiMainScreen falls back to a clear +
 * redraw whenever changed lines sit above the visible viewport; partial
 * markdown re-parses on every delta and structures like tables re-flow their
 * columns, which used to force a full redraw on nearly every chunk. The view
 * now streams as plain wrapped text and only applies markdown once sealed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Container, Text, TuiMainScreen } from '@earendil-works/pi-tui'
import type { ChatItem } from '../src/core/model.js'
import { AssistantMessageView, ReasoningView } from '../src/ui/views.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function assistantItem(): ChatItem {
  return { id: 0, kind: 'assistant', text: '', streaming: true }
}

function reasoningItem(): ChatItem {
  return { id: 0, kind: 'reasoning', text: '', streaming: true }
}

/** A growing markdown table: the classic re-flow structure. */
function tableChunks(rows: number): string[] {
  const chunks: string[] = []
  let text = '| name | value |\n| --- | --- |\n'
  for (let i = 0; i < rows; i++) {
    text += `| item ${i} | ${'x'.repeat(i % 18)} |\n`
    chunks.push(text)
  }
  return chunks
}

/** Build a TUI whose transcript already overflows the viewport. */
function tuiWithTranscript(): { tui: TuiMainScreen; messages: Container } {
  const terminal = new MockTerminal()
  terminal.width = 80
  terminal.height = 24
  const tui = new TuiMainScreen(terminal)
  const messages = new Container()
  tui.addChild(messages)
  for (let i = 0; i < 12; i++) {
    messages.addChild(new Text(`prior transcript line ${i}`, 1, 0))
  }
  tui.addChild(new Text('status bar', 1, 0))
  return { tui, messages }
}

test('streaming assistant table does not trigger repeated full redraws', async () => {
  const { tui, messages } = tuiWithTranscript()
  const item = assistantItem()
  const view = new AssistantMessageView(item)
  messages.addChild(view)
  tui.start()
  await tick()

  for (const chunk of tableChunks(24)) {
    item.text = chunk
    view.updateFromItem()
    tui.requestRender()
    await tick()
  }

  // One full redraw for the first frame only; the streaming phase must add none.
  assert.equal(
    tui.fullRedraws,
    1,
    `streaming should stay differential (got ${tui.fullRedraws} full redraws)`,
  )
  tui.stop()
})

test('streaming reasoning table does not trigger repeated full redraws', async () => {
  const { tui, messages } = tuiWithTranscript()
  const item = reasoningItem()
  const view = new ReasoningView(item)
  messages.addChild(view)
  tui.start()
  await tick()

  for (const chunk of tableChunks(24)) {
    item.text = chunk
    view.updateFromItem(false)
    tui.requestRender()
    await tick()
  }

  assert.equal(
    tui.fullRedraws,
    1,
    `streaming should stay differential (got ${tui.fullRedraws} full redraws)`,
  )
  tui.stop()
})

test('sealing an assistant message re-renders markdown without repeated redraws', async () => {
  const { tui, messages } = tuiWithTranscript()
  const item = assistantItem()
  const view = new AssistantMessageView(item)
  messages.addChild(view)
  tui.start()
  await tick()

  item.text = '| name | value |\n| --- | --- |\n| a | b |\n'
  view.updateFromItem()
  tui.requestRender()
  await tick()

  item.streaming = false
  view.updateFromItem()
  tui.requestRender()
  await tick()

  // Sealing switches plain text -> markdown; a single full redraw is fine.
  assert.ok(tui.fullRedraws <= 2, `expected a bounded seal redraw (got ${tui.fullRedraws})`)
  tui.stop()
})
