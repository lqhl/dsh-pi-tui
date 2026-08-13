/**
 * dsh-pi-tui app: boot the pi-tui rendering loop over dsh services.
 *
 * Flow: parse app args → resolve or create the agent (session picker when
 * `--resume` has no id) → mount the ChatScreen → replay the durable
 * session log → subscribe to live `session/event` → quit on Ctrl+C by
 * disposing the whole tree (bounded fallback, cc-tui semantics).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ProcessTerminal, TuiMainScreen, type TUI } from '@earendil-works/pi-tui'
import { parseArgs, USAGE } from './args.js'
import { listSessions, resolveAgent } from './core/session.js'
import { pickSession } from './ui/session-picker.js'
import { confirmApproval, askQuestions } from './ui/overlays.js'
import { ChatScreen } from './ui/chat.js'

export interface AppConfig {
  sessionId?: string
  provider?: string
  model?: string
  cwd?: string
}

/**
 * Mount the TUI app on the plugin context.
 */
export async function apply(ctx: Context, config: AppConfig): Promise<void> {
  if (process.env.PI_TUI_DEBUG !== undefined) {
    console.error('[pi-tui debug] config =', JSON.stringify(config))
  }
  const cmdline = ctx.get('cmdlineArgs') as { get(): readonly string[] } | undefined
  const args = parseArgs(cmdline?.get() ?? [])

  // YAML scalars like `undefined` arrive as the string "undefined"; treat
  // them (and empty strings) as absent.
  const clean = (value: string | undefined): string | undefined =>
    value === undefined || value === 'undefined' || value === '' ? undefined : value
  const sessionConfig = clean(config.sessionId)
  const provider = clean(config.provider)
  const model = clean(config.model)

  // Provider/model route: explicit row config wins; otherwise inherit the
  // harness's default-model selection (settings.yaml), matching the web app.
  const agentDefaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
    | undefined
  const defaultSelection = agentDefaultModel?.currentSelection()
  const effectiveProvider = provider ?? defaultSelection?.provider
  const effectiveModel = model ?? defaultSelection?.model
  if (args.help) {
    console.log(USAGE)
    disposeRootAndExit(ctx, 0)
    return
  }
  if (args.unknown.length > 0) {
    throw new Error(`pi-tui: unknown arguments: ${args.unknown.join(' ')} (see --help)`)
  }
  if (!process.stdout.isTTY) {
    throw new Error('dsh-pi-tui needs an interactive terminal (stdout is not a TTY)')
  }

  const terminal = new ProcessTerminal()
  const tui: TUI = new TuiMainScreen(terminal)
  tui.start()

  const agentOptions = { provider: effectiveProvider, model: effectiveModel }
  const meta = { cwd: config.cwd ?? process.cwd() }

  // Session picker when `--resume` is given without an id.
  let sessionId = args.resumeId ?? sessionConfig
  if (sessionId === undefined && args.pickSession) {
    const headers = await listSessions(ctx)
    sessionId = await pickSession(tui, headers)
  }

  const { agent } = await resolveAgent(ctx, sessionId, agentOptions, meta)

  // ── human-interaction seams ────────────────────────────────────────────────
  // Approval waterfall answerer: answer permission questions for OUR agent
  // only; every other request continues down the chain.
  ctx.on('approval/request', (request, next) => {
    if (request.agent.id !== agent.id) return next()
    return confirmApproval(tui, request)
  })

  // ask_user_question provider: the TUI renders the questionnaire itself.
  const userQuestions = ctx.get('userQuestions') as
    | { registerProvider(provider: { ask(request: unknown): Promise<unknown> }): () => void }
    | undefined
  userQuestions?.registerProvider({
    ask: (request) => askQuestions(tui, request as Parameters<typeof askQuestions>[1]),
  })

  const screen = new ChatScreen({
    ctx,
    tui,
    agent,
    config: {
      provider: effectiveProvider,
      model: effectiveModel,
      cwd: config.cwd,
    },
    onQuit: () => {
      disposeRootAndExit(ctx, 0)
    },
  })

  // Replay the durable log first so the transcript paints on the first
  // frame; only then subscribe, so no event is folded twice.
  for (const event of agent.session.events) {
    screen.handleEvent(event)
  }

  ctx.on('session/event', (session, event) => {
    if (session.id === agent.id) {
      screen.handleEvent(event)
    }
  })

  // If the surrounding tree goes down (reload, teardown), take the TUI
  // with it: stop the renderer and drain queued stdin so kitty key-release
  // bytes don't leak to the parent shell.
  ctx.effect(() => () => {
    tui.stop()
    void terminal.drainInput(1000, 50)
  })
}

/**
 * Dispose the whole application tree before process exit, with a bounded
 * fallback (mirrors cc-tui's disposeRootAndExit semantics).
 */
function disposeRootAndExit(ctx: Context, code: number): void {
  const timer = setTimeout(() => process.exit(code), 5000)
  timer.unref()
  void ctx.root.fiber.dispose().then(
    () => {
      clearTimeout(timer)
      process.exit(code)
    },
    () => {
      clearTimeout(timer)
      process.exit(code)
    },
  )
}
