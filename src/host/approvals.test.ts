import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInsights,
  initProject,
  snapshotWorkflow,
  type Actor,
  type ArtifactRef,
  type AttentionItem,
  type NodeStatus,
  type ProjectStores,
  type RunState,
  type RunStatus,
  type WorkflowDefinition,
} from '@taktflow/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPROVE_LABEL,
  REJECT_LABEL,
  ApprovalInputError,
  PlaceholderApprovals,
  createApprovals,
} from './approvals.js'
import type {
  Agent,
  ToolExecutionContext,
  UserQuestion,
  UserQuestionsRequest,
  UserQuestionsResult,
} from './dsh-types.js'
import {
  TaktToolError,
  type AnswerInput,
  type Approvals,
  type Ownership,
  type RunManager,
  type SpaceHandle,
} from './types.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const workflow: WorkflowDefinition = {
  id: 'approval-wf',
  title: '审批测试',
  version: '1',
  stages: [],
  nodes: [
    { id: 'draft', kind: 'agent', title: '起草', role: 'writer', prompt: '起草规格' },
    { id: 'approve', kind: 'human', title: '人工审批', needs: ['draft'], ask: '请审批规格', form: 'approve' },
    { id: 'publish', kind: 'script', title: '发布', needs: ['approve'], run: async () => {} },
  ],
}

interface PendingOptions {
  paths?: string[]
  form?: 'approve' | 'answer' | 'choice'
  choices?: string[]
  runStatus?: RunStatus
  nodeStatus?: NodeStatus
  itemAttempt?: number
  nodeAttempts?: number
}

interface PendingFixture {
  space: SpaceHandle
  stores: ProjectStores
  requirementId: string
  runId: string
  requestId: string
  refs: ArtifactRef[]
}

async function makePending(options: PendingOptions = {}): Promise<PendingFixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'takt-approvals-')))
  dirs.push(dir)
  const stores = await initProject(dir, { name: 'approvals' })
  const requirement = await stores.workspaces.createRequirement({ title: '审批需求' })
  const requirementId = requirement.id

  const refs: ArtifactRef[] = []
  for (const artifactPath of options.paths ?? ['spec/spec.md']) {
    const written = await stores.workspaces.writeArtifact({
      ref: { workspace: requirementId, path: artifactPath },
      content: `${artifactPath} v1`,
      kind: artifactPath.endsWith('plan.md') ? 'design' : 'spec',
      author: { type: 'system', id: 'test' },
    })
    refs.push({ workspace: written.workspace, path: written.path, version: written.version })
  }

  const runId = 'run-approval-1'
  const nodeAttempts = options.nodeAttempts ?? 1
  const state: RunState = {
    runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    requirementId,
    status: options.runStatus ?? 'waiting_human',
    startedAt: new Date().toISOString(),
    args: {},
    nodes: {
      approve: {
        id: 'approve',
        status: options.nodeStatus ?? 'waiting_human',
        attempts: nodeAttempts,
        outputs: [],
        inputs: refs.map((ref) => ({ ...ref })),
      },
    },
    expansions: [],
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))

  const requestId = `${runId}:approve`
  await stores.attention.create({
    requestId,
    runId,
    nodeId: 'approve',
    requirementId,
    ask: '请审批规格',
    form: options.form ?? 'approve',
    ...(options.choices === undefined ? {} : { choices: options.choices }),
    attempt: options.itemAttempt ?? 1,
    subjects: refs.map((ref) => ({ ...ref })),
  })

  return {
    space: { root: dir, stores, insights: createInsights(stores) },
    stores,
    requirementId,
    runId,
    requestId,
    refs,
  }
}

function rootAgent(id = 'agent-root'): Agent {
  return {
    id,
    options: {},
    session: { header: { id: 'session-root' } },
    followup: () => {},
    inject: () => {},
  }
}

function execFor(agent: Agent | undefined, signal?: AbortSignal): ToolExecutionContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'takt_ask_human',
    arguments: {},
    agent,
    signal: signal ?? new AbortController().signal,
    token: Symbol('test'),
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

function ctxFor(
  agent: Agent | undefined,
  ask?: (request: UserQuestionsRequest) => Promise<UserQuestionsResult>,
): Parameters<typeof createApprovals>[0]['ctx'] {
  return {
    agents: {
      get: (id: string) => (agent !== undefined && id === agent.id ? agent : undefined),
      roots: () => (agent === undefined ? [] : [agent]),
    },
    ...(ask === undefined ? {} : { userQuestions: { ask } }),
  }
}

function ownershipStub(): { ownership: Ownership; ensureLease: ReturnType<typeof vi.fn> } {
  const ensureLease = vi.fn(async () => {})
  const ownership: Ownership = {
    hostOwner: 'dsh:test',
    ensureLease,
    async release() {},
    async takeover() {},
    async recordRun() {},
    async readRun() { return undefined },
    async setEndReason() {},
  }
  return { ownership, ensureLease }
}

function runsStub(): { runs: RunManager; onAnswered: ReturnType<typeof vi.fn> } {
  const onAnswered = vi.fn(async (_space: SpaceHandle, _item: AttentionItem) => {})
  const runs: RunManager = {
    async start() { return { runId: 'run-x', deduped: false } },
    async cancel() {},
    async resume() {},
    async get() { return undefined },
    onAnswered,
    async disposeAll() {},
  }
  return { runs, onAnswered }
}

function answerInput(fixture: PendingFixture, patch: Partial<AnswerInput> = {}): AnswerInput {
  return {
    requestId: fixture.requestId,
    attempt: 1,
    decision: 'approve',
    by: { type: 'human', id: '审批人', via: 'dsh-web' },
    ...patch,
  }
}

async function findItem(stores: ProjectStores, requestId: string): Promise<AttentionItem | undefined> {
  return (await stores.attention.list()).find((item) => item.requestId === requestId)
}

async function expectTaktError(promise: Promise<unknown>, code: TaktToolError['code']): Promise<TaktToolError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(TaktToolError)
    expect((error as TaktToolError).code).toBe(code)
    return error as TaktToolError
  }
  throw new Error(`预期抛出 ${code}，实际成功`)
}

describe('approvals.answer：落账、幂等与过期', () => {
  it('批准写入 human actor（via=dsh-web），落账后只唤醒一次', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    const answered = await approvals.answer(fixture.space, answerInput(fixture))

    expect(answered.decision).toBe('approve')
    expect(answered.answeredBy).toEqual({ type: 'human', id: '审批人', via: 'dsh-web' })
    expect(onAnswered).toHaveBeenCalledTimes(1)
    expect(await findItem(fixture.stores, fixture.requestId)).toMatchObject({
      decision: 'approve',
      answeredBy: { type: 'human', id: '审批人', via: 'dsh-web' },
    })
  })

  it('重复回答幂等返回，不再调用 onAnswered', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    const first = await approvals.answer(fixture.space, answerInput(fixture))
    const second = await approvals.answer(fixture.space, answerInput(fixture))

    expect(second.answeredAt).toBe(first.answeredAt)
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('并发回答同一个待办只落账一次', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    const [first, second] = await Promise.all([
      approvals.answer(fixture.space, answerInput(fixture)),
      approvals.answer(fixture.space, answerInput(fixture)),
    ])

    expect(first.requestId).toBe(second.requestId)
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('节点尝试次数已变化时拒绝回答', async () => {
    const fixture = await makePending({ itemAttempt: 1, nodeAttempts: 2 })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(approvals.answer(fixture.space, answerInput(fixture)), 'TAKT_STALE_VERSION')
    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('artifactVersion 与冻结主产物不一致时拒绝', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(
      approvals.answer(fixture.space, answerInput(fixture, { artifactVersion: 2 })),
      'TAKT_STALE_VERSION',
    )
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('多 subject 中任一产物出现新版本时拒绝', async () => {
    const fixture = await makePending({ paths: ['spec/spec.md', 'spec/plan.md'] })
    await fixture.stores.workspaces.writeArtifact({
      ref: { workspace: fixture.requirementId, path: 'spec/plan.md' },
      content: 'plan v2',
      kind: 'design',
      author: { type: 'human', id: '审批人' },
      reason: '人工更新',
    })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    // 主产物版本没变，但第二个 subject 已经过期，仍必须拒绝。
    await expectTaktError(
      approvals.answer(fixture.space, answerInput(fixture, { artifactVersion: fixture.refs[0]!.version })),
      'TAKT_STALE_VERSION',
    )
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('非 human 回答一律拒绝，即使其它字段都合法', async () => {
    const fixture = await makePending()
    const { ownership, ensureLease } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(
      approvals.answer(fixture.space, answerInput(fixture, { by: { type: 'agent', role: 'lead', harness: 'dsh' } })),
      'TAKT_FORBIDDEN_FOR_LEAD',
    )
    expect(ensureLease).not.toHaveBeenCalled()
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('待办不存在返回 TAKT_NOT_BOUND', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(
      approvals.answer(fixture.space, answerInput(fixture, { requestId: 'run-missing:approve' })),
      'TAKT_NOT_BOUND',
    )
  })

  it('终态运行不能再回答', async () => {
    const fixture = await makePending({ runStatus: 'succeeded' })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(approvals.answer(fixture.space, answerInput(fixture)), 'TAKT_RUN_BUSY')
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('attempt 不是非负整数时按输入错误拒绝', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expect(approvals.answer(fixture.space, answerInput(fixture, { attempt: -1 }))).rejects.toBeInstanceOf(ApprovalInputError)
    await expect(approvals.answer(fixture.space, answerInput(fixture, { attempt: 1.5 }))).rejects.toBeInstanceOf(ApprovalInputError)
  })

  it('审批表单缺 decision 时拒绝；取消/跳过不能伪装成批准', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expect(
      approvals.answer(fixture.space, answerInput(fixture, { decision: undefined })),
    ).rejects.toBeInstanceOf(ApprovalInputError)
    await expect(
      approvals.answer(fixture.space, answerInput(fixture, { decision: 'cancelled' })),
    ).rejects.toBeInstanceOf(ApprovalInputError)
    expect(onAnswered).not.toHaveBeenCalled()
  })

  it('节点不在 waiting_human 时拒绝，历史待办不能隐式推进', async () => {
    for (const nodeStatus of ['failed', 'succeeded', 'cancelled', 'stale'] as const) {
      const fixture = await makePending({ nodeStatus })
      const { ownership } = ownershipStub()
      const { runs, onAnswered } = runsStub()
      const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

      await expectTaktError(approvals.answer(fixture.space, answerInput(fixture)), 'TAKT_RUN_BUSY')
      expect(onAnswered).not.toHaveBeenCalled()
      expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
    }
  })

  it('同一节点出现更新待办后，旧待办按过期拒绝', async () => {
    const fixture = await makePending()
    const secondRequestId = `${fixture.runId}:approve#2`
    await fixture.stores.attention.create({
      requestId: secondRequestId,
      runId: fixture.runId,
      nodeId: 'approve',
      requirementId: fixture.requirementId,
      ask: '请重新审批规格',
      form: 'approve',
      attempt: 1,
      subjects: fixture.refs.map((ref) => ({ ...ref })),
    })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expectTaktError(approvals.answer(fixture.space, answerInput(fixture)), 'TAKT_STALE_VERSION')
    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('两个工厂并发回答同一待办时只落账一次、只唤醒一次', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const first = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })
    const second = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    const results = await Promise.all([
      first.answer(fixture.space, answerInput(fixture)),
      second.answer(fixture.space, answerInput(fixture)),
    ])

    expect(results[0]!.answeredAt).toBe(results[1]!.answeredAt)
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('reject 按 core 语义落账，仍会唤醒运行由引擎处理失败', async () => {
    const fixture = await makePending()
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    const answered = await approvals.answer(fixture.space, answerInput(fixture, { decision: 'reject', answer: '缺少验收标准' }))

    expect(answered.decision).toBe('reject')
    expect(answered.answer).toBe('缺少验收标准')
    expect(onAnswered).toHaveBeenCalledTimes(1)
  })

  it('choice 表单只接受 choices 里的选项', async () => {
    const fixture = await makePending({ form: 'choice', choices: ['方案 A', '方案 B'] })
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expect(
      approvals.answer(fixture.space, answerInput(fixture, { decision: 'choice', answer: '方案 C' })),
    ).rejects.toBeInstanceOf(ApprovalInputError)
    const answered = await approvals.answer(fixture.space, answerInput(fixture, { decision: 'choice', answer: '方案 B' }))
    expect(answered).toMatchObject({ decision: 'choice', answer: '方案 B' })
  })

  it('文本表单只接受非空 answer，不接受 decision', async () => {
    const fixture = await makePending({ form: 'answer' })
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(rootAgent()), ownership, runs, config: { user: '审批人' } })

    await expect(
      approvals.answer(fixture.space, answerInput(fixture, { decision: undefined, answer: '   ' })),
    ).rejects.toBeInstanceOf(ApprovalInputError)
    await expect(
      approvals.answer(fixture.space, answerInput(fixture, { decision: 'approve', answer: '可以' })),
    ).rejects.toBeInstanceOf(ApprovalInputError)
    const answered = await approvals.answer(fixture.space, answerInput(fixture, { decision: undefined, answer: '同意' }))
    expect(answered.answer).toBe('同意')
  })
})

describe('approvals.present：原生问题卡片', () => {
  it('校验活根 Agent、先拿租约，再用冻结产物和版本弹出原生卡片', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const controller = new AbortController()
    const asked: UserQuestionsRequest[] = []
    const order: string[] = []
    const ctx = ctxFor(agent, async (request) => {
      order.push('ask')
      asked.push(request)
      expect(request.agent).toBe(agent)
      expect(request.signal).toBe(controller.signal)
      return { answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL] }] }
    })
    const { ownership, ensureLease } = ownershipStub()
    ensureLease.mockImplementation(async () => { order.push('lease') })
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent, controller.signal), fixture.space, fixture.requestId)

    // present 先确认本宿主能写，再弹卡片；answer 内部会再确认一次，但顺序必须正确。
    expect(ensureLease).toHaveBeenCalled()
    expect(order[0]).toBe('lease')
    expect(order.filter((step) => step === 'ask')).toHaveLength(1)
    expect(asked).toHaveLength(1)
    const question: UserQuestion = asked[0]!.questions[0]!
    expect(question.options?.map((option) => option.label)).toEqual([APPROVE_LABEL, REJECT_LABEL])
    expect(question.detail).toContain('spec/spec.md v1')
    expect(question.detail).toContain('publish（发布）')
    expect(question.detail).toContain('打回')
    expect(question.detail).toContain('失败')
    expect(onAnswered).toHaveBeenCalledTimes(1)
    expect(await findItem(fixture.stores, fixture.requestId)).toMatchObject({
      decision: 'approve',
      answeredBy: { type: 'human', id: '审批人', via: 'dsh:user-questions' },
    })
  })

  it('忽略与本卡片 id 不匹配的答案，不拿无关答案批准', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ctx = ctxFor(agent, async () => ({
      answers: [{ id: 'other-question', selected: [APPROVE_LABEL] }],
    }))
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('ask 返回前已 abort 时，即使答案是批准也不落账', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const controller = new AbortController()
    const ctx = ctxFor(agent, async (request) => {
      controller.abort()
      return { answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL] }] }
    })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await expectTaktError(
      approvals.present(execFor(agent, controller.signal), fixture.space, fixture.requestId),
      'TAKT_RUN_BUSY',
    )
    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('批准与未知选项混合时不视为批准', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ctx = ctxFor(agent, async (request) => ({
      answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL, '其它卡片选项'] }],
    }))
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('没有 userQuestions 服务时返回带主面板提示的结构化错误', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx: ctxFor(agent), ownership, runs, config: { user: '审批人' } })

    const error = await expectTaktError(
      approvals.present(execFor(agent), fixture.space, fixture.requestId),
      'TAKT_NOT_BOUND',
    )
    expect(error.hint).toContain('主面板')
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('非活根 Agent 不能发起审批', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const ask = vi.fn(async (): Promise<UserQuestionsResult> => ({ answers: [] }))

    const deadCtx = {
      agents: { get: () => undefined, roots: () => [] },
      userQuestions: { ask },
    }
    const deadApprovals = createApprovals({ ctx: deadCtx, ownership, runs, config: { user: '审批人' } })
    await expectTaktError(deadApprovals.present(execFor(agent), fixture.space, fixture.requestId), 'TAKT_NOT_BOUND')

    const childCtx = {
      agents: { get: () => agent, roots: () => [] },
      userQuestions: { ask },
    }
    const childApprovals = createApprovals({ ctx: childCtx, ownership, runs, config: { user: '审批人' } })
    await expectTaktError(childApprovals.present(execFor(agent), fixture.space, fixture.requestId), 'TAKT_NOT_BOUND')
    expect(ask).not.toHaveBeenCalled()
  })

  it('空答案（取消/跳过/超时）不落账、不推进', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ctx = ctxFor(agent, async () => ({ answers: [] }))
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('只填自定义意见、没点选项时按打回处理，绝不批准', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ctx = ctxFor(agent, async (request) => ({
      answers: [{ id: request.questions[0]!.id, selected: [], custom: '请补充验收标准' }],
    }))
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(await findItem(fixture.stores, fixture.requestId)).toMatchObject({
      decision: 'reject',
      answer: '请补充验收标准',
    })
  })

  it('同时选择批准和打回视为无效回答，不推进', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ctx = ctxFor(agent, async (request) => ({
      answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL, REJECT_LABEL] }],
    }))
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('卡片等待期间取消返回 TAKT_RUN_BUSY，运行保持等待', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const controller = new AbortController()
    const ctx = ctxFor(agent, async () => {
      controller.abort()
      throw new Error('用户取消')
    })
    const { ownership } = ownershipStub()
    const { runs, onAnswered } = runsStub()
    const approvals = createApprovals({ ctx, ownership, runs, config: { user: '审批人' } })

    await expectTaktError(
      approvals.present(execFor(agent, controller.signal), fixture.space, fixture.requestId),
      'TAKT_RUN_BUSY',
    )
    expect(onAnswered).not.toHaveBeenCalled()
    expect((await findItem(fixture.stores, fixture.requestId))?.answeredAt).toBeUndefined()
  })

  it('已回答的待办不再弹卡片', async () => {
    const fixture = await makePending()
    const agent = rootAgent()
    const ask = vi.fn(async (): Promise<UserQuestionsResult> => ({ answers: [] }))
    const { ownership } = ownershipStub()
    const { runs } = runsStub()
    const approvals: Approvals = createApprovals({
      ctx: ctxFor(agent, ask),
      ownership,
      runs,
      config: { user: '审批人' },
    })
    await approvals.answer(fixture.space, answerInput(fixture))

    await approvals.present(execFor(agent), fixture.space, fixture.requestId)

    expect(ask).not.toHaveBeenCalled()
  })
})

describe('PlaceholderApprovals', () => {
  it('未接线宿主显式失败，不返回假成功', async () => {
    const fixture = await makePending()
    const placeholder = new PlaceholderApprovals()
    await expect(placeholder.answer(fixture.space, answerInput(fixture))).rejects.toThrow('not implemented')
    await expect(
      placeholder.present(execFor(rootAgent()), fixture.space, fixture.requestId),
    ).rejects.toThrow('not implemented')
  })
})
