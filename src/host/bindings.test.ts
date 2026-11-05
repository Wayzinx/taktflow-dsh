import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInsights, initProject, type Actor } from '@taktflow/core'
import {
  bindingsFile,
  bindingsUser,
  createBindings,
  rememberBindingsUser,
} from './bindings.js'
import { TaktToolError } from './types.js'
import type { EndReason, Ownership, RunOwnerMeta, SpaceHandle } from './types.js'

const alice: Actor = { type: 'human', id: 'alice' }
const bob: Actor = { type: 'human', id: 'bob' }

class FakeOwnership implements Ownership {
  readonly hostOwner = 'dsh:test-host'
  ensureCalls = 0
  failure: Error | undefined

  async ensureLease(_space: SpaceHandle): Promise<void> {
    this.ensureCalls += 1
    if (this.failure !== undefined) throw this.failure
  }

  async release(): Promise<void> {}
  async takeover(): Promise<void> {}
  async recordRun(_space: SpaceHandle, _runId: string, _meta: RunOwnerMeta): Promise<void> {}
  async readRun(): Promise<RunOwnerMeta | undefined> {
    return undefined
  }
  async setEndReason(_space: SpaceHandle, _runId: string, _endReason: EndReason): Promise<void> {}
}

let root: string
let space: SpaceHandle
let ownership: FakeOwnership

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'taktflow-bindings-'))
  const stores = await initProject(root, { name: 'bindings-test' })
  space = { root, stores, insights: createInsights(stores) }
  ownership = new FakeOwnership()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createBindings', () => {
  it('未绑定时两个方向都返回 undefined', async () => {
    const bindings = createBindings({ ownership })
    await expect(bindings.byRequirement(space, 'REQ-001')).resolves.toBeUndefined()
    await expect(bindings.bySession(space, 'session-1')).resolves.toBeUndefined()
  })

  it('bind 后两个方向都能查到，并记录人和时间', async () => {
    const bindings = createBindings({ ownership })
    await bindings.bind(space, 'REQ-001', 'session-1', alice)

    await expect(bindings.byRequirement(space, 'REQ-001')).resolves.toBe('session-1')
    await expect(bindings.bySession(space, 'session-1')).resolves.toBe('REQ-001')

    const file = JSON.parse(await readFile(bindingsFile(space), 'utf8')) as {
      version: number
      bindings: Array<{ requirementId: string; sessionId: string; by: Actor; boundAt: string }>
    }
    expect(file.version).toBe(1)
    expect(file.bindings).toHaveLength(1)
    expect(file.bindings[0]?.requirementId).toBe('REQ-001')
    expect(file.bindings[0]?.sessionId).toBe('session-1')
    expect(file.bindings[0]?.by).toEqual(alice)
    expect(Number.isFinite(Date.parse(file.bindings[0]!.boundAt))).toBe(true)
    expect(ownership.ensureCalls).toBe(1)
  })

  it('同一对（需求、会话）重复 bind 是幂等操作', async () => {
    const bindings = createBindings({ ownership })
    await bindings.bind(space, 'REQ-001', 'session-1', alice)
    const first = JSON.parse(await readFile(bindingsFile(space), 'utf8')) as {
      bindings: Array<{ boundAt: string }>
    }

    await bindings.bind(space, 'REQ-001', 'session-1', bob)
    const second = JSON.parse(await readFile(bindingsFile(space), 'utf8')) as {
      bindings: Array<{ boundAt: string }>
    }
    expect(second.bindings).toHaveLength(1)
    expect(second.bindings[0]?.boundAt).toBe(first.bindings[0]?.boundAt)
  })

  it('需求已被其它会话绑定时明确拒绝', async () => {
    const bindings = createBindings({ ownership })
    await bindings.bind(space, 'REQ-001', 'session-1', alice)

    await expect(bindings.bind(space, 'REQ-001', 'session-2', bob)).rejects.toMatchObject({
      name: 'TaktToolError',
      code: 'TAKT_NOT_BOUND',
    })
    await expect(bindings.byRequirement(space, 'REQ-001')).resolves.toBe('session-1')
  })

  it('会话已绑定其它需求时明确拒绝', async () => {
    const bindings = createBindings({ ownership })
    await bindings.bind(space, 'REQ-001', 'session-1', alice)

    await expect(bindings.bind(space, 'REQ-002', 'session-1', alice)).rejects.toMatchObject({
      name: 'TaktToolError',
      code: 'TAKT_NOT_BOUND',
    })
    await expect(bindings.byRequirement(space, 'REQ-002')).resolves.toBeUndefined()
  })

  it('并发绑定同一需求时只有一个会话成功', async () => {
    const first = createBindings({ ownership })
    const second = createBindings({ ownership })
    const results = await Promise.allSettled([
      first.bind(space, 'REQ-001', 'session-1', alice),
      second.bind(space, 'REQ-001', 'session-2', bob),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(TaktToolError)
    expect((rejected[0]?.reason as TaktToolError).code).toBe('TAKT_NOT_BOUND')
    const bound = await first.byRequirement(space, 'REQ-001')
    expect(['session-1', 'session-2']).toContain(bound)
  })

  it('新实例能读到已落盘的绑定', async () => {
    await createBindings({ ownership }).bind(space, 'REQ-001', 'session-1', alice)
    const reopened = createBindings({ ownership })
    await expect(reopened.bySession(space, 'session-1')).resolves.toBe('REQ-001')
  })

  it('租约失败时不写绑定', async () => {
    const held = new TaktToolError('TAKT_LEASE_HELD', '空间被 CLI 占用', '在 dsh 主面板释放空间后重试。')
    ownership.failure = held
    const bindings = createBindings({ ownership })

    await expect(bindings.bind(space, 'REQ-001', 'session-1', alice)).rejects.toBe(held)
    await expect(bindings.byRequirement(space, 'REQ-001')).resolves.toBeUndefined()
  })

  it('绑定表损坏时按错误暴露，不当成空表', async () => {
    await mkdir(path.dirname(bindingsFile(space)), { recursive: true })
    await writeFile(bindingsFile(space), '{不是 JSON', 'utf8')
    const bindings = createBindings({ ownership })
    await expect(bindings.byRequirement(space, 'REQ-001')).rejects.toThrow(/不是合法 JSON/)
  })

  it('绑定表出现重复需求/会话时拒绝，不能按首条返回破坏双射', async () => {
    await mkdir(path.dirname(bindingsFile(space)), { recursive: true })
    const entry = (requirementId: string, sessionId: string) => ({
      requirementId,
      sessionId,
      by: alice,
      boundAt: new Date().toISOString(),
    })
    const duplicateRequirement = {
      version: 1,
      bindings: [entry('REQ-001', 'session-1'), entry('REQ-001', 'session-2')],
    }
    await writeFile(bindingsFile(space), JSON.stringify(duplicateRequirement), 'utf8')
    const bindings = createBindings({ ownership })
    await expect(bindings.byRequirement(space, 'REQ-001')).rejects.toThrow(/重复需求记录/)
    await expect(bindings.bySession(space, 'session-2')).rejects.toThrow(/重复需求记录/)
    await expect(bindings.bind(space, 'REQ-001', 'session-3', bob)).rejects.toThrow(/重复需求记录/)

    const duplicateSession = {
      version: 1,
      bindings: [entry('REQ-001', 'session-1'), entry('REQ-002', 'session-1')],
    }
    await writeFile(bindingsFile(space), JSON.stringify(duplicateSession), 'utf8')
    await expect(createBindings({ ownership }).bySession(space, 'session-1')).rejects.toThrow(/重复会话记录/)
  })

  it('重新绑定冲突的 hint 不承诺 P0 不存在的主面板功能', async () => {
    const bindings = createBindings({ ownership })
    await bindings.bind(space, 'REQ-001', 'session-1', alice)
    await expect(bindings.bind(space, 'REQ-001', 'session-2', bob)).rejects.toMatchObject({
      name: 'TaktToolError',
      code: 'TAKT_NOT_BOUND',
      hint: expect.stringContaining('P0 不支持重新绑定'),
    })
    await expect(bindings.bind(space, 'REQ-001', 'session-2', bob)).rejects.not.toMatchObject({
      hint: expect.stringContaining('主面板'),
    })
  })

  it('拒绝非法 ID 和非人 actor', async () => {
    const bindings = createBindings({ ownership })
    await expect(bindings.bind(space, '../REQ', 'session-1', alice)).rejects.toThrow(/非法需求 ID/)
    await expect(bindings.bind(space, 'REQ-001', 'session 1', alice)).rejects.toThrow(/非法会话 ID/)
    await expect(
      bindings.bind(space, 'REQ-001', 'session-1', { type: 'agent', role: 'lead', harness: 'dsh-host' }),
    ).rejects.toThrow(/by 必须是 human actor/)
  })

  it('配置人用 Symbol.for 非枚举属性挂在绑定对象上，跨 bundle 可读且不落盘', async () => {
    const bindings = createBindings({ ownership })
    expect(bindingsUser(bindings)).toBeUndefined()

    rememberBindingsUser(bindings, 'ConfigUser')
    expect(bindingsUser(bindings)).toBe('ConfigUser')

    const key = Symbol.for('taktflow.host.bindings.user')
    expect(Object.getOwnPropertySymbols(bindings)).toContain(key)
    expect(Object.getOwnPropertyDescriptor(bindings, key)?.enumerable).toBe(false)
    expect(Object.keys(bindings)).not.toContain(key)
    expect(JSON.stringify(bindings)).not.toContain('ConfigUser')

    // 模拟另一个 bundle 通过全局注册表取同一个键，而不是依赖模块级 WeakMap。
    expect((bindings as unknown as Record<symbol, unknown>)[Symbol.for('taktflow.host.bindings.user')])
      .toBe('ConfigUser')
  })
})
