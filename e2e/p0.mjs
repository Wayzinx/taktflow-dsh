#!/usr/bin/env node
/**
 * P0 端到端：在隔离 DSH_HOME 的 web profile 里，用真实模型跑完整交付流程。
 *
 * 运行（模型地址/key 只从进程环境读取）：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/p0.mjs
 *
 * 流程：准备隔离 profile → 启动 dsh → 页面认证 → 以 taktflow preset 创建会话
 * → 自然语言让 Lead 初始化/建需求/启动 P0 → 等人工审批 → 模拟问题卡片回答
 * （失败时用面板同款写接口，并如实记录）→ 等运行结束 → 断言产物、代码改动、
 * 测试、审计、面板、通知和 Lead 工具指标 → 停止进程、清理临时目录。
 *
 * 结果写到 e2e/out/p0-result.json（已 gitignore），只保留脱敏信息。任何阶段
 * 失败也会写结果；默认总超时 20 分钟，可用 TAKT_E2E_P0_TIMEOUT_MS 覆盖。
 *
 * 判定原则：任何 check fail / not-run 都让进程非零退出；通知只认真实会话里
 * agent/inbox/spliced + user/message 的投递证据，状态快照只作诊断。
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost } from './boot.mjs'
import { computeMetrics, createCheckList, notificationEvidence, verdictOf } from './checks.mjs'
import {
  CookieJar,
  assertOwnedHome,
  cleanupOwnedHome,
  contentText,
  eventOf,
  extractBootPayload,
  fetchWithJar,
  findBootEntries,
  isDirectRun,
  outDir,
  packageRoot,
  poll,
  readSessionRecords,
  requireEnv,
  resolveDshBin,
  resolveE2eHome,
  rpcCall,
  runCommand,
  sanitize,
  writeJson,
} from './lib.mjs'

const CHECK_NAMES = [
  'profile',
  'startup-url',
  'page-auth',
  'answer-cookie',
  'boot-payload',
  'client-bundle',
  'ping',
  'session-create',
  'session-prompt',
  'lead-init',
  'lead-create',
  'start-followup',
  'lead-start',
  'run-waiting-human',
  'approval-card',
  'run-succeeded',
  'artifacts',
  'dev-change',
  'tests-pass',
  'trace-audit',
  'panel-reads',
  'notifications',
  'lead-metrics',
  'process-stop',
  'home-cleanup',
]

const DEFAULT_P0_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_WS_TIMEOUT_MS = 120 * 1000
const DEMO_DIR_NAME = 'p0-demo'
const APPROVE_NODE = 'approve-design'
const APPROVE_VIA = { card: 'dsh:user-questions', panel: 'dsh-web' }

const PROMPT = [
  '这个目录还不是 taktflow 空间，帮我初始化，然后建一个需求：给 src/add.js 增加 sub(a, b) 函数并补上测试。',
  '创建成功后不要停，直接启动 P0 交付流程；设计写好后先让我审批，不要自己批准。',
].join('')

const FOLLOWUP_PROMPT = '需求已经建好了，请继续启动 P0 交付流程。'

const INITIAL_ADD = [
  "'use strict'",
  '',
  'function add(a, b) {',
  '  return a + b',
  '}',
  '',
  'module.exports = { add }',
  '',
].join('\n')

const INITIAL_ADD_TEST = [
  "'use strict'",
  '',
  "const test = require('node:test')",
  "const assert = require('node:assert/strict')",
  "const { add } = require('./add.js')",
  '',
  "test('add 返回两数之和', () => {",
  '  assert.equal(add(2, 3), 5)',
  '})',
  '',
].join('\n')

function currentSecrets() {
  return [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY]
}

function apiUrl(base, endpoint) {
  const url = new URL(base)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL(endpoint, url)
}

function remaining(deadline) {
  return Math.max(1, deadline - Date.now())
}

function parseJsonText(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function lastJsonLine(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = parseJsonText(trimmed)
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return parsed
  }
  return undefined
}

/** 子 Agent 会话日志里的业务结果：render 的两个 text block，第二个是完整 JSON。 */
function toolResultInfo(event) {
  const data = event?.data ?? {}
  const message = data.message ?? {}
  const content = Array.isArray(message.content) ? message.content : []
  let business
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const parsed = parseJsonText(block.text.trim())
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object'
      && !Array.isArray(parsed) && typeof parsed.ok === 'boolean') {
      business = parsed
      break
    }
  }
  return {
    callId: message?.source?.callId ?? message?.toolCallId,
    isError: message?.isError === true,
    text: contentText(content),
    business,
  }
}

/** 把会话日志整理成调用、结果、用户/助手文本；形状不认识的记录直接跳过。 */
function buildDigest(records) {
  const events = records.map(eventOf).filter((event) => event !== null && typeof event === 'object')
  const calls = []
  const results = new Map()
  const userTexts = []
  const assistantTexts = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      calls.push({
        callId: data.callId,
        name: data.name,
        args: parseJsonText(data.arguments) ?? {},
        turn: data.turn,
        step: data.step,
      })
    } else if (event.type === 'tool/result') {
      const info = toolResultInfo(event)
      if (typeof info.callId === 'string' && info.callId !== '') results.set(info.callId, info)
    } else if (event.type === 'user/message') {
      const text = contentText(event.data?.content ?? event.data?.message?.content ?? [])
      if (text !== '') userTexts.push(text)
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content ?? event.data?.content ?? [])
      if (text !== '') assistantTexts.push(text)
    }
  }
  return { events, calls, results, userTexts, assistantTexts }
}

/** 在会话里找第一个业务成功、且满足 match 的 takt_* 调用。 */
function successfulCall(digest, { name, action, match }) {
  for (const call of digest.calls) {
    if (call.name !== name) continue
    if (action !== undefined && call.args.action !== action) continue
    const info = digest.results.get(call.callId)
    if (info === undefined || info.isError === true) continue
    if (info.business?.ok !== true) continue
    if (match !== undefined && !match(info.business)) continue
    return { call, info }
  }
  return undefined
}

function deriveElectronPath(dshBin) {
  return path.resolve(path.dirname(dshBin), '../../../../MacOS/DeepSeek Harness')
}

function deriveGatewayDir(dshBin) {
  return path.join(
    path.resolve(path.dirname(dshBin), '../../../app.asar'),
    'dsh/node_modules/@deepseek-ai/dsh-api-gateway',
  )
}

/** 读取 run 的事件链；dev 归因需要 harness.started 的 child sessionId。 */
async function readRunEvents(demoDir, runId) {
  const file = path.join(demoDir, '.takt', 'runs', runId, 'events.jsonl')
  const text = await readFile(file, 'utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      throw new Error(`运行事件日志损坏：${path.basename(file)}`)
    }
  }
  return events
}

/**
 * dev 归因：implement 节点的 harness.started → child sessionId → 该 child 的
 * write/edit 成功调用 → file_path 解析到演示项目的 src/add.js 与测试文件。
 * 只比对文件内容不能证明是 dev 角色改的。
 */
async function assertDevAttribution({ home, demoDir, runId }) {
  const events = await readRunEvents(demoDir, runId)
  const starts = events.filter((event) => event?.type === 'harness.started'
    && event?.nodeId === 'implement'
    && typeof event?.data?.sessionId === 'string'
    && event.data.sessionId !== '')
  if (starts.length === 0) throw new Error('运行事件中没有 implement 节点的 harness.started，无法归因到 dev 子会话')
  const childSessionId = starts.at(-1).data.sessionId
  const records = await readSessionRecords(home, childSessionId)
  if (records.length === 0) throw new Error(`implement 子会话没有可读日志：${childSessionId}`)
  const digest = buildDigest(records)
  const targets = ['src/add.js', 'src/add.test.js']
  const edits = []
  for (const call of digest.calls) {
    if (call.name !== 'write' && call.name !== 'edit') continue
    const filePath = call.args?.file_path
    if (typeof filePath !== 'string' || filePath === '') continue
    const relative = path.relative(demoDir, path.resolve(demoDir, filePath)).split(path.sep).join('/')
    if (!targets.includes(relative)) continue
    const info = digest.results.get(call.callId)
    edits.push({
      tool: call.name,
      path: relative,
      callId: call.callId,
      ok: info !== undefined && info.isError !== true,
    })
  }
  const covered = new Set(edits.filter((edit) => edit.ok).map((edit) => edit.path))
  const missing = targets.filter((target) => !covered.has(target))
  if (missing.length > 0) {
    throw new Error(`implement 子会话 ${childSessionId} 没有成功写入 ${missing.join('、')}；已观察到 ${JSON.stringify(edits)}`)
  }
  return { nodeId: 'implement', childSessionId, edits }
}

function parsePassCount(text) {
  const match = /(?:#|ℹ)\s*pass\s+(\d+)/i.exec(text)
  return match === null ? null : Number(match[1])
}

function parseFailCount(text) {
  const match = /(?:#|ℹ)\s*fail\s+(\d+)/i.exec(text)
  return match === null ? null : Number(match[1])
}

function scrubText(value, context) {
  let text = sanitize(String(value), context.secrets)
  for (const [needle, replacement] of [
    [context.user, '<user>'],
    [context.home, '<e2e-home>'],
    [context.demoDir, '<demo-project>'],
    [context.workspace, '<workspace>'],
    [context.packageRoot, '<repo>'],
  ]) {
    if (typeof needle === 'string' && needle !== '') text = text.split(needle).join(replacement)
  }
  // 兜底：任何漏网的本机绝对路径都不进结果文件。
  text = text.replace(/\/Users\/[^/\s"']+/g, '<home>')
  text = text.replace(/\/private\/(?:var|tmp)\/[\w./-]+/g, '<tmp>')
  text = text.replace(/\/var\/folders\/[\w./-]+/g, '<tmp>')
  return text
}

function scrubValue(value, context) {
  if (typeof value === 'string') return scrubText(value, context)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, context))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, context)]))
  }
  return value
}

async function main() {
  const startedAt = new Date().toISOString()
  const secrets = currentSecrets()
  const result = {
    ok: false,
    startedAt,
    finishedAt: undefined,
    checks: [],
    failed: [],
    sessionId: undefined,
    requirementId: undefined,
    runId: undefined,
    answer: undefined,
    run: undefined,
    artifacts: undefined,
    devChange: undefined,
    notifications: undefined,
    metrics: undefined,
    profile: undefined,
    diagnostics: undefined,
    error: undefined,
    cleanupError: undefined,
  }
  const { checks, failures, mark, step, check } = createCheckList(CHECK_NAMES)
  const context = {
    secrets,
    home: undefined,
    demoDir: undefined,
    workspace: undefined,
    packageRoot,
    user: userInfo().username,
  }
  const diagnostics = {}

  let host
  let home
  let sessionId
  let requirementId
  let runId
  let failure

  const readDigest = async () => {
    if (home === undefined || sessionId === undefined) throw new Error('会话尚未创建')
    return buildDigest(await readSessionRecords(home, sessionId))
  }

  const leadDiagnostics = async () => {
    const digest = await readDigest()
    return {
      assistant: digest.assistantTexts.slice(-2).map((text) => text.slice(0, 1_500)),
      calls: digest.calls.slice(-20).map((call) => {
        const info = digest.results.get(call.callId)
        return {
          name: call.name,
          action: call.args.action ?? null,
          ok: info?.business?.ok ?? null,
          code: info?.business?.error?.code ?? null,
          pending: info === undefined,
        }
      }),
    }
  }

  const writeResult = async () => {
    result.finishedAt = new Date().toISOString()
    result.checks = [...checks.values()]
    const verdict = verdictOf({ failure, failures, checks })
    result.ok = verdict.ok
    result.failed = verdict.failed
    if (result.error === undefined && failures.length > 0) {
      result.error = failures[0] instanceof Error ? failures[0].message : String(failures[0])
    }
    await writeJson(path.join(outDir, 'p0-result.json'), scrubValue(result, context), secrets)
  }

  try {
    await mkdir(outDir, { recursive: true })
    const env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
    const timeoutMs = Number(process.env.TAKT_E2E_P0_TIMEOUT_MS ?? DEFAULT_P0_TIMEOUT_MS)
    const wsTimeoutMs = Number(process.env.TAKT_E2E_WS_TIMEOUT_MS ?? DEFAULT_WS_TIMEOUT_MS)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TAKT_E2E_P0_TIMEOUT_MS 必须是正数')
    if (!Number.isFinite(wsTimeoutMs) || wsTimeoutMs <= 0) throw new Error('TAKT_E2E_WS_TIMEOUT_MS 必须是正数')
    const deadline = Date.now() + timeoutMs

    // dsh 不认 NO_PROXY 网段写法；端点 hostname 和带端口 host 都补进进程环境。
    const endpoint = new URL(env.TAKT_E2E_BASE_URL)
    const noProxyEntries = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    const withEndpointHost = (value) => {
      const entries = noProxyEntries(value)
      for (const host of [endpoint.hostname, endpoint.host]) {
        if (!entries.includes(host)) entries.push(host)
      }
      return entries.join(',')
    }
    const e2eEnv = {
      ...process.env,
      NO_PROXY: withEndpointHost(process.env.NO_PROXY),
      no_proxy: withEndpointHost(process.env.no_proxy),
    }

    // 1. 隔离 profile。默认每次重新构建+安装；TAKT_E2E_REUSE_PROFILE=1 时复用
    //    上次成功的隔离目录，便于反复调试 e2e 本身。
    const statePath = path.join(outDir, 'state.json')
    let state
    const reuse = process.env.TAKT_E2E_REUSE_PROFILE === '1'
    if (reuse) {
      try {
        const candidate = JSON.parse(await readFile(statePath, 'utf8'))
        const candidateHome = path.resolve(candidate.home)
        await assertOwnedHome(candidateHome)
        state = candidate
      } catch {
        state = undefined
      }
    }
    if (state === undefined) {
      await step('profile', async () => {
        await runCommand(process.execPath, [path.join(packageRoot, 'e2e', 'profile.mjs')], {
          env: e2eEnv,
          cwd: packageRoot,
          timeoutMs: 900_000,
          secrets,
          label: 'e2e profile',
        })
        const profileResult = JSON.parse(await readFile(path.join(outDir, 'profile-result.json'), 'utf8'))
        if (profileResult?.ok !== true) throw new Error('profile-result.json 没有 ok=true')
        return { reused: false, steps: profileResult.steps?.length ?? 0 }
      }, (value) => value)
    } else {
      mark('profile', 'pass', { reused: true, steps: 0 })
    }
    state = JSON.parse(await readFile(statePath, 'utf8'))
    home = path.resolve(state.home ?? resolveE2eHome())
    context.home = home
    await assertOwnedHome(home)
    const dshBin = typeof state.dshBin === 'string' && state.dshBin !== ''
      ? state.dshBin
      : await resolveDshBin()
    result.profile = { reused: reuse, model: state.model, profile: state.profile }

    // 2. 演示项目：最小 Node 项目，测试命令是 node --test。
    const workspace = path.join(home, 'workspace')
    context.workspace = workspace
    const demoRaw = path.join(workspace, DEMO_DIR_NAME)
    await mkdir(workspace, { recursive: true })
    await rm(demoRaw, { recursive: true, force: true })
    await mkdir(path.join(demoRaw, 'src'), { recursive: true })
    await writeFile(path.join(demoRaw, 'package.json'), `${JSON.stringify({
      name: DEMO_DIR_NAME,
      private: true,
      version: '1.0.0',
      description: 'taktflow P0 e2e demo',
      scripts: { test: 'node --test' },
    }, null, 2)}\n`, 'utf8')
    await writeFile(path.join(demoRaw, 'src', 'add.js'), INITIAL_ADD, 'utf8')
    await writeFile(path.join(demoRaw, 'src', 'add.test.js'), INITIAL_ADD_TEST, 'utf8')
    const demoDir = await realpath(demoRaw)
    context.demoDir = demoDir

    // 3. 启动 dsh 并完成浏览器同款认证。
    host = await step('startup-url', async () => {
      const started = await startHost({ home, dshBin, env: e2eEnv })
      secrets.push(started.url, new URL(started.url).searchParams.get('token') ?? '')
      return started
    }, () => ({ captured: true }))

    const jar = new CookieJar()
    // /connect?interactions=answer 签发的是单 socket API 操作员 cookie，WS 断开时
    // 该 peer 会被回收；面板请求必须继续用 / 页面签发的浏览器 cookie，不能共用 jar。
    const answerJar = new CookieJar()
    const page = await step('page-auth', async () => {
      const exchanged = await fetchWithJar(
        host.url,
        { headers: { accept: 'text/html' } },
        jar,
        { secrets, label: 'launch-token exchange' },
      )
      const html = await exchanged.response.text()
      if (exchanged.response.status !== 200) {
        throw new Error(`页面 HTTP ${exchanged.response.status}（重定向 ${exchanged.redirects} 次）`)
      }
      if (!/text\/html/i.test(exchanged.response.headers.get('content-type') ?? '')) {
        throw new Error(`页面 Content-Type 不是 HTML：${exchanged.response.headers.get('content-type') ?? 'missing'}`)
      }
      if (!exchanged.redirectStatuses.includes(303)) throw new Error('launch-token 没有经过 303 交换')
      if (exchanged.finalUrl.searchParams.has('token')) throw new Error('重定向后 URL 仍带 token')
      if (jar.size === 0) throw new Error('launch-token 交换后没有拿到 cookie')
      secrets.push(jar.header())
      return {
        html,
        pageUrl: exchanged.finalUrl.href,
        status: exchanged.response.status,
        redirects: exchanged.redirects,
        cookieCount: jar.size,
        cookieHeader: jar.header(),
      }
    }, ({ status, redirects, cookieCount }) => ({ status, redirects, cookieCount }))
    const pageUrl = page.pageUrl

    await step('answer-cookie', async () => {
      const token = new URL(host.url).searchParams.get('token')
      if (token === null || token === '') throw new Error('启动 URL 没有 token')
      const connectUrl = new URL('/connect', pageUrl)
      connectUrl.searchParams.set('token', token)
      connectUrl.searchParams.set('interactions', 'answer')
      const before = answerJar.header()
      const exchanged = await fetchWithJar(
        connectUrl,
        { headers: { accept: 'text/html' } },
        answerJar,
        { secrets, label: 'answer cookie exchange' },
      )
      await exchanged.response.body?.cancel().catch(() => undefined)
      const after = answerJar.header()
      if (after === before) throw new Error('/connect?interactions=answer 没有更新认证 cookie')
      if (exchanged.redirects === 0) throw new Error('/connect 没有返回重定向')
      if (jar.header() !== page.cookieHeader) throw new Error('answer cookie 不应覆盖面板 cookie')
      secrets.push(after)
      return { redirects: exchanged.redirects, redirectStatuses: exchanged.redirectStatuses, cookieCount: answerJar.size }
    }, (value) => value)

    const payload = await step('boot-payload', async () => {
      const value = extractBootPayload(page.html)
      if (!Array.isArray(value?.entries)) throw new Error('__DSH_BOOT__.entries 不是数组')
      if (!Array.isArray(value?.batches)) throw new Error('__DSH_BOOT__.batches 不是数组')
      return value
    }, (value) => ({ entries: value.entries.length, batches: value.batches.length }))

    const clientEntry = await step('client-bundle', async () => {
      const matches = findBootEntries(payload, 'taktflow')
      const selected = matches.find((item) => typeof item.url === 'string' && item.url !== '')
      if (selected === undefined) throw new Error('boot payload 中没有 id=taktflow 的 client 条目')
      const url = new URL(selected.url, pageUrl).href
      const { response, finalUrl } = await fetchWithJar(
        url,
        { headers: { accept: 'text/javascript' } },
        jar,
        { secrets, label: 'client bundle' },
      )
      const body = await response.text()
      if (response.status !== 200) throw new Error(`client bundle HTTP ${response.status}`)
      if (body.length === 0) throw new Error('client bundle 是空响应')
      if (!body.includes('__ModuleLoader__')) throw new Error('client bundle 没有 __ModuleLoader__ 包装')
      if (!/id\s*:\s*["']taktflow["']/.test(body)) throw new Error('client bundle 没有 id=taktflow')
      return { path: finalUrl.pathname, bytes: body.length }
    }, (value) => value)

    const panelRead = async (op, params = {}) => {
      const url = apiUrl(pageUrl, 'api/taktflow')
      url.searchParams.set('space', demoDir)
      url.searchParams.set('p', op)
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
      const { response } = await fetchWithJar(
        url,
        { headers: { accept: 'application/json' } },
        jar,
        { secrets, label: `panel ${op}` },
      )
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`panel ${op} 返回非 JSON（HTTP ${response.status}）`)
      }
      if (!response.ok || body?.ok !== true) {
        const error = new Error(`panel ${op} 失败：HTTP ${response.status} ${body?.error?.code ?? ''}`.trim())
        error.status = response.status
        throw error
      }
      return body.data
    }

    const panelReadSafe = async (op, params = {}) => {
      try {
        return await panelRead(op, params)
      } catch (error) {
        if (error?.status === 400 || error?.status === 404) return undefined
        throw error
      }
    }

    const panelWrite = async (body) => {
      const { response } = await fetchWithJar(
        apiUrl(pageUrl, 'api/taktflow.op'),
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        jar,
        { secrets, label: 'panel write' },
      )
      const text = await response.text()
      return { status: response.status, body: parseJsonText(text) }
    }

    const runDiagnostics = async () => {
      const detail = await panelReadSafe('run', { runId }).catch(() => undefined)
      const report = await panelReadSafe('artifact', { id: requirementId, path: 'reports/test.md' }).catch(() => undefined)
      return {
        status: detail?.run?.status ?? null,
        nodes: Object.fromEntries(Object.entries(detail?.run?.nodes ?? {}).map(([id, node]) => [
          id,
          { status: node.status, attempts: node.attempts, error: node.error ?? null },
        ])),
        report: typeof report?.content === 'string' ? report.content.slice(-1_500) : null,
        lead: await leadDiagnostics().catch(() => undefined),
      }
    }

    const ping = await step('ping', async () => {
      const { response } = await fetchWithJar(
        apiUrl(pageUrl, 'api/taktflow.ping'),
        { headers: { accept: 'application/json' } },
        jar,
        { secrets, label: 'taktflow.ping' },
      )
      const body = JSON.parse(await response.text())
      if (body?.ok !== true) throw new Error('taktflow.ping 没有返回 ok=true')
      if (typeof body.version !== 'string' || body.version === '') throw new Error('taktflow.ping 没有返回 version')
      if (!Array.isArray(body.spaces)) throw new Error('taktflow.ping 没有返回 spaces 数组')
      return { version: body.version, spaces: body.spaces.length }
    }, (value) => value)

    // 4. 以 taktflow preset 创建会话，cwd 就是演示项目根。
    const created = await step('session-create', async () => {
      const value = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/create',
        args: { request: { agentPreset: 'taktflow', cwd: demoDir } },
        jar,
        secrets,
      })
      if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
        throw new Error('session/create 没有返回 sessionId')
      }
      if (value.agentPreset !== undefined && value.agentPreset !== 'taktflow') {
        throw new Error(`session/create 返回的 agentPreset 是 ${String(value.agentPreset)}`)
      }
      sessionId = value.sessionId
      result.sessionId = sessionId
      return { sessionId, agentPreset: value.agentPreset }
    }, (value) => ({ sessionId: value.sessionId, agentPreset: value.agentPreset }))

    await step('session-prompt', async () => {
      const value = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/prompt',
        args: {
          request: {
            requestId: randomUUID(),
            sessionId: created.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: PROMPT }],
          },
        },
        jar,
        secrets,
      })
      if (value?.accepted !== true) throw new Error('session/prompt 没有返回 accepted=true')
      return { accepted: true }
    }, () => ({ accepted: true }))

    // 5. Lead 先初始化空间。面板 ping 的 spaces 是“空间已注册”的权威信号；
    //    JSONL 可能晚写，因此再轮询本次 init 的成功业务结果。
    await step('lead-init', async () => {
      const spaces = await poll(async () => {
        try {
          const { response } = await fetchWithJar(
            apiUrl(pageUrl, 'api/taktflow.ping'),
            { headers: { accept: 'application/json' } },
            jar,
            { secrets, label: 'taktflow.ping (init)' },
          )
          const body = JSON.parse(await response.text())
          if (body?.ok === true && Array.isArray(body.spaces) && body.spaces.includes(demoDir)) return body.spaces
        } catch {
          return undefined
        }
        return undefined
      }, { timeoutMs: Math.min(remaining(deadline), 240_000), intervalMs: 500 })
      if (spaces === undefined) {
        throw new Error(`等待 Lead 初始化空间超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      const found = await poll(async () => {
        try {
          const digest = await readDigest()
          return successfulCall(digest, {
            name: 'takt_requirement',
            action: 'init',
            match: (business) => typeof business.space?.root === 'string' && business.space.root === demoDir,
          })
        } catch {
          return undefined
        }
      }, { timeoutMs: Math.min(remaining(deadline), 90_000), intervalMs: 500 })
      if (found === undefined) {
        throw new Error(`Lead 没有成功的 takt_requirement init 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      await access(path.join(demoDir, 'takt.config.json'))
      for (const role of ['analyst', 'architect', 'dev', 'reporter']) {
        await access(path.join(demoDir, '.takt', 'agents', `${role}.md`))
      }
      return { spaceRegistered: true, roles: 4, initialized: true }
    }, (value) => value)

    // 6. 需求创建。面板列表先出现，再等到与需求 ID 匹配的成功 create 结果，
    //    避免把 JSONL 晚写或首调失败后重试成功误判为全流程失败。
    await step('lead-create', async () => {
      const requirements = await poll(async () => {
        const list = await panelReadSafe('requirements')
        return Array.isArray(list) && list.length > 0 ? list : undefined
      }, { timeoutMs: Math.min(remaining(deadline), 180_000), intervalMs: 500 })
      if (requirements === undefined) {
        throw new Error(`等待需求创建超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      const picked = requirements.find((item) => typeof item?.title === 'string' && /sub|add/i.test(item.title))
        ?? requirements.slice().sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      if (typeof picked?.id !== 'string' || picked.id === '') throw new Error('需求列表没有有效 ID')
      requirementId = picked.id
      result.requirementId = requirementId
      const found = await poll(async () => {
        try {
          const digest = await readDigest()
          return successfulCall(digest, {
            name: 'takt_requirement',
            action: 'create',
            match: (business) => typeof business.requirement?.id === 'string' && business.requirement.id === requirementId,
          })
        } catch {
          return undefined
        }
      }, { timeoutMs: Math.min(remaining(deadline), 90_000), intervalMs: 500 })
      if (found === undefined) {
        throw new Error(`Lead 没有与需求 ${requirementId} 匹配的成功 create 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      return { requirementId, title: picked.title }
    }, (value) => value)

    // 7. 运行启动。模型偶尔会在 create 后结束回合；真实用户会再催一句，
    //    先等 60s，仍未启动就发一条自然语言 follow-up，再等 3 分钟。
    const start = await step('lead-start', async () => {
      const waitForRuns = (timeoutMs) => poll(async () => {
        const list = await panelReadSafe('runs', { requirement: requirementId })
        return Array.isArray(list) && list.length > 0 ? list : undefined
      }, { timeoutMs: Math.min(remaining(deadline), timeoutMs), intervalMs: 500 })

      let runs = await waitForRuns(60_000)
      let nudged = false
      if (runs === undefined) {
        try {
          const accepted = await rpcCall({
            baseUrl: pageUrl,
            method: 'session/prompt',
            args: {
              request: {
                requestId: randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: FOLLOWUP_PROMPT }],
              },
            },
            jar,
            secrets,
          })
          if (accepted?.accepted !== true) throw new Error('启动 follow-up 没有被接受')
          nudged = true
          mark('start-followup', 'pass', { nudged: true, accepted: true })
        } catch (error) {
          mark('start-followup', 'fail', error instanceof Error ? error.message : String(error))
          throw error
        }
        runs = await waitForRuns(180_000)
      } else {
        mark('start-followup', 'pass', { nudged: false })
      }
      if (runs === undefined) {
        throw new Error(`等待运行启动超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      const runEntry = runs.slice().sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      runId = runEntry?.runId
      if (typeof runId !== 'string' || runId === '') throw new Error('运行列表没有 runId')
      result.runId = runId
      const found = await poll(async () => {
        try {
          const digest = await readDigest()
          return successfulCall(digest, {
            name: 'takt_run',
            action: 'start',
            match: (business) => typeof business.runId === 'string' && business.runId === runId,
          })
        } catch {
          return undefined
        }
      }, { timeoutMs: Math.min(remaining(deadline), 90_000), intervalMs: 500 })
      if (found === undefined) {
        throw new Error(`Lead 没有与运行 ${runId} 匹配的成功 start 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      return {
        runId,
        workflow: typeof found.call.args.workflow === 'string' ? found.call.args.workflow : 'p0-delivery',
        nudged,
      }
    }, (value) => value)

    // 8. 等人工审批：run 状态和待办同时到位才算真的卡在审批；待办必须严格
    //    匹配本次 run/需求/节点/form，不能拿别的历史待办回答。
    const approval = await step('run-waiting-human', async () => {
      const found = await poll(async () => {
        const detail = await panelReadSafe('run', { runId })
        const status = detail?.run?.status
        if (status === 'failed' || status === 'cancelled') {
          throw new Error(`运行在审批前结束：${status}`)
        }
        if (status !== 'waiting_human') return undefined
        const pending = await panelReadSafe('attention', { pending: '1' })
        if (!Array.isArray(pending)) return undefined
        const item = pending.find((entry) => entry?.requestId !== undefined
          && entry.runId === runId
          && entry.requirementId === requirementId
          && entry.nodeId === APPROVE_NODE
          && entry.form === 'approve')
        if (item === undefined) return undefined
        return { detail, item }
      }, { timeoutMs: Math.min(remaining(deadline), 600_000), intervalMs: 1_000 })
      if (found === undefined) {
        throw new Error(`等待人工审批超时；诊断：${JSON.stringify(await runDiagnostics().catch(() => undefined))}`)
      }
      const attempt = found.item.attempt ?? found.detail.run?.nodes?.[APPROVE_NODE]?.attempts ?? 0
      const subjects = Array.isArray(found.item.subjects) ? found.item.subjects : []
      const design = subjects.find((subject) => subject?.path === 'design/design.md')
      if (design === undefined) throw new Error('审批待办没有冻结 design/design.md')
      if (!Number.isSafeInteger(design.version) || design.version < 1) {
        throw new Error(`审批待办冻结的 design/design.md 版本不合法：${String(design.version)}`)
      }
      return {
        requestId: found.item.requestId,
        attempt,
        subjects: subjects.map((subject) => ({ path: subject.path, version: subject.version ?? null })),
        runStatus: found.detail.run?.status,
      }
    }, (value) => value)

    // 9. 优先模拟原生问题卡片；失败才走面板写接口，并记录原因。
    const card = await (async () => {
      const electron = deriveElectronPath(dshBin)
      try {
        await access(electron, fsConstants.X_OK)
      } catch {
        return { answered: false, reason: 'Electron 可执行文件不存在，无法使用卡片回答' }
      }
      const helper = fileURLToPath(new URL('./answer-ws.mjs', import.meta.url))
      const childEnv = {
        ...e2eEnv,
        ELECTRON_RUN_AS_NODE: '1',
        TAKT_E2E_WS_BASE_URL: pageUrl,
        TAKT_E2E_WS_COOKIE: answerJar.header(),
        TAKT_E2E_WS_GATEWAY_DIR: deriveGatewayDir(dshBin),
        TAKT_E2E_WS_REQUEST_ID: approval.requestId,
        TAKT_E2E_WS_SESSION_ID: sessionId,
        TAKT_E2E_WS_APPROVE_LABEL: '批准',
        TAKT_E2E_WS_TIMEOUT_MS: String(wsTimeoutMs),
      }
      try {
        const { stdout } = await runCommand(electron, [helper], {
          env: childEnv,
          timeoutMs: wsTimeoutMs + 30_000,
          secrets,
          label: '审批卡片 WebSocket',
        })
        const payload = lastJsonLine(stdout)
        if (payload?.ok === true && payload.answered === true) return { answered: true, ...payload }
        return { answered: false, agentMismatch: payload?.agentMismatch === true, agentId: payload?.agentId, reason: payload?.error ?? '卡片回答未确认' }
      } catch (error) {
        const payload = lastJsonLine(error?.stdout ?? '')
        if (error?.code === 2 || payload?.timeout === true) {
          return { answered: false, reason: '等待审批卡片超时' }
        }
        return {
          answered: false,
          agentMismatch: payload?.agentMismatch === true,
          agentId: payload?.agentId,
          reason: payload?.error ?? (error instanceof Error ? error.message : String(error)),
        }
      }
    })()

    const readApproval = async () => {
      const all = await panelReadSafe('attention')
      if (!Array.isArray(all)) return undefined
      return all.find((entry) => entry?.requestId === approval.requestId
        && entry.runId === runId
        && entry.requirementId === requirementId
        && entry.nodeId === APPROVE_NODE
        && entry.form === 'approve')
    }

    let answer
    if (card.answered === true) {
      answer = {
        via: 'card',
        requestId: approval.requestId,
        attempt: approval.attempt,
        card: {
          header: card.header,
          options: card.options,
          agentId: card.agentId,
          detail: card.detail,
          clientId: card.clientId,
        },
      }
      // 拿到卡片结果立即落账；后续读回失败也保留已发送答案。
      result.answer = answer
      await step('approval-card', async () => {
        if (card.header !== 'taktflow 审批') throw new Error(`卡片标题不是 taktflow 审批：${String(card.header)}`)
        if (!Array.isArray(card.options) || !card.options.includes('批准')) {
          throw new Error(`卡片没有“批准”选项：${(card.options ?? []).join('、')}`)
        }
        if (typeof card.detail !== 'string' || !card.detail.includes('design/design.md')) {
          throw new Error('卡片详情没有引用 design/design.md')
        }
        if (card.agentId !== sessionId) throw new Error(`卡片 agentId 与 Lead 会话不一致：${String(card.agentId)}`)
        const answered = await poll(async () => {
          const item = await readApproval()
          return item?.answeredAt === undefined ? undefined : item
        }, { timeoutMs: 30_000, intervalMs: 300 })
        if (answered === undefined) throw new Error('卡片回答后待办没有落账')
        if (answered.requestId !== approval.requestId) throw new Error('卡片回答读回的 requestId 不一致')
        if (answered.runId !== runId || answered.requirementId !== requirementId) throw new Error('卡片回答读回的 run/需求不一致')
        if (answered.attempt !== undefined && answered.attempt !== approval.attempt) {
          throw new Error(`卡片回答读回的 attempt ${String(answered.attempt)} 与待审 ${approval.attempt} 不一致`)
        }
        if (answered.decision !== 'approve') throw new Error(`卡片回答落账为 ${String(answered.decision)}`)
        if (answered.answeredBy?.type !== 'human') throw new Error('卡片回答的 actor 不是 human')
        if (answered.answeredBy?.via !== APPROVE_VIA.card) {
          throw new Error(`卡片回答 via 是 ${String(answered.answeredBy?.via)}，不是 ${APPROVE_VIA.card}`)
        }
        answer.answeredBy = { type: answered.answeredBy.type, via: answered.answeredBy.via }
        result.answer = answer
        return { via: 'card', decision: answered.decision, answeredBy: answer.answeredBy }
      }, (value) => value)
    } else if (card.agentMismatch === true) {
      answer = { via: 'card-rejected', requestId: approval.requestId, attempt: approval.attempt, card }
      result.answer = answer
      await step('approval-card', async () => {
        throw new Error(`审批卡片 agentId 与 Lead 会话不一致：${String(card.agentId)}`)
      })
    } else {
      answer = {
        via: 'panel',
        fallbackReason: card.reason,
        requestId: approval.requestId,
        attempt: approval.attempt,
        cardProbe: { answered: false, reason: card.reason },
      }
      // 面板 fallback 也先把已发送的路径和原因落账。
      result.answer = answer
      await step('approval-card', async () => {
        const written = await panelWrite({
          p: 'attention.answer',
          space: demoDir,
          requestId: approval.requestId,
          attempt: approval.attempt,
          decision: 'approve',
        })
        if (written.body?.ok !== true) {
          const existing = await readApproval()
          if (existing?.answeredAt === undefined) {
            throw new Error(`面板审批失败：HTTP ${written.status} ${written.body?.error?.code ?? ''}`.trim())
          }
        }
        const answered = await poll(async () => {
          const item = await readApproval()
          return item?.answeredAt === undefined ? undefined : item
        }, { timeoutMs: 30_000, intervalMs: 300 })
        if (answered === undefined) throw new Error('面板审批后待办没有落账')
        if (answered.requestId !== approval.requestId) throw new Error('面板审批读回的 requestId 不一致')
        if (answered.runId !== runId || answered.requirementId !== requirementId) throw new Error('面板审批读回的 run/需求不一致')
        if (answered.attempt !== undefined && answered.attempt !== approval.attempt) {
          throw new Error(`面板审批读回的 attempt ${String(answered.attempt)} 与待审 ${approval.attempt} 不一致`)
        }
        if (answered.decision !== 'approve') throw new Error(`面板审批落账为 ${String(answered.decision)}`)
        if (answered.answeredBy?.type !== 'human') throw new Error('面板审批的 actor 不是 human')
        if (answered.answeredBy?.via !== APPROVE_VIA.panel) {
          throw new Error(`面板审批 via 是 ${String(answered.answeredBy?.via)}，不是 ${APPROVE_VIA.panel}`)
        }
        answer.answeredBy = { type: answered.answeredBy.type, via: answered.answeredBy.via }
        result.answer = answer
        return { via: 'panel', decision: answered.decision, answeredBy: answer.answeredBy }
      }, (value) => value)
    }

    // 10. 等运行终态；失败也先写 result.run 供审计。
    const terminal = await step('run-succeeded', async () => {
      const detail = await poll(async () => {
        const value = await panelReadSafe('run', { runId })
        const status = value?.run?.status
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') return value
        return undefined
      }, { timeoutMs: remaining(deadline), intervalMs: 1_000 })
      if (detail === undefined) {
        throw new Error(`等待运行结束超时；诊断：${JSON.stringify(await runDiagnostics().catch(() => undefined))}`)
      }
      result.run = {
        status: detail.run.status,
        startedAt: detail.run.startedAt,
        endedAt: detail.run.endedAt ?? null,
        nodes: Object.fromEntries(Object.entries(detail.run.nodes ?? {}).map(([id, node]) => [
          id,
          { status: node.status, attempts: node.attempts, error: node.error ?? null },
        ])),
      }
      if (detail.run.status !== 'succeeded') {
        throw new Error(`运行结束状态是 ${detail.run.status}；诊断：${JSON.stringify(await runDiagnostics().catch(() => undefined))}`)
      }
      return detail
    }, (value) => ({ status: value.run.status, nodes: Object.keys(value.run.nodes ?? {}).length }))

    // 11. 业务断言。单项失败不阻断其它证据收集，最后统一失败。
    const artifacts = await check('artifacts', async () => {
      const list = await panelReadSafe('artifacts', { id: requirementId })
      if (!Array.isArray(list)) throw new Error('artifacts 没有返回数组')
      const required = ['design/design.md', 'reports/test.md', 'reports/summary.md']
      const found = {}
      for (const artifactPath of required) {
        const record = list.find((item) => item?.path === artifactPath)
        if (record === undefined) throw new Error(`缺少产物 ${artifactPath}`)
        if (!Array.isArray(record.versions) || record.versions.length === 0) {
          throw new Error(`产物 ${artifactPath} 没有版本`)
        }
        found[artifactPath] = record.versions.at(-1)?.version ?? null
      }
      const design = await panelReadSafe('artifact', { id: requirementId, path: 'design/design.md' })
      if (typeof design?.content !== 'string' || design.content.trim() === '') {
        throw new Error('design/design.md 内容为空')
      }
      const test = await panelReadSafe('artifact', { id: requirementId, path: 'reports/test.md' })
      if (typeof test?.content !== 'string' || !test.content.includes('退出码：0')) {
        throw new Error('reports/test.md 没有记录退出码 0')
      }
      const summary = await panelReadSafe('artifact', { id: requirementId, path: 'reports/summary.md' })
      if (typeof summary?.content !== 'string' || summary.content.trim() === '') {
        throw new Error('reports/summary.md 内容为空')
      }
      return { versions: found, designBytes: design.content.length, summaryBytes: summary.content.length }
    }, (value) => value)
    result.artifacts = artifacts

    const devChange = await check('dev-change', async () => {
      // 先归因：run events 的 implement harness.started → child sessionId →
      // child 的 write/edit 成功调用；文件内容只作为附加校验。
      const attribution = await assertDevAttribution({ home, demoDir, runId })
      const addAfter = await readFile(path.join(demoDir, 'src', 'add.js'), 'utf8')
      const testAfter = await readFile(path.join(demoDir, 'src', 'add.test.js'), 'utf8')
      if (addAfter === INITIAL_ADD) throw new Error('src/add.js 没有被 dev 角色修改')
      if (!/\bsub\b/.test(addAfter)) throw new Error('src/add.js 没有 sub')
      if (!/\bsub\b/.test(testAfter)) throw new Error('src/add.test.js 没有补 sub 测试')
      await runCommand(process.execPath, ['-e', [
        "const m = require('./src/add.js')",
        "if (typeof m.sub !== 'function') { console.error('sub 不是函数'); process.exit(3) }",
        "if (m.sub(5, 3) !== 2) { console.error('sub(5,3) 结果错误'); process.exit(4) }",
      ].join(';')], {
        cwd: demoDir,
        env: e2eEnv,
        timeoutMs: 30_000,
        secrets,
        label: 'demo sub smoke',
      })
      return { ...attribution, addBytes: addAfter.length, testBytes: testAfter.length, subWorks: true }
    }, (value) => value)
    result.devChange = devChange

    await check('tests-pass', async () => {
      const testNode = terminal.run.nodes?.test
      if (testNode?.status !== 'succeeded') throw new Error(`test 节点状态是 ${String(testNode?.status)}`)
      const test = await panelReadSafe('artifact', { id: requirementId, path: 'reports/test.md' })
      if (typeof test?.content !== 'string' || !test.content.includes('退出码：0')) {
        throw new Error('测试报告没有记录退出码 0')
      }
      const npm = await runCommand('npm', ['test'], {
        cwd: demoDir,
        env: e2eEnv,
        timeoutMs: 120_000,
        secrets,
        label: 'npm test',
      })
      let passCount = parsePassCount(npm.stdout)
      let failCount = parseFailCount(npm.stdout)
      if (passCount === null) {
        // Node 默认 spec reporter 不输出 TAP；显式换 reporter 再取一次，不伪填。
        const tap = await runCommand('npm', ['test', '--', '--test-reporter=tap'], {
          cwd: demoDir,
          env: e2eEnv,
          timeoutMs: 120_000,
          secrets,
          label: 'npm test (tap)',
        })
        passCount = parsePassCount(tap.stdout)
        failCount = parseFailCount(tap.stdout)
      }
      if (passCount === null) throw new Error('npm test 输出里没有 pass 计数')
      if (failCount !== null && failCount !== 0) throw new Error(`npm test 有 ${failCount} 个失败`)
      if (passCount < 2) throw new Error(`npm test 只通过 ${passCount} 个用例，预期至少 2 个（add + sub）`)
      return {
        nodeStatus: testNode.status,
        reportExitZero: true,
        npmExit: npm.code,
        passCount,
        failCount,
      }
    }, (value) => value)

    await check('trace-audit', async () => {
      // 这是面板 p=audit 的 core events.verify，不是 Lead 的 takt_trace 调用。
      const audit = await panelReadSafe('audit', { runId })
      if (audit?.ok !== true) throw new Error(`事件链校验失败：${String(audit?.reason ?? audit?.brokenAt ?? 'unknown')}`)
      return { source: 'panel', op: 'audit', core: 'events.verify', ok: audit.ok, brokenAt: audit.brokenAt ?? null }
    }, (value) => value)

    await check('panel-reads', async () => {
      const counts = {}
      for (const [op, params] of [
        ['project', {}],
        ['requirements', {}],
        ['runs', {}],
        ['run', { runId }],
        ['attention', {}],
      ]) {
        const data = await panelRead(op, params)
        counts[op] = Array.isArray(data) ? data.length : Object.keys(data ?? {}).length
      }
      return counts
    }, (value) => value)

    // 12. 通知：只认真实会话里 agent/inbox/spliced 插入、且与 user/message.id
    //     配对的本次 REQ/run 消息。状态快照只作诊断，不能兜底 PASS。
    const notifications = await check('notifications', async () => {
      const readEvidence = async () => {
        const records = await readSessionRecords(home, sessionId)
        return notificationEvidence(records, { requirementId, runId })
      }
      const delivered = await poll(async () => {
        const evidence = await readEvidence()
        return evidence.admitted.length > 0 && evidence.terminal ? evidence : undefined
      }, { timeoutMs: Math.min(remaining(deadline), 60_000), intervalMs: 500 })
      const finalEvidence = delivered ?? await readEvidence()
      if (finalEvidence.admitted.length === 0) {
        const snapshot = await readFile(path.join(demoDir, '.takt', 'status', `${requirementId}.json`), 'utf8')
          .then((text) => JSON.parse(text))
          .catch(() => undefined)
        throw new Error([
          'Lead 会话没有消费本次 REQ/run 的通知',
          `queued=${finalEvidence.queued.length}`,
          `admitted=${finalEvidence.admitted.length}`,
          '状态快照只作诊断，不作为会话证据',
          snapshot?.lastMessage === undefined ? '' : `snapshot=${String(snapshot.lastMessage).slice(0, 200)}`,
        ].filter(Boolean).join('；'))
      }
      return {
        source: 'session',
        queued: finalEvidence.queued.length,
        admitted: finalEvidence.admitted.length,
        terminal: finalEvidence.terminal,
        targets: [...new Set(finalEvidence.admitted.map((record) => record.target))],
        samples: finalEvidence.samples,
      }
    }, (value) => ({
      source: value.source,
      queued: value.queued,
      admitted: value.admitted,
      terminal: value.terminal,
    }))
    result.notifications = notifications

    // 13. Lead 工具指标；卡片回答后等待 takt_ask_human 的结果落盘。
    if (answer.via === 'card') {
      await poll(async () => {
        const digest = await readDigest()
        const ask = digest.calls.find((call) => call.name === 'takt_ask_human')
        return ask !== undefined && digest.results.has(ask.callId) ? true : undefined
      }, { timeoutMs: 60_000, intervalMs: 500 })
    }
    const metrics = await check('lead-metrics', async () => {
      const digest = await readDigest()
      const value = computeMetrics(digest)
      const requireSuccessful = (name, action, predicate, label) => {
        const rows = value.calls.filter((row) => row.name === name
          && (action === undefined || row.action === action))
        if (rows.length === 0) throw new Error(`Lead 没有调用 ${label}`)
        if (!rows.some(predicate)) {
          const states = rows.map((row) => row.code ?? (row.pending ? 'pending' : row.isError ? 'isError' : 'unknown'))
          throw new Error(`${label} 没有成功结果：${states.join('、')}`)
        }
      }
      requireSuccessful('takt_status', undefined, (row) => row.ok || row.expectedNoSpace, 'takt_status')
      requireSuccessful('takt_requirement', 'init', (row) => row.ok, 'takt_requirement init')
      requireSuccessful('takt_requirement', 'create', (row) => row.ok, 'takt_requirement create')
      requireSuccessful('takt_run', 'start', (row) => row.ok, 'takt_run start')
      if (answer.via === 'card') {
        requireSuccessful('takt_ask_human', undefined, (row) => row.ok, 'takt_ask_human')
      }
      return value
    }, (value) => ({
      totalCalls: value.totalCalls,
      resolvedCalls: value.resolvedCalls,
      succeededCalls: value.succeededCalls,
      pendingCalls: value.pendingCalls,
      unknownCalls: value.unknownCalls,
      errorCalls: value.errorCalls,
      successRate: value.successRate,
      resolvedSuccessRate: value.resolvedSuccessRate,
      firstCallCorrectByAction: value.firstCallCorrectByAction,
      firstCallCorrectByTool: value.firstCallCorrectByTool,
      firstCallBusinessOkByAction: value.firstCallBusinessOkByAction,
      firstCallBusinessOkByTool: value.firstCallBusinessOkByTool,
    }))
    result.metrics = metrics
  } catch (error) {
    failure = error
    result.error = scrubText(error instanceof Error ? error.stack ?? error.message : String(error), context)
    if (Object.keys(diagnostics).length > 0) result.diagnostics = diagnostics
  } finally {
    // 任何阶段失败都尽量保留已有会话证据；必须在 home 清理前读 JSONL。
    try {
      if (result.metrics === undefined && sessionId !== undefined && home !== undefined) {
        const digest = await readDigest()
        result.metrics = { ...computeMetrics(digest), partial: true }
      }
    } catch {
      // 读取失败不覆盖原始失败。
    }
    try {
      if (result.notifications === undefined && requirementId !== undefined
        && runId !== undefined && sessionId !== undefined && home !== undefined) {
        const evidence = notificationEvidence(
          await readSessionRecords(home, sessionId),
          { requirementId, runId },
        )
        if (evidence.queued.length > 0) {
          result.notifications = {
            source: 'session',
            queued: evidence.queued.length,
            admitted: evidence.admitted.length,
            terminal: evidence.terminal,
            partial: true,
            samples: evidence.samples,
          }
        }
      }
    } catch {
      // 同上。
    }
    try {
      if (host !== undefined) {
        await step('process-stop', () => host.stop(), () => ({ completed: true }))
      }
    } catch (error) {
      result.cleanupError = scrubText(error instanceof Error ? error.message : String(error), context)
      failure ??= error
    }
    try {
      if (home !== undefined) {
        await step('home-cleanup', () => cleanupOwnedHome(home), () => ({ completed: true }))
      }
    } catch (error) {
      result.cleanupError = scrubText(error instanceof Error ? error.message : String(error), context)
      failure ??= error
    }
    try {
      await writeResult()
    } catch (error) {
      failure ??= error
    }
  }

  // 最终成败只看聚合结论：fail / not-run / 显式 failure 都非零退出。
  const verdict = verdictOf({ failure, failures, checks })
  result.ok = verdict.ok
  result.failed = verdict.failed
  if (result.ok !== true) {
    const failed = verdict.failed.map((item) => `${item.name}=${item.status}`).join('，')
    throw failure ?? new Error(`P0 e2e 未通过：${failed}`)
  }
  console.log(`P0 e2e passed: ${result.checks.filter((checkItem) => checkItem.status === 'pass').length}/${CHECK_NAMES.length}`)
  console.log(`结果：${path.relative(packageRoot, path.join(outDir, 'p0-result.json'))}`)
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[e2e:p0] 失败：${sanitize(error instanceof Error ? error.stack ?? error.message : String(error), currentSecrets())}`,
    )
    process.exit(1)
  })
}
