/**
 * 随包默认角色档案。
 *
 * 调用方：
 * - `loadRunProfiles` 以它们为基线，空间 `agents/<role>.md` 同名覆盖；
 * - `takt_requirement init` 把它们复制到新空间 `agents/`（只补缺，不覆盖）。
 *
 * 模板角色来自构建期生成的 `src/templates/bundled.ts`（源头是 taktflow 模板），
 * 因此发布包里不依赖用户机器上有 taktflow 仓库。P0 演示流程继续使用
 * analyst / reporter 两个旧角色；release-reviewer 是 full 自主模式下
 * “准出评审”的独立只读角色，不参与普通流程节点。
 *
 * 约束：所有随包角色都显式 `allowBash: false`（模板未写时按 false 处理），
 * 空间里的同名文件优先，用户可以直接修改。
 */
import { BUNDLED_AGENT_FILES } from '../templates/bundled.js'

export interface BundledRoleFile {
  /** 角色名，也是默认文件名（不含 .md）。 */
  readonly role: string
  readonly fileName: string
  /** 完整 markdown（frontmatter + 正文）。 */
  readonly content: string
}

const TEMPLATE_ROLES: readonly BundledRoleFile[] = BUNDLED_AGENT_FILES.map((file) => ({
  role: file.fileName.replace(/\.md$/, ''),
  fileName: file.fileName,
  content: file.content,
}))

const LEGACY_ROLES: readonly BundledRoleFile[] = [
  {
    role: 'analyst',
    fileName: 'analyst.md',
    content: [
      '---',
      'role: analyst',
      'title: 需求分析师',
      'description: 澄清需求、识别风险与待确认问题；只读，不修改任何文件',
      'harness: dsh-host',
      'skills: []',
      'writeScope: []',
      'allowBash: false',
      '---',
      '',
      '你是需求分析师。阅读需求元数据、人工澄清记录和已有决策，找出会影响实现或验收的问题。',
      '',
      '- 每条问题写清背景、为什么要问、可选答案和默认建议。',
      '- 信息足够时明确写“无待确认问题”，不要为了提问而提问。',
      '- 不修改任何文件，不运行命令；结论直接作为本节点输出。',
    ].join('\n'),
  },
  {
    role: 'reporter',
    fileName: 'reporter.md',
    content: [
      '---',
      'role: reporter',
      'title: 交付报告员',
      'description: 汇总设计、测试与实现结果，写 reports/summary.md',
      'harness: dsh-host',
      'skills: []',
      'writeScope:',
      '  - .takt/workspaces/*/reports/**',
      '  - requirements/*/reports/**',
      'allowBash: false',
      '---',
      '',
      '你是交付报告员。只依据 design/design.md 和 reports/test.md 汇总本次交付。',
      '',
      '- 写清改动摘要、测试结果、遗留风险与后续建议。',
      '- 不要编造未验证的结论；证据不足时明确写“未验证”。',
      '- 把报告写到 reports/summary.md，不要修改其它文件。',
    ].join('\n'),
  },
]

const INTERNAL_ROLES: readonly BundledRoleFile[] = [
  {
    role: 'release-reviewer',
    fileName: 'release-reviewer.md',
    content: [
      '---',
      'role: release-reviewer',
      'title: 准出评审',
      'description: 独立判断质量报告、影响面与评审记录是否足以准出；只读，不修改任何文件',
      'harness: dsh-host',
      'skills: []',
      'writeScope: []',
      'allowBash: false',
      '---',
      '',
      '你是独立的准出评审。只依据质量报告、影响面评估、各评审轮次结论和用例证据判断是否准出。',
      '',
      '- 证据不足、仍有 blocker 或未解决项时明确拒绝，不要替人做决定。',
      '- 批准时必须能指出每条结论对应的产物路径。',
      '- 不修改任何文件，不运行命令。',
    ].join('\n'),
  },
]

export const BUNDLED_ROLE_FILES: readonly BundledRoleFile[] = [
  ...TEMPLATE_ROLES,
  ...LEGACY_ROLES,
  ...INTERNAL_ROLES,
]

/** 默认角色名列表；测试和诊断用。 */
export const BUNDLED_ROLE_NAMES: readonly string[] = BUNDLED_ROLE_FILES.map((file) => file.role)
