import { notImplemented } from '../errors.js'
import type { DefineTool } from '../dsh-types.js'
import type { TaktflowService } from '../types.js'

/**
 * Lead 的 6 个工具名（技术方案 5.8）。
 *
 * P0 只开放标 ★ 的 action；这里只声明名字，不注册工具。Lead 层用 defineTool
 * 实现，审批回答是人的动作，绝不能暴露成 Lead 工具。
 */
export const LEAD_TOOL_NAMES = [
  'takt_status',
  'takt_requirement',
  'takt_artifact',
  'takt_run',
  'takt_trace',
  'takt_ask_human',
] as const

export type LeadToolName = (typeof LEAD_TOOL_NAMES)[number]

/**
 * 注册 Lead 工具。
 *
 * 调用方：Lead 层完成后由 taktflow/lead 行 apply 调用，defineTool 由
 * dsh-runtime.loadDefineTool 注入。当前显式抛 not implemented，避免加载出
 * “看起来有工具、实际没有”的会话。
 */
export function registerLeadTools(
  _defineTool: DefineTool,
  _service: TaktflowService,
): never {
  notImplemented('lead.tools.registerLeadTools')
}
