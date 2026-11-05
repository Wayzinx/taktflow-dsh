#!/usr/bin/env node
/**
 * M-I 子 Agent 追溯验收：隔离 DSH_HOME + 真实 dsh + 真实模型。
 *
 * 只新增本脚本：探针源码通过 esbuild stdin 打包进隔离 profile，不引入第二个文件。
 * 模型地址与密钥只从进程环境读取；落盘结果与样例都先脱敏。失败时如实记录
 * 具体断言和原因，不用假数据宣称通过。
 *
 * 运行：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/agent-trace.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { packTaktflow } from '../scripts/pack.mjs'
import { startHost } from './boot.mjs'
import {
  cleanupOwnedHome,
  CookieJar,
  fetchWithJar,
  isDirectRun,
  outDir,
  packageRoot,
  poll,
  prepareOwnedHome,
  requireEnv,
  resolveDshBin,
  runCommand,
  sanitize,
  writeJson,
} from './lib.mjs'

/** 隔离 profile 里的验收探针；只在本脚本的 esbuild stdin 中使用。 */
const PROBE_SOURCE = String.raw`
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agent, defineWorkflow, initProject } from '../vendor/taktflow/packages/core/src/index.ts'

export const name = 'taktflow-mi-trace-probe'
export const inject = ['connection', 'agents', 'subagents', 'tools']

export function apply(ctx) {
  const root = process.env.TAKTFLOW_E2E_TRACE_SPACE
  if (!root || !process.env.DSH_HOME || !root.startsWith(process.env.DSH_HOME + path.sep)) return
  let service, space, lead, workflowId
  const denialResults = []

  // 子 Agent 一发布就强制一次越权写；denials 不能依赖模型是否自觉。
  ctx.on('subagent/start', (info) => {
    denialResults.push({ stage: 'start', childId: info.id, permission: service?.permissions.lookup(info.id) !== undefined })
    const child = ctx.agents.get(info.id)
    if (!child) {
      denialResults.push({ stage: 'no-child', childId: info.id })
      return
    }
    // 子 Agent 的工具在 activation 过程中才挂载；先等 write 可见再执行，避免误判为工具缺失。
    void (async () => {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (ctx.tools.schemas(child).some((tool) => tool.name === 'write')) { ready = true; break }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      if (!ready) {
        denialResults.push({ stage: 'no-tool', childId: info.id })
        return
      }
      const writeArguments = { file_path: 'other/outside.txt', content: 'forbidden' }
      let isError
      try {
        // dsh 0.2.2 起工具执行器按批接收 calls；0.2.1 仍是单次调用，保留兜底。
        const batch = await ctx.tools.execute({
          calls: [{ id: 'mi-denial-' + randomUUID(), name: 'write', arguments: JSON.stringify(writeArguments) }],
          agent: child, signal: AbortSignal.timeout(15000),
        })
        if (!Array.isArray(batch?.results)) throw new Error('Tool batch execution failed')
        isError = batch.results[0]?.result?.isError
      } catch (error) {
        if (error.message !== 'Tool batch execution failed') throw error
        const single = await ctx.tools.execute({
          callId: 'mi-denial-' + randomUUID(), name: 'write', arguments: writeArguments,
          agent: child, signal: AbortSignal.timeout(15000),
        })
        isError = single.isError
      }
      denialResults.push({ stage: 'done', childId: info.id, isError })
    })().catch((error) => { denialResults.push({ stage: 'error', childId: info.id, error: error.message }) })
  })

  async function initialize() {
    service = ctx.get('taktflow')
    if (!service) throw new Error('taktflow 宿主服务尚未就绪')
    await initProject(root, { name: 'mi-trace' })
    await mkdir(path.join(root, 'allowed'), { recursive: true })
    await mkdir(path.join(root, 'other'), { recursive: true })
    await writeFile(path.join(root, '.takt', 'agents', 'writer.md'), [
      '---', 'role: writer', 'title: writer', 'harness: dsh-host', 'writeScope: ["allowed/**"]',
      'allowBash: false', 'skills: []', '---', '按任务执行；写文件只使用 write 工具，不使用 shell。', '',
    ].join('\n'))
    space = await service.spaces.open(root)
    const originalLoad = service.workflows.load.bind(service.workflows)
    const originalIds = service.workflows.ids.bind(service.workflows)
    workflowId = 'mi-trace-' + randomUUID()
    const definition = defineWorkflow({
      id: workflowId, title: '追溯验收', version: '1', stages: [],
      nodes: [agent({
        id: 'work', title: '写文件', role: 'writer',
        prompt: '必须实际调用 write 工具，file_path=allowed/inside.txt，content=TRACE_OK。不要创建其他文件。调用成功后仅回复 done。',
        writeScope: ['allowed/**'], timeoutMs: 120000,
      })],
    })
    service.workflows.load = (id) => id === workflowId ? Promise.resolve(definition) : originalLoad(id)
    service.workflows.ids = () => [...originalIds(), workflowId]
    lead = await ctx.agents.create({
      sessionId: randomUUID(),
      agentOptions: ctx.get('agentDefaultModel').currentSelection(),
      meta: { cwd: root, agentPreset: 'taktflow' },
      setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, 'taktflow') },
    })
    return { ready: true, leadId: lead.agent.id, workflowId }
  }

  async function start() {
    const requirement = await space.stores.workspaces.createRequirement({ title: 'mi-trace' })
    const result = await service.runs.start({
      space, requirementId: requirement.id, workflowId,
      ownerSessionId: lead.agent.id, requestKey: randomUUID(),
    })
    return { ...result, requirementId: requirement.id }
  }

  async function snapshot(runId) {
    const state = await space.stores.runs.get(runId)
    return { state, denials: denialResults, spaceRoot: root }
  }

  ctx.connection.fetch.register({
    path: '/api/taktflow.e2e', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const input = await request.json()
        let result
        switch (input.op) {
          case 'init': result = await initialize(); break
          case 'start': result = await start(); break
          case 'get': result = await snapshot(input.runId); break
          default: throw new Error('未知验收动作')
        }
        return Response.json({ ok: true, value: result })
      } catch (error) {
        return Response.json({ ok: false, error: { message: error.message } }, { status: 500 })
      }
    },
  })
}
`

const CHECK_NAMES = [
  'isolated-install',
  'trace-starting-running-completed',
  'prompt-preset-profile-frozen',
  'tools-and-usage',
  'denial-recorded',
  'route-consistent',
  'sanitized-sample',
]

function renderPatch(model, probePath) {
  return [
    '# 由 e2e/agent-trace.mjs 生成，仅用于隔离验收；不要提交。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      takt-e2e:',
    '        api: openai-completions',
    '        baseURL: !!js process.env.TAKT_E2E_BASE_URL',
    '        apiKeyEnv: TAKT_E2E_API_KEY',
    '        models:',
    `          - id: ${JSON.stringify(model)}`,
    '- id: agent-default-model',
    '  config:',
    '    provider: takt-e2e',
    `    model: ${JSON.stringify(model)}`,
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '- insert:',
    '    - id: mi-trace-probe',
    `      name: ${JSON.stringify(probePath)}`,
    '',
  ].join('\n')
}

async function main() {
  const env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY]
  const startedAt = new Date().toISOString()
  const result = {
    ok: false,
    startedAt,
    finishedAt: undefined,
    env: { model: env.TAKT_E2E_MODEL, baseUrlEnv: 'TAKT_E2E_BASE_URL', apiKeyEnv: 'TAKT_E2E_API_KEY' },
    checks: CHECK_NAMES.map((name) => ({ name, status: 'NOT_RUN' })),
    evidence: {},
    limitations: [],
    error: undefined,
  }
  const record = (name, status, detail, error) => {
    result.checks[result.checks.findIndex((item) => item.name === name)] = { name, status, ...(detail === undefined ? {} : { detail }), ...(error === undefined ? {} : { error }) }
  }

  let home
  let packed
  let host
  let runId
  let primaryError
  let currentStep

  try {
    home = await prepareOwnedHome(path.join(tmpdir(), `taktflow-mi-trace-${randomUUID()}`))
    secrets.push(home, packageRoot)
    const spaceRoot = path.join(home, 'workspace', 'space')
    const dshBin = await resolveDshBin()
    const childEnv = {
      ...process.env,
      DSH_HOME: home,
      CI: '1',
      NO_COLOR: '1',
      npm_config_cache: path.join(home, '.npm-cache'),
      npm_config_store_dir: path.join(home, '.pnpm-store'),
      PNPM_HOME: path.join(home, '.pnpm'),
      TAKTFLOW_E2E_TRACE_SPACE: spaceRoot,
    }

    packed = await packTaktflow({ buildFirst: true })
    await runCommand(dshBin, ['plugin', '--profile', 'web', 'add', packed.tgz], {
      env: childEnv, cwd: packageRoot, timeoutMs: 600_000, secrets, label: '隔离 profile 安装',
    })
    const profile = path.join(home, 'profiles', 'web')
    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
    assert(Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes('taktflow'))
    record('isolated-install', 'PASS', { bundles: manifest.dsh.profile.bundles, fullAccessConfigured: false })

    // 探针从 stdin 打包，避免在仓库里新增第二个 e2e 文件。
    await build({
      stdin: {
        contents: PROBE_SOURCE,
        resolveDir: path.join(packageRoot, 'e2e'),
        sourcefile: 'agent-trace-probe.mjs',
        loader: 'js',
      },
      outfile: path.join(profile, 'mi-trace-probe.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node:*'], logLevel: 'silent',
      banner: { js: "import { createRequire as __req } from 'node:module';const require = __req(import.meta.url);" },
    })
    await writeFile(path.join(profile, 'cordis.patch.yml'), renderPatch(env.TAKT_E2E_MODEL, path.join(profile, 'mi-trace-probe.mjs')), 'utf8')

    host = await startHost({ home, dshBin, env: childEnv })
    const jar = new CookieJar()
    const opened = await fetchWithJar(host.url, {}, jar)
    assert.equal(opened.response.status, 200)
    await opened.response.body?.cancel()
    const baseUrl = opened.finalUrl.href

    const probe = async (op, args = {}, timeoutMs = 120_000) => {
      const { response } = await fetchWithJar(new URL('api/taktflow.e2e', baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...args }),
      }, jar, { timeoutMs, secrets })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(`probe ${op} 失败：${body.error?.message ?? response.status}`)
      return body.value
    }
    const traceRoute = async (id) => {
      const url = new URL('api/taktflow.agents', baseUrl)
      url.searchParams.set('space', spaceRoot)
      url.searchParams.set('run', id)
      const { response } = await fetchWithJar(url, {}, jar, { secrets, label: 'GET /api/taktflow.agents' })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(`追溯路由失败：${body.error?.message ?? response.status}`)
      return body.data
    }

    const initialized = await probe('init')
    result.evidence.initialized = { leadId: initialized.leadId, workflowId: initialized.workflowId }
    const started = await probe('start')
    runId = started.runId
    result.evidence.runId = runId

    // 运行中观察状态变化；模型调用有真实延迟，足以捕获 running。
    const observed = []
    let latestState
    let latestTraces = []
    let latestSnapshot
    const settled = await poll(async () => {
      const snapshot = await probe('get', { runId }, 30_000)
      latestSnapshot = snapshot
      latestState = snapshot.state
      latestTraces = await traceRoute(runId)
      for (const trace of latestTraces) {
        if (!observed.includes(trace.status)) observed.push(trace.status)
      }
      const terminal = latestState !== undefined && ['succeeded', 'failed', 'cancelled'].includes(latestState.status)
      const traced = latestTraces.some((trace) => trace.nodeId === 'work' && trace.attempt === 1 && trace.status === 'completed')
      return terminal && traced ? { state: latestState, traces: latestTraces } : undefined
    }, { timeoutMs: 150_000, intervalMs: 150 })
    if (settled === undefined) {
      throw new Error(`运行未收敛：state=${latestState?.status ?? 'missing'}；trace=${latestTraces.map((trace) => `${trace.nodeId}#${trace.attempt}:${trace.status}`).join(',') || 'missing'}`)
    }
    currentStep = 'trace-starting-running-completed'
    assert.equal(settled.state.status, 'succeeded', '节点必须真实成功')
    result.evidence.observedTraceStatuses = observed
    assert(observed.includes('running'), '运行中必须从 running 状态可读，而不是只在结束后出现')
    record('trace-starting-running-completed', 'PASS', { observed })

    const traceFile = path.join(spaceRoot, '.takt', 'runs', runId, 'agents', 'work#1.json')
    const recordText = await readFile(traceFile, 'utf8')
    const trace = JSON.parse(recordText)
    result.evidence.traceFile = traceFile
    currentStep = 'prompt-preset-profile-frozen'
    assert.equal(trace.runId, runId)
    assert.equal(trace.nodeId, 'work')
    assert.equal(trace.attempt, 1)
    assert.equal(trace.status, 'completed')
    assert.equal(trace.stopReason, 'completed')
    assert(trace.endedAt !== undefined && trace.durationMs >= 0)
    assert.match(trace.prompt, /allowed\/inside\.txt/)
    assert.equal(trace.profile.source, 'space')
    assert.equal(trace.profile.title, 'writer')
    assert.deepEqual(trace.profile.writeScope, ['allowed/**'])
    assert.equal(trace.profile.readOnly, false)
    assert(trace.preset.id !== '' && trace.preset.cfgHash !== '')
    assert(trace.preset.plugins.length > 0 && trace.preset.plugins.includes('taktflow/role'))
    record('prompt-preset-profile-frozen', 'PASS', {
      promptBytes: Buffer.byteLength(trace.prompt, 'utf8'),
      preset: trace.preset.id,
      plugins: trace.preset.plugins,
      profileSource: trace.profile.source,
    })

    currentStep = 'tools-and-usage'
    assert(trace.tools.length > 0, '工具调用不能为空')
    assert(trace.tools.some((tool) => tool.name === 'write' && tool.ok === true), '必须记录到真实成功的 write 调用')
    assert(trace.usage !== undefined && trace.usage.inputTokens > 0 && trace.usage.outputTokens > 0)
    assert.equal(trace.model, env.TAKT_E2E_MODEL)
    record('tools-and-usage', 'PASS', { tools: trace.tools, usage: trace.usage, model: trace.model, effort: trace.effort })

    currentStep = 'denial-recorded'
    // 探针的越权写是独立异步调用；等它给出 done/error 再判定。
    await poll(async () => {
      latestSnapshot = await probe('get', { runId }, 30_000)
      return latestSnapshot.denials.some((item) => item.stage === 'done' || item.stage === 'error') ? true : undefined
    }, { timeoutMs: 5_000, intervalMs: 100 })
    const denialResults = latestSnapshot?.denials ?? []
    result.evidence.denialProbe = denialResults
    assert(trace.denials.length >= 1, '越权写必须进入 denials')
    assert(trace.denials.some((denial) => denial.tool === 'write' && denial.path === 'other/outside.txt'))
    assert(denialResults.some((item) => item.stage === 'done' && item.childId === trace.sessionId && item.isError === true), '探针的越权写必须被拒绝')
    record('denial-recorded', 'PASS', { denials: trace.denials, probe: denialResults })

    currentStep = 'route-consistent'
    const routed = settled.traces.find((item) => item.nodeId === 'work' && item.attempt === 1)
    assert(routed !== undefined, '追溯路由必须返回该节点')
    assert.deepEqual(routed, trace, '路由返回必须与落盘记录一致')
    record('route-consistent', 'PASS', { count: settled.traces.length, node: routed.nodeId, status: routed.status })

    currentStep = 'sanitized-sample'
    await mkdir(outDir, { recursive: true })
    const samplePath = path.join(outDir, 'agent-trace-sample.json')
    await writeJson(samplePath, trace, secrets)
    const sampleText = await readFile(samplePath, 'utf8')
    for (const secret of secrets) assert(!sampleText.includes(secret), '脱敏样例不能包含密钥或本机路径')
    assert(!/\/Users\/|\/private\/tmp\//.test(sampleText), '脱敏样例不能包含本机绝对路径')
    result.evidence.samplePath = 'e2e/out/agent-trace-sample.json'
    record('sanitized-sample', 'PASS', { path: 'e2e/out/agent-trace-sample.json' })
  } catch (error) {
    primaryError = error
    result.error = sanitize(error instanceof Error ? error.message : String(error), secrets)
    if (currentStep !== undefined) record(currentStep, 'FAIL', undefined, result.error)
    if (runId !== undefined) result.evidence.failedRunId = runId
  } finally {
    if (host !== undefined) {
      try {
        await host.stop()
        result.evidence.hostStopped = true
      } catch (error) {
        result.cleanupError = sanitize(error instanceof Error ? error.message : String(error), secrets)
        primaryError ??= error
      }
    }
    if (home !== undefined) {
      try {
        await cleanupOwnedHome(home)
        result.evidence.homeCleaned = true
      } catch (error) {
        result.cleanupError = sanitize(error instanceof Error ? error.message : String(error), secrets)
        primaryError ??= error
      }
    }
    await packed?.cleanup()
    result.finishedAt = new Date().toISOString()
    result.ok = primaryError === undefined && result.checks.every((check) => check.status === 'PASS')
    result.counts = Object.fromEntries(['PASS', 'FAIL', 'NOT_RUN'].map((status) => [status, result.checks.filter((check) => check.status === status).length]))
    await mkdir(outDir, { recursive: true })
    await writeJson(path.join(outDir, 'agent-trace-result.json'), result, secrets)
  }

  if (!result.ok) throw new Error(result.error ?? '存在失败或未执行的验收项；见 e2e/out/agent-trace-result.json')
  console.log(`[M-I] 追溯 e2e 通过：${result.counts.PASS} 项；样例 e2e/out/agent-trace-sample.json`)
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    const secrets = [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY]
    console.error(`[e2e:agent-trace] 失败：${sanitize(error instanceof Error ? error.stack ?? error.message : String(error), secrets)}`)
    process.exitCode = 1
  })
}
