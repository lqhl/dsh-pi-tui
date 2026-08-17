/**
 * Modal overlays for the human-interaction seams: permission approval and
 * ask_user_question. Both render as centered overlays whose content is a
 * single input-forwarding component (pi-tui routes focused-overlay input to
 * the content root).
 *
 * The overlays must be shown while a turn is parked on the answer, so every
 * flow resolves its promise exactly once and hides the overlay on every
 * exit path (selection, cancel, signal abort).
 */
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import {
  Container,
  Input,
  SelectList,
  Text,
  fuzzyFilter,
  matchesKey,
  type TUI,
} from '@earendil-works/pi-tui'
import { RG_DISPLAY_CAP } from '../core/files.js'
import { selectListTheme, style } from './theme.js'

/** Content root forwarding input to a SelectList child. */
class ListPanel extends Container {
  private list: SelectList

  constructor(title: string, body: string | undefined, list: SelectList) {
    super()
    this.list = list
    this.addChild(new Text(style.accent(title), 1, 0))
    if (body !== undefined && body !== '') {
      for (const line of body.split('\n')) {
        this.addChild(new Text(line, 1, 0))
      }
    }
    this.addChild(this.list)
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  /** Swap the list in place (multi-select check-mark refresh). */
  replaceList(list: SelectList): void {
    this.list = list
    this.children[this.children.length - 1] = list
  }
}

/** Content root forwarding input to an Input child. */
class InputPanel extends Container {
  constructor(
    title: string,
    body: string | undefined,
    private readonly input: Input,
  ) {
    super()
    this.addChild(new Text(style.accent(title), 1, 0))
    if (body !== undefined && body !== '') {
      for (const line of body.split('\n')) {
        this.addChild(new Text(line, 1, 0))
      }
    }
    this.addChild(this.input)
  }

  handleInput(data: string): void {
    this.input.handleInput(data)
  }
}

export interface ListPickItem {
  value: string
  label: string
  description?: string
}

/**
 * Generic single-choice overlay: title + optional body + SelectList.
 * Resolves the picked value, or undefined when cancelled (Esc).
 */
export function pickFromList(
  tui: TUI,
  options: {
    title: string
    body?: string
    items: ListPickItem[]
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const list = new SelectList(
      options.items,
      Math.min(12, Math.max(2, options.items.length)),
      selectListTheme,
    )
    const panel = new ListPanel(options.title, options.body, list)
    const handle = tui.showOverlay(panel, { width: '70%', maxHeight: '70%' })
    list.onSelect = (item) => {
      handle.hide()
      resolve(item.value)
    }
    list.onCancel = () => {
      handle.hide()
      resolve(undefined)
    }
    tui.requestRender()
  })
}

/**
 * Search-capable single-choice overlay: an Input above the list live-filters
 * items with fuzzy scoring (the pi ModelSelector pattern). Enter picks the
 * top match; Esc cancels. `shouldShow` gates per-item visibility (e.g. the
 * hidden-file policy); `footerTotal` feeds the count line.
 */
export function pickFromListWithSearch(
  tui: TUI,
  options: {
    title: string
    body?: string
    items: ListPickItem[]
    shouldShow?: (query: string, item: ListPickItem) => boolean
  },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const search = new Input()
    const list = new SelectList(
      options.items,
      Math.min(12, Math.max(2, options.items.length)),
      selectListTheme,
    )
    // Declared before the handlers so they can close over it; assigned once
    // after showOverlay resolves (prefer-const cannot represent this).
    // eslint-disable-next-line prefer-const
    let handle: ReturnType<TUI['showOverlay']> | undefined
    const onSelect = (item: { value: string; label: string; description?: string }): void => {
      if (item.value === '__nomatch__') return // placeholder is not a pick
      handle?.hide()
      resolve(item.value)
    }
    const onCancel = (): void => {
      handle?.hide()
      resolve(undefined)
    }
    // Wire handlers BEFORE the panel's constructor refilter rebuilds the
    // list: the rebuilt list copies handlers from this original one, so
    // late assignment would target a list no longer in the panel.
    list.onSelect = onSelect
    list.onCancel = onCancel
    const panel = new SearchPanel(
      options.title,
      options.body,
      search,
      list,
      options.items,
      options.shouldShow ?? (() => true),
    )
    handle = tui.showOverlay(panel, { width: '70%', maxHeight: '70%' })
    tui.requestRender()
  })
}

/**
 * Overlay content with a search Input and a SelectList: printable input goes
 * to the search box (live fuzzy re-filter), navigation keys to the list.
 */
class SearchPanel extends Container {
  private readonly allItems: ListPickItem[]
  private readonly shouldShow: (query: string, item: ListPickItem) => boolean
  private list: SelectList
  private readonly listChildIndex: number
  private readonly footer: Text

  constructor(
    title: string,
    body: string | undefined,
    private readonly search: Input,
    list: SelectList,
    allItems: ListPickItem[],
    shouldShow: (query: string, item: ListPickItem) => boolean,
  ) {
    super()
    this.list = list
    this.allItems = allItems
    this.shouldShow = shouldShow
    this.footer = new Text('', 1, 0)
    this.addChild(new Text(style.accent(title), 1, 0))
    if (body !== undefined && body !== '') {
      for (const line of body.split('\n')) {
        this.addChild(new Text(line, 1, 0))
      }
    }
    this.addChild(this.search)
    this.addChild(this.list)
    this.listChildIndex = this.children.length - 1
    this.addChild(this.footer)
    this.refilter()
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, 'up') ||
      matchesKey(data, 'down') ||
      matchesKey(data, 'enter') ||
      matchesKey(data, 'escape') ||
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown')
    ) {
      this.list.handleInput(data)
      return
    }
    // Everything else (printable, backspace, word ops) feeds the search box,
    // then re-filters the list.
    this.search.handleInput(data)
    this.refilter()
  }

  private refilter(): void {
    const query = this.search.getValue().trim()
    const visible = this.allItems.filter((item) => this.shouldShow(query, item))
    let filtered: ListPickItem[]
    if (query === '') {
      filtered = visible
    } else {
      // Two tiers, mirroring pi's filename-weighted fd scoring: basename
      // matches first (the user types filenames, not paths), then full-path
      // matches appended only when the basename tier is thin.
      const byBasename = fuzzyFilter(
        visible,
        query,
        (item) => item.label.split('/').at(-1) ?? item.label,
      )
      if (byBasename.length >= 8) {
        filtered = byBasename
      } else {
        const rest = visible.filter((item) => !byBasename.includes(item))
        filtered = [...byBasename, ...fuzzyFilter(rest, query, (item) => item.label)]
      }
    }
    if (filtered.length === 0) {
      // A selectable-looking placeholder would let Enter "pick" an empty
      // value; use a sentinel the caller ignores.
      filtered = [{ value: '__nomatch__', label: 'no matches', description: 'keep typing or Esc' }]
      this.footer.setText('')
    } else {
      // The full list lives in memory; the render is capped and the footer
      // tells the user how much is left to narrow down.
      const shown = filtered.slice(0, RG_DISPLAY_CAP)
      this.footer.setText(
        filtered.length > RG_DISPLAY_CAP
          ? style.statusBar(`showing ${shown.length} of ${filtered.length} — type to filter`)
          : style.statusBar(`${filtered.length} file${filtered.length === 1 ? '' : 's'}`),
      )
      filtered = shown
    }
    const rebuilt = new SelectList(
      filtered,
      Math.min(12, Math.max(2, filtered.length)),
      selectListTheme,
    )
    rebuilt.onSelect = this.list.onSelect
    rebuilt.onCancel = this.list.onCancel
    this.list = rebuilt
    this.children[this.listChildIndex] = rebuilt
  }
}

/**
 * Ask the human to allow or reject one pending approval request.
 * Returns the closed outcome; resolves 'cancelled' when the request's
 * signal aborts (the service settles the request itself in that case).
 */
export function confirmApproval(tui: TUI, request: ApprovalRequest): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: ApprovalOutcome): void => {
      if (settled) return
      settled = true
      handle.hide()
      resolve(outcome)
    }

    const items = [
      { value: 'allowed-once', label: '✓ Allow once' },
      { value: 'rejected', label: '✗ Reject' },
    ]
    const list = new SelectList(items, 2, selectListTheme)
    const panel = new ListPanel(
      `Approve ${request.toolName}?`,
      request.reason !== undefined && request.reason !== ''
        ? `Reason: ${request.reason}`
        : undefined,
      list,
    )
    const handle = tui.showOverlay(panel, { width: '70%', maxHeight: '60%' })
    list.onSelect = (item) => finish(item.value as ApprovalOutcome)
    list.onCancel = () => finish('rejected')

    const onAbort = (): void => finish('cancelled')
    request.signal?.addEventListener('abort', onAbort, { once: true })
    tui.requestRender()
  })
}

/**
 * Ask the human a batch of questions, one overlay step per question.
 * Options render as a select list (multi-select accumulates with a Done
 * entry); questions without options render a single-line text input.
 */
export function askQuestions(
  tui: TUI,
  request: AskUserQuestionRequest,
): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  return step(tui, request, request.questions, 0, answers)
}

async function step(
  tui: TUI,
  request: AskUserQuestionRequest,
  questions: readonly AskUserQuestionItem[],
  index: number,
  answers: AskUserQuestionAnswerItem[],
): Promise<AskUserQuestionAnswer> {
  if (index >= questions.length) return { answers }
  const question = questions[index]
  const header = question.header !== undefined ? `${question.header} — ` : ''
  const body = [
    header + question.question,
    question.detail !== undefined && question.detail !== '' ? question.detail : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n')

  // A plan-review question closes differently from a generic one: dismissing
  // it means "the user wants to talk instead", which dsh-plan-mode reads from
  // the ASK_CANCELLED rejection — not a skip that yields an empty answer.
  const planReview = question.intent?.kind === 'plan-review'

  const item: AskUserQuestionAnswerItem | undefined = await new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: AskUserQuestionAnswerItem | undefined): void => {
      if (settled) return
      settled = true
      handle.hide()
      resolve(value)
    }
    const dismiss = (): void => {
      if (settled) return
      settled = true
      handle.hide()
      reject(
        new UserQuestionError('the user dismissed the review to speak instead', 'ASK_CANCELLED'),
      )
    }
    const onAbort = (): void => finish(undefined)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    let handle: ReturnType<TUI['showOverlay']>
    if (question.options !== undefined && question.options.length > 0) {
      handle = optionsStep(
        tui,
        question,
        body,
        finish,
        planReview ? dismiss : () => finish(undefined),
      )
    } else {
      handle = textStep(tui, question, body, finish)
    }
    tui.requestRender()
  })

  if (item !== undefined) answers.push(item)
  return step(tui, request, questions, index + 1, answers)
}

/** Select-list step: single-select resolves on pick; multi-select accumulates. */
function optionsStep(
  tui: TUI,
  question: AskUserQuestionItem,
  body: string,
  finish: (value: AskUserQuestionAnswerItem | undefined) => void,
  cancel: () => void,
): ReturnType<TUI['showOverlay']> {
  const options = question.options ?? []
  const multi = question.multiSelect === true
  const selected: string[] = []
  // Plan-review intent: approve option first, plan markdown as the body.
  const approveLabel = question.intent?.kind === 'plan-review' ? question.intent.approve : undefined
  const ordered =
    approveLabel !== undefined
      ? [
          ...options.filter((option) => option.label === approveLabel),
          ...options.filter((option) => option.label !== approveLabel),
        ]
      : options

  const buildItems = () => [
    ...(multi ? [{ value: '__done__', label: selected.length > 0 ? '✓ Done' : 'Done' }] : []),
    ...ordered.map((option) => ({
      value: option.label,
      label: `${selected.includes(option.label) ? '✓ ' : '  '}${option.label}`,
      description: option.description,
    })),
  ]

  const list = new SelectList(
    buildItems(),
    Math.min(12, Math.max(2, ordered.length + 1)),
    selectListTheme,
  )
  const planReview = approveLabel !== undefined
  const panel = planReview
    ? new PlanReviewPanel(question, list)
    : new ListPanel(
        question.question,
        multi ? `${body}\n(multi-select: pick items, then Done)` : body,
        list,
      )
  // Plan review pins a small decision bar to the bottom so the transcript
  // (which holds the full plan) stays visible and scrollable above it.
  const handle = planReview
    ? tui.showOverlay(panel, { width: '70%', anchor: 'bottom-center' })
    : tui.showOverlay(panel, { width: '70%', maxHeight: '70%' })

  list.onSelect = (picked) => {
    if (picked.value === '__done__') {
      finish({ id: question.id, selected })
      return
    }
    if (!multi) {
      finish({ id: question.id, selected: [picked.value] })
      return
    }
    if (!selected.includes(picked.value)) selected.push(picked.value)
    // Rebuild the list in place with updated check marks.
    const rebuilt = new SelectList(
      buildItems(),
      Math.min(12, Math.max(2, ordered.length + 1)),
      selectListTheme,
    )
    rebuilt.onSelect = list.onSelect
    rebuilt.onCancel = list.onCancel
    panel.replaceList(rebuilt)
    tui.requestRender()
  }
  list.onCancel = cancel
  return handle
}

/**
 * Plan-review decision bar: title + question + the approve/decline list, plus
 * a hint. The full plan renders in the transcript's exit_plan_mode tool card
 * (scrollable via the main viewport), so this overlay stays small and is
 * anchored to the bottom of the screen.
 */
class PlanReviewPanel extends Container {
  private list: SelectList
  private readonly listChildIndex: number

  constructor(question: AskUserQuestionItem, list: SelectList) {
    super()
    this.list = list
    const title =
      question.header !== undefined && question.header !== '' ? question.header : 'Plan review'
    this.addChild(new Text(style.accent(title), 1, 0))
    this.addChild(new Text(question.question, 1, 0))
    this.addChild(this.list)
    this.listChildIndex = this.children.length - 1
    this.addChild(
      new Text(
        style.statusBar('PgUp/PgDn scroll the plan · ↑↓ choose · Enter approve · Esc chat'),
        1,
        0,
      ),
    )
  }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  replaceList(list: SelectList): void {
    this.list = list
    this.children[this.listChildIndex] = list
  }
}

/** Free-text step: single-line Input, Enter submits, Escape skips. */
function textStep(
  tui: TUI,
  question: AskUserQuestionItem,
  body: string,
  finish: (value: AskUserQuestionAnswerItem | undefined) => void,
): ReturnType<TUI['showOverlay']> {
  const input = new Input()
  const panel = new InputPanel(question.question, body, input)
  const handle = tui.showOverlay(panel, { width: '70%', maxHeight: '60%' })
  input.onSubmit = (value) => finish({ id: question.id, selected: [], custom: value })
  input.onEscape = () => finish(undefined)
  return handle
}

/**
 * Live "find in transcript" overlay: an Input whose every change re-runs the
 * caller's search and live-jumps to the first match; ↑/↓ (and PgUp/PgDn)
 * cycle through matches, Enter re-jumps to the current one, Esc closes
 * (the highlight stays until the caller clears it).
 */
export function openFindOverlay(
  tui: TUI,
  options: {
    /** Re-run the search for `query`; returns the match count. */
    search(query: string): number
    /** Jump to the match at `index` (scroll + highlight). */
    jump(index: number): void
    /** Initial query to prefill (a previous find's query, or ''). */
    initialQuery?: string
  },
): Promise<void> {
  return new Promise((resolve) => {
    const search = new Input()
    const panel = new FindPanel(
      search,
      (query) => options.search(query),
      (index) => options.jump(index),
      options.initialQuery ?? '',
    )
    const handle = tui.showOverlay(panel, { width: '70%', maxHeight: '30%' })
    panel.onClose = () => {
      handle.hide()
      resolve()
    }
    tui.requestRender()
  })
}

class FindPanel extends Container {
  private readonly search: Input
  private readonly searchFn: (query: string) => number
  private readonly jumpFn: (index: number) => void
  private readonly footer: Text
  private count = 0
  private index = 0
  onClose: (() => void) | undefined

  constructor(
    search: Input,
    searchFn: (query: string) => number,
    jumpFn: (index: number) => void,
    initialQuery: string,
  ) {
    super()
    this.search = search
    this.searchFn = searchFn
    this.jumpFn = jumpFn
    this.footer = new Text('', 1, 0)
    this.addChild(new Text(style.accent('Find in transcript'), 1, 0))
    this.addChild(this.search)
    this.addChild(this.footer)
    this.search.setValue(initialQuery)
    this.refresh(initialQuery)
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.move(-1)
      return
    }
    if (matchesKey(data, 'down')) {
      this.move(1)
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.move(-5)
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.move(5)
      return
    }
    if (matchesKey(data, 'enter')) {
      // Enter: re-jump to the current match and stay in the find bar.
      if (this.count > 0) this.jumpFn(this.index)
      return
    }
    if (matchesKey(data, 'escape')) {
      this.onClose?.()
      return
    }
    // Everything else (printable, backspace, word ops) feeds the search box,
    // then re-runs the search and live-jumps to the first match.
    this.search.handleInput(data)
    this.refresh(this.search.getValue())
  }

  private refresh(query: string): void {
    this.count = this.searchFn(query)
    this.index = this.count > 0 ? 0 : -1
    this.updateFooter()
    if (this.count > 0) this.jumpFn(0)
  }

  private move(delta: number): void {
    if (this.count === 0) return
    this.index = (this.index + delta + this.count) % this.count
    this.updateFooter()
    this.jumpFn(this.index)
  }

  private updateFooter(): void {
    if (this.count === 0) {
      this.footer.setText(style.statusBar('no matches — keep typing or Esc'))
      return
    }
    this.footer.setText(
      style.statusBar(
        `${this.index + 1}/${this.count} match${this.count === 1 ? '' : 'es'} — ↑/↓ cycle · Enter jump · Esc close`,
      ),
    )
  }
}
