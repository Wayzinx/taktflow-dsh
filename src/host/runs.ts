import { createEngine, type Actor, type AttentionItem, type Engine, type ProjectStores, type RunId, type RunState } from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import { updateRequirement } from '../../vendor/taktflow/packages/core/src/engine/requirement.js'
import type { HostContext } from './dsh-types.js'
import { createDshHarness, type DshHarness } from './dsh-harness.js'
import { assertRuntimeIdentity, loadRunRuntime, recordRuntimeIdentity, type RunRuntime } from './run-runtime.js'
import { TaktToolError, type EndReason, type Ownership, type PermissionRegistry, type RolePresets, type RunManager, type RunOwnerMeta, type SpaceHandle, type SpaceRegistry, type StartRunInput, type WorkflowCatalog } from './types.js'

/** 宿主行创建管理器；catalog 可由隔离 e2e 注入，生产只用随包目录。 */
export interface RunManagerDeps {
  ctx?: HostContext
  spaces: SpaceRegistry
  ownership: Ownership
  presets: RolePresets
  permissions: PermissionRegistry
  workflows: WorkflowCatalog
  /** 测试仅替换传输，仍走真实 engine 和 stores。 */
  harnessFactory?: typeof createDshHarness
  log?: (message: string) => void
}

interface ManagedRun extends RunRuntime {
  runId?: string
  meta: RunOwnerMeta
  engine: Engine
  harness: DshHarness
  task?: Promise<void>
  stopping?: Promise<void>
  cancelRequested?: boolean
}

const system: Actor = { type: 'system', id: 'dsh-host' }
const terminal = (state: RunState): boolean => ['cancelled', 'succeeded', 'failed'].includes(state.status)
const keyFor = (space: SpaceHandle, id: string): string => `${space.root}\0${id}`
const busy = (message: string): TaktToolError => new TaktToolError('TAKT_RUN_BUSY', message, '读取运行最新状态；需要重新执行时使用新的 requestKey 启动。')

/**
 * 宿主运行管理器：start 发布已落盘的 runId，后台任务推进；取消等待子 Agent 清理。
 * waiting_human 保留固定 runtime，终态不再恢复；后台异常统一记失败并记录日志。
 */
export class DshRunManager implements RunManager {
  private readonly records = new Map<string, ManagedRun>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly starting = new Set<Promise<unknown>>()
  private readonly spaces = new Map<string, SpaceHandle>()
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly deps: RunManagerDeps) {}

  start(input: StartRunInput): Promise<{ runId: RunId; deduped: boolean }> {
    return this.track(this.startOnce(input))
  }

  private async startOnce(input: StartRunInput): Promise<{ runId: RunId; deduped: boolean }> {
    this.assertOpen()
    await this.deps.ownership.ensureLease(input.space)
    this.spaces.set(input.space.root, input.space)
    return this.exclusive(keyFor(input.space, `request:${JSON.stringify([input.ownerSessionId, input.requestKey])}`), async () => {
      this.assertOpen()
      const existing = await input.space.stores.runs.list()
      for (const run of existing) {
        const owner = await this.deps.ownership.readRun(input.space, run.runId)
        if (owner?.requestKey === input.requestKey && owner.ownerSessionId === input.ownerSessionId) return { runId: run.runId, deduped: true }
      }
      return this.exclusive(keyFor(input.space, `requirement:${input.requirementId}`), async () => {
        const active = await input.space.stores.runs.list({ requirementId: input.requirementId })
        if (active.some((run) => run.status === 'running' || run.status === 'waiting_human')) throw busy('该需求已有执行中或等待审批的运行')
        const workflow = await this.deps.workflows.load(input.workflowId)
        const runtime = await loadRunRuntime(input.space, workflow)
        this.assertOpen()
        const meta: RunOwnerMeta = { owner: this.deps.ownership.hostOwner, ownerSessionId: input.ownerSessionId, requestKey: input.requestKey, createdAt: new Date().toISOString() }
        let publish!: (id: string) => void
        let reject!: (error: unknown) => void
        const published = new Promise<string>((resolve, fail) => { publish = resolve; reject = fail })
        void published.catch(() => {})
        const managed = this.build(runtime, meta, async (state) => {
          managed.runId = state.runId
          this.records.set(keyFor(input.space, state.runId), managed)
          await this.deps.ownership.recordRun(input.space, state.runId, meta)
          await recordRuntimeIdentity(runtime, state.runId)
          publish(state.runId)
        })
        this.launch(managed, () => managed.engine.start({ workflow: managed.workflow, requirementId: input.requirementId, args: structuredClone(input.args ?? {}) }), reject)
        return { runId: await published, deduped: false }
      })
    })
  }

  cancel(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    return this.track(this.cancelOnce(space, runId, by))
  }

  private async cancelOnce(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    this.assertOpen()
    this.spaces.set(space.root, space)
    await this.deps.ownership.ensureLease(space)
    await this.exclusive(keyFor(space, `operation:${runId}`), async () => {
      this.assertOpen()
      const state = await space.stores.runs.get(runId)
      if (!state) throw busy(`运行不存在：${runId}`)
      if (terminal(state)) throw busy(`运行已结束：${state.status}`)
      const record = this.records.get(keyFor(space, runId))
      if (record) { await this.stop(record); await record.task; await record.harness.drain() }
      else await createEngine({ stores: space.stores, profiles: {}, knowledge: [], harnesses: {} }).cancel(runId)
      await space.stores.events.append(runId, { type: 'log', actor: by, data: { level: 'info', message: '运行已取消，执行资源已清理' } })
    })
  }

  resume(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    return this.track(this.resumeOnce(space, runId, by))
  }

  private async resumeOnce(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    this.assertOpen()
    this.spaces.set(space.root, space)
    await this.deps.ownership.ensureLease(space)
    await this.exclusive(keyFor(space, `operation:${runId}`), async () => {
      this.assertOpen()
      let state = await space.stores.runs.get(runId)
      const meta = await this.deps.ownership.readRun(space, runId)
      if (!state || state.status !== 'waiting_human' || !meta || meta.endReason) throw busy('仅无异常终止原因的 waiting_human 运行允许恢复')
      let record = this.records.get(keyFor(space, runId))
      if (record?.task) {
        await record.task
        state = await space.stores.runs.get(runId)
        if (state?.status !== 'waiting_human') throw busy('运行状态已变化，不能恢复')
      }
      if (!record) {
        const definition = await this.deps.workflows.load(state.workflowId)
        const runtime = await loadRunRuntime(space, definition)
        await assertRuntimeIdentity(runtime, runId)
        this.assertOpen()
        record = this.build(runtime, meta)
        record.runId = runId
        this.records.set(keyFor(space, runId), record)
      }
      this.assertOpen()
      if (record.meta.owner !== this.deps.ownership.hostOwner) {
        record.meta = { ...record.meta, owner: this.deps.ownership.hostOwner }
        await this.deps.ownership.recordRun(space, runId, record.meta)
      }
      await space.stores.events.append(runId, { type: 'log', actor: by, data: { level: 'info', message: '恢复等待审批的运行' } })
      this.assertOpen()
      const resumed = record
      this.launch(resumed, () => resumed.engine.resume(runId, resumed.workflow))
    })
  }

  /** 审批落账后调用；快速回答先等本轮收敛，再重读状态，避免丢掉答案。 */
  async onAnswered(space: SpaceHandle, item: AttentionItem): Promise<void> {
    if (!item.answeredAt || this.disposed) return
    await this.records.get(keyFor(space, item.runId))?.task
    const state = await space.stores.runs.get(item.runId)
    if (state?.status !== 'waiting_human') return
    try { await this.resume(space, item.runId, item.answeredBy ?? system) } catch (error) {
      const current = await space.stores.runs.get(item.runId)
      if (error instanceof TaktToolError && error.code === 'TAKT_RUN_BUSY' && current?.status !== 'waiting_human') return
      throw error
    }
  }

  async get(space: SpaceHandle, runId: RunId): Promise<RunState | undefined> { return space.stores.runs.get(runId) }

  /** 租约丢失时宿主调用；停止在途运行，不重新获取已失去的租约。 */
  async cancelOwnedSpace(space: SpaceHandle): Promise<void> { await this.stopActive(space) }

  /** 宿主 effect 调用；先停止后台任务，再释放租约，重复调用复用结果。 */
  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      await Promise.allSettled([...this.starting])
      const stopped = await Promise.allSettled([...this.spaces.values()].map((space) => this.stopActive(space)))
      const failures = rejected(stopped)
      if (failures.length) throw new AggregateError(failures, '停止运行失败，租约未释放')
      const released = await Promise.allSettled([...this.spaces.values()].map((space) => this.deps.ownership.release(space)))
      const releaseFailures = rejected(released)
      if (releaseFailures.length) throw new AggregateError(releaseFailures, '释放运行租约失败')
    })()
    return this.disposal
  }

  /** 宿主诊断：进入卸载后禁止接收新运行。 */
  isDisposed(): boolean { return this.disposed }

  private build(runtime: RunRuntime, meta: RunOwnerMeta, created?: (state: RunState) => Promise<void>): ManagedRun {
    const ctx = this.deps.ctx
    if (!ctx) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh 宿主上下文不可用，无法启动子 Agent', '通过已加载的 taktflow 宿主服务启动。')
    const managed = { ...runtime, meta } as ManagedRun
    const registry = this.deps.presets as RolePresets & { fork?: (profiles: RunRuntime['profiles']) => RolePresets }
    const presets = registry.fork?.(runtime.profiles) ?? registry
    const harness = (this.deps.harnessFactory ?? createDshHarness)({
      ctx, space: runtime.space, presets, permissions: this.deps.permissions,
      ownership: this.deps.ownership, ownerSessionId: meta.ownerSessionId, profiles: runtime.profiles,
      onLeadOffline: async (nodeRef) => this.leadOffline(managed, nodeRef),
      onPreset: async (_role, preset, nodeRef) => {
        if (!managed.runId) throw new Error('运行归属尚未发布')
        managed.meta = { ...managed.meta, presets: { ...managed.meta.presets, [`${nodeRef.nodeId}#${nodeRef.attempt}`]: { id: preset.id, cfgHash: preset.cfgHash } } }
        await this.deps.ownership.recordRun(runtime.space, managed.runId, managed.meta)
      },
    })
    managed.harness = harness
    const original = runtime.space.stores
    const runs = Object.create(original.runs) as ProjectStores['runs']
    for (const name of ['get', 'getWorkflow', 'save', 'list', 'saveContext', 'saveCompaction', 'getContext'] as const) {
      ;(runs as unknown as Record<string, unknown>)[name] = (original.runs[name] as (...args: unknown[]) => unknown).bind(original.runs)
    }
    runs.create = async (state, workflow) => { await original.runs.create(state, workflow); await created?.(state) }
    const stores: ProjectStores = {
      ...original, runs,
      events: {
        append: async (runId, event) => {
          const result = await original.events.append(runId, event)
          // create 的 requirement 锁已释放；卸载早于调度时在这里补取消。
          if (event.type === 'run.started' && this.disposed) await this.stop(managed, 'host_lost')
          // core.cancel 可能在 Runtime 放入 active 之前读到旧状态；调度边界补取消，
          // 不能只复用 stopping，否则旧 Runtime 仍会继续启动节点。
          if (managed.cancelRequested && ['run.started', 'node.ready', 'node.started'].includes(event.type)) await managed.engine.cancel(runId)
          return result
        },
        read: original.events.read.bind(original.events), subscribe: original.events.subscribe.bind(original.events), verify: original.events.verify.bind(original.events),
      },
    }
    managed.engine = createEngine({ stores, profiles: runtime.profiles, knowledge: runtime.knowledge, harnesses: {
      'dsh-host': { ...harness, run: async (request, onEvent) => {
        if (managed.cancelRequested) {
          await managed.engine.cancel(request.env!.TAKT_RUN_ID!)
          throw busy('运行已请求取消，不能启动子 Agent')
        }
        return harness.run(request, onEvent)
      } },
    } })
    return managed
  }

  private launch(record: ManagedRun, execute: () => Promise<RunState>, rejectPublication?: (error: unknown) => void): void {
    record.stopping = undefined
    const task = execute().then(() => {}, async (error: unknown) => {
      rejectPublication?.(error)
      this.log(record.space, `运行失败：${error instanceof Error ? error.message : String(error)}`)
      await this.fail(record, error)
    }).then(() => record.harness.drain())
    const handled = task.catch((error: unknown) => { this.log(record.space, `后台运行或清理失败：${error instanceof Error ? error.message : String(error)}`); throw error })
    void handled.catch(() => {})
    record.task = handled
    void handled.then(async () => {
      if (record.task === handled) record.task = undefined
      if (record.runId) {
        const current = await record.space.stores.runs.get(record.runId)
        if (current && terminal(current)) this.records.delete(keyFor(record.space, record.runId))
      }
    }, () => { if (record.task === handled) record.task = undefined }).catch((error: unknown) => {
      this.log(record.space, `清理运行记录失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async fail(record: ManagedRun, error: unknown): Promise<void> {
    if (!record.runId) return
    const { space, runId } = record
    const state = await space.stores.runs.get(runId)
    if (!state || terminal(state)) return
    const message = createRedactor(collectSecrets(undefined, space.stores.config.providers))(error instanceof Error ? error.message : String(error))
    state.status = 'failed'
    state.endedAt = new Date().toISOString()
    for (const node of Object.values(state.nodes)) if (['running', 'ready'].includes(node.status)) { node.status = 'failed'; node.error = message; node.endedAt = state.endedAt }
    await space.stores.runs.save(state)
    await space.stores.events.append(runId, { type: 'log', actor: system, data: { level: 'error', message } })
    await space.stores.events.append(runId, { type: 'run.finished', actor: system, data: { status: 'failed' } })
    await updateRequirement(space.stores, state)
  }

  private stop(record: ManagedRun, reason?: EndReason['reason']): Promise<void> {
    if (record.stopping) return record.stopping
    record.cancelRequested = true
    record.stopping = (async () => {
      if (!record.runId) return
      await record.engine.cancel(record.runId)
      // active Runtime 的取消先同步 abort，避免写原因期间正常完成却留下 host_lost。
      const state = await record.space.stores.runs.get(record.runId)
      if (reason && state?.status === 'cancelled') await this.deps.ownership.setEndReason(record.space, record.runId, { reason, at: new Date().toISOString() })
    })()
    return record.stopping
  }

  private async stopActive(space: SpaceHandle): Promise<void> {
    const tasks = [...this.records.values()].filter((record) => record.space.root === space.root).map(async (record) => {
      const state = record.runId ? await space.stores.runs.get(record.runId) : undefined
      if (state?.status === 'running') await this.stop(record, 'host_lost')
      await record.task
      await record.harness.drain()
    })
    const errors = rejected(await Promise.allSettled(tasks))
    if (errors.length) throw new AggregateError(errors, '在途运行清理失败')
  }

  private async leadOffline(record: ManagedRun, nodeRef: { runId: string; nodeId: string; attempt: number }): Promise<void> {
    await this.stop(record, 'lead_offline')
    const state = await record.space.stores.runs.get(nodeRef.runId)
    if (!state) throw new Error('离线运行不存在')
    const requestId = `${nodeRef.runId}:${nodeRef.nodeId}:lead_offline`
    const existing = await record.space.stores.attention.list({ requirementId: state.requirementId })
    if (existing.some((item) => item.requestId === requestId)) return
    const item = await record.space.stores.attention.create({
      requestId, runId: nodeRef.runId, nodeId: nodeRef.nodeId, requirementId: state.requirementId,
      attempt: nodeRef.attempt, subjects: [], form: 'choice', choices: ['已重新打开需求群'],
      ask: 'Lead 会话已离线，本次运行已取消。请重新打开需求群并重新启动。',
    })
    await record.space.stores.events.append(nodeRef.runId, { type: 'human.requested', nodeId: nodeRef.nodeId, actor: system,
      data: { requestId, ask: item.ask, form: item.form, choices: item.choices } })
  }

  private assertOpen(): void { if (this.disposed) throw busy('宿主正在卸载，不能启动或恢复运行') }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.starting.add(pending)
    void pending.then(() => this.starting.delete(pending), () => this.starting.delete(pending))
    return pending
  }

  private log(space: SpaceHandle, message: string): void {
    const clean = createRedactor(collectSecrets(undefined, space.stores.config.providers))(message)
    try { (this.deps.log ?? ((value: string) => console.warn(`[taktflow] ${value}`)))(clean) } catch { /* 日志失败不能产生后台拒绝。 */ }
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(key, next)
    await previous
    try { return await operation() } finally { release(); if (this.locks.get(key) === next) this.locks.delete(key) }
  }
}

function rejected(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason as unknown)
}
