import { describe, expect, it, vi } from 'vitest'
import { apply, createService, inject, name } from './index.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import { VERSION } from '../version.js'
import type { TaktflowService } from './types.js'
import { P0_DELIVERY_ID } from '../workflows/p0-delivery.js'

describe('taktflow 宿主行', () => {
  it('行名与 inject 名单固定', () => {
    expect(name).toBe('taktflow')
    expect(inject).toEqual(['connection', 'subagents', 'agents', 'tools'])
  })

  it('apply 注册服务和全部路由，dispose 后全部注销且幂等', async () => {
    const ctx = new FakeHostContext()
    apply(ctx, {})
    const service = ctx.get<TaktflowService>('taktflow')!
    const cleanup = vi.spyOn(service.runs, 'disposeAll').mockImplementation(async () => {
      expect(ctx.get('taktflow')).toBe(service)
      expect(ctx.routes).toHaveLength(4)
    })

    expect(ctx.get('taktflow')).toBeDefined()
    expect(ctx.provided.map((entry) => entry.name)).toContain('taktflow')
    expect(ctx.routes.map((route) => route.path).sort()).toEqual([
      '/api/taktflow',
      '/api/taktflow.op',
      '/api/taktflow.ping',
      '/api/taktflow.stream',
    ])

    const ping = ctx.routes.find((route) => route.path === '/api/taktflow.ping')!
    const response = await ping.fetch(new Request('http://127.0.0.1/api/taktflow.ping'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, version: VERSION, spaces: [] })

    await ctx.dispose()
    expect(ctx.routes).toHaveLength(0)
    expect(ctx.get('taktflow')).toBeUndefined()

    await ctx.dispose()
    expect(ctx.routes).toHaveLength(0)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('审计用户不改变宿主身份；随包流程目录包含 p0-delivery', () => {
    expect(createService({ user: 'first' }).ownership.hostOwner).toBe(
      createService({ user: 'second' }).ownership.hostOwner,
    )
    expect(createService().workflows.ids()).toContain(P0_DELIVERY_ID)
  })
})
