import { describe, expect, it } from 'vitest'
import { computeMetrics, createCheckList, notificationEvidence, verdictOf } from '../e2e/checks.mjs'

describe('e2e 断言聚合', () => {
  it('check() 捕获的业务失败必须让最终结论为失败', async () => {
    const list = createCheckList(['a', 'b'])
    const value = await list.check('a', async () => {
      throw new Error('业务断言失败')
    })
    expect(value).toBeUndefined()
    expect(list.checks.get('a')?.status).toBe('fail')
    const verdict = verdictOf({ failures: list.failures, checks: list.checks })
    expect(verdict.ok).toBe(false)
    expect(verdict.failed).toEqual([
      { name: 'a', status: 'fail', detail: '业务断言失败' },
      { name: 'b', status: 'not-run', detail: undefined },
    ])
  })

  it('step() 抛出后标记 fail 并向上抛；not-run 也判失败', async () => {
    const list = createCheckList(['a', 'b'])
    await expect(list.step('a', async () => {
      throw new Error('阶段失败')
    })).rejects.toThrow('阶段失败')
    const verdict = verdictOf({ failures: list.failures, checks: list.checks })
    expect(verdict.ok).toBe(false)
    expect(verdict.failed.map((item) => [item.name, item.status])).toEqual([['a', 'fail'], ['b', 'not-run']])
  })

  it('全部 pass 且无异常才通过；显式 failure 即使断言全绿也失败', () => {
    const list = createCheckList(['a'])
    list.mark('a', 'pass')
    expect(verdictOf({ failures: list.failures, checks: list.checks }).ok).toBe(true)
    expect(verdictOf({ failure: new Error('超时'), failures: list.failures, checks: list.checks }).ok).toBe(false)
  })
})

type CallInput = { callId: string; name: string; args: Record<string, unknown> }
type ResultInput = { callId: string; isError?: boolean; business?: Record<string, unknown>; text?: string }

function digestOf(calls: CallInput[], results: ResultInput[]) {
  return { calls, results: new Map(results.map((result) => [result.callId, result])) }
}

describe('Lead 工具指标', () => {
  it('主成功率分母包含 pending；resolvedSuccessRate 单独统计', () => {
    const digest = digestOf(
      [
        { callId: 'c1', name: 'takt_status', args: {} },
        { callId: 'c2', name: 'takt_requirement', args: { action: 'create' } },
      ],
      [{ callId: 'c1', isError: false, business: { ok: true } }],
    )
    const metrics = computeMetrics(digest)
    expect(metrics.totalCalls).toBe(2)
    expect(metrics.pendingCalls).toBe(1)
    expect(metrics.succeededCalls).toBe(1)
    expect(metrics.successRate).toBe(0.5)
    expect(metrics.resolvedSuccessRate).toBe(1)
  })

  it('isError=true 即使 render 文本里有 ok=true 也不算成功', () => {
    const digest = digestOf(
      [{ callId: 'c1', name: 'takt_run', args: { action: 'start' } }],
      [{ callId: 'c1', isError: true, business: { ok: true } }],
    )
    const metrics = computeMetrics(digest)
    expect(metrics.succeededCalls).toBe(0)
    expect(metrics.errorCalls).toBe(1)
    expect(metrics.successRate).toBe(0)
    expect(metrics.calls[0]?.ok).toBe(false)

    // runtime 错误即使携带 TAKT_NO_SPACE，也不能算“预期用对”。
    const noSpaceError = digestOf(
      [{ callId: 'c2', name: 'takt_status', args: {} }],
      [{ callId: 'c2', isError: true, business: { ok: false, error: { code: 'TAKT_NO_SPACE' } } }],
    )
    const noSpaceMetrics = computeMetrics(noSpaceError)
    expect(noSpaceMetrics.calls[0]?.expectedNoSpace).toBe(false)
    expect(noSpaceMetrics.firstCallCorrectByTool.ratio).toBe(0)
  })

  it('首次调用取原始第一次；首个 pending 不能被后面的成功覆盖', () => {
    const digest = digestOf(
      [
        { callId: 'c1', name: 'takt_requirement', args: { action: 'init' } },
        { callId: 'c2', name: 'takt_requirement', args: { action: 'init' } },
      ],
      [{ callId: 'c2', isError: false, business: { ok: true } }],
    )
    const metrics = computeMetrics(digest)
    expect(metrics.firstCallCorrectByAction).toEqual({ passed: 0, total: 1, ratio: 0 })
    expect(metrics.firstCallBusinessOkByAction).toEqual({ passed: 0, total: 1, ratio: 0 })
  })

  it('TAKT_NO_SPACE 只在 init 成功之前算用对；之后报无空间是失败', () => {
    const noSpace = (callId: string) => ({ callId, isError: false, business: { ok: false, error: { code: 'TAKT_NO_SPACE' } } })
    const digest = digestOf(
      [
        { callId: 'c1', name: 'takt_status', args: {} },
        { callId: 'c2', name: 'takt_requirement', args: { action: 'init' } },
        { callId: 'c3', name: 'takt_status', args: {} },
      ],
      [noSpace('c1'), { callId: 'c2', isError: false, business: { ok: true } }, noSpace('c3')],
    )
    const metrics = computeMetrics(digest)
    expect(metrics.calls[0]?.expectedNoSpace).toBe(true)
    expect(metrics.calls[2]?.expectedNoSpace).toBe(false)
    expect(metrics.firstCallCorrectByTool.ratio).toBe(1)
    // 严格业务口径不豁免 NO_SPACE：takt_status 首次算失败，只有 init 算成功。
    expect(metrics.firstCallBusinessOkByTool).toEqual({ passed: 1, total: 2, ratio: 0.5 })
  })
})

describe('通知投递证据', () => {
  const requirementId = 'REQ-001'
  const runId = 'run-1'
  const text = `[taktflow] REQ=${requirementId} run=${runId}；运行结束：succeeded`

  const spliced = (id: string, body = text) => ({
    type: 'event',
    event: {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', inserted: [{ message: { id, content: [{ type: 'text', text: body }] } }] },
    },
  })

  it('只有 inbox 插入、没有 user/message 时只算 queued，不算投递', () => {
    const evidence = notificationEvidence([spliced('m1')], { requirementId, runId })
    expect(evidence.queued).toHaveLength(1)
    expect(evidence.admitted).toHaveLength(0)
    expect(evidence.terminal).toBe(false)
  })

  it('id 与 user/message 配对后算 admitted，并识别精确终态文案', () => {
    const records = [
      spliced('m1', `[taktflow] REQ=${requirementId} run=${runId}；当前状态：waiting_human`),
      { type: 'event', event: { type: 'user/message', data: { id: 'm1', content: [{ type: 'text', text: 'x' }] } } },
      spliced('m2'),
      { type: 'event', event: { type: 'user/message', data: { id: 'm2', content: [{ type: 'text', text: 'x' }] } } },
    ]
    const evidence = notificationEvidence(records, { requirementId, runId })
    expect(evidence.queued).toHaveLength(2)
    expect(evidence.admitted).toHaveLength(2)
    expect(evidence.terminal).toBe(true)
  })

  it('状态快照不是会话证据；其它 REQ/run 的消息也不计入', () => {
    expect(notificationEvidence([], { requirementId, runId })).toMatchObject({ queued: [], admitted: [], terminal: false })
    const other = spliced('m3', '[taktflow] REQ=REQ-002 run=run-2；运行结束：succeeded')
    expect(notificationEvidence([other], { requirementId, runId }).queued).toHaveLength(0)
  })
})
