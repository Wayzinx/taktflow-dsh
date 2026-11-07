#!/usr/bin/env node
/**
 * M-K 缺陷归因端到端验收。
 *
 * 固定流程（不探索替代方案）：
 *   隔离 DSH_HOME → 重新 build/pack/install → 新 dsh 进程 → 真实 Lead init/create →
 *   quick-fix T1 真实交付（spec → implement 自测 → review-code → delivery-check）→ 交付后实测 fixture 缺陷 →
 *   Lead takt_trace report/attribute → auditor 候选归因落盘 → 通知唤醒 Lead →
 *   原生确认卡片经 Remote Event WebSocket 回答 → takt_trace why 引用已确认归因。
 *
 * 运行（真实模型）：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/defect.mjs
 *
 * 可选：
 *   TAKT_E2E_DEFECT_TIMEOUT_MS=2700000   总超时，默认 45 分钟
 *   TAKT_E2E_PROGRESS_FILE=<path>        额外进度文件（不写死本机路径）
 *
 * 结果只写 git ignored 的 e2e/out/ 与 .dev/e2e/；不会提交，不会动用户 ~/.dsh。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packTaktflow } from '../scripts/pack.mjs'
import { startHost } from './boot.mjs'
import { createCheckList, verdictOf } from './checks.mjs'
import {
  CookieJar,
  cleanupOwnedHome,
  fetchWithJar,
  isDirectRun,
  outDir,
  packageRoot,
  poll,
  prepareOwnedHome,
  readSessionRecords,
  requireEnv,
  resolveDshBin,
  resolveE2eHome,
  rpcCall,
  runCommand,
  sanitize,
  writeJson,
} from './lib.mjs'
import * as D from './defect-lib.mjs'
import * as Delivery from './defect-delivery.mjs'

const REQUIREMENT_TITLE = 'M-K 缺陷归因验收：价格含税展示'
const WORKFLOW = 'quick-fix'
const WORKFLOW_FILE = 'workflows/quick-fix.workflow.ts'
const CONFIRM_LABEL = '确认候选归因'
const REPORT_REASON = '交付后实测发现，需求外逃逸'
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1_000
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled'])

const CHECK_NAMES = [
  'profile-install',
  'host-session',
  'lead-init',
  'lead-create',
  'fixture-materials',
  'business-run',
  'spec-generated',
  'selftest-evidence',
  'review-evidence',
  'gate-evidence',
  'delivery-evidence',
  'bug-repro',
  'defect-report',
  'attribution-persisted',
  'notification',
  'candidate-not-confirmed',
  'native-card',
  'human-confirmed',
  'why-after-confirm',
  'panel-reads',
  'events-verify',
  'static-tool-count',
  'runtime-tool-schemas',
  'lead-tool-pairing',
  'metrics',
]

function renderPatch(env) {
  const quote = (value) => JSON.stringify(value)
  return [
    '# 由 e2e/defect.mjs 生成，仅用于隔离 e2e；不要提交。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      takt-e2e:',
    '        api: openai-completions',
    '        baseURL: !!js process.env.TAKT_E2E_BASE_URL',
    '        apiKeyEnv: TAKT_E2E_API_KEY',
    '        models:',
    `          - id: ${quote(env.TAKT_E2E_MODEL)}`,
    '- id: agent-default-model',
    '  config:',
    '    provider: takt-e2e',
    `    model: ${quote(env.TAKT_E2E_MODEL)}`,
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
  ].join('\n')
}

function remaining(deadline) {
  return Math.max(1_000, deadline - Date.now())
}

function nodeEntry(nodes, id) {
  if (nodes?.[id] !== undefined) return [id, nodes[id]]
  const found = Object.entries(nodes ?? {}).find(([key]) => key === id || key.endsWith(`/${id}`))
  return found ?? [undefined, undefined]
}

async function main() {
  const startedAt = new Date()
  let env
  try {
    env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
  } catch (error) {
    await mkdir(outDir, { recursive: true })
    const blocked = {
      ok: false,
      status: 'BLOCKED',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      error: D.scrubText(error instanceof Error ? error.message : String(error), { secrets: [process.env.TAKT_E2E_API_KEY], packageRoot }),
      checks: CHECK_NAMES.map((name) => ({ name, status: 'not-run' })),
    }
    await writeJson(path.join(outDir, 'defect-result.json'), blocked)
    throw error
  }

  const timeoutMs = Number(process.env.TAKT_E2E_DEFECT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('TAKT_E2E_DEFECT_TIMEOUT_MS 必须是正数')
  const deadline = Date.now() + timeoutMs
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY]

  // NO_PROXY 补 endpoint hostname；不改用户全局配置，只影响本进程和子进程。
  const noProxyEntries = [process.env.NO_PROXY, process.env.no_proxy]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const host of [new URL(env.TAKT_E2E_BASE_URL).hostname, '127.0.0.1', 'localhost']) {
    if (!noProxyEntries.includes(host)) noProxyEntries.push(host)
  }
  const noProxy = noProxyEntries.join(',')
  const childEnv = {
    ...process.env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    TAKTFLOW_E2E_DEFECT_PROBE: '1',
  }

  const { checks, failures, step, check } = createCheckList(CHECK_NAMES)
  const result = {
    ok: false,
    status: 'RUNNING',
    startedAt: startedAt.toISOString(),
    finishedAt: undefined,
    durationMs: null,
    requirementTitle: REQUIREMENT_TITLE,
    workflow: WORKFLOW,
    scenario: 'controlled-selftest-t1',
    checksVersion: 'm-k-selftest-t1',
    tier: 'T1',
    checks: [],
    evidence: {},
    optional: [],
    metrics: {},
    error: undefined,
    cleanupError: undefined,
  }
  const progressLines = []
  const stageMarks = [{ name: 'start', at: startedAt.getTime() }]
  const markStage = (name) => stageMarks.push({ name, at: Date.now() })
  const progress = async (line) => {
    progressLines.push(`- ${new Date().toISOString()} ${line}`)
    const body = `# M-K defect e2e progress\n\n${progressLines.join('\n')}\n`
    await writeFile(path.join(outDir, 'defect-progress.md'), D.scrubText(body, context()), 'utf8').catch(() => {})
    const external = process.env.TAKT_E2E_PROGRESS_FILE?.trim()
    if (external !== undefined && external !== '') {
      await writeFile(external, D.scrubText(body, context()), 'utf8').catch(() => {})
    }
  }

  let home
  let spaceRoot
  let appDir
  let workspaceDir
  let worktreePath
  let dshBin
  let packed
  let host
  const hostOutput = D.createDiagnosticOutputCapture()
  let jar
  let answerJar
  let pageUrl
  let sessionId
  let requirementId
  let runId
  let runDetail
  let defectId
  let bindingUser
  let appFixture
  let generatedCases = []
  let deliveryTraces = []
  let artifactRecords = []
  let cardHelper
  let frozenCandidate
  let frozenHash
  let candidateCallId
  let attributionNotificationIds = []
  let confirmedCallId
  let failure

  const context = () => ({
    secrets,
    user: userInfo().username,
    home,
    spaceRoot,
    appDir,
    workspaceDir,
    worktree: worktreePath,
    packageRoot,
  })

  const readDigest = async () => D.buildDigest(await readSessionRecords(home, sessionId))

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

  const readPanel = (op, params = {}) => D.panelRead({ pageUrl, spaceRoot, jar, secrets, op, params })
  const readPanelSafe = (op, params = {}) => D.panelReadSafe({ pageUrl, spaceRoot, jar, secrets, op, params })


  const readArtifact = async (ref) => {
    if (ref?.workspace !== requirementId || typeof ref.path !== 'string' || !Number.isSafeInteger(ref.version) || ref.version < 1) {
      throw new Error('证据必须是当前需求的精确版本 ArtifactRef')
    }
    const value = await readPanel('artifact', { id: requirementId, path: ref.path, version: ref.version })
    if (value?.version !== ref.version || typeof value?.content !== 'string') throw new Error(`证据版本无法读回：${ref.path}`)
    return value.encoding === 'base64' ? Buffer.from(value.content, 'base64').toString('utf8') : value.content
  }

  const readTraces = async () => {
    const url = new URL('api/taktflow.agents', pageUrl)
    url.searchParams.set('space', spaceRoot)
    url.searchParams.set('run', runId)
    const { response } = await fetchWithJar(url, {}, jar, { secrets, label: 'GET taktflow.agents' })
    const body = await response.json()
    if (!response.ok || body?.ok !== true || !Array.isArray(body.data)) throw new Error('真实职责追溯接口不可读')
    return body.data
  }

  const readSchemaEvidence = async () => {
    const url = new URL('api/taktflow.e2e-defect-schemas', pageUrl)
    url.searchParams.set('session', sessionId)
    const { response } = await fetchWithJar(url, {}, jar, { secrets, label: '真实工具 schema 观察' })
    const body = await response.json()
    if (!response.ok || body?.ok !== true) throw new Error('真实工具 schema 探针不可读')
    return body.data
  }

  const collectSelftestCalls = async () => {
    const rows = []
    for (const trace of deliveryTraces) {
      if (!trace.tools?.some((tool) => tool.name === 'takt_selftest')) continue
      const calls = Delivery.selftestCalls(await readSessionRecords(home, trace.sessionId))
      for (const call of calls) rows.push({ runId: trace.runId, nodeId: trace.nodeId, attempt: trace.attempt,
        sessionId: trace.sessionId, role: trace.role, callId: call.callId, args: call.args,
        result: call.value ?? null, isError: call.result?.data?.message?.isError ?? null,
        pending: call.result === undefined, text: call.text.slice(-8192) })
    }
    return rows
  }

  const collectReviewResponses = async () => {
    const observations = []
    for (const trace of deliveryTraces) {
      if (trace.nodeId !== 'review-code' || trace.role !== 'reviewer') continue
      observations.push({ runId: trace.runId, nodeId: trace.nodeId, attempt: trace.attempt,
        ...await Delivery.collectReviewResponse(home, trace.sessionId) })
    }
    return observations
  }

  const producedArtifact = (record, nodeId, role) => {
    const version = record?.versions?.at(-1)
    if (version?.producedBy?.runId !== runId || version?.producedBy?.nodeId !== nodeId
      || role !== undefined && (version.author?.type !== 'agent' || version.author.role !== role)) {
      throw new Error(`产物不是本次 ${nodeId}${role === undefined ? '' : '/' + role} 产生：${record?.path}`)
    }
    return { workspace: requirementId, path: record.path, version: version.version }
  }

  const promptLead = async (text, label = 'Lead') => {
    const requestId = randomUUID()
    const value = await rpcCall({
      baseUrl: pageUrl,
      method: 'session/prompt',
      args: {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      },
      jar,
      secrets,
      timeoutMs: 120_000,
    })
    if (value?.accepted !== true) throw new Error(`${label} prompt 没有被接受`)
    return requestId
  }

  const waitToolSuccess = async ({ name, action, match, timeoutMs: waitMs, label, excludedCallIds = new Set() }) => {
    const found = await poll(async () => {
      const digest = await readDigest()
      return D.successfulCall({ ...digest, calls: digest.calls.filter((call) => !excludedCallIds.has(call.callId)) }, { name, action, match })
    }, { timeoutMs: Math.min(waitMs, remaining(deadline)), intervalMs: 500 })
    if (found === undefined) {
      throw new Error(`等待 ${label} 超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
    }
    return found
  }

  const waitAssistant = async (callId, accepts, label) => {
    let latest = ''
    const answer = await poll(async () => {
      const records = await readSessionRecords(home, sessionId)
      const texts = D.assistantTextsAfter(records, callId)
      latest = texts.join('\n')
      return latest && accepts(latest) ? latest : undefined
    }, { timeoutMs: Math.min(120_000, remaining(deadline)), intervalMs: 500 })
    if (answer === undefined) throw new Error(`${label} 没有匹配当前工具结果的回答：${latest.slice(0, 1000)}`)
    return answer
  }

  const readBoundHuman = async () => {
    const stored = await D.readJsonFileIfExists(path.join(spaceRoot, '.takt', 'dsh', 'bindings.json'))
    const binding = stored?.bindings?.find((entry) => entry?.requirementId === requirementId && entry?.sessionId === sessionId)
    const id = binding?.by?.id
    if (binding?.by?.type !== 'human' || typeof id !== 'string' || !id) throw new Error('当前需求缺少绑定人的持久化身份')
    return id
  }

  const runNodeScript = async (cwd, source, label) => {
    const out = await runCommand(process.execPath, ['--input-type=module', '-e', source], {
      cwd,
      env: childEnv,
      timeoutMs: 60_000,
      secrets,
      label,
    })
    const line = out.stdout.trim().split('\n').filter(Boolean).at(-1)
    return D.parseJsonText(line)
  }

  const waitChild = (helper, waitMs) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { helper.child.kill('SIGTERM') } catch { /* 已退出 */ }
      resolve({ timeout: true, code: null, signal: 'SIGTERM', stdout: helper.stdout, stderr: helper.stderr })
    }, waitMs)
    helper.exit.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })

  const startCardHelper = () => {
    const electron = D.deriveElectronPath(dshBin)
    const helperPath = path.join(packageRoot, 'e2e', 'defect-card.mjs')
    const child = spawn(electron, [helperPath], {
      env: {
        ...childEnv,
        ELECTRON_RUN_AS_NODE: '1',
        TAKT_E2E_WS_BASE_URL: pageUrl,
        TAKT_E2E_WS_COOKIE: answerJar.header(),
        TAKT_E2E_WS_GATEWAY_DIR: D.deriveGatewayDir(dshBin),
        TAKT_E2E_WS_SESSION_ID: sessionId,
        TAKT_E2E_DEFECT_REQUIREMENT_ID: requirementId,
        TAKT_E2E_DEFECT_ID: defectId,
        TAKT_E2E_DEFECT_CONFIRM_LABEL: CONFIRM_LABEL,
        TAKT_E2E_DEFECT_HASH: frozenHash,
        TAKT_E2E_WS_TIMEOUT_MS: String(Math.min(300_000, remaining(deadline))),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const exit = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: 1, signal: null, stdout, stderr: D.scrubText(error.message, context()) }))
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    return {
      child,
      exit,
      get stdout() { return stdout },
      get stderr() { return stderr },
    }
  }

  const captureMetrics = async (partial = false) => {
    if (home === undefined || sessionId === undefined) {
      result.metrics = { partial, durationMs: Date.now() - startedAt.getTime(), token: { observed: false, inputTokens: null, outputTokens: null, reason: 'Lead 会话尚未创建' } }
      return result.metrics
    }
    if (runId !== undefined && spaceRoot !== undefined) {
      try {
        const latest = await readPanel('run', { runId })
        if (latest !== undefined) runDetail = latest
      } catch (error) {
        result.evidence.runReadError = D.scrubText(error instanceof Error ? error.message : String(error), context())
      }
      if (runDetail !== undefined) result.evidence.runDetail = runDetail
      result.evidence.runEvents = await D.readRunEvents(spaceRoot, runId)
      try {
        deliveryTraces = await readTraces()
        result.evidence.deliveryTraces = deliveryTraces
        result.evidence.selftestCalls = await collectSelftestCalls()
        result.evidence.reviewResponses = await collectReviewResponses()
      } catch (error) {
        result.evidence.traceReadError = D.scrubText(error instanceof Error ? error.message : String(error), context())
      }
    }
    // schema 探针是角色身份来源，必须先于 usage 分类读取。
    try { result.evidence.toolSchemas = await readSchemaEvidence() } catch (error) {
      result.evidence.toolSchemaError = D.scrubText(error instanceof Error ? error.message : String(error), context())
    }
    const digest = await readDigest()
    const run = runDetail?.run ?? {}
    const runStarted = Date.parse(String(run.startedAt ?? ''))
    const subagents = await D.subagentUsage(home, sessionId, startedAt.getTime(), result.evidence.toolSchemas)
    result.evidence.childDiagnostics = D.scrubValue(await D.collectChildDiagnostics(home, subagents, result.evidence.toolSchemas?.errors ?? []), context())
    const lead = D.leadUsage(digest)
    const observedSubagents = subagents.filter((session) => session.observed)
    const auditors = subagents.filter((session) => session.kind === 'auditor')
      .sort((a, b) => String(a.endedAt ?? a.startedAt ?? a.schemaObservedAt ?? '').localeCompare(String(b.endedAt ?? b.startedAt ?? b.schemaObservedAt ?? '')))
    const auditor = auditors.at(-1) ?? null
    const observed = lead.observed || observedSubagents.length > 0
    const inputTokens = observed
      ? (lead.inputTokens ?? 0) + observedSubagents.reduce((total, session) => total + (session.inputTokens ?? 0), 0)
      : null
    const outputTokens = observed
      ? (lead.outputTokens ?? 0) + observedSubagents.reduce((total, session) => total + (session.outputTokens ?? 0), 0)
      : null
    const durationMs = Date.now() - startedAt.getTime()
    const stages = stageMarks.map((stage, index) => ({
      name: stageMarks[index + 1]?.name ?? 'finalize',
      startedAt: new Date(stage.at).toISOString(),
      durationMs: (stageMarks[index + 1]?.at ?? Date.now()) - stage.at,
    }))
    result.metrics = {
      partial,
      tokenScope: '本次隔离 home 中实际观测到的会话 usage；缺失会话不补零',
      durationMs,
      stages,
      run: {
        runId,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        durationMs: Number.isFinite(runStarted) && Number.isFinite(Date.parse(String(run.endedAt ?? '')))
          ? Date.parse(String(run.endedAt)) - runStarted
          : null,
      },
      lead,
      subagents,
      auditors,
      auditor,
      nodeUsage: Object.entries(run.nodes ?? {}).map(([id, node]) => ({
        id,
        status: node?.status ?? null,
        inputTokens: node?.usage?.inputTokens ?? null,
        outputTokens: node?.usage?.outputTokens ?? null,
      })),
      token: {
        observed,
        ...D.defectTokenCoverage({ lead, subagents, auditor, attributionPersisted: frozenCandidate !== undefined }),
        inputTokens,
        outputTokens,
        leadObserved: lead.observed,
        subagentObserved: observedSubagents.length,
        subagentMissing: subagents.length - observedSubagents.length,
        auditorObserved: auditor?.observed ?? false,
        auditorIdentity: auditor?.identitySource ?? '未获得可信 auditor 身份，不能宣称完整',
        auditorExecutions: auditors.length,
        auditorUsageMissing: auditors.filter((item) => !item.observed).length,
      },
      missingSessions: subagents.filter((session) => !session.observed).map((session) => ({
        sessionId: session.sessionId,
        kind: session.kind,
        role: session.role,
        identitySource: session.identitySource,
        executionObserved: session.executionObserved,
        cwd: session.cwd,
      })),
    }
    if (!partial && (!Number.isFinite(durationMs) || durationMs <= 0)) throw new Error('总耗时不可计算')
    if (!partial && stages.length === 0) throw new Error('阶段耗时为空的')
    result.evidence.lastLead = await leadDiagnostics()
    if (requirementId !== undefined) {
      const events = await D.readDefectEvents(spaceRoot, requirementId)
      result.evidence.defectErrors = events.filter((event) => event?.type === 'log' && event.data?.level === 'error')
    }
    return result.metrics
  }

  try {
    await mkdir(outDir, { recursive: true })
    await writeJson(path.join(outDir, 'defect-result.json'), D.scrubValue(result, context()), secrets)
    await progress('开始：隔离 home、重新构建安装、启动真实 dsh')

    // ---------------------------------------------------------------- profile
    await step('profile-install', async () => {
      dshBin = await resolveDshBin()
      home = await prepareOwnedHome(resolveE2eHome())
      const workspace = path.join(home, 'workspace')
      const rawSpace = path.join(workspace, 'mk-defect-space')
      await mkdir(rawSpace, { recursive: true })
      spaceRoot = await realpath(rawSpace)
      appDir = path.join(spaceRoot, 'app')
      childEnv.TAKTFLOW_E2E_DEFECT_SPACE = spaceRoot
      const installEnv = {
        ...childEnv,
        DSH_HOME: home,
        npm_config_cache: path.join(home, '.npm-cache'),
        npm_config_store_dir: path.join(home, '.pnpm-store'),
        PNPM_HOME: path.join(home, '.pnpm'),
      }
      packed = await packTaktflow({ buildFirst: true })
      await runCommand(dshBin, ['plugin', '--profile', 'web', 'add', packed.tgz], {
        env: installEnv,
        cwd: packageRoot,
        timeoutMs: 600_000,
        secrets,
        label: 'dsh plugin --profile web add',
      })
      const profileDir = path.join(home, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true })
      const schemaProbe = path.join(profileDir, 'defect-probe.mjs')
      await writeFile(schemaProbe, await readFile(new URL('./defect-probe.mjs', import.meta.url), 'utf8'), 'utf8')
      await writeFile(path.join(profileDir, 'cordis.patch.yml'), `${renderPatch(env)}- insert:\n    - id: taktflow-e2e-defect-schema-probe\n      name: ${JSON.stringify(schemaProbe)}\n`, 'utf8')
      const version = (await runCommand(dshBin, ['--version'], {
        env: installEnv,
        cwd: packageRoot,
        timeoutMs: 60_000,
        secrets,
        label: 'dsh --version',
      })).stdout.trim()
      const dump = await runCommand(dshBin, ['--profile', 'web', '--dump-config'], {
        env: installEnv,
        cwd: packageRoot,
        timeoutMs: 120_000,
        secrets,
        label: 'dsh --profile web --dump-config',
        outputLimit: Infinity,
      })
      await writeFile(path.join(outDir, 'defect-profile-config.yml'), `${D.scrubText(dump.stdout, context())}\n`, 'utf8')
      if (!dump.stdout.includes('takt-e2e') || !dump.stdout.includes(env.TAKT_E2E_MODEL)) {
        throw new Error('隔离 profile 的模型路由没有生效')
      }
      result.evidence.profile = {
        dshVersion: version,
        profile: 'web',
        provider: 'takt-e2e',
        modelEnv: 'TAKT_E2E_MODEL',
        baseUrlEnv: 'TAKT_E2E_BASE_URL',
        apiKeyEnv: 'TAKT_E2E_API_KEY',
      }
      return { dshVersion: version, model: env.TAKT_E2E_MODEL }
    }, (value) => value)
    markStage('profile-install')
    await progress('profile 安装完成，启动 dsh')

    // ------------------------------------------------------------ host/session
    await step('host-session', async () => {
      host = await startHost({ home, dshBin, env: childEnv })
      host.child.stdout.on('data', (chunk) => hostOutput.append(chunk, 'stdout'))
      host.child.stderr.on('data', (chunk) => hostOutput.append(chunk, 'stderr'))
      const token = new URL(host.url).searchParams.get('token')
      if (token === null || token === '') throw new Error('启动 URL 没有 token')
      secrets.push(host.url, token)

      jar = new CookieJar()
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

      // 卡片回答使用独立的单 socket operator cookie，不能覆盖面板 cookie。
      answerJar = new CookieJar()
      const connectUrl = new URL('/connect', pageUrl)
      connectUrl.searchParams.set('token', token)
      connectUrl.searchParams.set('interactions', 'answer')
      const before = answerJar.header()
      const answerExchange = await fetchWithJar(
        connectUrl,
        { headers: { accept: 'text/html' } },
        answerJar,
        { secrets, label: 'answer cookie exchange' },
      )
      await answerExchange.response.body?.cancel().catch(() => undefined)
      if (answerExchange.redirects === 0) throw new Error('/connect?interactions=answer 没有返回重定向')
      if (answerJar.header() === before) throw new Error('/connect?interactions=answer 没有更新认证 cookie')
      secrets.push(answerJar.header())

      const created = await rpcCall({
        baseUrl: pageUrl,
        method: 'session/create',
        args: { request: { agentPreset: 'taktflow', cwd: spaceRoot } },
        jar,
        secrets,
      })
      if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
        throw new Error('session/create 没有返回 sessionId')
      }
      if (created.agentPreset !== undefined && created.agentPreset !== 'taktflow') {
        throw new Error(`session/create 返回的 agentPreset 是 ${String(created.agentPreset)}`)
      }
      sessionId = created.sessionId
      result.sessionId = sessionId
      result.evidence.host = {
        sessionId,
        agentPreset: created.agentPreset ?? 'taktflow',
        pageAuth: 'launch-token-303',
        answerAuth: '/connect?interactions=answer',
      }
      return { sessionId, pageAuth: 303, answerCookie: true }
    }, (value) => value)
    markStage('host-session')
    await progress('Lead 会话已创建，开始自然语言 init/create')

    // ------------------------------------------------------------- lead init
    await step('lead-init', async () => {
      const phase1 = [
        '我已确认就在当前目录初始化，不要询问目录，也不要创建新目录。',
        '请只做两件事：',
        '1) 调用 takt_requirement init 初始化当前目录；',
        `2) 调用 takt_requirement create 创建需求「${REQUIREMENT_TITLE}」，requestKey 使用 mk-defect-create-${randomUUID()}。`,
        '不要启动运行，不要调用 takt_ask_human；除 init/create 外不要修改任何文件。',
        '完成后只报告需求 ID，然后结束回合。',
      ].join('\n')
      await promptLead(phase1, 'init/create')
      const found = await poll(async () => {
        const digest = await readDigest()
        return D.successfulCall(digest, {
          name: 'takt_requirement',
          action: 'init',
          match: (business) => typeof business.space?.root === 'string' && business.space.root === spaceRoot,
        })
      }, { timeoutMs: Math.min(240_000, remaining(deadline)), intervalMs: 500 })
      if (found === undefined) {
        throw new Error(`Lead 没有成功的 takt_requirement init；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      if (!(await D.fileExists(path.join(spaceRoot, 'takt.config.json')))) {
        throw new Error('init 后没有 takt.config.json')
      }
      result.evidence.init = {
        callId: found.call.callId,
        businessOk: found.info.business.ok === true,
        spaceRoot: '<space>',
      }
      return { callId: found.call.callId, initialized: true }
    }, (value) => value)
    markStage('lead-init')
    await progress('Lead init 成功，等待需求创建')

    // ----------------------------------------------------------- lead create
    await step('lead-create', async () => {
      const list = await poll(async () => {
        const requirements = await readPanelSafe('requirements')
        return Array.isArray(requirements) && requirements.length > 0 ? requirements : undefined
      }, { timeoutMs: Math.min(180_000, remaining(deadline)), intervalMs: 500 })
      if (list === undefined) throw new Error('等待需求创建超时')
      const picked = list.find((item) => typeof item?.title === 'string' && item.title === REQUIREMENT_TITLE)
        ?? list.slice().sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      if (typeof picked?.id !== 'string' || picked.id === '') throw new Error('需求列表没有有效 ID')
      requirementId = picked.id
      result.requirementId = requirementId
      const found = await poll(async () => {
        const digest = await readDigest()
        return D.successfulCall(digest, {
          name: 'takt_requirement',
          action: 'create',
          match: (business) => typeof business.requirement?.id === 'string' && business.requirement.id === requirementId,
        })
      }, { timeoutMs: Math.min(120_000, remaining(deadline)), intervalMs: 500 })
      if (found === undefined) {
        throw new Error(`Lead 没有与需求 ${requirementId} 匹配的成功 create；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      const config = JSON.parse(await readFile(path.join(spaceRoot, 'takt.config.json'), 'utf8'))
      const requirementsRoot = path.join(spaceRoot, config.paths?.requirements ?? 'requirements')
      workspaceDir = path.join(requirementsRoot, requirementId)
      await mkdir(workspaceDir, { recursive: true })
      result.evidence.create = {
        callId: found.call.callId,
        businessOk: found.info.business.ok === true,
        requirementId,
        title: picked.title,
      }
      return { requirementId, callId: found.call.callId }
    }, (value) => value)
    markStage('lead-create')
    await progress('需求已创建，准备 quick-fix T1 输入')

    // ------------------------------------------------------- fixture materials
    await step('fixture-materials', async () => {
      const paths = JSON.parse(await readFile(path.join(spaceRoot, 'takt.config.json'), 'utf8')).paths ?? {}
      const workflowsDir = path.join(spaceRoot, paths.workflows ?? 'workflows')
      const workflowFile = path.join(workflowsDir, 'quick-fix.workflow.ts')
      const hooksFile = path.join(workflowsDir, 'quick-fix.hooks.ts')
      if (!(await D.fileExists(workflowFile))) throw new Error('init 没有复制 quick-fix.workflow.ts')
      if (!(await D.fileExists(hooksFile))) throw new Error('init 没有复制 quick-fix.hooks.ts')
      const workflowText = await readFile(workflowFile, 'utf8')
      if (!workflowText.includes("id: 'quick-fix'")) throw new Error('quick-fix workflow id 不匹配')

      appFixture = await D.createAppFixture(appDir, { runCommand, secrets })
      const config = D.normalizeConfig(
        JSON.parse(await readFile(path.join(spaceRoot, 'takt.config.json'), 'utf8')),
        WORKFLOW_FILE,
      )
      await writeFile(path.join(spaceRoot, 'takt.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      const readback = JSON.parse(await readFile(path.join(spaceRoot, 'takt.config.json'), 'utf8'))
      if (readback.autonomy !== 'full') throw new Error('takt.config.json autonomy 不是 full')
      if (!Array.isArray(readback.workflows) || !readback.workflows.includes(WORKFLOW_FILE)) {
        throw new Error('takt.config.json 没有注册 quick-fix workflow')
      }
      if (!Array.isArray(readback.repos) || !readback.repos.some((repo) => repo?.id === 'app' && repo.path === 'app' && repo.defaultBranch === 'main')) {
        throw new Error('takt.config.json 没有 app 仓库绑定')
      }

      const input = await D.ensureArtifact({
        pageUrl, spaceRoot, jar, secrets, requirementId, requirementDir: workspaceDir,
        rel: 'inputs/request.md', content: D.QUICK_REQUEST,
        reason: '保存原始需求和既有 runner 合同，spec/用例由 T1 的真实 PM 生成',
      })
      for (const dir of ['spec', 'cases', 'evidence']) {
        if (await D.fileExists(path.join(workspaceDir, dir))) throw new Error(`T1 启动前已有 ${dir}/，不能证明由真实节点生成`)
      }
      if (await D.fileExists(path.join(workspaceDir, 'evidence', 'summary.json'))) {
        throw new Error('启动前已存在 evidence/summary.json，无法证明由 delivery-check 生成')
      }
      result.evidence.fixture = {
        app: { branch: appFixture.branch, head: appFixture.head, files: appFixture.files },
        workflow: { id: WORKFLOW, file: WORKFLOW_FILE, tier: 'T1' },
        input: { path: 'inputs/request.md', method: input.method, panelReadback: input.panelReadback },
        seededGeneratedArtifacts: [],
        expectedGeneratedPaths: ['spec/quick.md', 'cases/*.json'],
        config: { autonomy: readback.autonomy, repo: 'app', workflow: WORKFLOW_FILE },
      }
      return result.evidence.fixture
    }, (value) => value)
    markStage('fixture-materials')
    await progress('fixture 就绪，启动 quick-fix T1')

    // ----------------------------------------------------------- business run
    await check('business-run', async () => {
      const existing = await readPanelSafe('runs', { requirement: requirementId })
      const baseline = new Set((Array.isArray(existing) ? existing : []).map((entry) => entry?.runId).filter(Boolean))
      const promptAt = Date.now()
      const prompt = [
        `需求 ${requirementId} 只有 inputs/request.md 原始需求和现有测试入口，请只调用一次 takt_run start 启动 quick-fix T1，让 PM 实际生成 spec 与用例：`,
        `- workflow: ${WORKFLOW}`,
        `- requestKey: mk-defect-run-${randomUUID()}`,
        '- args: {"tier":"T1"}',
        '不要传 humanSignoff，autonomy 已在空间配置为 full；不要修改 workflow，不要删除节点。',
        '启动后只报告 runId 并结束回合。',
      ].join('\n')
      await promptLead(prompt, 'run start')

      const findRuns = (waitMs) => poll(async () => {
        const list = await readPanelSafe('runs', { requirement: requirementId })
        const fresh = (Array.isArray(list) ? list : []).filter((entry) => typeof entry?.runId === 'string'
          && entry.workflowId === WORKFLOW
          && !baseline.has(entry.runId)
          && Date.parse(String(entry.startedAt ?? '')) >= promptAt - 5_000)
        return fresh.length > 0 ? fresh : undefined
      }, { timeoutMs: Math.min(waitMs, remaining(deadline)), intervalMs: 500 })
      let runs = await findRuns(60_000)
      if (runs === undefined) {
        await promptLead(`请现在启动 ${WORKFLOW}，需求 ${requirementId}，使用上一条消息里的 args（tier=T1）；不要询问，不要调用 takt_ask_human。`, 'run start nudge')
        runs = await findRuns(180_000)
      }
      if (runs === undefined) {
        throw new Error(`等待 quick-fix 运行启动超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      const picked = runs.slice().sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))[0]
      runId = picked?.runId
      if (typeof runId !== 'string' || runId === '') throw new Error('运行列表没有本次新 runId')
      result.runId = runId
      const started = await waitToolSuccess({
        name: 'takt_run',
        action: 'start',
        match: (business) => business.runId === runId,
        timeoutMs: 120_000,
        label: 'takt_run start',
      })

      let waitingSince
      const terminal = await poll(async () => {
        const detail = await readPanelSafe('run', { runId })
        const status = detail?.run?.status
        if (detail !== undefined) runDetail = detail
        if (status === 'waiting_human') {
          waitingSince ??= Date.now()
          if (Date.now() - waitingSince > 120_000) {
            throw new Error(`quick-fix 停在 waiting_human；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
          }
          return undefined
        }
        return TERMINAL_RUN.has(status) ? detail : undefined
      }, { timeoutMs: Math.min(30 * 60_000, remaining(deadline)), intervalMs: 1_000 })
      if (terminal === undefined) {
        throw new Error(`等待 quick-fix 终态超时；诊断：${JSON.stringify(await leadDiagnostics().catch(() => undefined))}`)
      }
      runDetail = terminal
      result.evidence.runDetail = runDetail
      result.evidence.runEvents = await D.readRunEvents(spaceRoot, runId)
      const run = runDetail.run
      if (run.status !== 'succeeded') {
        throw new Error(`quick-fix 运行状态是 ${run.status}，不是 succeeded`)
      }
      const statuses = {}
      for (const id of ['spec', 'implement', 'review-code', 'delivery-check']) {
        const [key, node] = nodeEntry(run.nodes, id)
        statuses[id] = { key: key ?? null, status: node?.status ?? null }
      }
      for (const id of ['spec', 'implement', 'review-code', 'delivery-check']) {
        if (statuses[id].status !== 'succeeded') throw new Error(`节点 ${id} 状态是 ${String(statuses[id].status)}，不是 succeeded`)
      }
      result.evidence.run = {
        runId,
        workflowId: run.workflowId ?? WORKFLOW,
        status: run.status,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        nodes: statuses,
        startCallId: started.call.callId,
      }
      return result.evidence.run
    }, (value) => value)
    markStage('business-run')
    if (runId === undefined || runDetail === undefined) throw failures[0] ?? new Error('没有可验收的实际运行')
    result.evidence.runDetail = runDetail
    result.evidence.runEvents = await D.readRunEvents(spaceRoot, runId)
    deliveryTraces = await readTraces()
    result.evidence.deliveryTraces = deliveryTraces
    artifactRecords = await readPanel('artifacts', { id: requirementId })
    if (!Array.isArray(artifactRecords)) throw new Error('本次产物清单不可读')
    const runEvents = result.evidence.runEvents

    await check('spec-generated', async () => {
      const specNode = runDetail.run.nodes.spec
      if (specNode?.status !== 'succeeded') throw new Error('T1 spec 节点未真实完成')
      const specRecord = artifactRecords.find((item) => item.path === 'spec/quick.md')
      if (specRecord?.kind !== 'spec') throw new Error('PM 没有产出 kind=spec 的 spec/quick.md')
      const specRef = producedArtifact(specRecord, 'spec', 'pm')
      const spec = await readArtifact(specRef)
      const caseRecords = artifactRecords.filter((item) => /^cases\/[^/]+\.json$/.test(item.path))
      const candidates = []
      for (const record of caseRecords) {
        if (record.kind !== 'case') throw new Error(`PM 用例 kind 不是 case：${record.path}`)
        const ref = producedArtifact(record, 'spec', 'pm')
        candidates.push({ ...JSON.parse(await readArtifact(ref)), artifact: ref })
      }
      const parsed = Delivery.validateGeneratedCases(candidates, spec)
      const pm = deliveryTraces.filter((trace) => trace.runId === runId && trace.nodeId === 'spec'
        && trace.role === 'pm' && trace.attempt === specNode.attempts && trace.status === 'completed')
      if (pm.length === 0) throw new Error('spec 缺少本次 PM 子会话追溯')
      const writes = new Set()
      for (const trace of pm) {
        const digest = D.buildDigest(await readSessionRecords(home, trace.sessionId))
        for (const call of digest.calls) {
          if (!['write', 'edit'].includes(call.name) || typeof call.args.file_path !== 'string') continue
          const info = digest.results.get(call.callId)
          if (info === undefined || info.isError) continue
          writes.add(path.resolve(spaceRoot, call.args.file_path))
        }
      }
      for (const ref of [specRef, ...candidates.map((item) => item.artifact)]) {
        if (!writes.has(path.join(workspaceDir, ref.path))) throw new Error(`PM 子会话没有成功写入 ${ref.path}`)
      }
      generatedCases = candidates
      result.evidence.pmArtifacts = { spec: specRef, cases: candidates.map((item) => item.artifact), ...parsed,
        sessions: pm.map((trace) => trace.sessionId) }
      return result.evidence.pmArtifacts
    }, (value) => value)
    markStage('spec-generated')

    await check('selftest-evidence', async () => {
      result.evidence.selftestCalls = await collectSelftestCalls()
      if (generatedCases.length === 0) throw new Error('缺少已核对来源的 PM 用例，无法验证自测')
      const [, implement] = nodeEntry(runDetail.run.nodes, 'implement')
      worktreePath = implement?.worktree?.path
      if (typeof worktreePath !== 'string') throw new Error('自测缺少实际 implement 工作树')
      const relativeTree = path.relative(spaceRoot, await realpath(worktreePath))
      if (relativeTree.startsWith('..') || path.isAbsolute(relativeTree)) throw new Error('自测工作树不在本次隔离空间内')
      const evidence = await Delivery.verifySelftests({ home, spaceRoot, requirementId, runId,
        implement, worktree: worktreePath, traces: deliveryTraces, events: runEvents,
        cases: generatedCases, readArtifact, expectedScriptsHash: appFixture.packageScriptsHash })
      result.evidence.selftests = evidence
      return evidence
    }, (value) => value)
    markStage('selftest-evidence')

    await check('review-evidence', async () => {
      result.evidence.reviewResponses = await collectReviewResponses()
      const reviewNode = runDetail.run.nodes['review-code']
      if (reviewNode?.status !== 'succeeded') throw new Error('独立 review-code 没有实际通过')
      const rounds = runEvents.filter((event) => event.runId === runId && event.nodeId === 'review-code'
        && event.type === 'review.round')
      const latest = rounds.at(-1)
      if (latest?.data?.passed !== true || !latest.data.verdicts?.some((value) => value.reviewer === 'reviewer' && value.verdict === 'approve')) {
        throw new Error('review-code 没有独立 reviewer 的最新通过轮次')
      }
      const rel = `reviews/review-code/r${reviewNode.revision ?? 1}-round-${latest.data.round}.json`
      const ref = producedArtifact(artifactRecords.find((item) => item.path === rel), 'review-code')
      const round = JSON.parse(await readArtifact(ref))
      if (round.passed !== true || round.round !== latest.data.round || typeof round.targetFingerprint !== 'string') {
        throw new Error('评审轮次产物与真实 review.round 事件不一致')
      }
      const reviewer = round.records?.find((record) => record.reviewer === 'reviewer')
      if (reviewer?.verdict !== 'approve' || !Array.isArray(reviewer.artifacts) || reviewer.artifacts.length === 0) {
        throw new Error('评审没有实际代码产物版本')
      }
      for (const target of reviewer.artifacts) {
        if (!(await readArtifact(target)).trim()) throw new Error('评审目标版本内容为空')
      }
      const child = deliveryTraces.filter((trace) => trace.runId === runId && trace.nodeId === 'review-code'
        && trace.role === 'reviewer' && trace.profile?.readOnly === true && trace.status === 'completed')
        .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt))).at(-1)
      if (child === undefined || !runEvents.some((event) => event.type === 'harness.started'
        && event.nodeId === 'review-code' && event.data?.sessionId === child.sessionId)) {
        throw new Error('评审没有匹配的真实只读 reviewer 子会话')
      }
      if (deliveryTraces.some((trace) => trace.nodeId === 'implement' && trace.sessionId === child.sessionId)) {
        throw new Error('评审复用了实现会话')
      }
      const observation = await Delivery.collectReviewResponse(home, child.sessionId)
      // 先保留原始调用/结果和精确产物；后续断言失败也能在清理后复核。最终统一脱敏。
      result.evidence.reviewObservation = { artifact: ref, record: reviewer, eventSeq: latest.seq, ...observation }
      const answer = Delivery.assertReviewResponse(observation, { sessionId: child.sessionId, expected: reviewer })
      if (answer.source === 'structured_output' && !child.tools.some((tool) => tool.name === 'structured_output' && tool.ok === true)) {
        throw new Error('评审子会话的结构化提交与 AgentTrace 工具记录不一致')
      }
      result.evidence.review = { rounds: rounds.length, finalRound: latest.data.round, eventSeq: latest.seq,
        artifact: ref, targetFingerprint: round.targetFingerprint, targets: reviewer.artifacts,
        sessionId: child.sessionId, role: child.role, verdict: reviewer.verdict, answer }
      return result.evidence.review
    }, (value) => value)
    markStage('review-evidence')

    await check('gate-evidence', async () => {
      const gate = runEvents.filter((event) => event.runId === runId && event.nodeId === 'delivery-check'
        && event.type === 'gate.result').at(-1)
      if (runDetail.run.nodes['delivery-check']?.status !== 'succeeded' || gate?.data?.pass !== true) {
        throw new Error('delivery-check 没有真实成功的 gate.result')
      }
      for (const id of ['tests', 'acceptance']) {
        if (!gate.data.checks?.some((item) => item.id === id && item.pass === true)) throw new Error(`门禁 ${id} 未通过`)
      }
      const precedingReview = runEvents.filter((event) => event.runId === runId && event.nodeId === 'review-code'
        && event.type === 'review.round').at(-1)
      result.evidence.gateObservation = { eventSeq: gate.seq, checks: gate.data.checks,
        precedingReviewSeq: precedingReview?.seq ?? null, reviewResponseVerified: checks.get('review-evidence')?.status === 'pass' }
      if (precedingReview?.data?.passed !== true || gate.seq <= precedingReview.seq) {
        throw new Error('门禁事件不在实际通过的独立评审事件之后')
      }
      const acceptance = gate.data.checks.find((item) => item.id === 'acceptance')
      if (!Array.isArray(acceptance.details) || acceptance.details.length === 0
        || acceptance.details.some((item) => item.pass !== true || !item.cases?.length
          || item.cases.some((test) => test.pass !== true || !test.evidence?.length))) {
        throw new Error('交付校验没有逐 AC 的真实通过结果和证据')
      }
      const verifier = deliveryTraces.find((trace) => trace.runId === runId && trace.nodeId === 'delivery-check'
        && trace.role === 'verifier' && trace.profile?.readOnly === true && trace.status === 'completed')
      if (verifier === undefined) throw new Error('交付校验没有真实独立 verifier 会话')
      const refs = []
      for (const rel of ['evidence/summary.json', ...generatedCases.map((item) => `evidence/${item.id}/result.json`)]) {
        const record = artifactRecords.find((item) => item.path === rel)
        const ref = producedArtifact(record, 'delivery-check')
        refs.push(ref)
        const body = JSON.parse(await readArtifact(ref))
        if (rel === 'evidence/summary.json') Delivery.assertFixtureSummary(body, generatedCases)
        else {
          const test = generatedCases.find((item) => rel === `evidence/${item.id}/result.json`)
          if (body.id !== test.id || body.status !== 'passed' || body.pass !== true
            || JSON.stringify(body.actual) !== JSON.stringify(test.expected)) throw new Error(`门禁证据不匹配：${rel}`)
        }
      }
      result.evidence.gate = { eventSeq: gate.seq, checks: gate.data.checks, artifacts: refs, verifier: verifier.sessionId }
      return result.evidence.gate
    }, (value) => value)
    markStage('gate-evidence')
    if (failures.length > 0) throw failures[0]
    await progress('T1 自测、独立评审和交付校验均有真实证据，开始独立核对与缺陷复现')

    // ------------------------------------------------------ delivery evidence
    await step('delivery-evidence', async () => {
      const summaryPath = path.join(workspaceDir, 'evidence', 'summary.json')
      if (!(await D.fileExists(summaryPath))) throw new Error('delivery-check 没有生成 evidence/summary.json')
      const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
      Delivery.assertFixtureSummary(summary, generatedCases)
      const cases = Array.isArray(summary.cases) ? summary.cases : []
      for (const id of generatedCases.map((item) => item.id)) {
        const item = cases.find((entry) => entry?.id === id)
        if (item === undefined || item.pass !== true || item.status !== 'passed') throw new Error(`验收用例 ${id} 没有通过`)
        const proof = path.join(workspaceDir, 'evidence', id, 'result.json')
        if (!(await D.fileExists(proof))) throw new Error(`验收用例 ${id} 缺少逐条证据`)
      }

      const [, implement] = nodeEntry(runDetail.run.nodes, 'implement')
      worktreePath = implement?.worktree?.path
      if (typeof worktreePath !== 'string' || !worktreePath) throw new Error('implement 状态没有实际工作树路径')
      const relativeTree = path.relative(spaceRoot, await realpath(worktreePath))
      if (relativeTree.startsWith('..') || path.isAbsolute(relativeTree)) throw new Error('implement 工作树不在隔离空间内')
      await access(worktreePath, fsConstants.F_OK)
      const delivered = await readFile(path.join(worktreePath, 'src', 'price.js'), 'utf8')
      if (!delivered.includes('formatPriceWithTax')) throw new Error('实现工作树没有新增 formatPriceWithTax')
      const mainSource = await readFile(path.join(appDir, 'src', 'price.js'), 'utf8')
      if (mainSource.includes('formatPriceWithTax')) throw new Error('主检出被直接修改；交付没有发生在工作树')
      const head = (await runCommand('git', ['-C', appDir, 'rev-parse', 'HEAD'], {
        env: childEnv,
        timeoutMs: 60_000,
        secrets,
        label: 'fixture app HEAD',
      })).stdout.trim()
      if (head !== appFixture.head) throw new Error('fixture app 主检出 HEAD 在交付后发生变化')

      for (const rel of ['package.json', 'tests/run.mjs']) {
        const before = await runCommand('git', ['-C', appDir, 'show', `${appFixture.head}:${rel}`], {
          env: childEnv, timeoutMs: 30_000, secrets, label: `fixture baseline ${rel}`,
        })
        if (await readFile(path.join(worktreePath, rel), 'utf8') !== before.stdout) {
          throw new Error(`实现改动了固定测试输入：${rel}`)
        }
      }
      const moduleUrl = pathToFileURL(path.join(worktreePath, 'src', 'price.js')).href
      const independent = await runNodeScript(
        worktreePath,
        `import { formatPriceWithTax, formatPrice, parsePrice } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({taxStandard:formatPriceWithTax(10000,0.06),taxZero:formatPriceWithTax(0,0.06),formatPositive:formatPrice(1234),formatNegative:formatPrice(-1234),parsePositive:parsePrice('¥12.34'),parseZero:parsePrice('¥0.00')}))`,
        '独立验收含税功能及既有格式化/解析行为',
      )
      if (JSON.stringify(independent) !== JSON.stringify({ taxStandard: '¥106.00', taxZero: '¥0.00',
        formatPositive: '¥12.34', formatNegative: '-¥12.34', parsePositive: 1234, parseZero: 0 })) {
        throw new Error(`独立验收结果不一致：${JSON.stringify(independent)}`)
      }
      const diff = await runCommand('git', ['-C', worktreePath, 'diff', '--stat', appFixture.head], {
        env: childEnv,
        timeoutMs: 60_000,
        secrets,
        label: 'implement worktree diff',
      })
      result.evidence.delivery = {
        summaryOk: true,
        cases: cases.map((entry) => ({ id: entry.id, pass: entry.pass, status: entry.status })),
        evidenceFiles: ['evidence/summary.json', ...generatedCases.map((item) => `evidence/${item.id}/result.json`)],
        worktree: '<worktree>',
        independent: independent,
        mainCheckoutHeadUnchanged: head === appFixture.head,
        diffStat: sanitize(diff.stdout, secrets).slice(0, 2_000),
      }
      return result.evidence.delivery
    }, (value) => value)
    markStage('delivery-evidence')

    // ------------------------------------------------------------- bug repro
    await step('bug-repro', async () => {
      const moduleUrl = pathToFileURL(path.join(worktreePath, 'src', 'price.js')).href
      const values = await runNodeScript(
        worktreePath,
        `import { parsePrice } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({ negative: parsePrice('-¥12.34'), positive: parsePrice('¥12.34') }))`,
        '实测 parsePrice 负号缺陷',
      )
      if (values?.negative !== 1234) {
        throw new Error(`fixture 缺陷未复现：parsePrice('-¥12.34')=${JSON.stringify(values?.negative)}，期望实测 1234（正确值 -1234）`)
      }
      result.evidence.bugRepro = {
        source: '交付后的 implement 工作树，直接 import src/price.js',
        input: "parsePrice('-¥12.34')",
        actual: values.negative,
        expected: -1234,
        control: { input: "parsePrice('¥12.34')", actual: values.positive },
        reproducible: values.negative !== -1234,
      }
      return result.evidence.bugRepro
    }, (value) => value)
    markStage('bug-repro')
    await progress('实测缺陷已复现，交回 Lead report/attribute')

    // ---------------------------------------------------------- defect report
    await step('defect-report', async () => {
      const userVoice = [
        '我刚按交付结果实际跑了一下 app：',
        `node --input-type=module -e "import('./src/price.js').then(m => console.log(m.parsePrice('-¥12.34')))"`,
        `实际输出：${result.evidence.bugRepro.actual}；期望：${result.evidence.bugRepro.expected}。负号被丢掉了。`,
        `这是本次交付后发现的逃逸缺陷。请调用 takt_trace report 录入这个缺陷（severity 用 major，reason 写“${REPORT_REASON}”），`,
        '拿到 defectId 后立刻调用 takt_trace attribute 启动归因。不要自己改代码，不要预置归因结果。',
        '收到归因完成通知后，先调用 takt_trace why，明确说这是 auditor 候选、尚未人工确认，然后结束回合；暂时不要开确认卡片。',
        '只有我后续明确要求打开卡片时才调用 takt_ask_human，不要提前等待确认。',
      ].join('\n')
      await promptLead(userVoice, 'defect report/attribute')

      const report = await waitToolSuccess({
        name: 'takt_trace',
        action: 'report',
        match: (business) => typeof business.defectId === 'string' && /^D-\d+$/.test(business.defectId),
        timeoutMs: 240_000,
        label: 'takt_trace report',
      })
      defectId = report.info.business.defectId
      const attribute = await waitToolSuccess({
        name: 'takt_trace',
        action: 'attribute',
        match: (business) => business.defectId === defectId,
        timeoutMs: 240_000,
        label: 'takt_trace attribute',
      })
      const detail = await poll(async () => {
        const value = await readPanelSafe('defect', { id: requirementId, defectId })
        return value?.id === defectId ? value : undefined
      }, { timeoutMs: Math.min(120_000, remaining(deadline)), intervalMs: 500 })
      if (detail === undefined) throw new Error(`面板读不到缺陷 ${defectId}`)
      if (detail.severity !== 'major') throw new Error(`缺陷 severity 是 ${String(detail.severity)}，不是 major`)
      const description = String(detail.description ?? '')
      if (!/parsePrice|1234|负号/i.test(description)) {
        throw new Error(`缺陷描述没有记录实测输入/输出：${description.slice(0, 500)}`)
      }
      bindingUser = await readBoundHuman()
      const reportedBy = detail.reportedBy
      if (reportedBy?.type !== 'agent' || reportedBy?.role !== 'lead' || reportedBy?.onBehalfOf !== bindingUser) {
        throw new Error('缺陷 reportedBy 不是代表当前绑定人的 Lead agent')
      }
      if (report.call.args.reason !== REPORT_REASON) throw new Error('Lead report 没有使用本次用户说明的录入原因')
      const reportEvents = await D.readDefectEvents(spaceRoot, requirementId)
      const reportAudit = reportEvents.find((event) => {
        const data = D.parseJsonText(event?.data?.message)
        return event?.type === 'log' && data?.action === 'open'
          && data?.ref?.workspace === requirementId && data?.ref?.path === `defects/${defectId}.md`
          && data?.reason === REPORT_REASON && event.actor?.type === 'agent'
          && event.actor?.role === 'lead' && event.actor?.onBehalfOf === bindingUser
      })
      if (reportAudit === undefined) throw new Error('缺陷事件链缺少本次 Lead/onBehalfOf/原因一致的录入审计')
      result.evidence.defect = {
        defectId,
        title: detail.title,
        severity: detail.severity,
        status: detail.status,
        reportedBy,
        reportReason: REPORT_REASON,
        reportAuditSeq: reportAudit.seq,
        reportCallId: report.call.callId,
        attributeCallId: attribute.call.callId,
        description,
      }
      return result.evidence.defect
    }, (value) => value)
    markStage('defect-report')
    await progress('缺陷已录入并启动归因，等待 auditor 候选落盘')

    // --------------------------------------------------- attribution persisted
    await step('attribution-persisted', async () => {
      let last
      const detail = await poll(async () => {
        const value = await readPanelSafe('defect', { id: requirementId, defectId })
        last = value
        const events = await D.readDefectEvents(spaceRoot, requirementId)
        const failed = events.find((event) => event?.type === 'log'
          && event?.data?.level === 'error'
          && String(event?.data?.message ?? '').includes('归因失败'))
        if (failed !== undefined && value?.status === 'open' && value?.attributing !== true) {
          throw new Error(`auditor 归因失败：${String(failed.data.message)}`)
        }
        if (value?.status === 'attributed' && value?.attribution !== undefined && value?.attributing !== true) return value
        if (value?.status === 'confirmed') throw new Error('归因在 e2e 确认前就被写成了 confirmed')
        return undefined
      }, { timeoutMs: Math.min(15 * 60_000, remaining(deadline)), intervalMs: 1_000 })
      if (detail === undefined) {
        throw new Error(`等待候选归因超时；最后状态：${JSON.stringify(last)}`)
      }
      const attribution = detail.attribution
      if (attribution.defectId !== defectId) throw new Error('归因 defectId 与本次缺陷不一致')
      if (attribution.by?.type !== 'agent' || attribution.by?.role !== 'auditor') throw new Error(`归因执行角色不是 auditor：${String(attribution.by?.role)}`)
      if (attribution.confirmed !== undefined) throw new Error('候选归因不应带 confirmed')
      const origin = attribution.introducedAt?.origin
      const origins = ['requirement', 'design', 'implementation', 'test_design', 'automation', 'environment', 'external', 'unknown']
      if (!origins.includes(origin)) throw new Error(`归因 introducedAt.origin 不合法：${String(origin)}`)
      const evidence = attribution.introducedAt?.evidence
      if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new Error('归因 introducedAt.evidence 必须是非空字符串数组')
      }
      if (!Array.isArray(attribution.missedBy)) throw new Error('归因 missedBy 不是数组')
      for (const missed of attribution.missedBy) {
        if (typeof missed?.nodeId !== 'string' || !Array.isArray(missed?.evidence) || missed.evidence.length === 0) {
          throw new Error('归因 missedBy 条目缺少 nodeId 或证据')
        }
      }
      if (!Number.isFinite(attribution.confidence) || attribution.confidence < 0 || attribution.confidence > 1) {
        throw new Error('归因 confidence 不在 0–1')
      }
      if (!Array.isArray(attribution.suggestions)) throw new Error('归因 suggestions 不是数组')

      const attributionFile = path.join(workspaceDir, 'defects', `${defectId}.attribution.json`)
      const defectFile = path.join(workspaceDir, 'defects', `${defectId}.md`)
      if (!(await D.fileExists(attributionFile))) throw new Error('defects/<id>.attribution.json 没有落盘')
      if (!(await D.fileExists(defectFile))) throw new Error('defects/<id>.md 没有落盘')
      const persisted = JSON.parse(await readFile(attributionFile, 'utf8'))
      if (persisted.defectId !== defectId || persisted.introducedAt?.origin !== origin) {
        throw new Error('落盘归因与面板读取不一致')
      }
      if (JSON.stringify(persisted) !== JSON.stringify(attribution)) throw new Error('候选归因文件与面板完整内容不一致')
      frozenCandidate = JSON.parse(JSON.stringify(detail))
      frozenHash = D.candidateHash(frozenCandidate)
      result.evidence.attribution = {
        defectId,
        status: detail.status,
        origin,
        runId: attribution.introducedAt?.runId ?? null,
        nodeId: attribution.introducedAt?.nodeId ?? null,
        evidence,
        missedBy: attribution.missedBy.map((item) => ({ nodeId: item.nodeId, reason: item.reason, evidence: item.evidence })),
        confidence: attribution.confidence,
        suggestions: attribution.suggestions,
        confirmed: false,
        hash: frozenHash,
        files: [`defects/${defectId}.md`, `defects/${defectId}.attribution.json`],
      }
      return result.evidence.attribution
    }, (value) => value)
    markStage('attribution-persisted')
    await progress('auditor 候选归因已落盘，准备候选状态核对与原生确认卡片')

    // ------------------------------------------------------------- notification
    await step('notification', async () => {
      const found = await poll(async () => {
        const records = await readSessionRecords(home, sessionId)
        const evidence = D.defectNotificationEvidence(records, { requirementId, defectId })
        return evidence.admitted.length > 0 ? evidence : undefined
      }, { timeoutMs: Math.min(180_000, remaining(deadline)), intervalMs: 500 })
      if (found === undefined) {
        const records = await readSessionRecords(home, sessionId)
        const queued = D.defectNotificationEvidence(records, { requirementId, defectId }).queued
        throw new Error(`没有找到与 ${requirementId}/${defectId} 配对的 agent/inbox/spliced→user/message 通知；queued=${queued.length}`)
      }
      if (found.admitted.some((record) => Array.from(record.text).length > 200)) throw new Error('归因通知超过 200 字')
      attributionNotificationIds = found.admitted.map((record) => record.id)
      return {
        queued: found.queued.length,
        admitted: found.admitted.length,
        samples: found.samples,
        targets: [...new Set(found.admitted.map((record) => record.target).filter(Boolean))],
      }
    }, (value) => value)
    markStage('notification')

    // ------------------------------------------------- candidate not confirmed
    await step('candidate-not-confirmed', async () => {
      // 不发送新用户 prompt：归因完成 followup 必须自己带动 Lead 查候选并汇报。
      const why = await poll(async () => {
        const digest = await readDigest()
        const notice = digest.events.findIndex((event) => event?.type === 'user/message'
          && attributionNotificationIds.includes(event.data?.id ?? event.data?.message?.id))
        if (notice < 0) return undefined
        return D.successfulCall(D.buildDigest(digest.events.slice(notice + 1)), {
          name: 'takt_trace', action: 'why',
          match: (business) => business.defectId === defectId && business.attributionState === 'candidate',
        })
      }, { timeoutMs: Math.min(240_000, remaining(deadline)), intervalMs: 500 })
      if (why === undefined) throw new Error('归因通知已投递，但 Lead 没有在通知后自行调用 why 汇报候选')
      if (why.info.business.confirmed === true) throw new Error('候选阶段 why 已显示 confirmed')
      candidateCallId = why.call.callId
      const answer = await waitAssistant(why.call.callId, (text) => /未|尚未/.test(text) && /确认/.test(text) && /候选|auditor/i.test(text), '候选阶段')
      if (!/未|尚未/.test(answer) || !/确认/.test(answer)) {
        throw new Error(`候选阶段 Lead 回答没有说明未人工确认：${answer.slice(0, 500)}`)
      }
      if (/(?<!未|尚未)已由人确认|(?<!未|尚未)已确认/.test(answer)) throw new Error(`候选阶段 Lead 误称已确认：${answer.slice(0, 500)}`)
      return {
        callId: why.call.callId,
        source: '归因完成通知后的自然 followup，无新增用户 prompt',
        notificationMessageIds: attributionNotificationIds,
        attributionState: why.info.business.attributionState,
        confirmed: why.info.business.confirmed ?? false,
        assistant: answer.slice(0, 1_000),
      }
    }, (value) => value)
    markStage('candidate-not-confirmed')

    // -------------------------------------------------------------- native card
    await check('native-card', async () => {
      const currentCandidate = await readPanel('defect', { id: requirementId, defectId })
      if (currentCandidate.status !== 'attributed' || currentCandidate.attribution?.confirmed !== undefined
        || D.candidateHash(currentCandidate) !== frozenHash) throw new Error('开卡前持久化候选已变化')
      await access(D.deriveElectronPath(dshBin), fsConstants.X_OK)
      cardHelper = startCardHelper()
      const ready = await poll(() => {
        const line = cardHelper.stdout.split('\n').map(D.parseJsonText).find((value) => value?.type === 'ready')
        if (line !== undefined) return line
        if (cardHelper.child.exitCode !== null) throw new Error(`卡片 helper 提前退出：${cardHelper.stderr.slice(-800)}`)
        return undefined
      }, { timeoutMs: 15_000, intervalMs: 200 })
      if (ready === undefined) throw new Error('卡片 helper 未收到远端 clientId，拒绝触发确认')
      await promptLead(
        `候选状态已核对。现在请调用 takt_ask_human defectId="${defectId}" 打开原生确认卡片，让我在卡片上确认；`
        + '不要用 takt_trace 代替卡片，不要自己确认。',
        'defect card',
      )
      const exit = await waitChild(cardHelper, Math.min(300_000, remaining(deadline)))
      if (exit.timeout === true) throw new Error('等待原生归因卡片回答超时')
      const card = D.lastJsonLine(exit.stdout)
      if (exit.code !== 0 || card?.ok !== true || card?.answered !== true) {
        throw new Error(`原生卡片回答失败（code=${String(exit.code)}）：${card?.error ?? exit.stderr.slice(-1_000)}`)
      }
      if (card.agentId !== sessionId) throw new Error('卡片 agentId 不是当前 Lead 会话')
      if (typeof card.requestId !== 'string' || !card.requestId.startsWith(`defect:${requirementId}:${defectId}:`)) {
        throw new Error(`卡片 requestId 前缀不匹配：${String(card.requestId)}`)
      }
      if (card.header !== 'taktflow 归因确认') throw new Error(`卡片标题不匹配：${String(card.header)}`)
      if (typeof card.detail !== 'string') throw new Error('卡片没有 detail')
      for (const marker of [`需求：${requirementId}`, '引入环节：', '漏检环节：', '引入证据：', '归因哈希：']) {
        if (!card.detail.includes(marker)) throw new Error(`卡片 detail 缺少：${marker}`)
      }
      for (const label of [CONFIRM_LABEL, '修改后确认', '驳回候选']) {
        if (!Array.isArray(card.options) || !card.options.includes(label)) throw new Error(`卡片选项缺少：${label}`)
      }
      if (card.selected !== CONFIRM_LABEL) throw new Error(`卡片选择不是 ${CONFIRM_LABEL}`)
      if (card.hash !== frozenHash.slice(0, 12)) throw new Error('原生卡片未对应冻结的持久化归因')
      const ask = await waitToolSuccess({
        name: 'takt_ask_human',
        match: (business) => business.answered === true && business.confirmed === true,
        timeoutMs: 180_000,
        label: 'takt_ask_human 确认结果',
      })
      if (ask.call.args.defectId !== defectId) throw new Error('确认工具结果没有绑定本次缺陷')
      return {
        transport: card.transport,
        requestId: card.requestId,
        agentId: card.agentId,
        header: card.header,
        options: card.options,
        selected: card.selected,
        hash: card.hash,
        detail: card.detail,
        askCallId: ask.call.callId,
        askBusiness: ask.info.business,
      }
    }, (value) => value)
    markStage('native-card')

    // ---------------------------------------------------------- human confirmed
    await check('human-confirmed', async () => {
      const detail = await poll(async () => {
        const value = await readPanelSafe('defect', { id: requirementId, defectId })
        return value?.status === 'confirmed' && value?.attribution?.confirmed !== undefined ? value : undefined
      }, { timeoutMs: Math.min(120_000, remaining(deadline)), intervalMs: 500 })
      if (detail === undefined) throw new Error('缺陷没有在卡片回答后进入 confirmed')
      const confirmed = detail.attribution.confirmed
      const { confirmed: _confirmed, ...candidatePart } = detail.attribution
      if (D.candidateHash({ ...frozenCandidate, attribution: candidatePart }) !== frozenHash) {
        throw new Error('按候选确认后归因内容发生变化')
      }
      if (confirmed?.by?.type !== 'human') throw new Error(`confirmed.by.type 是 ${String(confirmed?.by?.type)}，不是 human`)
      if (confirmed?.by?.via !== 'dsh:user-questions') throw new Error(`confirmed.by.via 是 ${String(confirmed?.by?.via)}，不是 dsh:user-questions`)
      bindingUser = await readBoundHuman()
      if (confirmed.by.id !== bindingUser) throw new Error(`confirmed.by.id=${String(confirmed.by.id)} 与绑定人 ${bindingUser} 不一致`)
      if (confirmed.edited !== false) throw new Error('确认不是“按候选确认”（edited 不为 false）')
      const persisted = JSON.parse(await readFile(path.join(workspaceDir, 'defects', `${defectId}.attribution.json`), 'utf8'))
      if (JSON.stringify(persisted) !== JSON.stringify(detail.attribution)) throw new Error('已确认归因面板与落盘完整内容不一致')
      if (persisted.confirmed?.by?.via !== 'dsh:user-questions') throw new Error('落盘 confirmed.via 不是 dsh:user-questions')
      result.evidence.confirmation = {
        defectId,
        status: detail.status,
        confirmedBy: confirmed.by,
        confirmedAt: confirmed.at,
        note: confirmed.note ?? null,
        edited: confirmed.edited,
        bindingUser,
        files: [`defects/${defectId}.md`, `defects/${defectId}.attribution.json`],
      }
      return result.evidence.confirmation
    }, (value) => value)
    markStage('human-confirmed')
    await progress('卡片已确认，核对确认后 why 与面板/事件链')

    // --------------------------------------------------------- why after confirm
    await check('why-after-confirm', async () => {
      const excludedCallIds = new Set((await readDigest()).calls.map((call) => call.callId))
      await promptLead(
        `请调用 takt_trace why defectId="${defectId}" 查确认后的归因，并用一句话回答：谁确认的、引入环节、漏检环节和证据。`
        + '必须引用至少一条归因证据原文，不要修改任何文件。',
        'confirmed why',
      )
      const why = await waitToolSuccess({
        name: 'takt_trace',
        action: 'why',
        match: (business) => business.defectId === defectId && business.confirmed === true,
        timeoutMs: 240_000,
        label: '确认后 takt_trace why',
        excludedCallIds,
      })
      const business = why.info.business
      if (business.confirmedBy?.type !== 'human') throw new Error('确认后 why 的 confirmedBy.type 不是 human')
      if (business.confirmedBy?.via !== 'dsh:user-questions') throw new Error('确认后 why 的 confirmedBy.via 不是 dsh:user-questions')
      if (business.introducedAt === undefined || !Array.isArray(business.introducedAt.evidence)) {
        throw new Error('确认后 why 没有引用引入证据')
      }
      confirmedCallId = why.call.callId
      const answer = await waitAssistant(why.call.callId,
        (text) => /人/.test(text) && /确认/.test(text) && D.citedEvidence(text, business) !== undefined,
        '确认后 why')
      const cited = D.citedEvidence(answer, business)
      return {
        callId: why.call.callId,
        confirmedBy: business.confirmedBy,
        origin: business.introducedAt.origin,
        nodeId: business.introducedAt.nodeId ?? null,
        evidence: business.introducedAt.evidence,
        missedBy: business.missedBy,
        assistant: answer.slice(0, 1_200),
        cited,
      }
    }, (value) => value)
    markStage('why-after-confirm')

    // ------------------------------------------------------------- panel reads
    await check('panel-reads', async () => {
      const defects = await readPanel('defects', { id: requirementId })
      if (!Array.isArray(defects)) throw new Error('panel defects 不是数组')
      const detail = await readPanel('defect', { id: requirementId, defectId })
      if (detail?.id !== defectId) throw new Error('panel defect 没有返回本次缺陷')
      const scorecards = await readPanel('eval.scorecards', { by: 'node' })
      if (!Array.isArray(scorecards)) throw new Error('panel eval.scorecards 不是数组')
      return {
        defects: defects.length,
        defectStatus: detail.status,
        scorecards: scorecards.length,
        scorecardKeys: scorecards.slice(0, 8).map((entry) => entry?.key ?? null),
      }
    }, (value) => value)

    // ------------------------------------------------------------ events verify
    await check('events-verify', async () => {
      const normal = await readPanel('audit', { runId })
      if (normal?.ok !== true) throw new Error(`普通运行 ${runId} 的 events.verify 不是 ok`)
      const defectRunId = `defect-${requirementId}`
      let defectVerify = await readPanelSafe('audit', { runId: defectRunId })
      let source = 'panel'
      if (defectVerify === undefined) {
        // 当前面板的 audit 读操作要求 run 存在；缺陷事件链用真实 core store 校验。
        const core = await import(pathToFileURL(path.join(packageRoot, 'lib', 'core.js')).href)
        const stores = await core.openProject(spaceRoot)
        defectVerify = await stores.events.verify(defectRunId)
        source = 'core:openProject'
      }
      if (defectVerify?.ok !== true) throw new Error(`${defectRunId} 的 events.verify 不是 ok：${JSON.stringify(defectVerify)}`)
      return {
        normal: { runId, ok: normal.ok, source: 'panel' },
        defect: { runId: defectRunId, ok: defectVerify.ok, source },
      }
    }, (value) => value)

    // --------------------------------------------------------------- tool count
    await check('static-tool-count', async () => {
      const tools = await D.staticLeadToolNames(packageRoot)
      const expected = ['takt_status', 'takt_requirement', 'takt_artifact', 'takt_run', 'takt_trace', 'takt_ask_human']
      if (tools.names.length !== 6) throw new Error(`LEAD_TOOL_NAMES 数量是 ${tools.names.length}，不是 6`)
      for (const name of expected) {
        if (!tools.names.includes(name)) throw new Error(`LEAD_TOOL_NAMES 缺少 ${name}`)
      }
      const digest = await readDigest()
      const runtime = [...new Set(digest.calls.map((call) => call.name).filter((name) => typeof name === 'string' && name.startsWith('takt_')))]
      const unknown = runtime.filter((name) => !tools.names.includes(name))
      if (unknown.length > 0) throw new Error(`运行时出现未声明工具：${unknown.join('、')}`)
      return { scope: 'static-contract', declared: tools.names, source: tools.source, observedRuntimeCalls: runtime, runtimeSchemaVerified: false }
    }, (value) => value)

    await check('runtime-tool-schemas', async () => {
      const schemas = await readSchemaEvidence()
      const leadTools = schemas.lead?.toolNames
      const expectedLead = ['takt_status', 'takt_requirement', 'takt_artifact', 'takt_run', 'takt_trace', 'takt_ask_human']
      if (!Array.isArray(leadTools) || leadTools.includes('takt_selftest')
        || JSON.stringify(leadTools.filter((name) => name.startsWith('takt_')).sort()) !== JSON.stringify(expectedLead.sort())) {
        throw new Error('Lead 实际 schema 不是六个 Lead 工具，或泄漏了角色 selftest')
      }
      const checked = []
      for (const role of ['dev', 'reviewer', 'auditor']) {
        const candidates = schemas.children.filter((child) => child.role === role && child.parentSessionId === sessionId
          && (role === 'auditor' || child.runId === runId))
        if (candidates.length === 0) throw new Error(`没有实际 ${role} schema 快照，不能推断工具隔离`)
        for (const child of candidates) {
          if (child.schemasAvailable !== true || child.toolNames.length === 0) throw new Error(`${role} 的真实工具 schema 尚未就绪`)
          const has = child.toolNames.includes('takt_selftest')
          if (role === 'dev' && child.readOnly !== true ? !has : has) {
            throw new Error(`${role} 的实际 selftest 可见性与权限不一致`)
          }
          if (role !== 'dev' && child.readOnly !== true) throw new Error(`${role} schema 快照没有只读权限身份`)
          checked.push({ sessionId: child.sessionId, role, roleSource: child.roleSource, presetId: child.presetId,
            parentSessionId: child.parentSessionId, readOnly: child.readOnly, selftestVisible: has,
            toolNames: child.toolNames, observedAt: child.observedAt, selftestSchema: child.selftestSchema })
        }
      }
      result.evidence.toolSchemas = schemas
      return { source: schemas.source, leadSessionId: schemas.lead.sessionId, leadTools, checked, runtimeSchemaVerified: true }
    }, (value) => value)

    // -------------------------------------------------------- lead tool pairing
    await check('lead-tool-pairing', async () => {
      const digest = await readDigest()
      const pairs = []
      const pair = (name, action, match, label, expectedCallId) => {
        const eligible = expectedCallId === undefined ? digest : { ...digest, calls: digest.calls.filter((call) => call.callId === expectedCallId) }
        const found = D.successfulCall(eligible, { name, action, match })
        if (found === undefined) throw new Error(`缺少成功的 ${label}`)
        if (found.info.callId !== found.call.callId) throw new Error(`${label} 的 callId 配对不一致`)
        if (found.info.isError === true) throw new Error(`${label} 的 tool/result 是 error`)
        if (found.info.business?.ok !== true) throw new Error(`${label} 的 business.ok 不是 true`)
        pairs.push({ name, action: action ?? null, callId: found.call.callId, businessOk: true })
        return found
      }
      pair('takt_requirement', 'init', (business) => business.space?.root === spaceRoot, 'takt_requirement init')
      pair('takt_requirement', 'create', (business) => business.requirement?.id === requirementId, 'takt_requirement create')
      pair('takt_run', 'start', (business) => business.runId === runId, 'takt_run start')
      pair('takt_trace', 'report', (business) => business.defectId === defectId, 'takt_trace report')
      pair('takt_trace', 'attribute', (business) => business.defectId === defectId, 'takt_trace attribute')
      pair('takt_ask_human', undefined, (business) => business.answered === true && business.confirmed === true, 'takt_ask_human 确认')
      const candidateWhy = pair('takt_trace', 'why', (business) => business.defectId === defectId && business.attributionState === 'candidate', '候选 why', candidateCallId)
      if (candidateWhy.call.callId !== candidateCallId) throw new Error('候选 why 与已核对的回答不是同一调用')
      let confirmedWhy
      for (const call of digest.calls) {
        if (call.name !== 'takt_trace' || call.args.action !== 'why') continue
        const info = digest.results.get(call.callId)
        if (info?.isError === true || info?.business?.ok !== true) continue
        if (call.callId === confirmedCallId && info.business.defectId === defectId && info.business.confirmed === true) {
          confirmedWhy = { call, info }
          break
        }
      }
      if (confirmedWhy === undefined) throw new Error('缺少确认后成功的 takt_trace why')
      pairs.push({ name: 'takt_trace', action: 'why', callId: confirmedWhy.call.callId, businessOk: true, phase: 'confirmed' })
      return { pairs }
    }, (value) => value)

    // ------------------------------------------------------------------ metrics
    await check('metrics', () => captureMetrics(false), (value) => value)


    // -------------------------------------------------------- optional recipe
    try {
      const trace = await readPanel('trace', { id: requirementId })
      result.optional.push({
        name: 'trace-panel-read',
        status: 'READ_OK',
        detail: {
          scope: '追溯面板可读，不代表 recipeKey 关联已验证',
          keys: Object.keys(trace ?? {}),
          nodes: Array.isArray(trace?.nodes) ? trace.nodes.length : null,
          edges: Array.isArray(trace?.edges) ? trace.edges.length : null,
        },
      })
    } catch (error) {
      result.optional.push({
        name: 'trace-panel-read',
        status: 'NOT_RUN',
        reason: D.scrubText(error instanceof Error ? error.message : String(error), context()),
      })
    }
    markStage('post-checks')
    await progress('验收检查完成，清理隔离资源')
  } catch (error) {
    failure = error
    result.error = D.scrubText(error instanceof Error ? error.message : String(error), context())
    await progress(`失败：${result.error}`)
  } finally {
    // 原始失败保持优先；任何清理前都尽力保留已发生的真实模型调用。
    try { await captureMetrics(failure !== undefined || failures.length > 0) } catch (error) {
      result.metrics = { ...result.metrics, partial: true, collectionError: D.scrubText(error instanceof Error ? error.message : String(error), context()) }
    }
    if (cardHelper?.child !== undefined && cardHelper.child.exitCode === null) {
      try { cardHelper.child.kill('SIGTERM') } catch { /* 已退出 */ }
      const stopped = await waitChild(cardHelper, 3_000)
      if (stopped.timeout) {
        try { cardHelper.child.kill('SIGKILL') } catch { /* 已退出 */ }
        const killed = await waitChild(cardHelper, 3_000)
        if (killed.timeout) failure ??= new Error('卡片 helper 未在清理时退出')
      }
    }
    for (const [name, action] of [
      ['host-stop', () => host?.stop()],
      ['home-cleanup', () => (home === undefined ? undefined : cleanupOwnedHome(home))],
      ['pack-cleanup', () => packed?.cleanup()],
    ]) {
      try {
        await action()
      } catch (error) {
        result.cleanupError = D.scrubText(error instanceof Error ? error.message : String(error), context())
        if (failure === undefined) failure = error
      }
    }
    result.evidence.hostOutput = hostOutput.snapshot(context())
    hostOutput.clear()
    result.finishedAt = new Date().toISOString()
    result.durationMs = Date.now() - startedAt.getTime()
    result.checks = [...checks.values()]
    const verdict = verdictOf({ failure, failures, checks })
    result.ok = verdict.ok
    result.status = verdict.ok ? 'PASS' : 'FAIL'
    result.failed = verdict.failed
    result.optional = result.optional ?? []
    const clean = D.scrubValue(result, context())
    await writeJson(path.join(outDir, 'defect-result.json'), clean, secrets)
    await writeJson(path.join(outDir, `defect-result-t1-${startedAt.toISOString().replace(/[^0-9A-Z]/g, '')}.json`), clean, secrets)
    await writeJson(path.join(packageRoot, '.dev', 'e2e', 'defect-result.json'), clean, secrets).catch(() => {})
    await writeFile(
      path.join(outDir, 'defect-progress.md'),
      D.scrubText(`# M-K defect e2e progress\n\n${progressLines.join('\n')}\n`, context()),
      'utf8',
    ).catch(() => {})
    if (!verdict.ok) {
      throw failure ?? new Error('e2e 断言未全部通过')
    }
    console.log(`M-K defect e2e PASS: ${result.checks.filter((item) => item.status === 'pass').length}/${CHECK_NAMES.length}`)
    console.log(`结果：${path.relative(packageRoot, path.join(outDir, 'defect-result.json'))}`)
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    const secrets = [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY]
    console.error(`[e2e:defect] 失败：${D.scrubText(error instanceof Error ? error.stack ?? error.message : String(error), { secrets, packageRoot, user: userInfo().username })}`)
    process.exit(1)
  })
}
