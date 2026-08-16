/**
 * App argument parsing over `ctx.cmdlineArgs.get()`.
 *
 * `dsh --profile pi-tui --resume <id>` hands `['--resume', '<id>']` to the
 * booted profile; the launcher consumes its own flags first.
 */
export interface PiTuiArgs {
  /** Session id to resume (from `--resume <id>`). */
  resumeId?: string
  /** `--resume` without a value: pick from the persisted-session list. */
  pickSession: boolean
  /** Agent preset id (from `--preset <id>`). */
  preset?: string
  /** `--preset` without a value: pick from the preset roster. */
  pickPreset: boolean
  /** `--help` / `-h`: print usage and exit. */
  help: boolean
  /** Unrecognized positional/flags, reported as a usage error. */
  unknown: string[]
}

export function parseArgs(argv: readonly string[]): PiTuiArgs {
  const args: PiTuiArgs = { pickSession: false, pickPreset: false, help: false, unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--resume' || token === '-r') {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        args.resumeId = value
        i += 1
      } else {
        args.pickSession = true
      }
      continue
    }
    if (token === '--preset' || token === '-p') {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        args.preset = value
        i += 1
      } else {
        args.pickPreset = true
      }
      continue
    }
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    args.unknown.push(token)
  }
  return args
}

export const USAGE = `dsh-pi-tui — pi-tui terminal front door for DeepSeek Harness

Usage:
  dsh --profile pi-tui                 start a fresh session
  dsh --profile pi-tui --resume <id>   reopen a persisted session
  dsh --profile pi-tui --resume        pick a persisted session from a list
  dsh --profile pi-tui --preset <id>   choose an agent preset (standard/minimal/code…)
  dsh --profile pi-tui --preset        pick a preset from the roster
  dsh --profile pi-tui --help          this help

Keys:
  Esc        interrupt · cancel autocomplete
  Ctrl+C     running→interrupt · text→clear · empty→again exits
  Ctrl+D     exit when the editor is empty
  Ctrl+T     toggle thinking display
  Ctrl+O     toggle full tool output
  Ctrl+L     model picker · Ctrl+X cycle thinking
  Ctrl+R     search message history · Shift+Tab cycle mode
  Ctrl+Z     suspend to background
  Tab        complete paths · / slash commands · @ attach files

Commands:
  /new                    start a fresh session
  /fork                   fork this session at its current end
  /resume [query]         list sessions / reopen one
  /tree                   subagent session tree
  /model [query]          switch model (picker without a query)
  /thinking off|high|max  set thinking effort (next step)
  /skills                 list user-invocable skills
  /agents                 list live subagents
  /jobs                   list background jobs
  /export                 write this transcript to a markdown file
  /permission <ws|ro|danger>  switch sandbox mode
  /hotkeys                this key table
  /compact /goal /plan /feedback   official dsh commands`
