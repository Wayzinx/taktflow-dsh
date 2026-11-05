#!/usr/bin/env node
/**
 * 在 dsh 的 Remote Event WebSocket 上模拟浏览器回答 taktflow 审批卡片。
 *
 * 为什么单独成进程：ws 模块只存在于 dsh 的 app.asar 里，普通 Node 读不了；
 * 由 e2e/p0.mjs 用 Electron 的 ELECTRON_RUN_AS_NODE 模式启动本文件，再用
 * createRequire 从 gateway 包位置解析 ws。协议本身不自己实现。
 *
 * 输入（只从环境变量读，避免把 cookie 放进 argv）：
 * - TAKT_E2E_WS_BASE_URL：Host 根地址，例如 http://127.0.0.1:PORT/
 * - TAKT_E2E_WS_COOKIE：/connect?interactions=answer 换到的 v2 cookie
 * - TAKT_E2E_WS_GATEWAY_DIR：dsh-api-gateway 包目录（用于解析 ws）
 * - TAKT_E2E_WS_REQUEST_ID：待回答的 requestId
 * - TAKT_E2E_WS_SESSION_ID：期望的 Lead 会话 id；卡片 agentId 不一致时拒绝回答
 * - TAKT_E2E_WS_APPROVE_LABEL：批准选项文案，默认“批准”
 * - TAKT_E2E_WS_TIMEOUT_MS：等待卡片和回答的超时，默认 120000
 *
 * 输出：stdout 一行 JSON（脱敏，不含 cookie/地址）。退出码 0 表示已回答；
 * 2 表示超时；1 表示协议/连接错误。失败原因只写错误信息，不打印凭据。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const baseUrl = process.env.TAKT_E2E_WS_BASE_URL ?? ''
const cookie = process.env.TAKT_E2E_WS_COOKIE ?? ''
const gatewayDir = process.env.TAKT_E2E_WS_GATEWAY_DIR ?? ''
const requestId = process.env.TAKT_E2E_WS_REQUEST_ID ?? ''
const sessionId = process.env.TAKT_E2E_WS_SESSION_ID ?? ''
const approveLabel = process.env.TAKT_E2E_WS_APPROVE_LABEL ?? '批准'
const timeoutMs = Number(process.env.TAKT_E2E_WS_TIMEOUT_MS ?? 120_000)

function scrub(text) {
  let value = String(text)
  if (cookie !== '') value = value.split(cookie).join('<redacted>')
  if (baseUrl !== '') value = value.split(baseUrl).join('<host>')
  return value.replace(/([?&]token=)[^&\s"'<>]+/gi, '$1<redacted>')
}

function finish(code, payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
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

async function main() {
  if (baseUrl === '' || cookie === '' || requestId === '' || sessionId === '') {
    throw new Error('缺少 TAKT_E2E_WS_BASE_URL / TAKT_E2E_WS_COOKIE / TAKT_E2E_WS_REQUEST_ID / TAKT_E2E_WS_SESSION_ID')
  }
  const WebSocket = loadWebSocket()
  const url = new URL('api/remote.mux', directoryUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const streamId = randomUUID()
  const ws = new WebSocket(url, { headers: { cookie } })
  let clientId
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    try { ws.close() } catch { /* 已断开 */ }
    finish(2, { ok: false, timeout: true, requestId, clientId })
  }, timeoutMs)
  timer.unref?.()

  const fail = (error, extra = {}) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try { ws.close() } catch { /* 已断开 */ }
    finish(1, {
      ok: false,
      requestId,
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
      clientId = value.clientId
      return
    }
    if (value?.type === 'cancel' && value.eventId !== undefined) return
    if (value?.type !== 'waterfall' || value.event !== 'user-questions/request') return
    const questions = Array.isArray(value.request?.questions) ? value.request.questions : []
    const question = questions.find((item) => item?.id === requestId)
    if (question === undefined) return

    // 只回答本次 Lead 会话的卡片；别的会话/Agent 的 requestId 撞车也不能代答。
    if (value.agentId !== sessionId) {
      return fail(new Error(`卡片 agentId 与期望会话不一致：${String(value.agentId)}`), {
        agentMismatch: true,
        agentId: value.agentId,
      })
    }

    const labels = Array.isArray(question.options)
      ? question.options.map((option) => option?.label).filter((label) => typeof label === 'string')
      : []
    if (!labels.includes(approveLabel)) {
      return fail(new Error(`审批卡片没有“${approveLabel}”选项：${labels.join('、')}`))
    }

    // 先记录卡片内容，再回答；父进程据此断言卡片确实来自待审产物。
    const card = {
      ok: true,
      answered: true,
      requestId,
      agentId: value.agentId,
      header: question.header ?? null,
      question: question.question ?? null,
      detail: question.detail ?? null,
      options: labels,
      selected: approveLabel,
      clientId,
    }
    rpc('$events/result', {
      clientId,
      eventId: value.eventId,
      outcome: { kind: 'result', value: { answers: [{ id: requestId, selected: [approveLabel] }] } },
    }).then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 给 Host 一点时间把答案交回 waterfall；然后关闭连接。
      setTimeout(() => {
        try { ws.close() } catch { /* 已断开 */ }
        finish(0, card)
      }, 250).unref?.()
    }, (error) => fail(error))
  })
}

main().catch((error) => {
  finish(1, { ok: false, error: scrub(error instanceof Error ? error.message : error) })
})
