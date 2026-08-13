/**
 * dsh-pi-tui app: the pi-tui rendering loop over dsh services.
 *
 * M0 scope: prove the mount chain — boot a TUI, render a static surface,
 * quit cleanly on Ctrl+C. M1 replaces the static surface with the live
 * chat view (session/event → components) and agent followup submission.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ProcessTerminal,
  TUI,
  Text,
  TruncatedText,
  matchesKey,
} from '@mariozechner/pi-tui'

/**
 * Apply the TUI app on the plugin context.
 *
 * The returned promise settles only when the TUI is torn down; while it is
 * pending, the cordis fiber stays mounted and the raw-mode stdin keeps the
 * process alive. Quitting requests `ctx.root.fiber.dispose()`, which
 * reaches our dispose listener, stops the TUI, drains stdin, and resolves
 * the promise (mirroring cc-tui's disposeRootAndExit semantics).
 */
export async function apply(ctx: Context, _config: unknown): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error(
      'dsh-pi-tui needs an interactive terminal (stdout is not a TTY)',
    )
  }

  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)

  tui.addChild(new Text('hello dsh-pi-tui'))
  tui.addChild(new Text('M0 scaffold — the live chat view lands in M1.'))
  tui.addChild(new TruncatedText('Ctrl+C to quit', 0, 0))

  let stopped = false
  tui.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+c')) {
      void ctx.root.fiber.dispose()
    }
  })

  ctx.on('dispose', () => {
    if (!stopped) {
      stopped = true
      tui.stop()
    }
  })

  tui.start()

  await new Promise<void>((resolve) => {
    ctx.on('dispose', () => {
      // Drain queued stdin so kitty key-release bytes don't leak to the
      // parent shell, then hand the process back to the launcher.
      void terminal.drainInput(1000, 50).finally(resolve)
    })
  })
}
