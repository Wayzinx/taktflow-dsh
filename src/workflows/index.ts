import { TaktToolError, type WorkflowCatalog } from '../host/types.js'

/**
 * 随包流程目录占位实现。
 *
 * Lead 层把 p0-delivery 登记进来；在此之前目录为空，load 一律抛
 * TAKT_UNSUPPORTED_NODE，避免执行层把“没有流程”当成可运行。
 */
export function createWorkflowCatalog(): WorkflowCatalog {
  return {
    ids: () => [],
    async load(workflowId: string) {
      throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `未知流程：${workflowId}`, '用 takt_status 查看可用流程')
    },
  }
}
