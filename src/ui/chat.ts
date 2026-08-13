/**
 * ChatScreen: the live conversation surface.
 *
 * Layout is a vertical stack — messages, working loader, status bar, editor
 * — rendered top-down. Like pi's own chat, the terminal viewport naturally
 * sticks to the bottom (the last rendered lines), and scrollback is the
 * terminal's native buffer.
 *
 * Events flow in through `handleEvent()` (replay + live subscription from
 * the app layer); the screen folds them into the model and reconciles the
 * component tree, requesting one diff frame per batch.
 */
import { basename } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  Container,
  Editor,
  Loader,
  TuiMainScreen,
  matchesKey,
  type TUI,
} from '@earendil-works/pi-tui'
import { applyEvent, createModel, type ChatModel } from '../core/model.js'
import { editorTheme, style } from './theme.js'
import { createView, StatusBar, updateView, type StatusBarData } from './views.js'

export interface ChatScreenOptions {
  tui: TUI
  agent: Agent
  config: {
    provider?: string
    model?: string
    cwd?: string
  }
  onQuit: () => void
}

export class ChatScreen {
  private readonly tui: TUI
  private readonly agent: Agent
  private readonly config: ChatScreenOptions['config']
  private readonly cwd: string
  private readonly model: ChatModel = createModel()
  private readonly messages = new Container()
  private readonly statusBar = new StatusBar()
  private readonly editor: Editor
  private workingLoader: Loader | undefined
  private readonly views = new Map<number, ReturnType<typeof createView>>()
  private expandReasoning = false

  constructor(options: ChatScreenOptions) {
    this.tui = options.tui
    this.agent = options.agent
    this.config = options.config
    this.cwd = options.config.cwd ?? process.cwd()

    this.tui.addChild(this.messages)
    this.tui.addChild(this.statusBar)
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
    this.editor.onSubmit = (text) => {
      this.submit(text)
    }
    this.tui.addChild(this.editor)
    this.tui.setFocus(this.editor)

    this.tui.addInputListener((data: string) => {
      if (matchesKey(data, 'ctrl+o')) {
        this.expandReasoning = !this.expandReasoning
        this.sync()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+c')) {
        options.onQuit()
        return { consume: true }
      }
      return undefined
    })

    this.tui.terminal.setTitle(`dsh-pi-tui · ${basename(this.cwd)}`)
    this.sync()
    // NOTE: the app layer already started the TUI (it must be live for the
    // boot-time session picker overlay); starting again would attach a
    // second stdin data listener and duplicate every keystroke.
  }

  /** Submit one human turn. */
  submit(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') {
      this.editor.setText('')
      return
    }
    this.editor.addToHistory(trimmed)
    this.editor.setText('')
    this.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: trimmed }],
        source: { kind: 'user' },
      }),
    )
  }

  /** Fold one session event and reconcile the component tree. */
  handleEvent(event: SessionEvent): void {
    applyEvent(this.model, event)
    this.sync()
  }

  /** Create views for new items, refresh changed ones, fix the chrome. */
  private sync(): void {
    const { items } = this.model
    for (let index = this.views.size; index < items.length; index++) {
      const item = items[index]
      const view = createView(item)
      this.views.set(item.id, view)
      this.messages.addChild(view)
    }
    for (const item of items) {
      const view = this.views.get(item.id)
      if (view !== undefined) updateView(view, item, this.expandReasoning)
    }

    // Working loader between messages and the status bar.
    if (this.model.working && this.workingLoader === undefined) {
      const loader = new Loader(
        this.tui,
        style.spinner,
        style.workingLabel,
        'Working…',
      )
      loader.start()
      this.workingLoader = loader
      this.messages.addChild(loader)
    } else if (!this.model.working && this.workingLoader !== undefined) {
      this.workingLoader.stop()
      this.messages.removeChild(this.workingLoader)
      this.workingLoader = undefined
    }

    const status: StatusBarData = {
      model: this.configModel(),
      sessionId: String(this.agent.session.id),
      cwd: basename(this.cwd),
      tokens: this.model.tokens,
      title: this.model.title,
    }
    this.statusBar.update(status)
    this.tui.requestRender()
  }

  private configModel(): string | undefined {
    // The concrete model is adapter-resolved at request time; show the
    // explicit override when set, else the provider route.
    return this.config.model ?? this.config.provider
  }
}

export function createTui(terminal: import('@earendil-works/pi-tui').Terminal): TUI {
  return new TuiMainScreen(terminal)
}
