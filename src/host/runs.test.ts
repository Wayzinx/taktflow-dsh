import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, human, initProject, readLease, type AgentProfile, type NodeDef, type WorkflowDefinition } from '@taktflow/core'
import type { Agent, SubagentActivationSpec, SubagentResult } from './dsh-types.js'
import { DshRunManager } from './runs.js'
import { FsOwnership } from './ownership.js'
import { InMemoryPermissionRegistry } from './permissions.js'
import { FsSpaceRegistry } from './space.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { RolePresets, SpaceHandle } from './types.js'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const by = { type: 'human' as const, id: 'tester' }
const simple = () => [agent({ id: 'work', title: '执行', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '完成任务', writeScope: [] })]
const definition = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'test', version: '1', title: '测试', stages: [], nodes })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(nodes: NodeDef[] = simple()) {
  const root = await mkdtemp(join(tmpdir(), 'takt-runs-'))
  roots.push(root)
  const stores = await initProject(root)
  const roleFile = join(stores.taktDir, 'agents/dev.md')
  const roleText = (instructions = '原始角色') => `---\nrole: dev\nharness: dsh-host\nwriteScope: []\nskills: []\n---\n${instructions}\n`
  await writeFile(roleFile, roleText())
  const spaces = new FsSpaceRegistry()
  const space = await spaces.open(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '执行层验证' })).id
  const ctx = new FakeHostContext()
  const lead: Agent = { id: 'lead', options: {}, session: { header: { id: 'lead', cwd: root, agentPreset: 'taktflow' } }, inject() {}, followup() {} }
  ctx.agents.get = (id) => id === lead.id ? lead : undefined
  const ownership = new FsOwnership({ ctx, hostId: 'runs-test' })
  const permissions = new InMemoryPermissionRegistry()
  const acquired: AgentProfile[][] = []
  const presets: RolePresets & { fork(profiles: Record<string, AgentProfile>): RolePresets } = {
    acquire: vi.fn(async () => ({ id: 'test-preset', cfgHash: 'test-hash', release() {} })),
    fork(profiles) { acquired.push(Object.values(profiles)); return this },
  }
  let workflow = definition(nodes)
  const workflows = { ids: () => ['test'], load: vi.fn(async () => workflow) }
  const manager = new DshRunManager({ ctx, spaces, ownership, presets, permissions, workflows, log() {} })
  cleanups.push(async () => { await manager.disposeAll(); await ownership.releaseAll(); await ctx.dispose() })
  const input = { space, requirementId, workflowId: 'test', ownerSessionId: 'lead', requestKey: 'start-1' }
  const setWorkflow = (next: WorkflowDefinition) => { workflow = next }
  return { root, stores, space, spaces, ctx, lead, ownership, permissions, presets, acquired, workflows, manager, input, roleFile, roleText, setWorkflow }
}

async function status(space: SpaceHandle, runId: string, expected: string): Promise<void> {
  await vi.waitFor(async () => expect((await space.stores.runs.get(runId))?.status).toBe(expected), { timeout: 4_000, interval: 10 })
}

describe('RunManager 真实 core 生命周期', () => {
  it('先发布owner和runId，同键并发只执行一次，其他键RUN_BUSY，取消等待清理', async () => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    const cleanup = deferred<void>()
    const disposed = vi.fn(async () => { result.resolve({ stopReason: 'cancelled', output: [] }); await cleanup.promise })
    f.ctx.subagents.startActivation = vi.fn(async (spec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: disposed }
    })
    const [first, duplicate] = await Promise.all([f.manager.start(f.input), f.manager.start(f.input)])
    expect(first.runId).toBe(duplicate.runId)
    expect([first.deduped, duplicate.deduped].sort()).toEqual([false, true])
    expect(await f.ownership.readRun(f.space, first.runId)).toMatchObject({ requestKey: 'start-1', ownerSessionId: 'lead' })
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    await expect(f.manager.start({ ...f.input, requestKey: 'start-2' })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    const cancelling = f.manager.cancel(f.space, first.runId, by)
    let cancelled = false
    void cancelling.then(() => { cancelled = true })
    await vi.waitFor(() => expect(disposed).toHaveBeenCalled())
    expect(cancelled).toBe(false)
    cleanup.resolve()
    await cancelling
    expect(f.permissions.lookup(f.ctx.activations[0]!.childId!)).toBeUndefined()
    await status(f.space, first.runId, 'cancelled')
    await expect(f.manager.cancel(f.space, first.runId, by)).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    await expect(f.manager.resume(f.space, first.runId, by)).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
  })

  it('缺角色在发布前拒绝；owner写失败在发布后把已创建状态收敛failed', async () => {
    const f = await fixture()
    // 随包默认角色始终存在，只有既非随包也未落盘的角色才算缺失。
    f.setWorkflow(definition([agent({ id: 'work', title: '执行', role: 'ghost', harness: { harness: 'dsh-host' }, prompt: '完成任务', writeScope: [] })]))
    await expect(f.manager.start(f.input)).rejects.toThrow('角色不存在')
    expect(await f.space.stores.runs.list()).toHaveLength(0)
    await writeFile(join(f.stores.taktDir, 'agents', 'ghost.md'), '---\nrole: ghost\nharness: dsh-host\nwriteScope: []\nskills: []\n---\n幽灵角色\n')
    vi.spyOn(f.ownership, 'recordRun').mockRejectedValueOnce(new Error('owner写入失败'))
    await expect(f.manager.start(f.input)).rejects.toThrow('owner写入失败')
    await vi.waitFor(async () => expect((await f.space.stores.runs.list())[0]?.status).toBe('failed'))
    expect(f.ctx.activations).toHaveLength(0)
  })

  it('Lead离线取消整条运行并保留恢复提示，不会死锁或派发子Agent', async () => {
    const f = await fixture()
    f.ctx.agents.get = () => undefined
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'cancelled')
    await vi.waitFor(async () => expect(await f.ownership.readRun(f.space, runId)).toMatchObject({ endReason: { reason: 'lead_offline' } }))
    await vi.waitFor(async () => expect(await f.space.stores.attention.list({ pending: true })).toHaveLength(1))
    expect(f.ctx.activations).toHaveLength(0)
    await f.manager.disposeAll()
    expect((await f.space.stores.attention.list({ pending: true }))[0]?.ask).toContain('重新启动')
  })

  it('disposeAll幂等，host_lost落账，子Agent清理完成后才释放lease', async () => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    const cleanup = deferred<void>()
    f.ctx.subagents.startActivation = async (spec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: async () => { result.resolve({ stopReason: 'cancelled', output: [] }); await cleanup.promise } }
    }
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    const stopping = f.manager.disposeAll()
    expect(f.manager.disposeAll()).toBe(stopping)
    await vi.waitFor(async () => expect(await f.ownership.readRun(f.space, runId)).toMatchObject({ endReason: { reason: 'host_lost' } }))
    expect(await readLease(f.space.stores.taktDir)).toBeDefined()
    cleanup.resolve()
    await stopping
    expect(await readLease(f.space.stores.taktDir)).toBeUndefined()
    await expect(f.manager.start({ ...f.input, requestKey: 'again' })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
  })

  it('waiting_human期间修改档案和流程，resume仍使用开始时的runtime', async () => {
    const f = await fixture([human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))])
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    await writeFile(f.roleFile, f.roleText('新的角色'))
    f.setWorkflow(definition(simple().map((node) => ({ ...node, id: 'replacement' }))))
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    const answered = await f.space.stores.attention.answer(item.requestId, { decision: 'approve', by })
    await f.manager.onAnswered(f.space, answered)
    await status(f.space, runId, 'succeeded')
    expect(f.workflows.load).toHaveBeenCalledTimes(1)
    expect(f.acquired[0]?.find((profile) => profile.role === 'dev')?.instructions).toBe('原始角色')
    expect(f.ctx.activations[0]?.label).toContain('/work#1')
    expect(await f.ownership.readRun(f.space, runId)).toMatchObject({ presets: { 'work#1': { id: 'test-preset' } } })
  })

  it('答案早于全局waiting_human落盘时不丢失，重复回调只派发一次', async () => {
    const blocker = deferred<void>()
    const f = await fixture([
      human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }),
      { kind: 'script', id: 'parallel', title: '并行任务', run: async () => blocker.promise },
      ...simple().map((node) => ({ ...node, needs: ['approval', 'parallel'] })),
    ])
    const { runId } = await f.manager.start(f.input)
    let item: Awaited<ReturnType<typeof f.space.stores.attention.list>>[number] | undefined
    await vi.waitFor(async () => { item = (await f.space.stores.attention.list({ pending: true }))[0]; expect(item).toBeDefined() })
    expect((await f.manager.get(f.space, runId))?.status).toBe('running')
    const answered = await f.space.stores.attention.answer(item!.requestId, { decision: 'approve', by })
    const answers = Promise.all([f.manager.onAnswered(f.space, answered), f.manager.onAnswered(f.space, answered)])
    blocker.resolve()
    await answers
    await status(f.space, runId, 'succeeded')
    expect(f.ctx.activations).toHaveLength(1)
  })

  it('重启恢复核验runtime身份，相同配置可恢复，变化拒绝且不派发', async () => {
    const f = await fixture([human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))])
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    await f.manager.disposeAll()
    const manager = new DshRunManager({ ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions, workflows: f.workflows, log() {} })
    cleanups.push(() => manager.disposeAll())
    await writeFile(f.roleFile, f.roleText('修改后'))
    await expect(manager.resume(f.space, runId, by)).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    expect(f.ctx.activations).toHaveLength(0)
    await writeFile(f.roleFile, f.roleText())
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    await f.space.stores.attention.answer(item.requestId, { decision: 'approve', by })
    await manager.resume(f.space, runId, by)
    await status(f.space, runId, 'succeeded')
    const saved = await readFile(join(f.space.stores.taktDir, 'runs', runId, 'dsh-runtime.json'), 'utf8')
    expect(saved).not.toContain('原始角色')
    expect(JSON.parse(saved)).toMatchObject({ version: 1, workflow: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('清理失败不伪装取消成功，卸载不释放lease且保留权限', async () => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    f.ctx.subagents.startActivation = async (spec: SubagentActivationSpec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: async () => { result.resolve({ stopReason: 'cancelled', output: [] }); throw new Error('清理失败') } }
    }
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    await expect(f.manager.cancel(f.space, runId, by)).rejects.toThrow()
    await expect(f.manager.disposeAll()).rejects.toThrow()
    expect(await readLease(f.space.stores.taktDir)).toBeDefined()
    expect(f.permissions.lookup(f.ctx.activations[0]!.childId!)).toBeDefined()
    // 故意失败用例的资源由测试显式释放；产品路径应保留租约防并发写入。
    await f.ownership.releaseAll()
  })

  it('同一会话同键跨需求并发提交仍只创建一次，卸载后cancel不能重获lease', async () => {
    const f = await fixture([human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' })])
    const secondRequirement = (await f.space.stores.workspaces.createRequirement({ title: '第二需求' })).id
    const [first, duplicate] = await Promise.all([
      f.manager.start(f.input), f.manager.start({ ...f.input, requirementId: secondRequirement }),
    ])
    expect(first.runId).toBe(duplicate.runId)
    expect(await f.space.stores.runs.list()).toHaveLength(1)
    await status(f.space, first.runId, 'waiting_human')
    await f.manager.disposeAll()
    await expect(f.manager.cancel(f.space, first.runId, by)).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    expect(await readLease(f.space.stores.taktDir)).toBeUndefined()
  })

  it.each(['cancel', 'dispose'] as const)('runId发布后run.started完成前%s不会死锁或启动子Agent', async (action) => {
    const f = await fixture()
    const gate = deferred<void>()
    const announced = deferred<void>()
    const append = f.space.stores.events.append.bind(f.space.stores.events)
    vi.spyOn(f.space.stores.events, 'append').mockImplementation(async (runId, event) => {
      const envelope = await append(runId, event)
      if (event.type === 'run.started') { announced.resolve(); await gate.promise }
      return envelope
    })
    const { runId } = await f.manager.start(f.input)
    await announced.promise
    const stopped = action === 'cancel' ? f.manager.cancel(f.space, runId, by) : f.manager.disposeAll()
    await status(f.space, runId, 'cancelled')
    gate.resolve()
    await stopped
    await status(f.space, runId, 'cancelled')
    expect(f.ctx.activations).toHaveLength(0)
    expect((await f.space.stores.workspaces.getRequirement(f.input.requirementId))?.status).not.toBe('running')
  })

  it('冷恢复准备期间卸载会等待准备退出，不会卸载后派发或遗留lease', async () => {
    const f = await fixture([human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))])
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    await f.space.stores.attention.answer(item.requestId, { decision: 'approve', by })
    await f.manager.disposeAll()
    const gate = deferred<void>()
    const loading = deferred<void>()
    const manager = new DshRunManager({
      ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions,
      workflows: { ids: f.workflows.ids, load: async () => { loading.resolve(); await gate.promise; return f.workflows.load() } }, log() {},
    })
    cleanups.push(() => manager.disposeAll())
    const restoring = manager.resume(f.space, runId, by)
    const rejected = expect(restoring).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY' })
    await loading.promise
    const stopping = manager.disposeAll()
    expect(await readLease(f.space.stores.taktDir)).toBeDefined()
    gate.resolve()
    await rejected
    await stopping
    expect(f.ctx.activations).toHaveLength(0)
    expect(await readLease(f.space.stores.taktDir)).toBeUndefined()
    expect((await f.manager.get(f.space, runId))?.status).toBe('waiting_human')
  })

  it('cancel已捕获无active的旧状态、start随后进入Runtime时仍不派发', async () => {
    const f = await fixture()
    const announced = deferred<void>()
    const startGate = deferred<void>()
    const cancelCaptured = deferred<void>()
    const cancelGate = deferred<void>()
    const nodeGate = deferred<void>()
    let nodeReady = false
    const append = f.space.stores.events.append.bind(f.space.stores.events)
    vi.spyOn(f.space.stores.events, 'append').mockImplementation(async (runId, event) => {
      const envelope = await append(runId, event)
      if (event.type === 'run.started') { announced.resolve(); await startGate.promise }
      if (event.type === 'node.ready') { nodeReady = true; await nodeGate.promise }
      return envelope
    })
    const { runId } = await f.manager.start(f.input)
    await announced.promise
    const get = f.space.stores.runs.get.bind(f.space.stores.runs)
    let reads = 0
    vi.spyOn(f.space.stores.runs, 'get').mockImplementation(async (id) => {
      const state = await get(id)
      reads++
      // 第一次是管理器校验，第二次是尚未找到active的core.cancel读取。
      if (reads === 2) { cancelCaptured.resolve(); await cancelGate.promise }
      return state
    })
    const cancelled = f.manager.cancel(f.space, runId, by)
    await cancelCaptured.promise
    startGate.resolve()
    await vi.waitFor(async () => expect(nodeReady || (await get(runId))?.status === 'cancelled').toBe(true))
    cancelGate.resolve()
    nodeGate.resolve()
    await cancelled
    expect(f.ctx.activations).toHaveLength(0)
    await status(f.space, runId, 'cancelled')
  })

  it('写host_lost原因被延迟时先取消执行，不能成功后才补异常原因', async () => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    f.ctx.subagents.startActivation = async (spec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: async () => { result.resolve({ stopReason: 'cancelled', output: [] }) } }
    }
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    const reasonStarted = deferred<void>()
    const reasonGate = deferred<void>()
    const setReason = f.ownership.setEndReason.bind(f.ownership)
    vi.spyOn(f.ownership, 'setEndReason').mockImplementation(async (...args) => {
      reasonStarted.resolve()
      await reasonGate.promise
      return setReason(...args)
    })
    const stopping = f.manager.disposeAll()
    await reasonStarted.promise
    result.resolve({ stopReason: 'completed', output: [] })
    await status(f.space, runId, 'cancelled')
    reasonGate.resolve()
    await stopping
    expect(await f.ownership.readRun(f.space, runId)).toMatchObject({ endReason: { reason: 'host_lost' } })
  })

  it('自然完成先赢shutdown竞争时保留succeeded且不写host_lost', async () => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    f.ctx.subagents.startActivation = async (spec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: async () => {} }
    }
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    const captured = deferred<void>()
    const gate = deferred<void>()
    const get = f.space.stores.runs.get.bind(f.space.stores.runs)
    let first = true
    vi.spyOn(f.space.stores.runs, 'get').mockImplementation(async (id) => {
      const state = await get(id)
      if (first) { first = false; captured.resolve(); await gate.promise }
      return state
    })
    const stopping = f.manager.disposeAll()
    await captured.promise
    result.resolve({ stopReason: 'completed', output: [] })
    await vi.waitFor(async () => expect((await get(runId))?.status).toBe('succeeded'))
    gate.resolve()
    await stopping
    expect((await get(runId))?.status).toBe('succeeded')
    expect((await f.ownership.readRun(f.space, runId))?.endReason).toBeUndefined()
  })

  it('相同函数源码但不同闭包的冷恢复明确拒绝，不能执行替换闭包', async () => {
    const executed: string[] = []
    const makeAction = (value: string) => async () => { executed.push(value) }
    const before = makeAction('before')
    const after = makeAction('after')
    expect(before.toString()).toBe(after.toString())
    const approval = human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' })
    const f = await fixture([approval, { id: 'script', kind: 'script', title: '闭包', needs: ['approval'], run: before }])
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    await f.space.stores.attention.answer(item.requestId, { decision: 'approve', by })
    await f.manager.disposeAll()
    f.setWorkflow(definition([approval, { id: 'script', kind: 'script', title: '闭包', needs: ['approval'], run: after }]))
    const manager = new DshRunManager({ ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions, workflows: f.workflows, log() {} })
    cleanups.push(() => manager.disposeAll())
    await expect(manager.resume(f.space, runId, by)).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY', message: expect.stringContaining('包含函数') })
    expect(executed).toEqual([])
    expect(f.ctx.activations).toHaveLength(0)
    expect((await f.manager.get(f.space, runId))?.status).toBe('waiting_human')
  })
})
