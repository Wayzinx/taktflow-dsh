import type { HostContext } from '../dsh-types.js'
import type { TaktflowService } from '../types.js'
import { LEAD_PROMPT_SECTION } from './prompt.js'
import { LEAD_SKILL } from './skill.js'

export const name = 'taktflow/lead'

/**
 * Lead 行只依赖宿主门面、工具注册表、提示词与技能。
 * 注意：tools 只用于 Lead 层后续注册；当前 apply 不注册任何工具。
 */
export const inject = ['taktflow', 'tools', 'systemPrompt', 'skills']

/** Lead 行拿到的上下文：taktflow 是宿主行 provide 的服务。 */
export interface LeadContext extends HostContext {
  taktflow: TaktflowService
}

/**
 * Lead 行入口。
 *
 * 调用方：dsh preset 加载器（preset-taktflow 的最后一个子行）。
 * 时机：只有选择 taktflow preset 的会话才挂载。
 * 失败语义：提示词段/技能重复注册会让 preset 加载失败；这是配置错误，应显式暴露。
 */
export function apply(ctx: LeadContext): void {
  ctx.effect(() => ctx.systemPrompt.section(LEAD_PROMPT_SECTION), 'taktflow lead prompt')
  ctx.effect(() => ctx.skills.register(LEAD_SKILL), 'taktflow lead skill')
}
