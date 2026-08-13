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
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { Container, Input, SelectList, Text, type TUI } from '@earendil-works/pi-tui'
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
  constructor(title: string, body: string | undefined, private readonly input: Input) {
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
      request.reason !== undefined && request.reason !== '' ? `Reason: ${request.reason}` : undefined,
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

  const item: AskUserQuestionAnswerItem | undefined = await new Promise((resolve) => {
    let settled = false
    const finish = (value: AskUserQuestionAnswerItem | undefined): void => {
      if (settled) return
      settled = true
      handle.hide()
      resolve(value)
    }
    const onAbort = (): void => finish(undefined)
    request.signal?.addEventListener('abort', onAbort, { once: true })

    let handle: ReturnType<TUI['showOverlay']>
    if (question.options !== undefined && question.options.length > 0) {
      handle = optionsStep(tui, question, body, finish)
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
): ReturnType<TUI['showOverlay']> {
  const options = question.options ?? []
  const multi = question.multiSelect === true
  const selected: string[] = []

  const buildItems = () => [
    ...(multi ? [{ value: '__done__', label: selected.length > 0 ? '✓ Done' : 'Done' }] : []),
    ...options.map((option) => ({
      value: option.label,
      label: `${selected.includes(option.label) ? '✓ ' : '  '}${option.label}`,
      description: option.description,
    })),
  ]

  const list = new SelectList(buildItems(), Math.min(12, Math.max(2, options.length + 1)), selectListTheme)
  const panel = new ListPanel(question.question, multi ? `${body}\n(multi-select: pick items, then Done)` : body, list)
  const handle = tui.showOverlay(panel, { width: '70%', maxHeight: '60%' })

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
    const rebuilt = new SelectList(buildItems(), Math.min(12, Math.max(2, options.length + 1)), selectListTheme)
    rebuilt.onSelect = list.onSelect
    rebuilt.onCancel = list.onCancel
    panel.replaceList(rebuilt)
    tui.requestRender()
  }
  list.onCancel = () => finish(undefined)
  return handle
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
