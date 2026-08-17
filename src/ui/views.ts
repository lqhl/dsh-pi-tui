/**
 * Transcript views: one component per ChatItem kind plus the status bar.
 * Each view holds its ChatItem and refreshes from it on `updateFromItem()`;
 * rendering is stateless so `invalidate()` is a no-op.
 */
import { diffLines } from 'diff'
import chalk from 'chalk'
import {
  Container,
  Image,
  Markdown,
  Text,
  getCapabilities,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { ChatItem } from '../core/model.js'
import { markdownTheme, reasoningMarkdownTheme, style } from './theme.js'
import { renderContextBar, sandboxShort, shortTokens } from '../core/format.js'

/**
 * Collapsed reasoning label; expanded renders the markdown body. While the
 * text is still streaming it renders as plain wrapped text instead of
 * markdown: partial markdown re-parses on every delta and structures like
 * tables re-flow their columns, churning the transcript and re-rendering
 * the whole body O(n) per delta. Plain wrapped text grows monotonically, so
 * only the tail ever changes.
 */
export class ReasoningView extends Container {
  private body: Markdown
  private label: Text
  private plain: Text
  private expanded = false
  private lastText = ''
  private lastMode: 'label' | 'markdown' | 'plain' | undefined
  private item: ChatItem

  constructor(item: ChatItem) {
    super()
    this.item = item
    this.body = new Markdown('', 1, 0, reasoningMarkdownTheme)
    this.label = new Text('', 1, 0)
    this.plain = new Text('', 1, 0)
  }

  updateFromItem(expanded: boolean): void {
    this.expanded = expanded
    const mode: 'label' | 'markdown' | 'plain' = this.item.streaming
      ? 'plain'
      : expanded
        ? 'markdown'
        : 'label'
    if (this.lastMode !== mode || this.lastText !== this.item.text) {
      this.clear()
      if (mode === 'plain') {
        this.plain.setText(this.item.text)
        this.addChild(this.plain)
      } else if (mode === 'markdown') {
        this.body.setText(this.item.text)
        this.addChild(this.body)
      } else {
        this.label.setText(style.thinkingLabel(`∴ Thinking · ${this.item.text.length} chars`))
        this.addChild(this.label)
      }
      this.lastMode = mode
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
  private plain: Text
  private item: ChatItem
  private lastText = ''
  private lastStreaming = true

  constructor(item: ChatItem) {
    super()
    this.item = item
    this.markdown = new Markdown('', 1, 0, markdownTheme)
    this.plain = new Text('', 1, 0)
  }

  updateFromItem(): void {
    // Stream as plain wrapped text (stable, monotonic growth); apply markdown
    // only once sealed. See ReasoningView for the flicker rationale.
    if (this.lastText !== this.item.text || this.lastStreaming !== this.item.streaming) {
      this.clear()
      if (this.item.streaming) {
        this.plain.setText(this.item.text)
        this.addChild(this.plain)
      } else {
        this.markdown.setText(this.item.text)
        this.addChild(this.markdown)
      }
      this.lastText = this.item.text
      this.lastStreaming = this.item.streaming
    }
  }
}

export class NoticeView extends Text {
  private item: ChatItem
  private lastKey = ''

  constructor(item: ChatItem) {
    super('', 1, 0)
    this.item = item
  }

  updateFromItem(): void {
    const flavor = this.item.notice ?? 'info'
    const key = `${flavor}:${this.item.text}`
    if (key !== this.lastKey) {
      this.lastKey = key
      if (flavor === 'banner') {
        // Pre-colored block; render verbatim without a marker.
        this.setText(this.item.text)
        return
      }
      const marker =
        flavor === 'error'
          ? style.toolError('✗')
          : flavor === 'compact'
            ? style.accent('»')
            : style.muted('ℹ')
      const text =
        flavor === 'error' ? style.toolError(this.item.text) : style.muted(this.item.text)
      this.setText(`${marker} ${text}`)
    }
  }
}

/** Compact tool card: status line + truncated args, settle line on result. */
export class ToolCardView implements Component {
  private item: ChatItem
  private lastRender: string | undefined
  private expand = false
  private images: { base64: string; mediaType: string }[] = []
  /** Cached Image components: a fresh `Image` per render allocates a new
   * kitty image id every frame, churning the graphics protocol and forcing
   * extra full redraws (flicker). Reuse them; only width changes rebuild. */
  private imageViews: Image[] = []
  private imageViewsWidth = -1
  /** Cached markdown view for an exit_plan_mode card's full plan body. */
  private planMarkdown: Markdown | undefined

  constructor(item: ChatItem) {
    this.item = item
  }

  updateFromItem(expand: boolean): void {
    this.expand = expand
  }

  /** Resolved inline images (filled by the screen after read_image results). */
  setImages(images: { base64: string; mediaType: string }[]): void {
    this.images = images
    this.imageViews = []
    this.imageViewsWidth = -1
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
      if (tool.status === 'rejected') {
        return `${style.muted('↩')} ${style.toolName(tool.name)} ${style.toolArgs(tool.argsPreview)} — ${style.muted(tool.resultPreview ?? 'not approved')}`
      }
      return `${style.toolOk('✓')} ${style.toolName(tool.name)} ${style.toolArgs(tool.argsPreview)}`
    })()
    // Display-width-aware truncation: CJK glyphs occupy two columns, so
    // plain string slicing lets lines overflow the terminal and trip
    // pi-tui's width assertion.
    const truncate = (line: string): string => {
      const visible = visibleWidth(line)
      if (visible <= inner) return line
      return `${truncateToWidth(line, Math.max(0, inner - 1))}…`
    }
    lines.push(`${border} ${truncate(statusLine)}`)
    // exit_plan_mode carries the full plan in its arguments; render it as the
    // card body so the scrollable transcript (not the overlay) holds the plan.
    if (tool.planText !== undefined && tool.planText !== '') {
      if (this.planMarkdown === undefined) {
        this.planMarkdown = new Markdown(tool.planText, 0, 0, markdownTheme)
      }
      for (const line of this.planMarkdown.render(inner)) {
        lines.push(`${border} ${truncate(line)}`)
      }
    }
    // Only successful results get a body; running/error/rejected cards carry
    // their status in the status line alone.
    if (tool.status === 'ok') {
      // Expanded view with result-time diffs (write/edit tools) renders a
      // colored unified diff instead of the raw result text.
      if (this.expand && tool.diffs !== undefined && tool.diffs.length > 0) {
        lines.push(...this.renderDiffLines(border, truncate))
      } else if (tool.resultPreview !== undefined && tool.resultPreview !== '') {
        const body =
          this.expand && tool.resultFull !== undefined && tool.resultFull !== ''
            ? tool.resultFull
            : tool.resultPreview
        // Full output: keep every line, each truncated to the inner width,
        // capped at a generous height for very large results.
        const fullLines = body.split('\n').slice(0, 50)
        for (const line of fullLines) {
          lines.push(`${border} ${truncate(style.toolResult(line))}`)
        }
      }
    }
    // Inline images (read_image results) render in the expanded view when
    // the terminal speaks kitty/iTerm2 graphics; otherwise a text note.
    if (this.expand && this.images.length > 0) {
      const capabilities = getCapabilities()
      if (capabilities.images !== null) {
        if (this.imageViews.length !== this.images.length || this.imageViewsWidth !== width) {
          this.imageViews = this.images.map(
            (image) =>
              new Image(
                image.base64,
                image.mediaType,
                { fallbackColor: (text) => chalk.dim(text) },
                { maxWidthCells: Math.max(10, inner - 2) },
              ),
          )
          this.imageViewsWidth = width
        }
        for (const component of this.imageViews) {
          for (const line of component.render(width)) {
            lines.push(`${border} ${line}`)
          }
        }
      } else {
        lines.push(
          `${border} ${truncate(chalk.dim(`(image: ${this.images.map((image) => image.mediaType).join(', ')} — run in a kitty/iTerm2 terminal to view inline)`))}`,
        )
      }
    }
    this.lastRender = lines.join('\n')
    return lines
  }

  /** Colored unified diff per changed file (adapts pi's diff rendering). */
  private renderDiffLines(border: string, truncate: (line: string) => string): string[] {
    const lines: string[] = []
    for (const file of this.item.tool?.diffs ?? []) {
      lines.push(`${border} ${style.toolName(file.path)}`)
      const MAX = 80
      if (file.oldText === null) {
        // New file: every line added.
        for (const line of file.newText.split('\n').slice(0, MAX)) {
          lines.push(`${border} ${truncate(chalk.green(`+ ${line}`))}`)
        }
        continue
      }
      const parts = diffLines(file.oldText, file.newText)
      let count = 0
      for (const part of parts) {
        for (const line of part.value.replace(/\n$/, '').split('\n')) {
          if (count++ >= MAX) break
          const prefix = part.added ? '+ ' : part.removed ? '- ' : '  '
          const styled = part.added
            ? chalk.green(prefix + line)
            : part.removed
              ? chalk.red(prefix + line)
              : chalk.dim(prefix + line)
          lines.push(`${border} ${truncate(styled)}`)
        }
        if (count >= MAX) break
      }
    }
    return lines
  }

  handleInput(): void {
    // M2: Enter expands the full result.
  }

  invalidate(): void {
    this.lastRender = undefined
    this.planMarkdown?.invalidate()
  }
}

export interface StatusBarData {
  model?: string
  sessionId?: string
  cwd?: string
  tokens?: { input: number; output: number }
  todos?: { done: number; total: number }
  title?: string
  preset?: string
  planActive?: boolean
  goalPhase?: string
  contextPct?: number
  contextUsed?: number
  contextTotal?: number
  sandboxMode?: string
  jobsRunning?: number
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
    if (data.preset !== undefined) parts.push(data.preset)
    // Explicit mode indicator: plan when active, normal otherwise.
    parts.push(data.planActive === true ? '⌘plan' : 'normal')
    const modeShort = sandboxShort(data.sandboxMode)
    if (modeShort !== undefined) parts.push(modeShort)
    if (data.goalPhase !== undefined) parts.push(`◈${data.goalPhase}`)
    if (data.sessionId !== undefined) parts.push(data.sessionId.slice(0, 8))
    if (data.cwd !== undefined) parts.push(data.cwd)
    if (data.tokens !== undefined) {
      parts.push(`in ${shortTokens(data.tokens.input)} out ${shortTokens(data.tokens.output)}`)
    }
    if (data.contextPct !== undefined) {
      const bar = renderContextBar(data.contextUsed, data.contextTotal)
      const totals =
        data.contextUsed !== undefined && data.contextTotal !== undefined
          ? ` ${shortTokens(data.contextUsed)}/${shortTokens(data.contextTotal)}`
          : ''
      parts.push(`ctx ${bar !== undefined ? `${bar} ` : ''}${data.contextPct}%${totals}`)
    }
    if (data.todos !== undefined && data.todos.total > 0) {
      parts.push(`☐ ${data.todos.done}/${data.todos.total}`)
    }
    if (data.jobsRunning !== undefined) parts.push(`⚙ ${data.jobsRunning}`)
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
    case 'notice':
      return new NoticeView(item)
  }
}

export function updateView(
  view: Component,
  item: ChatItem,
  expandReasoning: boolean,
  expandTools: boolean,
): void {
  if (view instanceof UserMessageView) view.updateFromItem()
  else if (view instanceof AssistantMessageView) view.updateFromItem()
  else if (view instanceof ReasoningView) view.updateFromItem(expandReasoning)
  else if (view instanceof NoticeView) view.updateFromItem()
  else if (view instanceof ToolCardView) view.updateFromItem(expandTools)
}
