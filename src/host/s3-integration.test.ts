import { acquireLease, releaseLease, type AttentionItem } from '@taktflow/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVE_LABEL } from './approvals.js'
import type { LeadToolResult } from './lead/tools.js'
import {
  CONFIG_USER,
  HOST_SESSION,
  ROOT_AGENT_ID,
  createS3Fixture,
  toolExec,
  type S3Fixture,
} from './s3-fixture.js'
import { TaktToolError, type AnswerInput } from './types.js'

/**
 * S3 集成测试。
 *
 * 真实 core stores / engine + mock harness + 真实 approvals/routes + bindings；
 * RunManager 只是测试替身，负责 requestKey 幂等和引擎恢复。这里验证的是宿主
 * 半的审批闭环，不代表真实 dsh 宿主、真实问题卡片或真实唤醒链路已经打通。
 */

const fixtures: S3Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

async function makeFixture(): Promise<S3Fixture> {
  const fixture = await createS3Fixture()
  fixtures.push(fixture)
  return fixture
}

function humanBy(via: string) {
  return { type: 'human' as const, id: CONFIG_USER, via }
}

function answerInput(item: AttentionItem, patch: Partial<AnswerInput> = {}): AnswerInput {
  return {
    requestId: item.requestId,
    attempt: item.attempt ?? 1,
    decision: 'approve',
    by: humanBy('dsh-web'),
    ...patch,
  }
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

function routeFor(fixture: S3Fixture, path: string) {
  const found = fixture.host.routes.find((entry) => entry.path === path)
  if (found === undefined) throw new Error(`路由未注册：${path}`)
  return found
}

async function postOp(
  fixture: S3Fixture,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await routeFor(fixture, '/api/taktflow.op').fetch(
    new Request('http://localhost/api/taktflow.op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ space: fixture.root, ...body }),
    }),
  )
  return { status: response.status, body: await response.json() }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe('S3：真实 core + mock harness 的审批闭环', () => {
  it('重复 start 按 requestKey 去重，只执行一次引擎', async () => {
    const fixture = await makeFixture()

    const first = await fixture.start('request-dup')
    const second = await fixture.start('request-dup')

    expect(second).toEqual({ runId: first.runId, deduped: true })
    expect(fixture.runs.startCalls).toEqual(['request-dup'])
    expect(fixture.harnessCalls.filter((node) => node === 'draft')).toHaveLength(1)
    const state = await fixture.runState(first.runId)
    expect(state?.status).toBe('waiting_human')
    expect(fixture.published).toEqual([])
  })

  it('并发路由 run.start 按 requestKey 只执行一次真实 core 引擎', async () => {
    const fixture = await makeFixture()
    const body = {
      p: 'run.start',
      requirementId: fixture.requirementId,
      workflowId: fixture.workflow.id,
      requestKey: 'request-concurrent',
    }

    // 两个请求同时穿过路由与写租约；TestRunManager 必须用 inflight 串行化，
    // 不能等 engine.start 返回后才记账，否则引擎会真实执行两次。
    const [first, second] = await Promise.all([postOp(fixture, body), postOp(fixture, body)])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.data.runId).toBe(second.body.data.runId)
    expect([first.body.data.deduped, second.body.data.deduped].sort()).toEqual([false, true])
    expect(fixture.runs.startCalls).toEqual(['request-concurrent'])
    expect(fixture.harnessCalls.filter((node) => node === 'draft')).toHaveLength(1)
    expect((await fixture.runState(first.body.data.runId))?.status).toBe('waiting_human')
  })

  it('没有显式批准时运行停在人工节点，不执行下游发布', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    expect(item.attempt).toBe(1)
    expect(item.subjects?.map((subject) => subject.path)).toEqual(['spec/spec.md', 'spec/plan.md'])

    // 卡片返回空答案（取消/跳过/超时）不落账、不推进；必须走 A 的真实工具执行。
    fixture.host.askHandler = async () => ({ answers: [] })
    const result = await fixture.askHuman.execute(
      { requestId: item.requestId },
      toolExec(fixture.agent),
    ) as LeadToolResult
    expect(result).toMatchObject({ ok: true, presented: true, answered: false, pending: true })

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('waiting_human')
    expect(state?.nodes.publish?.status).toBe('pending')
    expect(fixture.published).toEqual([])
    expect(fixture.runs.answered).toHaveLength(0)
    expect((await fixture.findItem(item.requestId))?.answeredAt).toBeUndefined()
  })

  it('真实工具卡片批准后落账并唤醒引擎，发布只执行一次', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    const answerSpy = vi.spyOn(fixture.approvals, 'answer')
    fixture.host.askHandler = async (request) => ({
      answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL] }],
    })
    // 走 A 的真实 takt_ask_human.execute，而不是直接调用 approvals.present。
    const result = await fixture.askHuman.execute(
      { requestId: item.requestId },
      toolExec(fixture.agent),
    ) as LeadToolResult
    expect(result).toMatchObject({ ok: true, presented: true, answered: true, decision: 'approve' })
    expect(answerSpy).toHaveBeenCalledTimes(1)
    // 真实工具通过 SpaceRegistry 解析空间，拿到的是注册表缓存的 handle；
    // 这里只核对同一个空间根，不要求与 fixture 手工构造的 handle 同一对象。
    expect((answerSpy.mock.calls[0]![0] as { root: string }).root).toBe(fixture.root)
    expect((answerSpy.mock.calls[0]![1] as AnswerInput).by).toEqual({
      type: 'human',
      id: CONFIG_USER,
      via: 'dsh:user-questions',
    })

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('succeeded')
    expect(state?.nodes.publish?.status).toBe('succeeded')
    expect(fixture.published).toEqual(['publish'])
    expect(fixture.runs.answered).toHaveLength(1)
    expect(await fixture.findItem(item.requestId)).toMatchObject({
      decision: 'approve',
      answeredBy: { type: 'human', id: CONFIG_USER, via: 'dsh:user-questions' },
    })
  })

  it('面板路由批准走同一个 approvals.answer，重复回答不重复推进', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    // 路由与工具共用同一个 approvals 实例。
    expect(fixture.service.approvals).toBe(fixture.approvals)

    const first = await postOp(fixture, {
      p: 'attention.answer',
      requestId: item.requestId,
      attempt: 1,
      decision: 'approve',
      answer: '同意',
      // 伪造的 by 必须被宿主覆盖。
      by: { type: 'human', id: '伪造用户' },
    })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, data: { decision: 'approve' } })

    const second = await postOp(fixture, {
      p: 'attention.answer',
      requestId: item.requestId,
      attempt: 1,
      decision: 'approve',
    })
    expect(second.status).toBe(200)

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('succeeded')
    expect(fixture.published).toEqual(['publish'])
    expect(fixture.runs.answered).toHaveLength(1)
    expect(await fixture.findItem(item.requestId)).toMatchObject({
      decision: 'approve',
      answeredBy: { type: 'human', id: CONFIG_USER, via: 'dsh-web' },
    })
  })

  it('真实工具与面板路由共用同一个 approvals.answer 实例', async () => {
    const fixture = await makeFixture()
    const answerSpy = vi.spyOn(fixture.approvals, 'answer')

    const first = await fixture.start('request-tool')
    const firstItem = await fixture.pending()
    fixture.host.askHandler = async (request) => ({
      answers: [{ id: request.questions[0]!.id, selected: [APPROVE_LABEL] }],
    })
    const toolResult = await fixture.askHuman.execute(
      { requestId: firstItem.requestId },
      toolExec(fixture.agent),
    ) as LeadToolResult
    expect(toolResult).toMatchObject({ ok: true, answered: true, decision: 'approve' })

    const second = await fixture.start('request-route')
    const secondItem = await fixture.pending()
    const routed = await postOp(fixture, {
      p: 'attention.answer',
      requestId: secondItem.requestId,
      attempt: 1,
      decision: 'approve',
    })
    expect(routed.status).toBe(200)

    // present 内部也调用同一个实例方法：工具与路由各一次，没有第二套落账路径。
    expect(fixture.service.approvals).toBe(fixture.approvals)
    expect(answerSpy).toHaveBeenCalledTimes(2)
    // 工具与路由都从 SpaceRegistry 拿同一个缓存 handle，且都落到同一个 answer。
    expect(answerSpy.mock.calls[0]![0]).toBe(answerSpy.mock.calls[1]![0])
    expect((answerSpy.mock.calls[0]![0] as { root: string }).root).toBe(fixture.root)
    const vias = answerSpy.mock.calls
      .map((call) => (call[1] as AnswerInput).by)
      .map((by) => (by.type === 'human' ? by.via : undefined))
    expect(vias).toEqual(['dsh:user-questions', 'dsh-web'])
    expect(fixture.published).toEqual(['publish', 'publish'])
    expect((await fixture.runState(first.runId))?.status).toBe('succeeded')
    expect((await fixture.runState(second.runId))?.status).toBe('succeeded')
  })

  it('打回按 core 语义让节点和运行失败，不执行下游', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    const result = await postOp(fixture, {
      p: 'attention.answer',
      requestId: item.requestId,
      attempt: 1,
      decision: 'reject',
      answer: '缺少验收标准',
    })
    expect(result.status).toBe(200)

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('failed')
    expect(state?.nodes.approve?.status).toBe('failed')
    expect(state?.nodes.approve?.error).toBe('人工拒绝')
    expect(state?.nodes.publish?.status).toBe('pending')
    expect(fixture.published).toEqual([])
  })

  it('取消运行后待办变为 cancelled，再回答也不会推进', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    await fixture.runs.cancel(fixture.space, runId, humanBy('dsh-web'))

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('cancelled')
    expect(state?.nodes.approve?.status).toBe('cancelled')
    expect(await fixture.findItem(item.requestId)).toMatchObject({ decision: 'cancelled' })

    const answered = await fixture.approvals.answer(fixture.space, answerInput(item))
    expect(answered.decision).toBe('cancelled')
    expect(fixture.runs.answered).toHaveLength(0)
    expect(fixture.published).toEqual([])
  })

  it('冻结 attempt 与节点当前尝试次数不一致时拒绝', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    // 模拟节点已经重试到第 2 次，而待办仍冻结在第 1 次。
    const state = await fixture.runState(runId)
    state!.nodes.approve!.attempts = 2
    await fixture.stores.runs.save(state!)

    await expectTaktError(fixture.approvals.answer(fixture.space, answerInput(item)), 'TAKT_STALE_VERSION')
    expect(fixture.runs.answered).toHaveLength(0)
    expect(fixture.published).toEqual([])
    expect((await fixture.findItem(item.requestId))?.answeredAt).toBeUndefined()
  })

  it('任一冻结产物出现新版本时拒绝批准', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    await fixture.stores.workspaces.writeArtifact({
      ref: { workspace: fixture.requirementId, path: 'spec/plan.md' },
      content: '# 方案 v2\n',
      kind: 'design',
      author: { type: 'human', id: CONFIG_USER },
      reason: '人工更新方案',
    })

    await expectTaktError(
      fixture.approvals.answer(fixture.space, answerInput(item, { artifactVersion: 1 })),
      'TAKT_STALE_VERSION',
    )
    expect(fixture.runs.answered).toHaveLength(0)
    expect((await fixture.runState(runId))?.status).toBe('waiting_human')
    expect(fixture.published).toEqual([])
  })

  it('CLI 真实占用租约时，工具与路由写入口都拒绝且不推进', async () => {
    const fixture = await makeFixture()
    await fixture.start()
    const item = await fixture.pending()

    const held = await acquireLease(fixture.stores.taktDir, 'cli:s3-test')
    expect(held.ok).toBe(true)
    try {
      await expectTaktError(fixture.approvals.answer(fixture.space, answerInput(item)), 'TAKT_LEASE_HELD')

      const routed = await postOp(fixture, {
        p: 'attention.answer',
        requestId: item.requestId,
        attempt: 1,
        decision: 'approve',
      })
      expect(routed.status).toBe(409)
      expect(routed.body.error.code).toBe('TAKT_LEASE_HELD')

      expect(fixture.runs.answered).toHaveLength(0)
      expect(fixture.published).toEqual([])
      expect((await fixture.findItem(item.requestId))?.answeredAt).toBeUndefined()
    } finally {
      await releaseLease(fixture.stores.taktDir, 'cli:s3-test')
    }
  })

  it('审批读取 freshness 期间租约不能释放或被 CLI 接管，解除阻塞后正常落账', async () => {
    const fixture = await makeFixture()
    const { runId } = await fixture.start()
    const item = await fixture.pending()

    // 在 latestSubjectRefs 的真实读取处阻塞：此时审批已持有租约，但尚未落账。
    const originalListArtifacts = fixture.stores.workspaces.listArtifacts.bind(fixture.stores.workspaces)
    const gate = deferred()
    let blocked = false
    fixture.stores.workspaces.listArtifacts = async (workspaceId) => {
      if (!blocked) {
        blocked = true
        await gate.promise
      }
      return originalListArtifacts(workspaceId)
    }

    const approval = fixture.approvals.answer(fixture.space, answerInput(item))
    try {
      await waitFor(() => blocked)

      // 运行仍在 waiting_human：释放必须 409，不能让 CLI 在审批落账前接管。
      const released = await postOp(fixture, { p: 'lease.release' })
      expect(released.status).toBe(409)
      expect(released.body.error.code).toBe('TAKT_RUN_BUSY')

      const cli = await acquireLease(fixture.stores.taktDir, 'cli:interleave')
      expect(cli.ok).toBe(false)
      if (!cli.ok) expect(cli.held.owner).toBe(fixture.ownership.hostOwner)

      // 解除阻塞：落账前紧邻的第二次 ensureLease 仍由本宿主持有，批准正常推进。
      gate.resolve()
      const answered = await approval
      expect(answered.decision).toBe('approve')
    } finally {
      fixture.stores.workspaces.listArtifacts = originalListArtifacts
      gate.resolve()
      await approval.catch(() => {})
    }

    const state = await fixture.runState(runId)
    expect(state?.status).toBe('succeeded')
    expect(fixture.published).toEqual(['publish'])
    expect(fixture.runs.answered).toHaveLength(1)
    expect(await fixture.findItem(item.requestId)).toMatchObject({ decision: 'approve' })
  })

  it('根 Agent 身份校验：子 Agent / 已失效 Agent 不能弹审批卡片', async () => {
    const fixture = await makeFixture()
    await fixture.start()
    const item = await fixture.pending()

    // 身份契约：agent.id 即会话身份，绑定表、工具校验与运行所有权必须一致。
    expect(ROOT_AGENT_ID).toBe(fixture.agent.id)
    expect(HOST_SESSION).toBe(fixture.agent.id)
    expect(await fixture.bindings.bySession(fixture.space, fixture.agent.id)).toBe(fixture.requirementId)
    expect(await fixture.bindings.byRequirement(fixture.space, fixture.requirementId)).toBe(fixture.agent.id)

    const child = {
      ...fixture.agent,
      id: 'agent-child',
      session: { header: { id: 'agent-child', cwd: fixture.root, agentPreset: 'taktflow' } },
    }
    const childResult = await fixture.askHuman.execute(
      { requestId: item.requestId },
      toolExec(child),
    ) as LeadToolResult
    expect(childResult).toMatchObject({ ok: false, error: { code: 'TAKT_NOT_BOUND' } })

    const dead = { ...fixture.agent, id: 'agent-dead' }
    const deadResult = await fixture.askHuman.execute(
      { requestId: item.requestId },
      toolExec(dead),
    ) as LeadToolResult
    expect(deadResult).toMatchObject({ ok: false, error: { code: 'TAKT_NOT_BOUND' } })

    expect(fixture.host.questions).toHaveLength(0)
  })
})
