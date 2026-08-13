/**
 * Pure transcript model: folds `session/event` records into a renderable
 * item list, independent of any UI. Unit-testable without a terminal.
 *
 * The fold mirrors cc-tui's channel state machine: user bubbles, per-step
 * streaming assistant text, per-step reasoning, and tool cards keyed by
 * `callId`, plus a working flag driven by turn boundaries.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type ToolCardStatus = 'running' | 'ok' | 'error'

export interface ToolCardState {
  callId: string
  name: string
  argsPreview: string
  status: ToolCardStatus
  resultPreview?: string
  errorText?: string
}

export interface ChatItem {
  readonly id: number
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice'
  text: string
  /** True while deltas still stream in; sealed items render their final form. */
  streaming: boolean
  seq?: number
  tool?: ToolCardState
  /** Notice flavor: info (slash results), error, or compact checkpoint. */
  notice?: 'info' | 'error' | 'compact'
}

export interface ChatModel {
  items: ChatItem[]
  /** Cumulative token accounting from `assistant/message` usage records. */
  tokens: { input: number; output: number }
  /** Live session title (`session/title`), if any. */
  title?: string
  /** True between `turn/start` and `turn/end` — drives the working loader. */
  working: boolean
}

const ARGS_PREVIEW_LIMIT = 200
const RESULT_PREVIEW_LIMIT = 400

export function createModel(): ChatModel {
  return { items: [], tokens: { input: 0, output: 0 }, working: false }
}

/** Extract plain text from content blocks (text blocks only; others skipped). */
export function textOf(content: readonly ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

function preview(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ')
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/**
 * Fold one session event into the model. Stateful in place; returns the
 * model for chaining.
 */
export function applyEvent(model: ChatModel, event: SessionEvent): ChatModel {
  let nextId = model.items.length

  const push = (item: Omit<ChatItem, 'id'>): ChatItem => {
    const withId: ChatItem = { ...item, id: nextId }
    nextId += 1
    model.items.push(withId)
    return withId
  }

  switch (event.type) {
    case 'user/message': {
      // Compaction checkpoint: render as a framed notice, not a bubble.
      if (
        event.data.source.kind === 'plugin' &&
        event.data.source.plugin === 'compact'
      ) {
        push({ kind: 'notice', text: 'Conversation compacted', streaming: false, seq: event.seq, notice: 'compact' })
        const summary = textOf(event.data.content)
        if (summary) {
          push({ kind: 'notice', text: summary, streaming: false, seq: event.seq, notice: 'compact' })
        }
        break
      }
      // Only direct human prompts render as bubbles; other injected context
      // (goal/skill sources) is skipped.
      if (event.data.source.kind !== 'user') break
      const text = textOf(event.data.content)
      if (text) {
        push({ kind: 'user', text, streaming: false, seq: event.seq })
      }
      break
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && chunk.text) {
        const item = currentStreaming(model, 'assistant', event.seq)
        item.text += chunk.text
      } else if (chunk.type === 'reasoning-delta' && chunk.text) {
        const item = currentStreaming(model, 'reasoning', event.seq)
        item.text += chunk.text
      }
      break
    }
    case 'assistant/message': {
      // The assembled message is authoritative (chunks may have been
      // compacted or pruned); replace the streamed text and seal.
      const item = currentStreaming(model, 'assistant', event.seq)
      const text = textOf(event.data.message.content)
      if (text) item.text = text
      item.streaming = false
      sealReasoning(model, event.seq)
      const usage = event.data.usage
      if (usage !== undefined) {
        model.tokens.input += usage.inputTokens ?? 0
        model.tokens.output += usage.outputTokens ?? 0
      }
      break
    }
    case 'tool/call': {
      // ask_user_question renders through the userQuestions provider (M2),
      // not as a tool card — the model parks waiting for a human answer.
      if (event.data.name === 'ask_user_question') break
      push({
        kind: 'tool',
        text: '',
        streaming: true,
        seq: event.seq,
        tool: {
          callId: event.data.callId,
          name: event.data.name,
          argsPreview: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
          status: 'running',
        },
      })
      break
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const card = model.items.find(
        (item) => item.kind === 'tool' && item.tool?.callId === callId,
      )
      if (card === undefined || card.tool === undefined) break
      card.streaming = false
      const failure = event.data.error
      if (failure !== undefined) {
        card.tool.status = 'error'
        card.tool.errorText = `${failure.name}: ${failure.code}`
      } else {
        card.tool.status = 'ok'
        const block = event.data.message.content[0]
        const result =
          block !== undefined && block.type === 'tool-result'
            ? textOf(block.content)
            : ''
        if (result) card.tool.resultPreview = preview(result, RESULT_PREVIEW_LIMIT)
      }
      break
    }
    case 'turn/start': {
      model.working = true
      break
    }
    case 'turn/end': {
      model.working = false
      // A sealed turn folds all its reasoning blocks into collapsed labels.
      for (const item of model.items) {
        if (item.kind === 'reasoning') item.streaming = false
      }
      // Surface non-completed endings as notices.
      const reason = event.data.reason
      if (reason.kind === 'error') {
        const failure = (reason as { error: { code?: string; message?: string } }).error
        push({ kind: 'notice', text: `turn failed: ${failure?.code ?? 'ERROR'}${failure?.message ? ` — ${failure.message}` : ''}`, streaming: false, seq: event.seq, notice: 'error' })
      } else if (reason.kind === 'aborted') {
        push({ kind: 'notice', text: 'turn aborted', streaming: false, seq: event.seq, notice: 'info' })
      } else if (reason.kind === 'max-tokens') {
        push({ kind: 'notice', text: 'turn hit the output-token ceiling', streaming: false, seq: event.seq, notice: 'info' })
      }
      break
    }
    default:
      break
  }
  return model
}

/** The open streaming item of a kind for the current step, or a fresh one. */
function currentStreaming(
  model: ChatModel,
  kind: 'assistant' | 'reasoning',
  seq?: number,
): ChatItem {
  const existing = model.items
    .filter((item) => item.kind === kind && item.streaming)
    .at(-1)
  if (existing !== undefined) return existing
  const item: ChatItem = { id: model.items.length, kind, text: '', streaming: true, seq }
  model.items.push(item)
  return item
}

/** Seal the open reasoning item for the step (collapse to a label). */
function sealReasoning(model: ChatModel, _seq?: number): void {
  const item = model.items
    .filter((entry) => entry.kind === 'reasoning' && entry.streaming)
    .at(-1)
  if (item !== undefined) item.streaming = false
}

/** Push a UI-side notice (slash-command results, errors) into the transcript. */
export function pushNotice(
  model: ChatModel,
  text: string,
  notice: NonNullable<ChatItem['notice']> = 'info',
): void {
  model.items.push({
    id: model.items.length,
    kind: 'notice',
    text,
    streaming: false,
    notice,
  })
}
