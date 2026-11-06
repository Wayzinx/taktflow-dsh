/**
 * M-J 标准流水线 e2e 的确定性输入。
 *
 * 只提供原始输入：临时 app 基线、PRD 建议、两个角色 Skill 与档案/workflow 收窄补丁。
 * 不提供 cases/、tests/run-cases.mjs、scripts/run-cases.mjs 等最终业务产物；
 * 这些必须由真实 test-design / automate 节点生成，e2e 只做验收。
 */

export const REQUIREMENT_TITLE = '为 app 增加 sub 函数并补齐测试'

export const APP_PACKAGE_JSON = {
  name: 'app',
  private: true,
  version: '1.0.0',
  type: 'commonjs',
  scripts: { test: 'node --test' },
}

export const INITIAL_ADD = [
  "'use strict'",
  '',
  'function add(a, b) {',
  '  return a + b',
  '}',
  '',
  'module.exports = { add }',
  '',
].join('\n')

export const INITIAL_ADD_TEST = [
  "'use strict'",
  '',
  "const test = require('node:test')",
  "const assert = require('node:assert/strict')",
  "const { add } = require('./add.js')",
  '',
  "test('add 返回两数之和', () => {",
  '  assert.equal(add(2, 3), 5)',
  '})',
  '',
].join('\n')

/** PRD 建议只作为 `prd` 节点的 inputs/** 输入，不是最终 spec/prd.md。 */
export const PRD_SUGGESTION_PATH = 'inputs/prd-suggestion.md'

export const PRD_SUGGESTION_MARKDOWN = [
  '# 需求建议：为 app 增加 sub 函数并补齐测试',
  '',
  '## 背景',
  'app 是一个 CommonJS 小模块，当前只有 add(a, b)。现在需要增加 sub(a, b)，',
  '并保持 add 的签名和行为不变。',
  '',
  '## 范围与约束',
  '- 产品代码只允许改 app/src/add.js；不引入新依赖，不改变 add 的签名、返回值和已有测试。',
  '  这是产品改动范围，不限制自动化节点在空间 tests/ 与公共产物目录生成测试脚本和证据。',
  '- `sub(a, b)` 只处理两个有限 JS number，按原生减法语义计算；不新增类型校验、舍入、',
  '  异常或特殊值约定，负数与小数操作数同样按原生减法结果。',
  '- CommonJS 模块新增 `sub` 导出；`add` 的导出与行为保持不变。',
  '- 测试设计节点自行产出 test-plan/plan.md 与 cases/<CaseID>.json；每条用例必须含 id、',
  '  covers: [AC-<n>]、步骤与业务断言。CaseID 与拆分由测试设计节点决定，下面的用例只是参考。',
  '- 自动化节点自行生成空间根 tests/run-cases.mjs，并把待评审副本写到公共产物目录',
  '  scripts/run-cases.mjs；两份必须逐字节一致。e2e 不预置这两个文件，也不预置 cases/、',
  '  evidence/summary.json 或 reports/quality.md。',
  '',
  '## 执行目录约定',
  '- 公共产物目录由 TAKT_WORKSPACE 指向：test-plan/、cases/、scripts/、evidence/ 都写在这里。',
  '- 标准 hooks 会把空间根 tests/run-cases.mjs 复制到 app 集成 worktree 的 tests/，并在该',
  '  worktree 的 cwd 执行 `node tests/run-cases.mjs`。因此 runner 里引用产品必须用相对 cwd',
  '  的 `./src/add.js`，不要写成 `app/src/add.js`；证据与汇总仍写到 TAKT_WORKSPACE/evidence/。',
  '- 标准 hooks 的真实汇总接口：evidence/summary.json 必须是',
  '  `{"cases":[{"id":"<实际 CaseID>","status":"passed|failed","evidence":"<实际断言结果或证据路径>"}]}`，',
  '  逐条覆盖生成的 cases；不能只写 total/passed 计数，也不能用 success 等其它状态。',
  '',
  '## 验收标准',
  '- AC-1：`sub(a, b)` 返回 a - b；`sub(5, 3) === 2`，`sub(0, 0) === 0`。',
  '- AC-2：`add(2, 3) === 5` 保持不变。',
  '',
  '## 参考用例（仅建议，不是最终产物）',
  '- sub(5, 3) 期望 2，覆盖 AC-1。',
  '- sub(0, 0) 期望 0，覆盖 AC-1。',
  '- add(2, 3) 期望 5，覆盖 AC-2。',
  '',
  '## 不做什么',
  '- 不做命令行工具、HTTP 接口、性能优化或额外数学函数。',
  '',
].join('\n')

export const SKILL_ALPHA = [
  '---',
  'name: skill-alpha',
  'description: 标准 e2e 的 alpha 技能，只给 dev 角色',
  '---',
  'ALPHA_SKILL_MARKER',
  '',
  '这是 dev 角色的专属技能内容。若其他角色看到它，说明 Skill 隔离失败。',
  '',
].join('\n')

export const SKILL_BETA = [
  '---',
  'name: skill-beta',
  'description: 标准 e2e 的 beta 技能，只给 reviewer 角色',
  '---',
  'BETA_SKILL_MARKER',
  '',
  '这是 reviewer 角色的专属技能内容。若其他角色看到它，说明 Skill 隔离失败。',
  '',
].join('\n')

/**
 * 把角色档案的 skills 字段替换成指定 Skill。
 *
 * 兼容三种真实档案写法：`skills: []`、`skills: [a, b]` 和多行 YAML 列表。
 * 找不到 frontmatter 或 skills 字段时明确失败，不静默跳过。
 */
export function patchSkills(content, skillName) {
  if (typeof content !== 'string' || content === '') throw new Error('角色档案内容为空，无法注入 Skill')
  if (typeof skillName !== 'string' || skillName === '') throw new Error('Skill 名不能为空')
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.trim() === '---')
  const end = lines.findIndex((line, index) => index > start && line.trim() === '---')
  if (start < 0 || end < 0) throw new Error('角色档案缺少 frontmatter，无法注入 Skill')
  const skillsIndex = lines.findIndex((line, index) => index > start && index < end && /^skills\s*:/.test(line))
  const entry = `  - ${skillName}`
  if (skillsIndex >= 0) {
    const inline = lines[skillsIndex].replace(/^skills\s*:\s*/, '')
    if (inline.startsWith('[')) {
      lines[skillsIndex] = `skills: [${skillName}]`
    } else {
      let next = skillsIndex + 1
      while (next < end && /^\s*-\s*/.test(lines[next])) next += 1
      lines.splice(skillsIndex, next - skillsIndex, 'skills:', entry)
    }
  } else {
    lines.splice(end, 0, 'skills:', entry)
  }
  return lines.join('\n')
}

/** 把 planner 的 maxItems 收窄；模板变化时明确失败，不能静默跳过。 */
export function patchPlannerMaxItems(content, maxItems = 2) {
  if (!/maxItems:\s*12/.test(content)) throw new Error('标准流程里找不到 maxItems: 12，无法收窄 planner')
  return content.replace(/maxItems:\s*12/g, `maxItems: ${maxItems}`)
}

/**
 * 回归基线说明：宿主在脚本执行环境注入 TAKT_REGRESSION_BASELINE_REV。
 *
 * 只接受本次 fixture 新建仓库在 Agent 变更前的真实 40 位 SHA；不是运行后的
 * integration HEAD，也不沿用用户环境里可能已有的同名值。PRD 建议必须把来源
 * 和“缺失即 fail/升级”的约束写清楚，不能伪造输入产物。
 */
export function regressionBaselineSection(head) {
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`回归基线 SHA 不合法：${String(head)}`)
  }
  return [
    '',
    '## 回归基线（宿主注入的真实环境输入）',
    `- 宿主已在脚本执行环境注入环境变量 \`TAKT_REGRESSION_BASELINE_REV\`，值为本次变更前基线 commit：\`${head}\`。`,
    '- 来源：e2e 在启动流水线前新建 app 仓库的初始提交，所有 Agent 变更之前；不是运行后的集成 HEAD。',
    '- 回归核对已有 `src/add.test.js`、`package.json` 时，必须使用该 revision 的内容，而不是当前 HEAD。',
    '- 该 revision 必须可访问；如果环境变量缺失或无法读取该 revision，应 fail/升级，不能跳过基线回归或用当前 HEAD 冒充。',
    '',
  ].join('\n')
}
