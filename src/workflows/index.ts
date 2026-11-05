import { TaktToolError, type WorkflowCatalog } from '../host/types.js'
import type { WorkflowDefinition } from '@taktflow/core'
import { loadP0DeliveryWorkflow, P0_DELIVERY_ID, validateWorkflowForP0 } from './p0-delivery.js'

export { loadP0DeliveryWorkflow, P0_DELIVERY_ID, validateWorkflowForP0 } from './p0-delivery.js'

/** 随包流程表：P0 只加载构建期打包进来的流程，不读用户目录。 */
const P0_WORKFLOWS: Record<string, () => WorkflowDefinition> = {
  [P0_DELIVERY_ID]: loadP0DeliveryWorkflow,
}

/**
 * 随包流程目录。
 *
 * 调用方：宿主行创建服务门面；RunManager 在 start / resume 时按 id 加载。
 * 时机：每次 load 重新构造流程定义，并执行 P0 约束校验。
 * 失败语义：未知 id 或流程里出现 P0 不支持的节点抛 TAKT_UNSUPPORTED_NODE。
 */
export function createWorkflowCatalog(): WorkflowCatalog {
  return {
    ids: () => Object.keys(P0_WORKFLOWS),
    async load(workflowId: string): Promise<WorkflowDefinition> {
      // 只认自有键：constructor / toString / __proto__ 等原型链名字也必须按未知流程处理。
      const factory = Object.hasOwn(P0_WORKFLOWS, workflowId) ? P0_WORKFLOWS[workflowId] : undefined
      if (!factory) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `未知流程：${workflowId}`,
          `可用流程：${Object.keys(P0_WORKFLOWS).join(', ')}`,
        )
      }
      const workflow = factory()
      validateWorkflowForP0(workflow)
      return workflow
    },
  }
}
