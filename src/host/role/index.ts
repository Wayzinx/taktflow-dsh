import type { HostContext, SystemPromptSection } from '../dsh-types.js'
import { createRoleSkillTool, roleSkillRegistration, type RoleSkillSnapshot } from '../role-skills.js'
import type { TaktflowService } from '../types.js'

export const name = 'taktflow/role'

/** 角色行只依赖宿主门面、提示词、技能与工具；具体角色由 执行层按节点配置挂载。 */
export const inject = ['taktflow', 'systemPrompt', 'skills', 'tools']

export interface RoleContext extends HostContext {
  taktflow: TaktflowService
}

/** 执行器通过 preset 行传入冻结角色信息；运行中不重新读空间档案。 */
export interface RoleConfig {
  role?: string
  spaceRoot?: string
  title?: string
  description?: string
  instructions?: string
  /** 档案声明的技能名；仅用于旧实现/提示词，不代表已经注册。 */
  skills?: string[]
  /** 运行开始时冻结的角色技能；提供时按内容注册，并挂载角色局部 skill 工具。 */
  skillSnapshot?: RoleSkillSnapshot[]
  readOnly?: boolean
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
    '- 只在当前工作目录内工作；代码写入范围以宿主提供的 writeScope 为准，越界会被引擎判为违规。',
    '- 公共产物只能写到宿主登记的当前需求产物目录；不要创建其它需求目录或第二份产物。',
    '- 不要修改 `.takt/runs/`、`.takt/attention.jsonl` 等宿主状态。',
    '- P0 所有角色都没有 shell；不要尝试执行命令，测试由流程里的 script 节点执行。',
    '- 只读模式（readOnly）下不要修改任何文件。',
    '- 写入范围是 glob 白名单；不在白名单内的文件即使存在也不要改。',
    '- 结果用结构化 JSON 时，字段名与节点 resultSchema 对齐；失败时给出可执行的下一步。',
    '- 无法完成时明确返回 blocked 和原因，不要伪造成功。',
  ].join('\n'),
}

/**
 * 角色行入口。
 *
 * 调用方：dsh preset 加载器（执行层动态注册的角色 preset）。
 * 失败语义：重复注册同名段/技能会抛错，由 preset 注册失败暴露。
 */
export function apply(ctx: RoleContext, config: RoleConfig = {}): void {
  const snapshots = config.skillSnapshot ?? []
  const skillNames = snapshots.length > 0 ? snapshots.map((skill) => skill.name) : config.skills ?? []
  const detail = [
    config.role === undefined ? '' : `当前角色：${config.title ?? config.role}（${config.role}）`,
    config.spaceRoot === undefined ? '' : `空间根：${config.spaceRoot}`,
    config.readOnly === undefined ? '' : `本次权限：${config.readOnly ? '只读' : '仅可写宿主登记的范围'}`,
    config.description ?? '', config.instructions ?? '',
    skillNames.length ? `此角色声明的技能：${skillNames.join('、')}。只可使用 skill 工具实际返回的当前角色技能。` : '',
  ].filter(Boolean).join('\n\n')
  ctx.effect(() => ctx.systemPrompt.section({
    ...ROLE_PROMPT_SECTION,
    text: [ROLE_PROMPT_SECTION.text, detail].filter(Boolean).join('\n\n'),
    interpolate: false,
  }), 'taktflow role prompt')
  // 只注册角色声明并通过空间加载的技能；固定产物/权限说明已在上方 system prompt。
  for (const snapshot of snapshots) {
    ctx.effect(() => ctx.skills.register(roleSkillRegistration(snapshot)), `taktflow role skill ${snapshot.name}`)
  }
  // 无论快照是否为空都挂局部同名工具：空快照明确拒绝全部，不能继承全局 skill 工具/目录。
  ctx.effect(() => ctx.tools.register(createRoleSkillTool(snapshots)), 'taktflow role skill tool')
}
