import { expect, it } from 'vitest'
import { withSpaceMutationLock } from './space-lock.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

it('同一调用链内可重入，不会自锁', async () => {
  const order: string[] = []
  await withSpaceMutationLock(async () => {
    order.push('outer')
    await withSpaceMutationLock(async () => {
      order.push('inner')
    })
  })
  expect(order).toEqual(['outer', 'inner'])
})

it('锁内创建、锁释放后才执行的异步任务仍需重新排队', async () => {
  const order: string[] = []
  const started = deferred()
  const release = deferred()
  const trigger = deferred()

  const first = withSpaceMutationLock(async () => {
    started.resolve()
    order.push('first:start')
    // 锁内创建但依赖外部触发；它继承了租用上下文，但执行时租用已经失效。
    void trigger.promise.then(async () => {
      await withSpaceMutationLock(async () => {
        order.push('detached')
      })
    })
    await release.promise
    order.push('first:end')
  })
  await started.promise
  release.resolve()
  await first

  const second = withSpaceMutationLock(async () => {
    order.push('second:start')
    await tick()
    order.push('second:end')
  })
  // 让 second 先拿到锁，再触发锁内创建的 detached 任务。
  await tick()
  trigger.resolve()
  await second
  await tick()
  await tick()

  expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end', 'detached'])
})

it('任务失败后锁仍会释放，后续调用可以继续', async () => {
  await expect(withSpaceMutationLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
  await expect(withSpaceMutationLock(async () => 'next')).resolves.toBe('next')
})
