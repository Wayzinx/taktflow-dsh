/**
 * 空间流程的依赖闭包哈希（流程文件 + 它引用的本地文件，如 *.hooks.ts）。冷恢复含函数的流程时用它证明
 * “重新加载出来的函数和开始时是同一份源码”，而不是只比函数文本。随包流程没有，按旧规则拒绝冷恢复。
 *
 * host.js / lead.js 等是不同 bundle，模块变量不共享；登记表放在 globalThis 上。
 */
const REGISTRY = Symbol.for('taktflow.workflow.sourceHashes')

function registry(): WeakMap<object, string> {
  const holder = globalThis as unknown as Record<symbol, WeakMap<object, string> | undefined>
  return (holder[REGISTRY] ??= new WeakMap())
}

export function recordWorkflowSourceHash(workflow: object, hash: string): void {
  registry().set(workflow, hash)
}

export function workflowSourceHash(workflow: object): string | undefined {
  return registry().get(workflow)
}
