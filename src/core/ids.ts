/**
 * Session-id presentation helpers shared by every surface that shows a short
 * id (status bar, pickers, notices, export filenames).
 */

/** Constant prefix the store adds to ids it mints itself (`session-<uuid>`). */
const STORE_PREFIX = 'session-'

/**
 * Short, human-scannable form of a session id.
 *
 * TUI-created sessions carry a bare UUID, whose first 8 characters identify
 * them. Store-minted ids are `session-<uuid>`, where the first 8 characters
 * are the constant prefix — every such row rendered as a useless `session-`.
 * Skip the prefix first, then take 8 characters, and fall back to the raw
 * value when stripping leaves nothing.
 */
export function shortSessionId(id: string): string {
  const stripped = id.startsWith(STORE_PREFIX) ? id.slice(STORE_PREFIX.length) : id
  return (stripped === '' ? id : stripped).slice(0, 8)
}
