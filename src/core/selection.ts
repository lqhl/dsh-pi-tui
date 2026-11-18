import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'

export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

export interface SelectionSeed {
  config?: Pick<AgentOptions, 'provider' | 'model'>
  agentOptions?: AgentOptions
  defaults?: ModelSelection
  prior?: ModelSelection
}

/** Resolve initial options before the agent has a recorded model selection. */
export function seedModelSelection(input: SelectionSeed): ModelSelection {
  const provider =
    input.config?.provider ??
    input.agentOptions?.provider ??
    input.defaults?.provider ??
    DEFAULT_PROVIDER
  const model =
    input.config?.model ?? input.agentOptions?.model ?? input.defaults?.model ?? DEFAULT_MODEL
  const defaultEffort =
    input.defaults?.provider === provider && input.defaults.model === model
      ? input.defaults.reasoningEffort
      : undefined
  const reasoningEffort =
    input.agentOptions?.reasoningEffort ?? input.prior?.reasoningEffort ?? defaultEffort
  return {
    provider,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}
