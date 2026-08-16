/**
 * Pure model-selection seeding: the provider/model/reasoning-effort fallback
 * chain shared by fresh and resumed agents. Unit-testable without a terminal.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

export interface SelectionSeed {
  header?: { provider?: string; model?: string; reasoningEffort?: string }
  config?: { provider?: string; model?: string }
  agentOptions?: { provider?: string; model?: string }
  defaults?: { provider?: string; model?: string; reasoningEffort?: string }
  /** The prior selection — its reasoning effort carries across a session switch. */
  prior?: ModelSelection
}

/**
 * Fold the selection sources into the next-step model selection.
 * Precedence: persisted request header → row config → agent options →
 * harness default → hard-coded route. Reasoning effort additionally falls
 * back to the prior selection so a /thinking choice survives new/fork/
 * resume (which never see the prior agent's options).
 */
export function seedModelSelection(input: SelectionSeed): ModelSelection {
  const provider =
    input.header?.provider ??
    input.config?.provider ??
    input.agentOptions?.provider ??
    input.defaults?.provider ??
    DEFAULT_PROVIDER
  const model =
    input.header?.model ??
    input.config?.model ??
    input.agentOptions?.model ??
    input.defaults?.model ??
    DEFAULT_MODEL
  const reasoningEffort =
    input.header?.reasoningEffort !== undefined
      ? ReasoningEffortId(input.header.reasoningEffort)
      : input.prior?.reasoningEffort
  return {
    provider,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}
