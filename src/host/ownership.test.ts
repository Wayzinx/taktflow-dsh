import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireLease, createEngine, createInsights, defineWorkflow, human, initProject, readLease } from '@taktflow/core'
import { FsOwnership } from './ownership.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { RunOwnerMeta, SpaceHandle } from './types.js'

let space: SpaceHandle
const ownerships: FsOwnership[] = []
function own(hostId = 'first', ctx?: FakeHostContext, onLeaseLost?: (space: SpaceHandle) => void | Promise<void>): FsOwnership {
  const ownership = new FsOwnership({ hostId, ctx, onLeaseLost }); ownerships.push(ownership); return ownership
}
const actor = { type: 'human' as const, id: 'operator' }
const meta = (owner = 'dsh:first'): RunOwnerMeta => ({ owner, ownerSessionId: 'lead', createdAt: '2026-01-01T00:00:00.000Z', requestKey: 'key' })
async function staleLease() {
  await writeFile(path.join(space.stores.taktDir, 'lease.json'), JSON.stringify({
    owner: 'dsh:old', pid: 1, host: `${hostname()}-other`, acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 100,
  }))
}
beforeEach(async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-ownership-')))
  const stores = await initProject(root, { name: 'ownership' })
  space = { root, stores, insights: createInsights(stores) }
})
afterEach(async () => {
  vi.useRealTimers()
  for (const ownership of ownerships.splice(0)) await ownership.releaseAll().catch(() => {})
  vi.restoreAllMocks()
  await rm(space.root, { recursive: true, force: true })
})

describe('FsOwnership 租约', () => {
  it('同进程默认身份稳定，不把用户审计身份当 hostOwner', () => {
    expect(own().hostOwner).toBe('dsh:first')
    expect(new FsOwnership().hostOwner).toBe(new FsOwnership().hostOwner)
  })
  it('空闲获取、自己续约且保留 acquiredAt，只有一个竞争者成功', async () => {
    const first = own(), second = own('second')
    const results = await Promise.allSettled([first.ensureLease(space), second.ensureLease(space)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const lease = (await readLease(space.stores.taktDir))!
    const holder = lease.owner === first.hostOwner ? first : second
    await holder.ensureLease(space)
    expect((await readLease(space.stores.taktDir))?.acquiredAt).toBe(lease.acquiredAt)
    const error = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(error.reason).toMatchObject({ code: 'TAKT_LEASE_HELD' })
    expect(error.reason.message).toContain(lease.owner)
    expect(error.reason.message).toContain(lease.acquiredAt)
    expect(error.reason.hint).toContain('在对方处操作')
  })
  it('本机旧宿主进程已不存在（App 崩溃后重开）时自动接管；进程还在的同机租约不抢', async () => {
    const write = (pid: number) => writeFile(path.join(space.stores.taktDir, 'lease.json'), JSON.stringify({
      owner: 'dsh:crashed', pid, host: hostname(), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 100,
    }))
    await write(process.ppid)
    await expect(own().ensureLease(space)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
    await write(4_194_303)
    await own('second').ensureLease(space)
    expect((await readLease(space.stores.taktDir))?.owner).toBe('dsh:second')
  })

  it('stale 不自动接管，人工 takeover 只允许失效的外部租约', async () => {
    const ownership = own()
    await expect(ownership.takeover(space, actor)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
    await staleLease()
    await expect(ownership.ensureLease(space)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD', hint: expect.stringContaining('人工确认') })
    expect((await readLease(space.stores.taktDir))?.owner).toBe('dsh:old')
    await ownership.takeover(space, actor)
    expect((await readLease(space.stores.taktDir))?.owner).toBe(ownership.hostOwner)
    await expect(ownership.takeover(space, actor)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
  })
  it('不能接管活宿主，即使相同 host 的 heartbeat 已过期但 pid 仍活着', async () => {
    await acquireLease(space.stores.taktDir, 'cli:live', { now: () => new Date('2026-01-01'), ttlMs: 1 })
    await expect(own().takeover(space, actor)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
    expect((await readLease(space.stores.taktDir))?.owner).toBe('cli:live')
  })
  it('release 只释放自己，重复释放无副作用', async () => {
    const first = own(), second = own('second')
    await first.ensureLease(space)
    await second.release(space)
    expect((await readLease(space.stores.taktDir))?.owner).toBe(first.hostOwner)
    await first.release(space); await first.release(space); await first.releaseAll()
    expect(await readLease(space.stores.taktDir)).toBeUndefined()
  })
  it('续约失败停止定时器并回调；以后 ensureLease 重新检查当前 owner', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = new FakeHostContext()
    let lost!: () => void
    const lostPromise = new Promise<void>((resolve) => { lost = resolve })
    const onLost = vi.fn(() => { lost() })
    const ownership = own('first', ctx, onLost)
    await ownership.ensureLease(space)
    expect(ctx.effects.some((effect) => effect.label === 'taktflow:lease-heartbeat')).toBe(true)
    await staleLease()
    await vi.advanceTimersByTimeAsync(10_000)
    await lostPromise
    expect(onLost).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onLost).toHaveBeenCalledOnce()
    await expect(ownership.ensureLease(space)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
    await ctx.dispose()
  })
  it('释放与已排队续约不互相重建租约；ctx effect 清理只停续约', async () => {
    vi.useFakeTimers()
    const ctx = new FakeHostContext(), ownership = own('first', ctx)
    await ownership.ensureLease(space)
    vi.advanceTimersByTime(10_000)
    await ownership.release(space)
    expect(ctx.effects.filter((effect) => effect.label === 'taktflow:lease-heartbeat')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await readLease(space.stores.taktDir)).toBeUndefined()
    await ownership.ensureLease(space)
    await ctx.dispose()
    expect((await readLease(space.stores.taktDir))?.owner).toBe(ownership.hostOwner)
    await ownership.release(space)
    expect(await readLease(space.stores.taktDir)).toBeUndefined()
  })
  it('主动释放后迟到的续约失败不通知租约丢失，也不影响重新获取', async () => {
    vi.useFakeTimers()
    const ctx = new FakeHostContext(), onLost = vi.fn()
    const ownership = own('first', ctx, onLost)
    await ownership.ensureLease(space)
    await staleLease()
    vi.advanceTimersByTime(10_000)
    await ownership.release(space)
    await Promise.resolve()
    expect(onLost).not.toHaveBeenCalled()
    expect(ctx.effects.filter((effect) => effect.label === 'taktflow:lease-heartbeat')).toHaveLength(0)
    await rm(path.join(space.stores.taktDir, 'lease.json'))
    await ownership.ensureLease(space)
    expect(ctx.effects.filter((effect) => effect.label === 'taktflow:lease-heartbeat')).toHaveLength(1)
    await ownership.release(space)
    expect(ctx.effects.filter((effect) => effect.label === 'taktflow:lease-heartbeat')).toHaveLength(0)
    await ctx.dispose()
  })
  it('租约损坏不能当空闲空间抢占', async () => {
    await writeFile(path.join(space.stores.taktDir, 'lease.json'), '{}')
    await expect(own().ensureLease(space)).rejects.toThrow('损坏')
  })
})

describe('FsOwnership 运行归属', () => {
  it('原子写读与 preset 合并；身份不可覆盖，终止原因同值幂等', async () => {
    const ownership = own()
    expect(await ownership.readRun(space, 'run-test')).toBeUndefined()
    await ownership.recordRun(space, 'run-test', meta())
    await ownership.recordRun(space, 'run-test', { ...meta(), presets: { a: { id: 'preset-a', cfgHash: 'hash-a' } } })
    await ownership.recordRun(space, 'run-test', { ...meta(), presets: { b: { id: 'preset-b', cfgHash: 'hash-b' } } })
    const endReason = { reason: 'host_lost' as const, at: '2026-01-02T00:00:00.000Z' }
    await ownership.setEndReason(space, 'run-test', endReason)
    await ownership.setEndReason(space, 'run-test', { ...endReason, at: '2026-01-03T00:00:00.000Z' })
    await ownership.recordRun(space, 'run-test', meta())
    const result = await ownership.readRun(space, 'run-test')
    expect(result?.endReason).toEqual(endReason)
    expect(Object.keys(result?.presets ?? {})).toEqual(['a', 'b'])
    await expect(ownership.recordRun(space, 'run-test', meta('dsh:other'))).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    await expect(ownership.setEndReason(space, 'run-test', { ...endReason, reason: 'lead_offline' })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    expect(JSON.parse(await readFile(path.join(space.stores.taktDir, 'runs', 'run-test', 'owner.json'), 'utf8'))).toEqual(result)
  })
  it('只有持有租约的宿主可接回 waiting_human，保留 session 与原始创建信息', async () => {
    const requirement = await space.stores.workspaces.createRequirement({ title: '恢复' })
    const workflow = defineWorkflow({ id: 'approval', title: '审批', version: '1', stages: [], nodes: [human({ id: 'ask', title: '询问', ask: '确认', form: 'approve' })] })
    const state = await createEngine({ stores: space.stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: requirement.id, workflow })
    const ownership = own()
    await ownership.recordRun(space, state.runId, meta('dsh:old'))
    await expect(ownership.recordRun(space, state.runId, meta())).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    await ownership.ensureLease(space)
    await expect(ownership.recordRun(space, state.runId, { ...meta(), ownerSessionId: 'different' })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    await ownership.recordRun(space, state.runId, meta())
    expect(await ownership.readRun(space, state.runId)).toEqual(meta())
  })
  it('并发写不同原因只有一方成功', async () => {
    const first = own(), second = own('second')
    await first.recordRun(space, 'run-race', meta())
    const at = new Date().toISOString()
    const results = await Promise.allSettled([
      first.setEndReason(space, 'run-race', { reason: 'host_lost', at }),
      second.setEndReason(space, 'run-race', { reason: 'lead_offline', at }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'TAKT_RUN_BUSY' })
  })
  it('拒绝 runId 穿越、owner 符号链接和损坏记录', async () => {
    const ownership = own()
    await expect(ownership.recordRun(space, '../escape', meta())).rejects.toThrow()
    await mkdir(path.join(space.stores.taktDir, 'runs', 'run-link'))
    await symlink(path.join(space.root, 'outside.json'), path.join(space.stores.taktDir, 'runs', 'run-link', 'owner.json'))
    await expect(ownership.readRun(space, 'run-link')).rejects.toThrow('符号链接')
    await expect(ownership.recordRun(space, 'run-link', meta())).rejects.toThrow('符号链接')
    await ownership.recordRun(space, 'run-bad', meta())
    await writeFile(path.join(space.stores.taktDir, 'runs', 'run-bad', 'owner.json'), '{}')
    await expect(ownership.readRun(space, 'run-bad')).rejects.toThrow('损坏')
    await expect(ownership.setEndReason(space, 'run-missing', { reason: 'host_lost', at: new Date().toISOString() })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
  })
  it('takeover 补取消 foreign running，关闭待办、需求状态和事件；保留 waiting_human', async () => {
    const requirement = await space.stores.workspaces.createRequirement({ title: '接管' })
    const workflow = defineWorkflow({ id: 'approval', title: '审批', version: '1', stages: [], nodes: [human({ id: 'ask', title: '询问', ask: '确认', form: 'approve' })] })
    const engine = createEngine({ stores: space.stores, profiles: {}, harnesses: {}, knowledge: [] })
    const orphan = await engine.start({ requirementId: requirement.id, workflow })
    orphan.status = 'running'
    await space.stores.runs.save(orphan)
    const ownership = own()
    await ownership.recordRun(space, orphan.runId, meta('dsh:old'))
    const secondReq = await space.stores.workspaces.createRequirement({ title: '等待人' })
    const waiting = await engine.start({ requirementId: secondReq.id, workflow })
    await ownership.recordRun(space, waiting.runId, { ...meta('dsh:old'), requestKey: 'waiting' })
    await staleLease()
    await ownership.takeover(space, actor)
    expect((await space.stores.runs.get(orphan.runId))?.status).toBe('cancelled')
    expect((await ownership.readRun(space, orphan.runId))?.endReason?.reason).toBe('host_lost')
    expect(await space.stores.attention.list({ pending: true, requirementId: requirement.id })).toEqual([])
    expect((await space.stores.events.read(orphan.runId)).some((event) => event.type === 'run.finished' && (event.data as { status?: string }).status === 'cancelled')).toBe(true)
    expect((await space.stores.workspaces.getRequirement(requirement.id))?.status).not.toBe('running')
    expect((await space.stores.runs.get(waiting.runId))?.status).toBe('waiting_human')
    expect((await ownership.readRun(space, waiting.runId))?.endReason).toBeUndefined()
  })

  it.each(['ensureLease', 'takeover'] as const)('人工接管取消落盘失败后，%s 仅补偿已标记旧运行', async (retry) => {
    const workflow = defineWorkflow({ id: 'approval-retry', title: '审批', version: '1', stages: [], nodes: [human({ id: 'ask', title: '询问', ask: '确认', form: 'approve' })] })
    const engine = createEngine({ stores: space.stores, profiles: {}, harnesses: {}, knowledge: [] })
    const ownership = own()
    const create = async (title: string, status: 'running' | 'waiting_human', owner = 'dsh:old') => {
      const requirement = await space.stores.workspaces.createRequirement({ title })
      const state = await engine.start({ requirementId: requirement.id, workflow })
      state.status = status
      await space.stores.runs.save(state)
      await ownership.recordRun(space, state.runId, { ...meta(owner), requestKey: title })
      return state
    }
    const orphans = [await create('旧运行一', 'running'), await create('旧运行二', 'running')]
    const waiting = await create('仍等待人', 'waiting_human')
    const current = await create('本宿主运行', 'running', ownership.hostOwner)
    await staleLease()
    const save = vi.spyOn(space.stores.runs, 'save').mockRejectedValueOnce(new Error('取消保存故障'))
    await expect(ownership.takeover(space, actor)).rejects.toThrow('取消保存故障')
    expect((await readLease(space.stores.taktDir))?.owner).toBe(ownership.hostOwner)
    for (const orphan of orphans) {
      expect((await ownership.readRun(space, orphan.runId))?.endReason?.reason).toBe('host_lost')
      expect((await space.stores.runs.get(orphan.runId))?.status).toBe('running')
    }
    save.mockRestore()
    // 接管之后出现的新外部条目没有人工标记，重试不能顺带取消它。
    const unmarked = await create('未授权的新外部运行', 'running', 'dsh:unconfirmed')
    if (retry === 'ensureLease') await ownership.ensureLease(space)
    else await ownership.takeover(space, actor)
    for (const orphan of orphans) {
      expect((await space.stores.runs.get(orphan.runId))?.status).toBe('cancelled')
      expect(await space.stores.attention.list({ pending: true, requirementId: orphan.requirementId })).toEqual([])
      expect((await space.stores.events.read(orphan.runId)).some((event) => event.type === 'run.finished' && (event.data as { status?: string }).status === 'cancelled')).toBe(true)
    }
    expect((await space.stores.runs.get(waiting.runId))?.status).toBe('waiting_human')
    expect((await space.stores.runs.get(current.runId))?.status).toBe('running')
    expect((await space.stores.runs.get(unmarked.runId))?.status).toBe('running')
    expect((await ownership.readRun(space, unmarked.runId))?.endReason).toBeUndefined()
    await ownership.ensureLease(space)
    await expect(ownership.takeover(space, actor)).rejects.toMatchObject({ code: 'TAKT_LEASE_HELD' })
  })
})
