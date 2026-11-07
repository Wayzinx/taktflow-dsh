#!/usr/bin/env node
/**
 * 在 dsh 的 Remote Event WebSocket 上模拟人回答 taktflow 缺陷归因原生卡片。
 *
 * 与 answer-ws.mjs 的区别：归因卡片 id 带候选归因哈希，调用方不可能提前知道
 * 完整 requestId；本helper按 `defect:<REQ>:<D-N>:` 前缀等待，并校验卡片内容
 * 确实来自当前需求/缺陷后才回答。回答仍走 `$events/result`，不是面板写接口。
 *
 * 输入（只从环境变量读，避免 cookie 进 argv）：
 * - TAKT_E2E_WS_BASE_URL / TAKT_E2E_WS_COOKIE / TAKT_E2E_WS_GATEWAY_DIR
 * - TAKT_E2E_WS_SESSION_ID：期望的 Lead 根会话 id；agentId 不一致拒绝回答
 * - TAKT_E2E_DEFECT_REQUIREMENT_ID / TAKT_E2E_DEFECT_ID
 * - TAKT_E2E_DEFECT_CONFIRM_LABEL：默认“确认候选归因”
 * - TAKT_E2E_DEFECT_HASH：确认前持久化候选的完整 SHA256
 * - TAKT_E2E_WS_TIMEOUT_MS：默认 300000
 *
 * 输出：stdout 多行 JSON。第一行 `{type:'ready'}` 表示远端事件订阅和 clientId 已就绪；最后一行是
 * 回答结果或错误。退出码 0 已回答；2 超时；1 协议/校验错误。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { scrubText, scrubValue } from './defect-lib.mjs'

const baseUrl = process.env.TAKT_E2E_WS_BASE_URL ?? ''
const cookie = process.env.TAKT_E2E_WS_COOKIE ?? ''
const gatewayDir = process.env.TAKT_E2E_WS_GATEWAY_DIR ?? ''
const sessionId = process.env.TAKT_E2E_WS_SESSION_ID ?? ''
const requirementId = process.env.TAKT_E2E_DEFECT_REQUIREMENT_ID ?? ''
const defectId = process.env.TAKT_E2E_DEFECT_ID ?? ''
const confirmLabel = process.env.TAKT_E2E_DEFECT_CONFIRM_LABEL ?? '确认候选归因'
const timeoutMs = Number(process.env.TAKT_E2E_WS_TIMEOUT_MS ?? 300_000)
const prefix = `defect:${requirementId}:${defectId}:`
const expectedHash = process.env.TAKT_E2E_DEFECT_HASH ?? ''

function scrub(text) {
  return scrubText(text, { secrets: [cookie, baseUrl, process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY] })
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(scrubValue(payload, { secrets: [cookie, baseUrl, process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY] }))}\n`)
}

function finish(code, payload) {
  write(payload)
  process.exit(code)
}

function loadWebSocket() {
  const attempts = []
  const candidates = []
  if (gatewayDir !== '') candidates.push(path.join(gatewayDir, 'package.json'))
  candidates.push(import.meta.url)
  for (const candidate of candidates) {
    try {
      const require = createRequire(candidate)
      return require('ws')
    } catch (error) {
      attempts.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`无法解析 ws 模块（${attempts.join('；')}）`)
}

function directoryUrl(value) {
  const url = new URL(value)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

async function rpc(method, args) {
  const rpcId = randomUUID()
  const endpoint = new URL(`api/${method}`, directoryUrl(baseUrl))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`RPC ${method} 返回非 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`)
  if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
    throw new Error(`RPC ${method} 响应信封不匹配`)
  }
  if (body.result?.ok !== true) {
    const error = body.result?.error
    throw new Error(`RPC ${method} 失败：${error?.code ?? 'UNKNOWN'} ${error?.message ?? ''}`.trim())
  }
  return body.result.value
}

function validateCard(question) {
  if (question?.header !== 'taktflow 归因确认') {
    throw new Error(`卡片标题不是 taktflow 归因确认：${String(question?.header)}`)
  }
  if (typeof question?.question !== 'string' || !question.question.includes(defectId)) {
    throw new Error(`卡片问题没有指向缺陷 ${defectId}`)
  }
  const detail = typeof question?.detail === 'string' ? question.detail : ''
  const required = [
    `需求：${requirementId}`,
    '引入环节：',
    '漏检环节：',
    '引入证据：',
    '归因哈希：',
  ]
  for (const marker of required) {
    if (!detail.includes(marker)) throw new Error(`卡片缺少归因内容：${marker}`)
  }
  const hash = String(question.id).slice(prefix.length)
  if (!/^[0-9a-f]{12}$/.test(hash)) throw new Error(`卡片 id 的归因哈希不合法：${hash}`)
  if (hash !== expectedHash.slice(0, 12)) throw new Error('卡片归因哈希与确认前持久化候选不一致')
  if (!detail.includes(`归因哈希：${hash}`)) throw new Error('卡片 id 与展示的归因哈希不一致')
  const labels = Array.isArray(question.options)
    ? question.options.map((option) => option?.label).filter((label) => typeof label === 'string')
    : []
  for (const required of [confirmLabel, '修改后确认', '驳回候选']) {
    if (!labels.includes(required)) throw new Error(`卡片没有“${required}”选项：${labels.join('、')}`)
  }
  return { detail, labels, hash }
}

async function main() {
  if (baseUrl === '' || cookie === '' || sessionId === '' || requirementId === '' || defectId === '') {
    throw new Error('缺少 TAKT_E2E_WS_BASE_URL / COOKIE / SESSION_ID / DEFECT_REQUIREMENT_ID / DEFECT_ID')
  }
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('TAKT_E2E_DEFECT_HASH 必须是持久化候选的 SHA256')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TAKT_E2E_WS_TIMEOUT_MS 必须是正数')
  const WebSocket = loadWebSocket()
  const url = new URL('api/remote.mux', directoryUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const streamId = randomUUID()
  const ws = new WebSocket(url, { headers: { cookie } })
  let clientId
  let settled = false
  let answeredId

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    try { ws.close() } catch { /* 已断开 */ }
    finish(2, { ok: false, timeout: true, requirementId, defectId, clientId })
  }, timeoutMs)
  timer.unref?.()

  const fail = (error, extra = {}) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { ws.close() } catch { /* 已断开 */ }
    finish(1, {
      ok: false,
      requirementId,
      defectId,
      clientId,
      ...extra,
      error: scrub(error instanceof Error ? error.message : error),
    })
  }

  ws.on('error', (error) => fail(error))
  ws.on('close', () => {
    if (!settled) fail(new Error('WebSocket 在回答前关闭'))
  })

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
  })

  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      return fail(new Error('WebSocket 收到非 JSON 帧'))
    }
    if (frame?.type === 'error') {
      return fail(new Error(`WebSocket 流错误：${frame.error?.code ?? 'UNKNOWN'} ${frame.error?.message ?? ''}`))
    }
    if (frame?.type === 'end') return fail(new Error('WebSocket 事件流提前结束'))
    if (frame?.type !== 'item') return
    const value = frame.value
    if (value?.type === 'ready') {
      if (typeof value.clientId !== 'string' || !value.clientId) return fail(new Error('远端 ready 缺少 clientId'))
      clientId = value.clientId
      write({ type: 'ready', clientId })
      return
    }
    if (value?.type === 'cancel' && value.eventId !== undefined) return
    if (value?.type !== 'waterfall' || value.event !== 'user-questions/request') return
    const questions = Array.isArray(value.request?.questions) ? value.request.questions : []
    const question = questions.find((item) => typeof item?.id === 'string' && item.id.startsWith(prefix))
    if (question === undefined) return
    if (answeredId !== undefined) return
    if (value.agentId !== sessionId) {
      return fail(new Error(`卡片 agentId 与期望会话不一致：${String(value.agentId)}`), {
        agentMismatch: true,
        agentId: value.agentId,
      })
    }

    let validated
    try {
      validated = validateCard(question)
    } catch (error) {
      return fail(error, { requestId: question.id, header: question.header ?? null })
    }

    answeredId = question.id
    const card = {
      ok: true,
      answered: true,
      transport: 'websocket:$events/result',
      requestId: question.id,
      agentId: value.agentId,
      header: question.header ?? null,
      question: question.question ?? null,
      detail: question.detail ?? null,
      options: validated.labels,
      selected: confirmLabel,
      hash: validated.hash,
      clientId,
    }
    if (!clientId) return fail(new Error('卡片到达时远端 clientId 尚未就绪'))
    rpc('$events/result', {
      clientId,
      eventId: value.eventId,
      outcome: { kind: 'result', value: { answers: [{ id: question.id, selected: [confirmLabel] }] } },
    }).then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 给 Host 一点时间把答案交回 waterfall；然后关闭连接。
      setTimeout(() => {
        try { ws.close() } catch { /* 已断开 */ }
        finish(0, card)
      }, 250).unref?.()
    }, (error) => fail(error, { requestId: question.id }))
  })
}

main().catch((error) => {
  finish(1, { ok: false, error: scrub(error instanceof Error ? error.message : error) })
})
