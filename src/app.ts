/**
 * dsh-pi-tui app: the pi-tui rendering loop over dsh services.
 *
 * M0 scope: prove the mount chain — boot a TUI, render a static surface,
 * quit cleanly on Ctrl+C. M1 replaces the static surface with the live
 * chat view (session/event → components) and agent followup submission.
 *
 * Lifecycle mirrors cc-tui: apply() returns once the TUI is up; the raw
 * mode stdin keeps the process alive. Ctrl+C requests the whole tree's
 * disposal, whose effect cleanup stops the TUI and drains stdin, and the
 * bounded fallback guarantees the process exits.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ProcessTerminal,
  TuiMainScreen,
  Text,
  TruncatedText,
  matchesKey,
  type TUI,
} from '@earendil-works/pi-tui'

/**
 * Mount the TUI app on the plugin context.
 */
export async function apply(ctx: Context, _config: unknown): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error(
      'dsh-pi-tui needs an interactive terminal (stdout is not a TTY)',
    )
  }

  const terminal = new ProcessTerminal()
  const tui: TUI = new TuiMainScreen(terminal)

  tui.addChild(new Text('hello dsh-pi-tui'))
  tui.addChild(new Text('M0 scaffold — the live chat view lands in M1.'))
  tui.addChild(new TruncatedText('Ctrl+C to quit', 0, 0))

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      disposeRootAndExit(ctx, 0)
      return { consume: true }
    }
    return undefined
  })

  // If the surrounding tree goes down (reload, teardown), take the TUI
  // with it: stop the renderer and drain queued stdin so kitty key-release
  // bytes don't leak to the parent shell.
  ctx.effect(() => () => {
    tui.stop()
    void terminal.drainInput(1000, 50)
  })

  tui.start()
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
