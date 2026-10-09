/**
 * Pure transcript model: folds `session/event` records (plus the live
 * `agent/assistant-stream` frames) into a renderable item list, independent
 * of any UI. Unit-testable without a terminal.
 *
 * The fold mirrors cc-tui's channel state machine: user bubbles, per-step
 * streaming assistant text, per-step reasoning, and tool cards keyed by
 * `callId`, plus a working flag driven by turn boundaries.
 *
 * Two feeds, one transcript:
 *   - `session/event` is the durable, authoritative log (replayed on boot and
 *     resumed sessions): `user/message`, `assistant/message`, `tool/call`,
 *     `tool/result`, `request/header`, turn boundaries.
 *   - `agent/assistant-stream` carries process-local, non-durable
 *     `AssistantStreamFrame`s (`start`/`chunk`/`end`) that paint deltas while
 *     a model call runs. `assistant/message` then replaces the streamed text
 *     with the assembled, durable message.
 */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * This plugin's own user-message producer vocabulary. `MessageSourceMap` is
 * merge-extensible and has no shared catch-all kind, so a producer declares
 * its own: `!`/`!!` shell output the TUI injects into model context is
 * `pi-tui`, never `user`, so the fold does not render it as a second bubble.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pi-tui': { kind: 'pi-tui' }
  }
}

/**
 * Producer kind dsh-compaction stamps on a checkpoint (`compactCheckpointSource`).
 * Declared by a package this plugin does not depend on, so it is matched
 * structurally rather than through the merge-extensible union.
 */
const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint'

export type ToolCardStatus = 'running' | 'ok' | 'error' | 'rejected'

export interface ToolCardState {
  callId: string
  name: string
  argsPreview: string
  status: ToolCardStatus
  resultPreview?: string
  /** Untruncated result, rendered when the user expands tool output. */
  resultFull?: string
  /** Full plan markdown carried by an exit_plan_mode call, rendered as the card body. */
  planText?: string
  errorText?: string
  /** Result-time file diffs from tool meta (dsh-tool-fs), for /Ctrl+O view. */
  diffs?: FileDiff[]
  /** Durable image-attachment refs from image content blocks (read_image). */
  imageRefs?: ImageAttachmentRef[]
}

/** Serializable image-attachment reference from a tool result's image block. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** One file change carried by a tool result's `meta.diffs`. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

export interface ChatItem {
  readonly id: number
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice'
  text: string
  /** True while deltas still stream in; sealed items render their final form. */
  streaming: boolean
  seq?: number
  tool?: ToolCardState
  /** Notice flavor: info (slash results), error, compact checkpoint, or the
   * pre-colored startup banner. */
  notice?: 'info' | 'error' | 'compact' | 'banner'
}

export interface ChatModel {
  items: ChatItem[]
  /** Cumulative token accounting from `assistant/message` usage records. */
  tokens: { input: number; output: number }
  /** Live session title (`session/title`), if any. */
  title?: string
  /** True between `turn/start` and `turn/end` — drives the working loader. */
  working: boolean
  /** Reasoning effort the last request actually used (`request/header`). */
  effort?: string
  /** Provider/model route the last request actually used. */
  route?: { provider?: string; model?: string }
  /** Last plain human prompt — the `/retry` target. */
  lastUserText?: string
  /** Open streaming items for O(1) chunk folding (internal, not rendered). */
  openAssistant?: ChatItem
  openReasoning?: ChatItem
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

/** Extract reasoning text from content blocks (reasoning blocks only). */
export function reasoningOf(content: readonly ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => (block.type === 'reasoning' ? block.text : ''))
    .join('')
    .trim()
}

function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as { path?: unknown; oldText?: unknown; newText?: unknown }
  return (
    typeof record.path === 'string' &&
    (record.oldText === null || typeof record.oldText === 'string') &&
    typeof record.newText === 'string'
  )
}

function preview(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ')
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/** First `# heading` of a plan, or undefined when it has none. */
function planHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * Compact tool-args preview. Most tools keep the whitespace-collapsed raw
 * JSON, but exit_plan_mode carries the whole plan in its arguments — already
 * shown in the plan-review overlay — so it previews as the plan's title.
 */
function toolArgsPreview(name: string, argumentsJson: string): string {
  if (name === 'exit_plan_mode') {
    try {
      const parsed = JSON.parse(argumentsJson) as { plan?: unknown }
      if (typeof parsed.plan === 'string' && parsed.plan.trim() !== '') {
        return planHeading(parsed.plan) ?? 'plan'
      }
    } catch {
      // Malformed JSON: fall back to the raw preview.
    }
  }
  return preview(argumentsJson, ARGS_PREVIEW_LIMIT)
}

/** Full plan text from an exit_plan_mode call, or undefined for other tools. */
function toolPlanText(name: string, argumentsJson: string): string | undefined {
  if (name !== 'exit_plan_mode') return undefined
  try {
    const parsed = JSON.parse(argumentsJson) as { plan?: unknown }
    return typeof parsed.plan === 'string' && parsed.plan.trim() !== '' ? parsed.plan : undefined
  } catch {
    return undefined
  }
}

/** Strip the "Error: " prefix the tool runtime puts on thrown-error text. */
function stripErrorPrefix(text: string): string {
  return text.replace(/^Error:\s*/, '')
}

/**
 * exit_plan_mode failures that are actually human decisions, not errors.
 * Mirrors dsh-plan-mode's review-outcome messages: "keep planning" and the
 * dismissed-to-speak takeovers both leave the plan unapproved.
 */
function exitPlanNotApproved(text: string): string | undefined {
  const message = stripErrorPrefix(text)
  if (message.startsWith('The user chose to keep planning')) {
    return 'Plan not approved — still in plan mode'
  }
  if (message.startsWith('The user dismissed the plan review to speak instead')) {
    return 'Dismissed — chat instead; still in plan mode'
  }
  return undefined
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
      // Compaction checkpoint: render as a framed notice, not a bubble. The
      // checkpoint is a replacement user/message whose producer kind is
      // `compact-checkpoint` (dsh-compaction), so match it structurally.
      if ((event.data.source as { kind?: string }).kind === COMPACT_CHECKPOINT_KIND) {
        push({
          kind: 'notice',
          text: 'Conversation compacted',
          streaming: false,
          seq: event.seq,
          notice: 'compact',
        })
        const summary = textOf(event.data.content)
        if (summary) {
          push({
            kind: 'notice',
            text: summary,
            streaming: false,
            seq: event.seq,
            notice: 'compact',
          })
        }
        break
      }
      // Only direct human prompts render as bubbles; other injected context
      // (goal/skill/inbox sources) is skipped.
      if (event.data.source.kind !== 'user') break
      const text = textOf(event.data.content)
      if (text) {
        model.lastUserText = text
        push({ kind: 'user', text, streaming: false, seq: event.seq })
      }
      break
    }
    case 'assistant/message': {
      // The assembled message is authoritative (chunks may have been
      // compacted or pruned); replace the streamed text and seal. Reasoning
      // is rendered first: live deltas already opened that item, while a
      // replayed log carries reasoning only here, inside the message.
      const content = event.data.message.content
      const reasoning = reasoningOf(content)
      const openReasoning = model.openReasoning
      if (openReasoning !== undefined) {
        if (reasoning) openReasoning.text = reasoning
        openReasoning.streaming = false
        model.openReasoning = undefined
      } else if (reasoning) {
        push({ kind: 'reasoning', text: reasoning, streaming: false, seq: event.seq })
      }
      const item = currentStreaming(model, 'assistant', event.seq)
      const text = textOf(content)
      if (text) item.text = text
      item.streaming = false
      model.openAssistant = undefined
      const usage = event.data.usage
      if (usage !== undefined) {
        model.tokens.input += usage.inputTokens ?? 0
        model.tokens.output += usage.outputTokens ?? 0
      }
      break
    }
    case 'assistant/attempt': {
      // The attempt settled without committing model-visible history
      // (failed, retried, or cancelled). Seal whatever the live frames
      // painted so no item keeps streaming; the partial text stays visible
      // as the record of that attempt.
      sealOpenItems(model)
      break
    }
    case 'tool/call': {
      // ask_user_question renders through the userQuestions provider (M2),
      // not as a tool card — the model parks waiting for a human answer.
      if (event.data.name === 'ask_user_question') break
      const planText = toolPlanText(event.data.name, event.data.arguments)
      push({
        kind: 'tool',
        text: '',
        streaming: true,
        seq: event.seq,
        tool: {
          callId: event.data.callId,
          name: event.data.name,
          argsPreview: toolArgsPreview(event.data.name, event.data.arguments),
          status: 'running',
          ...(planText !== undefined ? { planText } : {}),
        },
      })
      break
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const card = model.items.find((item) => item.kind === 'tool' && item.tool?.callId === callId)
      if (card === undefined || card.tool === undefined) break
      card.streaming = false

      // A ToolResultMessage carries the result blocks directly (text/image/
      // file); there is no wrapping `tool-result` block any more.
      const content = event.data.message.content
      const result = textOf(content)
      // A plain `Error` thrown by a tool body carries no `event.data.error`
      // (only HarnessErrors do); its failure is flagged on the message.
      const failed = event.data.error !== undefined || event.data.message.isError === true

      if (failed) {
        const notApproved =
          card.tool.name === 'exit_plan_mode' ? exitPlanNotApproved(result) : undefined
        if (notApproved !== undefined) {
          card.tool.status = 'rejected'
          card.tool.resultPreview = notApproved
        } else {
          card.tool.status = 'error'
          const failure = event.data.error
          card.tool.errorText =
            failure !== undefined ? `${failure.name}: ${failure.code}` : stripErrorPrefix(result)
        }
        break
      }

      card.tool.status = 'ok'
      if (result) {
        card.tool.resultPreview = preview(result, RESULT_PREVIEW_LIMIT)
        card.tool.resultFull = result
      }
      // Image results are durable attachment refs carried by image blocks;
      // project them onto the card's plain, serializable shape.
      const imageRefs: ImageAttachmentRef[] = content
        .filter((block) => block.type === 'image')
        .map((block) => ({
          attachmentId: String(block.attachment.attachmentId),
          mediaType: String(block.attachment.mediaType),
          bytes: block.attachment.bytes,
          width: block.attachment.width,
          height: block.attachment.height,
          ...(block.attachment.name !== undefined ? { name: block.attachment.name } : {}),
        }))
      if (imageRefs.length > 0) card.tool.imageRefs = imageRefs
      const meta = event.data.meta as { diffs?: unknown } | undefined
      if (meta !== undefined && Array.isArray(meta.diffs)) {
        const diffs = meta.diffs.filter(isFileDiff)
        if (diffs.length > 0) card.tool.diffs = diffs
      }
      break
    }
    case 'request/header': {
      // The request actually dispatched: read back the resolved route and
      // reasoning effort (status-bar truth, durable on replay).
      const config = event.data.header.config as
        { provider?: string; model?: string; reasoningEffort?: string } | undefined
      if (config !== undefined) {
        model.route = { provider: config.provider, model: config.model }
        if (config.reasoningEffort !== undefined) model.effort = config.reasoningEffort
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
      model.openReasoning = undefined
      model.openAssistant = undefined
      // Surface non-completed endings as notices.
      const reason = event.data.reason
      if (reason.kind === 'error') {
        const failure = (reason as { error: { code?: string; message?: string } }).error
        push({
          kind: 'notice',
          text: `turn failed: ${failure?.code ?? 'ERROR'}${failure?.message ? ` — ${failure.message}` : ''}`,
          streaming: false,
          seq: event.seq,
          notice: 'error',
        })
      } else if (reason.kind === 'aborted') {
        push({
          kind: 'notice',
          text: 'turn aborted',
          streaming: false,
          seq: event.seq,
          notice: 'info',
        })
      } else if (reason.kind === 'max-tokens') {
        push({
          kind: 'notice',
          text: 'turn hit the output-token ceiling',
          streaming: false,
          seq: event.seq,
          notice: 'info',
        })
      }
      break
    }
    default:
      // Plugin-merged events (e.g. `session/title` from the harness's
      // session-title row) are outside the local SessionEventMap; fold the
      // ones we render without widening the union.
      foldPluginEvent(model, event)
      break
  }
  return model
}

/**
 * Fold plugin-merged session events the local dsh-session types do not
 * declare. Current surface: `session/title` feeds the status bar's title
 * segment (official auto-titles and `/rename` both land here on replay).
 */
function foldPluginEvent(model: ChatModel, event: SessionEvent): void {
  const raw = event as unknown as { type?: string; data?: { title?: unknown } }
  if (
    raw.type === 'session/title' &&
    typeof raw.data?.title === 'string' &&
    raw.data.title !== ''
  ) {
    model.title = raw.data.title
  }
}

/** The open streaming item of a kind for the current step, or a fresh one.
 * The open-item cache keeps chunk folding O(1) instead of re-scanning the
 * transcript on every delta. */
function currentStreaming(
  model: ChatModel,
  kind: 'assistant' | 'reasoning',
  seq?: number,
): ChatItem {
  const existing = kind === 'assistant' ? model.openAssistant : model.openReasoning
  if (existing !== undefined) return existing
  const item: ChatItem = { id: model.items.length, kind, text: '', streaming: true, seq }
  model.items.push(item)
  if (kind === 'assistant') model.openAssistant = item
  else model.openReasoning = item
  return item
}

/** Seal the open reasoning item for the step (collapse to a label). */
function sealReasoning(model: ChatModel): void {
  const item = model.openReasoning
  if (item !== undefined) {
    item.streaming = false
    model.openReasoning = undefined
  }
}

/** Seal both open streaming items (a settled attempt or an interrupted turn). */
function sealOpenItems(model: ChatModel): void {
  sealReasoning(model)
  const assistant = model.openAssistant
  if (assistant !== undefined) {
    assistant.streaming = false
    model.openAssistant = undefined
  }
}

/**
 * Fold one live `agent/assistant-stream` frame into the model. Frames are
 * process-local and non-durable: `start`/`end` only bracket an attempt, and
 * `chunk` frames paint deltas. The durable `assistant/message` (or
 * `assistant/attempt`) that follows replaces or seals whatever was painted.
 */
export function applyStreamFrame(model: ChatModel, frame: AssistantStreamFrame): ChatModel {
  switch (frame.type) {
    case 'start': {
      // A new attempt (possibly a retry after a sealed one) starts a fresh
      // streaming item rather than appending to the previous attempt's text.
      sealOpenItems(model)
      break
    }
    case 'chunk': {
      const chunk = frame.chunk
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        currentStreaming(model, 'assistant').text += chunk.text
      } else if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
        currentStreaming(model, 'reasoning').text += chunk.text
      }
      break
    }
    case 'end': {
      // `committed` means the durable settlement already landed (its
      // session/event sealed the item); `abandoned` means nothing follows,
      // so seal here either way.
      sealOpenItems(model)
      break
    }
  }
  return model
}

/** Push a UI-side notice (slash-command results, errors) into the transcript. */
export function pushNotice(
  model: ChatModel,
  text: string,
  notice: NonNullable<ChatItem['notice']> = 'info',
): ChatItem {
  const item: ChatItem = {
    id: model.items.length,
    kind: 'notice',
    text,
    streaming: false,
    notice,
  }
  model.items.push(item)
  return item
}
