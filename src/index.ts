/**
 * Taktflow dsh 包的程序化出口。
 *
 * dsh 加载的是 package.json exports 指向的 lib/host.js / lib/lead.js /
 * lib/role.js；这里汇总类型与工厂，方便 执行层、Lead 层和客户端 在仓库内引用和单测。
 */
export * from './host/types.js'
export * from './host/space.js'
export * from './host/ownership.js'
export * from './host/runs.js'
export * from './host/presets.js'
export * from './host/permissions.js'
export * from './host/approvals.js'
export * from './host/notify.js'
export * from './host/dsh-harness.js'
export * from './host/dsh-types.js'
export * from './host/dsh-runtime.js'
export * from './host/errors.js'
export * from './host/routes.js'
export { VERSION } from './version.js'
export { loadP0DeliveryWorkflow } from './workflows/p0-delivery.js'
