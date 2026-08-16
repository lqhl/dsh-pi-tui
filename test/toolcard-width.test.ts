import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiMainScreen, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { ChatItem } from '../src/core/model.js'
import { ToolCardView } from '../src/ui/views.js'
import { MockTerminal } from './mock-terminal.js'

const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function cardItem(text: string): ChatItem {
  return {
    id: 0,
    kind: 'tool',
    text: '',
    streaming: false,
    tool: {
      callId: 'c1',
      name: 'read',
      argsPreview: '{"file_path": "/x/OSDI-2026.md"}',
      status: 'ok',
      resultPreview: text,
      resultFull: text,
    },
  }
}

/** Every rendered line must fit the terminal width (pi-tui throws otherwise). */
test('tool card lines stay within width with CJK content', async () => {
  const terminal = new MockTerminal()
  terminal.width = 40
  const tui = new TuiMainScreen(terminal)
  const view: Component = new ToolCardView(
    cardItem(
      '<path>/Users/qliu/workspace/wiki/OSDI-2026.md</path> <content> 217: - [[GraCE-OSDI26]]：**核心问题**是 CUDA Graph 的收益常被细节抵消，动…',
    ),
  )
  tui.addChild(view)
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(visibleWidth(line) <= terminal.width, `line exceeds width ${terminal.width}: ${line}`)
  }
  tui.stop()
})

test('expanded tool card truncates full CJK output lines', async () => {
  const terminal = new MockTerminal()
  terminal.width = 30
  const tui = new TuiMainScreen(terminal)
  const view = new ToolCardView(
    cardItem('第一行包含大量中文内容需要截断处理\nsecond line\n第三行也很长很长很长很长'),
  )
  view.updateFromItem(true) // Ctrl+O expansion
  tui.addChild(view)
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(visibleWidth(line) <= terminal.width, `line exceeds width: ${line}`)
  }
  tui.stop()
})

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

test('diff rendering stays within width (CJK + ANSI)', async () => {
  const terminal = new MockTerminal()
  terminal.width = 40
  const tui = new TuiMainScreen(terminal)
  const item: ChatItem = {
    id: 0,
    kind: 'tool',
    text: '',
    streaming: false,
    tool: {
      callId: 'c1',
      name: 'edit',
      argsPreview: '{}',
      status: 'ok',
      diffs: [
        {
          path: 'wiki/OSDI.md',
          oldText: '旧的内容第一行\n第二行',
          newText: '新的内容第一行很长很长很长很长\n第二行',
        },
      ],
    },
  }
  const view = new ToolCardView(item)
  view.updateFromItem(true)
  tui.addChild(view)
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  assert.ok(output.includes('+ 新的内容'), 'diff added lines should render')
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(visibleWidth(line) <= terminal.width, `line exceeds width: ${line}`)
  }
  tui.stop()
})

test('image capability fallback renders a text note, no crash', async () => {
  const terminal = new MockTerminal()
  terminal.width = 60
  const tui = new TuiMainScreen(terminal)
  const item: ChatItem = {
    id: 0,
    kind: 'tool',
    text: '',
    streaming: false,
    tool: {
      callId: 'c1',
      name: 'read_image',
      argsPreview: '{}',
      status: 'ok',
      resultPreview: 'image 100x50',
    },
  }
  const view = new ToolCardView(item)
  view.setImages([{ base64: 'aGVsbG8=', mediaType: 'image/png' }])
  view.updateFromItem(true)
  tui.addChild(view)
  tui.start()
  tui.requestRender()
  await tick()
  const output = stripAnsi(terminal.output)
  // The mock terminal has no image capability: expect the note or nothing,
  // but never a crash / oversized line.
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    assert.ok(visibleWidth(line) <= terminal.width, `line exceeds width: ${line}`)
  }
  tui.stop()
})
