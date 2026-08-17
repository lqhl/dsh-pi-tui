/**
 * ProcessTerminal that mirrors OSC 52 clipboard writes into the tmux paste
 * buffer and the local OS clipboard (grok's three-route copy). The OSC 52
 * sequence itself is still written to stdout unchanged, so terminals that
 * natively handle OSC 52 (Ghostty, iTerm2, …) keep working.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import { decodeOsc52 } from '../core/clipboard.js'

const DEBUG = process.env.PI_TUI_CLIPBOARD_DEBUG === '1'

export class ClipboardTerminal extends ProcessTerminal {
  override write(data: string): void {
    super.write(data)
    if (!data.includes('\x1b]52;')) return
    const texts = decodeOsc52(data)
    debug(`write: OSC 52 detected, ${texts.length} payload(s)`)
    for (const text of texts) {
      debug(`mirroring ${text.length} chars`)
      void this.mirrorToClipboard(text)
    }
  }

  /** Best-effort async mirror; never rejects or blocks the render loop. */
  private async mirrorToClipboard(text: string): Promise<void> {
    const jobs: Promise<void>[] = []
    // tmux paste buffer via the socket — works regardless of set-clipboard.
    if (process.env.TMUX !== undefined) {
      jobs.push(pipeTo('tmux', ['load-buffer', '-'], text))
    }
    // Local OS clipboard (native route).
    if (process.platform === 'darwin') {
      jobs.push(pipeTo('pbcopy', [], text))
    } else if (process.platform === 'win32') {
      jobs.push(pipeTo('clip', [], text))
    } else {
      jobs.push(pipeTo('xclip', ['-selection', 'clipboard'], text))
    }
    await Promise.all(jobs)
  }
}

/** Spawn a clipboard command, feed `text` on stdin, and settle quietly. */
function pipeTo(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch (error) {
      debug(`spawn ${command} threw: ${String(error)}`)
      resolve()
      return
    }
    child.once('error', (error) => debug(`spawn ${command} error: ${String(error)}`))
    child.once('close', (code) => debug(`spawn ${command} close: code=${code ?? 'null'}`))
    child.stdin?.once('error', (error) => debug(`spawn ${command} stdin error: ${String(error)}`))
    child.stdin?.end(text)
  })
}

function debug(message: string): void {
  if (!DEBUG) return
  try {
    const path = join(homedir(), '.pi', 'agent', 'clipboard-debug.log')
    mkdirSync(join(homedir(), '.pi', 'agent'), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Debug logging is best effort.
  }
}
