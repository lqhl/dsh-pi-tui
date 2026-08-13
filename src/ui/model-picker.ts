/**
 * Model selection: catalog listing and picker overlay.
 *
 * Uses the same surface as the official web/grok clients — `ctx.llm`
 * catalog read + `installModelSelection` apply (the apply call lives in
 * ChatScreen, which owns the one-per-agent selection ref).
 */
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { TUI } from '@earendil-works/pi-tui'
import { pickFromList, type ListPickItem } from './overlays.js'

export interface ModelRoute {
  provider: string
  model: string
}

/** Minimal LlmRuntime surface we consume. */
export interface LlmRuntimeLike {
  listProviders(): readonly { id: string }[]
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/** Flatten the full provider catalog into provider/model routes. */
export async function listAllModels(llm: LlmRuntimeLike): Promise<ModelRoute[]> {
  const providers = llm.listProviders()
  const lists = await Promise.all(
    providers.map((provider) => llm.listModels(provider.id).catch(() => [])),
  )
  return lists.flat().map((info) => ({ provider: info.provider, model: info.id }))
}

function toItem(route: ModelRoute, current: ModelRoute | undefined, index: number): ListPickItem {
  const isCurrent = current !== undefined && current.provider === route.provider && current.model === route.model
  return {
    value: `${route.provider}\u0000${route.model}`,
    label: `${isCurrent ? '✓ ' : '  '}${route.model}${route.model !== route.provider ? ` (${route.provider})` : ''}`,
    description: isCurrent ? `active · #${index}` : `#${index}`,
  }
}

export function parseRoute(value: string): ModelRoute | undefined {
  const separator = value.indexOf('\u0000')
  if (separator === -1) return undefined
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
}

/** Picker overlay over the model catalog; resolves undefined on Esc. */
export async function pickModel(
  tui: TUI,
  llm: LlmRuntimeLike,
  current?: ModelRoute,
): Promise<ModelRoute | undefined> {
  const routes = await listAllModels(llm)
  if (routes.length === 0) return undefined
  const picked = await pickFromList(tui, {
    title: 'Select model',
    body: current !== undefined ? `current: ${current.model} (${current.provider})` : undefined,
    items: routes.map((route, index) => toItem(route, current, index)),
  })
  return picked === undefined ? undefined : parseRoute(picked)
}
