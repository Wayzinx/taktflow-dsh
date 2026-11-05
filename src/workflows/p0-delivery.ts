import type { WorkflowDefinition } from '@taktflow/core'
import { notImplemented } from '../host/errors.js'

/** Lead 层提供真实的随包流程；骨架不能把尚未实现的流程声明为可运行。 */
export function loadP0DeliveryWorkflow(): WorkflowDefinition {
  return notImplemented('workflows.p0-delivery（M-D）')
}
