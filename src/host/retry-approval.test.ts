import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  createEngine,
  createInsights,
  initProject,
  type AttentionItem,
  type EngineDeps,
  type HarnessAdapter,
  type ProjectStores,
  type WorkflowDefinition,
} from '@taktflow/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovals } from './approvals.js'
import type { Ownership, RunManager, SpaceHandle } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface RetryFixture {
  space: SpaceHandle
  stores: ProjectStores
  deps: EngineDeps
  definition: WorkflowDefinition
  runId: string
  item: AttentionItem
  calls: () => number
}

/**
 * 用真实 Core 引擎 + FS 存储制造 blocked retry：
 * 同一个 agent 节点连续两次相同失败后，Core 把节点置为 blocked、运行置为
 * waiting_human，并生成 kind=retry 的选项待办。
 */
async function blockedRetry(options: { succeedFrom?: number } = {}): Promise<RetryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'takt-retry-approval-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '重复失败审批' })).id
  const succeedFrom = options.succeedFrom ?? Number.POSITIVE_INFINITY
  let calls = 0
  const harness: HarnessAdapter = {
    id: 'mock',
    displayName: 'mock',
    capabilities: { usage: true, structuredOutput: true },
    available: async () => ({ ok: true }),
    run: async () => {
      calls += 1
      return calls >= succeedFrom
        ? { ok: true, finalText: '完成' }
        : { ok: false, finalText: '', error: 'exit 7' }
    },
  }
  const deps: EngineDeps = {
    stores,
    knowledge: [],
    harnesses: { mock: harness },
    profiles: {
      dev: {
        role: 'dev',
        title: '开发',
        description: '',
        instructions: '实现',
        harness: { harness: 'mock' },
        skills: [],
        writeScope: [],
      },
    },
  }
  const definition: WorkflowDefinition = {
    id: 'retry-approval',
    title: '重复失败审批',
    version: '1',
    stages: [],
    nodes: [agent({ id: 'implement', title: '实现', role: 'dev', prompt: '实现', retry: { max: 5 } })],
  }

  const state = await createEngine(deps).start({ requirementId, workflow: definition })
  expect(state.status).toBe('waiting_human')
  expect(state.nodes.implement).toMatchObject({ status: 'blocked' })
  expect(calls).toBe(2)

  const item = (await stores.attention.list({ pending: true })).find((entry) => entry.runId === state.runId)
  expect(item).toMatchObject({
    nodeId: 'implement',
    kind: 'retry',
    form: 'choice',
    choices: ['再试一次', '交给人处理', '终止运行'],
    attempt: 2,
  })

  return {
    space: { root, stores, insights: createInsights(stores) },
    stores,
    deps,
    definition,
    runId: state.runId,
    item: item!,
    calls: () => calls,
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

/**
 * 生产链路里 answer 落账后会调用 RunManager.onAnswered → engine.resume。
 * 这里用真实 engine.resume 代替 RunManager，避免把运行管理器整套依赖搬进测试。
 */
function approvalsFor(
  fixture: RetryFixture,
  resumeOnAnswer: boolean,
): { approvals: ReturnType<typeof createApprovals>; answered: AttentionItem[] } {
  const answered: AttentionItem[] = []
  const runs: RunManager = {
    async start() { throw new Error('测试不启动新运行') },
    async cancel() {},
    async resume() {},
    async get() { return undefined },
    async onAnswered(_space, item) {
      answered.push(item)
      if (resumeOnAnswer) await createEngine(fixture.deps).resume(item.runId, fixture.definition)
    },
    async disposeAll() {},
  }
  const approvals = createApprovals({
    ctx: { agents: { get: () => undefined, roots: () => [] } },
    ownership: ownershipStub(),
    runs,
    config: { user: '审批人' },
  })
  return { approvals, answered }
}

async function persistedItem(stores: ProjectStores, requestId: string): Promise<AttentionItem | undefined> {
  return (await stores.attention.list()).find((entry) => entry.requestId === requestId)
}

describe('blocked retry 经 createApprovals 落账后由 Core 消费', () => {
  it('终止运行：回答落账，Core resume 取消运行，最后事件与磁盘一致', async () => {
    const fixture = await blockedRetry()
    const { approvals, answered } = approvalsFor(fixture, true)

    const item = await approvals.answer(fixture.space, {
      requestId: fixture.item.requestId,
      attempt: fixture.item.attempt!,
      decision: 'choice',
      answer: '终止运行',
      by: { type: 'human', id: '审批人', via: 'dsh-web' },
    })

    expect(item).toMatchObject({
      requestId: fixture.item.requestId,
      decision: 'choice',
      answer: '终止运行',
      answeredBy: { type: 'human', id: '审批人', via: 'dsh-web' },
    })
    expect(answered).toHaveLength(1)

    const disk = await fixture.stores.runs.get(fixture.runId)
    expect(disk?.status).toBe('cancelled')
    expect(disk?.nodes.implement?.status).toBe('cancelled')

    const events = await fixture.stores.events.read(fixture.runId)
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'cancelled' } })
    const humanAnswers = await fixture.stores.events.read(fixture.runId, { types: ['human.answered'] })
    expect(humanAnswers).toHaveLength(1)
    expect(humanAnswers[0]).toMatchObject({
      nodeId: 'implement',
      actor: { type: 'human', id: '审批人', via: 'dsh-web' },
      data: { requestId: fixture.item.requestId, decision: 'choice', answer: '终止运行' },
    })
    expect((await persistedItem(fixture.stores, fixture.item.requestId))?.answeredAt).toBe(item.answeredAt)
  })

  it('重复提交同一个终止回答幂等：只落一次回答、一条 human.answered', async () => {
    const fixture = await blockedRetry()
    const { approvals, answered } = approvalsFor(fixture, true)
    const input = {
      requestId: fixture.item.requestId,
      attempt: fixture.item.attempt!,
      decision: 'choice',
      answer: '终止运行',
      by: { type: 'human' as const, id: '审批人', via: 'dsh-web' },
    }

    const first = await approvals.answer(fixture.space, input)
    const second = await approvals.answer(fixture.space, input)

    expect(second.answeredAt).toBe(first.answeredAt)
    expect(answered).toHaveLength(1)
    expect((await fixture.stores.events.read(fixture.runId, { types: ['human.answered'] }))).toHaveLength(1)
    expect((await fixture.stores.runs.get(fixture.runId))?.status).toBe('cancelled')
  })

  it('再试一次：Core 清零失败计数并实际重跑成功', async () => {
    const fixture = await blockedRetry({ succeedFrom: 3 })
    const { approvals, answered } = approvalsFor(fixture, true)

    await approvals.answer(fixture.space, {
      requestId: fixture.item.requestId,
      attempt: fixture.item.attempt!,
      decision: 'choice',
      answer: '再试一次',
      by: { type: 'human', id: '审批人', via: 'dsh-web' },
    })

    expect(answered).toHaveLength(1)
    expect(fixture.calls()).toBe(3)
    const disk = await fixture.stores.runs.get(fixture.runId)
    expect(disk?.status).toBe('succeeded')
    expect(disk?.nodes.implement).toMatchObject({ status: 'succeeded', failures: [{ count: 0 }] })
    const humanAnswers = await fixture.stores.events.read(fixture.runId, { types: ['human.answered'] })
    expect(humanAnswers).toHaveLength(1)
    expect(humanAnswers[0]?.data).toMatchObject({ requestId: fixture.item.requestId, answer: '再试一次' })
  })

  it('交给人处理：Core 保持 blocked / waiting_human，不误推进', async () => {
    const fixture = await blockedRetry()
    const { approvals, answered } = approvalsFor(fixture, true)

    await approvals.answer(fixture.space, {
      requestId: fixture.item.requestId,
      attempt: fixture.item.attempt!,
      decision: 'choice',
      answer: '交给人处理',
      by: { type: 'human', id: '审批人', via: 'dsh-web' },
    })

    expect(answered).toHaveLength(1)
    expect(fixture.calls()).toBe(2)
    const disk = await fixture.stores.runs.get(fixture.runId)
    // Core 对“交给人处理”的语义是节点保持 blocked；本轮没有其它可执行节点时，
    // 引擎会按既有规则把运行收敛为 failed（不是我们新增的判断）。
    expect(disk?.nodes.implement).toMatchObject({ status: 'blocked', error: '重复失败已交给人处理' })
    expect(disk?.status).toBe('failed')
    expect((await fixture.stores.events.read(fixture.runId, { types: ['human.answered'] }))).toHaveLength(1)
  })
})
