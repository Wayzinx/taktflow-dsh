import type { JsonValue, ToolDefinition, ToolRunContext } from '../dsh-types.js'
import type { SelftestService } from '../selftest.js'

/** 角色行条件注册的受控自测工具名；Lead 不挂载角色插件，因此不会拥有它。 */
export const SELFTEST_TOOL_NAME = 'takt_selftest'

function renderSelftestResult(value: JsonValue): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>
    const exitCode = typeof record.exitCode === 'number' ? record.exitCode : -1
    const passed = record.succeeded === true
    const tail = typeof record.outputTail === 'string' ? record.outputTail : ''
    const evidence = record.evidence
    const evidenceText = evidence === null || evidence === undefined
      ? `证据：无${typeof record.evidenceReason === 'string' ? `（${record.evidenceReason}）` : ''}`
      : `证据：${JSON.stringify(evidence)}`
    return [
      `受控自测${passed ? '通过' : '未通过'}（exitCode=${exitCode}）`,
      evidenceText,
      tail === '' ? '' : `输出尾部：\n${tail}`,
    ].filter(Boolean).join('\n')
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * 角色局部 `takt_selftest` 工具。
 *
 * 只暴露过滤参数；命令、cwd、env、timeout 全部来自启动前冻结的宿主上下文。
 * service 缺失时仍注册工具并明确拒绝，保持旧 fake 环境可启动，不伪造成功。
 */
export function createSelftestTool(service: SelftestService | undefined): ToolDefinition {
  return {
    name: SELFTEST_TOOL_NAME,
    description: [
      '执行当前节点冻结的受控自测命令（默认 5 分钟，可被空间配置调整）。',
      '仓库/worktree 节点执行仓库自身的显式 testCommand 或 environment/package 回退；只有空间根才使用流程 QA caseCommand。',
      '命令来自可信配置，调用方不能提供 command/cwd/env/timeout；只能选择全量、测试文件或测试名称过滤。',
      '完成前必须调用；根据真实 exitCode 和输出写完成说明，非 0 或超时/取消不能称为通过。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'files', 'name'],
          description: 'all=执行全部；files=只跑指定测试文件；name=按测试名称过滤。缺省 all。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'mode=files 时必填；相对当前工作目录的测试文件路径，禁止绝对路径、.. 和 shell 字符。',
        },
        name: {
          type: 'string',
          description: 'mode=name 时必填；测试名称过滤，禁止 shell 字符。',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer' },
          succeeded: { type: 'boolean' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          durationMs: { type: 'number' },
          outputTail: { type: 'string' },
          evidence: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  workspace: { type: 'string' },
                  path: { type: 'string' },
                  version: { type: 'integer' },
                },
                required: ['workspace', 'path', 'version'],
              },
              { type: 'null' },
            ],
          },
          evidenceReason: { type: 'string' },
          timedOut: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          trusted: { type: 'boolean' },
          scriptsChanged: { type: 'boolean' },
          command: { type: 'string' },
          commandSource: { type: 'string' },
          commandHash: { type: 'string' },
          filter: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              name: { type: 'string' },
            },
            required: ['mode'],
          },
          startedAt: { type: 'string' },
          endedAt: { type: 'string' },
        },
        required: [
          'exitCode', 'succeeded', 'durationMs', 'outputTail', 'evidence', 'timedOut',
          'cancelled', 'trusted', 'scriptsChanged', 'command', 'commandSource',
          'commandHash', 'filter', 'startedAt', 'endedAt',
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderSelftestResult(value) }, { type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const childId = exec.agent?.id
      if (childId === undefined || childId === '') {
        throw new Error('takt_selftest 只能由已登记的职责子 Agent 调用')
      }
      if (service === undefined) {
        throw new Error('当前宿主没有受控自测服务，拒绝执行；不要用其它方式执行命令')
      }
      return service.run(childId, args, exec)
    },
  }
}
