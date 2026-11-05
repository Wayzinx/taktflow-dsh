/**
 * P0 e2e 的纯判定逻辑。
 *
 * 与进程、网络、dsh 无关，便于离线回归：聚合结论不能把 fail / not-run 当成通过，
 * Lead 工具指标的分母和“首次调用”口径必须固定，通知必须有真实会话投递证据。
 */
import { contentText, eventOf } from './lib.mjs'

export function createCheckList(names) {
  const checks = new Map(names.map((name) => [name, { name, status: 'not-run' }]))
  const failures = []
  const mark = (name, status, detail) => {
    const check = checks.get(name)
    if (check === undefined) throw new Error(`未知断言：${name}`)
    check.status = status
    if (detail !== undefined) check.detail = detail
  }
  const step = async (name, fn, detailOf = () => undefined) => {
    try {
      const value = await fn()
      mark(name, 'pass', detailOf(value))
      return value
    } catch (error) {
      mark(name, 'fail', error instanceof Error ? error.message : String(error))
      failures.push(error)
      throw error
    }
  }
  const check = async (name, fn, detailOf = () => undefined) => {
    try {
      const value = await fn()
      mark(name, 'pass', detailOf(value))
      return value
    } catch (error) {
      mark(name, 'fail', error instanceof Error ? error.message : String(error))
      failures.push(error)
      return undefined
    }
  }
  return { checks, failures, mark, step, check }
}

/**
 * 最终结论。只有所有断言都是 pass 且没有异常才算通过；
 * fail / not-run 一律非零退出，不能被“已收集到 failures”掩盖。
 */
export function verdictOf({ failure, failures, checks }) {
  const failed = [...checks.values()]
    .filter((check) => check.status !== 'pass')
    .map((check) => ({ name: check.name, status: check.status, detail: check.detail }))
  const ok = failure === undefined && failures.length === 0 && failed.length === 0
  return { ok, failed }
}

function ratio(map) {
  const values = [...map.values()]
  const passed = values.filter((value) => value === true).length
  return {
    passed,
    total: values.length,
    ratio: values.length === 0 ? null : passed / values.length,
  }
}

/**
 * Lead 工具指标。
 *
 * - 主成功率：业务 ok=true 的调用 / **全部** takt_* 调用；pending、unknown 计入分母，
 *   不排除后报一个更好看的比例。
 * - resolvedSuccessRate：业务 ok / 已有结果的调用，单独说明。
 * - 首次调用用对：按 (工具, action) 分组取**真正第一次**调用；pending/unknown 不算成功。
 *   `takt_status` 的 TAKT_NO_SPACE 是预期状态，只在“用对”口径里算对。
 * - firstCallBusinessOk：同一分组第一次调用是否严格业务成功（不豁免 NO_SPACE）。
 * - isError=true 的调用一律不算业务成功，即使 render 文本里混进了 ok=true。
 */
export function computeMetrics(digest) {
  const rows = digest.calls
    .filter((call) => typeof call.name === 'string' && call.name.startsWith('takt_'))
    .map((call) => {
      const result = digest.results.get(call.callId)
      const action = typeof call.args.action === 'string' ? call.args.action : undefined
      const business = result?.business
      const code = typeof business?.error?.code === 'string' ? business.error.code : undefined
      const ok = result !== undefined && result.isError !== true && business?.ok === true
      return {
        callId: call.callId,
        name: call.name,
        action,
        ok,
        pending: result === undefined,
        unknown: result !== undefined && result.isError !== true && business === undefined,
        isError: result?.isError === true,
        code,
        expectedNoSpace: false,
        summary: typeof business?.summary === 'string'
          ? business.summary.slice(0, 300)
          : result?.text?.slice(0, 300),
      }
    })

  // TAKT_NO_SPACE 只在首次 init 成功之前算“预期用对”；init 之后仍报无空间就是真失败。
  // isError=true 的调用一律不算“用对”，即使文本里混有 TAKT_NO_SPACE。
  const initIndex = rows.findIndex((row) => row.name === 'takt_requirement' && row.action === 'init' && row.ok)
  const initBoundary = initIndex === -1 ? rows.length : initIndex
  for (const [index, row] of rows.entries()) {
    row.expectedNoSpace = row.name === 'takt_status'
      && row.code === 'TAKT_NO_SPACE'
      && row.isError !== true
      && index < initBoundary
  }

  const resolved = rows.filter((row) => !row.pending)
  const succeeded = rows.filter((row) => row.ok)
  const firstByAction = new Map()
  const firstByTool = new Map()
  const firstBusinessByAction = new Map()
  const firstBusinessByTool = new Map()
  for (const row of rows) {
    const actionKey = `${row.name}:${row.action ?? '-'}`
    if (!firstByAction.has(actionKey)) firstByAction.set(actionKey, row.ok || row.expectedNoSpace)
    if (!firstByTool.has(row.name)) firstByTool.set(row.name, row.ok || row.expectedNoSpace)
    if (!firstBusinessByAction.has(actionKey)) firstBusinessByAction.set(actionKey, row.ok)
    if (!firstBusinessByTool.has(row.name)) firstBusinessByTool.set(row.name, row.ok)
  }

  return {
    totalCalls: rows.length,
    resolvedCalls: resolved.length,
    succeededCalls: succeeded.length,
    pendingCalls: rows.filter((row) => row.pending).length,
    unknownCalls: rows.filter((row) => row.unknown).length,
    errorCalls: rows.filter((row) => row.isError).length,
    successRate: rows.length === 0 ? null : succeeded.length / rows.length,
    resolvedSuccessRate: resolved.length === 0 ? null : succeeded.length / resolved.length,
    firstCallCorrectByAction: ratio(firstByAction),
    firstCallCorrectByTool: ratio(firstByTool),
    firstCallBusinessOkByAction: ratio(firstBusinessByAction),
    firstCallBusinessOkByTool: ratio(firstBusinessByTool),
    // 完整逐调用记录，不截断；结果文件由调用方做路径/用户名脱敏。
    calls: rows,
  }
}

/**
 * 通知投递证据。只认 dsh 会话里 `agent/inbox/spliced` 插入、且对应
 * `user/message` 已出现（admitted）的消息；状态快照不算会话证据。
 *
 * @returns {{ queued, admitted, terminal, samples }}
 */
export function notificationEvidence(records, { requirementId, runId, terminalText = '运行结束：succeeded' }) {
  const prefix = `[taktflow] REQ=${requirementId} run=${runId}`
  const events = records.map(eventOf).filter((event) => event !== null && typeof event === 'object')
  const userMessageIds = new Set()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const id = event.data?.id ?? event.data?.message?.id
    if (typeof id === 'string' && id !== '') userMessageIds.add(id)
  }

  const messageText = (message) => {
    if (typeof message?.content === 'string') return message.content.trim()
    return contentText(message?.content ?? [])
  }

  const queued = []
  const admitted = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
    for (const entry of inserted) {
      const message = entry?.message ?? entry
      const id = message?.id
      const text = messageText(message)
      if (typeof id !== 'string' || id === '' || !text.startsWith(prefix)) continue
      const record = { id, target: event.data?.target ?? null, text }
      queued.push(record)
      if (userMessageIds.has(id)) admitted.push(record)
    }
  }

  return {
    queued,
    admitted,
    terminal: admitted.some((record) => record.text.includes(terminalText)),
    texts: admitted.map((record) => record.text),
    samples: admitted.slice(-4).map((record) => record.text.slice(0, 500)),
  }
}
