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
  /** `--help` / `-h`: print usage and exit. */
  help: boolean
  /** Unrecognized positional/flags, reported as a usage error. */
  unknown: string[]
}

export function parseArgs(argv: readonly string[]): PiTuiArgs {
  const args: PiTuiArgs = { pickSession: false, help: false, unknown: [] }
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
  dsh --profile pi-tui --help          this help

Keys:
  Ctrl+C      quit
  Ctrl+O      toggle expanded reasoning blocks`
