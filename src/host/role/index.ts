import type { HostContext, SystemPromptSection } from '../dsh-types.js'
import { createRoleSkillTool, roleSkillRegistration, type RoleSkillSnapshot } from '../role-skills.js'
import { createSelftestTool } from './selftest.js'
import { hideHandoff } from '../handoff.js'
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
  /** M-K 增量：本次节点实际生效的写入范围；空数组表示只读。 */
  writeScope?: string[]
  /** M-K 增量：是否挂载受控自测工具；只读或无写入范围时由 preset 置 false。 */
  selftest?: boolean
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
    '- 不要使用 bash 或任意 shell；只有宿主挂载了受控自测工具时，才能用它执行当前节点冻结的测试命令。',
    '- 只读模式（readOnly）下不要修改任何文件，也不要执行命令。',
    '- 写入范围是 glob 白名单；不在白名单内的文件即使存在也不要改。',
    '- 有结构化结果约束（resultSchema/outputSchema）时：如果宿主提供了 structured_output 工具，完成时必须调用它提交实际结果（只调用一次，参数是实际结果字段，不是 schema 定义；不要用纯文本替代）；没有该工具时，按节点约定提交实际结果，节点要求 JSON 时输出实际结果 JSON。字段名、类型和必填项按约束填写，字段值按本次真实检查结论填写。',
    '- 不要把 schema 定义本身（type/properties/required 等）当作结果提交，也不要用长文、批准话术或已读的人类报告替代实际结果；失败时在结果字段中给出可执行的下一步。',
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
  // 职责角色就在流水线里，不需要“交给 Taktflow”。
  ctx.effect(() => hideHandoff(ctx), 'taktflow role hides handoff')
  const selftest = config.selftest === true && config.readOnly !== true && (config.writeScope?.length ?? 0) > 0 && config.role !== 'lead'
  const snapshots = config.skillSnapshot ?? []
  const skillNames = snapshots.length > 0 ? snapshots.map((skill) => skill.name) : config.skills ?? []
  const detail = [
    config.role === undefined ? '' : `当前角色：${config.title ?? config.role}（${config.role}）`,
    config.spaceRoot === undefined ? '' : `空间根：${config.spaceRoot}`,
    config.readOnly === undefined ? '' : `本次权限：${config.readOnly ? '只读' : '仅可写宿主登记的范围'}`,
    selftest
      ? '本角色挂载了 takt_selftest：完成前必须调用它，并根据真实 exitCode 与输出写完成说明；非 0、超时或取消都不得写成通过。无适用测试入口时如实记录未执行，按本节点完成标准判断；要求自测证据的实现节点不能放行。'
      : '当前角色没有受控自测工具；不要执行任何命令，流程级测试由 script/自动化节点负责。',
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
  // 只读角色、无写入范围角色和 Lead 都没有该工具；service 缺失时工具仍明确拒绝。
  if (selftest) {
    ctx.effect(() => ctx.tools.register(createSelftestTool(ctx.taktflow.selftests)), 'taktflow role selftest tool')
  }
}
