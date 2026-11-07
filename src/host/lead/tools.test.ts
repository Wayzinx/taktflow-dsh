import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInsights,
  initProject,
  type Actor,
  type AttentionItem,
  type RunState,
  type WorkflowSnapshot,
} from '@taktflow/core'
import type {
  Agent,
  DefineTool,
  HostContext,
  ToolDefinition,
  ToolExecutionContext,
} from '../dsh-types.js'
import { bindingsFile, createBindings } from '../bindings.js'
import { autoAnswerPath } from '../approvals.js'
import { beginAutonomyAnswer } from '../autonomy-state.js'
import { createLeadServices } from './services.js'
import {
  assertLeadWritablePath,
  LEAD_TOOL_NAMES,
  registerLeadTools,
  type LeadToolResult,
} from './tools.js'
import {
  createRequestsFile,
  fingerprintCreateInput,
  withCreateLedger,
  type CreateRequestRecord,
} from './ledger.js'
import type {
  Approvals,
  Bindings,
  EndReason,
  Ownership,
  RunManager,
  RunOwnerMeta,
  SpaceHandle,
  SpaceRegistry,
  StartRunInput,
  TaktflowService,
  WorkflowCatalog,
} from '../types.js'

const alice: Actor = { type: 'human', id: 'alice' }

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

class FakeRuns implements RunManager {
  readonly starts: StartRunInput[] = []
  readonly cancels: Array<{ runId: string; by: Actor }> = []
  deduped = false
  runId = 'run-001'

  async start(input: StartRunInput): Promise<{ runId: string; deduped: boolean }> {
    this.starts.push(input)
    return { runId: this.runId, deduped: this.deduped }
  }

  async cancel(_space: SpaceHandle, runId: string, by: Actor): Promise<void> {
    this.cancels.push({ runId, by })
  }

  async resume(): Promise<void> {}
  async get(space: SpaceHandle, runId: string): Promise<RunState | undefined> {
    return space.stores.runs.get(runId)
  }
  async onAnswered(): Promise<void> {}
  async disposeAll(): Promise<void> {}
}

class FakeApprovals implements Approvals {
  readonly presented: Array<{ requestId: string; sessionId: string | undefined }> = []
  /** 模拟人在卡片上的行为：落回答、取消或跳过。 */
  onPresent: ((space: SpaceHandle, requestId: string) => Promise<void>) | undefined

  async present(exec: ToolExecutionContext, space: SpaceHandle, requestId: string): Promise<void> {
    this.presented.push({ requestId, sessionId: exec.agent?.id })
    await this.onPresent?.(space, requestId)
  }

  async answer(): Promise<AttentionItem> {
    throw new Error('测试未实现 answer')
  }
}

const defineToolStub: DefineTool = (options) => options as unknown as ToolDefinition

function makeAgent(id: string, cwd: string): Agent {
  return {
    id,
    options: { model: 'test-model' },
    session: { header: { id, cwd, agentPreset: 'taktflow' } },
    followup: () => undefined,
    inject: () => undefined,
  }
}

function execFor(agent: Agent | undefined): ToolExecutionContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'test',
    arguments: {},
    ...(agent !== undefined ? { agent } : {}),
    signal: new AbortController().signal,
    token: Symbol('test'),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  }
}

interface Harness {
  root: string
  space: SpaceHandle
  spaces: { current: SpaceHandle; registry: SpaceRegistry }
  ownership: FakeOwnership
  bindings: Bindings
  runs: FakeRuns
  workflows: WorkflowCatalog
  approvals: FakeApprovals
  service: TaktflowService
  rootAgent: Agent
  agents: HostContext['agents']
  tools: Map<string, ToolDefinition>
  call(name: string, args: Record<string, unknown>, agent?: Agent | null): Promise<LeadToolResult>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeHarness(options: { withCtx?: boolean; user?: string; workflows?: WorkflowCatalog } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'taktflow-lead-'))
  roots.push(root)
  const stores = await initProject(root, { name: 'lead-test' })
  const space: SpaceHandle = { root, stores, insights: createInsights(stores) }
  const ownership = new FakeOwnership()
  const bindings = createBindings({ ownership })
  const runs = new FakeRuns()
  const workflows: WorkflowCatalog = options.workflows ?? {
    ids: () => ['p0-delivery'],
    load: async () => {
      throw new Error('测试不加载流程')
    },
  }
  const approvals = new FakeApprovals()
  const spacesState = {
    current: space,
    registry: {
      async open(): Promise<SpaceHandle> {
        return spacesState.current
      },
      async forSession(cwd: string | undefined): Promise<SpaceHandle> {
        if (cwd !== spacesState.current.root) {
          throw new Error(`cwd 不是空间根：${String(cwd)}`)
        }
        return spacesState.current
      },
      async roots(): Promise<string[]> {
        return [spacesState.current.root]
      },
    } satisfies SpaceRegistry,
  }
  const rootAgent = makeAgent('session-1', root)
  const agents: HostContext['agents'] = {
    get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
    roots: () => [rootAgent],
  }
  const service = {
    spaces: spacesState.registry,
    ownership,
    runs,
    bindings,
    approvals,
    workflows,
  } as unknown as TaktflowService
  const tools = new Map(
    registerLeadTools(defineToolStub, service, {
      ...(options.withCtx === false ? {} : { ctx: { agents } }),
      ...(options.user !== undefined ? { user: options.user } : {}),
    }).map((tool) => [tool.name, tool]),
  )

  return {
    root,
    space,
    spaces: spacesState,
    ownership,
    bindings,
    runs,
    workflows,
    approvals,
    service,
    rootAgent,
    agents,
    tools,
    async call(name, args, agent: Agent | null = rootAgent) {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`未注册工具：${name}`)
      return await tool.execute(args, execFor(agent ?? undefined)) as LeadToolResult
    },
  }
}

async function seedRequirement(h: Harness, id: string, title = `需求 ${id}`): Promise<void> {
  await h.space.stores.workspaces.createRequirement({ id, title })
}

async function bindRequirement(h: Harness, requirementId: string, sessionId = 'session-1'): Promise<void> {
  await h.bindings.bind(h.space, requirementId, sessionId, alice)
}

async function seedRun(
  h: Harness,
  runId: string,
  requirementId: string,
  startedAt = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  const state: RunState = {
    runId,
    workflowId: 'p0-delivery',
    workflowVersion: '1',
    requirementId,
    status: 'running',
    startedAt,
    args: {},
    nodes: {},
    expansions: [],
  }
  const workflow: WorkflowSnapshot = {
    id: 'p0-delivery',
    title: 'P0 交付',
    version: '1',
    stages: [],
    nodes: [],
  }
  await h.space.stores.runs.create(state, workflow)
}

async function seedAttention(
  h: Harness,
  requestId: string,
  requirementId: string,
  runId = 'run-001',
): Promise<AttentionItem> {
  // 待办冻结了 attempt，core 落回答时会核对节点快照；测试必须提供真实 run/node，
  // 不能只造 attention 记录，否则会被 freshness 判为“节点不存在”。
  const node = { id: 'design', status: 'waiting_human' as const, attempts: 1, outputs: [] }
  const existing = await h.space.stores.runs.get(runId)
  if (existing !== undefined) {
    if (existing.nodes.design === undefined) {
      existing.nodes.design = node
      await h.space.stores.runs.save(existing)
    }
  } else {
    await h.space.stores.runs.create({
      runId,
      workflowId: 'p0-delivery',
      workflowVersion: '1',
      requirementId,
      status: 'waiting_human',
      startedAt: '2026-01-01T00:00:00.000Z',
      args: {},
      nodes: { design: node },
      expansions: [],
    }, {
      id: 'p0-delivery',
      title: 'P0 交付',
      version: '1',
      stages: [],
      nodes: [],
    })
  }
  return await h.space.stores.attention.create({
    requestId,
    runId,
    nodeId: 'design',
    requirementId,
    ask: '请审批设计',
    form: 'approve',
    attempt: 1,
    subjects: [],
  })
}

describe('registerLeadTools', () => {
  it('按固定顺序注册 7 个工具，描述含使用时机和示例', async () => {
    const h = await makeHarness()
    expect([...h.tools.keys()]).toEqual([...LEAD_TOOL_NAMES])
    for (const tool of h.tools.values()) {
      expect(tool.description).toContain('何时用')
      expect(tool.description).toContain('示例')
      expect(typeof tool.parameters).toBe('object')
      expect(tool.output.schema).toMatchObject({ type: 'object', additionalProperties: true })
    }
    expect(h.tools.get('takt_requirement')?.parameters).toMatchObject({
      action: { type: 'string', required: true },
    })
  })
})

describe('身份与初始化授权', () => {
  it('没有 Agent 身份时拒绝', async () => {
    const h = await makeHarness()
    const result = await h.call('takt_status', {}, null)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(result.error?.hint).toBeDefined()
    expect(result.next_actions.length).toBeGreaterThan(0)
  })

  it('没有可信 ctx 时拒绝，而不是放宽权限', async () => {
    const h = await makeHarness({ withCtx: false })
    const result = await h.call('takt_status', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(result.error?.message).toContain('agents')
  })

  it('Agent 已不在线时拒绝', async () => {
    const h = await makeHarness()
    const ghost = makeAgent('session-ghost', h.root)
    const result = await h.call('takt_status', {}, ghost)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('子 Agent 不能代替 Lead 根 Agent', async () => {
    const h = await makeHarness()
    const child = makeAgent('child-1', h.root)
    h.agents.get = (id: string) => (id === child.id ? child : id === h.rootAgent.id ? h.rootAgent : undefined)
    const result = await h.call('takt_status', {}, child)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(result.error?.message).toContain('根 Agent')
  })

  it('伪造相同 id 但不同对象的 Agent 不能通过身份校验', async () => {
    const h = await makeHarness()
    const forged = makeAgent(h.rootAgent.id, h.root)
    h.agents.get = () => forged
    h.agents.roots = () => [forged]
    const result = await h.call('takt_status', {}, h.rootAgent)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(result.error?.message).toContain('存活')
  })

  it('非 taktflow preset 的根 Agent 不能调用 Lead 工具或创建绑定', async () => {
    const h = await makeHarness()
    const base = makeAgent('session-standard', h.root)
    const standard: Agent = {
      ...base,
      session: { header: { id: base.id, cwd: h.root, agentPreset: 'standard' } },
    }
    h.agents.get = () => standard
    h.agents.roots = () => [standard]
    const status = await h.call('takt_status', {}, standard)
    expect(status.ok).toBe(false)
    expect(status.error?.code).toBe('TAKT_NOT_BOUND')
    expect(status.error?.message).toContain('preset')

    const created = await h.call('takt_requirement', {
      action: 'create',
      title: '标准会话不能建需求',
      requestKey: 'standard-create-1',
    }, standard)
    expect(created.ok).toBe(false)
    expect(created.error?.code).toBe('TAKT_NOT_BOUND')
    await expect(h.bindings.bySession(h.space, 'session-standard')).resolves.toBeUndefined()
  })

  it('桌面版：会话按 standard 创建后切到 taktflow，以挂载的 preset 为准', async () => {
    const h = await makeHarness()
    const base = makeAgent('session-switched', h.root)
    const presets = { composedPreset: (ctx: unknown) => (ctx === agentCtx ? 'taktflow' : undefined) }
    const agentCtx = { get: (name: string) => (name === 'agentPresets' ? presets : undefined) }
    const switched: Agent = {
      ...base,
      session: { header: { id: base.id, cwd: h.root, agentPreset: 'standard' } },
      ctx: agentCtx,
    }
    h.agents.get = () => switched
    h.agents.roots = () => [switched]
    const status = await h.call('takt_status', {}, switched)
    expect(status.error?.message ?? '').not.toContain('preset')
  })

  it('header 写着 taktflow 但当前挂载的是别的 preset 时拒绝', async () => {
    const h = await makeHarness()
    const base = makeAgent('session-left', h.root)
    const agentCtx = { get: () => ({ composedPreset: () => 'standard' }) }
    const left: Agent = { ...base, ctx: agentCtx }
    h.agents.get = () => left
    h.agents.roots = () => [left]
    const status = await h.call('takt_status', {}, left)
    expect(status.ok).toBe(false)
    expect(status.error?.code).toBe('TAKT_NOT_BOUND')
    expect(status.error?.message).toContain('preset')
  })

  it('绑定表双向关系不一致时拒绝已绑定动作', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    const original = h.service.bindings.byRequirement.bind(h.service.bindings)
    h.service.bindings.byRequirement = async () => 'session-other'
    const result = await h.call('takt_artifact', { action: 'list' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(result.error?.message).toContain('不一致')
    h.service.bindings.byRequirement = original
  })

  it('绑定后只能访问自己的需求', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await seedRequirement(h, 'REQ-002')
    await bindRequirement(h, 'REQ-001')

    const own = await h.call('takt_status', { requirement: 'REQ-001' })
    expect(own.ok).toBe(true)
    expect((own.requirement as { id: string }).id).toBe('REQ-001')

    const other = await h.call('takt_status', { requirement: 'REQ-002' })
    expect(other.ok).toBe(false)
    expect(other.error?.code).toBe('TAKT_NOT_BOUND')
  })
})

describe('takt_status', () => {
  it('未绑定根返回空间、可用流程和初始化下一步，不泄露需求数据', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    const result = await h.call('takt_status', {})
    expect(result.ok).toBe(true)
    expect(result.bound).toBe(false)
    expect(result.workflows).toEqual(['p0-delivery'])
    expect(result.requirement).toBeUndefined()
    expect((result.initialization as { steps: string[] }).steps.length).toBeGreaterThan(0)
    expect(result.next_actions.join('\n')).toContain('takt_requirement create')
    expect(result.next_actions.join('\n')).toContain('takt_requirement bind')
  })

  it('takt_status 使用空间异步目录展示流程，不依赖 ids 缓存', async () => {
    let listedFor: string | undefined
    const workflows: WorkflowCatalog = {
      ids: () => ['p0-delivery'],
      list: async (space) => {
        listedFor = space?.root
        return ['p0-delivery', 'standard']
      },
      load: async () => {
        throw new Error('测试不加载流程')
      },
    }
    const h = await makeHarness({ workflows })
    const result = await h.call('takt_status', {})
    expect(result.ok).toBe(true)
    expect(result.workflows).toEqual(['p0-delivery', 'standard'])
    expect(listedFor).toBe(h.root)
  })

  it('未绑定时显式请求需求也拒绝', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    const result = await h.call('takt_status', { requirement: 'REQ-001' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('已绑定返回自己的需求、最近运行和待办', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    await seedRun(h, 'run-001', 'REQ-001', '2026-01-02T00:00:00.000Z')
    await seedAttention(h, 'run-001:design', 'REQ-001')

    const result = await h.call('takt_status', {})
    expect(result.ok).toBe(true)
    expect(result.bound).toBe(true)
    expect((result.requirement as { id: string }).id).toBe('REQ-001')
    expect((result.run as { runId: string }).runId).toBe('run-001')
    expect((result.attention as unknown[]).length).toBe(1)
    // 旧字段保留，同时追加可核对的运行增量视图。
    const runStatus = result.runStatus as {
      runId: string
      pending: Array<{ requestId: string; handling: string; escalation: boolean }>
    }
    expect(runStatus.runId).toBe('run-001')
    expect(runStatus.pending[0]).toMatchObject({ requestId: 'run-001:design', handling: 'human', escalation: false })
    expect(result.next_actions.join('\n')).toContain('takt_ask_human')
  })

  it('runStatus 从真实决策产物给出自主升级原因与来源，不把普通待办冒充升级', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    await seedRun(h, 'run-001', 'REQ-001', '2026-01-02T00:00:00.000Z')
    const item = await seedAttention(h, 'run-001:design', 'REQ-001')
    const decisionPath = autoAnswerPath(item.requestId)
    await h.space.stores.workspaces.writeArtifact({
      ref: { workspace: 'REQ-001', path: decisionPath },
      content: [
        '# 自主审批记录',
        '',
        '- 处置：escalate',
        '',
        '## Blocker',
        '',
        '- 缺少质量报告正文',
        '',
        '## 未解决项',
        '',
        '- 回归范围未确认',
        '',
        '## 理由',
        '',
        '证据不足，需要人判断',
        '',
      ].join('\n'),
      kind: 'decision',
      author: { type: 'agent', role: 'release-reviewer', harness: 'dsh-host', onBehalfOf: 'alice' },
      reason: '自主升级',
      producedBy: { runId: 'run-001', nodeId: 'design' },
    })

    const result = await h.call('takt_status', {})
    const pending = (result.runStatus as {
      pending: Array<{
        requestId: string
        handling: string
        escalation: boolean
        escalationReason: string | null
        escalationSource: string | null
        marker: { type: string } | null
      }>
    }).pending
    expect(pending[0]).toMatchObject({
      requestId: item.requestId,
      handling: 'human',
      escalation: true,
      escalationReason: '证据不足，需要人判断',
      escalationSource: `${decisionPath}@v1`,
      marker: { type: 'autonomy.escalated' },
    })

    // AI 正在处理时 handling=ai，即使同路径有历史升级产物也不显示为“等人升级”。
    const release = beginAutonomyAnswer(h.space.root, item.requestId)
    try {
      const during = await h.call('takt_status', {})
      expect((during.runStatus as { pending: Array<{ handling: string; escalation: boolean }> }).pending[0])
        .toMatchObject({ handling: 'ai', escalation: false })
    } finally {
      release()
    }
  })
})

describe('takt_requirement create', () => {
  it('创建需求、自动绑定并写审计人', async () => {
    const h = await makeHarness({ user: 'Alice' })
    const result = await h.call('takt_requirement', {
      action: 'create',
      title: '支付回调重试',
      requestKey: 'req-001',
      links: [{ type: 'url', url: 'https://example.com/prd', title: 'PRD' }],
    })
    expect(result.ok).toBe(true)
    expect(result.bound).toBe(true)
    expect((result.requirement as { title: string }).title).toBe('支付回调重试')
    expect((result.audit as { by: string }).by).toBe('Alice')
    expect(await h.bindings.bySession(h.space, 'session-1')).toBe((result.requirement as { id: string }).id)

    const file = JSON.parse(await readFile(bindingsFile(h.space), 'utf8')) as {
      bindings: Array<{ by: Actor }>
    }
    expect(file.bindings[0]?.by).toEqual({ type: 'human', id: 'Alice' })

    const ledgerFile = createRequestsFile(h.space)
    expect(ledgerFile.endsWith(path.join('runs', '.dsh', 'requests.json'))).toBe(true)
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as {
      creates: Record<string, CreateRequestRecord>
    }
    expect(ledger.creates['req-001']?.status).toBe('completed')
    expect(ledger.creates['req-001']?.by).toEqual({ type: 'human', id: 'Alice' })
  })

  it('同一 requestKey 重试返回同一需求', async () => {
    const h = await makeHarness()
    const first = await h.call('takt_requirement', { action: 'create', title: '幂等需求', requestKey: 'req-idem' })
    const second = await h.call('takt_requirement', { action: 'create', title: '幂等需求', requestKey: 'req-idem' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.deduped).toBe(true)
    expect((second.requirement as { id: string }).id).toBe((first.requirement as { id: string }).id)
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
  })

  it('同一 requestKey 输入变化时拒绝', async () => {
    const h = await makeHarness()
    await h.call('takt_requirement', { action: 'create', title: '原标题', requestKey: 'req-change' })
    const changed = await h.call('takt_requirement', { action: 'create', title: '新标题', requestKey: 'req-change' })
    expect(changed.ok).toBe(false)
    expect(changed.error?.code).toBe('TAKT_INVALID_INPUT')
    expect(changed.error?.hint).toContain('requestKey')
  })

  it('同一会话并发不同 requestKey 只创建一个需求', async () => {
    const h = await makeHarness()
    const results = await Promise.all([
      h.call('takt_requirement', { action: 'create', title: '并发一', requestKey: 'req-c1' }),
      h.call('takt_requirement', { action: 'create', title: '并发二', requestKey: 'req-c2' }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)[0]?.error?.code).toBe('TAKT_NOT_BOUND')
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
  })

  it('并发同一 requestKey 只创建一个需求', async () => {
    const h = await makeHarness()
    const results = await Promise.all([
      h.call('takt_requirement', { action: 'create', title: '并发同键', requestKey: 'req-same' }),
      h.call('takt_requirement', { action: 'create', title: '并发同键', requestKey: 'req-same' }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.filter((result) => result.deduped === true)).toHaveLength(1)
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
  })

  it('create 暂停期间并发 bind 已有需求：串行化后只有一方赢，创建的 REQ 必定绑定', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-B', '已有需求')

    // 在 createRequirement 落盘前卡住 create，让它持着初始化事务锁暂停。
    const workspaces = h.space.stores.workspaces
    const originalCreate = workspaces.createRequirement.bind(workspaces)
    let releaseCreate!: () => void
    const gate = new Promise<void>((resolve) => { releaseCreate = resolve })
    let enteredCreate!: () => void
    const createEntered = new Promise<void>((resolve) => { enteredCreate = resolve })
    workspaces.createRequirement = async (input) => {
      enteredCreate()
      await gate
      return originalCreate(input)
    }

    // 记录 bindings.bind 的调用；修复前 bind 会在 create 暂停时抢先写入 REQ-B。
    const bindCalls: string[] = []
    const originalBind = h.bindings.bind.bind(h.bindings)
    h.bindings.bind = async (space, requirementId, sessionId, by) => {
      bindCalls.push(requirementId)
      return originalBind(space, requirementId, sessionId, by)
    }

    try {
      const creating = h.call('takt_requirement', {
        action: 'create',
        title: '交错创建',
        requestKey: 'req-interleave',
        id: 'REQ-A',
      })
      await createEntered

      const binding = h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-B' })
      // bind 必须等 create 的事务锁，而不是先写 REQ-B。
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(bindCalls).toEqual([])

      releaseCreate()
      const [created, bound] = await Promise.all([creating, binding])

      expect(created.ok).toBe(true)
      expect((created.requirement as { id: string }).id).toBe('REQ-A')
      expect(bound.ok).toBe(false)
      expect(bound.error?.code).toBe('TAKT_NOT_BOUND')
      expect(bindCalls).toEqual(['REQ-A'])
      expect(await h.bindings.bySession(h.space, 'session-1')).toBe('REQ-A')
      expect(await h.bindings.byRequirement(h.space, 'REQ-A')).toBe('session-1')
      expect(await h.bindings.byRequirement(h.space, 'REQ-B')).toBeUndefined()

      const ledger = JSON.parse(await readFile(createRequestsFile(h.space), 'utf8')) as {
        creates: Record<string, CreateRequestRecord>
      }
      expect(ledger.creates['req-interleave']?.status).toBe('completed')
      expect(ledger.creates['req-interleave']?.requirementId).toBe('REQ-A')
    } finally {
      releaseCreate()
      workspaces.createRequirement = originalCreate
      h.bindings.bind = originalBind
    }
  })

  it('另一个会话不能复用同名 requestKey 接管需求', async () => {
    const h = await makeHarness()
    const first = await h.call('takt_requirement', { action: 'create', title: '会话一的需求', requestKey: 'shared-key' })
    expect(first.ok).toBe(true)

    const other = makeAgent('session-2', h.root)
    h.agents.get = (id: string) => (id === other.id ? other : id === h.rootAgent.id ? h.rootAgent : undefined)
    h.agents.roots = () => [h.rootAgent, other]
    const second = await h.call(
      'takt_requirement',
      { action: 'create', title: '会话一的需求', requestKey: 'shared-key' },
      other,
    )
    expect(second.ok).toBe(false)
    expect(second.error?.code).toBe('TAKT_NOT_BOUND')
    expect(second.error?.message).toContain('另一个')
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
    expect(await h.bindings.bySession(h.space, 'session-2')).toBeUndefined()
  })

  it('支持显式需求 ID', async () => {
    const h = await makeHarness()
    const result = await h.call('takt_requirement', {
      action: 'create',
      title: '指定 ID',
      requestKey: 'req-explicit',
      id: 'REQ-777',
    })
    expect(result.ok).toBe(true)
    expect((result.requirement as { id: string }).id).toBe('REQ-777')
  })

  it('已绑定会话不能再次创建', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    const result = await h.call('takt_requirement', { action: 'create', title: '第二个', requestKey: 'req-second' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
  })

  it('requestKey 使用 constructor/toString 也不会命中对象原型', async () => {
    const h = await makeHarness()
    const ctor = await h.call('takt_requirement', { action: 'create', title: '原型键一', requestKey: 'constructor' })
    expect(ctor.ok).toBe(true)
    const toString = await h.call('takt_requirement', { action: 'create', title: '原型键二', requestKey: 'toString' })
    // 同一会话已绑定第一个需求，第二次创建应被拒绝，而不是从原型取到“已有记录”。
    expect(toString.ok).toBe(false)
    expect(toString.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('pending 账本 + 已存在需求时恢复绑定，不重复创建', async () => {
    const h = await makeHarness()
    const requestKey = 'req-recover'
    const title = '恢复需求'
    const id = 'REQ-RECOVER'
    await seedRequirement(h, id, title)
    await withCreateLedger(h.space, async (ledger) => {
      await ledger.put({
        requestKey,
        requirementId: id,
        fingerprint: fingerprintCreateInput({ title, id }),
        sessionId: 'session-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        by: alice,
      })
    })

    const result = await h.call('takt_requirement', { action: 'create', title, requestKey, id })
    expect(result.ok).toBe(true)
    expect(result.deduped).toBe(true)
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
    expect(await h.bindings.bySession(h.space, 'session-1')).toBe(id)
  })

  it('pending 账本 + 需求未创建时按预留 ID 补创建', async () => {
    const h = await makeHarness()
    const requestKey = 'req-pending-only'
    const title = '预留后崩溃'
    const id = 'REQ-PENDING'
    await withCreateLedger(h.space, async (ledger) => {
      await ledger.put({
        requestKey,
        requirementId: id,
        fingerprint: fingerprintCreateInput({ title, id }),
        sessionId: 'session-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        by: alice,
      })
    })

    const result = await h.call('takt_requirement', { action: 'create', title, requestKey, id })
    expect(result.ok).toBe(true)
    expect((result.requirement as { id: string }).id).toBe(id)
    expect(await h.space.stores.workspaces.listRequirements()).toHaveLength(1)
  })

  it('pending 预留 ID 被不同内容占用时拒绝并清理账本', async () => {
    const h = await makeHarness()
    const requestKey = 'req-collision'
    const id = 'REQ-COLLISION'
    await seedRequirement(h, id, '别人的需求')
    await withCreateLedger(h.space, async (ledger) => {
      await ledger.put({
        requestKey,
        requirementId: id,
        fingerprint: fingerprintCreateInput({ title: '我的需求', id }),
        sessionId: 'session-1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        by: alice,
      })
    })

    const result = await h.call('takt_requirement', {
      action: 'create',
      title: '我的需求',
      requestKey,
      id,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_INVALID_INPUT')
    await withCreateLedger(h.space, async (ledger) => {
      expect(ledger.get(requestKey)).toBeUndefined()
    })
  })

  it('已完成账本指向不存在的需求时拒绝', async () => {
    const h = await makeHarness()
    await withCreateLedger(h.space, async (ledger) => {
      await ledger.put({
        requestKey: 'req-dangling',
        requirementId: 'REQ-GONE',
        fingerprint: fingerprintCreateInput({ title: '已删除' }),
        sessionId: 'session-1',
        status: 'completed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        by: alice,
      })
    })
    const result = await h.call('takt_requirement', {
      action: 'create',
      title: '已删除',
      requestKey: 'req-dangling',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })
})

describe('takt_requirement bind', () => {
  it('绑定已有需求', async () => {
    const h = await makeHarness({ user: 'Alice' })
    await seedRequirement(h, 'REQ-001')
    const result = await h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-001' })
    expect(result.ok).toBe(true)
    expect(await h.bindings.bySession(h.space, 'session-1')).toBe('REQ-001')
    const file = JSON.parse(await readFile(bindingsFile(h.space), 'utf8')) as {
      bindings: Array<{ by: Actor; boundAt: string }>
    }
    expect(file.bindings[0]?.by).toEqual({ type: 'human', id: 'Alice' })
    expect(Number.isFinite(Date.parse(file.bindings[0]!.boundAt))).toBe(true)
  })

  it('绑定不存在的需求时拒绝', async () => {
    const h = await makeHarness()
    const result = await h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-404' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('已绑定其它需求时拒绝', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await seedRequirement(h, 'REQ-002')
    await bindRequirement(h, 'REQ-001')
    const result = await h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-002' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('重复绑定同一需求是幂等的', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-001' })
    const again = await h.call('takt_requirement', { action: 'bind', requirementId: 'REQ-001' })
    expect(again.ok).toBe(true)
  })

  it('P1 action 返回明确提示', async () => {
    const h = await makeHarness()
    for (const action of ['update', 'import_link']) {
      const result = await h.call('takt_requirement', { action })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('TAKT_UNSUPPORTED_ACTION')
      expect(result.error?.hint).toBeDefined()
    }
  })
})

describe('takt_artifact', () => {
  async function boundHarness(): Promise<Harness> {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    return h
  }

  it('list 空存放区', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_artifact', { action: 'list' })
    expect(result.ok).toBe(true)
    expect(result.artifacts).toEqual([])
  })

  it('write 新建、读取和版本历史', async () => {
    const h = await boundHarness()
    const written = await h.call('takt_artifact', {
      action: 'write',
      path: 'decisions/lead-notes.md',
      content: '# 决策\n\n先做 P0。',
      reason: '记录 Lead 决策',
      baseVersion: 0,
    })
    expect(written.ok).toBe(true)
    expect(written.version).toBe(1)
    expect((written.audit as { by: string }).by).toBeTruthy()
    const actor = (written.audit as { actor: Actor }).actor
    expect(actor).toMatchObject({ type: 'agent', role: 'lead', harness: 'dsh-host', model: 'test-model' })

    const list = await h.call('takt_artifact', { action: 'list' })
    expect((list.artifacts as unknown[]).length).toBe(1)

    const read = await h.call('takt_artifact', { action: 'read', path: 'decisions/lead-notes.md' })
    expect(read.ok).toBe(true)
    expect(read.content).toContain('先做 P0')

    const log = await h.call('takt_artifact', { action: 'log', path: 'decisions/lead-notes.md' })
    expect((log.versions as unknown[]).length).toBe(1)
    expect(log.truncated).toBe(false)
  })

  it('clarifications/** 允许写入', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/q1.md',
      content: '答：先支持单空间。',
      reason: '记录澄清',
      baseVersion: 0,
    })
    expect(result.ok).toBe(true)
  })

  it('中文文件名合法，不因 ASCII 限制被拒', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/需求澄清.md',
      content: '中文内容',
      reason: '记录中文澄清',
      baseVersion: 0,
    })
    expect(result.ok).toBe(true)
    expect(result.path).toBe('clarifications/需求澄清.md')
    expect(assertLeadWritablePath('clarifications/需求澄清.md')).toBe('clarifications/需求澄清.md')

    const read = await h.call('takt_artifact', { action: 'read', path: 'clarifications/需求澄清.md' })
    expect(read.ok).toBe(true)
    expect(read.content).toBe('中文内容')
  })

  it('baseVersion 不匹配返回 TAKT_STALE_VERSION', async () => {
    const h = await boundHarness()
    await h.call('takt_artifact', {
      action: 'write',
      path: 'decisions/lead-notes.md',
      content: 'v1',
      reason: '第一次',
      baseVersion: 0,
    })
    const stale = await h.call('takt_artifact', {
      action: 'write',
      path: 'decisions/lead-notes.md',
      content: 'v2',
      reason: '第二次',
      baseVersion: 0,
    })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe('TAKT_STALE_VERSION')
    expect(stale.error?.hint).toContain('baseVersion=1')
  })

  it('禁止写白名单之外的路径', async () => {
    const h = await boundHarness()
    for (const target of ['design/design.md', 'decisions/other.md', 'reports/final.md']) {
      const result = await h.call('takt_artifact', {
        action: 'write',
        path: target,
        content: 'x',
        reason: '越界',
        baseVersion: 0,
      })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('TAKT_FORBIDDEN_FOR_LEAD')
      expect(result.error?.hint).toContain('takt_run')
    }
  })

  it('拒绝路径穿越、绝对路径和编码绕过', async () => {
    const h = await boundHarness()
    const badPaths = [
      '../evil.md',
      '/tmp/evil.md',
      'clarifications/../../evil.md',
      'clarifications/%2e%2e/evil.md',
      'clarifications/%2fetc/passwd',
      'clarifications/a b.md',
    ]
    for (const target of badPaths) {
      const result = await h.call('takt_artifact', {
        action: 'write',
        path: target,
        content: 'x',
        reason: '越界',
        baseVersion: 0,
      })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('TAKT_INVALID_INPUT')
    }
  })

  it('assertLeadWritablePath 直接校验白名单', () => {
    expect(assertLeadWritablePath('decisions/lead-notes.md')).toBe('decisions/lead-notes.md')
    expect(assertLeadWritablePath('clarifications/nested/q.md')).toBe('clarifications/nested/q.md')
    expect(() => assertLeadWritablePath('decisions/lead-notes.md.bak')).toThrow()
    expect(() => assertLeadWritablePath('clarifications')).toThrow()
  })

  it('write 缺少 reason/baseVersion 时拒绝', async () => {
    const h = await boundHarness()
    const noReason = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/q.md',
      content: 'x',
      baseVersion: 0,
    })
    expect(noReason.ok).toBe(false)
    expect(noReason.error?.code).toBe('TAKT_INVALID_INPUT')

    const noBase = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/q.md',
      content: 'x',
      reason: '缺版本',
    })
    expect(noBase.ok).toBe(false)
    expect(noBase.error?.code).toBe('TAKT_INVALID_INPUT')
  })

  it('读取不存在的产物时拒绝', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_artifact', { action: 'read', path: 'spec/none.md' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('跨 bundle 的已知错误码按 code 识别，不退化成内部错误', async () => {
    const h = await boundHarness()
    const foreign = Object.assign(new Error('空间被另一个宿主占用'), {
      code: 'TAKT_LEASE_HELD',
      hint: '等待占用结束后重试。',
    })
    h.ownership.failure = foreign
    const result = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/q.md',
      content: 'x',
      reason: '测试',
      baseVersion: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_LEASE_HELD')
    expect(result.error?.hint).toBe('等待占用结束后重试。')
    expect(result.next_actions.join('\n')).toContain('takt_status')
  })

  it('未知异常不把原始 message/stack 透给模型，且仍有 hint', async () => {
    const h = await boundHarness()
    h.ownership.failure = new Error('secret-token=abc /redacted-test-root/private/internal.ts')
    const result = await h.call('takt_artifact', {
      action: 'write',
      path: 'clarifications/q.md',
      content: 'x',
      reason: '测试',
      baseVersion: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_INTERNAL')
    expect(result.error?.message).not.toContain('secret-token')
    expect(result.error?.message).not.toContain('/redacted-test-root/private')
    expect(result.summary).not.toContain('secret-token')
    expect(result.error?.hint).toBeTruthy()
    expect(result.next_actions.length).toBeGreaterThan(0)
  })

  it('P1 action 返回明确提示', async () => {
    const h = await boundHarness()
    for (const action of ['diff', 'revert', 'comment']) {
      const result = await h.call('takt_artifact', { action })
      expect(result.error?.code).toBe('TAKT_UNSUPPORTED_ACTION')
    }
  })
})

describe('takt_run', () => {
  async function boundHarness(): Promise<Harness> {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    return h
  }

  it('start 透传 requestKey/ownerSessionId 并立即返回 runId', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_run', {
      action: 'start',
      requestKey: 'run-req-1',
      args: { mode: 'fast' },
    })
    expect(result.ok).toBe(true)
    expect(result.runId).toBe('run-001')
    expect(h.runs.starts).toHaveLength(1)
    expect(h.runs.starts[0]).toMatchObject({
      requirementId: 'REQ-001',
      workflowId: 'p0-delivery',
      ownerSessionId: 'session-1',
      requestKey: 'run-req-1',
      args: { mode: 'fast' },
    })
    expect((result.audit as { actor: Actor }).actor).toMatchObject({ role: 'lead', onBehalfOf: expect.any(String) })
    expect(h.ownership.ensureCalls).toBeGreaterThan(0)
  })

  it('ids 只有 p0 时显式 start 空间流程仍按异步目录校验并透传 workflow', async () => {
    const workflows: WorkflowCatalog = {
      ids: () => ['p0-delivery'],
      list: async () => ['p0-delivery', 'standard'],
      load: async () => {
        throw new Error('测试不加载流程')
      },
    }
    const h = await makeHarness({ workflows })
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    const result = await h.call('takt_run', {
      action: 'start',
      requestKey: 'run-req-space',
      workflow: 'standard',
    })
    expect(result.ok).toBe(true)
    expect(h.runs.starts).toHaveLength(1)
    expect(h.runs.starts[0]).toMatchObject({ requirementId: 'REQ-001', workflowId: 'standard' })
  })

  it('省略 workflow 时使用空间 defaultId 的首个自定义流程', async () => {
    const workflows: WorkflowCatalog = {
      ids: () => ['p0-delivery'],
      list: async () => ['p0-delivery', 'custom-first'],
      defaultId: async () => 'custom-first',
      load: async () => {
        throw new Error('测试不加载流程')
      },
    }
    const h = await makeHarness({ workflows })
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    const result = await h.call('takt_run', {
      action: 'start',
      requestKey: 'run-req-default',
    })
    expect(result.ok).toBe(true)
    expect(h.runs.starts).toHaveLength(1)
    expect(h.runs.starts[0]).toMatchObject({ requirementId: 'REQ-001', workflowId: 'custom-first' })
  })

  it('未知流程返回 TAKT_UNSUPPORTED_NODE', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_run', {
      action: 'start',
      requestKey: 'run-req-2',
      workflow: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_UNSUPPORTED_NODE')
    expect(h.runs.starts).toHaveLength(0)
  })

  it('get 不传 runId 时取最近一次运行', async () => {
    const h = await boundHarness()
    await seedRun(h, 'run-001', 'REQ-001', '2026-01-01T00:00:00.000Z')
    await seedRun(h, 'run-002', 'REQ-001', '2026-01-02T00:00:00.000Z')
    const result = await h.call('takt_run', { action: 'get' })
    expect(result.ok).toBe(true)
    expect((result.run as { runId: string }).runId).toBe('run-002')
  })

  it('get 不能读取其它需求的运行', async () => {
    const h = await boundHarness()
    await seedRequirement(h, 'REQ-002')
    await seedRun(h, 'run-other', 'REQ-002')
    const result = await h.call('takt_run', { action: 'get', runId: 'run-other' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('cancel 只作用于自己的运行', async () => {
    const h = await boundHarness()
    await seedRun(h, 'run-001', 'REQ-001')
    const result = await h.call('takt_run', { action: 'cancel', runId: 'run-001' })
    expect(result.ok).toBe(true)
    expect(h.runs.cancels).toHaveLength(1)
    expect(h.runs.cancels[0]?.runId).toBe('run-001')
    expect(h.runs.cancels[0]?.by).toMatchObject({ role: 'lead' })
  })

  it('P1 action 返回明确提示', async () => {
    const h = await boundHarness()
    for (const action of ['rerun_from', 'dispatch', 'ask']) {
      const result = await h.call('takt_run', { action })
      expect(result.error?.code).toBe('TAKT_UNSUPPORTED_ACTION')
    }
  })
})

describe('takt_trace', () => {
  async function boundHarness(): Promise<Harness> {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    return h
  }

  it('audit 真实事件链返回完整', async () => {
    const h = await boundHarness()
    await seedRun(h, 'run-001', 'REQ-001')
    await h.space.stores.events.append('run-001', {
      type: 'log',
      actor: { type: 'system', id: 'test' },
      data: { level: 'info', message: 'hello' },
    })
    const result = await h.call('takt_trace', { action: 'audit', runId: 'run-001' })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.summary).toContain('完整')
  })

  it('把 truncated 渲染成可定位的摘要', async () => {
    const h = await boundHarness()
    await seedRun(h, 'run-001', 'REQ-001')
    const patched: SpaceHandle = {
      ...h.space,
      stores: Object.assign(Object.create(h.space.stores), {
        events: {
          verify: async () => ({ ok: false, brokenAt: 3, reason: 'truncated' }),
        },
      }),
    }
    h.spaces.current = patched
    const result = await h.call('takt_trace', { action: 'audit', runId: 'run-001' })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.reason).toBe('truncated')
    expect((result.position as { seq: number }).seq).toBe(3)
    expect(result.summary).toContain('截断')
    // 审计不通过仍是“工具调用成功”，但下一步必须给出可执行的工具。
    expect(result.ok).toBe(true)
    expect(result.next_actions.join('\n')).toContain('takt_run get')
    expect(result.next_actions.join('\n')).toContain('takt_status')
    expect(result.hint).toContain('保留现场')
  })

  it('运行不存在时拒绝', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_trace', { action: 'audit', runId: 'run-404' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('未实现的 action 返回明确提示', async () => {
    const h = await boundHarness()
    for (const action of ['coverage', 'compare']) {
      const result = await h.call('takt_trace', { action })
      expect(result.error?.code).toBe('TAKT_UNSUPPORTED_ACTION')
    }
  })

  it('M3 action 在未接线宿主上明确失败，而不是静默成功', async () => {
    const h = await boundHarness()
    for (const action of ['defects', 'why', 'scorecard']) {
      const result = await h.call('takt_trace', { action })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('TAKT_UNSUPPORTED_NODE')
    }
  })
})

describe('takt_ask_human', () => {
  async function boundHarness(): Promise<Harness> {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    return h
  }

  it('把待办呈现给人；未回答时返回 pending 并允许重新 ask', async () => {
    const h = await boundHarness()
    await seedAttention(h, 'run-001:design', 'REQ-001')
    const result = await h.call('takt_ask_human', { requestId: 'run-001:design' })
    expect(result.ok).toBe(true)
    expect(result.presented).toBe(true)
    expect(result.answered).toBe(false)
    expect(result.pending).toBe(true)
    expect(h.approvals.presented).toEqual([{ requestId: 'run-001:design', sessionId: 'session-1' }])
    expect(result.next_actions.join('\n')).toContain('takt_ask_human')
    expect(result.next_actions.join('\n')).toContain('takt_run get')
  })

  it('present 期间人已回答时，返回 answered/decision 而不是继续等待', async () => {
    const h = await boundHarness()
    await seedAttention(h, 'run-001:design', 'REQ-001')
    h.approvals.onPresent = async (space, requestId) => {
      await space.stores.attention.answer(requestId, { decision: 'approve', by: alice })
    }
    const result = await h.call('takt_ask_human', { requestId: 'run-001:design' })
    expect(result.ok).toBe(true)
    expect(result.presented).toBe(true)
    expect(result.answered).toBe(true)
    expect(result.decision).toBe('approve')
    expect(result.next_actions).toEqual(['takt_run get runId="run-001"'])
  })

  it('已回答的待办不再重复呈现', async () => {
    const h = await boundHarness()
    await seedAttention(h, 'run-001:design', 'REQ-001')
    await h.space.stores.attention.answer('run-001:design', { decision: 'approve', by: alice })
    const result = await h.call('takt_ask_human', { requestId: 'run-001:design' })
    expect(result.ok).toBe(true)
    expect(result.answered).toBe(true)
    expect(h.approvals.presented).toHaveLength(0)
  })

  it('不存在的待办拒绝', async () => {
    const h = await boundHarness()
    const result = await h.call('takt_ask_human', { requestId: 'run-404:design' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
  })

  it('其它需求的待办拒绝', async () => {
    const h = await boundHarness()
    await seedRequirement(h, 'REQ-002')
    await seedAttention(h, 'run-002:design', 'REQ-002', 'run-002')
    const result = await h.call('takt_ask_human', { requestId: 'run-002:design' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(h.approvals.presented).toHaveLength(0)
  })
})

describe('首次调用友好度', () => {
  it('参数缺失时每个工具都返回带 hint 和 next_actions 的结构化错误', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    for (const name of ['takt_requirement', 'takt_artifact', 'takt_run', 'takt_trace', 'takt_ask_human']) {
      const result = await h.call(name, {})
      expect(result.ok).toBe(false)
      expect(result.error?.hint).toBeTruthy()
      expect(result.next_actions.length).toBeGreaterThan(0)
      expect(result.summary.length).toBeGreaterThan(0)
    }
  })

  it('结果渲染成一行摘要和完整结构化 JSON', async () => {
    const h = await makeHarness()
    const tool = h.tools.get('takt_requirement')!
    const result = await tool.execute({ action: 'create' }, execFor(h.rootAgent)) as LeadToolResult
    const blocks = tool.output.render({}, result as unknown as never)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: result.summary })
    // dsh 保存/送模型的是 content；结构化字段必须在 JSON block 里完整可见。
    expect(JSON.parse((blocks[1] as { text: string }).text)).toEqual(result)
    expect((blocks[1] as { text: string }).text).toContain('next_actions')
    expect((blocks[1] as { text: string }).text).toContain('TAKT_INVALID_INPUT')
  })

  it('工具渲染与错误摘要都不透传换行', async () => {
    const h = await makeHarness()
    await seedRequirement(h, 'REQ-001')
    await bindRequirement(h, 'REQ-001')
    const tool = h.tools.get('takt_run')!
    const result = await tool.execute(
      { action: 'start', workflow: 'bad\nworkflow', requestKey: 'run-key-newline' },
      execFor(h.rootAgent),
    ) as LeadToolResult
    expect(result.ok).toBe(false)
    expect(result.summary).not.toContain('\n')
    expect(result.error?.message).not.toContain('\n')
    expect(result.error?.hint).not.toContain('\n')

    const rendered = tool.output.render({}, {
      ok: false,
      summary: '第一行\n第二行',
      next_actions: [],
    } as unknown as never)
    expect(rendered[0]).toEqual({ type: 'text', text: '第一行 第二行' })
    expect(JSON.parse((rendered[1] as { text: string }).text)).toEqual({
      ok: false,
      summary: '第一行\n第二行',
      next_actions: [],
    })
  })
})

describe('createLeadServices', () => {
  it('config.user 同时进入绑定记录和工具 actor', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taktflow-lead-services-'))
    roots.push(root)
    const stores = await initProject(root, { name: 'lead-services-test' })
    const space: SpaceHandle = { root, stores, insights: createInsights(stores) }
    const ownership = new FakeOwnership()
    const runs = new FakeRuns()
    const rootAgent = makeAgent('session-1', root)
    const agents = {
      get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
      roots: () => [rootAgent],
    }
    const spaces: SpaceRegistry = {
      async open() {
        return space
      },
      async forSession() {
        return space
      },
      async roots() {
        return [root]
      },
    }
    const services = createLeadServices({
      spaces,
      ownership,
      runs,
      ctx: {
        agents,
        userQuestions: { ask: vi.fn(async () => ({ answers: [] })) },
      },
      config: { user: 'ConfigUser' },
    })
    const service = {
      spaces,
      ownership,
      runs,
      bindings: services.bindings,
      approvals: services.approvals,
      workflows: { ids: () => ['p0-delivery'], load: async () => { throw new Error('no') } },
    } as unknown as TaktflowService
    const tools = new Map(
      registerLeadTools(defineToolStub, service, { ctx: { agents } }).map((tool) => [tool.name, tool]),
    )

    const created = await tools.get('takt_requirement')!.execute(
      { action: 'create', title: '服务工厂需求', requestKey: 'svc-1' },
      execFor(rootAgent),
    ) as LeadToolResult
    expect(created.ok).toBe(true)
    const file = JSON.parse(await readFile(bindingsFile(space), 'utf8')) as {
      bindings: Array<{ by: Actor }>
    }
    expect(file.bindings[0]?.by).toEqual({ type: 'human', id: 'ConfigUser' })

    const written = await tools.get('takt_artifact')!.execute(
      {
        action: 'write',
        path: 'decisions/lead-notes.md',
        content: '决策',
        reason: '记录',
        baseVersion: 0,
      },
      execFor(rootAgent),
    ) as LeadToolResult
    expect(written.ok).toBe(true)
    expect((written.audit as { actor: Actor }).actor).toMatchObject({ onBehalfOf: 'ConfigUser' })
  })
})
