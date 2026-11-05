import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLease,
  agent,
  createEngine,
  createInsights,
  defineWorkflow,
  human,
  initProject,
  releaseLease,
  script,
  type Actor,
  type AgentProfile,
  type AttentionItem,
  type Engine,
  type HarnessAdapter,
  type ProjectStores,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { createMockHarness } from '@taktflow/harness'
import { createApprovals } from './approvals.js'
import { createBindings } from './bindings.js'
import type {
  Agent,
  ConnectionFetchRoute,
  DefineTool,
  DefineToolOptions,
  Disposer,
  EffectBody,
  HostContext,
  ToolDefinition,
  ToolExecutionContext,
  UserQuestion,
  UserQuestionsRequest,
  UserQuestionsResult,
} from './dsh-types.js'
import { registerLeadTools } from './lead/tools.js'
import { registerRoutes } from './routes.js'
import { FsSpaceRegistry } from './space.js'
import {
  TaktToolError,
  type Approvals,
  type Bindings,
  type EndReason,
  type Notifier,
  type Ownership,
  type PermissionRegistry,
  type RolePresets,
  type RunManager,
  type RunOwnerMeta,
  type SpaceHandle,
  type StartRunInput,
  type TaktflowService,
  type WorkflowCatalog,
} from './types.js'

/** S3 测试里代表人的审计身份；与真实 config.user 走同一条路径。 */
export const CONFIG_USER = '审批人'
/**
 * 测试 Lead 会话 ID。
 *
 * dsh 契约里 `agent.id` 就是会话身份：Lead 工具按 agent.id 查绑定，运行所有权
 * 也用它。因此 ROOT_AGENT_ID 必须与它相同，不能造两个不同的 ID。
 */
export const HOST_SESSION = 'session-root'
/** 测试空间根 Agent ID；与 HOST_SESSION 统一，保证真实工具能通过绑定校验。 */
export const ROOT_AGENT_ID = HOST_SESSION

/**
 * S3 集成测试夹具。
 *
 * 使用真实 core stores / engine + mock harness + 真实 approvals/routes 与
 * bindings；RunManager 只是测试替身，负责引擎恢复和 requestKey 幂等，不模拟
 * 真实 dsh 执行层。CLI 租约通过 core 的 acquireLease/releaseLease 真实占用。
 */
export interface S3Fixture {
  root: string
  space: SpaceHandle
  stores: ProjectStores
  requirementId: string
  workflow: WorkflowDefinition
  engine: Engine
  runs: TestRunManager
  ownership: TestOwnership
  bindings: Bindings
  approvals: Approvals
  service: TaktflowService
  host: S3Host
  agent: Agent
  /** A 的真实 Lead 工具 `takt_ask_human`；S3 用它验证工具层真实执行。 */
  askHuman: ToolDefinition
  published: string[]
  harnessCalls: string[]
  start(requestKey?: string): Promise<{ runId: string; deduped: boolean }>
  pending(): Promise<AttentionItem>
  findItem(requestId: string): Promise<AttentionItem | undefined>
  runState(runId: string): Promise<RunState | undefined>
  cleanup(): Promise<void>
}

/** 真实 core 租约的测试所有权实现；不依赖 M-C 的 ownership.ts。 */
export class TestOwnership implements Ownership {
  readonly hostOwner: string
  private readonly meta = new Map<string, RunOwnerMeta>()

  constructor(hostOwner = 'dsh:s3-test') {
    this.hostOwner = hostOwner
  }

  async ensureLease(space: SpaceHandle): Promise<void> {
    const result = await acquireLease(space.stores.taktDir, this.hostOwner)
    if (result.ok) return
    throw new TaktToolError(
      'TAKT_LEASE_HELD',
      `空间租约被 ${result.held.owner} 持有`,
      '等占用方释放租约；P0 不自动抢占活租约。',
    )
  }

  async release(space: SpaceHandle): Promise<void> {
    await releaseLease(space.stores.taktDir, this.hostOwner)
  }

  async takeover(space: SpaceHandle, _by: Actor): Promise<void> {
    const result = await acquireLease(space.stores.taktDir, this.hostOwner, { takeover: true })
    if (result.ok) return
    throw new TaktToolError('TAKT_LEASE_HELD', `空间租约仍被 ${result.held.owner} 持有`)
  }

  async recordRun(_space: SpaceHandle, runId: string, meta: RunOwnerMeta): Promise<void> {
    this.meta.set(runId, meta)
  }

  async readRun(_space: SpaceHandle, runId: string): Promise<RunOwnerMeta | undefined> {
    return this.meta.get(runId)
  }

  async setEndReason(_space: SpaceHandle, runId: string, endReason: EndReason): Promise<void> {
    const meta = this.meta.get(runId)
    if (meta?.endReason !== undefined && meta.endReason.reason !== endReason.reason) {
      throw new TaktToolError('TAKT_RUN_BUSY', '运行已经带有其它终止原因')
    }
    if (meta !== undefined) meta.endReason = endReason
  }
}

/**
 * 测试 RunManager：只负责 requestKey 去重和引擎恢复，不代表真实执行层。
 *
 * 并发去重必须用 inflight Promise，而不是等 engine.start 返回后再写 byRequestKey：
 * 否则两个并发 start 都会看到“没有记录”并各跑一次引擎。这里按
 * space.root + ownerSessionId + requestKey 串行化，后到者等待同一个 Promise。
 */
export class TestRunManager implements RunManager {
  readonly startCalls: string[] = []
  readonly answered: AttentionItem[] = []
  private readonly byRequestKey = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<{ runId: string; deduped: boolean }>>()

  constructor(
    private readonly engine: Engine,
    private readonly workflow: WorkflowDefinition,
  ) {}

  async start(input: StartRunInput): Promise<{ runId: string; deduped: boolean }> {
    const key = `${input.space.root}\0${input.ownerSessionId}\0${input.requestKey}`
    const existing = this.byRequestKey.get(key)
    if (existing !== undefined) return { runId: existing, deduped: true }

    const running = this.inflight.get(key)
    if (running !== undefined) {
      // 并发重复提交：等首个请求把运行建好，再按幂等结果返回。
      const result = await running
      return { runId: result.runId, deduped: true }
    }

    this.startCalls.push(input.requestKey)
    const task = (async () => {
      const state = await this.engine.start({
        workflow: this.workflow,
        requirementId: input.requirementId,
        args: input.args,
      })
      // 引擎返回后再记账：同一 Promise 的等待者直接复用结果，不会重复执行。
      this.byRequestKey.set(key, state.runId)
      return { runId: state.runId, deduped: false }
    })()
    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      if (this.inflight.get(key) === task) this.inflight.delete(key)
    }
  }

  async cancel(_space: SpaceHandle, runId: string, _by: Actor): Promise<void> {
    await this.engine.cancel(runId)
  }

  async resume(_space: SpaceHandle, runId: string, _by: Actor): Promise<void> {
    await this.engine.resume(runId, this.workflow)
  }

  async get(space: SpaceHandle, runId: string): Promise<RunState | undefined> {
    return space.stores.runs.get(runId)
  }

  async onAnswered(_space: SpaceHandle, item: AttentionItem): Promise<void> {
    this.answered.push(item)
    await this.engine.resume(item.runId, this.workflow)
  }

  async disposeAll(): Promise<void> {}
}

/** 只实现 routes/approvals 用到的宿主面；其余 dsh 服务不在 S3 范围。 */
export class S3Host {
  readonly routes: ConnectionFetchRoute[] = []
  readonly questions: UserQuestion[][] = []
  readonly agents: HostContext['agents']
  readonly userQuestions: HostContext['userQuestions']
  readonly connection: HostContext['connection']
  askHandler: (request: UserQuestionsRequest) => Promise<UserQuestionsResult> = async () => ({ answers: [] })

  private readonly effects: Array<{ label: string; dispose: Disposer }> = []

  constructor(readonly agent: Agent) {
    this.agents = {
      get: (id: string) => (id === agent.id ? agent : undefined),
      roots: () => [agent],
    }
    this.connection = {
      fetch: {
        register: (route) => {
          this.routes.push(route)
          return () => {
            const index = this.routes.indexOf(route)
            if (index >= 0) this.routes.splice(index, 1)
          }
        },
      },
    }
    this.userQuestions = {
      ask: (request) => {
        this.questions.push([...request.questions])
        return this.askHandler(request)
      },
    }
  }

  effect(execute: () => EffectBody, label = 'anonymous'): Disposer {
    const body = execute()
    if (typeof body !== 'function') throw new Error(`S3Host 只支持同步清理：${label}`)
    const record = { label, dispose: body }
    this.effects.push(record)
    return () => {
      const index = this.effects.indexOf(record)
      if (index >= 0) this.effects.splice(index, 1)
      return body()
    }
  }

  async dispose(): Promise<void> {
    for (const record of [...this.effects].reverse()) await record.dispose()
    this.effects.length = 0
  }
}

export function toolExec(agent: Agent, signal?: AbortSignal): ToolExecutionContext {
  return {
    callId: 'call-s3',
    rootCallId: 'call-s3',
    name: 'takt_ask_human',
    arguments: {},
    agent,
    signal: signal ?? new AbortController().signal,
    token: Symbol('s3'),
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

export async function createS3Fixture(): Promise<S3Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'takt-s3-')))
  const stores = await initProject(root, { name: 's3' })
  const requirement = await stores.workspaces.createRequirement({ title: 'S3 审批闭环' })
  const requirementId = requirement.id

  const published: string[] = []
  const workflow = defineWorkflow({
    id: 's3-approval',
    title: 'S3 审批闭环',
    version: '1',
    stages: [{ id: 'delivery', title: '交付' }],
    nodes: [
      agent({
        id: 'draft',
        title: '起草规格与方案',
        stage: 'delivery',
        role: 'writer',
        prompt: '起草规格与方案',
        outputs: [
          { path: 'spec/spec.md', kind: 'spec' },
          { path: 'spec/plan.md', kind: 'design' },
        ],
        writeScope: ['**'],
      }),
      human({
        id: 'approve',
        title: '人工审批',
        stage: 'delivery',
        needs: ['draft'],
        inputs: [{ path: 'spec/spec.md' }, { path: 'spec/plan.md' }],
        ask: '请审批规格与方案',
        form: 'approve',
      }),
      script({
        id: 'publish',
        title: '发布',
        stage: 'delivery',
        needs: ['approve'],
        run: async () => {
          published.push('publish')
          return { data: { published: true } }
        },
      }),
    ],
  })

  const harnessCalls: string[] = []
  const mock = createMockHarness({
    steps: [{
      match: { nodeId: 'draft' },
      writes: {
        '{{workspace}}/spec/spec.md': '# 规格 v1\n',
        '{{workspace}}/spec/plan.md': '# 方案 v1\n',
      },
      finalText: '草稿完成',
    }],
  })
  const harness: HarnessAdapter = {
    ...mock,
    async run(request, onEvent) {
      harnessCalls.push(request.env?.TAKT_NODE ?? 'unknown')
      return mock.run(request, onEvent)
    },
  }

  const profiles: Record<string, AgentProfile> = {
    writer: {
      role: 'writer',
      title: 'Writer',
      description: '',
      harness: { harness: 'mock' },
      skills: [],
      writeScope: ['**'],
      instructions: '起草规格与方案',
    },
  }

  const engine = createEngine({ stores, harnesses: { mock: harness }, profiles, knowledge: [] })
  const runs = new TestRunManager(engine, workflow)
  const ownership = new TestOwnership()
  const bindings = createBindings({ ownership })
  // dsh 契约：agent.id 就是会话身份，绑定、工具身份校验和运行所有权都用它。
  // cwd 必须是空间根，agentPreset 必须是 taktflow，否则真实 Lead 工具会拒绝调用。
  const rootAgent: Agent = {
    id: ROOT_AGENT_ID,
    options: {},
    session: { header: { id: HOST_SESSION, cwd: root, agentPreset: 'taktflow' } },
    followup: () => {},
    inject: () => {},
  }
  const host = new S3Host(rootAgent)
  const approvals = createApprovals({ ctx: host, ownership, runs, config: { user: CONFIG_USER } })
  const spaces = new FsSpaceRegistry({ spaces: [root] })
  const service: TaktflowService = {
    spaces,
    ownership,
    runs,
    permissions: {} as PermissionRegistry,
    presets: {} as RolePresets,
    bindings,
    approvals,
    notifier: { attach: async () => {}, detach: async () => {} } satisfies Notifier,
    workflows: {
      ids: () => [workflow.id],
      load: async () => workflow,
    } satisfies WorkflowCatalog,
  }
  const space: SpaceHandle = { root, stores, insights: createInsights(stores) }
  // 真实 Lead 工具按 agent.id 查双向绑定；fixture 先建绑定，再把 setup 用的租约
  // 释放掉，让“CLI 占用租约”用例仍能真实抢占，写入口会按需重新 ensureLease。
  await bindings.bind(space, requirementId, rootAgent.id, {
    type: 'human',
    id: CONFIG_USER,
    via: 'dsh-web',
  })
  await ownership.release(space)

  // A 的真实 takt_ask_human：S3 必须经过工具层执行，而不是直接调用 approvals.present。
  const defineTool = ((options: DefineToolOptions): ToolDefinition => ({
    name: options.name,
    description: options.description,
    parameters: options.parameters as Record<string, unknown>,
    output: {
      schema: options.output.schema as unknown as Record<string, unknown>,
      render: options.output.render,
    },
    execute: options.execute,
  })) satisfies DefineTool
  const tools = registerLeadTools(defineTool, service, { ctx: host, user: CONFIG_USER })
  const askHuman = tools.find((tool) => tool.name === 'takt_ask_human')
  if (askHuman === undefined) throw new Error('takt_ask_human 未注册')

  registerRoutes(host as unknown as HostContext, service, { user: CONFIG_USER })

  return {
    root,
    space,
    stores,
    requirementId,
    workflow,
    engine,
    runs,
    ownership,
    bindings,
    approvals,
    service,
    host,
    agent: rootAgent,
    askHuman,
    published,
    harnessCalls,
    async start(requestKey = 'request-1') {
      return runs.start({
        space,
        requirementId,
        workflowId: workflow.id,
        ownerSessionId: rootAgent.id,
        requestKey,
      })
    },
    async pending() {
      const pending = await stores.attention.list({ pending: true, requirementId })
      const item = pending[0]
      if (item === undefined) throw new Error('没有待处理的审批')
      return item
    },
    async findItem(requestId) {
      return (await stores.attention.list()).find((item) => item.requestId === requestId)
    },
    async runState(runId) {
      return stores.runs.get(runId)
    },
    async cleanup() {
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
