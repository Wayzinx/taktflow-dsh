#!/usr/bin/env node
/**
 * M-J 标准流水线真实 e2e。
 *
 * 流程：隔离 DSH_HOME / profile → 临时 app git fixture → 真实 Lead init →
 * Lead 创建需求 → 只写 PRD 建议输入，真实 test-design/automate 生成用例与脚本 →
 * autonomy full 启动 taktflow-standard → 不回答任何人工待办 → 轮询到终态 →
 * 用真实子 Agent 探针、trace、真实生成的用例/脚本/证据、评审产物和审计做断言。
 *
 * init 必须由发布包复制完整 agents/workflows 模板；e2e 只对 dev/reviewer 档案注入
 * 各自 Skill、只把标准 planner maxItems 收窄为 2，其它角色/节点保持原样。
 * e2e 不预置 cases/、tests/run-cases.mjs、scripts/run-cases.mjs 等最终业务产物。
 *
 * 运行：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/standard.mjs
 *
 * 模型地址和 key 只从进程环境读取；结果文件不含 baseURL/key/本机绝对路径。
 * full 模式禁止调用 attention.answer；若运行升级给人，如实记录并以非零退出。
 */
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'

import { startHost } from './boot.mjs'
import { createCheckList, verdictOf } from './checks.mjs'
import {
  CookieJar,
  assertOwnedHome,
  cleanupOwnedHome,
  contentText,
  delay,
  eventOf,
  fetchWithJar,
  isDirectRun,
  outDir,
  packageRoot,
  poll,
  readSessionRecords,
  requireEnv,
  resolveDshBin,
  rpcCall,
  runCommand,
  sanitize,
  writeJson,
} from './lib.mjs'
import {
  APP_PACKAGE_JSON,
  INITIAL_ADD,
  INITIAL_ADD_TEST,
  PRD_SUGGESTION_MARKDOWN,
  PRD_SUGGESTION_PATH,
  REQUIREMENT_TITLE,
  SKILL_ALPHA,
  SKILL_BETA,
  patchPlannerMaxItems,
  patchSkills,
  regressionBaselineSection,
} from './standard-fixture.mjs'

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1_000
const MODEL_ENV = ['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY']
const TRACE_PATH = '/api/taktflow.agents'
const PROBE_PATH = '/api/taktflow.e2e-standard'
const STANDARD_WORKFLOW = 'taktflow-standard'
const STANDARD_WORKFLOW_FILE = 'workflows/taktflow-standard.workflow.ts'
const REVIEW_NODES = ['review-prd', 'review-design', 'review-cases']
const LOOP_RUN = 'dev-test-loop/run-cases'
const LOOP_JUDGE = 'dev-test-loop/judge'
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled'])
/** 只有这两个是普通人工门禁；其它节点的待办都按明确升级处理。 */
const HUMAN_GATE_NODES = new Set(['answer-clarify', 'acceptance'])
/** Lead init 必须从发布包复制的完整角色；缺任何一个都 FAIL，不由 e2e 补。 */
const REQUIRED_ROLES = ['pm', 'architect', 'dev', 'reviewer', 'test-designer', 'automation', 'judge', 'release-reviewer', 'lead']
/** 标准流程必须实际产生 trace 的职责角色；Lead 是根会话，不在这条 trace 端点里。 */
const REQUIRED_TRACE_ROLES = REQUIRED_ROLES.filter((role) => role !== 'lead')
/** 标准 workflow 三件套同样必须由 init 复制；e2e 只改 planner maxItems。 */
const REQUIRED_WORKFLOWS = [
  'taktflow-standard.workflow.ts',
  'taktflow-standard.hooks.ts',
  'taktflow-standard.integration.ts',
]
/** 标准节点一个都不能少；e2e 只允许收窄 planner maxItems。 */
const STANDARD_NODE_IDS = [
  'clarify', 'answer-clarify', 'prd', 'review-prd', 'design', 'review-design',
  'test-design', 'review-cases', 'trace-gate', 'freeze', 'implement', 'automate',
  'review-scripts', 'integration', 'dev-test-loop', 'impact', 'quality-report',
  'acceptance', 'knowledge-writeback',
]
const GLOBAL_FORBIDDEN_SKILL = 'global-forbidden'
/** 探针必须真实执行 skill/read 的角色；缺失或未完成都按 NOT_RUN/FAIL。 */
const PROBE_ROLES = ['dev', 'reviewer', 'test-designer']
/** 待办刚出现时给自动代答 Agent 的启动窗口，避免把启动竞态误判成升级。 */
const PENDING_GRACE_MS = 30_000
/** 自动判定产物已出现后，给真正写入答复的收尾窗口；不能用 120s 当升级阈值。 */
const AUTO_ANSWER_GRACE_MS = 60_000
/** skill 工具的白名单拒绝必须是明确语义，而不是任意工具错误。 */
const SKILL_DENIAL_RE = /skill\s+"[^"]+"\s+is\s+(?:unknown or no longer available|not available for model invocation|not allowed|forbidden|denied|not permitted)|技能\s*"[^"]+"\s*(?:不在当前角色范围内|被拒绝|未授权|不允许)/i
/** 读守卫拒绝必须能从探针结果里明确识别，不能把协议异常当成拒绝。 */
const READ_DENIAL_RE = /拒绝|denied|forbidden|not allowed|outside|越界|只读/i
/**
 * 独立产品验收：在集成 worktree 的 cwd 直接 require 真实产品文件，不采信 AI runner/报告。
 * execFile 参数执行，不走 shell；只输出断言实际值，供主脚本判定。
 */
const PRODUCT_ASSERTION_SCRIPT = `
const { add, sub } = require('./src/add.js')
const cases = [
  ['sub(5, 3)', sub(5, 3), 2],
  ['sub(0, 0)', sub(0, 0), 0],
  ['sub(2, 5)', sub(2, 5), -3],
  ['sub(-4, 2)', sub(-4, 2), -6],
  ['sub(2.5, 0.5)', sub(2.5, 0.5), 2],
  ['add(2, 3)', add(2, 3), 5],
]
const assertions = cases.map(([name, actual, expected]) => ({ name, actual, expected, pass: actual === expected }))
process.stdout.write(JSON.stringify(assertions))
if (assertions.some((item) => !item.pass)) process.exitCode = 1
`

/** trace 终态；非终态说明该节点可能仍在 AI 处理，不能提前按升级结束。 */
const TERMINAL_TRACE_STATUS = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'blocked'])
const SKILL_MARKERS = { 'skill-alpha': 'ALPHA_SKILL_MARKER', 'skill-beta': 'BETA_SKILL_MARKER' }
const CHECK_NAMES = [
  'profile',
  'fixture-space',
  'fixture-app-repo',
  'probe-installed',
  'startup-url',
  'page-auth',
  'session-create',
  'session-prompt',
  'lead-init',
  'init-templates',
  'lead-create',
  'materials',
  'skills-fixture',
  'workflow-narrowed',
  'autonomy-full',
  'core-singleton',
  'lead-start',
  'run-finished',
  'no-escalation',
  'reviews-cross',
  'denials-read',
  'skills-isolated',
  'role-exact',
  'loop-ran',
  'generated-artifacts',
  'product-acceptance',
  'evidence-summary',
  'quality-report',
  'auto-answers',
  'audit-verify',
  'metrics',
  'sanitized-result',
  'process-stop',
  'home-cleanup',
]

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

/** dsh 不认 NO_PROXY 网段写法；把模型端点 hostname 和带端口 host 补进子进程环境。 */
function noProxyWithEndpoint(value, baseUrl) {
  const entries = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  try {
    const endpoint = new URL(baseUrl)
    for (const host of [endpoint.hostname, endpoint.host]) {
      if (!entries.includes(host)) entries.push(host)
    }
  } catch {
    // baseURL 在 requireEnv 阶段已校验；这里失败就保留原值。
  }
  return entries.join(',')
}

/** trace.denials 里的相对路径按子 Agent 工作目录还原，避免用子串猜测同一次 read。 */
function sameDenialPath(candidate, expected, cwd) {
  if (typeof candidate !== 'string' || candidate === '' || typeof expected !== 'string') return false
  if (path.isAbsolute(candidate)) return path.normalize(candidate) === path.normalize(expected)
  return path.normalize(path.resolve(cwd ?? '', candidate)) === path.normalize(expected)
}

/** 自动代答产物里必须能看到同一段答复；兼容 JSON 转义后的文本。 */
function proofPresent(text, proof) {
  if (typeof proof !== 'string' || proof.trim() === '') return false
  const sample = proof.trim().slice(0, 40)
  return text.includes(proof) || text.includes(sample) || text.includes(JSON.stringify(sample).slice(1, -1))
}

/** 节点 ID 可能带 stage 前缀；标准节点按叶子名对齐。 */
function sameNodeId(candidate, expected) {
  return typeof candidate === 'string' && typeof expected === 'string'
    && (candidate === expected || leafNodeId(candidate) === expected)
}

/** 同一次子 Agent 执行：run/node/attempt/session 全部对齐，不能只按角色取第一条。 */
function sameTraceExecution(trace, probe) {
  if (trace === undefined || probe === undefined) return false
  if (typeof probe.runId !== 'string') return false
  if (trace.runId !== probe.runId) return false
  // trace.sessionId 由 dsh-harness 写成 childId；探针的 sessionId 可能取到
  // session header id，两者都指向同一次子 Agent 执行，不能只认其中一个。
  const sessionIds = [probe.sessionId, probe.childId].filter((value) => typeof value === 'string' && value !== '')
  if (sessionIds.length === 0 || !sessionIds.includes(trace.sessionId)) return false
  if (!sameNodeId(trace.nodeId, probe.nodeId)) return false
  return (trace.attempt ?? 0) === (probe.attempt ?? 0)
}

/** 从待办答复里取可核对的最短证据文本。 */
function answerProof(item) {
  if (typeof item?.answer === 'string' && item.answer.trim() !== '') return item.answer.trim()
  if (item?.answer !== null && typeof item?.answer === 'object') {
    const values = Object.values(item.answer).filter((value) => typeof value === 'string' && value.trim() !== '')
    if (values.length > 0) return values.join(' / ')
    return JSON.stringify(item.answer)
  }
  if (typeof item?.decision === 'string' && item.decision.trim() !== '') return item.decision.trim()
  return ''
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 取 Markdown 二级标题下的正文；缺失标题返回 undefined。 */
function markdownSection(text, heading) {
  if (typeof text !== 'string') return undefined
  const marker = `## ${heading}`
  const start = text.indexOf(marker)
  if (start < 0) return undefined
  const after = text.slice(start + marker.length)
  const next = after.search(/\n##\s/)
  return (next < 0 ? after : after.slice(0, next)).trim()
}

/** trace 的 token 覆盖：只汇总真实观测到的 usage，缺失单独计数，不用 0 冒充。 */
function traceTokenSummary(items) {
  const observed = []
  const missing = []
  for (const trace of Array.isArray(items) ? items : []) {
    const usage = trace?.usage
    if (usage !== undefined && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
      observed.push(trace)
    } else {
      missing.push({ nodeId: trace?.nodeId ?? null, role: trace?.role ?? null })
    }
  }
  const sum = (key) => observed.reduce((total, trace) => total + (trace.usage[key] ?? 0), 0)
  return {
    observedCount: observed.length,
    missingCount: missing.length,
    missing,
    inputTokens: observed.length > 0 ? sum('inputTokens') : null,
    outputTokens: observed.length > 0 ? sum('outputTokens') : null,
  }
}

/** Lead 根会话的 usage 只能从会话日志里读；没有就明确标记未观测。 */
function leadTokenSummary(digest) {
  const events = Array.isArray(digest?.events) ? digest.events : []
  let inputTokens = 0
  let outputTokens = 0
  let observed = 0
  for (const event of events) {
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
    : { observed: false, reason: 'Lead 会话日志没有 assistant/message usage 事件' }
}

/** 评审/审计事件按 runId + nodeId 过滤，避免混入提前启动或历史运行。 */
function eventsOfNode(events, runId, nodeId, type) {
  return events.filter((event) => event?.runId === runId
    && sameNodeId(event.nodeId, nodeId)
    && (type === undefined || event.type === type))
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

/** 把会话日志整理成调用、结果、用户/助手文本。 */
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

function scrubText(value, context) {
  let text = sanitize(String(value), context.secrets)
  for (const [needle, replacement] of [
    [context.user, '<user>'],
    [context.home, '<e2e-home>'],
    [context.spaceRoot, '<space>'],
    [context.appDir, '<app-repo>'],
    [context.workspaceDir, '<requirement-workspace>'],
    [context.packageRoot, '<repo>'],
  ]) {
    if (typeof needle === 'string' && needle !== '') text = text.split(needle).join(replacement)
  }
  // 兜底：任何漏网的本机绝对路径都不进结果文件。
  text = text.replace(/\/Users\/[^/\s"']+/g, '<home>')
  text = text.replace(/\/private\/(?:var|tmp)\/[\w./-]+/g, '<tmp>')
  text = text.replace(/\/var\/folders\/[\w./-]+/g, '<tmp>')
  text = text.replace(/\/tmp\/[\w./-]+/g, '<tmp>')
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

async function readJsonFileIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function fileExists(file) {
  try {
    await access(file, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listFiles(root, predicate) {
  const out = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && predicate(full)) out.push(full)
    }
  }
  await walk(root)
  return out.sort()
}

function leafNodeId(nodeId) {
  return typeof nodeId === 'string' ? nodeId.split('/').at(-1) : undefined
}

/** 普通人工门禁只有 answer-clarify / acceptance；其它待办一律按升级处理。 */
function isHumanGateNode(nodeId) {
  return HUMAN_GATE_NODES.has(leafNodeId(nodeId))
}

/** 只在 app fixture 里执行 git 初始化；绝不操作用户插件仓库。 */
async function createAppFixture(appDir, runCommand, secrets) {
  await rm(appDir, { recursive: true, force: true })
  await mkdir(path.join(appDir, 'src'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(APP_PACKAGE_JSON, null, 2)}\n`, 'utf8')
  await writeFile(path.join(appDir, 'src', 'add.js'), INITIAL_ADD, 'utf8')
  await writeFile(path.join(appDir, 'src', 'add.test.js'), INITIAL_ADD_TEST, 'utf8')
  const git = (args) => runCommand('git', args, {
    cwd: appDir,
    timeoutMs: 60_000,
    secrets,
    label: `fixture git ${args[0]}`,
  })
  await git(['init', '-b', 'main'])
  // 临时 fixture 不能受用户全局 gpg 签名/全局 hooks 影响；只改本仓库局部配置。
  await git(['config', 'commit.gpgSign', 'false'])
  await mkdir(path.join(appDir, '.git', 'takt-hooks-empty'), { recursive: true })
  await git(['config', 'core.hooksPath', path.join(appDir, '.git', 'takt-hooks-empty')])
  await git(['config', 'user.name', 'taktflow e2e fixture'])
  await git(['config', 'user.email', 'taktflow-e2e@example.invalid'])
  await git(['add', '.'])
  await git(['commit', '-m', 'fixture: add 初始实现'])
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (branch !== 'main') throw new Error(`fixture 分支不是 main：${branch}`)
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`fixture HEAD 不合法：${head}`)
  return { branch, head, files: ['package.json', 'src/add.js', 'src/add.test.js'] }
}

/** 写入两个角色 Skill；Skill 是 e2e 固定输入，不是最终业务产物。 */
async function writeSkillFixtures(skillsDir) {
  const alphaDir = path.join(skillsDir, 'skill-alpha')
  const betaDir = path.join(skillsDir, 'skill-beta')
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })
  await writeFile(path.join(alphaDir, 'SKILL.md'), SKILL_ALPHA, 'utf8')
  await writeFile(path.join(betaDir, 'SKILL.md'), SKILL_BETA, 'utf8')
  return { dir: skillsDir, skills: ['skill-alpha', 'skill-beta'] }
}

function normalizeConfig(config) {
  if (typeof config !== 'object' || config === null) throw new Error('takt.config.json 不是对象')
  if (typeof config.project?.name !== 'string' || config.project.name === '') {
    config.project = { ...(config.project ?? {}), name: 'taktflow-mj-standard-e2e' }
  }
  if (!Array.isArray(config.workflows)) config.workflows = []
  if (!config.workflows.includes(STANDARD_WORKFLOW_FILE)) config.workflows.push(STANDARD_WORKFLOW_FILE)
  config.autonomy = 'full'
  const repos = Array.isArray(config.repos) ? config.repos : []
  const next = repos.filter((repo) => repo?.id !== 'app')
  next.push({ id: 'app', path: 'app', defaultBranch: 'main', purpose: 'app', description: 'e2e 临时 app fixture' })
  config.repos = next
  // fixture 显式登记标准流程后续在空间根执行的 QA 命令；只登记这一条精确命令，
  // 不预置 runner、不放宽其它信任校验。仓库/worktree 自测不会使用它。
  const selftest = config.selftest !== null && typeof config.selftest === 'object' && !Array.isArray(config.selftest)
    ? config.selftest
    : {}
  const allowed = Array.isArray(selftest.allowedCommands) ? selftest.allowedCommands.filter((item) => typeof item === 'string') : []
  config.selftest = { ...selftest, allowedCommands: [...new Set([...allowed, 'node tests/run-cases.mjs'])] }
  return config
}

async function main() {
  const startedAt = new Date().toISOString()
  const env = requireEnv(MODEL_ENV)
  const timeoutMs = Number(process.env.TAKT_E2E_STANDARD_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TAKT_E2E_STANDARD_TIMEOUT_MS 必须是正数')
  const deadline = Date.now() + timeoutMs
  const secrets = currentSecrets()
  // 隔离用户全局 Git 配置：gpg 签名、全局 hooks 会让临时 fixture 的提交不确定。
  // 只影响本进程和它启动的宿主子进程，不改用户配置，也不在主仓库提交。
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  // profile 会把 /var/folders/... 规范成 /private/var/folders/...；后续全流程必须用
  // state.home 的规范路径，否则 spaces.includes/root=== 这类断言会被 macOS 路径差异误伤。
  const rawHome = path.join(tmpdir(), `taktflow-mj-standard-${randomUUID()}`)
  let home = rawHome
  let spaceRoot = path.join(home, 'space')
  let appDir = path.join(spaceRoot, 'app')
  const context = {
    secrets,
    home,
    spaceRoot,
    appDir,
    workspaceDir: undefined,
    packageRoot,
    user: userInfo().username,
  }
  const result = {
    ok: false,
    runKey: randomUUID(),
    startedAt,
    finishedAt: undefined,
    home: '<e2e-home>',
    timeoutMs,
    model: env.TAKT_E2E_MODEL,
    baseUrlEnv: 'TAKT_E2E_BASE_URL',
    apiKeyEnv: 'TAKT_E2E_API_KEY',
    sessionId: undefined,
    requirementId: undefined,
    runId: undefined,
    checks: [],
    failed: [],
    diagnostics: undefined,
    evidence: {},
    error: undefined,
    cleanupError: undefined,
  }
  const { checks, failures, mark, step, check } = createCheckList(CHECK_NAMES)

  // 本次启动立即写入独立 runKey 的失败占位；即使进程被强杀，上次 ok=true 也不会冒充本次成功。
  await mkdir(outDir, { recursive: true })
  await writeJson(path.join(outDir, 'standard-result.json'), scrubValue(result, context), secrets)
  // profile 结果/state 必须来自本次；先删除上次残留，避免 profile 未落盘时读到旧 ok=true。
  await rm(path.join(outDir, 'profile-result.json'), { force: true })
  await rm(path.join(outDir, 'state.json'), { force: true })

  let host
  let dshBin
  let jar
  let pageUrl
  let sessionId
  let requirementId
  let runId
  let runDetail
  let attentionItems = []
  let probeChildren = []
  let probeMeta = {}
  let traces = []
  let runEvents = []
  let appFixture
  let initSnapshot
  let generatedArtifacts
  let integrationWorktreePath
  let evidenceSummary
  let autoAnswerEvidence
  let auditEvidence
  const monitorEvidence = {
    waitingSnapshots: [],
    autoAnswerFiles: [],
    escalations: [],
    terminalStatus: undefined,
    timeout: false,
  }
  let failure

  const readConfig = async () => readJsonFileIfExists(path.join(spaceRoot, 'takt.config.json'))
  /** 使用 init 写出的路径配置；新空间必须是顶层 agents/workflows/skills/requirements。 */
  const spacePaths = async () => {
    const config = await readConfig()
    const paths = config?.paths ?? {}
    return {
      agents: path.join(spaceRoot, paths.agents ?? 'agents'),
      workflows: path.join(spaceRoot, paths.workflows ?? 'workflows'),
      skills: path.join(spaceRoot, paths.skills ?? 'skills'),
      knowledge: path.join(spaceRoot, paths.knowledge ?? 'knowledge'),
      requirements: path.join(spaceRoot, paths.requirements ?? 'requirements'),
    }
  }
  const requirementDir = async () => {
    const paths = await spacePaths()
    return path.join(paths.requirements, requirementId)
  }
  const requirementFile = async (rel) => path.join(await requirementDir(), rel)

  const readDigest = async () => {
    if (home === undefined || sessionId === undefined) throw new Error('会话尚未创建')
    return buildDigest(await readSessionRecords(home, sessionId))
  }

  const leadDiagnostics = async () => {
    const digest = await readDigest()
    return {
      assistant: digest.assistantTexts.slice(-2).map((text) => text.slice(0, 1_500)),
      calls: digest.calls.slice(-30).map((call) => {
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

  const panelRead = async (op, params = {}) => {
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

  const panelReadSafe = async (op, params = {}) => {
    try {
      return await panelRead(op, params)
    } catch (error) {
      if (error?.status === 400 || error?.status === 404) return undefined
      throw error
    }
  }

  const postPanel = async (payload) => {
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

  const panelWriteCore = (op, params, body) => postPanel({ p: op, params, body })

  /**
   * 物料写面板 artifact.edit（正确的 params/body 嵌套）；失败就是失败，不回退直接写。
   * fixture 配置（repos/autonomy/roles/skills/workflow）才允许直写隔离空间。
   */
  const ensureArtifact = async (rel, content, reason) => {
    const dir = await requirementDir()
    const file = path.join(dir, rel)
    const panel = await panelWriteCore('artifact.edit', { id: requirementId, path: rel }, { content, reason })
    if (panel.body?.ok !== true) {
      throw new Error(`artifact.edit 失败：HTTP ${panel.status} ${panel.body?.error?.code ?? ''} ${panel.body?.error?.message ?? panel.text ?? ''}`.trim())
    }
    const readback = await readArtifactText(rel)
    if (readback !== content) throw new Error(`artifact.edit 返回成功但内容回读不一致：${rel}`)
    // 面板写成功后，真实工作区文件也应存在且一致；两者不一致说明产物没有落到本次需求。
    if (!(await fileExists(file)) || (await readFile(file, 'utf8')) !== content) {
      throw new Error(`artifact.edit 成功但工作区文件不一致：${rel}`)
    }
    return { method: 'panel', status: panel.status }
  }

  const readArtifactText = async (rel) => {
    try {
      const data = await panelRead('artifact', { id: requirementId, path: rel })
      if (typeof data?.content === 'string') {
        return data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : data.content
      }
    } catch {
      // 面板不可用时直接读隔离工作区；两者都是真实产物。
    }
    return (await readFile(await requirementFile(rel), 'utf8').catch(() => undefined)) ?? undefined
  }

  /** 绑定表里的真实人；自动代答的 onBehalfOf 和审计 actor 都必须对齐它。 */
  const readBindingUser = async () => {
    const bindings = await readJsonFileIfExists(path.join(spaceRoot, '.takt', 'dsh', 'bindings.json'))
    const binding = Array.isArray(bindings?.bindings)
      ? bindings.bindings.find((entry) => entry?.requirementId === requirementId)
      : undefined
    if (binding === undefined || typeof binding.by?.id !== 'string' || binding.by.id === '') {
      throw new Error('bindings.json 没有本次需求的绑定人')
    }
    return binding.by.id
  }

  /**
   * 失败路径先采集证据，再停宿主/清理 home；否则唯一证据会随隔离目录一起消失。
   * 每个读取单独兜底，采集失败不能覆盖原始异常。
   */
  const collectFailureEvidence = async () => {
    const snapshot = {
      collectedAt: new Date().toISOString(),
      run: undefined,
      events: undefined,
      traces: undefined,
      probe: undefined,
      attention: undefined,
      autoAnswers: undefined,
      artifacts: undefined,
      tokens: undefined,
    }
    const safe = async (fn) => {
      try {
        return await fn()
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    // 失败诊断只做证据保留：长文本/深层结构截断，不改变执行、断言或门禁语义。
    const SNAPSHOT_TEXT_LIMIT = 20_000
    const SNAPSHOT_ITEM_LIMIT = 12
    const capText = (value) => {
      if (typeof value !== 'string' || value.length <= SNAPSHOT_TEXT_LIMIT) return value
      return `${value.slice(0, SNAPSHOT_TEXT_LIMIT)}\n…[truncated ${value.length - SNAPSHOT_TEXT_LIMIT} chars]`
    }
    const compactValue = (value, depth = 0) => {
      if (typeof value === 'string') return capText(value)
      if (Array.isArray(value)) {
        if (depth >= 6) return '[truncated depth]'
        return value.slice(0, SNAPSHOT_ITEM_LIMIT).map((item) => compactValue(item, depth + 1))
      }
      if (value !== null && typeof value === 'object') {
        if (depth >= 6) return '[truncated depth]'
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactValue(item, depth + 1)]))
      }
      return value
    }
    // 只有 failed/blocked 节点保留完整诊断；正常节点维持原来的精简形状。
    const failedNodeIds = new Set()
    const failedNode = (id) => [...failedNodeIds].some((failed) => sameNodeId(id, failed))
    if (pageUrl !== undefined && jar !== undefined && runId !== undefined) {
      snapshot.run = await safe(async () => {
        const detail = await panelReadSafe('run', { runId })
        const run = detail?.run
        if (run === undefined) return { missing: true }
        return {
          runId: run.runId,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          nodes: Object.fromEntries(Object.entries(run.nodes ?? {}).map(([id, node]) => {
            const base = {
              status: node.status,
              attempts: node.attempts ?? 0,
              iteration: node.iteration ?? null,
              round: node.round ?? null,
              reworks: node.reworks ?? 0,
              error: node.error ?? null,
            }
            if (node.status !== 'failed' && node.status !== 'blocked') return [id, base]
            failedNodeIds.add(id)
            return [id, {
              ...base,
              startedAt: node.startedAt ?? null,
              endedAt: node.endedAt ?? null,
              summary: capText(node.summary ?? null),
              checks: compactValue(node.checks ?? null),
              result: compactValue(node.result ?? null),
              inputs: compactValue(node.inputs ?? []),
              outputs: compactValue(node.outputs ?? []),
              worktree: node.worktree === undefined ? null : compactValue(node.worktree),
              failures: compactValue(node.failures ?? null),
            }]
          })),
        }
      })
      snapshot.events = await safe(async () => {
        const events = await panelReadSafe('events', { runId })
        const list = Array.isArray(events) ? events : []
        return {
          count: list.length,
          types: [...new Set(list.map((event) => event?.type))].filter(Boolean).sort(),
          reviewRounds: list.filter((event) => event?.runId === runId && event.type === 'review.round').length,
          humanAnswered: list.filter((event) => event?.runId === runId && event.type === 'human.answered').length,
          // 决策产物每次写入都留事件；两次写入说明先代答后升级（或相反）。
          decisionArtifacts: list
            .filter((event) => event?.runId === runId && event.type === 'artifact.written'
              && String(event?.data?.ref?.path ?? '').startsWith('decisions/auto-answers/'))
            .map((event) => ({
              ts: event.ts,
              actor: event.actor,
              path: event.data.ref.path,
              version: event.data.ref.version,
              reason: event.data.reason ?? null,
            })),
          humanRequested: list
            .filter((event) => event?.runId === runId && event.type === 'human.requested')
            .map((event) => ({ ts: event.ts, nodeId: event.nodeId, data: event.data })),
          // 失败节点保留自检与 harness 诊断；长文本截断，count/types 仍按全量列表统计。
          failedNodeEvents: list
            .filter((event) => event?.runId === runId && event.nodeId !== undefined && failedNode(event.nodeId))
            .filter((event) => event.type === 'node.checks' || event.type === 'node.failed'
              || event.type === 'harness.message'
              || (event.type === 'harness.tool_call' && /selftest/i.test(JSON.stringify(event.data ?? {}))))
            .slice(-40)
            .map((event) => ({
              seq: event.seq,
              ts: event.ts,
              type: event.type,
              nodeId: event.nodeId,
              actor: event.actor,
              data: compactValue(event.data),
            })),
        }
      })
      snapshot.traces = await safe(async () => {
        const list = await fetchTrace()
        // 失败节点的 trace 即使 status=completed（例如完成标准 c2 未满足）也保留，
        // 否则只能看到节点失败、看不到子 Agent 的真实停止原因与最后输出。
        const failedTraces = list.filter((trace) => trace?.status === 'failed' || trace?.status === 'blocked'
          || (trace?.nodeId !== undefined && failedNode(trace.nodeId)))
        return {
          count: list.length,
          roles: [...new Set(list.map((trace) => trace?.role))].filter(Boolean).sort(),
          token: traceTokenSummary(list),
          denials: list.reduce((sum, trace) => sum + (Array.isArray(trace.denials) ? trace.denials.length : 0), 0),
          failed: failedTraces.slice(0, 20).map((trace) => ({
            role: trace.role,
            nodeId: trace.nodeId,
            attempt: trace.attempt,
            status: trace.status,
            stopReason: capText(trace.stopReason ?? null),
            error: capText(trace.error ?? null),
            finalText: capText(trace.finalText ?? null),
            tools: (Array.isArray(trace.tools) ? trace.tools : []).slice(-30).map((tool) => ({
              name: capText(tool.name),
              summary: capText(tool.summary),
              ok: tool.ok,
              durationMs: tool.durationMs,
            })),
            denials: (Array.isArray(trace.denials) ? trace.denials : []).slice(0, 20).map((denial) => ({
              tool: capText(denial.tool),
              path: capText(denial.path),
              reason: capText(denial.reason),
              at: denial.at,
            })),
          })),
        }
      })
      snapshot.probe = await safe(async () => {
        const value = await fetchProbe()
        const children = Array.isArray(value.children) ? value.children : []
        return {
          count: children.length,
          globalSkill: value.globalSkill,
          children: children.map((child) => ({
            childId: child.childId,
            sessionId: child.sessionId,
            runId: child.runId,
            role: child.role,
            nodeId: child.nodeId,
            attempt: child.attempt,
            pending: child.pending,
            error: child.error,
            read: child.read,
            skill: child.skill,
            skillOther: child.skillOther,
            globalSkill: child.globalSkill,
          })),
        }
      })
      snapshot.attention = await safe(async () => {
        const all = await attentionAll()
        const pending = await attentionPendingForRun()
        return {
          total: all.filter((item) => item?.runId === runId).length,
          pending: pending.map((item) => ({
            requestId: item.requestId,
            nodeId: item.nodeId,
            form: item.form,
            attempt: item.attempt,
            ask: item.ask,
          })),
        }
      })
    }
    if (requirementId !== undefined) {
      snapshot.autoAnswers = await safe(async () => {
        const dir = path.join(await requirementDir(), 'decisions', 'auto-answers')
        const files = await listFiles(dir, (item) => item.endsWith('.md'))
        const entries = []
        for (const file of files) {
          // 失败现场必须留下决策正文：只有文件路径无法判断是“代答”还是“升级”。
          const text = await readFile(file, 'utf8').catch(() => '')
          entries.push({
            path: `decisions/auto-answers/${path.basename(file)}`,
            bytes: text.length,
            text: text.slice(0, 20_000),
          })
        }
        return {
          count: files.length,
          files: entries.map((entry) => entry.path),
          entries,
        }
      })
      snapshot.workspaceFiles = await safe(async () => {
        const workspace = await requirementDir()
        const listed = []
        for (const rel of ['inputs', 'spec', 'decisions', 'test-plan', 'cases', 'scripts', 'evidence', 'reports', 'reviews', 'tasks']) {
          const files = await listFiles(path.join(workspace, rel), () => true)
          for (const file of files) {
            const relative = path.relative(workspace, file).split(path.sep).join('/')
            listed.push({ path: relative, bytes: (await stat(file)).size })
          }
        }
        return listed.sort((left, right) => left.path.localeCompare(right.path))
      })
      snapshot.artifacts = await safe(async () => {
        const workspace = await requirementDir()
        const checks = {}
        for (const rel of ['spec/prd.md', 'test-plan/plan.md', 'scripts/run-cases.mjs', 'evidence/summary.json', 'reports/quality.md']) {
          const file = path.join(workspace, rel)
          checks[rel] = (await fileExists(file)) ? { exists: true, bytes: (await stat(file)).size } : { exists: false }
        }
        const caseFiles = await listFiles(path.join(workspace, 'cases'), (file) => file.endsWith('.json'))
        checks['cases/'] = { exists: caseFiles.length > 0, count: caseFiles.length }
        return checks
      })
      // automate 失败时保留 selftest 账本与 runner 正文；只读快照，不执行脚本，也不据此判 PASS。
      if (failedNode('automate') && Array.isArray(snapshot.workspaceFiles)) {
        snapshot.automationFailure = await safe(async () => {
          const workspace = await requirementDir()
          const listed = snapshot.workspaceFiles
          const ledgerPaths = listed.filter((item) => /^evidence\/selftest-.*\.json$/.test(item.path)).slice(0, 10)
          const runnerPaths = listed.filter((item) => item.path === 'scripts/run-cases.mjs').slice(0, 1)
          const readEntry = async (item) => {
            const text = await readFile(path.join(workspace, item.path), 'utf8').catch(() => '')
            return { path: item.path, bytes: text.length, text: capText(text) }
          }
          return {
            ledger: await Promise.all(ledgerPaths.map(readEntry)),
            runner: await Promise.all(runnerPaths.map(readEntry)),
          }
        })
      }
    }
    if (home !== undefined && sessionId !== undefined) {
      snapshot.tokens = await safe(async () => {
        const digest = await readDigest()
        const traceList = await fetchTrace().catch(() => [])
        return { lead: leadTokenSummary(digest), trace: traceTokenSummary(traceList) }
      })
    }
    return snapshot
  }

  const fetchProbe = async (query) => {
    // 探针只做只读快照，使用 GET；与 standard-probe.mjs 注册的方法保持一致。
    // core=1 才会执行 core 单例验收（会写一个私有临时 workflow），只在 Lead init 后调用。
    const url = apiUrl(pageUrl, PROBE_PATH)
    if (query !== undefined) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const { response } = await fetchWithJar(
      url,
      { method: 'GET', headers: { accept: 'application/json' } },
      jar,
      { secrets, label: 'standard probe snapshot' },
    )
    const text = await response.text()
    const body = parseJsonText(text)
    if (!response.ok || body?.ok !== true) throw new Error(`探针快照失败：HTTP ${response.status}`)
    return body.value ?? {}
  }

  const fetchTrace = async () => {
    const url = apiUrl(pageUrl, TRACE_PATH)
    url.searchParams.set('space', spaceRoot)
    url.searchParams.set('run', runId)
    const { response } = await fetchWithJar(
      url,
      { headers: { accept: 'application/json' } },
      jar,
      { secrets, label: 'agent trace' },
    )
    const text = await response.text()
    const body = parseJsonText(text)
    if (!response.ok || body?.ok !== true) throw new Error(`trace 读取失败：HTTP ${response.status}`)
    return Array.isArray(body.data) ? body.data : []
  }

  const attentionAll = async () => {
    const items = await panelReadSafe('attention')
    return Array.isArray(items) ? items : []
  }

  const attentionPendingForRun = async () => {
    const items = await panelReadSafe('attention', { pending: '1' })
    return (Array.isArray(items) ? items : []).filter((item) => item?.runId === runId)
  }

  const autoAnswerCache = new Map()
  /** 自动判定完成的证据：decisions/auto-answers/*.md 里引用了该 requestId。 */
  const findAutoAnswer = async (requestId) => {
    if (typeof requestId !== 'string' || requestId === '') return undefined
    if (autoAnswerCache.has(requestId)) return autoAnswerCache.get(requestId)
    const dir = path.join(await requirementDir(), 'decisions', 'auto-answers')
    for (const file of await listFiles(dir, (item) => item.endsWith('.md'))) {
      const text = await readFile(file, 'utf8').catch(() => '')
      if (text.includes(requestId)) {
        const rel = `decisions/auto-answers/${path.basename(file)}`
        autoAnswerCache.set(requestId, rel)
        return rel
      }
    }
    return undefined
  }

  const writeResult = async () => {
    result.finishedAt = new Date().toISOString()
    result.checks = [...checks.values()]
    const verdict = verdictOf({ failure, failures, checks })
    result.ok = verdict.ok
    result.failed = verdict.failed
    if (result.error === undefined && failure !== undefined) {
      result.error = failure instanceof Error ? failure.message : String(failure)
    }
    await writeJson(path.join(outDir, 'standard-result.json'), scrubValue(result, context), secrets)
  }

  try {
    await mkdir(outDir, { recursive: true })
    secrets.push(home, spaceRoot, appDir, packageRoot, outDir)
    await mkdir(path.dirname(home), { recursive: true })

    // 1. 隔离 profile：每次重新构建+安装当前工作区产物；模型配置只来自进程环境。
    //    NO_PROXY 只补进进程/子进程环境，不落盘、不输出；dsh 不认网段写法，这里补精确 host。
    const noProxyUpper = noProxyWithEndpoint(process.env.NO_PROXY, env.TAKT_E2E_BASE_URL)
    const noProxyLower = noProxyWithEndpoint(process.env.no_proxy, env.TAKT_E2E_BASE_URL)
    process.env.NO_PROXY = noProxyUpper
    process.env.no_proxy = noProxyLower
    const e2eEnv = {
      ...process.env,
      TAKT_E2E_HOME: home,
      TAKTFLOW_E2E_STANDARD_SPACE: spaceRoot,
      TAKTFLOW_E2E_STANDARD_PRODUCT: 'app/src/add.js',
      NO_PROXY: noProxyUpper,
      no_proxy: noProxyLower,
      CI: '1',
      NO_COLOR: '1',
    }
    await step('profile', async () => {
      await runCommand(process.execPath, [path.join(packageRoot, 'e2e', 'profile.mjs')], {
        env: e2eEnv,
        cwd: packageRoot,
        timeoutMs: 900_000,
        secrets,
        label: 'e2e profile',
      })
      const profileResult = await readJsonFileIfExists(path.join(outDir, 'profile-result.json'))
      if (profileResult?.ok !== true) throw new Error('profile-result.json 没有 ok=true')
      return { steps: profileResult.steps?.length ?? 0 }
    }, (value) => value)

    const state = await readJsonFileIfExists(path.join(outDir, 'state.json'))
    if (state === undefined) throw new Error('profile 没有写出 state.json')
    dshBin = typeof state.dshBin === 'string' && state.dshBin !== '' ? state.dshBin : await resolveDshBin()
    secrets.push(dshBin)
    if (typeof state.home !== 'string' || state.home === '') throw new Error('state.json 没有记录 profile home')
    home = await realpath(state.home)
    spaceRoot = path.join(home, 'space')
    appDir = path.join(spaceRoot, 'app')
    context.home = home
    context.spaceRoot = spaceRoot
    context.appDir = appDir
    secrets.push(home, spaceRoot, appDir)
    e2eEnv.TAKT_E2E_HOME = home
    e2eEnv.TAKTFLOW_E2E_STANDARD_SPACE = spaceRoot
    await assertOwnedHome(home)

    // 2. 探针插件：普通 ESM 文件，不需要 esbuild；只在本次隔离 profile 生效。
    await step('probe-installed', async () => {
      const profileDir = path.join(home, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true })
      const target = path.join(profileDir, 'mj-standard-probe.mjs')
      await writeFile(target, await readFile(new URL('./standard-probe.mjs', import.meta.url), 'utf8'), 'utf8')
      const patchFile = path.join(profileDir, 'cordis.patch.yml')
      const patch = await readFile(patchFile, 'utf8')
      if (!patch.includes('mj-standard-probe')) {
        await writeFile(patchFile, `${patch.replace(/\s*$/, '\n')}- insert:\n    - id: mj-standard-probe\n      name: ${JSON.stringify(target)}\n`, 'utf8')
      }
      const after = await readFile(patchFile, 'utf8')
      if (!after.includes('mj-standard-probe') || !after.includes(target)) throw new Error('profile patch 没有写入探针插件')
      return { file: 'mj-standard-probe.mjs', patch: 'cordis.patch.yml' }
    }, () => ({ installed: true }))

    // 3. 新目录 + 临时 app git fixture（只在隔离 home 内，绝不碰用户仓库）。
    await step('fixture-space', async () => {
      await mkdir(spaceRoot, { recursive: true })
      // 用 realpath 后的空间根同步后续 env/断言，避免 macOS /var 与 /private/var 差异。
      const canonicalSpace = await realpath(spaceRoot)
      if (canonicalSpace !== spaceRoot) {
        spaceRoot = canonicalSpace
        appDir = path.join(spaceRoot, 'app')
        context.spaceRoot = spaceRoot
        context.appDir = appDir
        e2eEnv.TAKTFLOW_E2E_STANDARD_SPACE = spaceRoot
        secrets.push(spaceRoot, appDir)
      }
      if (await fileExists(path.join(spaceRoot, 'takt.config.json'))) {
        throw new Error('新目录已存在 takt.config.json，无法验证真实 Lead init')
      }
      return { fresh: true }
    }, () => ({ fresh: true }))

    await step('fixture-app-repo', async () => {
      appFixture = await createAppFixture(appDir, runCommand, secrets)
      // 回归基线只能来自本次新建 fixture 在 Agent 变更前的真实初始提交。
      // 必须在 startHost 之前写入 e2eEnv：不能沿用用户环境里可能已有的同名值，
      // 也不能使用运行后的 integration HEAD。
      if (!/^[0-9a-f]{40}$/.test(appFixture.head)) throw new Error(`fixture HEAD 不是 40 位 SHA：${appFixture.head}`)
      const inheritedSameName = Object.hasOwn(process.env, 'TAKT_REGRESSION_BASELINE_REV')
      e2eEnv.TAKT_REGRESSION_BASELINE_REV = appFixture.head
      if (e2eEnv.TAKT_REGRESSION_BASELINE_REV !== appFixture.head) throw new Error('回归基线环境变量写入不一致')
      result.evidence.appFixture = {
        branch: appFixture.branch,
        head: appFixture.head,
        files: appFixture.files,
        baselineRev: {
          env: 'TAKT_REGRESSION_BASELINE_REV',
          value: appFixture.head,
          source: 'fixture-app-repo 新建 app 仓库的初始提交，任何 Agent 变更之前',
          appliedBefore: 'startup-url/startHost',
          inheritedSameNamePresent: inheritedSameName,
        },
      }
      return appFixture
    }, (value) => ({ branch: value.branch, files: value.files.length, baselineRev: value.head }))

    // 4. 启动 dsh 并完成页面同款认证。
    await step('startup-url', async () => {
      host = await startHost({ home, dshBin, env: e2eEnv })
      secrets.push(host.url, new URL(host.url).searchParams.get('token') ?? '')
      return { captured: true }
    }, () => ({ captured: true }))

    jar = new CookieJar()
    await step('page-auth', async () => {
      const exchanged = await fetchWithJar(
        host.url,
        { headers: { accept: 'text/html' } },
        jar,
        { secrets, label: 'launch-token exchange' },
      )
      const html = await exchanged.response.text()
      if (exchanged.response.status !== 200) throw new Error(`页面 HTTP ${exchanged.response.status}`)
      if (!/text\/html/i.test(exchanged.response.headers.get('content-type') ?? '')) {
        throw new Error('页面 Content-Type 不是 HTML')
      }
      if (!exchanged.redirectStatuses.includes(303)) throw new Error('launch-token 没有经过 303 交换')
      if (exchanged.finalUrl.searchParams.has('token')) throw new Error('重定向后 URL 仍带 token')
      if (jar.size === 0) throw new Error('launch-token 交换后没有拿到 cookie')
      secrets.push(jar.header())
      pageUrl = exchanged.finalUrl.href
      return { status: 200, redirects: exchanged.redirects, cookieCount: jar.size }
    }, (value) => value)

    // 5. 真实 Lead 会话，cwd 就是新空间根。
    await step('session-create', async () => {
      const value = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/create',
        args: { request: { agentPreset: 'taktflow', cwd: spaceRoot } },
        jar,
        secrets,
      })
      if (typeof value?.sessionId !== 'string' || value.sessionId === '') throw new Error('session/create 没有返回 sessionId')
      if (value.agentPreset !== undefined && value.agentPreset !== 'taktflow') {
        throw new Error(`session/create 返回的 agentPreset 是 ${String(value.agentPreset)}`)
      }
      sessionId = value.sessionId
      result.sessionId = sessionId
      return { sessionId, agentPreset: value.agentPreset }
    }, (value) => ({ sessionId: value.sessionId, agentPreset: value.agentPreset }))

    // 6. 第一阶段：真实 Lead init + 建需求；明确不启动运行。
    const phase1 = [
      '我已确认就在当前目录初始化，不要询问目录，也不要创建新目录。',
      '请只做两件事：',
      '1) 调用 takt_requirement init 初始化当前目录；',
      `2) 调用 takt_requirement create 创建需求「${REQUIREMENT_TITLE}」，requestKey 使用 ${`mj-e2e-create-${randomUUID()}`}。`,
      '不要启动运行，不要调用 takt_ask_human；除 init/create 外不要修改任何文件。',
      '完成后只报告需求 ID，然后结束回合。',
    ].join('\n')
    await step('session-prompt', async () => {
      const value = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/prompt',
        args: {
          request: {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: phase1 }],
          },
        },
        jar,
        secrets,
      })
      if (value?.accepted !== true) throw new Error('session/prompt 没有返回 accepted=true')
      return { accepted: true }
    }, () => ({ accepted: true }))

    await step('lead-init', async () => {
      const spaces = await poll(async () => {
        try {
          const url = apiUrl(pageUrl, 'api/taktflow.ping')
          const { response } = await fetchWithJar(url, { headers: { accept: 'application/json' } }, jar, { secrets, label: 'ping (init)' })
          const body = JSON.parse(await response.text())
          if (body?.ok === true && Array.isArray(body.spaces) && body.spaces.includes(spaceRoot)) return body.spaces
        } catch {
          return undefined
        }
        return undefined
      }, { timeoutMs: Math.min(remaining(deadline), 240_000), intervalMs: 500 })
      if (spaces === undefined) throw new Error(`等待 Lead 初始化空间超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      const found = await poll(async () => {
        try {
          const digest = await readDigest()
          return successfulCall(digest, {
            name: 'takt_requirement',
            action: 'init',
            match: (business) => typeof business.space?.root === 'string' && business.space.root === spaceRoot,
          })
        } catch {
          return undefined
        }
      }, { timeoutMs: Math.min(remaining(deadline), 90_000), intervalMs: 500 })
      if (found === undefined) throw new Error(`Lead 没有成功的 takt_requirement init 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      if (!(await fileExists(path.join(spaceRoot, 'takt.config.json')))) throw new Error('init 后没有 takt.config.json')
      return { spaceRegistered: true, initialized: true }
    }, (value) => value)

    // 6.1 init 必须真的从发布包复制完整模板；缺角色/缺 workflow 直接 FAIL，不由 e2e 补。
    await step('init-templates', async () => {
      const config = await readConfig()
      const configured = config?.paths ?? {}
      for (const key of ['agents', 'workflows', 'skills', 'knowledge', 'requirements']) {
        if (configured[key] !== undefined && configured[key] !== key) {
          throw new Error(`新空间布局不是顶层 ${key}/：takt.config.json paths.${key}=${String(configured[key])}`)
        }
      }
      const paths = await spacePaths()
      const roleFiles = {}
      for (const role of REQUIRED_ROLES) {
        const file = path.join(paths.agents, `${role}.md`)
        if (!(await fileExists(file))) throw new Error(`Lead init 没有从发布包复制角色 ${role}.md：${file}`)
        const content = await readFile(file, 'utf8')
        if (content.trim() === '') throw new Error(`Lead init 复制的角色 ${role}.md 是空文件`)
        if (!new RegExp(`^role:\\s*${role}\\s*$`, 'm').test(content)) {
          throw new Error(`角色 ${role}.md 的 frontmatter role 不匹配`)
        }
        roleFiles[role] = content
      }
      const workflowFiles = {}
      for (const name of REQUIRED_WORKFLOWS) {
        const file = path.join(paths.workflows, name)
        if (!(await fileExists(file))) throw new Error(`Lead init 没有从发布包复制 workflow ${name}：${file}`)
        const content = await readFile(file, 'utf8')
        if (content.trim() === '') throw new Error(`Lead init 复制的 workflow ${name} 是空文件`)
        workflowFiles[name] = content
      }
      const workflow = workflowFiles['taktflow-standard.workflow.ts']
      for (const id of STANDARD_NODE_IDS) {
        if (!new RegExp(`id:\\s*['"]${id}['"]`).test(workflow)) throw new Error(`init 复制出的标准 workflow 缺少节点 ${id}`)
      }
      // 新空间必须是顶层布局；旧 .takt/agents 双写会让“只改顶层档案”的断言失去意义。
      if (await fileExists(path.join(spaceRoot, '.takt', 'agents'))) {
        throw new Error('Lead init 双写了旧布局 .takt/agents，新空间应为顶层 agents/')
      }
      initSnapshot = { roleFiles, workflowFiles, paths }
      result.evidence.initTemplates = {
        layout: 'top-level',
        roles: Object.keys(roleFiles),
        workflows: Object.keys(workflowFiles),
      }
      return result.evidence.initTemplates
    }, (value) => value)

    await step('lead-create', async () => {
      const list = await poll(async () => {
        const requirements = await panelReadSafe('requirements')
        return Array.isArray(requirements) && requirements.length > 0 ? requirements : undefined
      }, { timeoutMs: Math.min(remaining(deadline), 180_000), intervalMs: 500 })
      if (list === undefined) throw new Error(`等待需求创建超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      const picked = list.find((item) => typeof item?.title === 'string' && item.title === REQUIREMENT_TITLE)
        ?? list.find((item) => typeof item?.title === 'string' && /sub|add/i.test(item.title))
        ?? list.slice().sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
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
      if (found === undefined) throw new Error(`Lead 没有与需求 ${requirementId} 匹配的成功 create 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      context.workspaceDir = await requirementDir()
      result.evidence.workspace = '<requirement-workspace>'
      return { requirementId, title: picked.title }
    }, (value) => value)

    // 7. 物料：只写 PRD 建议输入；角色/Skill/workflow/配置是 fixture 准备，直写隔离空间。
    //    cases/、tests/run-cases.mjs、scripts/run-cases.mjs 必须由真实节点生成。
    await step('materials', async () => {
      if (initSnapshot === undefined) throw new Error('缺少 init 模板快照，无法证明只改了允许的文件')
      const paths = await spacePaths()

      if (typeof appFixture?.head !== 'string' || !/^[0-9a-f]{40}$/.test(appFixture.head)) {
        throw new Error('materials 缺少本次 fixture 基线 SHA，无法写入回归基线说明')
      }
      // PRD 建议只追加本次真实 fixture 基线的来源与访问约束；不生成 cases/runner/evidence。
      const prdContent = `${PRD_SUGGESTION_MARKDOWN}${regressionBaselineSection(appFixture.head)}`
      const prd = await ensureArtifact(
        PRD_SUGGESTION_PATH,
        prdContent,
        'e2e 提供 PRD 建议，作为真实 prd 节点的输入',
      )

      // 只改 dev/reviewer 档案的 skills 字段；其它角色与 init 快照逐字节一致。
      const devFile = path.join(paths.agents, 'dev.md')
      const reviewerFile = path.join(paths.agents, 'reviewer.md')
      const devBefore = initSnapshot.roleFiles.dev
      const reviewerBefore = initSnapshot.roleFiles.reviewer
      const devAfter = patchSkills(devBefore, 'skill-alpha')
      const reviewerAfter = patchSkills(reviewerBefore, 'skill-beta')
      await writeFile(devFile, devAfter, 'utf8')
      await writeFile(reviewerFile, reviewerAfter, 'utf8')
      for (const role of REQUIRED_ROLES) {
        if (role === 'dev' || role === 'reviewer') continue
        const content = await readFile(path.join(paths.agents, `${role}.md`), 'utf8')
        if (content !== initSnapshot.roleFiles[role]) throw new Error(`e2e 修改了不应改动的角色 ${role}.md`)
      }
      if (!/skills:\s*\[skill-alpha\]/.test(devAfter)) throw new Error('dev.md 没有注入 skill-alpha')
      if (!/skills:\s*\[skill-beta\]/.test(reviewerAfter)) throw new Error('reviewer.md 没有注入 skill-beta')

      const skills = await writeSkillFixtures(paths.skills)

      // 只改标准 workflow 的 planner maxItems；hooks/integration 必须与 init 快照一致。
      const workflowFile = path.join(paths.workflows, 'taktflow-standard.workflow.ts')
      const workflowBefore = initSnapshot.workflowFiles['taktflow-standard.workflow.ts']
      const workflowAfter = patchPlannerMaxItems(workflowBefore, 2)
      await writeFile(workflowFile, workflowAfter, 'utf8')
      const workflowReadback = await readFile(workflowFile, 'utf8')
      if (workflowReadback !== workflowAfter) throw new Error('workflow 收窄后回读不一致')
      for (const name of REQUIRED_WORKFLOWS) {
        if (name === 'taktflow-standard.workflow.ts') continue
        const content = await readFile(path.join(paths.workflows, name), 'utf8')
        if (content !== initSnapshot.workflowFiles[name]) throw new Error(`e2e 修改了不应改动的 workflow ${name}`)
      }

      // fixture 配置（repos/autonomy/workflow 注册）允许直写隔离空间，不经过写 API。
      const config = normalizeConfig(await readConfig())
      await writeFile(path.join(spaceRoot, 'takt.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      const after = await readConfig()
      if (after?.autonomy !== 'full') throw new Error('takt.config.json autonomy 不是 full')
      if (!Array.isArray(after?.repos) || !after.repos.some((repo) => repo?.id === 'app' && repo.path === 'app' && repo.defaultBranch === 'main')) {
        throw new Error('takt.config.json 没有 app 仓库绑定')
      }
      if (!Array.isArray(after?.workflows) || !after.workflows.includes(STANDARD_WORKFLOW_FILE)) {
        throw new Error('takt.config.json 没有注册标准 workflow')
      }
      if (!Array.isArray(after?.selftest?.allowedCommands)
        || !after.selftest.allowedCommands.includes('node tests/run-cases.mjs')) {
        throw new Error('takt.config.json 没有登记标准 QA caseCommand 白名单')
      }

      // 启动前必须没有任何最终业务产物；否则无法证明它们由真实节点生成。
      const workspace = await requirementDir()
      const seeded = []
      const caseFiles = await listFiles(path.join(workspace, 'cases'), () => true)
      if (caseFiles.length > 0) seeded.push('cases/')
      for (const rel of ['scripts/run-cases.mjs', 'spec/prd.md', 'test-plan/plan.md', 'evidence/summary.json', 'reports/quality.md']) {
        if (await fileExists(path.join(workspace, rel))) seeded.push(rel)
      }
      if (await fileExists(path.join(spaceRoot, 'tests', 'run-cases.mjs'))) seeded.push('tests/run-cases.mjs')
      if (await fileExists(path.join(appDir, 'tests', 'run-cases.mjs'))) seeded.push('app/tests/run-cases.mjs')
      if (seeded.length > 0) throw new Error(`启动前已存在最终业务产物，无法证明由真实节点生成：${seeded.join(', ')}`)

      result.evidence.materials = {
        prd: {
          path: PRD_SUGGESTION_PATH,
          method: prd.method,
          role: 'input-only',
          baselineRev: { env: 'TAKT_REGRESSION_BASELINE_REV', value: appFixture.head },
        },
        roles: {
          injected: { dev: ['skill-alpha'], reviewer: ['skill-beta'] },
          unchanged: REQUIRED_ROLES.filter((role) => role !== 'dev' && role !== 'reviewer'),
        },
        skills: skills.skills,
        workflow: { files: REQUIRED_WORKFLOWS, plannerMaxItems: 2 },
        config: { autonomy: after.autonomy, repo: 'app', workflow: STANDARD_WORKFLOW_FILE },
        seededFinalArtifacts: [],
      }
      return result.evidence.materials
    }, (value) => value)

    await check('skills-fixture', async () => {
      const paths = await spacePaths()
      const alpha = await readFile(path.join(paths.skills, 'skill-alpha', 'SKILL.md'), 'utf8')
      const beta = await readFile(path.join(paths.skills, 'skill-beta', 'SKILL.md'), 'utf8')
      const dev = await readFile(path.join(paths.agents, 'dev.md'), 'utf8')
      const reviewer = await readFile(path.join(paths.agents, 'reviewer.md'), 'utf8')
      if (!alpha.includes('ALPHA_SKILL_MARKER') || !beta.includes('BETA_SKILL_MARKER')) throw new Error('Skill 文件缺少 marker')
      if (!/skills:\s*\[skill-alpha\]/.test(dev)) throw new Error('dev 档案没有声明 skill-alpha')
      if (!/skills:\s*\[skill-beta\]/.test(reviewer)) throw new Error('reviewer 档案没有声明 skill-beta')
      for (const role of REQUIRED_ROLES) {
        if (role === 'dev' || role === 'reviewer') continue
        const content = await readFile(path.join(paths.agents, `${role}.md`), 'utf8')
        if (content !== initSnapshot.roleFiles[role]) throw new Error(`角色 ${role}.md 被意外修改`)
        if (content.includes('skill-alpha') || content.includes('skill-beta')) {
          throw new Error(`角色 ${role}.md 意外出现 e2e Skill`)
        }
      }
      return {
        alpha: 'ALPHA_SKILL_MARKER',
        beta: 'BETA_SKILL_MARKER',
        dev: 'skill-alpha',
        reviewer: 'skill-beta',
        unchangedRoles: REQUIRED_ROLES.filter((role) => role !== 'dev' && role !== 'reviewer'),
      }
    }, (value) => value)

    await check('workflow-narrowed', async () => {
      const paths = await spacePaths()
      const content = await readFile(path.join(paths.workflows, 'taktflow-standard.workflow.ts'), 'utf8')
      if (!/maxItems:\s*2/.test(content)) throw new Error('workflow 没有 maxItems: 2')
      if (/maxItems:\s*12/.test(content)) throw new Error('workflow 仍保留 maxItems: 12')
      for (const id of STANDARD_NODE_IDS) {
        if (!content.includes(`id: '${id}'`)) throw new Error(`标准节点 ${id} 被删除`)
      }
      for (const name of REQUIRED_WORKFLOWS) {
        if (name === 'taktflow-standard.workflow.ts') continue
        const other = await readFile(path.join(paths.workflows, name), 'utf8')
        if (other !== initSnapshot.workflowFiles[name]) throw new Error(`workflow 文件 ${name} 被意外修改`)
      }
      return { maxItems: 2, nodesKept: true, files: REQUIRED_WORKFLOWS }
    }, (value) => value)

    await check('autonomy-full', async () => {
      const config = await readConfig()
      if (config?.autonomy !== 'full') throw new Error('空间 autonomy 不是 full')
      return { autonomy: config.autonomy }
    }, (value) => value)

    // 7.5 真实 dsh core 单例验收：Lead init 之后、start 之前，由探针写一个本次私有
    // 临时 workflow（从 @taktflow/core 导入 FsAttentionStore）并经 workflows.loadFile
    // 加载，要求与宿主空间 stores.attention 的 instanceof/constructor 完全一致。
    // 只有显式 core=1 才触发，避免探针早期轮询缓存失败。
    await step('core-singleton', async () => {
      let last = {}
      const value = await poll(async () => {
        try {
          const snapshot = await fetchProbe({ core: '1' })
          last = snapshot.coreSingleton ?? {}
          return last.ok === true ? last : undefined
        } catch {
          return undefined
        }
      }, { timeoutMs: Math.min(remaining(deadline), 30_000), intervalMs: 1_000 })
      if (value === undefined) throw new Error(`core 单例检查未通过：${JSON.stringify(last)}`)
      if (value.instanceofMatch !== true || value.constructorMatch !== true) {
        throw new Error(`core 单例检查缺少 instanceof/constructor 证据：${JSON.stringify(value)}`)
      }
      result.evidence.coreSingleton = value
      return value
    }, (value) => value)

    // 8. 第二阶段：真实 Lead 启动 taktflow-standard；不传 humanSignoff，靠 autonomy full。
    // 只收窄 planner maxItems；review 保留模板默认 3 轮/1 次打回，不覆盖。
    const runArgs = {
      caseCommand: 'node tests/run-cases.mjs',
      testScript: 'tests/run-cases.mjs',
      repo: 'app',
    }
    const phase2 = [
      `需求 ${requirementId} 的 PRD 建议输入、角色、Skill 和空间配置已准备好；测试用例与脚本由流程节点生成。`,
      '请只调用一次 takt_run start 启动标准流水线：',
      `- workflow: ${STANDARD_WORKFLOW}`,
      `- requestKey: mj-e2e-run-${randomUUID()}`,
      `- args: ${JSON.stringify(runArgs)}`,
      '不要传 humanSignoff，autonomy 已在空间配置为 full。',
      '启动后只报告 runId 并结束回合。',
      '不要调用 takt_ask_human，不要回答任何人工待办，不要修改 workflow，不要删除任何节点。',
    ].join('\n')

    await step('lead-start', async () => {
      // 启动前再次确认 QA caseCommand 白名单已冻结在空间配置里；只登记精确命令。
      const frozenConfig = await readConfig()
      if (!Array.isArray(frozenConfig?.selftest?.allowedCommands)
        || !frozenConfig.selftest.allowedCommands.includes('node tests/run-cases.mjs')) {
        throw new Error('标准 QA caseCommand 白名单未在启动前冻结')
      }
      // 启动前先冻结历史 runId；后面只认集合外、同 workflow、startedAt 在本次 prompt 之后的新运行。
      const existing = await panelReadSafe('runs', { requirement: requirementId })
      const existingRuns = (Array.isArray(existing) ? existing : [])
        .filter((entry) => entry?.requirementId === requirementId)
      const baselineRunIds = new Set(existingRuns.map((entry) => entry?.runId).filter((id) => typeof id === 'string'))
      const standardExisting = existingRuns.filter((entry) => entry?.runId !== undefined && entry.workflowId === STANDARD_WORKFLOW)
      const terminalExisting = standardExisting.filter((entry) => TERMINAL_RUN.has(entry.status))
      if (terminalExisting.length > 0) {
        throw new Error(`启动前已存在终态运行，Lead 提前启动了流程：${terminalExisting.map((entry) => `${entry.runId}/${entry.status}`).join(',')}`)
      }
      const active = standardExisting.filter((entry) => !TERMINAL_RUN.has(entry.status))
      const cancelled = []
      for (const entry of active) {
        // 插件写操作（run.cancel）的字段平铺在 POST body 里，不能套 core 的 {params,body} 信封。
        const cancel = await postPanel({ p: 'run.cancel', runId: entry.runId })
        if (cancel.body?.ok !== true) {
          throw new Error(`提前运行 ${entry.runId} 取消失败：HTTP ${cancel.status} ${cancel.body?.error?.code ?? cancel.text ?? ''}`.trim())
        }
        // 取消必须读回终态；不能把取消请求当作已完成，更不能把旧 run 当成本轮。
        const stopped = await poll(async () => {
          const detail = await panelReadSafe('run', { runId: entry.runId })
          return TERMINAL_RUN.has(detail?.run?.status) ? detail : undefined
        }, { timeoutMs: Math.min(remaining(deadline), 60_000), intervalMs: 500 })
        if (stopped === undefined) throw new Error(`提前运行 ${entry.runId} 取消后未到终态`)
        cancelled.push({ runId: entry.runId, status: stopped.run.status })
      }
      if (cancelled.length > 0) result.evidence.prematureRunCancelled = cancelled
      const promptAtMs = Date.now()
      const accepted = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/prompt',
        args: {
          request: {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: phase2 }],
          },
        },
        jar,
        secrets,
      })
      if (accepted?.accepted !== true) throw new Error('启动 prompt 没有被接受')
      const waitForRuns = (timeoutMs) => poll(async () => {
        const list = await panelReadSafe('runs', { requirement: requirementId })
        const fresh = (Array.isArray(list) ? list : []).filter((entry) => typeof entry?.runId === 'string'
          && entry.requirementId === requirementId
          && entry.workflowId === STANDARD_WORKFLOW
          && !baselineRunIds.has(entry.runId)
          && Date.parse(String(entry.startedAt ?? '')) >= promptAtMs - 5_000)
        return fresh.length > 0 ? fresh : undefined
      }, { timeoutMs: Math.min(remaining(deadline), timeoutMs), intervalMs: 500 })
      let runs = await waitForRuns(60_000)
      if (runs === undefined) {
        const nudge = await rpcCall({
          baseUrl: pageUrl,
          method: 'session/prompt',
          args: {
            request: {
              requestId: randomUUID(),
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: `请现在启动 ${STANDARD_WORKFLOW}，需求 ${requirementId}，使用上一条消息里的 args；不要询问，不要调用 takt_ask_human。` }],
            },
          },
          jar,
          secrets,
        })
        if (nudge?.accepted !== true) throw new Error('启动 follow-up 没有被接受')
        runs = await waitForRuns(180_000)
      }
      if (runs === undefined) throw new Error(`等待运行启动超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      const picked = runs.slice().sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0]
      runId = picked?.runId
      if (typeof runId !== 'string' || runId === '') throw new Error('运行列表没有本次新 runId')
      if (baselineRunIds.has(runId)) throw new Error(`选中的 runId ${runId} 是启动前历史运行`)
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
      if (found === undefined) throw new Error(`Lead 没有与运行 ${runId} 匹配的成功 start 结果；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      return { runId, workflow: found.call.args.workflow ?? STANDARD_WORKFLOW }
    }, (value) => value)

    // 9. 等运行终态；full 模式下绝不调用 attention.answer，不替人回答。
    //    waiting_human 不是超时：AI 代答本身会跑真实子 Agent，可能超过 2 分钟。
    //    只有非人工节点的待办（loop/review/judge 等）才是明确升级；普通人工门禁要等
    //    自动判定结束后的未答证据，或全局 timeout 才报 timeout。
    await check('run-finished', async () => {
      const waitingSeen = new Set()
      const pendingSince = new Map()
      const autoSince = new Map()
      const detail = await poll(async () => {
        const current = await panelReadSafe('run', { runId })
        const status = current?.run?.status
        if (status === 'waiting_human') {
          const pending = await attentionPendingForRun()
          if (pending.length === 0) return undefined
          const now = Date.now()
          let traceSnapshot
          const nodeIsActive = async (nodeId) => {
            if (traceSnapshot === undefined) traceSnapshot = await fetchTrace().catch(() => [])
            if (traceSnapshot.some((trace) => trace?.runId === runId
              && sameNodeId(trace.nodeId, nodeId)
              && !TERMINAL_TRACE_STATUS.has(trace.status))) return true
            const node = Object.entries(current?.run?.nodes ?? {}).find(([id]) => sameNodeId(id, nodeId))?.[1]
            return node?.status === 'running'
          }
          const escalated = []
          for (const item of pending) {
            if (!pendingSince.has(item.requestId)) pendingSince.set(item.requestId, now)
            const auto = await findAutoAnswer(item.requestId)
            const key = `${item.requestId}:${auto ?? 'processing'}`
            if (!waitingSeen.has(key)) {
              waitingSeen.add(key)
              monitorEvidence.waitingSnapshots.push({
                at: new Date().toISOString(),
                requestId: item.requestId,
                nodeId: item.nodeId,
                form: item.form,
                autoDecision: auto ?? null,
              })
              if (auto !== undefined && !monitorEvidence.autoAnswerFiles.includes(auto)) {
                monitorEvidence.autoAnswerFiles.push(auto)
              }
            }
            if (isHumanGateNode(item.nodeId)) {
              // 普通人工门禁：AI 代答本身会跑真实子 Agent，可能超过 2 分钟。
              // 只有“自动判定产物已出现但经过收尾窗口仍未回答”才是升级证据；否则等全局 timeout。
              if (auto !== undefined) {
                if (!autoSince.has(item.requestId)) autoSince.set(item.requestId, now)
                // 自动判定产物可能先落盘、代答子 Agent 仍在收尾；只要同节点还有
                // 非终态 trace，就仍按 AI 处理中，不受收尾窗口影响。
                const processing = await nodeIsActive(item.nodeId)
                if (!processing && now - autoSince.get(item.requestId) >= AUTO_ANSWER_GRACE_MS) {
                  escalated.push({
                    requestId: item.requestId,
                    nodeId: item.nodeId,
                    form: item.form,
                    ask: item.ask,
                    kind: 'auto-decision-finished-but-pending',
                    autoDecision: auto,
                  })
                }
              }
              continue
            }
            // 非 human 节点（loop/review/judge）的待办可以是明确升级；但节点仍在跑
            // AI 评审/判决时不能提前结束，给自动处理一个启动窗口。
            const processing = await nodeIsActive(item.nodeId)
            const age = now - (pendingSince.get(item.requestId) ?? now)
            if (!processing && age >= PENDING_GRACE_MS) {
              escalated.push({
                requestId: item.requestId,
                nodeId: item.nodeId,
                form: item.form,
                ask: item.ask,
                kind: 'non-human-pending',
              })
            }
          }
          if (escalated.length > 0) {
            for (const item of escalated) {
              if (!monitorEvidence.escalations.some((seen) => seen.requestId === item.requestId && seen.kind === item.kind)) {
                monitorEvidence.escalations.push(item)
              }
            }
            return { current, escalation: escalated }
          }
          return undefined
        }
        if (TERMINAL_RUN.has(status)) return { current, terminal: true }
        return undefined
      }, { timeoutMs: remaining(deadline), intervalMs: 2_000 })
      if (detail === undefined) {
        monitorEvidence.timeout = true
        throw new Error(`等待运行结束超时（${timeoutMs}ms）；诊断：${JSON.stringify(await runDiagnostics())}`)
      }
      runDetail = detail.current
      monitorEvidence.terminalStatus = runDetail?.run?.status
      if (detail.escalation !== undefined) {
        throw new Error(`运行出现明确升级待办：${JSON.stringify(detail.escalation.map((item) => ({ nodeId: item.nodeId, requestId: item.requestId, kind: item.kind })))}；诊断：${JSON.stringify(await runDiagnostics())}`)
      }
      const status = runDetail?.run?.status
      if (status !== 'succeeded') {
        throw new Error(`运行终态是 ${String(status)}；诊断：${JSON.stringify(await runDiagnostics())}`)
      }
      return {
        status,
        startedAt: runDetail.run.startedAt,
        endedAt: runDetail.run.endedAt,
        nodes: Object.keys(runDetail.run.nodes ?? {}).length,
        waitingSnapshots: monitorEvidence.waitingSnapshots.length,
        autoAnswerFiles: monitorEvidence.autoAnswerFiles.length,
      }
    }, (value) => value)

    // 10. 采集真实 trace / 探针快照 / 待办 / 评审 / 审计。
    // 先等自动代答收尾，再读待办，避免终态后最后一条 agent 答复尚未落盘。
    await delay(3_000)
    attentionItems = await panelReadSafe('attention').catch(() => [])
    if (!Array.isArray(attentionItems)) attentionItems = []
    runEvents = await panelReadSafe('events', { runId })
    if (!Array.isArray(runEvents)) runEvents = []
    // judge 只在真有失败需要模型判决时才会启动 harness；健康首轮全通过时 judge 节点
    // succeeded 但不调用模型、不产生 judge trace。不能无条件要求 judge trace。
    const judgeModelRan = runEvents.some((event) => event?.runId === runId
      && sameNodeId(event.nodeId, LOOP_JUDGE)
      && (event.type === 'harness.started' || event.type === 'judge.verdict'))
    // 只有 judge 节点真实执行（succeeded 且 attempts>=1）时，才可能“无需模型”；
    // 节点缺失/未执行/失败时不能把缺失或失败伪装成无需模型。
    const judgeNode = runDetail?.run?.nodes?.[LOOP_JUDGE]
      ?? Object.entries(runDetail?.run?.nodes ?? {}).find(([id]) => id.endsWith('/judge'))?.[1]
    const judgeAttempts = Number(judgeNode?.attempts ?? 0)
    const judgeSucceeded = judgeNode?.status === 'succeeded'
    const judgeExecuted = judgeSucceeded && judgeAttempts >= 1
    const judgeExecution = {
      status: judgeNode?.status ?? null,
      attempts: judgeAttempts,
      succeeded: judgeSucceeded,
      executed: judgeExecuted,
      modelRan: judgeModelRan,
      modelNotNeeded: judgeExecuted && !judgeModelRan,
    }
    const requiredTraceRoles = REQUIRED_TRACE_ROLES.filter((role) => role !== 'judge' || judgeModelRan)
    let lastTraces = []
    traces = await poll(async () => {
      try {
        const value = await fetchTrace()
        lastTraces = value
        const roles = new Set(value.map((trace) => trace?.role))
        return requiredTraceRoles.every((role) => roles.has(role)) ? value : undefined
      } catch {
        return undefined
      }
    }, { timeoutMs: Math.min(remaining(deadline), 60_000), intervalMs: 1_000 }) ?? lastTraces
    let lastProbe = {}
    probeChildren = await poll(async () => {
      try {
        const value = await fetchProbe()
        lastProbe = value
        const children = Array.isArray(value.children) ? value.children : []
        // 必需角色的探针必须全部完成；任意一个 child 完成不能代表 dev/reviewer/test-designer 都跑过。
        // raw catalog 只是诊断：host registry 合并 global 层，不能当作 Agent 可见目录的硬门禁。
        const ready = PROBE_ROLES.every((role) => children.some((child) => child?.runId === runId
          && child.role === role
          && child.pending === false
          && (role === 'test-designer'
            ? child.read?.completed === true
            : child.skill?.completed === true
              && child.skillOther?.completed === true
              && child.globalSkill?.completed === true
              && child.visibility !== undefined)))
        return ready ? children : undefined
      } catch {
        return undefined
      }
    }, { timeoutMs: Math.min(remaining(deadline), 60_000), intervalMs: 1_000 })
      ?? (Array.isArray(lastProbe.children) ? lastProbe.children : [])
    probeMeta = lastProbe
    const pendingForRun = (await attentionPendingForRun().catch(() => []))
    const escalations = [
      ...monitorEvidence.escalations,
      ...pendingForRun.map((item) => ({
        requestId: item.requestId,
        nodeId: item.nodeId,
        form: item.form,
        ask: item.ask,
        attempt: item.attempt,
        kind: 'pending-at-terminal',
      })),
    ]
    if (escalations.length > 0) result.evidence.escalations = escalations
    result.evidence.trace = {
      count: traces.length,
      roles: [...new Set(traces.map((trace) => trace.role))].sort(),
      denials: traces.reduce((sum, trace) => sum + (Array.isArray(trace.denials) ? trace.denials.length : 0), 0),
      records: traces.map((trace) => ({
        role: trace.role,
        nodeId: trace.nodeId,
        attempt: trace.attempt,
        sessionId: trace.sessionId,
        status: trace.status,
        preset: trace.preset?.id ?? trace.preset,
        skills: Array.isArray(trace.profile?.skills) ? trace.profile.skills : undefined,
        denials: Array.isArray(trace.denials) ? trace.denials : [],
        usage: trace.usage,
      })),
    }
    result.evidence.probe = {
      count: probeChildren.length,
      globalSkill: probeMeta.globalSkill,
      roleSamples: probeMeta.roleSamples,
      children: probeChildren.map((child) => ({
        childId: child.childId,
        sessionId: child.sessionId,
        runId: child.runId,
        role: child.role,
        nodeId: child.nodeId,
        attempt: child.attempt,
        preset: child.preset,
        pending: child.pending,
        tools: child.tools,
        skill: child.skill,
        skillOther: child.skillOther,
        globalSkill: child.globalSkill,
        visibility: child.visibility,
        catalog: child.catalog,
        read: child.read,
        error: child.error,
      })),
    }
    result.evidence.events = {
      count: runEvents.length,
      types: [...new Set(runEvents.map((event) => event?.type))].filter(Boolean).sort(),
    }

    // 11. 断言：full 不产生人工回答、没有升级。
    await check('no-escalation', async () => {
      if (escalations.length > 0) {
        throw new Error(`运行升级给人：${JSON.stringify(escalations)}`)
      }
      const pendingNow = await attentionPendingForRun()
      if (pendingNow.length > 0) throw new Error(`运行结束时仍有待办：${JSON.stringify(pendingNow.map((item) => ({ nodeId: item.nodeId, requestId: item.requestId })))}`)
      const humanAnswered = attentionItems.filter((item) => item?.runId === runId && item?.answeredBy?.type === 'human')
      if (humanAnswered.length > 0) throw new Error(`full 运行里出现人工回答：${JSON.stringify(humanAnswered.map((item) => item.requestId))}`)
      const status = runDetail?.run?.status
      if (status === 'waiting_human') throw new Error('运行停在 waiting_human，说明 AI 代答没有完成')
      return { pending: 0, humanAnswered: 0, escalations: 0 }
    }, (value) => value)

    // 12. 交叉评审：从本 run 的 review.round 事件累计轮次，至少 2 个不同 reviewer。
    await check('reviews-cross', async () => {
      if (runEvents.length === 0) throw new Error('本 run 没有事件记录，无法验证评审轮次')
      const observed = {}
      for (const nodeId of REVIEW_NODES) {
        const rounds = eventsOfNode(runEvents, runId, nodeId, 'review.round')
        if (rounds.length === 0) throw new Error(`评审节点 ${nodeId} 没有 review.round 事件`)
        const sorted = rounds.slice().sort((a, b) => Number(a?.data?.round ?? 0) - Number(b?.data?.round ?? 0))
        const latest = sorted.at(-1)
        if (latest?.data?.passed !== true) throw new Error(`评审节点 ${nodeId} 最新一轮没有通过`)
        const reviewers = [...new Set(rounds.flatMap((event) => (Array.isArray(event?.data?.verdicts)
          ? event.data.verdicts.map((verdict) => verdict?.reviewer)
          : []).filter((reviewer) => typeof reviewer === 'string' && reviewer !== '')))]
        if (reviewers.length < 2) throw new Error(`评审节点 ${nodeId} 只有 ${reviewers.length} 个 reviewer：${reviewers.join(',')}`)
        observed[nodeId] = { rounds: rounds.length, maxRound: Number(latest?.data?.round ?? rounds.length), reviewers }
      }
      return observed
    }, (value) => value)

    // 13. 读守卫：test-designer 真实读产品代码被拒，trace.denials 必须对应同一次执行/path。
    await check('denials-read', async () => {
      const probes = probeChildren.filter((child) => child?.runId === runId && child?.role === 'test-designer' && child.pending === false)
      if (probes.length === 0) throw new Error('真实子 Agent 探针没有完成的 test-designer 记录')
      const matched = []
      for (const probe of probes) {
        if (probe.read === undefined) throw new Error(`test-designer 探针缺少 read 结果：${String(probe.childId)}`)
        if (probe.read.toolMissing === true) throw new Error(`test-designer 子会话没有 read 工具：${String(probe.childId)}`)
        if (probe.read.protocolError === true) throw new Error(`test-designer read 执行异常，不能算守卫拒绝：${String(probe.read.error ?? probe.read.message)}`)
        if (probe.read.completed !== true) throw new Error('test-designer read 没有完成工具调用')
        if (probe.read.isError !== true) throw new Error(`test-designer 竟然能读取产品代码：${String(probe.read.path)}`)
        if (probe.read.denial !== true) throw new Error(`test-designer read 报错不是明确的守卫拒绝：${String(probe.read.message ?? probe.read.text).slice(0, 300)}`)
        if (!READ_DENIAL_RE.test(`${String(probe.read.message ?? '')}\n${String(probe.read.text ?? '')}`)) {
          throw new Error('test-designer read 的报错文本不含明确拒绝语义，不能算守卫拒绝')
        }
        const trace = traces.find((item) => sameTraceExecution(item, probe))
        if (trace === undefined) throw new Error(`test-designer 探针没有同 session/run/node/attempt 的 trace：${String(probe.sessionId)}`)
        if (trace.role !== 'test-designer') throw new Error(`匹配到的 trace 角色不是 test-designer：${String(trace.role)}`)
        const denial = (Array.isArray(trace.denials) ? trace.denials : [])
          .find((item) => item?.tool === 'read'
            && (sameDenialPath(item?.path, probe.read.path, probe.scope?.cwd)
              || sameDenialPath(item?.path, probe.read.path, spaceRoot)))
        if (denial === undefined) throw new Error(`trace.denials 没有同一次 read 的 path 拒绝：${String(probe.read.path)}`)
        if (typeof denial.reason !== 'string' || denial.reason.trim() === '') throw new Error('trace denial 缺少 reason')
        matched.push({
          probe: { sessionId: probe.sessionId, nodeId: probe.nodeId, attempt: probe.attempt, path: probe.read.path },
          trace: { sessionId: trace.sessionId, nodeId: trace.nodeId, attempt: trace.attempt, path: denial.path, reason: denial.reason },
        })
      }
      return { matched }
    }, (value) => value)

    // 14. Skill 隔离：真实工具描述/目录 + 自己的 Skill 真读到 + 其它/global 明确白名单拒绝。
    await check('skills-isolated', async () => {
      const probes = probeChildren.filter((child) => child?.runId === runId
        && (child?.role === 'dev' || child?.role === 'reviewer')
        && child.pending === false)
      if (probes.length === 0) throw new Error('真实子 Agent 探针没有完成的 dev/reviewer 记录')
      const roles = new Set(probes.map((probe) => probe.role))
      if (!roles.has('dev')) throw new Error('探针缺少 dev 角色')
      if (!roles.has('reviewer')) throw new Error('探针缺少 reviewer 角色')
      if (probeMeta.globalSkill?.registered !== true) {
        throw new Error(`global-forbidden 探针 Skill 没有注册成功：${String(probeMeta.globalSkill?.error ?? '')}`)
      }
      const checked = []
      for (const probe of probes) {
        const own = probe.role === 'dev' ? 'skill-alpha' : 'skill-beta'
        const other = probe.role === 'dev' ? 'skill-beta' : 'skill-alpha'
        const marker = SKILL_MARKERS[own]
        if (!Array.isArray(probe.tools) || !probe.tools.includes('skill')) throw new Error(`${probe.role} 真实工具清单没有 skill：${JSON.stringify(probe.tools)}`)
        if (probe.error !== undefined) throw new Error(`${probe.role} 探针异常：${String(probe.error)}`)
        for (const [field, label] of [['skill', '自己的 Skill'], ['skillOther', '其它角色 Skill'], ['globalSkill', 'global Skill']]) {
          const value = probe[field]
          if (value === undefined) throw new Error(`${probe.role} 缺少 ${label} 探针结果`)
          if (value.toolMissing === true) throw new Error(`${probe.role} 的 ${label} 工具缺失，不能算白名单拒绝`)
          if (value.protocolError === true) throw new Error(`${probe.role} 的 ${label} 执行异常，不能算白名单拒绝：${String(value.error ?? value.message)}`)
          if (value.completed !== true) throw new Error(`${probe.role} 的 ${label} 工具调用没有完成`)
        }
        if (probe.skill.isError === true) throw new Error(`${probe.role} 读取自己声明的 ${own} 失败：${JSON.stringify(probe.skill)}`)
        if (!String(probe.skill.text ?? '').includes(marker)) throw new Error(`${probe.role} 的 ${own} 内容缺少 ${marker}`)
        if (probe.skillOther.isError !== true || probe.skillOther.denial !== true) {
          throw new Error(`${probe.role} 读取未声明 ${other} 没有明确白名单拒绝：${JSON.stringify(probe.skillOther)}`)
        }
        if (!SKILL_DENIAL_RE.test(`${String(probe.skillOther.message ?? '')}\n${String(probe.skillOther.text ?? '')}`)) {
          throw new Error(`${probe.role} 读取 ${other} 的报错不含明确白名单拒绝语义`)
        }
        if (probe.globalSkill.isError !== true || probe.globalSkill.denial !== true) {
          throw new Error(`${probe.role} 读取 global-forbidden 没有明确白名单拒绝：${JSON.stringify(probe.globalSkill)}`)
        }
        if (!SKILL_DENIAL_RE.test(`${String(probe.globalSkill.message ?? '')}\n${String(probe.globalSkill.text ?? '')}`)) {
          throw new Error(`${probe.role} 读取 global-forbidden 的报错不含明确白名单拒绝语义`)
        }
        if (probe.visibility?.found !== true) throw new Error(`${probe.role} 子会话没有 skill 工具描述，无法验证可见目录`)
        // 自己的 Skill 是否列在工具描述里因实现而异；真实读取成功才是硬证据。
        // 但其它角色 Skill 与 global-forbidden 一旦出现在工具描述里就是可见性泄漏。
        if (probe.visibility.otherVisible !== false) throw new Error(`${probe.role} 的 skill 工具描述泄漏了 ${other}`)
        if (probe.visibility.globalVisible !== false) throw new Error(`${probe.role} 的 skill 工具描述泄漏了 global-forbidden`)
        // raw 宿主 registry（ctx.skills.list/snapshot）合并 global 层，是特权诊断视角，
        // 不是 Agent 工具可见面；global/other 出现在 raw catalog 是预期，不作为硬门禁。
        // Agent 可见性硬门禁仍是工具描述不泄漏 + 自己的 Skill 真实读成功 + 其它/global 明确拒绝。
        const rawCatalog = probe.catalog ?? {}
        const catalogNames = Array.isArray(rawCatalog.names) ? rawCatalog.names : []
        const catalog = {
          available: rawCatalog.available === true,
          completed: rawCatalog.completed === true,
          complete: rawCatalog.complete !== false,
          ownPresent: catalogNames.includes(own),
          otherPresent: catalogNames.includes(other),
          globalLayerPresent: catalogNames.includes(GLOBAL_FORBIDDEN_SKILL),
          names: catalogNames,
          error: rawCatalog.error === undefined ? undefined : String(rawCatalog.error),
        }
        const trace = traces.find((item) => sameTraceExecution(item, probe))
        if (trace === undefined) throw new Error(`${probe.role} 探针没有同 session/run/node/attempt 的 trace：${String(probe.sessionId)}`)
        if (trace.role !== probe.role) throw new Error(`匹配到的 trace 角色是 ${String(trace.role)}，不是 ${probe.role}`)
        const traceSkills = Array.isArray(trace.profile?.skills) ? trace.profile.skills : []
        if (!traceSkills.includes(own)) throw new Error(`${probe.role} trace profile.skills 没有 ${own}：${JSON.stringify(traceSkills)}`)
        if (traceSkills.includes(other)) throw new Error(`${probe.role} trace profile.skills 泄漏了 ${other}：${JSON.stringify(traceSkills)}`)
        checked.push({
          role: probe.role,
          sessionId: probe.sessionId,
          nodeId: probe.nodeId,
          attempt: probe.attempt,
          own,
          other,
          otherDenied: probe.skillOther.denial,
          globalDenied: probe.globalSkill.denial,
          catalog,
          toolDescription: probe.visibility.toolDescription.slice(0, 300),
        })
      }
      return { checked }
    }, (value) => value)

    // 15. 角色身份必须精确：release-reviewer 不能被 reviewer 的包含匹配吃掉。
    await check('role-exact', async () => {
      const samples = probeMeta.roleSamples ?? {}
      const expected = {
        'taktflow-release-reviewer': 'release-reviewer',
        'release-reviewer': 'release-reviewer',
        'taktflow-reviewer': 'reviewer',
        'taktflow-dev': 'dev',
        'taktflow-test-designer': 'test-designer',
      }
      for (const [preset, role] of Object.entries(expected)) {
        if (samples[preset] !== role) throw new Error(`角色匹配 ${preset} 得到 ${String(samples[preset])}，应为 ${role}`)
      }
      const traceRoles = [...new Set(traces.map((trace) => trace?.role).filter(Boolean))].sort()
      const missingRoles = requiredTraceRoles.filter((role) => !traceRoles.includes(role))
      if (missingRoles.length > 0) throw new Error(`本 run 缺少职责角色 trace：${missingRoles.join(',')}`)
      for (const trace of traces) {
        const preset = String(trace?.preset?.id ?? trace?.preset ?? '').toLowerCase()
        if (preset.includes('release-reviewer') && trace.role !== 'release-reviewer') {
          throw new Error(`trace preset ${preset} 被错误识别为 ${String(trace.role)}`)
        }
        if (preset.includes('test-designer') && trace.role !== 'test-designer') {
          throw new Error(`trace preset ${preset} 被错误识别为 ${String(trace.role)}`)
        }
        if (preset.includes('reviewer') && !preset.includes('release-reviewer') && trace.role !== 'reviewer') {
          throw new Error(`trace preset ${preset} 被错误识别为 ${String(trace.role)}`)
        }
      }
      for (const probe of probeChildren.filter((child) => child?.runId === runId && child.pending === false)) {
        const preset = String(probe?.preset ?? '').toLowerCase()
        if (preset.includes('release-reviewer') && probe.role !== 'release-reviewer') {
          throw new Error(`探针 preset ${preset} 被错误识别为 ${String(probe.role)}`)
        }
        if (preset.includes('test-designer') && probe.role !== 'test-designer') {
          throw new Error(`探针 preset ${preset} 被错误识别为 ${String(probe.role)}`)
        }
      }
      return {
        samples: expected,
        traceRoles,
        missingRoles: [],
        requiredRoles: requiredTraceRoles,
        judgeModelRan,
        judgeModelNotNeeded: judgeExecution.modelNotNeeded,
        judgeExecution,
      }
    }, (value) => value)

    // 16. 用例执行 + 判决环至少一轮；judge 必须真正 succeeded。
    await check('loop-ran', async () => {
      const nodes = runDetail?.run?.nodes ?? {}
      const runCases = nodes[LOOP_RUN] ?? Object.entries(nodes).find(([id]) => id.endsWith('/run-cases'))?.[1]
      const judge = nodes[LOOP_JUDGE] ?? Object.entries(nodes).find(([id]) => id.endsWith('/judge'))?.[1]
      if (runCases === undefined) throw new Error(`运行节点里没有 ${LOOP_RUN}`)
      if (judge === undefined) throw new Error(`运行节点里没有 ${LOOP_JUDGE}`)
      if (runCases.status !== 'succeeded') throw new Error(`run-cases 状态是 ${String(runCases.status)}`)
      if (judge.status !== 'succeeded') throw new Error(`judge 状态是 ${String(judge.status)}`)
      if ((runCases.attempts ?? 0) < 1) throw new Error('run-cases 没有执行尝试')
      if ((judge.attempts ?? 0) < 1) throw new Error('judge 没有执行尝试')
      return {
        runCases: { status: runCases.status, attempts: runCases.attempts, iteration: runCases.iteration },
        judge: { status: judge.status, attempts: judge.attempts, iteration: judge.iteration },
      }
    }, (value) => value)

    // 17. 真实节点生成的业务产物：PRD、测试计划、用例、runner；启动前已断言不存在 seed。
    await check('generated-artifacts', async () => {
      const workspace = await requirementDir()
      const prdText = await readArtifactText('spec/prd.md')
      if (prdText === undefined || prdText.trim() === '') throw new Error('没有真实生成的 spec/prd.md')
      const acs = [...new Set(prdText.match(/\bAC-\d+(?:-\d+)?\b/g) ?? [])]
      if (acs.length === 0) throw new Error('spec/prd.md 没有 AC 编号')
      const planText = await readArtifactText('test-plan/plan.md')
      if (planText === undefined || planText.trim() === '') throw new Error('没有真实生成的 test-plan/plan.md')
      const caseFiles = await listFiles(path.join(workspace, 'cases'), (file) => file.endsWith('.json'))
      if (caseFiles.length === 0) throw new Error('没有真实生成的 cases/*.json')
      const cases = []
      for (const file of caseFiles) {
        let parsed
        try {
          parsed = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          throw new Error(`用例文件不是 JSON：${path.basename(file)}`)
        }
        if (typeof parsed?.id !== 'string' || parsed.id.trim() === '') throw new Error(`用例缺少 id：${path.basename(file)}`)
        if (!Array.isArray(parsed.covers) || parsed.covers.length === 0) throw new Error(`用例 ${parsed.id} 缺少 covers`)
        const covers = parsed.covers.filter((cover) => typeof cover === 'string' && /^AC-\d+(?:-\d+)?$/.test(cover.trim()))
        if (covers.length === 0) throw new Error(`用例 ${parsed.id} 没有合法 AC 覆盖`)
        cases.push({ id: parsed.id, covers, file: path.basename(file) })
      }
      const ids = cases.map((item) => item.id)
      if (new Set(ids).size !== ids.length) throw new Error(`用例 ID 重复：${ids.join(',')}`)
      const covered = new Set(cases.flatMap((item) => item.covers))
      const missingAcs = acs.filter((ac) => !covered.has(ac))
      if (missingAcs.length > 0) throw new Error(`用例没有覆盖 AC：${missingAcs.join(',')}`)
      const scripts = await readArtifactText('scripts/run-cases.mjs')
      if (scripts === undefined || scripts.trim() === '') throw new Error('没有真实生成的 scripts/run-cases.mjs')
      // 标准 hooks 从空间根 tests/run-cases.mjs 读取实际执行脚本，并复制到集成 worktree 的 tests/。
      const spaceTests = path.join(spaceRoot, 'tests', 'run-cases.mjs')
      if (!(await fileExists(spaceTests))) throw new Error('空间根 tests/run-cases.mjs 不存在')
      const spaceTestsText = await readFile(spaceTests, 'utf8')
      if (spaceTestsText !== scripts) throw new Error('空间根 tests/run-cases.mjs 与 scripts/run-cases.mjs 不是逐字节一致')
      const integrationNode = runDetail?.run?.nodes?.integration
        ?? Object.entries(runDetail?.run?.nodes ?? {}).find(([id]) => leafNodeId(id) === 'integration')?.[1]
      const integrationResult = integrationNode?.result
      const integrationPath = typeof integrationResult?.path === 'string' && integrationResult.path !== ''
        ? integrationResult.path
        : (typeof integrationResult?.data?.path === 'string' && integrationResult.data.path !== ''
          ? integrationResult.data.path
          : (await readJsonFileIfExists(await requirementFile('tasks/integration.json'))?.path))
      if (typeof integrationPath !== 'string' || integrationPath === '') {
        throw new Error('没有集成 worktree 路径，无法核对实际执行脚本')
      }
      integrationWorktreePath = integrationPath
      const worktreeTests = path.join(integrationPath, 'tests', 'run-cases.mjs')
      if (!(await fileExists(worktreeTests))) throw new Error('集成 worktree tests/run-cases.mjs 不存在')
      const worktreeTestsText = await readFile(worktreeTests, 'utf8')
      if (worktreeTestsText !== scripts) throw new Error('集成 worktree tests/run-cases.mjs 与 scripts/run-cases.mjs 不是逐字节一致')
      generatedArtifacts = {
        acs,
        plan: { path: 'test-plan/plan.md', bytes: planText.length },
        cases: { count: cases.length, ids, covers: Object.fromEntries(cases.map((item) => [item.id, item.covers])) },
        runner: {
          scriptsBytes: scripts.length,
          spaceTestsIdentical: true,
          integrationWorktreeIdentical: true,
        },
      }
      result.evidence.generatedArtifacts = generatedArtifacts
      return generatedArtifacts
    }, (value) => value)

    // 17b. 独立产品验收：直接 require 集成 worktree 的产品文件，不采信 AI 报告。
    await check('product-acceptance', async () => {
      if (generatedArtifacts === undefined) throw new Error('generated-artifacts 未通过，无法定位集成 worktree')
      if (typeof integrationWorktreePath !== 'string' || integrationWorktreePath === '') {
        throw new Error('没有集成 worktree 路径，无法执行产品验收')
      }
      if (typeof appFixture?.head !== 'string' || appFixture.head === '') throw new Error('缺少 fixture 初始 HEAD')
      const ownedSpace = await realpath(spaceRoot)
      const integration = await realpath(integrationWorktreePath)
      if (!integration.startsWith(`${ownedSpace}${path.sep}`)) {
        throw new Error(`集成 worktree 不在本次 owned space 内：${integration}`)
      }

      // 独立 Node 断言：execFile 参数、不走 shell；checker 不继承模型 key。
      const checkerEnv = { ...process.env }
      delete checkerEnv.TAKT_E2E_API_KEY
      let assertions
      try {
        const output = await runCommand(process.execPath, ['-e', PRODUCT_ASSERTION_SCRIPT], {
          cwd: integration,
          env: checkerEnv,
          timeoutMs: 30_000,
          secrets: [],
          label: 'product acceptance assertions',
        })
        assertions = JSON.parse(output.stdout)
      } catch (error) {
        const raw = error?.stdout
        try {
          assertions = JSON.parse(raw)
        } catch {
          throw new Error(`独立产品断言执行失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!Array.isArray(assertions) || assertions.length !== 6) {
        throw new Error(`独立产品断言数量不是 6：${String(assertions?.length)}`)
      }
      const failedAssertions = assertions.filter((item) => item?.pass !== true)
      if (failedAssertions.length > 0) {
        throw new Error(`独立产品断言失败：${failedAssertions
          .map((item) => `${String(item?.name)} 实际 ${String(item?.actual)} 期望 ${String(item?.expected)}`)
          .join('；')}`)
      }

      // 产品改动范围：提交里只能有 src/add.js；框架复制但未提交的 tests/runner 不算产品 commit。
      const base = appFixture.head
      const integrationHead = (await runCommand('git', ['rev-parse', 'HEAD'], {
        cwd: integration,
        timeoutMs: 60_000,
        secrets,
        label: 'integration HEAD',
      })).stdout.trim()
      const changed = (await runCommand('git', ['diff', '--name-only', `${base}..${integrationHead}`], {
        cwd: integration,
        timeoutMs: 60_000,
        secrets,
        label: 'integration product diff',
      })).stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      if (changed.length !== 1 || changed[0] !== 'src/add.js') {
        throw new Error(`集成提交的产品改动不是仅 src/add.js：${changed.join(',') || '(空)'}`)
      }
      const expectedPackage = `${JSON.stringify(APP_PACKAGE_JSON, null, 2)}\n`
      if ((await readFile(path.join(integration, 'src', 'add.test.js'), 'utf8')) !== INITIAL_ADD_TEST) {
        throw new Error('集成 worktree 的 src/add.test.js 与初始基线不一致')
      }
      if ((await readFile(path.join(integration, 'package.json'), 'utf8')) !== expectedPackage) {
        throw new Error('集成 worktree 的 package.json 与初始基线不一致')
      }

      // 原 app 根 HEAD/代码必须未变，证明产品写入发生在 worktree。
      const appHead = (await runCommand('git', ['rev-parse', 'HEAD'], {
        cwd: appDir,
        timeoutMs: 60_000,
        secrets,
        label: 'app root HEAD',
      })).stdout.trim()
      if (appHead !== base) throw new Error(`原 app 根 HEAD 变化：${base} -> ${appHead}`)
      if ((await readFile(path.join(appDir, 'src', 'add.js'), 'utf8')) !== INITIAL_ADD) {
        throw new Error('原 app 根 src/add.js 被修改')
      }
      if ((await readFile(path.join(appDir, 'src', 'add.test.js'), 'utf8')) !== INITIAL_ADD_TEST) {
        throw new Error('原 app 根 src/add.test.js 被修改')
      }
      if ((await readFile(path.join(appDir, 'package.json'), 'utf8')) !== expectedPackage) {
        throw new Error('原 app 根 package.json 被修改')
      }

      const acceptance = {
        assertions,
        passed: assertions.length,
        total: assertions.length,
        productFiles: changed,
        appHeadUnchanged: true,
      }
      result.evidence.productAcceptance = acceptance
      return acceptance
    }, (value) => value)

    // 18. evidence/summary.json：真实生成 case 全部 passed，且每条都有证据。
    await check('evidence-summary', async () => {
      if (generatedArtifacts === undefined) throw new Error('generated-artifacts 未通过，无法核对 evidence')
      const text = await readArtifactText('evidence/summary.json')
      if (text === undefined) throw new Error('没有 evidence/summary.json')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('evidence/summary.json 不是 JSON')
      }
      const rows = Array.isArray(parsed?.cases) ? parsed.cases : undefined
      if (rows === undefined) throw new Error('evidence/summary.json 没有 cases 数组')
      if (rows.length === 0) throw new Error('evidence/summary.json 没有用例行')
      for (const id of generatedArtifacts.cases.ids) {
        const row = rows.find((entry) => entry?.id === id)
        if (row === undefined) throw new Error(`evidence 缺少生成用例 ${id}`)
        if (row.status !== 'passed') throw new Error(`生成用例 ${id} 状态是 ${String(row.status)}：${String(row.evidence ?? '')}`)
        const evidenceText = typeof row.evidence === 'string' ? row.evidence.trim() : row.evidence
        if (evidenceText === undefined || evidenceText === null || evidenceText === '') throw new Error(`生成用例 ${id} 缺少 evidence`)
      }
      const failed = rows.filter((row) => row?.status !== 'passed')
      if (failed.length > 0) throw new Error(`evidence 仍有失败用例：${failed.map((row) => row.id).join(',')}`)
      evidenceSummary = {
        rows: rows.length,
        passed: rows.filter((row) => row?.status === 'passed').length,
        caseIds: generatedArtifacts.cases.ids,
      }
      result.evidence.evidenceSummary = evidenceSummary
      return evidenceSummary
    }, (value) => value)

    // 19. 质量报告真实产出，统计必须与生成 case 数量一致，AC 表覆盖全部 AC。
    await check('quality-report', async () => {
      if (generatedArtifacts === undefined || evidenceSummary === undefined) {
        throw new Error('generated-artifacts / evidence-summary 未通过，无法核对质量报告')
      }
      const text = await readArtifactText('reports/quality.md')
      if (text === undefined) throw new Error('没有 reports/quality.md')
      if (!text.includes('# 质量报告')) throw new Error('quality.md 缺少标题')
      const match = /用例\s*(\d+)\s*条，通过\s*(\d+)\s*条/.exec(text)
      if (match === null) throw new Error('quality.md 缺少“用例 N 条，通过 M 条”统计')
      const total = Number(match[1])
      const passed = Number(match[2])
      if (total !== generatedArtifacts.cases.count) throw new Error(`quality 用例数 ${total} 与生成 case 数 ${generatedArtifacts.cases.count} 不一致`)
      if (passed !== total) throw new Error(`quality 通过数 ${passed} 与用例数 ${total} 不一致`)
      for (const ac of generatedArtifacts.acs) {
        if (!new RegExp(`\\|\\s*${ac}\\s*\\|`).test(text)) throw new Error(`quality.md 的 AC 表缺少 ${ac}`)
      }
      return { bytes: text.length, total, passed, acs: generatedArtifacts.acs }
    }, (value) => value)

    // 18. AI 代答留痕：每个门禁按自己的 requestId 核对 actor/答复/决策产物/依据。
    await check('auto-answers', async () => {
      // 以最新待办为准；终态后仍可能有最后一条 agent 答复刚落盘。
      attentionItems = await attentionAll().catch(() => attentionItems)
      if (!Array.isArray(attentionItems)) attentionItems = []
      const expected = await readBindingUser()
      if (typeof expected !== 'string' || expected === '') {
        throw new Error('没有需求绑定人，无法核对 AI 代答的 onBehalfOf')
      }
      const answered = attentionItems.filter((item) => item?.runId === runId
        && typeof item?.answeredAt === 'string' && item.answeredAt !== '')
      const byNode = {}
      const artifactPaths = new Set()
      const contents = []
      for (const nodeId of ['answer-clarify', 'acceptance']) {
        // 同一节点可能因 rework/重试产生多条待办；只认最后一次真实答复。
        const item = answered
          .filter((entry) => sameNodeId(entry?.nodeId, nodeId))
          .sort((a, b) => Number(a?.attempt ?? 0) - Number(b?.attempt ?? 0)
            || String(a?.answeredAt ?? '').localeCompare(String(b?.answeredAt ?? '')))
          .at(-1)
        if (item === undefined) throw new Error(`待办 ${nodeId} 没有被 AI 代答`)
        if (typeof item.requestId !== 'string' || item.requestId === '') throw new Error(`待办 ${nodeId} 没有 requestId`)
        if (item.answeredBy?.type !== 'agent') throw new Error(`待办 ${nodeId} 的 actor 不是 agent：${JSON.stringify(item.answeredBy)}`)
        if (typeof item.answeredBy?.role !== 'string' || item.answeredBy.role.trim() === '') {
          throw new Error(`待办 ${nodeId} 的 agent actor 没有角色`)
        }
        if (item.answeredBy?.onBehalfOf !== expected) {
          throw new Error(`待办 ${nodeId} 的 onBehalfOf 是 ${String(item.answeredBy?.onBehalfOf)}，不是绑定人 ${expected}`)
        }
        const proof = answerProof(item)
        if (proof === '') throw new Error(`待办 ${nodeId} 没有非空答复或决定`)
        const rel = await findAutoAnswer(item.requestId)
        if (rel === undefined) throw new Error(`待办 ${nodeId} 没有引用 ${item.requestId} 的 auto-answer 决策产物`)
        if (artifactPaths.has(rel)) throw new Error(`待办 ${nodeId} 复用了其它门禁的决策产物：${rel}`)
        artifactPaths.add(rel)
        const text = await readArtifactText(rel)
        if (text === undefined) throw new Error(`auto-answer 产物不可读：${rel}`)
        if (!text.includes(item.requestId)) throw new Error(`auto-answer 产物没有引用 requestId ${item.requestId}`)
        const nodeNames = [item.nodeId, leafNodeId(item.nodeId)].filter((value) => typeof value === 'string' && value !== '')
        if (!nodeNames.some((name) => new RegExp(`节点[：:][^\\n]*${escapeRegExp(name)}`).test(text))) {
          throw new Error(`auto-answer 产物没有对应节点 ${String(item.nodeId)}`)
        }
        const disposition = typeof item.decision === 'string' && item.decision.trim() !== '' ? item.decision.trim() : 'answer'
        if (!new RegExp(`处置[：:]\\s*${escapeRegExp(disposition)}`).test(text)) {
          throw new Error(`auto-answer 产物处置不是 ${disposition}`)
        }
        if (!new RegExp(`代表[：:]\\s*${escapeRegExp(expected)}`).test(text)) {
          throw new Error(`auto-answer 产物代表不是绑定人 ${expected}`)
        }
        if (!/(?:^|\n)-?\s*角色[：:]\s*\S+/.test(text)) throw new Error('auto-answer 产物缺少角色留痕')
        const answerSection = markdownSection(text, '回答')
        if (answerSection === undefined || answerSection === '') throw new Error('auto-answer 产物缺少 ## 回答 正文')
        if (!proofPresent(answerSection, proof) && !proofPresent(text, proof)) {
          throw new Error(`auto-answer 产物没有包含本次答复：${proof.slice(0, 80)}`)
        }
        const basisSection = markdownSection(text, '依据产物')
        if (basisSection === undefined || basisSection === '') throw new Error('auto-answer 产物缺少 ## 依据产物 正文')
        if (!basisSection.split('\n').some((line) => /^[-*]\s+\S/.test(line.trim()))) {
          throw new Error('auto-answer 产物没有列出任何依据产物')
        }
        const reasonSection = markdownSection(text, '理由')
        if (reasonSection === undefined || reasonSection === '') throw new Error('auto-answer 产物缺少 ## 理由 正文')
        byNode[nodeId] = {
          requestId: item.requestId,
          disposition,
          answeredBy: item.answeredBy,
          artifact: rel,
        }
        contents.push({
          nodeId,
          path: rel,
          bytes: text.length,
          requestId: item.requestId,
          disposition,
          proof: proof.slice(0, 120),
        })
      }
      autoAnswerEvidence = { binding: expected, byNode, artifacts: contents }
      result.evidence.autoAnswers = autoAnswerEvidence
      return autoAnswerEvidence
    }, (value) => value)

    // 19. 审计链 verify ok；本 run 非空事件且包含开始/结束和每次 AI 回答 actor。
    await check('audit-verify', async () => {
      const expected = await readBindingUser()
      if (typeof expected !== 'string' || expected === '') {
        throw new Error('没有需求绑定人，无法核对审计链的 AI 回答 actor')
      }
      const audit = await panelReadSafe('audit', { runId })
      if (audit === undefined) throw new Error('audit 面板不可用或没有返回')
      if (audit?.ok !== true) throw new Error(`audit verify 未通过：${JSON.stringify(audit).slice(0, 500)}`)
      if (audit?.brokenAt !== undefined) throw new Error(`audit verify 返回 brokenAt=${String(audit.brokenAt)}`)
      if (runEvents.length === 0) throw new Error('本 run 没有非空事件链，空日志的 ok 不能当审计通过')
      const started = runEvents.filter((event) => event?.runId === runId && event.type === 'run.started')
      const finished = runEvents.filter((event) => event?.runId === runId && event.type === 'run.finished')
      if (started.length === 0) throw new Error('本 run 事件链缺少 run.started')
      if (finished.length === 0) throw new Error('本 run 事件链缺少 run.finished')
      if (finished.at(-1)?.data?.status !== runDetail?.run?.status) {
        throw new Error(`run.finished 状态 ${String(finished.at(-1)?.data?.status)} 与运行状态 ${String(runDetail?.run?.status)} 不一致`)
      }
      const answered = runEvents.filter((event) => event?.runId === runId && event.type === 'human.answered')
      if (answered.length < 2) throw new Error(`本 run 只有 ${answered.length} 条 human.answered，缺少 AI 代答留痕`)
      const answeredNodes = new Set()
      for (const event of answered) {
        if (event.actor?.type === 'human') throw new Error(`本 run 出现人工回答：${String(event.data?.requestId)}`)
        if (event.actor?.type !== 'agent') throw new Error(`human.answered actor 不是 agent：${JSON.stringify(event.actor)}`)
        if (event.actor?.onBehalfOf !== expected) {
          throw new Error(`human.answered actor onBehalfOf 是 ${String(event.actor?.onBehalfOf)}，不是绑定人 ${expected}`)
        }
        if (typeof event.actor?.role !== 'string' || event.actor.role.trim() === '') {
          throw new Error('human.answered actor 缺少角色')
        }
        if (typeof event.data?.requestId !== 'string' || event.data.requestId === '') {
          throw new Error('human.answered 缺少 requestId')
        }
        const answerText = typeof event.data?.answer === 'string' ? event.data.answer.trim() : ''
        const decisionText = typeof event.data?.decision === 'string' ? event.data.decision.trim() : ''
        if (answerText === '' && decisionText === '') throw new Error(`human.answered ${event.data.requestId} 没有非空答复/决定`)
        const item = attentionItems.find((entry) => entry?.runId === runId && entry.requestId === event.data.requestId)
        if (item === undefined) throw new Error(`human.answered 的 requestId 没有对应待办：${event.data.requestId}`)
        if (item.answeredBy?.type !== 'agent') throw new Error(`待办 ${item.requestId} 的 answeredBy 不是 agent`)
        answeredNodes.add(leafNodeId(event.nodeId))
      }
      for (const nodeId of ['answer-clarify', 'acceptance']) {
        if (!answeredNodes.has(nodeId)) throw new Error(`本 run 的 human.answered 缺少节点 ${nodeId}`)
      }
      auditEvidence = {
        ok: true,
        eventCount: runEvents.length,
        startedAt: started.at(-1)?.ts ?? null,
        finishedAt: finished.at(-1)?.ts ?? null,
        finishedStatus: finished.at(-1)?.data?.status,
        humanAnswered: answered.length,
        answeredNodes: [...answeredNodes].filter(Boolean).sort(),
        binding: expected,
      }
      result.evidence.audit = auditEvidence
      return auditEvidence
    }, (value) => value)

    // 20. 耗时/token 覆盖/评审轮次：缺失 trace 和 usage 都计数，不用 0 冒充已观测。
    await check('metrics', async () => {
      const run = runDetail?.run ?? {}
      const started = Date.parse(String(run.startedAt ?? ''))
      const ended = Date.parse(String(run.endedAt ?? ''))
      const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null
      const nodes = Object.entries(run.nodes ?? {}).map(([id, node]) => ({
        id,
        status: node.status,
        attempts: node.attempts ?? 0,
        iteration: node.iteration ?? null,
        round: node.round ?? null,
        reworks: node.reworks ?? 0,
        inputTokens: node.usage?.inputTokens ?? null,
        outputTokens: node.usage?.outputTokens ?? null,
      }))
      const traceToken = traceTokenSummary(traces)
      let leadToken
      try {
        leadToken = leadTokenSummary(await readDigest())
      } catch (error) {
        leadToken = { observed: false, reason: `Lead 会话日志不可读：${error instanceof Error ? error.message : String(error)}` }
      }
      const traceRoles = [...new Set(traces.map((trace) => trace?.role).filter(Boolean))]
      const missingTraceRoles = requiredTraceRoles.filter((role) => !traceRoles.includes(role))
      const reviewEvents = runEvents.filter((event) => event?.runId === runId
        && typeof event.nodeId === 'string' && event.nodeId !== ''
        && event.type === 'review.round')
      const reviewRounds = {}
      for (const event of reviewEvents) {
        const nodeId = String(event.nodeId ?? '')
        if (nodeId === '') continue
        reviewRounds[nodeId] ??= { rounds: 0, maxRound: 0, latestPassed: null }
        reviewRounds[nodeId].rounds += 1
        reviewRounds[nodeId].maxRound = Math.max(reviewRounds[nodeId].maxRound, Number(event.data?.round ?? 0))
        reviewRounds[nodeId].latestPassed = event.data?.passed === true
      }
      const loopJudgeNode = run.nodes?.[LOOP_JUDGE]
        ?? Object.entries(run.nodes ?? {}).find(([id]) => id.endsWith('/judge'))?.[1]
      const loopRunNode = run.nodes?.[LOOP_RUN]
        ?? Object.entries(run.nodes ?? {}).find(([id]) => id.endsWith('/run-cases'))?.[1]
      const loopIteration = loopJudgeNode?.iteration ?? loopRunNode?.iteration ?? null
      const tokenObserved = traceToken.inputTokens !== null || leadToken.observed
      const tokenTotal = tokenObserved
        ? {
            inputTokens: (traceToken.inputTokens ?? 0) + (leadToken.observed ? leadToken.inputTokens : 0),
            outputTokens: (traceToken.outputTokens ?? 0) + (leadToken.observed ? leadToken.outputTokens : 0),
            includesLead: leadToken.observed,
          }
        : null
      const metrics = {
        durationMs,
        nodeCount: nodes.length,
        nodesUsageReported: nodes.filter((node) => node.inputTokens !== null).length,
        traceCoverage: {
          expectedRoles: requiredTraceRoles,
          observedRoles: traceRoles,
          missingRoles: missingTraceRoles,
          traceCount: traces.length,
          usageObserved: traceToken.observedCount,
          usageMissing: traceToken.missingCount,
          judgeModelRan,
          judgeModelNotNeeded: judgeExecution.modelNotNeeded,
          judgeExecution,
        },
        token: {
          scope: '职责 Agent trace 已观测值；Lead 单独标注是否可观测',
          trace: traceToken,
          lead: leadToken,
          total: tokenTotal,
        },
        missingUsageCount: traceToken.missingCount,
        missingUsage: traceToken.missing,
        missingTraceCount: missingTraceRoles.length,
        missingTraceRoles,
        reviewRounds,
        reviewRoundTotal: reviewEvents.length,
        loopIteration,
        loop: {
          runCases: loopRunNode?.iteration ?? null,
          judge: loopJudgeNode?.iteration ?? null,
        },
        escalations: result.evidence.escalations ?? [],
        nodes,
      }
      result.evidence.metrics = metrics
      if (durationMs === null) throw new Error('运行缺少 startedAt/endedAt，无法计算耗时')
      if (nodes.length === 0) throw new Error('运行没有节点记录')
      return metrics
    }, (value) => value)
  } catch (error) {
    failure = error
    result.error = error instanceof Error ? error.message : String(error)
    result.diagnostics = await runDiagnostics().catch(() => undefined)
    // 异常路径先采集证据，再进入 finally 停宿主/清理；不能让唯一证据随 home 删除。
    result.evidence.failureSnapshot = await collectFailureEvidence().catch(() => undefined)
  } finally {
    // check 失败不会抛异常，只会进 failures；同样要在停宿主前留下现场。
    if (result.evidence.failureSnapshot === undefined && (failure !== undefined || failures.length > 0)) {
      result.evidence.failureSnapshot = await collectFailureEvidence().catch(() => undefined)
    }
    let hostStopped = host === undefined
    if (host !== undefined) {
      try {
        await host.stop()
        hostStopped = true
        mark('process-stop', 'pass', { stopped: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        mark('process-stop', 'fail', message)
        failures.push(error)
        result.cleanupError = message
      }
    } else {
      mark('process-stop', 'pass', { stopped: false, reason: '宿主未启动' })
    }
    if (!hostStopped) {
      // 活进程可能仍在写 home；停止未确认时保留目录，只报告清理失败。
      const message = '宿主未停止，保留隔离 home 供取证，未执行清理'
      mark('home-cleanup', 'fail', message)
      result.cleanupError = result.cleanupError ?? message
    } else {
      try {
        if (await fileExists(home)) {
          await cleanupOwnedHome(home)
          mark('home-cleanup', 'pass', { removed: true })
        } else {
          mark('home-cleanup', 'pass', { removed: false, reason: 'home 未创建' })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        mark('home-cleanup', 'fail', message)
        failures.push(error)
        result.cleanupError = result.cleanupError ?? message
      }
    }
    await writeResult()
    await check('sanitized-result', async () => {
      const text = await readFile(path.join(outDir, 'standard-result.json'), 'utf8')
      const leaks = []
      for (const secret of secrets) {
        if (typeof secret === 'string' && secret !== '' && text.includes(secret)) leaks.push('secret')
      }
      for (const pattern of [/\/Users\/[^/\s"']+/, /\/private\/tmp\/[^"\s]+/, /\/var\/folders\/[^"\s]+/, /\/tmp\/[^"\s]+/]) {
        const match = pattern.exec(text)
        if (match !== null) leaks.push(match[0].slice(0, 80))
      }
      if (leaks.length > 0) throw new Error(`结果文件仍含敏感内容：${leaks.join(',')}`)
      return { bytes: text.length }
    }, (value) => value)
    await writeResult()
  }

  const final = await readJsonFileIfExists(path.join(outDir, 'standard-result.json'))
  if (final?.ok !== true) process.exitCode = 1

  async function runDiagnostics() {
    const detail = await panelReadSafe('run', { runId }).catch(() => undefined)
    return {
      status: detail?.run?.status ?? null,
      nodes: Object.fromEntries(Object.entries(detail?.run?.nodes ?? {}).map(([id, node]) => [
        id,
        { status: node.status, attempts: node.attempts, error: node.error ?? null, round: node.round ?? null, reworks: node.reworks ?? null },
      ])),
      pending: await panelReadSafe('attention', { pending: '1' }).catch(() => undefined),
      lead: await leadDiagnostics().catch(() => undefined),
    }
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (error) => {
    // main 内部已经写结果；这里只兜底启动前失败（例如缺环境变量）并写最小结果。
    const message = sanitize(error instanceof Error ? error.message : String(error), currentSecrets())
      .replace(/\/Users\/[^/\s"']+/g, '<home>')
      .replace(/\/private\/(?:var|tmp)\/[\w./-]+/g, '<tmp>')
      .replace(/\/var\/folders\/[\w./-]+/g, '<tmp>')
      .replace(/\/tmp\/[\w./-]+/g, '<tmp>')
    try {
      await mkdir(outDir, { recursive: true })
      const file = path.join(outDir, 'standard-result.json')
      // 每次都覆盖：上一次 ok=true 的残留绝不能冒充本次启动前失败的成功结果。
      const now = new Date().toISOString()
      await writeJson(file, {
        ok: false,
        runKey: randomUUID(),
        startedAt: now,
        finishedAt: now,
        checks: [{ name: 'bootstrap', status: 'fail', detail: message }],
        failed: [{ name: 'bootstrap', status: 'fail', detail: message }],
        error: message,
      }, currentSecrets())
    } catch {
      // 兜底写结果失败时仍保留非零退出。
    }
    console.error(`[standard e2e] ${message}`)
    process.exitCode = 1
  })
}
