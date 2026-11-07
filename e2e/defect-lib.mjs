/**
 * M-K 缺陷归因 e2e 的纯辅助逻辑。
 *
 * 只做可离线验证的事情：会话日志整理、面板读写、fixture、脱敏、用量汇总。
 * 断言和流程留在 defect.mjs，避免把“证据采集”和“结论”混在一起。
 */
import { constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  contentText,
  eventOf,
  fetchWithJar,
  readSessionRecords,
  sanitize,
} from './lib.mjs'

export function parseJsonText(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function lastJsonLine(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = parseJsonText(trimmed)
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return parsed
  }
  return undefined
}

export function fileExists(file) {
  return access(file, fsConstants.F_OK).then(() => true, () => false)
}

export async function readJsonFileIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 子 Agent 会话日志里的业务结果：render 的两个 text block，第二个是完整 JSON。 */
export function toolResultInfo(event) {
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

/** 把会话日志整理成调用、结果、用户/助手文本。 */
export function buildDigest(records) {
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
export function successfulCall(digest, { name, action, match }) {
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

/** 只取指定调用结果之后、下一条用户消息之前的回答，避免串到另一个回合。 */
export function assistantTextsAfter(records, callId) {
  const digest = buildDigest(records)
  const index = digest.events.findIndex((event) => {
    if (event?.type !== 'tool/result') return false
    return toolResultInfo(event).callId === callId
  })
  if (index < 0) return []
  const texts = []
  for (const event of digest.events.slice(index + 1)) {
    if (event?.type === 'user/message') break
    if (event?.type !== 'assistant/message') continue
    const text = contentText(event.data?.message?.content ?? event.data?.content ?? [])
    if (text !== '') texts.push(text)
  }
  return texts
}

function apiUrl(base, endpoint) {
  const url = new URL(base)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL(endpoint, url)
}

export async function panelRead({ pageUrl, spaceRoot, jar, secrets, op, params = {} }) {
  const url = apiUrl(pageUrl, 'api/taktflow')
  url.searchParams.set('space', spaceRoot)
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
    error.code = body?.error?.code
    throw error
  }
  return body.data
}

export async function panelReadSafe(options) {
  try {
    return await panelRead(options)
  } catch (error) {
    if (error?.status === 400 || error?.status === 404) return undefined
    throw error
  }
}

export async function postPanel({ pageUrl, spaceRoot, jar, secrets, payload }) {
  const { response } = await fetchWithJar(
    apiUrl(pageUrl, 'api/taktflow.op'),
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ space: spaceRoot, ...payload }),
    },
    jar,
    { secrets, label: `panel write ${payload.p}` },
  )
  const text = await response.text()
  return { status: response.status, body: parseJsonText(text), text: text.slice(0, 2_000) }
}

/**
 * 物料必须经面板 artifact.edit 写入，再从面板和工作区双重回读。
 * 失败就是失败，不回退直接写文件。
 */
export async function ensureArtifact({
  pageUrl, spaceRoot, jar, secrets, requirementId, requirementDir, rel, content, reason,
}) {
  const panel = await postPanel({
    pageUrl,
    spaceRoot,
    jar,
    secrets,
    payload: { p: 'artifact.edit', params: { id: requirementId, path: rel }, body: { content, reason } },
  })
  if (panel.body?.ok !== true) {
    throw new Error(
      `artifact.edit 失败：HTTP ${panel.status} ${panel.body?.error?.code ?? ''} ${panel.body?.error?.message ?? panel.text ?? ''}`.trim(),
    )
  }
  let panelReadback = false
  try {
    const data = await panelRead({ pageUrl, spaceRoot, jar, secrets, op: 'artifact', params: { id: requirementId, path: rel } })
    const readback = typeof data?.content === 'string'
      ? (data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : data.content)
      : undefined
    panelReadback = readback === content
  } catch {
    panelReadback = false
  }
  if (!panelReadback) throw new Error(`artifact.edit 成功但面板内容回读不一致：${rel}`)
  const file = path.join(requirementDir, rel)
  if (!(await fileExists(file)) || (await readFile(file, 'utf8')) !== content) {
    throw new Error(`artifact.edit 成功但工作区文件不一致：${rel}`)
  }
  return { method: 'panel', status: panel.status, panelReadback }
}

/** fixture 配置允许直写隔离空间；只补 quick-fix 需要的最小字段。 */
export function normalizeConfig(config, workflowFile) {
  if (typeof config !== 'object' || config === null) throw new Error('takt.config.json 不是对象')
  if (typeof config.project?.name !== 'string' || config.project.name === '') {
    config.project = { ...(config.project ?? {}), name: 'taktflow-mk-defect-e2e' }
  }
  if (!Array.isArray(config.workflows)) config.workflows = []
  if (!config.workflows.includes(workflowFile)) config.workflows.push(workflowFile)
  config.autonomy = 'full'
  const repos = Array.isArray(config.repos) ? config.repos : []
  const next = repos.filter((repo) => repo?.id !== 'app')
  next.push({ id: 'app', path: 'app', defaultBranch: 'main', purpose: 'app', description: 'M-K e2e 临时 app fixture' })
  config.repos = next
  return config
}

/** T1 只提供原始需求与既有测试入口合同；spec/cases 由真实 PM 生成。 */
export const QUICK_REQUEST = `# 用户原始需求：价格含税展示

请在 app/src/price.js 新增 formatPriceWithTax(cents, rate)，按分计算税后金额，
四舍五入到分后复用现有 formatPrice 输出；保持 formatPrice/parsePrice 的实现与既有行为，不修改测试程序。
PM 必须在本轮 spec 中列出以下 AC，并为每个明确输入/预期生成实际 cases：
- AC-1：formatPriceWithTax(10000, 0.06) === '¥106.00'。
- AC-2：formatPriceWithTax(0, 0.06) === '¥0.00'。
- AC-3：既有 formatPrice 行为保持：formatPrice(1234) === '¥12.34'，formatPrice(-1234) === '-¥12.34'；两项都要有用例。
- AC-4：既有 parsePrice 行为保持：parsePrice('¥12.34') === 1234，parsePrice('¥0.00') === 0；两项都要有用例。
这是小范围改动，不引入既有函数的其他行为变更。

初始仓库只有下面的通用测试 runner，没有另一套独立回归 suite，也没有预先执行的回归证据。
既有行为的回归必须由 PM 在本轮生成上述四项 baseline 用例，并由同一固定 runner 实际执行。
不要把代码未变当成回归已执行，也不要要求或声称存在未提供的额外测试 suite；未执行就如实标明。

## 既有测试程序的输入合同

- PM 必须自己编写 spec/quick.md 和 cases/<id>.json，包含明确的 AC 与真实用例；不要声称已经运行测试。
- 每个用例是一份 JSON 对象：id 是以 TC- 开头的大写字母/数字/连字符标识，文件名与 id 相同；
  covers 是非空字符串数组，条目为 spec 中的 AC 编号；input 包含 fn（产品模块导出函数名）
  与 args（参数数组）；expected 是实际预期值。不要改用中文字段，也不要把 covers 写成字符串。
- 例如接口形状是 {"id":"TC-EXAMPLE","covers":["AC-1"],"input":{"fn":"函数名","args":[]},"expected":"预期值"}；
  这只是格式说明，不是可直接使用的用例。请按上面的需求填真实函数、参数、预期。
- 用例放在需求公共目录 cases/ 下，不使用子目录；固定 runner 从 TAKT_WORKSPACE/cases 读取全部用例。
- app 的 npm test 已固定为 node tests/run.mjs，不能修改 package.json 或 runner 来让结果变绿。
- 开发角色在完成前调用受控 takt_selftest 真实自测，并在 tasks/change.md 引用宿主返回的证据；
  无工具、命令失败或证据不可读就如实报告，不得用静态验算替代自测。
- TAKT_SELFTEST=1 时 runner 仅输出真实 JSON 结果，不写公共 evidence；正式 delivery-check 执行
  npm test 时，runner 会写 evidence/summary.json 以及 evidence/<CaseID>/result.json。
`

const APP_PRICE_JS = `export function formatPrice(cents) {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return \`\${sign}¥\${(abs / 100).toFixed(2)}\`
}

// 已知缺陷：负数文本会丢掉负号。本次需求不涉及 parsePrice。
export function parsePrice(text) {
  const value = Number(String(text).replace(/[^\\d.]/g, ''))
  return Math.round(value * 100)
}
`

const APP_TEST_RUNNER = `import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workspace = process.env.TAKT_WORKSPACE ?? repoRoot
const casesDir = path.join(workspace, 'cases')
const evidenceDir = path.join(workspace, 'evidence')
const selftest = process.env.TAKT_SELFTEST === '1'
const mod = await import(pathToFileURL(path.join(repoRoot, 'src', 'price.js')).href)

const names = (await readdir(casesDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort()
if (names.length === 0) {
  console.error('没有 cases/*.json')
  process.exitCode = 1
} else {
  const results = []
  for (const name of names) {
    const testCase = JSON.parse(await readFile(path.join(casesDir, name), 'utf8'))
    if (!/^TC-[A-Z0-9-]+$/.test(testCase.id) || name !== testCase.id + '.json'
      || !Array.isArray(testCase.covers) || testCase.covers.length === 0
      || !testCase.covers.every((ac) => /^AC-[0-9]+(?:-[0-9]+)?$/.test(ac))
      || typeof testCase.input?.fn !== 'string' || !Array.isArray(testCase.input?.args)
      || !Object.hasOwn(testCase, 'expected')) throw new Error('用例格式不符合固定 runner 合同：' + name)
    let actual
    let error
    try {
      const fn = mod[testCase.input.fn]
      if (typeof fn !== 'function') throw new Error(\`缺少导出 \${testCase.input.fn}\`)
      actual = fn(...testCase.input.args)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const pass = error === undefined && JSON.stringify(actual) === JSON.stringify(testCase.expected)
    const result = { id: testCase.id, pass, status: pass ? 'passed' : 'failed', expected: testCase.expected, actual: actual ?? null, ...(error === undefined ? {} : { error }) }
    results.push(result)
    if (!selftest) {
      await mkdir(path.join(evidenceDir, testCase.id), { recursive: true })
      await writeFile(path.join(evidenceDir, testCase.id, 'result.json'), \`\${JSON.stringify({ ...testCase, ...result }, null, 2)}\\n\`)
    }
  }
  const ok = results.every((item) => item.pass)
  const summary = { ok, passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length, cases: results, generatedAt: new Date().toISOString() }
  if (!selftest) {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(path.join(evidenceDir, 'summary.json'), \`\${JSON.stringify(summary, null, 2)}\\n\`)
  }
  console.log(JSON.stringify(summary))
  if (!ok) process.exitCode = 1
}
`

const APP_PACKAGE_JSON = `{
  "name": "taktflow-mk-defect-fixture-app",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node tests/run.mjs"
  }
}
`

/** 只在隔离 DSH_HOME 内建 app git fixture；不碰用户仓库。 */
export async function createAppFixture(appDir, { runCommand, secrets }) {
  await mkdir(path.join(appDir, 'src'), { recursive: true })
  await mkdir(path.join(appDir, 'tests'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), APP_PACKAGE_JSON, 'utf8')
  await writeFile(path.join(appDir, 'src', 'price.js'), APP_PRICE_JS, 'utf8')
  await writeFile(path.join(appDir, 'tests', 'run.mjs'), APP_TEST_RUNNER, 'utf8')
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'taktflow e2e',
    GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
    GIT_COMMITTER_NAME: 'taktflow e2e',
    GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
  }
  const git = (args, label) => runCommand('git', args, { cwd: appDir, env, secrets, label, timeoutMs: 120_000 })
  await git(['init', '-b', 'main'], 'fixture git init')
  await git(['config', 'user.name', 'taktflow e2e'], 'fixture git config name')
  await git(['config', 'user.email', 'e2e@example.invalid'], 'fixture git config email')
  await git(['add', '-A'], 'fixture git add')
  await git(['commit', '-m', 'fixture: initial price module'], 'fixture git commit')
  const head = (await git(['rev-parse', 'HEAD'], 'fixture git rev-parse')).stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`fixture HEAD 不是 40 位 SHA：${head}`)
  return {
    head,
    packageScriptsHash: createHash('sha256').update(JSON.stringify(JSON.parse(APP_PACKAGE_JSON).scripts)).digest('hex'),
    branch: 'main',
    files: ['package.json', 'src/price.js', 'tests/run.mjs'],
  }
}

/** 读取本次隔离空间的真实事件日志，供失败时保留节点错误与阻塞原因。 */
export async function readRunEvents(spaceRoot, runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) throw new Error('运行事件身份不合法')
  const file = path.join(spaceRoot, '.takt', 'runs', runId, 'events.jsonl')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 正在追加的半行跳过；归因失败事件必须可解析才会被采用。
    }
  }
  return events
}

/** 独立缺陷事件日志不依赖面板是否暴露 defect-REQ。 */
export async function readDefectEvents(spaceRoot, requirementId) {
  return readRunEvents(spaceRoot, `defect-${requirementId}`)
}

/**
 * 缺陷通知证据。只认会话里 `agent/inbox/spliced` 插入、且对应
 * `user/message` 已出现（admitted）的消息，并且必须指向本次 REQ/defect。
 */
export function defectNotificationEvidence(records, { requirementId, defectId }) {
  const events = records.map(eventOf).filter((event) => event !== null && typeof event === 'object')
  const userMessageIds = new Set()
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const id = event.data?.id ?? event.data?.message?.id
    if (typeof id === 'string' && id !== '') userMessageIds.add(id)
  }
  const queued = []
  const admitted = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
    for (const entry of inserted) {
      const message = entry?.message ?? entry
      const id = message?.id ?? entry?.id
      const text = typeof message?.content === 'string'
        ? message.content.trim()
        : contentText(message?.content ?? [])
      if (typeof id !== 'string' || id === '') continue
      if (!text.startsWith('[taktflow]')) continue
      const header = /^\[taktflow\] REQ=([^ ]+) run=([^；\s]+)/.exec(text)
      if (header?.[1] !== requirementId || !header[2].split(',').includes(`defect-${requirementId}`)) continue
      if (!text.includes(`缺陷 ${defectId} 候选归因已生成（auditor）`)) continue
      const record = { id, target: event.data?.target ?? null, text }
      queued.push(record)
      if (userMessageIds.has(id)) admitted.push(record)
    }
  }
  return {
    queued,
    admitted,
    samples: admitted.slice(-4).map((record) => record.text.slice(0, 500)),
  }
}

async function listFiles(root, predicate) {
  const files = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.isFile() && predicate(target)) files.push(target)
    }
  }
  await walk(root)
  return files
}

/** 扫描隔离 home 的会话头；只读 header，不加载整份日志。 */
export async function listSessionSummaries(home) {
  const files = await listFiles(path.join(home, 'sessions'), (file) => file.endsWith('.jsonl'))
  const summaries = []
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const first = text.split('\n').find((line) => line.trim() !== '')
    if (first === undefined) continue
    let header
    try {
      header = JSON.parse(first)
    } catch {
      continue
    }
    if (header?.type !== 'session' || typeof header?.id !== 'string' || header.id === '') continue
    const info = await stat(file).catch(() => undefined)
    const createdAt = header.createdAt ?? header.created_at ?? header.time ?? header.timestamp ?? info?.mtime?.toISOString?.()
    summaries.push({
      id: header.id,
      file,
      cwd: header.cwd ?? header.session?.cwd ?? header.data?.cwd ?? null,
      parentSessionId: header.parentSession ?? null,
      createdAt: typeof createdAt === 'string' ? createdAt : null,
      mtimeMs: info?.mtimeMs ?? null,
    })
  }
  return summaries
}

/** 单个会话的真实 usage；缺失就 observed=false，不用 0 冒充。 */
export async function sessionUsage(home, sessionId) {
  const records = await readSessionRecords(home, sessionId)
  let inputTokens = 0
  let outputTokens = 0
  let usageEvents = 0
  let assistantMessages = 0
  for (const record of records) {
    const event = eventOf(record)
    if (event?.type !== 'assistant/message') continue
    assistantMessages += 1
    const usage = event?.data?.usage ?? event?.data?.message?.usage
    if (usage === undefined) continue
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) continue
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    usageEvents += 1
  }
  return {
    observed: usageEvents > 0,
    usageEvents,
    assistantMessages,
    inputTokens: usageEvents > 0 ? inputTokens : null,
    outputTokens: usageEvents > 0 ? outputTokens : null,
  }
}

/** Lead 根会话 usage；只从 assistant/message usage 读。 */
export function leadUsage(digest) {
  let inputTokens = 0
  let outputTokens = 0
  let observed = 0
  for (const event of Array.isArray(digest?.events) ? digest.events : []) {
    if (event?.type !== 'assistant/message') continue
    const usage = event?.data?.usage ?? event?.data?.message?.usage
    if (usage === undefined) continue
    if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) continue
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    observed += 1
  }
  return observed > 0
    ? { observed: true, events: observed, inputTokens, outputTokens }
    : { observed: false, events: 0, inputTokens: null, outputTokens: null, reason: 'Lead 会话日志没有 assistant/message usage 事件' }
}

/** 用真实只读 schema 探针的父子身份关联 usage；cwd 不是角色身份，不用于猜测 auditor。 */
export function attachSubagentIdentities(sessions, probe, leadSessionId) {
  const children = probe?.source === 'ctx.tools.schemas(live-agent)' && probe.lead?.sessionId === leadSessionId
    ? (probe.children ?? []).filter((child) => child.parentSessionId === leadSessionId
      && typeof child.sessionId === 'string' && typeof child.role === 'string'
      && ['live-composed-preset', 'session.header.agentPreset'].includes(child.roleSource)) : []
  const matches = (child, id) => child.sessionId === id || child.headerSessionId === id
  const rows = [...sessions]
  // 启动后没有写出日志的子会话也保留，不能把没有 usage 变成没有执行。
  for (const child of children) {
    if (rows.some((row) => matches(child, row.sessionId))) continue
    rows.push({ sessionId: child.headerSessionId ?? child.sessionId, cwd: null, createdAt: null,
      observed: false, usageEvents: 0, assistantMessages: 0, inputTokens: null, outputTokens: null, logAvailable: false })
  }
  return rows.map((row) => {
    const child = children.find((item) => matches(item, row.sessionId))
    const startedAt = child?.startedAt ?? (child?.stage === 'subagent/start' ? child.observedAt : null)
    const endedAt = child?.endedAt ?? null
    const elapsed = Date.parse(endedAt ?? '') - Date.parse(startedAt ?? '')
    return { ...row,
      kind: child?.role === 'auditor' ? 'auditor' : child === undefined ? 'subagent' : 'run-node',
      role: child?.role ?? null,
      roleSource: child?.roleSource ?? null,
      identitySource: child === undefined ? 'unverified' : `schema-probe/${child.roleSource}`,
      parentSessionId: child?.parentSessionId ?? row.parentSessionId ?? null,
      executionObserved: child !== undefined ? true : row.assistantMessages > 0 || row.usageEvents > 0 ? true : null,
      ...(child === undefined ? {} : { agentSessionId: child.sessionId, runId: child.runId,
        nodeId: child.nodeId, attempt: child.attempt, readOnly: child.readOnly,
        schemaObservedAt: child.observedAt, startedAt, endedAt,
        lifecycleDurationMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null, stopReason: child.stopReason ?? null }),
    }
  })
}

/** 所有本批子会话的真实 usage；probe 身份优先，缺日志/缺 usage 都单独保留。 */
export async function subagentUsage(home, leadSessionId, sinceMs, probe) {
  const summaries = await listSessionSummaries(home)
  const sessions = []
  const seen = new Set()
  for (const summary of summaries) {
    if (seen.has(summary.id)) continue
    seen.add(summary.id)
    if (summary.id === leadSessionId || summary.parentSessionId && summary.parentSessionId !== leadSessionId) continue
    const created = Date.parse(summary.createdAt ?? '')
    const fresh = Number.isFinite(created) ? created >= sinceMs - 5_000 : (summary.mtimeMs ?? 0) >= sinceMs - 5_000
    if (!fresh) continue
    const usage = await sessionUsage(home, summary.id)
    sessions.push({ sessionId: summary.id, cwd: summary.cwd ?? '', createdAt: summary.createdAt,
      parentSessionId: summary.parentSessionId, logAvailable: true, ...usage })
  }
  return attachSubagentIdentities(sessions, probe, leadSessionId)
}

/** 清理前保存所有本批子会话的错误、终态与结构化提交；未知协议事件另保留尾部供定位。 */
export async function collectChildDiagnostics(home, sessions, nativeErrors = []) {
  const collected = []
  const terminalType = /(?:^|[/.])(?:end|ended|stop|stopped|finish|finished|complete|completed|cancel|cancelled|abort|aborted|terminated)(?:$|[/.])/
  const errorType = /(?:^|[/.])(?:error|failed|failure)(?:$|[/.])/
  const isFailure = (event) => errorType.test(event?.type ?? '') || event?.data?.error !== undefined
    || event?.data?.exception !== undefined || event?.data?.isError === true || event?.data?.message?.isError === true
    || event?.data?.stopReason === 'error' || ['failed', 'error'].includes(event?.data?.status)
    || event?.data?.reason?.kind === 'error' || event?.data?.reason?.error !== undefined
  for (const session of sessions) {
    try {
      const records = await readSessionRecords(home, session.sessionId)
      const events = records.map(eventOf)
      const structuredOutput = []
      for (const [index, call] of events.entries()) {
        if (call?.type !== 'tool/call' || call.data?.name !== 'structured_output') continue
        const callId = call.data.callId
        const result = events.slice(index + 1).find((event) => event?.type === 'tool/result'
          && (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === callId)
        structuredOutput.push({ callId, call, result: result ?? null,
          parsed: typeof call.data.arguments === 'string' ? parseJsonText(call.data.arguments) ?? null : call.data.arguments })
      }
      const eventTypes = {}
      for (const event of events) eventTypes[event.type ?? 'unknown'] = (eventTypes[event.type ?? 'unknown'] ?? 0) + 1
      collected.push({ sessionId: session.sessionId, role: session.role, identitySource: session.identitySource,
        parentSessionId: session.parentSessionId, runId: session.runId, nodeId: session.nodeId, attempt: session.attempt,
        startedAt: session.startedAt ?? null, endedAt: session.endedAt ?? null, stopReason: session.stopReason ?? null,
        executionObserved: session.executionObserved, usageObserved: session.observed,
        logAvailable: session.logAvailable, eventCount: events.length, eventTypes,
        errors: events.filter(isFailure),
        nativeErrors: nativeErrors.filter((item) => item.sessionId === session.sessionId || item.sessionId === session.agentSessionId),
        terminalEvents: events.filter((event) => terminalType.test(event.type ?? '') || event.data?.stopReason !== undefined),
        structuredOutput, eventTail: events.slice(-16),
      })
    } catch (error) {
      collected.push({ sessionId: session.sessionId, role: session.role, identitySource: session.identitySource,
        usageObserved: session.observed, collectionError: error instanceof Error ? error.message : String(error) })
    }
  }
  return collected
}

/** 读取构建产物里的 LEAD_TOOL_NAMES；优先静态解析，失败再动态导入。 */
export async function staticLeadToolNames(packageRoot) {
  const file = path.join(packageRoot, 'lib', 'lead.js')
  const text = await readFile(file, 'utf8')
  const match = /LEAD_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(text)
  if (match !== null) {
    const names = [...match[1].matchAll(/['"]([a-z_]+)['"]/g)].map((item) => item[1])
    if (names.length > 0) return { names, source: 'lib/lead.js:LEAD_TOOL_NAMES' }
  }
  const mod = await import(pathToFileURL(file).href)
  if (!Array.isArray(mod.LEAD_TOOL_NAMES)) throw new Error('lib/lead.js 没有导出 LEAD_TOOL_NAMES')
  return { names: [...mod.LEAD_TOOL_NAMES], source: 'lib/lead.js:import' }
}

export function deriveElectronPath(dshBin) {
  return path.resolve(path.dirname(dshBin), '../../../../MacOS/DeepSeek Harness')
}

export function deriveGatewayDir(dshBin) {
  return path.join(
    path.resolve(path.dirname(dshBin), '../../../app.asar'),
    'dsh/node_modules/@deepseek-ai/dsh-api-gateway',
  )
}

/** 结果文件脱敏：密钥、本机路径、用户名都不进仓库或日志。 */
export function scrubText(value, context = {}) {
  let text = sanitize(String(value), context.secrets ?? [])
  for (const [needle, replacement] of [
    [context.user, '<user>'],
    [context.home, '<e2e-home>'],
    [context.spaceRoot, '<space>'],
    [context.appDir, '<app-repo>'],
    [context.workspaceDir, '<requirement-workspace>'],
    [context.worktree, '<worktree>'],
    [context.packageRoot, '<repo>'],
  ]) {
    if (typeof needle === 'string' && needle !== '') text = text.split(needle).join(replacement)
  }
  text = text.replace(/\/Users\/[^/\s"']+/g, '<home>')
  text = text.replace(/\/private\/(?:var|tmp)\/[\w./-]+/g, '<tmp>')
  text = text.replace(/\/var\/folders\/[\w./-]+/g, '<tmp>')
  text = text.replace(/\/tmp\/[\w./-]+/g, '<tmp>')
  return text
}

export function scrubValue(value, context = {}) {
  if (typeof value === 'string') return scrubText(value, context)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, context))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, context)]))
  }
  return value
}

/** 与宿主 attributionHash 相同的规范 JSON 哈希；调用方传持久化候选快照。 */
export function candidateHash(defect) {
  const canonical = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const frozen = JSON.parse(JSON.stringify({
    requirementId: defect.requirementId,
    defectId: defect.id,
    status: defect.status,
    attribution: defect.attribution ?? null,
  }))
  return createHash('sha256').update(canonical(frozen)).digest('hex')
}

/** 只接受实际证据原文片段或精确产物版本；类别名、节点名不构成证据引用。 */
export function citedEvidence(answer, attribution) {
  const compact = (value) => String(value ?? '').replace(/\s+/g, '')
  const text = compact(answer)
  const evidence = [...(attribution?.introducedAt?.evidence ?? []),
    ...(attribution?.missedBy ?? []).flatMap((item) => item.evidence ?? [])]
  for (const item of evidence) {
    const value = compact(item)
    if (!value) continue
    const snippet = value.slice(0, Math.min(16, value.length))
    if (text.includes(snippet)) return { kind: 'evidence', snippet }
  }
  const artifact = attribution?.introducedAt?.artifact
  if (typeof artifact?.path === 'string' && artifact.path && Number.isSafeInteger(artifact.version)
    && text.includes(artifact.path)
    && (text.includes(`v${artifact.version}`) || text.includes(`版本${artifact.version}`))) {
    return { kind: 'artifact', path: artifact.path, version: artifact.version }
  }
  return undefined
}

/** 既定归因闭环的用量覆盖；未执行或未观测 auditor 时不能称整条流程完整。 */
export function defectTokenCoverage({ lead, subagents, auditor, attributionPersisted = false }) {
  return {
    completionScope: 'planned-defect-flow-with-auditor',
    auditorRequired: true,
    expectedAuditorExecuted: attributionPersisted || auditor !== null && auditor !== undefined,
    complete: lead?.observed === true && subagents.length > 0
      && subagents.every((session) => session.observed === true)
      && auditor?.observed === true,
  }
}

/** 宿主输出只留内存；完整拼接后先脱敏再截尾，避免跨 chunk 或截断边界泄露凭证。 */
export function createDiagnosticOutputCapture() {
  const streams = new Map()
  return {
    append(chunk, stream = 'stdout') {
      const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))
      const row = streams.get(stream) ?? { chunks: [], bytes: 0 }
      row.chunks.push(buffer)
      row.bytes += buffer.length
      streams.set(stream, row)
    },
    snapshot(context, maxBytes = 32_768) {
      // 两条流分别合并，stderr 不能插断 stdout 中跨 chunk 的凭证。
      const tails = [...streams].map(([stream, row]) => {
        const clean = Buffer.from(scrubText(Buffer.concat(row.chunks).toString('utf8'), context), 'utf8')
        let offset = Math.max(0, clean.length - maxBytes)
        while (offset < clean.length && (clean[offset] & 0xc0) === 0x80) offset += 1
        return { stream, capturedBytes: row.bytes, truncated: offset > 0, tail: clean.subarray(offset).toString('utf8') }
      })
      return { source: 'host stdout/stderr after startup URL, each stream redacted before tail slicing', streams: tails }
    },
    clear() { streams.clear() },
  }
}
