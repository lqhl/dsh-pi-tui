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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, rm, writeFile } from 'node:fs/promises'
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
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
import { runRgFiles, shouldShowPath } from '../core/files.js'
import {
  ctrlC,
  cycleEffort,
  isPathLikeToken,
  parseBang,
  parseSlash,
  type ExitArm,
} from '../core/keys.js'
import { editorTheme, style } from './theme.js'
import { createView, StatusBar, ToolCardView, updateView, type StatusBarData } from './views.js'
import { listAllModels, pickModel, type LlmRuntimeLike, type ModelRoute } from './model-picker.js'
import { forkSession, listSessions, resolveAgent, type ResolvedAgent } from '../core/session.js'
import { pickFromList, pickFromListWithSearch } from './overlays.js'

export interface ChatScreenOptions {
  ctx: Context
  tui: TUI
  agent: Agent
  config: {
    provider?: string
    model?: string
    cwd?: string
    preset?: string
  }
  onQuit: () => void
  /** Called after a successful in-session agent switch (new/fork/resume). */
  onAgentSwitch?: (resolved: ResolvedAgent) => void
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
  private agent: Agent
  private readonly config: ChatScreenOptions['config']
  private readonly cwd: string
  private readonly commands: CommandRuntime | undefined
  private readonly onAgentSwitch: ((resolved: ResolvedAgent) => void) | undefined
  private model: ChatModel = createModel()
  private readonly messages = new Container()
  private readonly statusBar = new StatusBar()
  private readonly editor: Editor
  /** One-per-agent mutable model selection (grok/web pattern; install once per agent). */
  private readonly selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  private disposeSelection: (() => void) | undefined
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
    this.onAgentSwitch = options.onAgentSwitch

    this.seedSelection()
    this.seedSelection()
    this.disposeSelection = installModelSelection(this.agent.ctx, this.selection)

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
      { name: 'new', description: 'Start a fresh session' },
      { name: 'fork', description: 'Fork this session at its current end' },
      { name: 'resume', description: 'List sessions / reopen one' },
      { name: 'tree', description: 'Subagent session tree' },
      { name: 'model', description: 'Switch model', getArgumentCompletions: (prefix) => this.modelCompletions(prefix) },
      { name: 'thinking', description: 'Set thinking effort (off/high/max)' },
      { name: 'skills', description: 'List user-invocable skills' },
      { name: 'agents', description: 'List live subagents' },
      { name: 'jobs', description: 'List background jobs' },
      { name: 'export', description: 'Write this transcript to a markdown file' },
      { name: 'rename', description: 'Rename this session' },
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
      if (matchesKey(data, 'ctrl+r')) {
        void this.cmdHistorySearch()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+z')) {
        this.suspend()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+g')) {
        void this.externalEditor()
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

  private isBusy(): boolean {
    return this.isWorking() || this.bashRunning
  }

  /** The session id the screen currently renders. */
  get currentSessionId(): string {
    return String(this.agent.session.id)
  }

  ownsSession(id: unknown): boolean {
    return id === this.agent.session.id || String(id) === String(this.agent.session.id)
  }

  /**
   * Seed the model selection so every step has a route, including RESUMED
   * agents (whose creation never saw our agentOptions): the persisted
   * request header wins, then the row config, then the harness defaults.
   */
  private seedSelection(): void {
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
  }

  /**
   * Rebind the screen to another live agent (new/fork/resume): tear down the
   * old per-agent selection install, reset the transcript, reinstall and
   * reseed the selection, replay the durable log, and repaint.
   */
  async switchAgent(next: Agent): Promise<void> {
    if (next === this.agent) return
    if (this.isBusy()) {
      this.pushNotice('cannot switch sessions while work is running (Esc to interrupt)', 'error')
      return
    }
    this.disposeSelection?.()
    this.agent = next
    this.model = createModel()
    this.views.clear()
    this.messages.clear()
    if (this.workingLoader !== undefined) {
      this.workingLoader.stop()
      this.workingLoader = undefined
    }
    this.seedSelection()
    this.disposeSelection = installModelSelection(this.agent.ctx, this.selection)
    for (const event of next.session.events) {
      this.handleEvent(event)
    }
    this.tui.terminal.setTitle(`dsh-pi-tui · ${basename(this.cwd)}`)
    this.sync()
  }

  /** Switch and notify the app layer (which owns old-handle disposal). */
  private async commitSwitch(resolved: ResolvedAgent): Promise<void> {
    await this.switchAgent(resolved.agent)
    this.onAgentSwitch?.(resolved)
  }

  // ── session management commands ────────────────────────────────────────────

  private sessionOptions() {
    const route = this.currentRoute()
    return {
      provider: route.provider,
      model: route.model,
    }
  }

  private sessionMeta() {
    return {
      cwd: this.cwd,
      ...(this.config.preset !== undefined ? { agentPreset: this.config.preset } : {}),
    }
  }

  private async cmdNew(): Promise<void> {
    if (this.isBusy()) {
      this.pushNotice('cannot switch sessions while work is running (Esc to interrupt)', 'error')
      return
    }
    try {
      const resolved = await resolveAgent(
        this.ctx,
        undefined,
        this.sessionOptions(),
        this.sessionMeta(),
      )
      await this.commitSwitch(resolved)
      this.pushNotice(`new session ${this.currentSessionId.slice(0, 8)}`)
    } catch (error) {
      this.pushNotice(`/new failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  private async cmdFork(): Promise<void> {
    if (this.isBusy()) {
      this.pushNotice('cannot fork while work is running (Esc to interrupt)', 'error')
      return
    }
    try {
      const resolved = await forkSession(
        this.ctx,
        this.agent,
        this.sessionOptions(),
        this.sessionMeta(),
      )
      await this.commitSwitch(resolved)
      this.pushNotice(`forked → ${this.currentSessionId.slice(0, 8)} (history kept, lineage recorded)`)
    } catch (error) {
      this.pushNotice(`/fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  private async cmdResume(raw: string): Promise<void> {
    if (this.isBusy()) {
      this.pushNotice('cannot switch sessions while work is running (Esc to interrupt)', 'error')
      return
    }
    let target = raw.trim()
    if (target === '') {
      const headers = await listSessions(this.ctx)
      if (headers.length === 0) {
        this.pushNotice('no persisted sessions')
        return
      }
      target = (await pickFromListWithSearch(this.tui, {
        title: 'Resume session',
        items: headers.map((header) => ({
          value: String(header.id),
          label: `${basename(header.cwd ?? '')} · ${String(header.id).slice(0, 8)}`,
          description: new Date(header.createdAt).toLocaleString(),
        })),
      })) ?? ''
    }
    if (target === '') return
    try {
      const resolved = await resolveAgent(
        this.ctx,
        target,
        this.sessionOptions(),
        this.sessionMeta(),
      )
      await this.commitSwitch(resolved)
      this.pushNotice(`resumed ${this.currentSessionId.slice(0, 8)}`)
    } catch (error) {
      this.pushNotice(`/resume failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  private async cmdTree(): Promise<void> {
    const subs = this.ctx.get('subagents') as
      | {
          listDescendants(
            root: unknown,
            signal?: AbortSignal,
          ): Promise<
            readonly { id: string; depth: number; mode: string; activity: string; hasChildren?: boolean }[]
          >
        }
      | undefined
    if (subs === undefined) {
      this.pushNotice('subagent service unavailable', 'error')
      return
    }
    const nodes = await subs.listDescendants(this.agent.session.id).catch(() => [])
    if (nodes.length === 0) {
      this.pushNotice('no subagent sessions under this root')
      return
    }
    const picked = await pickFromListWithSearch(this.tui, {
      title: 'Session tree',
      items: nodes.map((node) => ({
        value: node.id,
        label: `${'  '.repeat(Math.min(node.depth, 6))}${node.mode === 'continuable' ? '◈' : '◦'} ${node.id.slice(0, 8)}`,
        description: `${node.activity}${node.hasChildren === true ? ' · has children' : ''}`,
      })),
    })
    if (picked !== undefined) {
      const resolved = await resolveAgent(this.ctx, picked, this.sessionOptions(), this.sessionMeta())
      await this.commitSwitch(resolved)
    }
  }

  private async cmdAgents(): Promise<void> {
    const subs = this.ctx.get('subagents') as
      | {
          listChildren(
            parent: unknown,
            signal?: AbortSignal,
          ): Promise<
            readonly { id: string; mode: string; activity: string; hasChildren?: boolean }[]
          >
        }
      | undefined
    if (subs === undefined) {
      this.pushNotice('subagent service unavailable', 'error')
      return
    }
    const nodes = await subs.listChildren(this.agent.session.id).catch(() => [])
    if (nodes.length === 0) {
      this.pushNotice('no live subagents')
      return
    }
    await pickFromListWithSearch(this.tui, {
      title: 'Subagents',
      items: nodes.map((node) => ({
        value: node.id,
        label: `${node.mode === 'continuable' ? '◈' : '◦'} ${node.id.slice(0, 8)}`,
        description: `${node.activity}${node.hasChildren === true ? ' · has children' : ''}`,
      })),
    })
  }

  private async cmdJobs(): Promise<void> {
    const jobs = this.ctx.get('jobs') as
      | { list(caller?: unknown): readonly { id: string; kind: string; label: string; status: string }[] }
      | undefined
    if (jobs === undefined) {
      this.pushNotice('jobs service unavailable', 'error')
      return
    }
    const snapshots = jobs.list(this.agent)
    if (snapshots.length === 0) {
      this.pushNotice('no background jobs')
      return
    }
    await pickFromListWithSearch(this.tui, {
      title: 'Background jobs',
      items: snapshots.map((job) => ({
        value: job.id,
        label: `${job.id} · ${job.label || job.kind}`,
        description: job.status,
      })),
    })
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
    if (parsed.name === 'new') return this.cmdNew()
    if (parsed.name === 'fork') return this.cmdFork()
    if (parsed.name === 'resume') return this.cmdResume(parsed.raw)
    if (parsed.name === 'tree') return this.cmdTree()
    if (parsed.name === 'agents') return this.cmdAgents()
    if (parsed.name === 'jobs') return this.cmdJobs()
    if (parsed.name === 'export') return this.cmdExport()
    if (parsed.name === 'rename') return this.cmdRename(parsed.raw.trim())
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

  private async cmdExport(): Promise<void> {
    const fs = this.ctx.get('fs') as
      | { resolve(path: string): Promise<unknown>; writeText(target: unknown, content: string): Promise<void> }
      | undefined
    if (fs === undefined) {
      this.pushNotice('fs service unavailable', 'error')
      return
    }
    const lines: string[] = []
    for (const item of this.model.items) {
      if (item.kind === 'user') {
        lines.push(`## User\n\n${item.text}\n`)
      } else if (item.kind === 'assistant') {
        lines.push(`## Assistant\n\n${item.text}\n`)
      } else if (item.kind === 'reasoning') {
        lines.push(`<details><summary>Thinking</summary>\n\n${item.text}\n</details>\n`)
      } else if (item.kind === 'tool') {
        lines.push(
          `### Tool: ${item.tool?.name ?? ''}\n\n\`\`\`\n${item.tool?.argsPreview ?? ''}\n\`\`\`\n\n${item.tool?.resultFull ?? item.tool?.resultPreview ?? ''}\n`,
        )
      } else if (item.kind === 'notice') {
        lines.push(`> ${item.text}\n`)
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = `${this.cwd}/dsh-pi-tui-export-${stamp}-${this.currentSessionId.slice(0, 8)}.md`
    try {
      const target = await fs.resolve(path)
      await fs.writeText(target, lines.join('\n'))
      this.pushNotice(`exported → ${path}`)
    } catch (error) {
      this.pushNotice(`export failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  private async cmdRename(title: string): Promise<void> {
    if (title === '') {
      this.pushNotice('usage: /rename <title>', 'error')
      return
    }
    const service = this.ctx.get('sessionTitle') as
      | { rename(session: unknown, title: string): void }
      | undefined
    if (service === undefined) {
      this.pushNotice('session title service unavailable', 'error')
      return
    }
    try {
      service.rename(this.agent.session, title)
      this.model.title = title
      this.sync()
      this.pushNotice(`session renamed: ${title}`)
    } catch (error) {
      this.pushNotice(`rename failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
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
        '  Ctrl+O     toggle full tool output / diff',
        '  Ctrl+L     model picker · Shift+Tab cycle thinking',
        '  Ctrl+R     search message history',
        '  Ctrl+Z     suspend to background',
        '  Ctrl+G     edit input in $EDITOR',
        '  Tab        complete paths · / slash commands · @ attach files',
        'commands: /new /fork /resume /tree /model /thinking /skills /agents /jobs /export /rename /hotkeys',
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
      shouldShow: (query, item) => shouldShowPath(query, item.label),
    })
    if (picked !== undefined) {
      const text = this.editor.getText()
      this.editor.setText(text.replace(/(?:^|[\s(])@\s*$/, ` @${picked} `))
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
  }

  private rgCache: string[] | undefined

  /**
   * Enumerate attachable files. Primary source: one ripgrep run with the
   * standard ignore convention (.gitignore/.ignore nested + unconditional
   * excludes); falls back to the ctx.fs walker when rg is unavailable.
   */
  private async listWorkspaceFiles(): Promise<string[]> {
    if (this.rgCache !== undefined) return this.rgCache
    const viaRg = await this.tryRgListing()
    this.rgCache = viaRg.length > 0 ? viaRg : await this.walkFallback()
    return this.rgCache
  }

  private async tryRgListing(): Promise<string[]> {
    try {
      const { rgPath } = await import('@vscode/ripgrep')
      return await runRgFiles(rgPath, this.cwd)
    } catch {
      return []
    }
  }

  /** Bounded recursive walk through the dsh fs seam (rg-unavailable fallback). */
  private async walkFallback(): Promise<string[]> {
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
      '__pycache__',
      '.svn',
      '.hg',
      '.bzr',
      '.jj',
      '.sl',
    ])
    const junkFiles = new Set(['.DS_Store', 'Thumbs.db'])
    let root: unknown
    try {
      root = await fs.resolve(this.cwd)
    } catch {
      return []
    }
    const walk = async (target: unknown, depth: number): Promise<void> => {
      if (depth > 8 || results.length >= 5000) return
      let entries
      try {
        entries = await fs.listDir(target)
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= 5000) return
        if (entry.type === 'file') {
          if (junkFiles.has(entry.name) || entry.name.endsWith('.pyc')) continue
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
    if (event.type === 'tool/result') void this.resolveImages(event)
    this.sync()
  }

  /**
   * Resolve image-attachment refs from read_image results into inline
   * base64 for the tool card (best effort; the text envelope still shows).
   */
  private async resolveImages(event: SessionEvent): Promise<void> {
    const callId = (event.data as { message?: { source?: { callId?: string } } }).message
      ?.source?.callId
    if (callId === undefined) return
    const card = this.model.items.find(
      (item) => item.kind === 'tool' && item.tool?.callId === callId,
    )
    if (card === undefined || card.tool?.imageRefs === undefined) return
    const attachments = this.ctx.get('attachments') as
      | { readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> }
      | undefined
    if (attachments === undefined) return
    const images: { base64: string; mediaType: string }[] = []
    for (const ref of card.tool.imageRefs) {
      try {
        const stored = await attachments.readImage(ref)
        images.push({
          base64: Buffer.from(stored.data).toString('base64'),
          mediaType: ref.mediaType,
        })
      } catch {
        // Resolution is best effort.
      }
    }
    if (images.length === 0) return
    const view = this.views.get(card.id)
    if (view instanceof ToolCardView) {
      view.setImages(images)
      this.sync()
    }
  }

  /** Ctrl+Z: stop the renderer, suspend the process, redraw on SIGCONT. */
  private suspend(): void {
    this.tui.stop()
    process.once('SIGCONT', () => {
      this.tui.start()
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    })
    process.kill(process.pid, 'SIGTSTP')
  }

  /** Ctrl+G: edit the input in $EDITOR/$VISUAL (user full authority). */
  private async externalEditor(): Promise<void> {
    if (this.isBusy()) {
      this.pushNotice('cannot open the editor while work is running', 'error')
      return
    }
    const editor = process.env.VISUAL ?? process.env.EDITOR
    if (editor === undefined || editor === '') {
      this.pushNotice('set $EDITOR (or $VISUAL) to use the external editor', 'error')
      return
    }
    const shell = this.ctx.get('shell') as
      | { run(req: unknown): Promise<{ exitCode: number | null }> }
      | undefined
    if (shell === undefined) {
      this.pushNotice('shell service unavailable', 'error')
      return
    }
    const tmp = join(tmpdir(), `dsh-pi-tui-${Date.now()}.md`)
    await writeFile(tmp, this.editor.getText(), 'utf8')
    this.tui.stop()
    try {
      await shell.run({
        command: `${editor} ${JSON.stringify(tmp)}`,
        workdir: this.cwd,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: this.cwd },
        timeoutMs: 30 * 60 * 1000,
      })
      const text = await readFile(tmp, 'utf8')
      this.editor.setText(text)
    } finally {
      try {
        await rm(tmp, { force: true })
      } catch {
        // Best effort.
      }
      this.tui.start()
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
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
    let planActive: boolean | undefined
    let goalPhase: string | undefined
    let contextPct: number | undefined
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
      const plan = values?.plan as { active?: boolean } | undefined
      planActive = plan?.active === true
      const goalValue = values?.goal as
        | { goal?: { phase?: string } }
        | null
        | undefined
      goalPhase = goalValue?.goal?.phase
      const pressure = values?.contextPressure as
        | { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
        | undefined
      if (pressure?.contextWindow !== undefined && pressure.contextWindow > 0) {
        const pressureTokens = pressure.projectedTokens ?? pressure.pressureTokens
        if (pressureTokens !== undefined) {
          contextPct = Math.min(100, Math.round((100 * pressureTokens) / pressure.contextWindow))
        }
      }
    } catch {
      // Projections are an optional capability; the folded counters suffice.
    }

    // Live background-job count (process-local snapshot, cheap per event).
    let jobsRunning: number | undefined
    try {
      const jobs = this.ctx.get('jobs') as
        | { list(caller?: unknown): readonly { status: string }[] }
        | undefined
      const snapshots = jobs?.list(this.agent)
      if (snapshots !== undefined) {
        const running = snapshots.filter((job) => job.status === 'running').length
        jobsRunning = running > 0 ? running : undefined
      }
    } catch {
      // Jobs are optional.
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
      preset: this.config.preset,
      planActive,
      goalPhase,
      contextPct,
      jobsRunning,
    }
    this.statusBar.update(status)
    this.tui.requestRender()
  }

  /** Fuzzy search over the transcript; picking a message loads it into the
   * editor for re-sending or editing. */
  private async cmdHistorySearch(): Promise<void> {
    const entries = this.model.items
      .filter((item) => item.kind === 'user' || item.kind === 'assistant')
      .map((item) => ({
        id: String(item.id),
        text: item.text,
        label: `${item.kind === 'user' ? '❯ ' : ''}${item.text.replace(/\s+/g, ' ').slice(0, 90)}`,
        kind: item.kind,
      }))
    if (entries.length === 0) {
      this.pushNotice('no messages yet')
      return
    }
    const picked = await pickFromListWithSearch(this.tui, {
      title: 'Search history',
      items: entries.map((entry) => ({
        value: entry.id,
        label: entry.label,
        description: entry.kind,
      })),
    })
    if (picked !== undefined) {
      const entry = entries.find((candidate) => candidate.id === picked)
      if (entry !== undefined) {
        this.editor.setText(entry.text)
        this.tui.setFocus(this.editor)
        this.tui.requestRender()
      }
    }
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
