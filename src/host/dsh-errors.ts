import type { AgentErrorEvent, HostContext, SessionEvent, SubagentResult } from './dsh-types.js'

/** 宿主在发布子会话之前订阅；只保留指定子会话的脱敏错误，不保存原始异常或堆栈；清理监听失败时显式抛错。 */
export function observeDshFailure(
  ctx: Pick<HostContext, 'on'>,
  childId: string,
  redact: (value: string) => string,
): { describe(result: SubagentResult): string; dispose(): Promise<void> } {
  let failure: string | undefined
  const clean = (value: string) => {
    const bytes = Buffer.from(redact(value))
    if (bytes.length <= 4096) return bytes.toString()
    let end = 4093
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    return `${bytes.subarray(0, end).toString()}…`
  }
  const capture = (error: unknown) => {
    if (typeof error === 'string') { failure = clean(error); return }
    if (!error || typeof error !== 'object') return
    const value = error as { message?: unknown; code?: unknown }
    if (typeof value.message !== 'string') return
    failure = clean(`${typeof value.code === 'string' ? `[${value.code}] ` : ''}${value.message}`)
  }
  const stopError = ctx.on('agent/error', ((event: AgentErrorEvent) => {
    if (event.agent.id === childId) capture(event.error)
  }) as (...args: never[]) => void)
  const stopSession = ctx.on('session/event', ((session: { id?: string; header?: { id?: string } }, event: SessionEvent) => {
    if ((session.id ?? session.header?.id) !== childId || event.type !== 'turn/end') return
    const data = event.data as { reason?: { kind?: unknown; error?: unknown } } | undefined
    if (data?.reason?.kind === 'error') capture(data.reason.error)
  }) as (...args: never[]) => void)
  return {
    describe(result) {
      // spawn 的 captureLocalResult 不带 diagnostic；早于 turn 的失败只能从 agent/error 获取。
      return clean(result.diagnostic ?? failure ?? `子 Agent 停止：${result.stopReason}`)
    },
    async dispose() {
      const results = await Promise.allSettled([Promise.resolve().then(stopSession), Promise.resolve().then(stopError)])
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map((value) => value.reason)
      if (errors.length) throw new AggregateError(errors, '子会话错误监听清理失败')
    },
  }
}
