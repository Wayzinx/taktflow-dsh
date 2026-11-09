import type { DefineTool, Disposer, HostContext } from '../dsh-types.js'
import type { TaktflowService } from '../types.js'
import { loadDefineTool } from '../dsh-runtime.js'
import { hideHandoff } from '../handoff.js'
import { LEAD_PROMPT_SECTION } from './prompt.js'
import { LEAD_SKILL } from './skill.js'
import { registerLeadTools } from './tools.js'

export const name = 'taktflow/lead'

/**
 * Lead 行依赖宿主门面、工具注册表、提示词、技能，以及 agents（工具按会话取根 Agent）。
 * 工具在 apply 里注册；测试可注入 defineTool seam，正式环境用 dsh-runtime。
 */
export const inject = ['taktflow', 'tools', 'systemPrompt', 'skills', 'agents']

/** Lead 行拿到的上下文：taktflow 是宿主行 provide 的服务。 */
export interface LeadContext extends HostContext {
  taktflow: TaktflowService
}

/** apply 的测试 seam；正式加载器只传 ctx，走 loadDefineTool。 */
export interface LeadApplyOptions {
  defineTool?: DefineTool
}

/**
 * Lead 行入口。
 *
 * 调用方：dsh preset 加载器（preset-taktflow 的最后一个子行）。
 * 时机：只有选择 taktflow preset 的会话才挂载。
 * 失败语义：
 * - 提示词段/技能重复注册会让 preset 加载失败；这是配置错误，应显式暴露。
 * - 正式环境返回 Promise<Disposer>：dsh-tools 加载失败或工具注册失败会让
 *   preset 加载显式失败，而不是“Lead 已加载但一个工具都没有”；卸载时等待
 *   异步 disposer 完成。
 * - 单测通过 options.defineTool 注入，保持同步注册便于断言。
 */
export function apply(ctx: LeadContext, options: LeadApplyOptions = {}): void {
  ctx.effect(() => hideHandoff(ctx), 'taktflow lead hides handoff')
  ctx.effect(() => ctx.systemPrompt.section(LEAD_PROMPT_SECTION), 'taktflow lead prompt')
  ctx.effect(() => ctx.skills.register(LEAD_SKILL), 'taktflow lead skill')
  ctx.effect(() => {
    if (options.defineTool !== undefined) return registerTools(ctx, options.defineTool)
    return loadDefineTool().then((defineTool) => registerToolsAsync(ctx, defineTool))
  }, 'taktflow lead tools')
}

/** 同步注册；中途失败时先卸载已注册的工具，再把原始错误抛给宿主。 */
function registerTools(ctx: LeadContext, defineTool: DefineTool): Disposer {
  const disposers: Disposer[] = []
  try {
    collectToolDisposers(ctx, defineTool, disposers)
  } catch (error) {
    const cleanup = disposeTools(disposers)
    if (cleanup !== undefined) void cleanup.catch(() => undefined)
    throw error
  }
  return () => disposeTools(disposers)
}

/** 异步路径：等待部分注册失败时的清理完成，再暴露原始错误。 */
async function registerToolsAsync(ctx: LeadContext, defineTool: DefineTool): Promise<Disposer> {
  const disposers: Disposer[] = []
  try {
    collectToolDisposers(ctx, defineTool, disposers)
  } catch (error) {
    await disposeTools(disposers)
    throw error
  }
  return () => disposeTools(disposers)
}

/** 逐项注册并写入调用方数组；中途抛错时调用方仍能看到已成功的 disposer。 */
function collectToolDisposers(
  ctx: LeadContext,
  defineTool: DefineTool,
  disposers: Disposer[],
): void {
  for (const definition of registerLeadTools(defineTool, ctx.taktflow, { ctx: { agents: ctx.agents } })) {
    disposers.push(ctx.tools.register(definition))
  }
}

/** 逆序卸载；同步与异步 disposer 都执行完，再汇总错误。 */
function disposeTools(disposers: Disposer[]): void | Promise<void> {
  const pending: Array<void | Promise<void>> = []
  const errors: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      const result = dispose()
      if (result !== undefined) pending.push(result)
    } catch (error) {
      errors.push(error)
    }
  }
  const finish = (): void => {
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'taktflow lead 工具卸载失败')
  }
  if (pending.length === 0) {
    finish()
    return undefined
  }
  return Promise.all(pending.map(async (item) => {
    try {
      await item
    } catch (error) {
      errors.push(error)
    }
  })).then(finish)
}

export { createLeadServices, type LeadServices, type LeadServicesDeps } from './services.js'
export { registerLeadTools, LEAD_TOOL_NAMES, type LeadToolResult } from './tools.js'
