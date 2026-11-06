import { createEngine, type Actor, type AttentionItem, type Engine, type EventEnvelope, type ModelProvider, type ProjectStores, type RunId, type RunState, type TaktConfig, updateRequirement } from '@taktflow/core'
import { collectSecrets, createHarnesses, createProvider, createRedactor } from '@taktflow/harness'
import { createLocalSandboxProvider, createRepoManager } from '@taktflow/sandbox'
import { AgentTraceHub, bindAgentTraceHub } from './agent-trace.js'
import { autonomyStep, nodeKindOf } from './autonomy.js'
import { beginAutonomyAnswer } from './autonomy-state.js'
import type { HostContext } from './dsh-types.js'
import { createDshHarness, type DshHarness } from './dsh-harness.js'
import { assertRuntimeIdentity, loadRunRuntime, prepareRunArgs, recordRuntimeIdentity, repoBindingsForRun, type RunRuntime } from './run-runtime.js'
import { TaktToolError, type Approvals, type Autonomy, type EndReason, type Notifier, type Ownership, type PermissionRegistry, type RoleHarness, type RolePresets, type RunManager, type RunOwnerMeta, type SpaceHandle, type SpaceRegistry, type StartRunInput, type WorkflowCatalog } from './types.js'

/** 宿主行创建管理器；catalog 可由隔离 e2e 注入，生产只用随包目录。 */
export interface RunManagerDeps {
  ctx?: HostContext
  /** 插件级自主程度/角色 harness 默认；空间配置可在运行时覆盖 autonomy。 */
  config?: { autonomy?: Autonomy; roleHarness?: RoleHarness; user?: string }
  spaces: SpaceRegistry
  ownership: Ownership
  presets: RolePresets
  permissions: PermissionRegistry
  workflows: WorkflowCatalog
  /** 测试仅替换传输，仍走真实 engine 和 stores。 */
  harnessFactory?: typeof createDshHarness
  /** 子 Agent 追溯中心；缺失时保持原执行语义，不写追溯文件。 */
  traces?: AgentTraceHub
  log?: (message: string) => void
  /** Lead 层创建后由 index 注入；缺失时自主代答与升级通知停用。 */
  approvals?: Approvals
  notifier?: Notifier
}

interface ManagedRun extends RunRuntime {
  runId?: string
  meta: RunOwnerMeta
  engine: Engine
  harness: DshHarness
  task?: Promise<void>
  stopping?: Promise<void>
  cancelRequested?: boolean
  /** 本次进程内已经尝试过的待办；升级/失败/中断不重试。 */
  autonomyAttempts: Set<string>
  /** 在途自主代答的取消信号；stop 先 abort 再等任务。 */
  autonomyAbort?: AbortController
  /** 正在跑自主判定；stopActive 用它决定 waiting_human 是否也要取消。 */
  autonomyDriving: boolean
  /** 已登记的通知抑制；stop/fail/dispose 统一释放。 */
  autonomyReleases: Map<string, () => void>
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
  private readonly traces: AgentTraceHub
  private readonly ownsTraces: boolean
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly deps: RunManagerDeps) {
    // 未显式注入时自建追溯中心；守卫和路由通过权限登记表取回同一个实例。
    this.traces = deps.traces ?? new AgentTraceHub({ ...(deps.log === undefined ? {} : { log: deps.log }) })
    this.ownsTraces = deps.traces === undefined
    bindAgentTraceHub(deps.permissions, this.traces)
  }

  /** index 在 Lead 服务创建后接线；运行已启动时后续 drive 也会用到这里的新实例。 */
  setCollaborators(collaborators: { approvals?: Approvals; notifier?: Notifier }): void {
    if (collaborators.approvals !== undefined) this.deps.approvals = collaborators.approvals
    if (collaborators.notifier !== undefined) this.deps.notifier = collaborators.notifier
  }

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
        const workflow = await this.deps.workflows.load(input.workflowId, input.space)
        const runtime = await loadRunRuntime(input.space, workflow, {
          autonomy: this.deps.config?.autonomy,
          roleHarness: this.deps.config?.roleHarness,
        })
        this.assertOpen()
        const meta: RunOwnerMeta = {
          owner: this.deps.ownership.hostOwner,
          ownerSessionId: input.ownerSessionId,
          requestKey: input.requestKey,
          createdAt: new Date().toISOString(),
          autonomy: runtime.autonomy,
          roleHarness: runtime.roleHarness,
          autonomyAttempts: [],
        }
        let publish!: (id: string) => void
        let reject!: (error: unknown) => void
        const published = new Promise<string>((resolve, fail) => { publish = resolve; reject = fail })
        void published.catch(() => {})
        const managed = await this.build(runtime, meta, async (state) => {
          managed.runId = state.runId
          this.records.set(keyFor(input.space, state.runId), managed)
          await this.deps.ownership.recordRun(input.space, state.runId, meta)
          await recordRuntimeIdentity(runtime, state.runId)
          publish(state.runId)
        })
        // full 必须在这里规范化 args.review/args.reviews；core 的 configureReviews
        // 优先级高于 workflow 定义，只清 workflow 会被显式 true 重新打开人工签字。
        this.launch(managed, () => managed.engine.start({
          workflow: managed.workflow,
          requirementId: input.requirementId,
          args: prepareRunArgs(structuredClone(input.args ?? {}), managed.autonomy),
        }), reject)
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
    let record: ManagedRun | undefined
    await this.exclusive(keyFor(space, `operation:${runId}`), async () => {
      this.assertOpen()
      const state = await space.stores.runs.get(runId)
      if (!state) throw busy(`运行不存在：${runId}`)
      if (terminal(state)) throw busy(`运行已结束：${state.status}`)
      record = this.records.get(keyFor(space, runId))
      if (record) {
        // 锁内只发取消/abort；等待后台任务必须在锁外，否则同一任务的 resume 会占锁卡死。
        await this.stop(record)
      } else {
        await createEngine({ stores: space.stores, profiles: {}, knowledge: [], harnesses: {} }).cancel(runId)
      }
    })
    if (record) {
      await record.task
      await record.harness.drain()
    }
    await space.stores.events.append(runId, { type: 'log', actor: by, data: { level: 'info', message: '运行已取消，执行资源已清理' } })
  }

  resume(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    return this.track(this.resumeOnce(space, runId, by))
  }

  private async resumeOnce(space: SpaceHandle, runId: RunId, by: Actor): Promise<void> {
    this.assertOpen()
    this.spaces.set(space.root, space)
    await this.deps.ownership.ensureLease(space)
    // 先等当前后台任务收敛；这个等待必须在操作锁外，否则任务里的 resume 永远拿不到锁。
    const existing = this.records.get(keyFor(space, runId))
    if (existing?.task) await existing.task
    await this.exclusive(keyFor(space, `operation:${runId}`), async () => {
      this.assertOpen()
      const state = await space.stores.runs.get(runId)
      const meta = await this.deps.ownership.readRun(space, runId)
      if (!state || state.status !== 'waiting_human' || !meta || meta.endReason) throw busy('仅无异常终止原因的 waiting_human 运行允许恢复')
      let record = this.records.get(keyFor(space, runId))
      if (record?.task) {
        // 等锁期间另一个 resume 可能已启动；锁内重读后如果仍在跑，交给已有任务。
        throw busy('运行正在推进，不能重复恢复')
      }
      if (!record) {
        const definition = await this.deps.workflows.load(state.workflowId, space)
        const runtime = await loadRunRuntime(space, definition, {
          // 历史 run 缺 autonomy 时按 manual 保守恢复：新宿主的 full 默认不能
          // 把旧人工审批语义改成 AI 自动批准。
          autonomy: meta.autonomy ?? 'manual',
          roleHarness: meta.roleHarness ?? this.deps.config?.roleHarness,
        })
        await assertRuntimeIdentity(runtime, runId)
        this.assertOpen()
        record = await this.build(runtime, meta)
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
      if (error instanceof TaktToolError && error.code === 'TAKT_RUN_BUSY') {
        // 另一个 onAnswered/resume 已在推进（可能还没把状态写成 running）时是幂等重复，
        // 交给已有任务；仍停在 waiting_human 且没有任务才说明确实无法恢复。
        const record = this.records.get(keyFor(space, item.runId))
        if (record?.task !== undefined || current?.status !== 'waiting_human') return
      }
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
      // 自建追溯中心随宿主一起冲刷；注入实例的生命周期由调用方管理。
      if (this.ownsTraces) await this.traces.disposeAll()
    })()
    return this.disposal
  }

  /** 宿主诊断：进入卸载后禁止接收新运行。 */
  isDisposed(): boolean { return this.disposed }

  private async build(runtime: RunRuntime, meta: RunOwnerMeta, created?: (state: RunState) => Promise<void>): Promise<ManagedRun> {
    const ctx = this.deps.ctx
    if (!ctx) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh 宿主上下文不可用，无法启动子 Agent', '通过已加载的 taktflow 宿主服务启动。')
    const managed = {
      ...runtime, meta,
      autonomyAttempts: new Set(meta.autonomyAttempts ?? []),
      autonomyDriving: false,
      autonomyReleases: new Map<string, () => void>(),
    } as ManagedRun
    // 必须同时传运行开始时冻结的 skills 快照；只 fork profiles 会让 preset 在
    // 节点启动时重新读 SKILL.md，破坏“运行开始后技能内容不变”的承诺。
    const registry = this.deps.presets as RolePresets & {
      fork?: (profiles: RunRuntime['profiles'], skills: RunRuntime['roleSkills']) => RolePresets
    }
    const presets = registry.fork?.(runtime.profiles, runtime.roleSkills) ?? registry
    const harness = (this.deps.harnessFactory ?? createDshHarness)({
      ctx, space: runtime.space, presets, permissions: this.deps.permissions,
      ownership: this.deps.ownership, ownerSessionId: meta.ownerSessionId, profiles: runtime.profiles,
      profileSources: runtime.profileSources, roleSkills: runtime.roleSkills, traces: this.traces,
      onLeadOffline: async (nodeRef) => this.leadOffline(managed, nodeRef),
      onPreset: async (role, preset, nodeRef) => {
        if (!managed.runId) throw new Error('运行归属尚未发布')
        const ref = `${nodeRef.nodeId}#${nodeRef.attempt}`
        managed.meta = {
          ...managed.meta,
          // 兼容旧审计键，同时按角色记录：同一 review 节点的多个评审者共享
          // node#attempt，只写旧键会丢掉后一个角色的 preset。
          presets: { ...managed.meta.presets, [ref]: { id: preset.id, cfgHash: preset.cfgHash }, [`${ref}:${role}`]: { id: preset.id, cfgHash: preset.cfgHash } },
        }
        await this.deps.ownership.recordRun(runtime.space, managed.runId, managed.meta)
      },
    })
    managed.harness = harness
    const original = runtime.space.stores
    const redactor = createRedactor(collectSecrets(undefined, original.config.providers))
    const runs = Object.create(original.runs) as ProjectStores['runs']
    for (const name of ['get', 'getWorkflow', 'save', 'list', 'saveContext', 'saveCompaction', 'getContext'] as const) {
      ;(runs as unknown as Record<string, unknown>)[name] = (original.runs[name] as (...args: unknown[]) => unknown).bind(original.runs)
    }
    runs.create = async (state, workflow) => { await original.runs.create(state, workflow); await created?.(state) }
    const stores: ProjectStores = {
      ...original, runs,
      events: {
        append: (async (runId: string, event: EventEnvelope): Promise<EventEnvelope> => {
          const safe = redactEvent(event, redactor)
          // AI 处理的普通 human 待办在事件落盘前就登记抑制，避免通知轮询先唤醒 Lead。
          if (safe.type === 'human.requested' && runtime.autonomy !== 'manual') {
            const data = safe.data as { requestId?: unknown; form?: unknown }
            const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
            const form = data.form
            // planner 动态展开的 human 只存在于本次 run 已落盘的 expansions 里；
            // 必须读当前 run state，不能拿 undefined 去查静态 workflow。
            const state = safe.nodeId === undefined ? undefined : await original.runs.get(runId)
            const kind = safe.nodeId === undefined ? undefined : nodeKindOf(managed.workflow, state, safe.nodeId)
            const eligible = kind === 'human' && (form === 'answer' || (form === 'approve' && runtime.autonomy === 'full'))
            if (eligible && requestId !== undefined && !managed.autonomyReleases.has(requestId)) {
              managed.autonomyReleases.set(requestId, beginAutonomyAnswer(runtime.space.root, requestId))
            }
          }
          const result = await original.events.append(runId, safe)
          // create 的 requirement 锁已释放；卸载早于调度时在这里补取消。
          if (safe.type === 'run.started' && this.disposed) await this.stop(managed, 'host_lost')
          // core.cancel 可能在 Runtime 放入 active 之前读到旧状态；调度边界补取消，
          // 不能只复用 stopping，否则旧 Runtime 仍会继续启动节点。
          if (managed.cancelRequested && ['run.started', 'node.ready', 'node.started'].includes(safe.type)) await managed.engine.cancel(runId)
          return result
        }) as ProjectStores['events']['append'],
        read: original.events.read.bind(original.events), subscribe: original.events.subscribe.bind(original.events), verify: original.events.verify.bind(original.events),
      },
    }
    const repos = createRepoManager({ projectDir: runtime.space.root, taktDir: runtime.space.stores.taktDir, repos: await repoBindingsForRun(runtime.space) })
    if (runtime.roleHarness === 'dsh-host') {
      // dsh-host 适配器只支持本地 sandbox；空间明确要求 docker/bwrap 时必须提前
      // 明确拒绝，不能用一个 local provider 静默掩盖用户的隔离要求。
      const requestedSandbox = runtime.space.stores.config.sandbox
      if (requestedSandbox !== undefined && requestedSandbox.provider !== 'local') {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `dsh-host 角色 harness 不支持 ${requestedSandbox.provider} sandbox`,
          '把 takt.config.json 的 sandbox.provider 改为 local，或把插件的 roleHarness 切成 profile。',
        )
      }
      managed.engine = createEngine({
        stores, profiles: runtime.profiles, knowledge: runtime.knowledge, repos,
        // dsh-host 统一走 App 模型，禁用 core autoApprove（它会伪造人工 actor/固定答案）。
        sandbox: createLocalSandboxProvider(),
        harnesses: {
          'dsh-host': { ...harness, run: async (request, onEvent) => {
            if (managed.cancelRequested) {
              await managed.engine.cancel(request.env!.TAKT_RUN_ID!)
              throw busy('运行已请求取消，不能启动子 Agent')
            }
            return harness.run(request, onEvent)
          } },
        },
      }, { harnessOverride: 'dsh-host' })
    } else {
      // profile 模式完整沿用角色/节点的 harness 选择；不传 skillsDir，避免 core
      // syncSkills 把全空间技能同步给所有外部 CLI。
      managed.engine = createEngine({
        stores, profiles: runtime.profiles, knowledge: runtime.knowledge, repos,
        harnesses: createHarnesses({
          config: runtime.space.stores.config,
          projectDir: runtime.space.root,
          providers: runtimeProviders(runtime.space.stores.config),
        }),
      })
    }
    return managed
  }

  private launch(record: ManagedRun, execute: () => Promise<RunState>, rejectPublication?: (error: unknown) => void): void {
    record.stopping = undefined
    const task = execute().then(async (state) => {
      // 引擎本轮收敛到 waiting_human 后才开始 AI 代答；回答落账后直接 resume。
      await this.drive(record, state)
    }, async (error: unknown) => {
      rejectPublication?.(error)
      this.log(record.space, `运行失败：${error instanceof Error ? error.message : String(error)}`)
      await this.fail(record, error)
    }).then(() => record.harness.drain())
    const handled = task.catch((error: unknown) => { this.log(record.space, `后台运行或清理失败：${error instanceof Error ? error.message : String(error)}`); throw error })
    void handled.catch(() => {})
    record.task = handled
    void handled.then(async () => {
      if (record.task === handled) record.task = undefined
      this.releaseAutonomy(record)
      if (record.runId) {
        const current = await record.space.stores.runs.get(record.runId)
        if (current && terminal(current)) this.records.delete(keyFor(record.space, record.runId))
      }
    }, () => { if (record.task === handled) record.task = undefined }).catch((error: unknown) => {
      this.log(record.space, `清理运行记录失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 自主代答循环：每轮只处理一条待办，落账后直接 engine.resume。
   *
   * 人抢先回答时 answerAsAgent 返回 answered=false，仍要 resume 消费真人答案；
   * 升级或没有可处理待办就停下，把决定权交回人。
   */
  private async drive(record: ManagedRun, initial: RunState): Promise<void> {
    const approvals = this.deps.approvals
    if (record.autonomy === 'manual' || approvals?.answerAsAgent === undefined || record.runId === undefined) return
    const controller = new AbortController()
    record.autonomyAbort = controller
    record.autonomyDriving = true
    let state = initial
    try {
      while (!this.disposed && !record.cancelRequested && !controller.signal.aborted && state.status === 'waiting_human') {
        const step = await autonomyStep({
          space: record.space,
          runId: record.runId,
          requirementId: state.requirementId,
          workflow: record.workflow,
          profiles: record.profiles,
          autonomy: record.autonomy,
          harness: record.harness,
          approvals,
          notifier: this.deps.notifier,
          configUser: this.deps.config?.user,
          signal: controller.signal,
          log: (message) => this.log(record.space, message),
          claim: async (requestId) => {
            if (record.autonomyAttempts.has(requestId)) return
            record.autonomyAttempts.add(requestId)
            record.meta = { ...record.meta, autonomyAttempts: [...record.autonomyAttempts] }
            await this.deps.ownership.recordRun(record.space, record.runId!, record.meta)
          },
        }, state, record.autonomyAttempts)
        if (step.kind === 'none') break
        this.releaseAutonomy(record, step.requestId)
        if (step.kind === 'escalated') break
        if (this.disposed || record.cancelRequested || controller.signal.aborted) break
        state = await record.engine.resume(record.runId, record.workflow)
      }
    } catch (error) {
      if (controller.signal.aborted || record.cancelRequested || this.disposed) {
        this.log(record.space, `自主代答随运行取消：${error instanceof Error ? error.message : String(error)}`)
      } else {
        // resume 失败不能只记日志：run 已保存为 running 但没有执行者，必须收敛
        // 为 failed，否则 status 会永远显示进行中。
        this.log(record.space, `自主代答异常：${error instanceof Error ? error.message : String(error)}`)
        await this.fail(record, error)
      }
    } finally {
      record.autonomyDriving = false
      if (record.autonomyAbort === controller) record.autonomyAbort = undefined
      this.releaseAutonomy(record)
    }
  }

  private releaseAutonomy(record: ManagedRun, requestId?: string): void {
    if (requestId !== undefined) {
      const release = record.autonomyReleases.get(requestId)
      record.autonomyReleases.delete(requestId)
      release?.()
      return
    }
    for (const release of record.autonomyReleases.values()) release()
    record.autonomyReleases.clear()
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
    // 自主子会话不属于 core 的 active runtime，engine.cancel 取消不到它；先 abort。
    record.autonomyAbort?.abort(new Error('运行已取消'))
    this.releaseAutonomy(record)
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
      // waiting_human 上仍有 AI 代答在途时也必须取消，不能留下孤儿子会话。
      if (state?.status === 'running' || (state?.status === 'waiting_human' && record.autonomyDriving)) await this.stop(record, 'host_lost')
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

/**
 * 事件落盘前统一脱敏：脚本成功输出（log）、harness 文本、节点错误和工具调用
 * 都可能带模型/环境密钥。只复制需要改的字段，不修改 core 传入的对象。
 */
function redactEvent(event: EventEnvelope, redact: (value: string) => string): EventEnvelope {
  const data = event.data as Record<string, unknown> | undefined
  if (data === undefined || data === null || typeof data !== 'object') return event
  let next: Record<string, unknown> | undefined
  const edit = (key: string, value: unknown): void => {
    if (typeof value !== 'string') return
    next ??= { ...data }
    next[key] = redact(value)
  }
  if (event.type === 'log') edit('message', data.message)
  if (event.type === 'harness.message') edit('text', data.text)
  if (event.type === 'node.failed') edit('error', data.error)
  if (event.type === 'harness.tool_call') { edit('input', data.input); edit('output', data.output) }
  return next === undefined ? event : ({ ...event, data: next } as EventEnvelope)
}

/** 只实例化 native 能消费的 provider；CLI 适配器直接读配置，不需要 ModelProvider。 */
function runtimeProviders(config: TaktConfig): Record<string, ModelProvider> {
  const result = Object.create(null) as Record<string, ModelProvider>
  for (const [id, value] of Object.entries(config.providers ?? {})) {
    if (value.protocol !== 'openai-chat' && value.protocol !== 'anthropic-messages') continue
    if (typeof value.baseURL !== 'string' || value.baseURL === '') throw new Error(`provider ${id} 缺少 baseURL`)
    result[id] = createProvider(id, value)
  }
  return result
}
