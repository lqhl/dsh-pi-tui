/**
 * Boot-time session picker: a centered overlay listing persisted sessions
 * (newest first) with a leading "new session" entry. Resolves the picked
 * session id, or undefined when cancelled.
 *
 * The overlay content must be a single component that implements
 * `handleInput` (pi-tui routes focused-overlay input to the content root,
 * and a plain Container drops it) — hence the forwarding wrapper, matching
 * pi's own ModelSelectorComponent pattern.
 */
import { basename } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { Container, SelectList, Text, type TUI } from '@earendil-works/pi-tui'
import type { SessionSummary } from '../core/session.js'
import { shortSessionId } from '../core/ids.js'
import { selectListTheme, style } from './theme.js'

/** Label for a stored session that holds no conversation at all. */
const EMPTY_LABEL = '(empty session)'

class SessionPicker extends Container {
  private readonly list: SelectList

  constructor(title: string, items: { value: string; label: string; description: string }[]) {
    super()
    this.addChild(new Text(style.accent(title), 1, 0))
    this.list = new SelectList(items, Math.min(12, Math.max(3, items.length)), selectListTheme)
    this.addChild(this.list)
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  set onSelect(callback: (value: string) => void) {
    this.list.onSelect = (item) => callback(item.value)
  }

  set onCancel(callback: () => void) {
    this.list.onCancel = callback
  }
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function pickSession(
  tui: TUI,
  headers: readonly SessionHeader[],
  summaries?: ReadonlyMap<string, SessionSummary>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const items = [
      { value: '', label: '＋ New session', description: 'start fresh' },
      ...headers.map((header) => {
        const id = String(header.id)
        const summary = summaries?.get(id)
        const title = summary?.title
        const empty = summary !== undefined && !summary.hasContent
        const short = shortSessionId(id)
        const where = basename(header.cwd ?? '') || `session ${short}`
        return {
          value: id,
          label: title ?? (empty ? EMPTY_LABEL : where),
          description: `${short} · ${formatTime(header.createdAt)} · ${where}${
            empty ? ' · resumes empty' : ''
          }`,
        }
      }),
    ]
    const picker = new SessionPicker('Resume a session', items)
    const handle = tui.showOverlay(picker, { width: '70%', maxHeight: '60%' })
    picker.onSelect = (value) => {
      handle.hide()
      resolve(value === '' ? undefined : value)
    }
    picker.onCancel = () => {
      handle.hide()
      resolve(undefined)
    }
    tui.requestRender()
  })
}
