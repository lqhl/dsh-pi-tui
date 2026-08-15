/**
 * ChatScreen: the live conversation surface.
 *
 * Layout is a vertical stack — messages, working loader, status bar, editor
 * — rendered top-down. Like pi's own chat, the terminal viewport naturally
 * sticks to the bottom (the last rendered lines), and scrollback is the
 * terminal's native buffer.
 *
 * Key semantics (pi / Claude Code conventions):
 *   Esc        interrupt (cancel the running turn; editor cancels autocomplete)
 *   Ctrl+C     running → interrupt; idle+text → clear editor; idle+empty →
 *              arm, second press within 500ms exits
 *   Ctrl+D     exit when the editor is empty (else editor delete-forward)
 *   Ctrl+T     toggle thinking display
 *   Ctrl+O     toggle full tool output
 *   Ctrl+L     open the model picker
 *   Shift+Tab  cycle thinking effort
 */
import { basename, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { isUserInvocable, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  TuiMainScreen,
  isKeyRelease,
  matchesKey,
  type AutocompleteProvider,
  type SlashCommand,
  type TUI,
} from '@earendil-works/pi-tui'
import { applyEvent, createModel, pushNotice, type ChatItem, type ChatModel } from '../core/model.js'
import {
  ctrlC,
  cycleEffort,
  isPathLikeToken,
  parseBang,
  parseSlash,
  type ExitArm,
} from '../core/keys.js'
import { editorTheme, style } from './theme.js'
import { createView, StatusBar, updateView, type StatusBarData } from './views.js'
import { listAllModels, pickModel, type LlmRuntimeLike, type ModelRoute } from './model-picker.js'
import { pickFromList, pickFromListWithSearch } from './overlays.js'

export interface ChatScreenOptions {
  ctx: Context
  tui: TUI
  agent: Agent
  config: {
    provider?: string
    model?: string
    cwd?: string
  }
  onQuit: () => void
}

interface LlmRuntime extends LlmRuntimeLike {
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts?: { id: string; name: string; description?: string }[]; defaultEffort?: string }
  }>
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
}

export class ChatScreen {
  private readonly ctx: Context
  private readonly tui: TUI
  private readonly agent: Agent
  private readonly config: ChatScreenOptions['config']
  private readonly cwd: string
  private readonly commands: CommandRuntime | undefined
  private readonly model: ChatModel = createModel()
  private readonly messages = new Container()
  private readonly statusBar = new StatusBar()
  private readonly editor: Editor
  /** One-per-agent mutable model selection (grok/web pattern; install once). */
  private readonly selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  private exitArm: ExitArm = { lastPressAt: 0 }
  private workingLoader: Loader | undefined
  private readonly views = new Map<number, ReturnType<typeof createView>>()
  private expandReasoning = false
  private expandTools = false
  private atPickerOpen = false

  constructor(options: ChatScreenOptions) {
    this.ctx = options.ctx
    this.tui = options.tui
    this.agent = options.agent
    this.config = options.config
    this.cwd = options.config.cwd ?? process.cwd()
    this.commands = this.ctx.get('commands') as CommandRuntime | undefined

    // Seed the selection so every step has a route, including RESUMED agents
    // (whose creation never saw our agentOptions): the persisted request
    // header wins, then the row config, then the harness defaults.
    const headerConfig = this.agent.session.requestHeader()?.config
    const seedRoute = {
      provider:
        headerConfig?.provider ??
        this.config.provider ??
        this.agent.options.provider ??
        'deepseek-official',
      model:
        headerConfig?.model ??
        this.config.model ??
        this.agent.options.model ??
        'deepseek-v4-flash',
    }
    this.selection.current = {
      ...seedRoute,
      ...(headerConfig?.reasoningEffort !== undefined
        ? { reasoningEffort: ReasoningEffortId(headerConfig.reasoningEffort) }
        : {}),
    }
    installModelSelection(this.agent.ctx, this.selection)

    this.tui.addChild(this.messages)
    this.tui.addChild(this.statusBar)
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 })
    this.editor.onSubmit = (text) => {
      this.submit(text)
    }
    this.editor.onChange = (text) => {
      this.maybeOpenAtPicker(text)
    }

    // pi-tui's combined provider: slash commands (official + local UI
    // commands) plus file-path completion anchored at the session cwd.
    const slashCommands: SlashCommand[] = [
      ...(this.commands?.list(this.agent) ?? []).map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
      })),
      { name: 'model', description: 'Switch model', getArgumentCompletions: (prefix) => this.modelCompletions(prefix) },
      { name: 'thinking', description: 'Set thinking effort (off/high/max)' },
      { name: 'skills', description: 'List user-invocable skills' },
      { name: 'hotkeys', description: 'Show key bindings' },
    ]
    this.editor.setAutocompleteProvider(
      new PathAwareAutocomplete(
        new CombinedAutocompleteProvider(slashCommands, this.cwd),
      ),
    )
    // Rebuild the provider once the skill catalog arrives so `/` completes
    // user-invocable skills too (plain `/name` — the dsh pre-step gesture
    // recognizes that token, not pi's `/skill:name` form).
    void this.listSkills().then((skills) => {
      const withSkills: SlashCommand[] = [
        ...slashCommands,
        ...skills.map((skill) => ({
          name: skill.name,
          description: skill.description ?? skill.whenToUse ?? 'skill',
        })),
      ]
      this.editor.setAutocompleteProvider(
        new PathAwareAutocomplete(new CombinedAutocompleteProvider(withSkills, this.cwd)),
      )
    })
    this.tui.addChild(this.editor)
    this.tui.setFocus(this.editor)

    this.tui.addInputListener((data: string) => {
      // Global listeners see raw chunks BEFORE the focused-component path,
      // which filters kitty key-release events — do the same here, or every
      // functional key (Ctrl+C/D/T/O/L, Esc, Shift+Tab) fires twice.
      if (isKeyRelease(data)) return undefined
      if (matchesKey(data, 'escape')) {
        // A running human shell command owns Esc first (pi semantics).
        if (this.bashRunning) {
          this.bashAbort?.abort()
          return { consume: true }
        }
        if (this.isWorking()) {
          this.interrupt()
          return { consume: true }
        }
        return undefined // editor cancels autocomplete, overlays close
      }
      if (matchesKey(data, 'ctrl+c')) {
        const { action, state, arm } = ctrlC(
          this.exitArm,
          this.isWorking(),
          this.editor.getText().length > 0,
          Date.now(),
        )
        this.exitArm = state
        if (action === 'cancel') this.interrupt()
        else if (action === 'clear') this.editor.setText('')
        else if (action === 'exit') options.onQuit()
        if (arm) this.pushNotice('Press Ctrl+C again to exit')
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+d')) {
        if (this.editor.getText() === '' && !this.isWorking()) {
          options.onQuit()
          return { consume: true }
        }
        return undefined // editor handles delete-forward
      }
      if (matchesKey(data, 'ctrl+t')) {
        this.expandReasoning = !this.expandReasoning
        this.sync()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+o')) {
        this.expandTools = !this.expandTools
        this.sync()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+l')) {
        void this.openModelPicker()
        return { consume: true }
      }
      if (matchesKey(data, 'shift+tab')) {
        void this.cycleThinking()
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

  private isWorking(): boolean {
    return this.model.working || this.agent.status === 'running'
  }

  private interrupt(): void {
    this.agent.cancel({ kind: 'user' }, { keepInbox: true })
  }

  /** Submit one human turn or dispatch a slash/bang command. */
  submit(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') {
      this.editor.setText('')
      return
    }
    this.editor.addToHistory(trimmed)
    this.editor.setText('')
    if (trimmed.startsWith('!')) {
      void this.runBashCommand(trimmed)
      return
    }
    if (trimmed.startsWith('/')) {
      void this.dispatchSlash(trimmed)
      return
    }
    this.followup(trimmed)
  }

  private followup(text: string): void {
    this.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
  }

  /** Route a slash line: local UI commands → official registry → skills. */
  private async dispatchSlash(line: string): Promise<void> {
    const parsed = parseSlash(line)
    if (parsed === undefined) {
      this.followup(line)
      return
    }
    if (parsed.name === 'model') return this.cmdModel(parsed.raw.trim())
    if (parsed.name === 'thinking') return this.cmdThinking(parsed.raw.trim())
    if (parsed.name === 'skills') return this.cmdSkills()
    if (parsed.name === 'hotkeys') return this.cmdHotkeys()

    if (this.commands !== undefined) {
      try {
        const execution = await this.commands.execute(this.agent, line, new AbortController().signal)
        if (execution !== undefined) {
          const result = execution.result
          if (result.kind === 'success') this.pushNotice(result.text ?? line)
          else this.pushNotice(result.text, 'error')
          return
        }
      } catch (error) {
        this.pushNotice(
          `command failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        )
        return
      }
    }

    // User-invocable skills ride a plain `/skillname` message; the
    // dsh-tool-skill pre-step gesture picks it up. Don't swallow it.
    const skills = await this.listSkills()
    if (skills.some((skill) => skill.name === parsed.name)) {
      this.followup(line)
      return
    }
    this.pushNotice(`unknown command: ${line}`, 'error')
  }

  // ── local UI commands ─────────────────────────────────────────────────────

  private llm(): LlmRuntime | undefined {
    return this.ctx.get('llm') as LlmRuntime | undefined
  }

  private currentRoute(): ModelRoute {
    const current = this.selection.current
    if (current !== undefined && current.provider !== undefined && current.model !== undefined) {
      return { provider: current.provider, model: current.model }
    }
    if (this.model.route?.provider !== undefined && this.model.route?.model !== undefined) {
      return { provider: this.model.route.provider, model: this.model.route.model }
    }
    return {
      provider: this.config.provider ?? this.agent.options.provider ?? 'deepseek-official',
      model: this.config.model ?? this.agent.options.model ?? 'deepseek-v4-flash',
    }
  }

  private currentEffort(): string | undefined {
    return this.selection.current?.reasoningEffort ?? this.model.effort
  }

  private async cmdModel(query: string): Promise<void> {
    const llm = this.llm()
    if (llm === undefined) {
      this.pushNotice('llm service unavailable', 'error')
      return
    }
    if (query !== '') {
      const routes = await listAllModels(llm)
      const match =
        routes.find((route) => route.model === query) ??
        routes.find((route) => route.model.toLowerCase().includes(query.toLowerCase()))
      if (match !== undefined) {
        await this.applyModel(match)
        return
      }
    }
    const picked = await pickModel(this.tui, llm, this.currentRoute())
    if (picked !== undefined) await this.applyModel(picked)
  }

  private async applyModel(route: ModelRoute): Promise<void> {
    const llm = this.llm()
    if (llm === undefined) return
    try {
      const resolved = await llm.resolveCallConfig({ provider: route.provider, model: route.model })
      this.selection.current = { provider: resolved.provider, model: resolved.model }
      // Write the shared default too (grok rationale: the web host's outer
      // waterfall fallback chain reads it, so a stale selection can't
      // overwrite this one).
      try {
        const defaults = this.ctx.get('agentDefaultModel') as
          | { saveSelection(next: unknown): Promise<void> }
          | undefined
        await defaults?.saveSelection({ provider: resolved.provider, model: resolved.model })
      } catch {
        // Best effort; session selection already applied.
      }
      this.pushNotice(`model → ${resolved.model} (${resolved.provider}) · from the next step`)
      this.sync()
    } catch (error) {
      this.pushNotice(
        `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    }
  }

  private async cmdThinking(effort: string): Promise<void> {
    const llm = this.llm()
    if (llm === undefined) {
      this.pushNotice('llm service unavailable', 'error')
      return
    }
    const route = this.currentRoute()
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = info.reasoning?.efforts ?? []
    if (effort === '' || !efforts.some((entry) => entry.id === effort)) {
      const list = efforts.map((entry) => entry.id).join('|') || 'off|high|max'
      this.pushNotice(
        `thinking: ${list} · current: ${this.currentEffort() ?? info.reasoning?.defaultEffort ?? 'default'}`,
      )
      return
    }
    try {
      await llm.resolveCallConfig({
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(effort),
      })
      this.selection.current = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(effort),
      }
      this.pushNotice(`thinking → ${effort} · from the next step`)
      this.sync()
    } catch (error) {
      this.pushNotice(
        `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    }
  }

  private async cycleThinking(): Promise<void> {
    const llm = this.llm()
    if (llm === undefined) return
    const route = this.currentRoute()
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = info.reasoning?.efforts ?? []
    const next = cycleEffort(efforts, this.currentEffort())
    if (next !== undefined) await this.cmdThinking(next)
  }

  private async cmdSkills(): Promise<void> {
    const skills = await this.listSkills()
    if (skills.length === 0) {
      this.pushNotice('no user-invocable skills in this workspace')
      return
    }
    const picked = await pickFromListWithSearch(this.tui, {
      title: 'Skills (user-invocable)',
      body: 'pick one to stage /name in the input; send it to invoke',
      items: skills.map((skill) => ({
        value: skill.name,
        label: skill.name,
        description: skill.description ?? skill.whenToUse,
      })),
    })
    if (picked !== undefined) {
      this.editor.setText(`/${picked} `)
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
  }

  private async listSkills(): Promise<readonly SkillSummary[]> {
    try {
      const presets = this.ctx.get('agentPresets') as
        | { serviceFor(agent: unknown, key: string): unknown }
        | undefined
      const registry = (presets?.serviceFor(this.agent, 'skills') ??
        this.ctx.get('skills')) as
        | { list(options: { cwd?: string; scope?: unknown }): Promise<readonly SkillSummary[]> }
        | undefined
      if (registry === undefined) return []
      const all = await registry.list({ cwd: this.cwd, scope: this.agent })
      return all.filter((skill) => isUserInvocable(skill))
    } catch {
      return []
    }
  }

  private cmdHotkeys(): void {
    this.pushNotice(
      [
        'keys:',
        '  Esc        interrupt · cancel autocomplete',
        '  Ctrl+C     running→interrupt · text→clear · empty→again exits',
        '  Ctrl+D     exit when the editor is empty',
        '  Ctrl+T     toggle thinking display',
        '  Ctrl+O     toggle full tool output',
        '  Ctrl+L     model picker · Shift+Tab cycle thinking',
        '  Tab        complete paths · / slash commands · @ attach files',
      ].join('\n'),
    )
  }

  // ── ! shell command (user full authority) ──────────────────────────────────

  private bashRunning = false
  private bashAbort: AbortController | undefined

  /**
   * `!cmd` runs a shell command in the session cwd with user full authority
   * (danger-full-access, pi/Claude Code semantics) and streams its output
   * into a transcript card; the output joins the model context unless the
   * `!!` prefix excluded it. Esc aborts.
   */
  private async runBashCommand(line: string): Promise<void> {
    const parsed = parseBang(line)
    if (parsed === undefined) return
    if (this.bashRunning) {
      this.pushNotice('a shell command is already running — press Esc to cancel it first', 'error')
      return
    }
    const shell = this.ctx.get('shell') as
      | {
          start(spec: {
            command: string
            workdir?: string
            signal?: AbortSignal
            sandboxPolicy?: { mode: string; workspaceRoot: string }
          }): BashProcess
        }
      | undefined
    if (shell === undefined) {
      this.pushNotice('shell service unavailable', 'error')
      return
    }
    const { command, excluded } = parsed
    this.bashRunning = true
    this.bashAbort = new AbortController()
    const card = pushNotice(this.model, `$ ${command}`, 'info')
    this.sync()

    try {
      const process = shell.start({
        command,
        workdir: this.cwd,
        signal: this.bashAbort.signal,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: this.cwd },
      })
      // Drain incremental output until the process settles.
      let output = ''
      let running = true
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        const read = process.readOutput()
        if (read.delta !== '') {
          output += read.delta
          card.text = `$ ${command}${output === '' ? '' : `\n${output}`}`
          this.sync()
        }
        if (process.status !== 'running') running = false
      }
      await process.done
      const read = process.readOutput()
      if (read.delta !== '') output += read.delta
      card.text = `$ ${command}${output === '' ? '' : `\n${output}`}`.trimEnd()
      const exitCode = process.exitCode
      if (exitCode === 0) {
        card.notice = 'info'
      } else {
        card.notice = 'error'
        card.text += `\n[exit ${exitCode ?? process.signal ?? 'killed'}]`
      }
      if (!excluded) {
        // Join the model context without waking the driver (pi's
        // recordBashResult equivalent).
        this.agent.inject(
          createUserMessage({
            content: [{ type: 'text', text: `$ ${command}${output === '' ? '' : `\n${output}`}` }],
            source: { kind: 'user' },
          }),
        )
      }
    } catch (error) {
      card.notice = 'error'
      card.text += `\nfailed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      this.bashRunning = false
      this.bashAbort = undefined
      this.sync()
    }
  }

  // ── @ file attachment ─────────────────────────────────────────────────────

  /** Bare `@` at a token start opens the fuzzy file-attachment picker. */
  private maybeOpenAtPicker(text: string): void {
    if (this.atPickerOpen || this.tui.hasOverlay()) return
    const match = /(?:^|[\s(])@\s*$/.exec(text)
    if (match === null) return
    this.atPickerOpen = true
    void this.openAtPicker().finally(() => {
      this.atPickerOpen = false
    })
  }

  private async openAtPicker(): Promise<void> {
    const files = await this.listWorkspaceFiles()
    if (files.length === 0) {
      this.pushNotice('no files found to attach')
      return
    }
    const picked = await pickFromListWithSearch(this.tui, {
      title: 'Attach file',
      items: files.map((file) => ({ value: file, label: file })),
    })
    if (picked !== undefined) {
      const text = this.editor.getText()
      this.editor.setText(text.replace(/(?:^|[\s(])@\s*$/, ` @${picked} `))
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
  }

  /** Bounded recursive walk over the session cwd through the dsh fs seam. */
  private async listWorkspaceFiles(): Promise<string[]> {
    const fs = this.ctx.get('fs') as
      | {
          resolve(path: string): Promise<{ displayPath: string }>
          listDir(
            target: unknown,
            signal?: AbortSignal,
          ): Promise<
            {
              name: string
              type: 'file' | 'directory' | 'other'
              target: { displayPath: string }
            }[]
          >
        }
      | undefined
    if (fs === undefined) return []
    const results: string[] = []
    const visited = new Set<string>()
    // Build artifacts and VCS metadata never belong in an attach list.
    const ignored = new Set([
      'node_modules',
      '.git',
      '.dsh',
      'lib',
      'dist',
      'build',
      'coverage',
      '.turbo',
      '.next',
      '.cache',
    ])
    let root: unknown
    try {
      root = await fs.resolve(this.cwd)
    } catch {
      return []
    }
    const walk = async (target: unknown, depth: number): Promise<void> => {
      if (depth > 4 || results.length >= 300) return
      let entries
      try {
        entries = await fs.listDir(target)
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= 300) return
        if (entry.type === 'file') {
          const rel = relative(this.cwd, entry.target.displayPath) || entry.name
          if (!visited.has(rel)) {
            visited.add(rel)
            results.push(rel)
          }
        } else if (entry.type === 'directory' && !ignored.has(entry.name)) {
          await walk(entry.target, depth + 1)
        }
      }
    }
    await walk(root, 0)
    return results.sort()
  }

  private async modelCompletions(prefix: string) {
    const llm = this.llm()
    if (llm === undefined) return null
    const routes = await listAllModels(llm)
    const items = routes
      .filter((route) => route.model.startsWith(prefix))
      .map((route) => ({ value: route.model, label: route.model }))
    return items.length > 0 ? items : null
  }

  // ── transcript plumbing ───────────────────────────────────────────────────

  /** Push a UI-side notice into the transcript. */
  pushNotice(text: string, notice: 'info' | 'error' | 'compact' = 'info'): void {
    pushNotice(this.model, text, notice)
    this.sync()
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
      if (view !== undefined) {
        updateView(view, item, this.expandReasoning, this.expandTools)
      }
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

    // Session projections (todo list, token meter) are the authoritative
    // UI read models; fall back to the locally folded counters.
    let tokens = this.model.tokens
    let todos: { done: number; total: number } | undefined
    try {
      const projections = this.ctx.get('sessionProjections') as
        | { snapshot(session: unknown): { values: Record<string, unknown> } }
        | undefined
      const values = projections?.snapshot(this.agent.session).values
      const usage = values?.tokenUsage as
        | { totals?: { uncachedInputTokens: number; outputTokens: number } }
        | undefined
      if (usage?.totals !== undefined) {
        tokens = { input: usage.totals.uncachedInputTokens, output: usage.totals.outputTokens }
      }
      const todoList = values?.todos as { status: string }[] | null | undefined
      if (Array.isArray(todoList)) {
        todos = {
          done: todoList.filter((entry) => entry.status === 'completed').length,
          total: todoList.length,
        }
      }
    } catch {
      // Projections are an optional capability; the folded counters suffice.
    }

    const route = this.currentRoute()
    const effort = this.currentEffort()
    const status: StatusBarData = {
      model: effort !== undefined ? `${route.model}·${effort}` : route.model,
      sessionId: String(this.agent.session.id),
      cwd: basename(this.cwd),
      tokens,
      todos,
      title: this.model.title,
    }
    this.statusBar.update(status)
    this.tui.requestRender()
  }

  private async openModelPicker(): Promise<void> {
    const llm = this.llm()
    if (llm === undefined) {
      this.pushNotice('llm service unavailable', 'error')
      return
    }
    const picked = await pickModel(this.tui, llm, this.currentRoute())
    if (picked !== undefined) await this.applyModel(picked)
  }
}

export function createTui(terminal: import('@earendil-works/pi-tui').Terminal): TUI {
  return new TuiMainScreen(terminal)
}

/** Minimal ShellProcess surface the `!` command consumes. */
interface BashProcess {
  status: 'running' | 'completed' | 'killed'
  exitCode: number | null
  signal: string | null
  readonly done: Promise<void>
  readOutput(): { delta: string; lossy: boolean }
}

/**
 * Tab-restraint wrapper (option B): the editor consults
 * `shouldTriggerFileCompletion` before a forced Tab completion, so returning
 * false for non-path-like tokens makes Tab a no-op on plain words. The
 * inline `/`-command and `@`-mention triggers never pass through this gate.
 */
class PathAwareAutocomplete implements AutocompleteProvider {
  constructor(private readonly inner: AutocompleteProvider) {}

  get triggerCharacters(): string[] | undefined {
    return this.inner.triggerCharacters
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
    const token = before.slice(before.lastIndexOf(' ') + 1)
    return isPathLikeToken(token)
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
    const token = before.slice(before.lastIndexOf(' ') + 1)
    const suggestions = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
    if (suggestions === null) return null
    // Belt and braces: outside slash/@ contexts, only path-like tokens may
    // receive file suggestions.
    if (token.startsWith('/') || token.startsWith('@') || isPathLikeToken(token)) {
      return suggestions
    }
    return null
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: { value: string; label: string; description?: string },
    prefix: string,
  ) {
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }
}
