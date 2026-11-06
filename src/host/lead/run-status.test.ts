import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createInsights,
  initProject,
  type EventPayloads,
  type EventType,
  type NodeState,
  type RunState,
  type WorkflowSnapshot,
} from '@taktflow/core'
import type { SpaceHandle } from '../types.js'
import { buildRunStatus } from './run-status.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const actor = { type: 'system', id: 'run-status-test' } as const

function node(
  id: string,
  status: NodeState['status'],
  extra: Partial<NodeState> = {},
): NodeState {
  return { id, status, attempts: 1, outputs: [], ...extra }
}

function snapshot(): WorkflowSnapshot {
  return {
    id: 'wf-status',
    title: '状态测试流程',
    version: '1.0.0',
    stages: [
      { id: 'design', title: '设计' },
      { id: 'develop', title: '开发' },
      { id: 'loop', title: '联调' },
      { id: 'release', title: '准出' },
    ],
    nodes: [
      { id: 'design', kind: 'agent', title: '系分', stage: 'design', needs: [] },
      {
        id: 'review-design',
        kind: 'review',
        title: '设计评审',
        stage: 'design',
        needs: ['design'],
        review: {
          target: ['requirements/REQ-001/design.md'],
          author: 'dev',
          reviewers: [{ role: 'reviewer' }],
          pass: 'all',
          maxRounds: 3,
          onExhausted: { rework: 'design', maxReworks: 1 },
        },
      },
      {
        id: 'review-cases',
        kind: 'review',
        title: '用例评审',
        stage: 'develop',
        needs: [],
        review: {
          target: ['requirements/REQ-001/cases.md'],
          author: 'dev',
          reviewers: [{ role: 'reviewer' }],
          pass: 'all',
          maxRounds: 2,
          onExhausted: 'human',
          humanSignoff: true,
        },
      },
      {
        id: 'loop-test',
        kind: 'loop',
        title: '联调循环',
        stage: 'loop',
        needs: [],
        maxIterations: 5,
        body: [{ id: 'run-cases', kind: 'agent', title: '跑用例', needs: [] }],
      },
      { id: 'accept', kind: 'human', title: '验收', stage: 'release', needs: [], ask: '确认发布', form: 'approve' },
    ],
  }
}

function run(nodes: Record<string, NodeState>, extra: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-001',
    workflowId: 'wf-status',
    workflowVersion: '1.0.0',
    requirementId: 'REQ-001',
    status: 'running',
    startedAt: '2026-11-06T00:00:00.000Z',
    args: {},
    nodes,
    expansions: [],
    ...extra,
  }
}

async function makeSpace(): Promise<SpaceHandle> {
  const root = await mkdtemp(path.join(tmpdir(), 'taktflow-run-status-'))
  roots.push(root)
  const stores = await initProject(root, { name: 'run-status-test' })
  return { root, stores, insights: createInsights(stores) }
}

async function seed(space: SpaceHandle, state: RunState, workflow = snapshot()): Promise<void> {
  await space.stores.runs.create(state, workflow)
}

function append<T extends EventType>(
  space: SpaceHandle,
  runId: string,
  type: T,
  nodeId: string,
  data: EventPayloads[T],
): Promise<unknown> {
  return space.stores.events.append(runId, { type, nodeId, actor, data })
}

describe('buildRunStatus', () => {
  it('并行阶段按数组返回；运行结束返回空 currentStages', async () => {
    const space = await makeSpace()
    const state = run({
      design: node('design', 'running'),
      'review-design': node('review-design', 'pending', { attempts: 0 }),
      'review-cases': node('review-cases', 'waiting_human', { round: 1 }),
      'loop-test': node('loop-test', 'waiting_human', { iteration: 2 }),
      'loop-test/run-cases': node('loop-test/run-cases', 'waiting_human', { iteration: 2 }),
      accept: node('accept', 'waiting_human'),
    })
    await seed(space, state)
    const report = await buildRunStatus(space, state)
    expect(report.ended).toBe(false)
    expect(report.currentStages.map((stage) => stage.id)).toEqual(['design', 'develop', 'loop', 'release'])
    expect(report.currentStages.flatMap((stage) => stage.nodes.map((item) => item.id))).toEqual([
      'design',
      'review-cases',
      'loop-test',
      'loop-test/run-cases',
      'accept',
    ])

    const ended = run(
      { design: node('design', 'succeeded', { attempts: 2 }), 'review-design': node('review-design', 'succeeded') },
      { runId: 'run-002', status: 'succeeded', endedAt: '2026-11-06T01:00:00.000Z' },
    )
    await seed(space, ended)
    const endedReport = await buildRunStatus(space, ended)
    expect(endedReport.ended).toBe(true)
    expect(endedReport.currentStages).toEqual([])
    expect(endedReport.endedAt).toBe('2026-11-06T01:00:00.000Z')
  })

  it('review 当前轮次与累计轮次分开统计，打回数与结论来自真实事件', async () => {
    const space = await makeSpace()
    const state = run({
      design: node('design', 'succeeded', { attempts: 2, reworks: 1 }),
      'review-design': node('review-design', 'succeeded', { round: 1, reworks: 1 }),
      'review-cases': node('review-cases', 'waiting_human', { round: 1 }),
      'loop-test': node('loop-test', 'succeeded', { iteration: 3 }),
      'loop-test/run-cases': node('loop-test/run-cases', 'succeeded', { iteration: 3 }),
      accept: node('accept', 'pending', { attempts: 0 }),
    }, { status: 'waiting_human' })
    await seed(space, state)

    // 第一代评审 1 轮未通过 -> 用尽轮次 -> 打回；第二代评审 1 轮通过。
    await append(space, state.runId, 'review.round', 'review-design', {
      round: 1,
      passed: false,
      verdicts: [{ reviewer: 'reviewer', verdict: 'request_changes', issues: 2 }],
    })
    await append(space, state.runId, 'review.exhausted', 'review-design', { rounds: 3, action: 'rework' })
    await append(space, state.runId, 'rework.started', 'review-design', {
      from: 'review-design',
      to: 'design',
      count: 1,
      feedback: '补充边界',
      reset: ['design', 'review-design'],
    })
    await append(space, state.runId, 'review.round', 'review-design', {
      round: 1,
      passed: true,
      verdicts: [{ reviewer: 'reviewer', verdict: 'approve', issues: 0 }],
    })
    await append(space, state.runId, 'review.round', 'review-cases', {
      round: 1,
      passed: true,
      verdicts: [{ reviewer: 'reviewer', verdict: 'approve', issues: 0 }],
    })
    await append(space, state.runId, 'node.started', 'loop-test/run-cases', { attempt: 1, iteration: 1 })
    await append(space, state.runId, 'node.started', 'loop-test/run-cases', { attempt: 2, iteration: 2 })
    await append(space, state.runId, 'node.started', 'loop-test/run-cases', { attempt: 3, iteration: 3 })

    const report = await buildRunStatus(space, state)
    expect(report.reviews).toHaveLength(2)
    expect(report.reviews[0]).toMatchObject({
      nodeId: 'review-design',
      currentRound: 1,
      cumulativeRounds: 2,
      maxRounds: 3,
      reworks: 1,
      exhausted: 1,
      exhaustedAction: 'rework',
      conclusion: 'passed',
      latestRound: { round: 1, passed: true },
    })
    expect(report.reviews[1]).toMatchObject({
      nodeId: 'review-cases',
      currentRound: 1,
      cumulativeRounds: 1,
      humanSignoff: true,
      conclusion: 'awaiting_signoff',
    })
    expect(report.reviews[0]?.source).toContain('review.round')
    expect(report.loops[0]).toMatchObject({
      nodeId: 'loop-test',
      currentIteration: 3,
      maxObservedIteration: 3,
      maxIterations: 5,
      exhausted: false,
      failed: false,
    })
    expect(report.sources.reviews).toContain('core.events')
    expect(report.sources.loops).toContain('node.started')
  })

  it('pending 只取当前 runId；AI 处理不算升级，普通人工待办真实显示', async () => {
    const space = await makeSpace()
    const state = run({
      'review-design': node('review-design', 'waiting_human', { round: 3 }),
      accept: node('accept', 'waiting_human'),
    }, { status: 'waiting_human' })
    await seed(space, state)
    await append(space, state.runId, 'review.exhausted', 'review-design', { rounds: 3, action: 'human' })
    await space.stores.attention.create({
      requestId: `${state.runId}:review-design#2`,
      runId: state.runId,
      nodeId: 'review-design',
      requirementId: 'REQ-001',
      ask: '评审轮次已用完，请裁决。',
      form: 'choice',
      choices: ['放行', '打回', '终止'],
    })
    await space.stores.attention.create({
      requestId: `${state.runId}:accept`,
      runId: state.runId,
      nodeId: 'accept',
      requirementId: 'REQ-001',
      ask: '确认发布',
      form: 'approve',
    })
    // 同一需求的其它运行不能混进来。
    await space.stores.attention.create({
      requestId: 'run-002:accept',
      runId: 'run-002',
      nodeId: 'accept',
      requirementId: 'REQ-001',
      ask: '另一运行的待办',
      form: 'approve',
    })

    const humanReport = await buildRunStatus(space, state)
    expect(humanReport.pending.map((item) => item.requestId)).toEqual([
      `${state.runId}:review-design#2`,
      `${state.runId}:accept`,
    ])
    expect(humanReport.pending[0]).toMatchObject({
      handling: 'human',
      escalation: true,
      escalationReason: 'review.exhausted action=human rounds=3',
      marker: { type: 'review.exhausted' },
    })
    expect(humanReport.pending[1]).toMatchObject({
      handling: 'human',
      escalation: false,
      escalationReason: null,
      marker: null,
      ask: '确认发布',
    })

    // 自动裁决中的同一待办：仍列出，但不算升级。
    const aiReport = await buildRunStatus(space, state, {
      isAiHandling: async (item) => item.nodeId === 'review-design',
    })
    expect(aiReport.pending[0]).toMatchObject({
      handling: 'ai',
      escalation: false,
      escalationReason: null,
      marker: { type: 'review.exhausted' },
    })
    expect(aiReport.pending[1]).toMatchObject({ handling: 'human', escalation: false })
  })

  it('AI 自主升级按真实 reason/source 显示；普通 manual 待办不升级', async () => {
    const space = await makeSpace()
    const state = run({
      accept: node('accept', 'waiting_human'),
      clarify: node('clarify', 'waiting_human'),
    }, { status: 'waiting_human' })
    await seed(space, state)
    await space.stores.attention.create({
      requestId: `${state.runId}:accept`,
      runId: state.runId,
      nodeId: 'accept',
      requirementId: 'REQ-001',
      ask: '确认发布',
      form: 'approve',
    })
    await space.stores.attention.create({
      requestId: `${state.runId}:clarify`,
      runId: state.runId,
      nodeId: 'clarify',
      requirementId: 'REQ-001',
      ask: '请确认验收范围',
      form: 'answer',
    })

    const report = await buildRunStatus(space, state, {
      getEscalation: async (item) => item.nodeId === 'accept'
        ? {
            reason: '自主审批升级：置信度不足（0.72 < 0.9）',
            source: 'decisions/auto-answers/accept-abc123.md',
          }
        : undefined,
    })

    expect(report.pending[0]).toMatchObject({
      nodeId: 'accept',
      handling: 'human',
      escalation: true,
      escalationReason: '自主审批升级：置信度不足（0.72 < 0.9）',
      escalationSource: 'decisions/auto-answers/accept-abc123.md',
      marker: { type: 'autonomy.escalated', detail: '自主审批升级：置信度不足（0.72 < 0.9）' },
    })
    expect(report.pending[1]).toMatchObject({
      nodeId: 'clarify',
      handling: 'human',
      escalation: false,
      escalationReason: null,
      escalationSource: null,
      marker: null,
    })
  })

  it('AI 处理中的待办不查询升级回调，也不算升级', async () => {
    const space = await makeSpace()
    const state = run({ accept: node('accept', 'waiting_human') }, { status: 'waiting_human' })
    await seed(space, state)
    await space.stores.attention.create({
      requestId: `${state.runId}:accept`,
      runId: state.runId,
      nodeId: 'accept',
      requirementId: 'REQ-001',
      ask: '确认发布',
      form: 'approve',
    })

    let called = false
    const report = await buildRunStatus(space, state, {
      isAiHandling: async () => true,
      getEscalation: async () => {
        called = true
        return { reason: '自主审批升级', source: 'decisions/auto-answers/accept.md' }
      },
    })

    expect(called).toBe(false)
    expect(report.pending[0]).toMatchObject({
      handling: 'ai',
      escalation: false,
      escalationReason: null,
      escalationSource: null,
      marker: null,
    })
  })

  it('getEscalation 返回缺少 reason/source 时抛错，不伪造升级', async () => {
    const space = await makeSpace()
    const state = run({ accept: node('accept', 'waiting_human') }, { status: 'waiting_human' })
    await seed(space, state)
    await space.stores.attention.create({
      requestId: `${state.runId}:accept`,
      runId: state.runId,
      nodeId: 'accept',
      requirementId: 'REQ-001',
      ask: '确认发布',
      form: 'approve',
    })

    await expect(buildRunStatus(space, state, {
      getEscalation: async () => ({ reason: ' ', source: '' }),
    })).rejects.toThrow('getEscalation 返回缺少 reason/source')
  })

  it('loop 用 node.started.iteration 报已观察最高轮次，并识别轮次用尽的待办', async () => {
    const space = await makeSpace()
    const state = run({
      'loop-test': node('loop-test', 'waiting_human', { iteration: 5 }),
      'loop-test/run-cases': node('loop-test/run-cases', 'succeeded', { iteration: 5 }),
    }, { status: 'waiting_human' })
    await seed(space, state)
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      await append(space, state.runId, 'node.started', 'loop-test/run-cases', { attempt: iteration, iteration })
    }
    await space.stores.attention.create({
      requestId: `${state.runId}:loop-test`,
      runId: state.runId,
      nodeId: 'loop-test',
      requirementId: 'REQ-001',
      ask: '循环 联调循环 已达到 5 轮，是否放行？',
      form: 'approve',
    })

    const report = await buildRunStatus(space, state)
    expect(report.loops[0]).toMatchObject({
      nodeId: 'loop-test',
      currentIteration: 5,
      maxObservedIteration: 5,
      maxIterations: 5,
      exhausted: true,
      exhaustedSource: 'attention',
      pendingRequestIds: [`${state.runId}:loop-test`],
    })
    expect(report.pending[0]).toMatchObject({
      nodeId: 'loop-test',
      handling: 'human',
      escalation: true,
      marker: { type: 'loop.exhausted' },
    })
  })

  it('loop 早期失败不冒充轮次耗尽；达到 maxIterations 且失败才标耗尽', async () => {
    const space = await makeSpace()
    const early = run({
      'loop-test': node('loop-test', 'failed', { iteration: 2 }),
      'loop-test/run-cases': node('loop-test/run-cases', 'failed', { iteration: 2 }),
    }, { runId: 'run-early', status: 'failed' })
    await seed(space, early)
    const earlyReport = await buildRunStatus(space, early)
    expect(earlyReport.loops[0]).toMatchObject({
      nodeId: 'loop-test',
      currentIteration: 2,
      maxObservedIteration: 2,
      maxIterations: 5,
      exhausted: false,
      exhaustedSource: null,
      failed: true,
    })

    const budget = run({
      'loop-test': node('loop-test', 'failed', { iteration: 5 }),
      'loop-test/run-cases': node('loop-test/run-cases', 'failed', { iteration: 5 }),
    }, { runId: 'run-budget', status: 'failed' })
    await seed(space, budget)
    const budgetReport = await buildRunStatus(space, budget)
    expect(budgetReport.loops[0]).toMatchObject({
      nodeId: 'loop-test',
      currentIteration: 5,
      maxObservedIteration: 5,
      maxIterations: 5,
      exhausted: true,
      exhaustedSource: 'node.failed',
      failed: true,
    })
  })

  it('review 取消优先于最近通过轮次，latestRound 仍保留 AI 结论', async () => {
    const space = await makeSpace()
    const state = run({
      'review-design': node('review-design', 'cancelled', { round: 1 }),
    }, { runId: 'run-cancel', status: 'cancelled' })
    await seed(space, state)
    await append(space, state.runId, 'review.round', 'review-design', {
      round: 1,
      passed: true,
      verdicts: [{ reviewer: 'reviewer', verdict: 'approve', issues: 0 }],
    })

    const report = await buildRunStatus(space, state)
    expect(report.reviews[0]).toMatchObject({
      nodeId: 'review-design',
      conclusion: 'cancelled',
      latestRound: { round: 1, passed: true },
    })
  })

  it('缺节点定义时 kind=null 且 definitionSource=null，不伪造 subflow', async () => {
    const space = await makeSpace()
    const state = run({ ghost: node('ghost', 'running') }, { runId: 'run-ghost' })
    await seed(space, state)

    const report = await buildRunStatus(space, state)
    expect(report.currentStages).toHaveLength(1)
    expect(report.currentStages[0]).toMatchObject({
      id: null,
      title: null,
      nodes: [{
        id: 'ghost',
        title: 'ghost',
        kind: null,
        definitionSource: null,
        status: 'running',
      }],
    })
  })

  it('缺 workflow 快照直接抛错，不返回假空列表', async () => {
    const space = await makeSpace()
    const state = run({})
    await expect(buildRunStatus(space, state)).rejects.toThrow('缺少 workflow 快照')
  })

  it('attention 读取失败原样抛出，不静默降级为空待办', async () => {
    const space = await makeSpace()
    const state = run({})
    await seed(space, state)
    const broken: SpaceHandle = {
      ...space,
      stores: {
        ...space.stores,
        attention: {
          list: async () => { throw new Error('attention 读取失败') },
        },
      } as unknown as SpaceHandle['stores'],
    }
    await expect(buildRunStatus(broken, state)).rejects.toThrow('attention 读取失败')
  })
})
