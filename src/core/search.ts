/**
 * Transcript search: build a per-item match index over the chat model.
 * Pure and unit-testable — the UI jumps to a matched item by accumulating
 * rendered line heights in front of it (see ChatScreen).
 *
 * Matching is case-insensitive substring search over the human-visible text
 * of user / assistant / reasoning items plus the full tool-result text, so
 * "find where the model said X" works across every transcript kind.
 */
import type { ChatItem } from './model.js'

/** One transcript item that contains the query (first match per item). */
export interface TranscriptSearchMatch {
  /** Item id (=== index into `model.items`). */
  itemId: number
  /** Render kind, for the picker's description column. */
  kind: ChatItem['kind']
  /** Whitespace-collapsed single-line snippet around the first match. */
  snippet: string
}

/** Searchable plain text of an item (empty for items with no text). */
export function itemSearchText(item: ChatItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
      return item.text
    case 'tool': {
      const tool = item.tool
      if (tool === undefined) return ''
      const args = tool.argsPreview
      const body = tool.resultFull ?? tool.resultPreview ?? ''
      return `${tool.name} ${args} ${body}`
    }
    case 'notice':
      return item.text
  }
}

/** Collapse whitespace and trim to a single-line snippet (max ~90 cols). */
export function snippetOf(text: string, maxLength = 90): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single
}

/**
 * Index items that contain `query` (case-insensitive). Returns one entry
 * per matching item, in transcript order; an empty/whitespace query matches
 * nothing. The snippet is centered on the first occurrence when the text is
 * long, so the user sees the matched region, not just the head of the item.
 */
export function buildSearchIndex(
  items: readonly ChatItem[],
  query: string,
): TranscriptSearchMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: TranscriptSearchMatch[] = []
  for (const item of items) {
    const text = itemSearchText(item)
    // Locate the match in whitespace-collapsed text so the snippet window
    // centers on it even when the raw text has ragged newlines/indentation.
    const single = text.replace(/\s+/g, ' ').trim()
    const at = single.toLowerCase().indexOf(needle)
    if (at === -1) continue
    matches.push({
      itemId: item.id,
      kind: item.kind,
      snippet: snippetAround(single, at),
    })
  }
  return matches
}

/** Snippet centered on the first match, bounded by the surrounding text. */
function snippetAround(single: string, at: number): string {
  if (single.length <= 90) return single
  const start = Math.max(0, Math.min(at - 30, single.length - 90))
  const prefix = start > 0 ? '…' : ''
  const suffix = start + 90 < single.length ? '…' : ''
  return `${prefix}${single.slice(start, start + 90)}${suffix}`
}
