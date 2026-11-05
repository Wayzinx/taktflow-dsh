import { describe, expect, it } from 'vitest'
import { FakeHostContext } from './fake-ctx.js'

describe('FakeHostContext effect 生命周期', () => {
  it('await inject 得到普通 Fiber，其 dispose 只卸载本次注册', async () => {
    const ctx = new FakeHostContext()
    ctx.on('outside', () => {})
    const fiber = await ctx.inject(['tools'], (scoped) => {
      scoped.on('inside', () => {})
      scoped.skills.register({ name: 'test-skill', description: 'test', content: 'test', source: 'bundled' })
      scoped.provide('test-service', {})
    })

    expect('then' in fiber).toBe(false)
    expect(ctx.registeredSkills).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.listeners.map((listener) => listener.event)).toEqual(['outside'])
    expect(ctx.registeredSkills).toHaveLength(0)
    expect(ctx.get('test-service')).toBeUndefined()
    await ctx.dispose()
    expect(ctx.listeners).toHaveLength(0)
  })

  it('一个生成器清理失败仍执行其余 yield 的清理', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(function* () {
      yield () => { events.push('first') }
      yield () => { events.push('second'); throw new Error('cleanup failed') }
    })
    await expect(ctx.dispose()).rejects.toThrow('cleanup failed')
    expect(events).toEqual(['second', 'first'])
  })

  it('异步生成器注册中断仍清理已产生的资源', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(async function* () {
      yield () => { events.push('cleaned') }
      throw new Error('generator failed')
    })
    await expect(ctx.dispose()).rejects.toThrow('generator failed')
    expect(events).toEqual(['cleaned'])
  })

  it('同步生成器注册中断仍清理已产生的资源', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(function* () {
      yield () => { events.push('cleaned') }
      throw new Error('generator failed')
    })
    await expect(ctx.dispose()).rejects.toThrow('generator failed')
    expect(events).toEqual(['cleaned'])
  })

  it('异步 effect 在 dispose 前触发时先等注册完成再清理', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            events.push('registered')
            resolve(() => {
              events.push('disposed')
            })
          }, 5)
        }),
      'async',
    )

    const disposing = ctx.dispose()
    await disposing
    expect(events).toEqual(['registered', 'disposed'])
  })

  it('手动注销后再 dispose 不会重复清理', async () => {
    const ctx = new FakeHostContext()
    let disposed = 0
    const release = ctx.effect(() => () => {
      disposed += 1
    }, 'manual')

    await release()
    await release()
    await ctx.dispose()
    expect(disposed).toBe(1)
  })

  it('单个 effect 清理失败不会中断其它 effect，最后汇总抛错', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(() => () => {
      events.push('first')
      throw new Error('boom')
    }, 'failing')
    ctx.effect(() => () => {
      events.push('second')
    }, 'ok')

    await expect(ctx.dispose()).rejects.toThrow('boom')
    expect(events).toEqual(['second', 'first'])
  })

  it('异步 effect 注册失败也会继续清理其它 effect', async () => {
    const ctx = new FakeHostContext()
    const events: string[] = []
    ctx.effect(() => Promise.reject(new Error('register failed')), 'bad-async')
    ctx.effect(() => () => {
      events.push('cleaned')
    }, 'ok')

    await expect(ctx.dispose()).rejects.toThrow('register failed')
    expect(events).toEqual(['cleaned'])
  })

  it('dispose 后可重复调用且不再执行清理', async () => {
    const ctx = new FakeHostContext()
    let count = 0
    ctx.effect(() => () => {
      count += 1
    }, 'once')

    await ctx.dispose()
    await ctx.dispose()
    expect(count).toBe(1)
    expect(() => ctx.effect(() => () => {}, 'late')).toThrow('已 dispose')
  })
})
