import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 空间变更串行锁。
 *
 * 调用方：`FsSpaceRegistry.open` 与 `takt_requirement init`。init 的
 * “检查单根冲突 → initProject 写盘 → 复制角色 → 绑定根”和 open 的
 * “检查单根 → 绑定根”必须互斥，否则两个 Lead 会话可能同时通过检查后各写一半。
 *
 * 同一异步调用链内可重入：init 持锁后调用 `spaces.open` 不会自锁。重入只认
 * **仍在执行中的租用**（token.active）；锁内创建、等锁释放后才执行的 timer /
 * followup 会继承同一个 AsyncLocalStorage 上下文，但 token 已失效，必须重新排队。
 * 不能只用 `AsyncLocalStorage<true>`：那样脱离任务链的异步任务会永久绕过互斥。
 *
 * 跨进程不在这里处理：init 只发生在 dsh 会话内；CLI 初始化由 core 的原子写负责。
 */
interface Lease {
  active: boolean
}

const leaseStorage = new AsyncLocalStorage<Lease>()
let tail: Promise<unknown> = Promise.resolve()

export function withSpaceMutationLock<T>(task: () => Promise<T>): Promise<T> {
  if (leaseStorage.getStore()?.active === true) return task()
  const run = tail.then(
    () => acquire(task),
    () => acquire(task),
  )
  tail = run.then(() => undefined, () => undefined)
  return run
}

async function acquire<T>(task: () => Promise<T>): Promise<T> {
  const lease: Lease = { active: true }
  try {
    return await leaseStorage.run(lease, task)
  } finally {
    // 释放后再创建的异步任务即使继承上下文，也只会看到 active=false 并重新排队。
    lease.active = false
  }
}
