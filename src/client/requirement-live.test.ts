import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-ignore 根 tsconfig 用 NodeNext，不允许 .ts 后缀；vitest 需要显式 .ts 才能跨包解析。
import { LIVE_REFRESH_DEBOUNCE_MS, startRequirementLiveRefresh } from '../../vendor/taktflow/packages/web/src/pages/requirement/live-refresh.ts'
import type { EventEnvelope } from '@taktflow/core'

function event(type: EventEnvelope['type'], runId = 'run-a'): EventEnvelope {
  return { seq: 1, ts: '', runId, type, actor: { type: 'system', id: 'system' }, data: {}, prevHash: '', hash: '' } as EventEnvelope
}

/** 记录订阅 / 刷新 / 清理顺序，并暴露触发事件和当前回调的入口。 */
function harness() {
  const calls: string[] = []
  let handler: ((e: EventEnvelope) => void) | undefined
  const off = vi.fn(() => {
    calls.push('off')
  })
  const subscribe = vi.fn((runId: string, onEvent: (e: EventEnvelope) => void) => {
    calls.push(`subscribe:${runId}`)
    handler = onEvent
    return off
  })
  const refresh = vi.fn(() => {
    calls.push('refresh')
  })
  return { calls, subscribe, refresh, off, fire: (e: EventEnvelope) => handler?.(e) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('需求页运行实时刷新', () => {
  it('先订阅当前运行再补拉一次，普通事件合并成一次刷新', () => {
    vi.useFakeTimers()
    const h = harness()
    const stop = startRequirementLiveRefresh({ runId: 'run-a', subscribe: h.subscribe, refresh: h.refresh })

    expect(h.subscribe).toHaveBeenCalledWith('run-a', expect.any(Function))
    expect(h.calls).toEqual(['subscribe:run-a', 'refresh'])

    h.fire(event('node.started'))
    h.fire(event('node.finished'))
    expect(h.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS - 1)
    expect(h.refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(h.refresh).toHaveBeenCalledTimes(2)

    // 合并窗口结束后新的一串事件仍会再刷新一次，且全程只订阅一次。
    h.fire(event('artifact.written'))
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(h.refresh).toHaveBeenCalledTimes(3)
    expect(h.subscribe).toHaveBeenCalledTimes(1)

    stop()
  })

  it('run.finished 立即刷新，并丢弃未到期的合并刷新', () => {
    vi.useFakeTimers()
    const h = harness()
    const stop = startRequirementLiveRefresh({ runId: 'run-a', subscribe: h.subscribe, refresh: h.refresh })

    h.fire(event('node.finished'))
    h.fire(event('run.finished'))
    expect(h.refresh).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS * 2)
    expect(h.refresh).toHaveBeenCalledTimes(2)

    stop()
  })

  it('清理后取消订阅并丢弃未到期刷新，迟到事件不再刷新', () => {
    vi.useFakeTimers()
    const h = harness()
    const stop = startRequirementLiveRefresh({ runId: 'run-a', subscribe: h.subscribe, refresh: h.refresh })

    h.fire(event('node.started'))
    stop()
    expect(h.off).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(h.refresh).toHaveBeenCalledTimes(1)

    h.fire(event('node.finished'))
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('切换运行：旧订阅被清理，旧运行的事件不影响新运行', () => {
    vi.useFakeTimers()
    const a = harness()
    const stopA = startRequirementLiveRefresh({ runId: 'run-a', subscribe: a.subscribe, refresh: a.refresh })
    const b = harness()
    const stopB = startRequirementLiveRefresh({ runId: 'run-b', subscribe: b.subscribe, refresh: b.refresh })

    stopA()
    a.fire(event('node.finished', 'run-a'))
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(a.refresh).toHaveBeenCalledTimes(1)
    expect(b.refresh).toHaveBeenCalledTimes(1)

    b.fire(event('node.finished', 'run-b'))
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(b.refresh).toHaveBeenCalledTimes(2)

    stopB()
  })

  it('忽略其他运行的事件（当前运行过滤）', () => {
    vi.useFakeTimers()
    const h = harness()
    const stop = startRequirementLiveRefresh({ runId: 'run-a', subscribe: h.subscribe, refresh: h.refresh })

    h.fire(event('node.started', 'run-b'))
    h.fire(event('run.finished', 'run-b'))
    expect(h.refresh).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS)
    expect(h.refresh).toHaveBeenCalledTimes(1)

    stop()
  })
})
