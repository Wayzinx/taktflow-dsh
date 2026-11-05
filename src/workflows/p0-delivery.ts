import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agent,
  defineWorkflow,
  human,
  script,
  type NodeContext,
  type NodeDef,
  type NodeResult,
  type WorkflowDefinition,
} from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
// core 公开入口没有导出进程组取消工具；这里只读复用其内部实现，不改 vendor。
import { command } from '../../vendor/taktflow/packages/core/src/engine/process.js'
import { TaktToolError } from '../host/types.js'

/** 随包流程的稳定 id；RunManager、工具与客户端都按这个 id 加载。 */
export const P0_DELIVERY_ID = 'p0-delivery'

/** P0 引擎真正实现的节点类型；review / subflow 等协议里有但引擎没有的类型一律拒绝。 */
const P0_NODE_KINDS = new Set(['script', 'agent', 'gate', 'human', 'judge', 'loop', 'planner'])

/** 测试命令的默认值；流程参数 testCommand 优先。 */
const DEFAULT_TEST_COMMAND = 'npm test'

/** 测试输出只保留尾部，避免把整份日志塞进产物。 */
const TEST_OUTPUT_TAIL = 4_000

type NodeWithExtras = NodeDef & {
  /** P0 禁止声明的字段；引擎不支持 shell，声明即拒绝（false 也不行）。 */
  allowBash?: unknown
}

/**
 * 校验 P0 流程的节点约束。
 *
 * 调用方：随包流程目录的 load（以及测试）。
 * 失败语义：未知节点类型、review 节点、任何声明 allowBash 的节点（含 false）都抛
 * TAKT_UNSUPPORTED_NODE；嵌套的 loop 体同样递归校验。
 */
export function validateWorkflowForP0(workflow: WorkflowDefinition): void {
  const visit = (nodes: readonly NodeDef[], prefix: string): void => {
    for (const raw of nodes) {
      const node = raw as NodeWithExtras
      const label = `${prefix}${node.id}`
      if (!P0_NODE_KINDS.has(node.kind)) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `P0 不支持节点类型 ${node.kind}（节点 ${label}）`,
          '移除该节点；P0 只执行 script / agent / gate / human / judge / loop / planner',
        )
      }
      // 声明了就算越权，无论值是 true 还是 false：P0 所有角色都没有 shell。
      if (Object.hasOwn(node, 'allowBash')) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `P0 的节点不能声明 allowBash（节点 ${label}）`,
          '删除 allowBash；测试由 script 节点执行，角色 Agent 不加载 shell',
        )
      }
      if (node.kind === 'loop') visit(node.body, `${label}/`)
      // planner 的 expand 是函数，动态节点在运行时才可见；引擎会逐个校验类型，
      // 随包流程不使用 planner，避免静态检查看不到 allowBash。
    }
  }
  visit(workflow.nodes, '')
}

/**
 * 运行测试脚本节点。
 *
 * 命令优先级：流程参数 `testCommand` → 默认 `npm test`（TaktConfig 没有测试命令字段，
 * 因此空间级自定义只能通过 start 参数传入）。命令在项目根执行，结果写入公共存放区的
 * `reports/test.md`；退出码非 0 时节点失败，不把失败当通过。
 *
 * 取消语义：复用 core 的进程组取消，运行被取消时连同测试命令派生的后台子进程一起结束；
 * 取消不写测试报告，交回引擎按 cancelled 处理。
 */
async function runTests(ctx: NodeContext): Promise<NodeResult | void> {
  const configured = ctx.args.testCommand
  const commandText = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_TEST_COMMAND
  const redact = createRedactor(collectSecrets())
  const startedAt = Date.now()
  let exitCode = 0
  let output = ''
  try {
    const result = await command(commandText, ctx.projectDir, {
      TAKT_REQ: ctx.requirementId,
      TAKT_RUN_ID: ctx.runId,
      TAKT_NODE: ctx.nodeId,
      TAKT_WORKSPACE: ctx.workspaceDir,
    }, ctx.signal)
    exitCode = result.code
    output = result.output.trim()
  } catch (error) {
    // 取消不是测试失败，交回引擎按 cancelled 处理。
    if (ctx.signal?.aborted) throw error
    const failure = error as { message?: string }
    exitCode = 1
    output = failure.message ?? String(error)
  }
  const elapsedMs = Date.now() - startedAt
  // 先脱敏再截断，避免密钥刚好跨过截断边界留下半段。
  const redacted = redact(output)
  const tail = redacted.length > TEST_OUTPUT_TAIL ? `…\n${redacted.slice(-TEST_OUTPUT_TAIL)}` : redacted
  const report = [
    '# 测试结果',
    '',
    `- 命令：\`${redact(commandText)}\``,
    `- 退出码：${exitCode}`,
    `- 耗时：${elapsedMs} ms`,
    '',
    '## 输出',
    '',
    '```text',
    tail || '（无输出）',
    '```',
    '',
  ].join('\n')
  await mkdir(join(ctx.workspaceDir, 'reports'), { recursive: true })
  await writeFile(join(ctx.workspaceDir, 'reports/test.md'), report, 'utf8')
  if (exitCode !== 0) {
    return { status: 'failed', message: `测试命令退出码 ${exitCode}（详见 reports/test.md）` }
  }
  return { data: { command: redact(commandText), exitCode, elapsedMs } }
}

/**
 * P0 随包交付流程。
 *
 * 澄清（只读）→ 系分（写 design/**）→ 人工审批 → 实现（写 src/**）→ 测试（script）→
 * 报告（写 reports/**）。所有 agent 节点都走 dsh-host，且不声明 allowBash。
 */
export function loadP0DeliveryWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    id: P0_DELIVERY_ID,
    title: 'P0 交付流程',
    description: '需求澄清 → 系分 → 人工审批 → 实现 → 测试 → 报告',
    version: '0.1.0',
    stages: [
      { id: 'clarify', title: '需求澄清' },
      { id: 'design', title: '系分设计' },
      { id: 'approve', title: '人工审批' },
      { id: 'implement', title: '实现' },
      { id: 'test', title: '测试' },
      { id: 'report', title: '交付报告' },
    ],
    nodes: [
      agent({
        id: 'clarify',
        title: '需求澄清',
        stage: 'clarify',
        role: 'analyst',
        harness: { harness: 'dsh-host' },
        // 只读：不产出产物、不声明可写范围。
        writeScope: [],
        inputs: [
          { path: 'inputs/**', required: false },
          { path: 'decisions/**', required: false },
          // Lead 获准写澄清记录的路径；不纳入会漏掉人工补充的信息。
          { path: 'clarifications/**', required: false },
        ],
        prompt: [
          '先读取公共存放区根目录的 requirement.json，确认需求 title 与 links；',
          '它是工作区元数据，不是产物，不要把它声明成产物输入。',
          '再阅读 inputs/、decisions/ 与 clarifications/ 下的人工澄清记录，列出会影响实现或验收的待确认问题。',
          '每条写清楚为什么要问、可选答案；信息足够时明确写“无待确认问题”。',
          '不要修改任何文件，也不要运行命令。',
        ].join('\n'),
      }),
      agent({
        id: 'design',
        title: '系分设计',
        stage: 'design',
        role: 'architect',
        harness: { harness: 'dsh-host' },
        needs: ['clarify'],
        inputs: [
          { path: 'inputs/**', required: false },
          { path: 'decisions/**', required: false },
          { path: 'clarifications/**', required: false },
        ],
        outputs: [{ path: 'design/design.md', kind: 'design' }],
        // 引擎按项目根做写后 diff，而 agent 实际写的是 .takt/workspaces/<REQ>/design/**，
        // 所以这里写物理范围；逻辑产物路径仍是 design/**。单星只匹配一层需求目录。
        // 若执行层能按 TAKT_REQ 收窄到当前需求，应优先使用更窄的范围。
        writeScope: ['.takt/workspaces/*/design/**'],
        prompt: (ctx) => {
          const clarified = ctx.resultOf('clarify')
          const summary = typeof clarified === 'string' ? clarified : JSON.stringify(clarified ?? '')
          return [
            '写系分：改动范围、模块划分、接口/数据变更、风险与回滚方案。',
            '阅读 inputs/、decisions/ 与 clarifications/；人工澄清与澄清结论冲突时以最新澄清为准。',
            '存量能力优先复用，不要重写。',
            '把结论写到 design/design.md，供人工审批。',
            '',
            `澄清结论：${summary.slice(0, 8_000) || '（无）'}`,
          ].join('\n')
        },
      }),
      human({
        id: 'approve-design',
        title: '人工审批系分',
        stage: 'approve',
        needs: ['design'],
        inputs: [{ path: 'design/design.md' }],
        form: 'approve',
        ask: '审阅 design/design.md：批准后进入实现（写 src/**）；拒绝则本次运行失败，需要重新发起。',
      }),
      agent({
        id: 'implement',
        title: '实现',
        stage: 'implement',
        role: 'dev',
        harness: { harness: 'dsh-host' },
        needs: ['approve-design'],
        inputs: [{ path: 'design/design.md' }],
        writeScope: ['src/**'],
        prompt: [
          '按 design/design.md 在 src/ 下实现已批准方案。',
          '保持改动最小，复用存量能力；不要修改设计文档、测试与流程文件。',
          '完成后用一段话说明改了什么、还有哪些风险。',
        ].join('\n'),
      }),
      script({
        id: 'test',
        title: '运行测试',
        stage: 'test',
        needs: ['implement'],
        inputs: [{ path: 'design/design.md', required: false }],
        outputs: [{ path: 'reports/test.md', kind: 'report' }],
        run: runTests,
      }),
      agent({
        id: 'report',
        title: '交付报告',
        stage: 'report',
        role: 'reporter',
        harness: { harness: 'dsh-host' },
        needs: ['test'],
        inputs: [
          { path: 'design/design.md' },
          { path: 'reports/test.md' },
        ],
        outputs: [{ path: 'reports/summary.md', kind: 'report' }],
        // 同 design：产物逻辑路径是 reports/**，物理写入在需求目录下。
        writeScope: ['.takt/workspaces/*/reports/**'],
        prompt: [
          '汇总本次交付：改动摘要、测试结果、遗留风险与后续建议。',
          '只依据 design/design.md 和 reports/test.md，不要编造未验证的结论。',
          '把报告写到 reports/summary.md。',
        ].join('\n'),
      }),
    ],
  })
}
