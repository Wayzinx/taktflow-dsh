import { expect, it, vi } from 'vitest'
import { apply } from './index.js'
import type { Disposer, EffectBody } from './dsh-types.js'
import { FsOwnership } from './ownership.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { TaktflowService } from './types.js'

/** 模拟 Cordis：同 effect 内嵌套资源逆序清理，顶层 effect 并发卸载。 */
class ParallelUnloadContext extends FakeHostContext {
  readonly topLevel: Disposer[] = []
  private readonly nesting: Disposer[][] = []

  override effect(execute: () => EffectBody, label?: string): Disposer {
    const parent = this.nesting.at(-1)
    const children: Disposer[] = []
    this.nesting.push(children)
    let dispose: Disposer
    try {
      dispose = super.effect(() => {
        const body = execute()
        if (typeof body !== 'function') throw new Error('本测试的同步注册必须返回清理函数')
        return async () => {
          await body()
          for (const child of [...children].reverse()) await child()
        }
      }, label)
    } finally { this.nesting.pop() }
    if (parent) parent.push(dispose)
    else this.topLevel.push(dispose)
    return dispose
  }
}

it('真实Cordis式并发顶层卸载：先等runs，再lease，最后移除guard/route/service', async () => {
  const ctx = new ParallelUnloadContext()
  apply(ctx)
  expect(ctx.topLevel).toHaveLength(1)
  const service = ctx.get<TaktflowService>('taktflow')!
  const order: string[] = []
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  vi.spyOn(service.runs, 'disposeAll').mockImplementation(async () => { order.push('runs'); await gate })
  vi.spyOn(service.ownership as FsOwnership, 'releaseAll').mockImplementation(async () => {
    order.push('lease')
    expect(ctx.guards).toHaveLength(1)
    expect(ctx.routes).toHaveLength(7)
    expect(ctx.get('taktflow')).toBe(service)
  })
  const unloading = Promise.all(ctx.topLevel.map((dispose) => dispose()))
  await vi.waitFor(() => expect(order).toEqual(['runs']))
  expect(ctx.get('taktflow')).toBe(service)
  expect(ctx.guards).toHaveLength(1)
  finish()
  await unloading
  expect(order).toEqual(['runs', 'lease'])
  expect(ctx.get('taktflow')).toBeUndefined()
  expect(ctx.routes).toHaveLength(0)
  expect(ctx.guards).toHaveLength(0)
  await ctx.dispose()
})
