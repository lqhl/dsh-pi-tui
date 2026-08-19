/**
 * dsh-pi-tui plugin entry: the pi-tui interactive terminal front door.
 *
 * M0 surface: name/inject/Config/apply at the canonical `src/index.ts`
 * location. The real app (session manager, event mapper, chat view) lands
 * in `./app.js` behind a dynamic import during M1, mirroring how cc-tui
 * keeps the entry plain for the Loader.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'pi-tui'
// `workspaceRegistry` is a web-only service that this bundle's
// cordis.patch.yml adds to the tree (see its workspace/storage rows).
// Injecting it guarantees the service both exists AND has finished its init
// before `apply`, so the TUI's per-creation attach runs against a ready
// registry. The hard dependency is safe only because the plugin ships as a
// bundle with that patch — a bare plugin row without those rows would fail
// activation waiting for this service.
export const inject = ['agents', 'cmdlineArgs', 'workspaceRegistry']

/** dsh-pi-tui plugin configuration (row config in cordis.patch.yml). */
export interface Config {
  /** Existing session to attach; a fresh session is created when absent. */
  sessionId?: string
  /** LLM provider route; the harness deepseek-official route by default. */
  provider?: string
  /** Model override passed to the agent (adapter default when absent). */
  model?: string
  /** Session working directory; defaults to the invoking directory. */
  cwd?: string
  /**
   * Trash the live session on quit when it has no human prompt.
   * Default true; set false to keep empty sessions.
   */
  discardEmptyOnQuit?: boolean
}

export const Config: Schema<Config> = Schema.object({
  sessionId: Schema.string().required(false),
  provider: Schema.string().required(false),
  model: Schema.string().required(false),
  cwd: Schema.string().required(false),
  discardEmptyOnQuit: Schema.boolean().default(true).required(false),
})

/**
 * Boot the TUI, keep it mounted until the user quits (Ctrl+C) or the tree
 * is disposed, then hand the process back.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { apply: piTuiApply } = await import('./app.js')
  return piTuiApply(ctx, config)
}
