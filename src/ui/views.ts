/**
 * Transcript views: one component per ChatItem kind plus the status bar.
 * Each view holds its ChatItem and refreshes from it on `updateFromItem()`;
 * rendering is stateless so `invalidate()` is a no-op.
 */
import chalk from 'chalk'
import {
  Container,
  Markdown,
  Text,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { ChatItem } from '../core/model.js'
import { markdownTheme, reasoningMarkdownTheme, style } from './theme.js'

/** Collapsed reasoning label; expanded/streaming renders the markdown body. */
export class ReasoningView extends Container {
  private body: Markdown
  private label: Text
  private expanded = false
  private lastText = ''
  private lastExpanded: boolean | undefined
  private item: ChatItem

  constructor(item: ChatItem) {
    super()
    this.item = item
    this.body = new Markdown('', 1, 0, reasoningMarkdownTheme)
    this.label = new Text('', 1, 0)
  }

  updateFromItem(expanded: boolean): void {
    this.expanded = expanded
    const showBody = this.item.streaming || expanded
    if (this.lastExpanded !== showBody || this.lastText !== this.item.text) {
      this.clear()
      if (showBody) {
        this.body.setText(this.item.text)
        this.addChild(this.body)
      } else {
        this.label.setText(style.thinkingLabel(`∴ Thinking · ${this.item.text.length} chars`))
        this.addChild(this.label)
      }
      this.lastExpanded = showBody
      this.lastText = this.item.text
    }
  }
}

export class UserMessageView extends Text {
  private item: ChatItem
  private lastText = ''

  constructor(item: ChatItem) {
    super('', 1, 0)
    this.item = item
  }

  updateFromItem(): void {
    if (this.lastText !== this.item.text) {
      this.setText(`${style.userPrefix('❯')} ${style.userText(this.item.text)}`)
      this.lastText = this.item.text
    }
  }
}

export class AssistantMessageView extends Container {
  private markdown: Markdown
  private item: ChatItem
  private lastText = ''

  constructor(item: ChatItem) {
    super()
    this.item = item
    this.markdown = new Markdown('', 1, 0, markdownTheme)
    this.addChild(this.markdown)
  }

  updateFromItem(): void {
    if (this.lastText !== this.item.text) {
      this.markdown.setText(this.item.text)
      this.markdown.invalidate()
      this.lastText = this.item.text
    }
  }
}

/** Compact tool card: status line + truncated args, settle line on result. */
export class ToolCardView implements Component {
  private item: ChatItem
  private lastRender: string | undefined

  constructor(item: ChatItem) {
    this.item = item
  }

  render(width: number): string[] {
    const tool = this.item.tool
    if (tool === undefined) return []
    const inner = Math.max(10, width - 4)
    const border = style.toolBorder('│')
    const lines: string[] = []
    const statusLine = (() => {
      if (tool.status === 'running') {
        return `${chalk.blue('⏺')} ${style.toolName(tool.name)} ${style.toolArgs(tool.argsPreview)}`
      }
      if (tool.status === 'error') {
        return `${style.toolError('✗')} ${style.toolName(tool.name)} ${style.toolError(tool.errorText ?? 'error')}`
      }
      return `${style.toolOk('✓')} ${style.toolName(tool.name)} ${style.toolArgs(tool.argsPreview)}`
    })()
    const truncate = (line: string): string =>
      line.length > inner ? `${line.slice(0, inner - 1)}…` : line
    lines.push(`${border} ${truncate(statusLine)}`)
    if (tool.status !== 'running') {
      if (tool.resultPreview !== undefined && tool.resultPreview !== '') {
        lines.push(`${border} ${truncate(style.toolResult(tool.resultPreview))}`)
      }
    }
    // Pad the border line to full width (the TUI requires exact width lines
    // only for content; short lines are fine).
    this.lastRender = lines.join('\n')
    return lines
  }

  handleInput(): void {
    // M2: Enter expands the full result.
  }

  invalidate(): void {
    this.lastRender = undefined
  }
}

export interface StatusBarData {
  model?: string
  sessionId?: string
  cwd?: string
  tokens?: { input: number; output: number }
  title?: string
}

/** Single-line status bar; truncates to the terminal width. */
export class StatusBar implements Component {
  private text = ''

  constructor() {
    this.text = ''
  }

  update(data: StatusBarData): void {
    const parts: string[] = ['dsh-pi-tui']
    if (data.model !== undefined) parts.push(data.model)
    if (data.sessionId !== undefined) parts.push(data.sessionId.slice(0, 8))
    if (data.cwd !== undefined) parts.push(data.cwd)
    if (data.tokens !== undefined) {
      parts.push(`in ${data.tokens.input} out ${data.tokens.output}`)
    }
    if (data.title !== undefined) parts.push(data.title)
    this.text = style.statusBar(parts.join(' · '))
  }

  render(width: number): string[] {
    if (width <= 1) return ['']
    return [truncateToWidth(this.text, width)]
  }

  invalidate(): void {
    // Stateless.
  }
}

export function createView(item: ChatItem): Component {
  switch (item.kind) {
    case 'user':
      return new UserMessageView(item)
    case 'assistant':
      return new AssistantMessageView(item)
    case 'reasoning':
      return new ReasoningView(item)
    case 'tool':
      return new ToolCardView(item)
  }
}

export function updateView(view: Component, item: ChatItem, expandReasoning: boolean): void {
  if (view instanceof UserMessageView) view.updateFromItem()
  else if (view instanceof AssistantMessageView) view.updateFromItem()
  else if (view instanceof ReasoningView) view.updateFromItem(expandReasoning)
  // ToolCardView renders statelessly from its item each frame.
}
