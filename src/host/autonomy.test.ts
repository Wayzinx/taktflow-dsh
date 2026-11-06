import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInsights,
  initProject,
  snapshotWorkflow,
  type ArtifactRef,
  type AttentionItem,
  type HarnessRequest,
  type HarnessResult,
  type NodeStatus,
  type ProjectStores,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApprovals } from './approvals.js'
import { autonomyStep, nodeKindOf, type AutonomyDriveDeps } from './autonomy.js'
import type { DshHarness } from './dsh-harness.js'
import type { Notifier, Ownership, RunManager, SpaceHandle } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const workflow: WorkflowDefinition = {
  id: 'autonomy-wf',
  title: '自主审批测试',
  version: '1',
  stages: [],
  nodes: [
    { id: 'approve', kind: 'human', title: '人工准出', needs: [], ask: '是否准出？', form: 'approve' },
    { id: 'answer', kind: 'human', title: '人工回答', needs: [], ask: '请回答', form: 'answer' },
    { id: 'review-node', kind: 'review', title: '交叉评审', needs: [], target: ['reports/quality.md'], author: { role: 'pm' }, reviewers: [{ role: 'release-reviewer' }], maxRounds: 1, onExhausted: 'human', humanSignoff: true },
    { id: 'judge-node', kind: 'judge', title: '失败判决', needs: [], role: 'judge', target: 'approve', routes: {} },
  ],
}

interface FixtureOptions {
  form?: 'approve' | 'answer'
  nodeId?: string
  nodeStatus?: NodeStatus
  paths?: Array<{ path: string; content: string }>
  attempt?: number
}

interface Fixture {
  space: SpaceHandle
  stores: ProjectStores
  requirementId: string
  runId: string
  requestId: string
  refs: ArtifactRef[]
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'takt-autonomy-')))
  roots.push(root)
  const stores = await initProject(root, { name: 'autonomy' })
  const requirementId = (await stores.workspaces.createRequirement({ title: '自主审批需求' })).id
  const files = options.paths ?? [
    { path: 'reports/quality.md', content: '# 质量报告\n全部用例通过。' },
    { path: 'reports/impact.md', content: '# 影响面\n仅影响审批链路。' },
    { path: 'reviews/r1.md', content: '# 评审\n未发现阻塞问题。' },
  ]
  const refs: ArtifactRef[] = []
  for (const file of files) {
    const written = await stores.workspaces.writeArtifact({
      ref: { workspace: requirementId, path: file.path },
      content: file.content,
      kind: file.path.startsWith('reports/') ? 'report' : 'review',
      author: { type: 'system', id: 'test' },
    })
    refs.push({ workspace: written.workspace, path: written.path, version: written.version })
  }

  const runId = 'run-autonomy-1'
  const nodeId = options.nodeId ?? 'approve'
  const state: RunState = {
    runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    requirementId,
    status: 'waiting_human',
    startedAt: new Date().toISOString(),
    args: {},
    nodes: {
      [nodeId]: {
        id: nodeId,
        status: options.nodeStatus ?? 'waiting_human',
        attempts: options.attempt ?? 1,
        outputs: [],
        inputs: [],
      },
    },
    expansions: [],
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  const requestId = `${runId}:${nodeId}`
  await stores.attention.create({
    requestId,
    runId,
    nodeId,
    requirementId,
    ask: nodeId === 'answer' ? '请回答' : '是否准出？',
    form: options.form ?? (nodeId === 'answer' ? 'answer' : 'approve'),
    attempt: options.attempt ?? 1,
    subjects: [],
  })
  return {
    space: { root, stores, insights: createInsights(stores) },
    stores,
    requirementId,
    runId,
    requestId,
    refs,
  }
}

function ownershipStub(): Ownership {
  return {
    hostOwner: 'dsh:test',
    async ensureLease() {},
    async release() {},
    async takeover() {},
    async recordRun() {},
    async readRun() { return undefined },
    async setEndReason() {},
  }
}

function runsStub(): RunManager {
  return {
    async start() { return { runId: 'run-x', deduped: false } },
    async cancel() {},
    async resume() {},
    async get() { return undefined },
    async onAnswered() {},
    async disposeAll() {},
  }
}

function approvalsFor(fixture: Fixture) {
  return createApprovals({
    ctx: { agents: { get: () => undefined, roots: () => [] } },
    ownership: ownershipStub(),
    runs: runsStub(),
    config: { user: '审批人' },
  })
}

function notifierStub(): { notifier: Notifier; notifyEscalation: ReturnType<typeof vi.fn> } {
  const notifyEscalation = vi.fn(async () => {})
  return {
    notifyEscalation,
    notifier: {
      async attach() {},
      async detach() {},
      notifyEscalation,
    },
  }
}

function harnessStub(
  run: (request: HarnessRequest) => Promise<HarnessResult> | HarnessResult,
  calls: HarnessRequest[] = [],
): DshHarness {
  return {
    id: 'dsh-host',
    displayName: '测试子 Agent',
    async available() { return { ok: true } },
    async run(request) {
      calls.push(request)
      return run(request)
    },
    async drain() {},
  }
}

function decision(patch: Record<string, unknown> = {}): HarnessResult {
  return {
    ok: true,
    finalText: '{}',
    structured: {
      disposition: 'approve',
      confidence: 0.95,
      evidence: [],
      blockers: [],
      unresolved: [],
      rationale: '质量、影响面与评审均已齐备，可以准出。',
      ...patch,
    },
  }
}

function depsFor(
  fixture: Fixture,
  overrides: Partial<AutonomyDriveDeps> = {},
): AutonomyDriveDeps {
  return {
    space: fixture.space,
    runId: fixture.runId,
    requirementId: fixture.requirementId,
    workflow,
    profiles: {
      'release-reviewer': {
        role: 'release-reviewer',
        title: '准出评审',
        description: '准出审批',
        harness: { harness: 'dsh-host' },
        instructions: '只依据冻结产物判断。',
        writeScope: [],
        allowBash: false,
        skills: [],
      },
      pm: {
        role: 'pm',
        title: '产品',
        description: '需求澄清',
        harness: { harness: 'dsh-host' },
        instructions: '回答澄清问题。',
        writeScope: [],
        allowBash: false,
        skills: [],
      },
    },
    autonomy: 'full',
    configUser: '审批人',
    harness: harnessStub(() => decision({ evidence: fixture.refs.map((ref) => ({ ...ref })) })),
    approvals: approvalsFor(fixture),
    signal: new AbortController().signal,
    log() {},
    ...overrides,
  }
}

async function stateOf(fixture: Fixture): Promise<RunState> {
  return (await fixture.stores.runs.get(fixture.runId))!
}

async function pending(fixture: Fixture): Promise<AttentionItem | undefined> {
  return (await fixture.stores.attention.list({ requirementId: fixture.requirementId, pending: true }))
    .find((item) => item.requestId === fixture.requestId)
}

async function autoArtifacts(fixture: Fixture) {
  return (await fixture.stores.workspaces.listArtifacts(fixture.requirementId))
    .filter((record) => record.path.startsWith('decisions/auto-answers/'))
}

describe('autonomyStep：证据冻结与决策校验', () => {
  it('准出必要材料缺失时直接升级，不调用模型', async () => {
    const fixture = await makeFixture({
      paths: [
        { path: 'reports/impact.md', content: '# 影响面' },
        { path: 'reviews/r1.md', content: '# 评审' },
      ],
    })
    const calls: HarnessRequest[] = []
    const { notifier, notifyEscalation } = notifierStub()
    const step = await autonomyStep(depsFor(fixture, {
      harness: harnessStub(() => decision(), calls),
      notifier,
    }), await stateOf(fixture), new Set())

    expect(step).toMatchObject({ kind: 'escalated', reason: expect.stringContaining('reports/quality.md') })
    expect(calls).toHaveLength(0)
    expect(notifyEscalation).toHaveBeenCalledTimes(1)
    expect((await pending(fixture))?.answeredAt).toBeUndefined()
    const artifacts = await autoArtifacts(fixture)
    expect(artifacts).toHaveLength(1)
    const content = (await fixture.stores.workspaces.readArtifact({
      workspace: fixture.requirementId,
      path: artifacts[0]!.path,
      version: artifacts[0]!.versions.at(-1)!.version,
    }))?.toString('utf8') ?? ''
    expect(content).toContain('处置：escalate')
    expect(content).toContain('reports/quality.md')
  })

  it('模型输出合法批准时落账，提示词带需求 ID、workspace 与可引用清单', async () => {
    const fixture = await makeFixture()
    const calls: HarnessRequest[] = []
    const step = await autonomyStep(depsFor(fixture, {
      harness: harnessStub(() => decision({ evidence: fixture.refs.map((ref) => ({ ...ref })) }), calls),
    }), await stateOf(fixture), new Set())

    expect(step).toMatchObject({ kind: 'answered' })
    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.prompt
    expect(prompt).toContain(`requirementId（evidence.workspace 必须使用这个值）：${fixture.requirementId}`)
    expect(prompt).toContain(`workspace="${fixture.requirementId}" path="reports/quality.md"`)
    expect(prompt).toContain('可引用证据清单')
    expect(prompt).toContain('workspace="' + fixture.requirementId + '" path="reviews/r1.md" version=1')
    const item = await pending(fixture)
    expect(item).toBeUndefined()
    const answered = (await fixture.stores.attention.list({ requirementId: fixture.requirementId }))
      .find((entry) => entry.requestId === fixture.requestId)
    expect(answered).toMatchObject({
      decision: 'approve',
      answeredBy: { type: 'agent', role: 'release-reviewer', harness: 'dsh-host', onBehalfOf: '审批人' },
    })
    const artifacts = await autoArtifacts(fixture)
    expect(artifacts).toHaveLength(1)
    const content = (await fixture.stores.workspaces.readArtifact({
      workspace: fixture.requirementId,
      path: artifacts[0]!.path,
      version: artifacts[0]!.versions.at(-1)!.version,
    }))?.toString('utf8') ?? ''
    expect(content).toContain('处置：approve')
    expect(content).toContain('- reports/quality.md v1')
    expect(content).toContain('- reviews/r1.md v1')
  })

  it('低置信度、blocker、非法处置与模型主动升级都写升级记录且不落回答', async () => {
    const cases: Array<{ label: string; result: HarnessResult; reason: string }> = [
      { label: '低置信度', result: decision({ confidence: 0.5, evidence: [] }), reason: '置信度不足' },
      { label: 'blocker', result: decision({ blockers: ['回归范围未确认'] }), reason: 'blocker' },
      { label: '非法处置', result: decision({ disposition: 'reject' }), reason: '未知处置' },
      { label: '模型主动升级', result: decision({ disposition: 'escalate', rationale: '证据不足' }), reason: '证据不足' },
    ]
    for (const testCase of cases) {
      const fixture = await makeFixture()
      const calls: HarnessRequest[] = []
      const step = await autonomyStep(depsFor(fixture, {
        harness: harnessStub(() => testCase.result, calls),
      }), await stateOf(fixture), new Set())

      expect(step.kind, testCase.label).toBe('escalated')
      expect((step as { reason: string }).reason, testCase.label).toContain(testCase.reason)
      expect(calls, testCase.label).toHaveLength(1)
      expect((await pending(fixture))?.answeredAt, testCase.label).toBeUndefined()
      const artifacts = await autoArtifacts(fixture)
      expect(artifacts, testCase.label).toHaveLength(1)
    }
  })

  it('引用正文未完整提供的产物时升级，不把它当批准依据', async () => {
    const fixture = await makeFixture({
      paths: [
        { path: 'reports/quality.md', content: '# 质量报告' },
        { path: 'reports/impact.md', content: '# 影响面' },
        { path: 'reviews/r1.md', content: '# 评审' },
        { path: 'reports/huge.md', content: `# 超长报告\n${'x'.repeat(30_000)}` },
      ],
    })
    const huge = fixture.refs.find((ref) => ref.path === 'reports/huge.md')!
    const step = await autonomyStep(depsFor(fixture, {
      harness: harnessStub(() => decision({ evidence: [{ ...huge }] })),
    }), await stateOf(fixture), new Set())

    expect(step).toMatchObject({ kind: 'escalated', reason: expect.stringContaining('不在本次完整提供') })
    expect((await pending(fixture))?.answeredAt).toBeUndefined()
  })

  it('review / judge / choice 待办不代答，模型完全不被调用', async () => {
    for (const nodeId of ['review-node', 'judge-node'] as const) {
      const fixture = await makeFixture({ nodeId, form: 'approve' })
      const calls: HarnessRequest[] = []
      const step = await autonomyStep(depsFor(fixture, {
        harness: harnessStub(() => decision(), calls),
      }), await stateOf(fixture), new Set())

      expect(step, nodeId).toEqual({ kind: 'none' })
      expect(calls, nodeId).toHaveLength(0)
      expect((await pending(fixture))?.answeredAt, nodeId).toBeUndefined()
    }
  })

  it('动态展开节点的 kind 从运行快照读取', async () => {
    const fixture = await makeFixture()
    const state = await stateOf(fixture)
    state.expansions = [{
      plannerId: 'plan',
      items: [],
      nodeIds: ['plan/item/review', 'plan/item/answer'],
      nodes: [
        { id: 'plan/item/review', kind: 'review', title: '动态评审', needs: [], ask: '评审？', form: 'approve' },
        { id: 'plan/item/answer', kind: 'human', title: '动态回答', needs: [], ask: '回答？', form: 'answer' },
      ],
      at: new Date().toISOString(),
    }]
    expect(nodeKindOf(workflow, state, 'plan/item/review')).toBe('review')
    expect(nodeKindOf(workflow, state, 'plan/item/answer')).toBe('human')
    expect(nodeKindOf(workflow, state, 'missing')).toBeUndefined()
  })

  it('模型调用期间真人抢答：不写第二份决定，返回 answered 供 resume', async () => {
    const fixture = await makeFixture()
    let release!: (result: HarnessResult) => void
    const gate = new Promise<HarnessResult>((resolve) => { release = resolve })
    const calls: HarnessRequest[] = []
    const approvals = approvalsFor(fixture)
    const driving = autonomyStep(depsFor(fixture, {
      approvals,
      harness: harnessStub(() => gate, calls),
    }), await stateOf(fixture), new Set())

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await approvals.answer(fixture.space, {
      requestId: fixture.requestId,
      attempt: 1,
      decision: 'approve',
      by: { type: 'human', id: '审批人', via: 'dsh-web' },
    })
    release(decision({ evidence: fixture.refs.map((ref) => ({ ...ref })) }))
    const step = await driving

    expect(step).toMatchObject({ kind: 'answered' })
    expect(await autoArtifacts(fixture)).toHaveLength(0)
    const item = (await fixture.stores.attention.list({ requirementId: fixture.requirementId }))
      .find((entry) => entry.requestId === fixture.requestId)
    expect(item?.answeredBy).toMatchObject({ type: 'human' })
  })

  it('取消后模型结果与升级通知都不再落账', async () => {
    const fixture = await makeFixture()
    const controller = new AbortController()
    let release!: (result: HarnessResult) => void
    const gate = new Promise<HarnessResult>((resolve) => { release = resolve })
    const { notifier, notifyEscalation } = notifierStub()
    const calls: HarnessRequest[] = []
    const driving = autonomyStep(depsFor(fixture, {
      signal: controller.signal,
      notifier,
      harness: harnessStub(() => gate, calls),
    }), await stateOf(fixture), new Set())

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    controller.abort()
    release(decision({ disposition: 'escalate', rationale: '取消前的结果' }))
    const step = await driving

    expect(step).toEqual({ kind: 'none' })
    expect(notifyEscalation).not.toHaveBeenCalled()
    expect(await autoArtifacts(fixture)).toHaveLength(0)
    expect((await pending(fixture))?.answeredAt).toBeUndefined()
  })

  it('升级写产物时取消：不发送新的升级通知', async () => {
    const fixture = await makeFixture()
    const controller = new AbortController()
    const { notifier, notifyEscalation } = notifierStub()
    const approvals = approvalsFor(fixture)
    const answerAsAgent = approvals.answerAsAgent!.bind(approvals)
    const step = await autonomyStep(depsFor(fixture, {
      signal: controller.signal,
      notifier,
      approvals: {
        ...approvals,
        async answerAsAgent(space, input) {
          // 模拟落账过程中 stop/卸载：写入被取消，信号已 abort。
          controller.abort()
          return answerAsAgent(space, input)
        },
      },
      harness: harnessStub(() => decision({ disposition: 'escalate', rationale: '证据不足' })),
    }), await stateOf(fixture), new Set())

    expect(step.kind).toBe('escalated')
    expect(notifyEscalation).not.toHaveBeenCalled()
    expect((await pending(fixture))?.answeredAt).toBeUndefined()
  })

  it('同 requestId 已尝试过时不再重复调用模型', async () => {
    const fixture = await makeFixture()
    const calls: HarnessRequest[] = []
    const step = await autonomyStep(depsFor(fixture, {
      harness: harnessStub(() => decision(), calls),
    }), await stateOf(fixture), new Set([fixture.requestId]))

    expect(step).toEqual({ kind: 'none' })
    expect(calls).toHaveLength(0)
  })

  it('缺少绑定人且无配置 user 时升级给人，不调用模型', async () => {
    const fixture = await makeFixture()
    const calls: HarnessRequest[] = []
    const { notifier, notifyEscalation } = notifierStub()
    const step = await autonomyStep(depsFor(fixture, {
      configUser: undefined,
      notifier,
      harness: harnessStub(() => decision(), calls),
    }), await stateOf(fixture), new Set())

    expect(step).toMatchObject({ kind: 'escalated', reason: expect.stringContaining('没有绑定人') })
    expect(calls).toHaveLength(0)
    expect(notifyEscalation).toHaveBeenCalledTimes(1)
    expect((await pending(fixture))?.answeredAt).toBeUndefined()
  })
})
