import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative as relativePath } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agent, human, initProject, readLease, script, type AgentProfile, type AttentionItem, type HarnessRequest, type HarnessResult, type NodeDef, type WorkflowDefinition } from '@taktflow/core'
import { AgentTraceHub, agentTraceHubFor } from './agent-trace.js'
import { createApprovals } from './approvals.js'
import type { createDshHarness } from './dsh-harness.js'
import type { Agent, AgentPresetDefinition, SubagentActivationSpec, SubagentResult } from './dsh-types.js'
import { DshRolePresets } from './presets.js'
import type { RoleSkillSnapshots } from './role-skills.js'
import { DshRunManager } from './runs.js'
import { FsOwnership } from './ownership.js'
import { InMemoryPermissionRegistry } from './permissions.js'
import { FsSpaceRegistry } from './space.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { Approvals, RolePresets, SpaceHandle } from './types.js'

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

interface FixtureOptions {
  traces?: AgentTraceHub
  /** 用真实 DshRolePresets（会向 FakeHostContext.agentPresets 注册带 skillSnapshot 的组合）。 */
  realPresets?: boolean
  config?: { autonomy?: 'full' | 'checkpoints' | 'manual'; roleHarness?: 'dsh-host' | 'profile'; user?: string }
  harnessFactory?: typeof createDshHarness
  approvals?: Approvals
}

async function fixture(nodes: NodeDef[] = simple(), options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-runs-'))
  roots.push(root)
  const stores = await initProject(root)
  const roleFile = join(stores.paths.agents, 'dev.md')
  const roleText = (instructions = '原始角色', skills = '[]') => `---\nrole: dev\nharness: dsh-host\nwriteScope: []\nskills: ${skills}\n---\n${instructions}\n`
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
  const forkedSkills: RoleSkillSnapshots[] = []
  const stub = {
    acquire: vi.fn(async () => ({ id: 'test-preset', cfgHash: 'test-hash', release() {} })),
    fork(profiles: Record<string, AgentProfile>, skills?: RoleSkillSnapshots) {
      acquired.push(Object.values(profiles))
      if (skills !== undefined) forkedSkills.push(skills)
      return this
    },
  }
  const presets: RolePresets = options.realPresets === true
    ? (() => {
        ctx.setService('agentPresets', ctx.agentPresets)
        return new DshRolePresets(ctx)
      })()
    : stub
  let workflow = definition(nodes)
  const workflows = { ids: () => ['test'], load: vi.fn(async () => workflow) }
  const manager = new DshRunManager({
    ctx, spaces, ownership, presets, permissions, workflows, log() {},
    ...(options.traces === undefined ? {} : { traces: options.traces }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.harnessFactory === undefined ? {} : { harnessFactory: options.harnessFactory }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
  })
  cleanups.push(async () => { await manager.disposeAll(); await ownership.releaseAll(); await ctx.dispose() })
  const input = { space, requirementId, workflowId: 'test', ownerSessionId: 'lead', requestKey: 'start-1' }
  const setWorkflow = (next: WorkflowDefinition) => { workflow = next }
  return { root, stores, space, spaces, ctx, lead, ownership, permissions, presets, acquired, forkedSkills, workflows, manager, input, roleFile, roleText, setWorkflow }
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
    await writeFile(join(f.stores.paths.agents, 'ghost.md'), '---\nrole: ghost\nharness: dsh-host\nwriteScope: []\nskills: []\n---\n幽灵角色\n')
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
    expect(JSON.parse(saved)).toMatchObject({ version: 2, workflow: expect.stringMatching(/^[a-f0-9]{64}$/) })
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

  it.each([
    ['经 withHostWrites 的 Lead 写入不算节点越界，运行成功', true, 'succeeded'],
    ['不经窗口的同一写入仍被算成节点越界（守卫没有被放宽）', false, 'failed'],
  ] as const)('节点执行期间 Lead 写决策记录：%s', async (_name, viaHost, expected) => {
    const f = await fixture()
    const result = deferred<SubagentResult>()
    f.ctx.subagents.startActivation = async (spec) => {
      f.ctx.activations.push(spec)
      return { childId: spec.childId!, result: result.promise, dispose: async () => {} }
    }
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(() => expect(f.ctx.activations).toHaveLength(1))
    // 和真实事故相同：节点（评审）还在执行，Lead 用已审计的产物写入记录决策
    const target = 'decisions/lead-notes.md'
    const relative = relativePath(f.space.stores.projectDir, join(f.space.stores.workspaces.dir(f.input.requirementId), target))
    const write = () => f.space.stores.workspaces.writeArtifact({
      ref: { workspace: f.input.requirementId, path: target }, content: '# Lead 决策\n', kind: 'decision',
      author: { type: 'agent', role: 'lead', harness: 'dsh', onBehalfOf: 'tester' }, reason: '记录人的授权',
    })
    if (viaHost) await f.manager.withHostWrites(f.space, [relative], write)
    else await write()
    result.resolve({ stopReason: 'completed', output: [] })
    await status(f.space, runId, expected)
    const events = await f.space.stores.events.read(runId)
    const violation = events.find((event) => event.type === 'guard.violation')
    if (viaHost) expect(violation).toBeUndefined()
    else expect(violation?.data).toMatchObject({ paths: [relative] })
  })

  it('提供追溯中心时，真实节点运行落盘 starting→completed，并冻结角色来源', async () => {
    const traces = new AgentTraceHub({ throttleMs: 10, log: () => {} })
    const f = await fixture(simple(), { traces })
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'succeeded')
    const records = await traces.read(f.space, runId)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      runId, nodeId: 'work', attempt: 1, role: 'dev', status: 'completed', stopReason: 'completed',
    })
    // 空间里的 dev.md 覆盖了随包角色，来源必须在开始时就冻结为 space。
    expect(records[0]!.profile).toMatchObject({ source: 'space', writeScope: [] })
    expect(records[0]!.preset).toEqual({ id: 'test-preset', cfgHash: 'test-hash', plugins: [] })
    expect(records[0]!.endedAt).toBeTypeOf('string')
    await traces.disposeAll()
  })

  it('未注入追溯中心时自建并登记到权限表，守卫和路由可共享同一实例', async () => {
    const f = await fixture()
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'succeeded')
    const shared = agentTraceHubFor(f.permissions)
    expect(shared).toBeInstanceOf(AgentTraceHub)
    expect(await shared!.read(f.space, runId)).toMatchObject([{ runId, nodeId: 'work', status: 'completed' }])
  })

  it('full 模式在引擎启动前克隆并关闭显式 args 的评审签字，输入对象不被修改', async () => {
    const f = await fixture(simple(), { config: { autonomy: 'full' } })
    const args = {
      review: { humanSignoff: true, maxRounds: 2 },
      reviews: { work: { humanSignoff: true, maxReworks: 3 } },
    }
    const { runId } = await f.manager.start({ ...f.input, args })
    await status(f.space, runId, 'succeeded')
    // core 的 configureReviews 优先使用 args；落盘状态必须已经是强制关闭后的版本。
    expect((await f.space.stores.runs.get(runId))?.args).toMatchObject({
      review: { humanSignoff: false, maxRounds: 2 },
      reviews: { work: { humanSignoff: false, maxReworks: 3 } },
    })
    expect(args.review.humanSignoff).toBe(true)
    expect(args.reviews.work.humanSignoff).toBe(true)
  })

  it('等待期间修改 SKILL.md 不会改变运行开始时冻结的角色技能快照', async () => {
    const f = await fixture(
      [human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))],
      { realPresets: true, config: { autonomy: 'manual' } },
    )
    await writeFile(f.roleFile, f.roleText('原始角色', '[demo]'))
    const skillDir = join(f.stores.paths.skills, 'demo')
    await mkdir(skillDir, { recursive: true })
    const skillFile = join(skillDir, 'SKILL.md')
    const skillText = (content: string) => `---\nname: demo\ndescription: 演示技能\n---\n${content}\n`
    await writeFile(skillFile, skillText('版本一'))
    const registered: AgentPresetDefinition[] = []
    const register = f.ctx.agentPresets.register.bind(f.ctx.agentPresets)
    f.ctx.agentPresets.register = async (definition) => {
      registered.push(structuredClone(definition))
      return register(definition)
    }
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    // 等待期间改技能文件：本次运行必须继续使用开始时冻结的正文。
    await writeFile(skillFile, skillText('版本二'))
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    const answered = await f.space.stores.attention.answer(item.requestId, { decision: 'approve', by })
    await f.manager.onAnswered(f.space, answered)
    await status(f.space, runId, 'succeeded')
    const rolePlugins = registered
      .flatMap((definition) => definition.plugins as Array<{ name?: string; config?: unknown }>)
      .filter((plugin) => plugin.name === 'taktflow/role')
    const snapshots = rolePlugins.map((plugin) => (plugin.config as { skillSnapshot?: Array<{ content: string }> }).skillSnapshot ?? [])
    expect(snapshots.flat().map((skill) => skill.content)).toContain('版本一')
    expect(JSON.stringify(registered)).not.toContain('版本二')
  })

  it('dsh-host 遇到空间 docker sandbox 在管理器层明确拒绝，不静默降级 local', async () => {
    const f = await fixture()
    const configFile = join(f.root, 'takt.config.json')
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    config.sandbox = { provider: 'docker' }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)
    await expect(f.manager.start(f.input)).rejects.toMatchObject({
      code: 'TAKT_UNSUPPORTED_NODE',
      message: expect.stringContaining('docker'),
    })
    expect(await f.space.stores.runs.list()).toHaveLength(0)
    expect(f.ctx.activations).toHaveLength(0)
  })

  it('自主代答后的 engine.resume 失败会把运行收敛 failed，不留无执行者的 running', async () => {
    const releaseAnswer = deferred<void>()
    const approvals: Approvals = {
      present: async () => {},
      answer: async () => { throw new Error('不应走人工入口') },
      async answerAsAgent() {
        await releaseAnswer.promise
        return { disposition: 'answer', answered: true }
      },
    }
    const fakeHarness = {
      id: 'dsh-host',
      displayName: 'fake dsh-host',
      capabilities: {},
      async available() { return { ok: true } },
      async run(_request: HarnessRequest): Promise<HarnessResult> {
        return {
          ok: true,
          finalText: '',
          structured: {
            disposition: 'answer', confidence: 0.95, evidence: [], blockers: [], unresolved: [],
            rationale: '冻结证据足够', answer: '按默认配置继续',
          },
        }
      },
      async drain() {},
    }
    const harnessFactory = (() => fakeHarness) as unknown as typeof createDshHarness
    const f = await fixture(
      [human({ id: 'approval', title: '答复', ask: '怎么继续？', form: 'answer' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))],
      { config: { autonomy: 'full', user: '审批人' }, harnessFactory, approvals },
    )
    const { runId } = await f.manager.start(f.input)
    await vi.waitFor(async () => expect((await f.space.stores.attention.list({ pending: true }))).toHaveLength(1))
    // drive 正在 answerAsAgent 里等闸门；此时替换 resume，模拟引擎恢复失败。
    const internals = f.manager as unknown as { records: Map<string, { engine: { resume(...args: unknown[]): Promise<unknown> } }> }
    const record = internals.records.get(`${f.space.root}\0${runId}`)
    expect(record).toBeDefined()
    record!.engine.resume = async () => { throw new Error('resume 注入失败') }
    releaseAnswer.resolve()
    await status(f.space, runId, 'failed')
    // fail() 先落 run 状态，run.finished 与 error log 随后异步写入；等两个最终事件都落盘再断言。
    await vi.waitFor(async () => {
      const events = await f.space.stores.events.read(runId)
      expect(events.some((event) => event.type === 'run.finished' && (event.data as { status: string }).status === 'failed')).toBe(true)
      expect(events.some((event) => event.type === 'log' && String((event.data as { message: string }).message).includes('resume 注入失败'))).toBe(true)
    }, { timeout: 5_000 })
  })

  it('历史运行缺 autonomy 时按 manual 恢复，不被新宿主 full 默认升级为自动批准', async () => {
    const f = await fixture(
      [human({ id: 'approval', title: '审批', ask: '批准？', form: 'approve' }), ...simple().map((node) => ({ ...node, needs: ['approval'] }))],
      { config: { autonomy: 'manual' } },
    )
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    await f.manager.disposeAll()
    // 模拟旧版本落盘的 owner：没有 autonomy 字段。
    const ownerFile = join(f.root, '.takt', 'runs', runId, 'owner.json')
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'))
    delete owner.autonomy
    await writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`)
    const answerAsAgent = vi.fn(async () => ({ disposition: 'answer' as const, answered: true }))
    const manager = new DshRunManager({
      ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions,
      workflows: f.workflows,
      approvals: { present: async () => {}, answer: async () => { throw new Error('不应走人工入口') }, answerAsAgent },
      // 新宿主默认 full；旧运行必须仍按开始时的 manual 语义恢复。
      config: { autonomy: 'full' },
      log() {},
    })
    cleanups.push(() => manager.disposeAll())
    await manager.resume(f.space, runId, by)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(answerAsAgent).not.toHaveBeenCalled()
    expect((await f.space.stores.runs.get(runId))?.status).toBe('waiting_human')
    const identity = JSON.parse(await readFile(join(f.space.stores.taktDir, 'runs', runId, 'dsh-runtime.json'), 'utf8'))
    expect(identity.autonomy).toBe('manual')
  })

  it('冷宿主终止 retry 经审批桥落账后直接取消，补记原始回答且不恢复函数', async () => {
    const executed: string[] = []
    const calls = { count: 0 }
    const fakeHarness = {
      id: 'dsh-host',
      displayName: 'fake dsh-host',
      capabilities: { usage: true },
      async available() { return { ok: true } },
      async run() {
        calls.count += 1
        return { ok: false, finalText: '', error: 'exit 7' }
      },
      async drain() {},
    }
    const harnessFactory = (() => fakeHarness) as unknown as typeof createDshHarness
    const f = await fixture([
      agent({ id: 'implement', title: '实现', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '实现', writeScope: [], retry: { max: 5 } }),
      // 函数节点让运行身份带 hasFunctions；它依赖 implement，不会被执行。
      script({ id: 'publish', title: '发布', needs: ['implement'], run: async () => { executed.push('publish') } }),
    ], { harnessFactory })
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    expect(calls.count).toBe(2)
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    expect(item).toMatchObject({ kind: 'retry', form: 'choice' })
    await f.manager.disposeAll()

    // 重启后的宿主没有 active runtime：终止回答必须走取消，不能冷恢复函数流程。
    const manager = new DshRunManager({
      ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions,
      workflows: f.workflows, harnessFactory, log() {},
    })
    cleanups.push(() => manager.disposeAll())
    const approvals = createApprovals({ ctx: f.ctx, ownership: f.ownership, runs: manager, config: { user: '审批人' } })
    const humanInput = { type: 'human' as const, id: '审批人', via: 'dsh-web' }
    const answered = await approvals.answer(f.space, {
      requestId: item.requestId, attempt: item.attempt!, decision: 'choice', answer: '终止运行', by: humanInput,
    })
    await status(f.space, runId, 'cancelled')

    const state = await f.space.stores.runs.get(runId)
    expect(state?.nodes.implement?.status).toBe('cancelled')
    expect(state?.nodes.publish?.status).toBe('pending')
    expect(executed).toEqual([])
    expect(calls.count).toBe(2)
    expect(f.ctx.activations).toHaveLength(0)
    const audits = await f.space.stores.events.read(runId, { types: ['human.answered'] })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      nodeId: 'implement',
      actor: humanInput,
      data: { requestId: item.requestId, decision: 'choice', answer: '终止运行' },
    })
    expect(await f.space.stores.events.verify(runId)).toEqual({ ok: true })

    // 重复回调与重复提交都不产生第二条审计。
    await manager.onAnswered(f.space, answered)
    await expect(approvals.answer(f.space, {
      requestId: item.requestId, attempt: item.attempt!, decision: 'choice', answer: '终止运行', by: humanInput,
    })).resolves.toBeDefined()
    expect(await f.space.stores.events.read(runId, { types: ['human.answered'] })).toHaveLength(1)
  })

  it('未持久化的伪造终止回答不能取消运行', async () => {
    const executed: string[] = []
    const calls = { count: 0 }
    const fakeHarness = {
      id: 'dsh-host',
      displayName: 'fake dsh-host',
      capabilities: { usage: true },
      async available() { return { ok: true } },
      async run() {
        calls.count += 1
        return { ok: false, finalText: '', error: 'exit 7' }
      },
      async drain() {},
    }
    const harnessFactory = (() => fakeHarness) as unknown as typeof createDshHarness
    const f = await fixture([
      agent({ id: 'implement', title: '实现', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '实现', writeScope: [], retry: { max: 5 } }),
      script({ id: 'publish', title: '发布', needs: ['implement'], run: async () => { executed.push('publish') } }),
    ], { harnessFactory })
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!
    await f.manager.disposeAll()
    const manager = new DshRunManager({
      ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions,
      workflows: f.workflows, harnessFactory, log() {},
    })
    cleanups.push(() => manager.disposeAll())

    // 磁盘上仍是未回答待办；调用方只在内存里伪造“已回答的终止选择”。
    const forged: AttentionItem = {
      ...item,
      answeredAt: new Date().toISOString(),
      answeredBy: { type: 'human', id: '审批人', via: 'dsh-web' },
      decision: 'choice',
      answer: '终止运行',
    }
    await expect(manager.onAnswered(f.space, forged)).rejects.toMatchObject({
      code: 'TAKT_RUN_BUSY', message: expect.stringContaining('包含函数'),
    })

    const state = await f.space.stores.runs.get(runId)
    expect(state?.status).toBe('waiting_human')
    expect(state?.nodes.implement?.status).toBe('blocked')
    expect((await f.space.stores.attention.list()).find((entry) => entry.requestId === item.requestId)?.answeredAt).toBeUndefined()
    expect(await f.space.stores.events.read(runId, { types: ['human.answered'] })).toEqual([])
    expect(calls.count).toBe(2)
    expect(executed).toEqual([])
    expect(f.ctx.activations).toHaveLength(0)
  })

  it('冷宿主非终止 retry 在落账前被预检拒绝，待办保持未回答', async () => {
    const executed: string[] = []
    const calls = { count: 0 }
    const fakeHarness = {
      id: 'dsh-host',
      displayName: 'fake dsh-host',
      capabilities: { usage: true },
      async available() { return { ok: true } },
      async run() {
        calls.count += 1
        return { ok: false, finalText: '', error: 'exit 7' }
      },
      async drain() {},
    }
    const harnessFactory = (() => fakeHarness) as unknown as typeof createDshHarness
    const f = await fixture([
      agent({ id: 'implement', title: '实现', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '实现', writeScope: [], retry: { max: 5 } }),
      script({ id: 'publish', title: '发布', needs: ['implement'], run: async () => { executed.push('publish') } }),
    ], { harnessFactory })
    const { runId } = await f.manager.start(f.input)
    await status(f.space, runId, 'waiting_human')
    const item = (await f.space.stores.attention.list({ pending: true }))[0]!

    // 同进程已有受管记录：预检直接放行，不重新加载 workflow。
    const loads = f.workflows.load.mock.calls.length
    await f.manager.assertResumeReady(f.space, runId)
    expect(f.workflows.load).toHaveBeenCalledTimes(loads)
    await f.manager.disposeAll()

    const manager = new DshRunManager({
      ctx: f.ctx, spaces: f.spaces, ownership: f.ownership, presets: f.presets, permissions: f.permissions,
      workflows: f.workflows, harnessFactory, log() {},
    })
    cleanups.push(() => manager.disposeAll())
    await expect(manager.assertResumeReady(f.space, runId)).rejects.toMatchObject({
      code: 'TAKT_RUN_BUSY', message: expect.stringContaining('包含函数'),
    })
    const approvals = createApprovals({ ctx: f.ctx, ownership: f.ownership, runs: manager, config: { user: '审批人' } })
    await expect(approvals.answer(f.space, {
      requestId: item.requestId, attempt: item.attempt!, decision: 'choice', answer: '再试一次',
      by: { type: 'human', id: '审批人', via: 'dsh-web' },
    })).rejects.toMatchObject({ code: 'TAKT_RUN_BUSY', message: expect.stringContaining('包含函数') })

    expect((await f.space.stores.runs.get(runId))?.status).toBe('waiting_human')
    expect((await f.space.stores.attention.list()).find((entry) => entry.requestId === item.requestId)?.answeredAt).toBeUndefined()
    expect(calls.count).toBe(2)
    expect(executed).toEqual([])
    expect(await f.space.stores.events.read(runId, { types: ['human.answered'] })).toEqual([])
  })
})
