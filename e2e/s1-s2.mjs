#!/usr/bin/env node
/** S1/S2 真实宿主验收；模型设置仅从环境读取，所有自建资源在 finally 清理。 */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { packTaktflow } from '../scripts/pack.mjs'
import { startHost } from './boot.mjs'
import { cleanupOwnedHome, CookieJar, delay, fetchWithJar, isDirectRun, outDir, packageRoot, poll,
  prepareOwnedHome, requireEnv, resolveDshBin, rpcCall, runCommand, sanitize, writeJson } from './lib.mjs'

const CHECKS = ['isolated-current-package-install', 'normal-completion', 'reserved-child-identity-and-cleanup',
  'scope-pipeline-positive-and-negative', 'child-and-lead-no-shell-or-dispatch', 'request-key-deduplication',
  'readonly-role', 'cancel-immediately-after-run-publication', 'cancel-in-flight-no-later-write', 'lead-offline',
  'resident-runner-parent', 'graceful-process-exit', 'live-plugin-unload', 'process-stop', 'owned-home-cleanup']

export async function main() {
  const env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY, packageRoot]
  const result = { startedAt: new Date().toISOString(), dshVersion: '0.2.1-rc.3',
    scope: '真实 dsh，隔离默认 web profile，最小单 agent 流程；不含完整交付流程', checks: CHECKS.map((name) => ({ name, status: 'NOT_RUN', reason: '尚未执行' })), evidence: {} }
  let home, packed, host, failed = false, currentStep = CHECKS[0], activeRunId, diagnosticProbe
  const record = (value) => { result.checks[result.checks.findIndex((item) => item.name === value.name)] = value }
  const check = async (name, action) => {
    currentStep = name
    try {
      const evidence = await action()
      record({ name, status: 'PASS', ...(evidence === undefined ? {} : { evidence }) })
      console.log(`[S1/S2] ${name}: PASS`)
      return evidence
    } catch (error) {
      failed = true
      const message = sanitize(error.message, secrets)
      record({ name, status: 'FAIL', error: message })
      console.log(`[S1/S2] ${name}: FAIL (${message.slice(0, 250)})`)
      return undefined
    }
  }
  try {
    home = await prepareOwnedHome(path.join(tmpdir(), `taktflow-s12-${randomUUID()}`))
    secrets.push(home)
    const dshBin = await resolveDshBin()
    const childEnv = { ...process.env, DSH_HOME: home, CI: '1', NO_COLOR: '1',
      npm_config_cache: path.join(home, '.npm-cache'), npm_config_store_dir: path.join(home, '.pnpm-store'), PNPM_HOME: path.join(home, '.pnpm'),
      TAKTFLOW_DEBUG_ROUTES: '1', TAKTFLOW_E2E_SPACE: path.join(home, 'workspace', 'space') }
    result.sourceBeforeBuild = await sourceIdentity()
    packed = await packTaktflow({ buildFirst: true })
    result.sourceAfterPack = await sourceIdentity()
    result.packageSha256 = createHash('sha256').update(await readFile(packed.tgz)).digest('hex')
    await runCommand(dshBin, ['plugin', '--profile', 'web', 'add', packed.tgz], {
      env: childEnv, cwd: packageRoot, timeoutMs: 600_000, secrets, label: '隔离 profile 安装',
    })
    const profile = path.join(home, 'profiles', 'web')
    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8'))
    assert(manifest.dsh.profile.bundles.includes('taktflow'))
    await build({ entryPoints: [path.join(packageRoot, 'e2e', 's1-probe.mjs')], outfile: path.join(profile, 's12-probe.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['node:*'], logLevel: 'silent',
      banner: { js: "import { createRequire as __req } from 'node:module';const require = __req(import.meta.url);" },
    })
    await writeFile(path.join(profile, 'cordis.patch.yml'), [
      '# 仅隔离 S1/S2；不配置 Full access，沿用 web 默认权限。',
      '- id: llm-pi-ai', '  config:', '    providers:', '      takt-e2e:', '        api: openai-completions',
      '        baseURL: !!js process.env.TAKT_E2E_BASE_URL', '        apiKeyEnv: TAKT_E2E_API_KEY', '        models:',
      `          - id: ${JSON.stringify(env.TAKT_E2E_MODEL)}`, '- id: agent-default-model', '  config:', '    provider: takt-e2e',
      `    model: ${JSON.stringify(env.TAKT_E2E_MODEL)}`, '- id: session-persistence-jsonl', '  config:',
      "    root: !!js dshHomePath('sessions')", '    compression: none', '- insert:', '    - id: s12-probe',
      `      name: ${JSON.stringify(path.join(profile, 's12-probe.mjs'))}`, '',
    ].join('\n'))
    record({ name: 'isolated-current-package-install', status: 'PASS', evidence: { bundles: manifest.dsh.profile.bundles, fullAccessConfigured: false } })
    host = await startHost({ home, dshBin, env: childEnv })
    let jar = new CookieJar()
    const { response, finalUrl } = await fetchWithJar(host.url, {}, jar)
    assert.equal(response.status, 200); await response.body?.cancel()
    let baseUrl = finalUrl.href
    const probe = async (op, args = {}, timeoutMs = 120_000) => {
      const { response: res } = await fetchWithJar(new URL('api/taktflow.e2e', baseUrl), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) }, jar, { timeoutMs })
      const value = await res.json()
      if (!res.ok || value.ok !== true) throw new Error(`probe ${op}: ${value.error?.code ?? ''} ${value.error?.message ?? res.status}`)
      return value.value
    }
    diagnosticProbe = probe
    const initialized = await probe('init')
    result.evidence.initialized = initialized
    const settled = async (runId) => {
      let latest
      const value = await poll(async () => {
        latest = await probe('get', { runId })
        return ['succeeded', 'failed', 'cancelled'].includes(latest.state?.status) && latest.children.every((child) => !child.live && !child.pending) ? latest : undefined
      }, { timeoutMs: 150_000, intervalMs: 300 })
      if (!value) throw new Error(`运行未收敛：${latest?.state?.status ?? 'missing'}`)
      return value
    }
    const noBypass = (tools) => !tools.some((name) => /^(bash|pwsh)$|subagent|dispatch|workflow|team|schedule|jobs|goal/.test(name))
    currentStep = 'normal-completion'
    const normal = await probe('start', { mode: 'normal' })
    activeRunId = normal.runId
    const normalState = await settled(normal.runId)
    result.evidence.normal = normalState
    await check('normal-completion', () => {
      assert.equal(normalState.state.status, 'succeeded')
      assert.equal(normalState.modelFile, 'S12_MODEL_OK')
      assert(normalState.modelTools.some((tool) => tool.name === 'write' && tool.filePath === 'allowed/model.txt' && !tool.isError))
      return { runId: normal.runId, childIds: normalState.children.map((child) => child.childId), modelWriteVerified: true }
    })
    await check('reserved-child-identity-and-cleanup', () => {
      assert.equal(normalState.children.length, 1)
      const child = normalState.children[0]
      assert(child.permissionAtStart && child.headerId === child.childId)
      assert.equal(child.starts, 1); assert.equal(child.ends, 1); assert.equal(child.live, false); assert.equal(child.permissionPresent, false)
      assert(normalState.events.some((event) => event.type === 'harness.started' && event.data.sessionId === child.childId))
      assert.deepEqual(normalState.registeredPresets, [])
      return { reservedEqualsActual: true, pairedLifecycle: true, presetVisibleDuring: child.presetVisibleDuring, presetReleased: true }
    })
    await check('scope-pipeline-positive-and-negative', () => {
      const probes = normalState.children[0]?.pipelines ?? []
      assert.equal(probes.length, 8)
      assert.equal(probes.find((item) => item.id === 'inside')?.isError, false)
      for (const id of ['outside-scope', 'parent-escape', 'symlink-outside', 'symlink-parent', 'cwd-change', 'bash', 'pwsh']) {
        const item = probes.find((item) => item.id === id)
        assert.equal(item?.isError, true, `${id} 必须拒绝`)
        assert.match(item.message ?? item.text ?? '', /拒绝|not found|not available|unknown tool/i, `${id} 必须是权限或工具缺失拒绝`)
      }
      assert.equal(normalState.forbidden.scope, false); assert.equal(normalState.forbidden.external, false)
      return { source: '真实 child 的 ctx.tools.execute 工具管线，不计模型自主负例', probes }
    })
    await check('child-and-lead-no-shell-or-dispatch', () => {
      assert(noBypass(normalState.children[0].tools)); assert(noBypass(initialized.leadTools))
      assert.notEqual(normalState.children[0].sandbox?.mode, 'danger-full-access')
      assert.equal(normalState.children[0].sandbox?.mode, 'workspace-write')
      return { childTools: normalState.children[0].tools, leadTools: initialized.leadTools, sandbox: normalState.children[0].sandbox }
    })
    await check('request-key-deduplication', async () => {
      const again = await probe('dedupe', { runId: normal.runId })
      assert.equal(again.runId, normal.runId); assert.equal(again.deduped, true)
      return again
    })
    currentStep = 'readonly-role'
    const readonly = await probe('start', { mode: 'readonly' })
    activeRunId = readonly.runId
    const readonlyState = await settled(readonly.runId)
    result.evidence.readonly = readonlyState
    await check('readonly-role', () => {
      assert.equal(readonlyState.state.status, 'succeeded')
      assert(readonlyState.children.length === 1 && !readonlyState.children[0].tools.includes('write') && !readonlyState.children[0].tools.includes('edit'))
      assert.equal(readonlyState.children[0].pipelines[0]?.isError, true)
      assert.equal(readonlyState.forbidden.readonly, false)
      return { noWriteTools: true, pipelineRejected: true, fileAbsent: true }
    })
    currentStep = 'cancel-immediately-after-run-publication'
    const early = await probe('start', { mode: 'early-cancel' })
    activeRunId = early.runId
    const earlyCancelled = await probe('cancel', { runId: early.runId })
    result.evidence.earlyCancel = await settled(early.runId)
    await check('cancel-immediately-after-run-publication', () => {
      assert.equal(earlyCancelled.state.status, 'cancelled')
      assert(earlyCancelled.children.every((child) => !child.live && !child.permissionPresent))
      return { childPublished: earlyCancelled.children.length > 0, count: earlyCancelled.children.length }
    })
    currentStep = 'cancel-in-flight-no-later-write'
    const running = await probe('start', { mode: 'cancel' })
    activeRunId = running.runId
    const executing = await poll(async () => {
      const value = await probe('get', { runId: running.runId })
      return value.state.status === 'running' && value.modelTools.some((tool) => tool.name === 'write' && !tool.isError) ? value : undefined
    }, { timeoutMs: 120_000, intervalMs: 150 })
    if (!executing) throw new Error('执行中取消：没有观察到真实模型写入')
    const cancelled = await probe('cancel', { runId: running.runId })
    await delay(1500)
    const later = await probe('get', { runId: running.runId })
    result.evidence.cancel = { cancelled, afterObservation: later }
    await check('cancel-in-flight-no-later-write', () => {
      assert.equal(cancelled.state.status, 'cancelled'); assert.deepEqual(later.files, cancelled.files)
      assert(later.children.length > 0 && later.children.every((child) => !child.live && !child.permissionPresent && child.starts === child.ends))
      return { modelWriteBeforeCancel: true, filesStableForMs: 1500, childCount: later.children.length }
    })
    const closed = await probe('close-lead')
    assert.equal(closed.live, false)
    currentStep = 'lead-offline'
    const offline = await probe('start', { mode: 'offline' })
    activeRunId = offline.runId
    const offlineState = await settled(offline.runId)
    result.evidence.offline = offlineState
    await check('lead-offline', () => {
      assert.equal(offlineState.state.status, 'cancelled'); assert.equal(offlineState.owner.endReason.reason, 'lead_offline')
      assert.equal(offlineState.children.length, 0)
      return { leadActuallyDisposed: true, endReason: 'lead_offline' }
    })
    currentStep = 'resident-runner-parent'
    const runner = await probe('start-runner')
    activeRunId = runner.runId
    const runnerState = await settled(runner.runId)
    result.evidence.runner = runnerState
    await check('resident-runner-parent', () => {
      assert.equal(runnerState.state.status, 'succeeded')
      assert.equal(runnerState.owner.ownerSessionId, runner.runnerId)
      assert(runnerState.modelTools.some((tool) => tool.name === 'write' && tool.filePath === 'allowed/runner.txt' && !tool.isError))
      return { originalLeadDisposed: true, independentlyCreatedParent: true, childSucceeded: true }
    })
    await probe('new-lead')
    currentStep = 'graceful-process-exit'
    const exiting = await probe('start', { mode: 'process-exit' })
    activeRunId = exiting.runId
    const exitExecuting = await poll(async () => {
      const value = await probe('get', { runId: exiting.runId })
      return value.state.status === 'running' && value.modelTools.some((tool) => tool.name === 'write' && !tool.isError) ? value : undefined
    }, { timeoutMs: 120_000, intervalMs: 150 })
    if (!exitExecuting) throw new Error('优雅退出前没有观察到真实模型写入')
    result.evidence.beforeProcessExit = exitExecuting
    await check('graceful-process-exit', async () => {
      const process = await stopIsolatedHost(host)
      host = undefined
      const runDir = path.join(childEnv.TAKTFLOW_E2E_SPACE, '.takt', 'runs', exiting.runId)
      const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'))
      const owner = JSON.parse(await readFile(path.join(runDir, 'owner.json'), 'utf8'))
      const lease = await readFile(path.join(childEnv.TAKTFLOW_E2E_SPACE, '.takt', 'lease.json'), 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return undefined; throw error })
      result.evidence.afterProcessExit = { state, owner, lease, process }
      assert.equal(state.status, 'cancelled'); assert.equal(owner.endReason?.reason, 'host_lost'); assert.equal(lease, undefined)
      assert.notEqual(process.hostSignal, 'SIGKILL', '优雅退出不能由强杀冒充')
      return { runId: exiting.runId, state: state.status, endReason: owner.endReason.reason, leaseReleased: true, process }
    })
    if (host) throw new Error('旧宿主尚未确认停止，不启动第二个宿主')
    // 复用同一自建 home 重启，单独验收插件 live 卸载；遗留旧租约只能显式接管。
    host = await startHost({ home, dshBin, env: childEnv })
    jar = new CookieJar()
    const reopened = await fetchWithJar(host.url, {}, jar)
    assert.equal(reopened.response.status, 200); await reopened.response.body?.cancel()
    baseUrl = reopened.finalUrl.href
    await probe('init')
    if (result.evidence.afterProcessExit?.lease) await probe('takeover')
    currentStep = 'live-plugin-unload'
    const unload = await probe('start', { mode: 'unload' })
    activeRunId = unload.runId
    const unloadExecuting = await poll(async () => {
      const value = await probe('get', { runId: unload.runId })
      return value.state.status === 'running' && value.children.some((child) => child.live) ? value : undefined
    }, { timeoutMs: 60_000, intervalMs: 150 })
    if (!unloadExecuting) throw new Error('卸载前没有在途真实子 Agent')
    const plugins = await rpcCall({ baseUrl, method: 'pluginManager/listPlugins', args: {}, jar, secrets })
    const entries = Array.isArray(plugins) ? plugins : plugins.plugins ?? plugins.entries ?? []
    const target = entries.find((entry) => entry.moduleName === 'taktflow')
    result.evidence.pluginEntryKeys = target ? Object.keys(target) : Object.keys(plugins)
    if (!target) throw new Error('未找到 taktflow 插件卸载入口')
    const change = await rpcCall({ baseUrl, method: 'pluginManager/setPluginEnabled', args: { id: target.entryId, enabled: false }, jar, secrets })
    const unloaded = await poll(async () => {
      const value = await probe('get', { runId: unload.runId })
      return value.servicePresent === false ? value : undefined
    }, { timeoutMs: 20_000, intervalMs: 200 })
    if (!unloaded) {
      record({ name: 'live-plugin-unload', status: 'BLOCKED', reason: '禁用仅持久化配置，观察窗口内宿主服务未消失', change })
      failed = true
      await probe('cancel', { runId: unload.runId }).catch(() => {})
    } else {
      await delay(1000)
      const unloadedLater = await probe('get', { runId: unload.runId })
      result.evidence.unload = { change, after: unloadedLater }
      await check('live-plugin-unload', () => {
        assert.equal(unloadedLater.state.status, 'cancelled'); assert.equal(unloadedLater.owner.endReason.reason, 'host_lost')
        assert.equal(unloadedLater.leasePresent, false); assert.equal(unloadedLater.servicePresent, false)
        assert(unloadedLater.children.every((child) => !child.live && !child.permissionPresent && child.starts === child.ends))
        assert.deepEqual(unloadedLater.files, unloaded.files)
        return { cancelled: true, endReason: 'host_lost', serviceRemoved: true, leaseReleased: true }
      })
    }
  } catch (error) {
    failed = true
    result.error = sanitize(error.stack ?? error.message, secrets)
    record({ name: currentStep, status: 'FAIL', error: sanitize(error.message, secrets) })
    if (activeRunId && diagnosticProbe) {
      try { result.evidence.failureSnapshot = await diagnosticProbe('get', { runId: activeRunId }, 5000) }
      catch (snapshotError) { result.evidence.failureSnapshotError = sanitize(snapshotError.message, secrets) }
    }
    console.log(`[S1/S2] 执行受阻：${sanitize(error.message, secrets).slice(0, 400)}`)
  } finally {
    if (host) await check('process-stop', async () => await stopIsolatedHost(host))
    if (home) await check('owned-home-cleanup', async () => { await cleanupOwnedHome(home); return { removed: true } })
    await packed?.cleanup()
    result.finishedAt = new Date().toISOString()
    result.sourceAfterExecution = await sourceIdentity()
    result.sourceChanged = JSON.stringify(result.sourceBeforeBuild) !== JSON.stringify(result.sourceAfterPack) ||
      JSON.stringify(result.sourceAfterPack) !== JSON.stringify(result.sourceAfterExecution)
    result.ok = !failed && !result.sourceChanged
    result.counts = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].map((status) => [status, result.checks.filter((check) => check.status === status).length]))
    await mkdir(outDir, { recursive: true })
    await writeJson(path.join(outDir, 's12-result.json'), result, secrets)
  }
  if (failed || result.sourceChanged) throw new Error('S1/S2 存在失败或阻断；见脱敏结果文件')
  console.log(`[S1/S2] 完成：${result.counts.PASS} 项通过，${result.counts.NOT_RUN} 项未执行`)
}
const SOURCE_FILES = ['ownership.ts', 'permissions.ts', 'runs.ts', 'run-runtime.ts', 'index.ts', 'dsh-harness.ts',
  'dsh-schema.ts', 'presets.ts', 'role/index.ts', 'dsh-types.ts', 'testing/fake-ctx.ts'].map((file) => `src/host/${file}`)
async function sourceIdentity() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (file) => [file,
    createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex')])))
}

// macOS 的已退出进程组可能对 kill(0) 返回 EPERM；只核对本次持有的 PGID，不碰其它宿主。
async function stopIsolatedHost(host) {
  try { await host.stop(); return { stopped: true, hostSignal: host.child.signalCode, hostExitCode: host.child.exitCode } } catch (error) {
    if (error.code !== 'EPERM' || process.platform === 'win32') throw error
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,pgid=,stat='])
    const members = stdout.split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) => Number(parts[1]) === host.child.pid)
    const active = members.filter((parts) => !parts[2]?.startsWith('Z'))
    if (active.length > 0) throw new Error('宿主停止后仍有活动进程；保留清理失败状态')
    return { stopped: true, hostSignal: host.child.signalCode, hostExitCode: host.child.exitCode, activeGroupMembers: 0, defunctMembers: members.length, verification: 'kill EPERM 后按本次 PGID 读回无活动进程' }
  }
}

if (isDirectRun(import.meta.url)) main().catch((error) => { console.error(sanitize(error.message, [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY])); process.exitCode = 1 })
