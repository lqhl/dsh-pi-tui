/**
 * Long-session fold window computation. Pure and unit-testable: once a
 * transcript passes `threshold` items, the screen renders only the newest
 * `threshold` items and replaces the hidden head with a one-line notice.
 * `/expand-all` (or a find jump into the folded region) lifts the fold.
 *
 * The transcript's item ids are sequential from 0, so "first visible id" is
 * exactly the fold count — everything below it is hidden.
 */
export interface FoldWindow {
  /** Container rebuild key: 'none' | 'all' | 'folded:<count>'. */
  key: string
  /** First visible item id (0 when not folded or expanded). */
  boundary: number
}

export function foldWindow(
  itemsLength: number,
  expandedAll: boolean,
  threshold: number,
): FoldWindow {
  if (expandedAll) return { key: 'all', boundary: 0 }
  const folded = itemsLength - threshold
  if (folded > 0) return { key: `folded:${folded}`, boundary: folded }
  return { key: 'none', boundary: 0 }
}

/**
 * Scroll offset of `targetId` inside the transcript: the sum of rendered
 * line heights of every VISIBLE item before it, plus the fold notice's
 * height when folded. Hidden (folded) items are skipped because the layout
 * never renders them — counting them would overshoot the scroll position.
 * `heights(id)` returns a view's rendered line count.
 */
export function visibleItemsBefore(
  targetId: number,
  window: FoldWindow,
  heights: (id: number) => number,
  noticeHeight = 1,
): number {
  let offset = 0
  if (window.key.startsWith('folded:')) offset += noticeHeight
  for (let id = 0; id < targetId; id += 1) {
    if (id < window.boundary) continue
    offset += heights(id)
  }
  return offset
}
