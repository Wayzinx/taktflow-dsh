/** T1 交付证据的纯判定逻辑；只读取已有证据，绝不生成模型结果或归因。 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { contentText, eventOf, readSessionRecords } from './lib.mjs'
import { parseJsonText, lastJsonLine } from './defect-lib.mjs'

/** 验收驱动调用：校验真实 PM 生成的用例与固定 runner 的合同；不认识的形状直接失败。 */
export function validateGeneratedCases(items, spec) {
  const acs = new Set(spec.match(/\bAC-\d+(?:-\d+)?\b/g) ?? [])
  if (!['AC-1', 'AC-2', 'AC-3', 'AC-4'].every((ac) => acs.has(ac))) throw new Error('PM spec 缺少原始需求的 AC-1 至 AC-4（含既有行为回归）')
  if (!Array.isArray(items) || items.length < 6) throw new Error('PM 没有生成两条含税验收与四条 baseline 真实用例')
  const ids = new Set()
  for (const item of items) {
    if (!/^TC-[A-Z0-9-]+$/.test(item?.id) || ids.has(item.id)) throw new Error('PM 用例 ID 不合法或重复')
    ids.add(item.id)
    if (!Array.isArray(item.covers) || item.covers.length === 0 || !item.covers.every((ac) => acs.has(ac))) {
      throw new Error(`PM 用例 ${item.id} 的 covers 没有引用真实 spec AC`)
    }
    if (typeof item.input?.fn !== 'string' || !Array.isArray(item.input?.args) || !Object.hasOwn(item, 'expected')) {
      throw new Error(`PM 用例 ${item.id} 不符合固定 runner 的 input/expected 合同`)
    }
    if (item.artifact?.path !== `cases/${item.id}.json`) throw new Error(`用例 ${item.id} 与产物文件名不一致`)
  }
  for (const ac of acs) {
    if (!items.some((item) => item.covers.includes(ac))) throw new Error(`PM 的 ${ac} 没有生成验收用例`)
  }
  const required = [
    ['formatPriceWithTax', [10000, 0.06], '¥106.00', 'AC-1'],
    ['formatPriceWithTax', [0, 0.06], '¥0.00', 'AC-2'],
    ['formatPrice', [1234], '¥12.34', 'AC-3'],
    ['formatPrice', [-1234], '-¥12.34', 'AC-3'],
    ['parsePrice', ['¥12.34'], 1234, 'AC-4'],
    ['parsePrice', ['¥0.00'], 0, 'AC-4'],
  ]
  for (const [fn, args, expected, ac] of required) {
    if (!items.some((item) => item.input.fn === fn
      && JSON.stringify(item.input.args) === JSON.stringify(args) && item.expected === expected && item.covers.includes(ac))) {
      throw new Error(`PM 用例遗漏或改写原始需求/回归示例 ${ac} ${fn}(${JSON.stringify(args)})`)
    }
  }
  return { ids: [...ids], acs: [...acs] }
}

/** 验收驱动调用：实际 runner 输出必须逐条覆盖本次 PM 用例，不能用总数或旧 summary 替代。 */
export function assertFixtureSummary(summary, cases) {
  if (summary?.ok !== true || !Array.isArray(summary.cases)) throw new Error('真实 runner 没有返回成功的逐条结果')
  if (summary.passed !== cases.length || summary.failed !== 0 || summary.cases.length !== cases.length) {
    throw new Error('真实 runner 的通过/失败/总数与本次 PM 用例不一致')
  }
  const ids = new Set()
  for (const item of summary.cases) {
    if (ids.has(item?.id)) throw new Error('真实 runner 返回重复用例 ID')
    ids.add(item.id)
    const source = cases.find((test) => test.id === item.id)
    if (source === undefined || item.pass !== true || item.status !== 'passed'
      || JSON.stringify(item.expected) !== JSON.stringify(source.expected)
      || JSON.stringify(item.actual) !== JSON.stringify(source.expected)) {
      throw new Error(`真实 runner 用例 ${String(item.id)} 没有得到本次声明的预期结果`)
    }
  }
  return { cases: [...ids], passed: summary.passed, failed: summary.failed }
}

/** 根据子会话完整 tool/result 读取结构化结果；transport ok 不替代 exitCode。 */
export function selftestResult(event) {
  const message = event?.data?.message
  if (message?.isError === true) return undefined
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const value = parseJsonText(block.text)
    if (value !== null && typeof value === 'object' && typeof value.exitCode === 'number') return value
  }
  return undefined
}

/** 只按真实调用顺序定位成功自测之后的产品写入；缺失结果视为无法证明未修改。 */
export function untestedProductWrites(records, callId, worktree) {
  const events = records.map(eventOf)
  const after = callId === undefined ? -1 : events.findIndex((event) => event?.type === 'tool/result'
    && (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === callId)
  if (after < 0 && callId !== undefined) throw new Error('找不到自测结果在子会话里的位置')
  const results = new Map(events.filter((event) => event?.type === 'tool/result')
    .map((event) => [event.data?.message?.source?.callId ?? event.data?.message?.toolCallId, event.data?.message]))
  const changed = []
  for (const event of events.slice(after + 1)) {
    if (event?.type !== 'tool/call' || !['write', 'edit'].includes(event.data?.name)) continue
    const args = parseJsonText(event.data.arguments)
    if (typeof args?.file_path !== 'string') throw new Error('自测后写入工具缺少可识别路径')
    const target = path.resolve(worktree, args.file_path)
    const rel = path.relative(worktree, target).split(path.sep).join('/')
    if (rel !== 'package.json' && !rel.startsWith('src/')) continue
    if (results.get(event.data.callId)?.isError === true) continue
    changed.push({ callId: event.data.callId, tool: event.data.name, path: rel })
  }
  return changed
}

/** 配对工具调用与结果；返回原始事件，供宿主证据合同校验，不从摘要猜成功。 */
export function selftestCalls(records) {
  const events = records.map(eventOf)
  const calls = events.filter((event) => event?.type === 'tool/call' && event.data?.name === 'takt_selftest')
  return calls.map((call) => {
    const result = events.find((event) => event?.type === 'tool/result'
      && (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === call.data.callId)
    return { callId: call.data.callId, args: parseJsonText(call.data.arguments), call, result,
      value: result === undefined ? undefined : selftestResult(result),
      text: contentText(result?.data?.message?.content ?? []),
    }
  })
}

/** 主脚本在节点结束后调用；核对真实工具结果、精确证据版本及调用先后，任一缺失即失败。 */
export async function verifySelftests({ home, requirementId, runId, implement, worktree,
  traces, events, cases, readArtifact, expectedScriptsHash }) {
  const primary = traces.filter((trace) => trace.runId === runId && trace.nodeId === 'implement'
    && trace.role === 'dev' && trace.attempt === implement?.attempts && trace.status === 'completed')
  if (primary.length !== 1) throw new Error('找不到本次 implement 最终尝试的唯一真实 dev 追溯')
  const checked = []
  const relevant = [...primary, ...traces.filter((trace) => trace.runId === runId && trace.nodeId === 'review-code'
    && trace.role === 'dev' && trace.status === 'completed')]
  for (const trace of relevant) {
    if (trace.profile?.readOnly !== false) throw new Error('自测调用者没有可写角色身份')
    const records = await readSessionRecords(home, trace.sessionId)
    if (records.length === 0) throw new Error('自测子会话没有可读日志')
    // 评审作者只回复意见、没有改产品时不要求执行一次无关测试。
    if (trace.nodeId === 'review-code' && untestedProductWrites(records, undefined, worktree).length === 0) continue
    const calls = selftestCalls(records)
    const selected = calls.at(-1)
    if (selected?.value === undefined) throw new Error('最终自测没有配对的结构化工具结果')
    const result = selected.value
    if (!trace.tools?.some((tool) => tool.name === 'takt_selftest' && tool.ok === true)) {
      throw new Error('AgentTrace 没有记录本次成功返回的 takt_selftest')
    }
    if (result.exitCode !== 0 || result.succeeded !== true || result.timedOut !== false
      || result.cancelled !== false || result.trusted !== true || result.scriptsChanged !== false) {
      throw new Error('最终 selftest 未真实通过，或发生超时/取消/命令脚本变化')
    }
    if ((selected.args?.mode ?? 'all') !== 'all' || result.filter?.mode !== 'all'
      || Object.keys(selected.args ?? {}).some((key) => key !== 'mode')) {
      throw new Error('本次完整验收需要全量自测，不能用过滤子集或模型命令参数替代')
    }
    if (!['quick-fix', 'package-script'].includes(result.commandSource) || result.command !== 'npm test'
      || result.commandHash !== createHash('sha256').update('npm test').digest('hex')) {
      throw new Error('自测命令没有来自原样 quick-fix 的可信 npm test')
    }
    if (typeof result.outputTail !== 'string' || Buffer.byteLength(result.outputTail, 'utf8') > 8192) {
      throw new Error('自测输出不是受限的真实尾部')
    }
    const report = lastJsonLine(result.outputTail)
    const summary = assertFixtureSummary(report, cases)
    for (const key of ['passed', 'failed']) {
      if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || result[key] !== summary[key])) {
        throw new Error(`工具 ${key} 计数与实际逐条结果不一致`)
      }
    }
    const ref = result.evidence
    if (ref?.workspace !== requirementId || !/^tasks\/selftest-[A-Za-z0-9_.-]+\.json$/.test(ref.path)
      || !Number.isSafeInteger(ref.version) || ref.version < 1) {
      throw new Error('自测未返回当前需求 tasks 下的精确证据版本；不能用 gate evidence 替代')
    }
    const proof = JSON.parse(await readArtifact(ref))
    if (proof.schemaVersion !== 1 || proof.runId !== runId || proof.nodeId !== trace.nodeId
      || proof.attempt !== trace.attempt || proof.sessionId !== trace.sessionId
      || proof.requirementId !== requirementId || proof.role !== 'dev') {
      throw new Error('自测证据身份与真实 run/node/attempt/session 不一致')
    }
    for (const key of ['exitCode', 'succeeded', 'passed', 'failed', 'durationMs', 'startedAt', 'endedAt', 'command', 'commandHash',
      'timedOut', 'cancelled', 'trusted', 'scriptsChanged', 'outputTail']) {
      if (proof[key] !== result[key]) throw new Error(`精确证据与工具结果的 ${key} 不一致`)
    }
    if (proof.source !== result.commandSource || proof.packageScriptsHash !== expectedScriptsHash
      || JSON.stringify(proof.filter) !== JSON.stringify(result.filter)) {
      throw new Error('自测证据没有对应本次冻结的命令来源、package scripts 或过滤范围')
    }
    const start = Date.parse(result.startedAt), end = Date.parse(result.endedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
      || !Number.isFinite(result.durationMs) || result.durationMs < 0
      || start < Date.parse(trace.startedAt) || end > Date.parse(trace.endedAt)) {
      throw new Error('自测执行时序不在本次真实子会话内')
    }
    const mutations = untestedProductWrites(records, selected.callId, worktree)
    if (mutations.length > 0) throw new Error(`自测后又修改产品且没有重新自测：${JSON.stringify(mutations)}`)
    const started = events.find((event) => event.runId === runId && event.nodeId === trace.nodeId
      && event.type === 'harness.started' && event.data?.sessionId === trace.sessionId)
    if (started === undefined) throw new Error('自测子会话没有对应 harness.started 事件')
    let completion
    if (trace.nodeId === 'implement') {
      completion = events.filter((event) => event.nodeId === 'implement' && event.type === 'node.checks'
        && event.seq > started.seq && event.data?.unmet?.length === 0
        && event.data?.checks?.length > 0 && event.data.checks.every((item) => item.pass === true)).at(-1)
      if (completion === undefined || end > Date.parse(completion.ts)) {
        throw new Error('实现完成标准没有在真实自测之后通过')
      }
      const direct = completion.data.checks.some((item) => typeof item.evidence === 'string' && item.evidence.includes(ref.path))
      const taskRef = implement.outputs?.find((item) => item.path === 'tasks/change.md')
      const note = taskRef === undefined ? '' : await readArtifact(taskRef)
      if (!direct && !note.includes(ref.path)) throw new Error('实现完成说明或任务产物没有引用本次精确自测证据')
    }
    checked.push({ sessionId: trace.sessionId, nodeId: trace.nodeId, attempt: trace.attempt, callId: selected.callId,
      artifact: ref, source: proof.source, commandHash: result.commandHash, startedAt: result.startedAt,
      endedAt: result.endedAt, durationMs: result.durationMs, exitCode: result.exitCode, succeeded: result.succeeded, ...summary,
      toolCounts: { passed: result.passed ?? null, failed: result.failed ?? null },
      harnessStartedSeq: started.seq, completionSeq: completion?.seq ?? null, productWritesAfter: 0 })
  }
  return { source: '真实 AgentTrace + 子会话工具结果 + 精确任务证据', executions: checked }
}

/** 只解析真实回复中的 JSON 对象；兼容纯 JSON 和最终 Markdown JSON 代码块。 */
function reviewValues(text) {
  const candidates = [parseJsonText(text)]
  for (const match of String(text ?? '').matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(parseJsonText(match[1].trim()))
  return candidates.filter((value) => value !== null && typeof value === 'object'
    && ['approve', 'request_changes', 'reject'].includes(value.verdict)
    && typeof value.summary === 'string' && Array.isArray(value.issues))
}

/** 只去掉 core 后补的问题标识；模型提交的所有评审字段仍逐项比较。 */
function reviewContent(value) {
  const issueKeys = ['id', 'severity', 'location', 'title', 'category', 'description', 'suggestion']
  return {
    verdict: value.verdict,
    summary: value.summary,
    ...(value.score === undefined ? {} : { score: value.score }),
    issues: value.issues.map((issue) => Object.fromEntries(issueKeys.filter((key) => issue[key] !== undefined).map((key) => [key, issue[key]]))),
  }
}

/** 清理之前采集同一持久化子会话的回答，保留原始调用/结果和解析值供失败诊断。 */
export async function collectReviewResponse(home, sessionId) {
  const records = await readSessionRecords(home, sessionId)
  const events = records.map(eventOf)
  const structuredCalls = []
  for (const [index, call] of events.entries()) {
    if (call?.type !== 'tool/call' || call.data?.name !== 'structured_output') continue
    const callId = call.data.callId
    const later = events.slice(index + 1)
    const nextSameCall = later.findIndex((event) => event?.type === 'tool/call' && event.data?.callId === callId)
    const window = nextSameCall < 0 ? later : later.slice(0, nextSameCall)
    const result = window.find((event) => event?.type === 'tool/result'
      && (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === callId)
    const raw = call.data.arguments
    const parsed = typeof raw === 'string' ? parseJsonText(raw) : raw
    structuredCalls.push({ callId, call, result: result ?? null, parsed: parsed ?? null })
  }
  const assistant = events.filter((event) => event?.type === 'assistant/message').map((event) => {
    const text = contentText(event.data?.message?.content ?? event.data?.content ?? [])
    return { event, text, parsed: reviewValues(text) }
  })
  return { sessionId, eventCount: events.length, structuredCalls, assistant }
}

/** 原生 structured_output 必须有对应成功回执；最终评审内容必须和精确版本产物一致。 */
export function assertReviewResponse(observation, { sessionId, expected }) {
  if (observation?.sessionId !== sessionId || observation.eventCount < 1) throw new Error('评审回答不属于预期子会话，或子会话日志缺失')
  const same = (value) => value !== null && typeof value === 'object'
    && ['approve', 'request_changes', 'reject'].includes(value.verdict)
    && typeof value.summary === 'string' && Array.isArray(value.issues)
    && JSON.stringify(reviewContent(value)) === JSON.stringify(reviewContent(expected))
  if (observation.structuredCalls.length > 0) {
    const submitted = observation.structuredCalls.at(-1)
    const message = submitted.result?.data?.message
    const ids = [message?.source?.callId, message?.toolCallId].filter((id) => typeof id === 'string')
    if (!submitted.callId || !message || ids.length === 0 || ids.some((id) => id !== submitted.callId)
      || message.isError === true) throw new Error('structured_output 没有同 callId 的成功工具结果')
    const texts = (Array.isArray(message.content) ? message.content : []).filter((block) => block?.type === 'text').map((block) => block.text)
    const acknowledged = texts.some((text) => text.trim() === 'Structured output recorded.' || parseJsonText(text)?.recorded === true)
    if (!acknowledged) throw new Error('structured_output 结果没有官方 recorded 成功回执')
    if (!same(submitted.parsed)) throw new Error('structured_output 提交的 verdict/summary/issues 与精确评审产物不一致')
    return { source: 'structured_output', callId: submitted.callId, sessionId, parsed: submitted.parsed }
  }
  const values = observation.assistant.flatMap((item) => item.parsed)
  const value = values.at(-1)
  if (!same(value)) throw new Error('普通文本 JSON 回答的 verdict/summary/issues 与精确评审产物不一致')
  return { source: 'assistant-json', sessionId, parsed: value }
}
