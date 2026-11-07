import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { Agent, HostContext } from './dsh-types.js'
import { ApiError } from '@taktflow/server'
import type { SpaceHandle } from './types.js'

/**
 * 面板“告诉 Lead”（docs/design/21）与角色模型选择用到的 dsh 会话服务。
 *
 * 只用宿主服务 `sessionController`（@deepseek-ai/dsh-api-session-controller 的 Host 服务）：
 * create 新建会话、prompt 以用户消息投递、modelCatalog 列出 App 可用模型。
 */
export interface SessionControllerService {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  prompt(request: { sessionId: string; requestId: string; mode?: 'queue' | 'steer'; content: Array<{ type: 'text'; text: string }> }, signal: AbortSignal): Promise<{ accepted: boolean }>
  modelCatalog(): Promise<{ default?: { provider: string; model: string }; groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>
}

export const LEAD_PRESET = 'taktflow'
const MAX_TEXT = 2000
const PAGE_LABEL: Record<string, string> = {
  'settings:policy': '空间设置 · 运行策略', 'settings:agents': '空间设置 · 角色', 'settings:skills': '空间设置 · 技能',
  'settings:knowledge': '空间设置 · 知识源', 'settings:repos': '空间设置 · 代码仓库', workflows: 'Workflow',
}

function controller(ctx: HostContext): SessionControllerService {
  const service = ctx.get<SessionControllerService>('sessionController')
  if (service === undefined) throw new ApiError(501, '宿主没有提供会话服务（sessionController），请升级 DeepSeek Harness 后重试')
  return service
}

function presetOf(agent: Agent): string | undefined {
  const presets = agent.ctx?.get('agentPresets') as { composedPreset?(ctx: unknown): string | undefined } | undefined
  return presets?.composedPreset?.(agent.ctx) ?? agent.session.header.agentPreset
}

/** 当前在线、工作目录就是这个空间根的 Lead 会话；有多个时取最后一个（最近创建）。 */
async function onlineLead(ctx: HostContext, space: SpaceHandle): Promise<Agent | undefined> {
  let found: Agent | undefined
  for (const agent of ctx.agents.roots()) {
    if (presetOf(agent) !== LEAD_PRESET) continue
    const cwd = agent.session.header.cwd
    if (cwd === undefined) continue
    const resolved = await realpath(cwd).catch(() => undefined)
    if (resolved === space.root) found = agent
  }
  return found
}

/**
 * 把面板上的一句话交给这个空间的 Lead：有在线 Lead 会话就投递过去，没有就新建一个 taktflow 会话。
 * 消息以用户身份进入会话（就是人说的话），前面标注来自面板的哪一页，Lead 据此决定用哪个工具。
 * 失败语义：空文本 / 超长 400；宿主没有会话服务时明确失败，不静默丢弃。
 */
export async function askLead(ctx: HostContext, space: SpaceHandle, input: { text: unknown; page?: unknown; target?: unknown }): Promise<{ sessionId: string; created: boolean }> {
  if (typeof input.text !== 'string' || input.text.trim() === '') throw new ApiError(400, '要交给 Lead 的话不能为空')
  const text = input.text.trim()
  if (text.length > MAX_TEXT) throw new ApiError(400, `一句话最多 ${MAX_TEXT} 字，请拆开分几次说`)
  const page = typeof input.page === 'string' ? input.page : undefined
  const target = typeof input.target === 'string' && input.target.trim() ? input.target.trim() : undefined
  const sessions = controller(ctx)
  const live = await onlineLead(ctx, space)
  const sessionId = live?.id ?? (await sessions.create({ cwd: space.root, agentPreset: LEAD_PRESET })).sessionId
  const where = page === undefined ? 'Taktflow 面板' : `Taktflow 面板 · ${PAGE_LABEL[page] ?? page}`
  // 用户的话放在前面：dsh 会用第一条消息生成会话标题。
  const message = `${text}\n\n（来自${where}${target ? `，对象：${target}` : ''}）`
  const result = await sessions.prompt({ sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: message }] }, AbortSignal.timeout(30_000))
  if (!result.accepted) throw new ApiError(502, 'Lead 会话没有接收这条消息，请在会话里直接说一遍')
  return { sessionId, created: live === undefined }
}

/** App 里可用的模型，id 形如 `<provider>/<model>`；角色档案写这个值时子 Agent 用指定模型。 */
export async function hostModels(ctx: HostContext): Promise<Array<{ id: string; label: string }>> {
  const catalog = await controller(ctx).modelCatalog()
  return catalog.groups.flatMap((group) => group.models.map((model) => ({ id: `${group.id}/${model.id}`, label: `${model.name} · ${group.name}` })))
}

/**
 * 角色档案里的 model 如果是 App 模型（`<provider>/<model>`，provider 存在于 App），返回子 Agent 的模型选项；
 * 其它写法（模板里的 sonnet、gpt-5-codex 等别名）返回 undefined，子 Agent 跟随 App 当前模型。
 */
export async function dshModelOption(ctx: HostContext, model: string | undefined): Promise<{ provider: string; model: string } | undefined> {
  if (model === undefined) return undefined
  const slash = model.indexOf('/')
  if (slash <= 0) return undefined
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1)
  const service = ctx.get<SessionControllerService>('sessionController')
  if (service === undefined) return undefined
  const catalog = await service.modelCatalog().catch(() => undefined)
  return catalog?.groups.some((group) => group.id === provider && group.models.some((m) => m.id === id)) ? { provider, model: id } : undefined
}
