import type { HostContext } from '../dsh-types.js'
import type { SkillRegistration, SystemPromptSection } from '../dsh-types.js'
import type { TaktflowService } from '../types.js'

export const name = 'taktflow/role'

/** 角色行只依赖宿主门面、提示词与技能；具体角色由 执行层按节点配置挂载。 */
export const inject = ['taktflow', 'systemPrompt', 'skills']

export interface RoleContext extends HostContext {
  taktflow: TaktflowService
}

/**
 * 角色行的固定提示词段。
 *
 * 调用方：执行层为节点创建角色 preset 时挂载本行。
 * 时机：每次节点尝试；运行态权限由 PermissionScope 提供，不写死在提示词里。
 */
export const ROLE_PROMPT_SECTION: SystemPromptSection = {
  name: 'taktflow:role',
  order: 110,
  text: [
    '你是 Taktflow 交付流水线中的角色 Agent。',
    '',
    '工作规则：',
    '- 只在当前工作目录内工作；写入范围以宿主提供的 writeScope 为准，越界会被引擎判为违规。',
    '- P0 所有角色都没有 shell；不要尝试执行命令，测试由流程里的 script 节点执行。',
    '- 只读模式（readOnly）下不要修改任何文件。',
    '- 产物写入公共存放区约定的路径，并在结果里说明改了哪些文件、依据是什么。',
    '- 无法完成时明确返回 blocked 和原因，不要伪造成功。',
  ].join('\n'),
}

/**
 * 角色行的 bundled skill。
 *
 * 调用方：执行层挂载角色行时注册。
 * 时机：模型需要确认产物路径/写权限边界时读取。
 */
export const ROLE_SKILL: SkillRegistration = {
  name: 'taktflow',
  description: 'Taktflow 角色 Agent 的产物路径与写权限边界',
  whenToUse: '当需要写产物、确认写权限或返回结构化结果时',
  source: 'bundled',
  content: [
    '# Taktflow 角色约定',
    '',
    '- 公共存放区在 `.takt/workspaces/<需求ID>/`；产物路径相对该目录。',
    '- 不要修改 `.takt/runs/`、`.takt/attention.jsonl` 等宿主状态。',
    '- 写入范围是 glob 白名单；不在白名单内的文件即使存在也不要改。',
    '- 结果用结构化 JSON 时，字段名与节点 resultSchema 对齐；失败时给出可执行的下一步。',
  ].join('\n'),
}

/**
 * 角色行入口。
 *
 * 调用方：dsh preset 加载器（执行层动态注册的角色 preset）。
 * 失败语义：重复注册同名段/技能会抛错，由 preset 注册失败暴露。
 */
export function apply(ctx: RoleContext): void {
  ctx.effect(() => ctx.systemPrompt.section(ROLE_PROMPT_SECTION), 'taktflow role prompt')
  ctx.effect(() => ctx.skills.register(ROLE_SKILL), 'taktflow role skill')
}
