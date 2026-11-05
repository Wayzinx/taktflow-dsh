import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@taktflow/core'
import { DshRolePresets } from './presets.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { SpaceHandle } from './types.js'
import type { AgentPresetDefinition } from './dsh-types.js'

const profile: AgentProfile = {
  role: 'dev', title: '开发', description: '实现节点任务', instructions: '遵守已有接口',
  harness: { harness: 'dsh-host' }, skills: ['coding'], writeScope: ['out/**'], allowBash: false,
}
const space = { root: path.resolve('space-fixture') } as SpaceHandle
const writable = { readOnly: false, allowBash: false }

function fixture() {
  const ctx = new FakeHostContext()
  ctx.setService('agentPresets', ctx.agentPresets)
  const presets = new DshRolePresets(ctx, { profiles: { dev: profile } })
  return { ctx, presets }
}

describe('动态角色 preset', () => {
  it('并发租用共享一次注册，最后一个引用释放后注销，重复 release 幂等', async () => {
    const { ctx, presets } = fixture()
    const register = vi.spyOn(ctx.agentPresets, 'register')
    const list = vi.fn(ctx.agentPresets.list!)
    ctx.agentPresets.list = list
    const [first, second] = await Promise.all([presets.acquire(space, 'dev', writable), presets.acquire(space, 'dev', writable)])
    expect(first.id).toMatch(/^takt-[0-9a-f]{8}-dev-[0-9a-f]{8}$/)
    expect(second.id).toBe(first.id)
    expect(register).toHaveBeenCalledOnce()
    expect(list.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[0]!)
    await first.release()
    await first.release()
    expect(ctx.presets).toHaveLength(1)
    await second.release()
    expect(ctx.presets).toHaveLength(0)
    await ctx.dispose()
  })

  it('完整白名单行使用 name，必填配置齐全，角色参数真实传入', async () => {
    const { ctx, presets } = fixture()
    const handle = await presets.acquire(space, 'dev', { readOnly: true, allowBash: false })
    const rows = ctx.presets[0]!.plugins as Array<{ id: string; name: string; config?: Record<string, unknown> }>
    expect(rows.map((row) => row.name)).toEqual([
      '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context',
      '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-skill', 'taktflow/role',
    ])
    expect(rows.find((row) => row.id === 'tool-fs')!.config).toEqual({ write: false, edit: false })
    expect(rows.find((row) => row.id === 'agent-instructions')!.config).toEqual({ maxBytes: 65536 })
    expect(rows.find((row) => row.id === 'tool-fs-search')!.config).toEqual({ sampleOverCapGlobResults: false })
    expect(rows.at(-1)!.config).toMatchObject({ role: 'dev', spaceRoot: space.root, instructions: profile.instructions, skills: ['coding'] })
    await handle.release()
  })

  it('Cordis 每次读取服务返回新代理时，跨运行 fork 仍共享引用', async () => {
    const { ctx, presets } = fixture()
    const originalGet = ctx.get.bind(ctx)
    ctx.get = <T,>(name: string): T | undefined => name === 'agentPresets'
      ? new Proxy(ctx.agentPresets, {}) as T : originalGet<T>(name)
    const register = vi.spyOn(ctx.agentPresets, 'register')
    const [first, second] = await Promise.all([
      presets.acquire(space, 'dev', writable),
      presets.fork({ dev: profile }).acquire(space, 'dev', writable),
    ])
    expect(register).toHaveBeenCalledOnce()
    await first.release()
    expect(ctx.presets).toHaveLength(1)
    await second.release()
    expect(ctx.presets).toHaveLength(0)
  })

  it('同名声明存在时直接复用，不能注销不归本宿主创建的声明', async () => {
    const { ctx, presets } = fixture()
    const first = await presets.acquire(space, 'dev', writable)
    const definition = ctx.presets[0]!
    await first.release()
    const foreignDispose = await ctx.agentPresets.register(definition)
    const register = vi.spyOn(ctx.agentPresets, 'register')
    const second = await presets.acquire(space, 'dev', writable)
    expect(second.id).toBe(first.id)
    expect(register).not.toHaveBeenCalled()
    await second.release()
    expect(ctx.presets).toHaveLength(1)
    await foreignDispose()
  })

  it('register 已返回但组合 broken 时失败，并回滚声明', async () => {
    const { ctx, presets } = fixture()
    ctx.agentPresets.resolve = async (id) => ({ id, broken: 'missing service' })
    await expect(presets.acquire(space, 'dev', writable)).rejects.toThrow('missing service')
    expect(ctx.presets).toHaveLength(0)
  })

  it('注册失败不留下引用，下次可重试', async () => {
    const { ctx, presets } = fixture()
    const register = vi.spyOn(ctx.agentPresets, 'register').mockRejectedValueOnce(new Error('挂载失败'))
    await expect(presets.acquire(space, 'dev', writable)).rejects.toThrow('挂载失败')
    const handle = await presets.acquire(space, 'dev', writable)
    expect(register).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it('fork 固定运行开始时的档案，角色配置与权限变更会改变哈希', async () => {
    const { presets } = fixture()
    const mutable = { dev: structuredClone(profile) }
    const frozen = presets.fork(mutable)
    mutable.dev.instructions = '新的说明'
    const original = await presets.acquire(space, 'dev', writable)
    const same = await frozen.acquire(space, 'dev', writable)
    const changed = await presets.fork(mutable).acquire(space, 'dev', writable)
    const readOnly = await presets.acquire(space, 'dev', { readOnly: true, allowBash: false })
    expect(original.id).toBe(same.id)
    expect(changed.cfgHash).not.toBe(original.cfgHash)
    expect(readOnly.cfgHash).not.toBe(original.cfgHash)
    for (const handle of [original, same, changed, readOnly]) await handle.release()
  })

  it('服务缺失、未知角色与 shell 权限明确失败', async () => {
    const { presets } = fixture()
    await expect(new DshRolePresets().acquire(space, 'dev', writable)).rejects.toThrow('agentPresets 服务不可用')
    await expect(presets.acquire(space, 'missing', writable)).rejects.toMatchObject({ code: 'TAKT_FORBIDDEN_FOR_LEAD' })
    await expect(presets.acquire(space, 'dev', { ...writable, allowBash: true })).rejects.toMatchObject({ code: 'TAKT_UNSUPPORTED_NODE' })
    await expect(presets.fork({ dev: { ...profile, allowBash: true } }).acquire(space, 'dev', writable)).rejects.toMatchObject({ code: 'TAKT_UNSUPPORTED_NODE' })
  })

  it('等待异步注销完成后才允许同配置重新注册', async () => {
    const { ctx, presets } = fixture()
    let complete!: () => void
    const pending = new Promise<void>((resolve) => { complete = resolve })
    const original = ctx.agentPresets.register
    ctx.agentPresets.register = vi.fn(async (definition: AgentPresetDefinition) => {
      const dispose = await original(definition)
      return async () => { await pending; await dispose() }
    })
    const first = await presets.acquire(space, 'dev', writable)
    const release = Promise.resolve(first.release())
    const second = presets.acquire(space, 'dev', writable)
    await Promise.resolve()
    expect(ctx.agentPresets.register).toHaveBeenCalledOnce()
    complete()
    await release
    const next = await second
    expect(ctx.agentPresets.register).toHaveBeenCalledTimes(2)
    await next.release()
  })

  it('异步注销错误传给等待者，不被旁路 catch 吞掉', async () => {
    const { ctx, presets } = fixture()
    const original = ctx.agentPresets.register
    ctx.agentPresets.register = async (definition) => {
      const dispose = await original(definition)
      return async () => { await dispose(); throw new Error('注销失败') }
    }
    const handle = await presets.acquire(space, 'dev', writable)
    await expect(Promise.resolve(handle.release())).rejects.toThrow('注销失败')
    await expect(Promise.resolve(handle.release())).rejects.toThrow('注销失败')
  })
})
