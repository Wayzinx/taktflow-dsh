#!/usr/bin/env node
/**
 * S4 第二步：启动隔离 profile，按浏览器实际路径取页面并验证 Host RPC。
 *
 * 运行：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/boot.mjs
 *
 * 断言失败、超时或 dsh 提前退出都会以非零退出；不会把 token/cookie/baseURL/key
 * 写进 e2e/out。成功或失败都会停止 dsh 进程，并清理本次创建的隔离 DSH_HOME
 * 。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertOwnedHome,
  assertSafeHome,
  cleanupOwnedHome,
  CookieJar,
  extractBootPayload,
  fetchWithJar,
  findBootEntries,
  isDirectRun,
  outDir,
  poll,
  readAssistantTexts,
  readJson,
  requireEnv,
  resolveDshBin,
  resolveE2eHome,
  rpcCall,
  sanitize,
  writeJson,
} from './lib.mjs'

const CHECK_NAMES = [
  'startup-url',
  'page-auth',
  'boot-payload',
  'client-entry',
  'client-bundle',
  'ping',
  'preset-list',
  'preset-read',
  'session-create',
  'session-prompt',
  'assistant-pong',
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

function findTokenUrl(text) {
  const cleaned = text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  for (const match of cleaned.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const candidate = match[0].replace(/[),.;]+$/g, '')
    try {
      const url = new URL(candidate)
      if (url.searchParams.has('token')) return url.href
    } catch {
      // 输出里可能还有半行日志，继续找。
    }
  }
  return undefined
}

async function waitForStartupUrl(child, output, timeoutMs, secrets) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `等待 dsh 启动 URL 超时（${timeoutMs}ms）\n${sanitize(output(), secrets).slice(-4000)}`,
          ),
        ),
      )
    }, timeoutMs)
    const onData = () => {
      const found = findTokenUrl(output())
      if (found !== undefined) finish(() => resolve(found))
    }
    const onClose = (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `dsh 在打印启动 URL 前退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）\n${sanitize(output(), secrets).slice(-4000)}`,
          ),
        ),
      )
    }
    const onError = (error) => {
      finish(() =>
        reject(new Error(`dsh 无法启动：${sanitize(error instanceof Error ? error.message : String(error), secrets)}`)),
      )
    }
    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
      fn()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
    onData()
  })
}

async function stopChild(child) {
  if (child === undefined || child.pid === undefined) return
  const pid = child.pid
  const alive = () => {
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
    try { process.kill(-pid, 0); return true } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const signalGroup = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  if (!alive()) return
  signalGroup('SIGTERM')
  if (await poll(() => !alive(), { timeoutMs: 3_000, intervalMs: 100 })) return
  signalGroup('SIGKILL')
  if (!await poll(() => !alive(), { timeoutMs: 3_000, intervalMs: 100 })) {
    throw new Error('dsh 进程组在 SIGKILL 后仍未停止')
  }
}

/** url 仅供当前进程传给浏览器，不得打印或持久化；调用方必须 finally stop。 */
export async function startHost({ home, dshBin, env = process.env }) {
  await assertOwnedHome(home)
  const workspace = path.join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY]
  const child = spawn(dshBin ?? await resolveDshBin(), ['--profile', 'web', '--port', '0', '--no-open'], {
    cwd: workspace,
    env: { ...env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let output = ''
  const append = (chunk) => { output = (output + chunk.toString()).slice(-200_000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    const url = await waitForStartupUrl(child, () => output, 120_000, secrets)
    return {
      url, child, workspace, stop: () => stopChild(child),
      unref() { child.unref(); child.stdout.unref?.(); child.stderr.unref?.() },
    }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function main() {
  const env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY]
  const startedAt = new Date().toISOString()
  const result = {
    ok: false,
    startedAt,
    finishedAt: undefined,
    checks: CHECK_NAMES.map((name) => ({ name, status: 'not-run' })),
    sessionId: undefined,
    assistantText: undefined,
    error: undefined,
    cleanupError: undefined,
  }
  const mark = (name, status, detail) => {
    const check = result.checks.find((item) => item.name === name)
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
      mark(name, 'fail', sanitize(error instanceof Error ? error.message : String(error), secrets))
      throw error
    }
  }

  const statePath = path.join(outDir, 'state.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const home = path.resolve(state.home ?? resolveE2eHome())
  const configuredHome = process.env.TAKT_E2E_HOME?.trim()
  if (configuredHome !== undefined && configuredHome !== '' && await assertSafeHome(configuredHome) !== home) {
    throw new Error(`TAKT_E2E_HOME 与 state.json 不一致：${path.resolve(configuredHome)} != ${home}`)
  }
  await assertOwnedHome(home)
  const dshBin = typeof state.dshBin === 'string' && state.dshBin !== '' ? state.dshBin : await resolveDshBin()
  const workspace = path.join(home, 'workspace')
  let host
  let failure
  let tokenHref

  try {
    host = await step('startup-url', async () => {
      const started = await startHost({ home, dshBin })
      tokenHref = started.url
      secrets.push(tokenHref, new URL(tokenHref).searchParams.get('token'))
      return started
    }, () => ({ captured: true }))
    if (tokenHref === undefined) throw new Error('内部错误：没有捕获到启动 URL')

    const page = await step('page-auth', async () => {
      const jar = new CookieJar()
      const { response, finalUrl, redirects, redirectStatuses } = await fetchWithJar(
        tokenHref,
        { headers: { accept: 'text/html' } },
        jar,
        { secrets, label: 'launch-token exchange' },
      )
      const html = await response.text()
      if (response.status !== 200) {
        throw new Error(`页面 HTTP ${response.status}（重定向 ${redirects} 次）`)
      }
      if (!/text\/html/i.test(response.headers.get('content-type') ?? '')) {
        throw new Error(`页面 Content-Type 不是 HTML：${response.headers.get('content-type') ?? 'missing'}`)
      }
      if (!redirectStatuses.includes(303)) throw new Error('launch-token 没有经过 303 交换')
      if (finalUrl.searchParams.has('token')) throw new Error('重定向后 URL 仍带 token')
      if (jar.size === 0) throw new Error('launch-token 交换后没有拿到 cookie')
      secrets.push(jar.header())
      return { html, jar, pageUrl: finalUrl.href, status: response.status, redirects, redirectStatuses, cookieCount: jar.size }
    }, ({ status, redirects, redirectStatuses, cookieCount }) => ({ status, redirects, redirectStatuses, cookieCount }))

    const payload = await step('boot-payload', async () => {
      const value = extractBootPayload(page.html)
      if (!Array.isArray(value?.entries)) throw new Error('__DSH_BOOT__.entries 不是数组')
      if (!Array.isArray(value?.batches)) throw new Error('__DSH_BOOT__.batches 不是数组')
      return value
    }, (value) => ({ entries: value.entries.length, batches: value.batches.length }))

    const entry = await step('client-entry', async () => {
      const matches = findBootEntries(payload, 'taktflow')
      if (matches.length === 0) throw new Error('boot payload 中没有 id=taktflow 的 client 条目')
      const selected = matches.find((item) => typeof item.url === 'string' && item.url !== '')
      if (selected === undefined) throw new Error('taktflow client 条目没有 url')
      return {
        id: 'taktflow',
        url: new URL(selected.url, page.pageUrl).href,
        rev: selected.rev,
        inject: selected.inject,
      }
    }, ({ id, url, rev, inject }) => ({ id, path: new URL(url).pathname, rev, inject }))

    await step('client-bundle', async () => {
      const { response, finalUrl } = await fetchWithJar(
        entry.url,
        { headers: { accept: 'text/javascript' } },
        page.jar,
        { secrets, label: 'client bundle' },
      )
      const body = await response.text()
      if (response.status !== 200) throw new Error(`client bundle HTTP ${response.status}`)
      if (body.length === 0) throw new Error('client bundle 是空响应')
      if (!body.includes('__ModuleLoader__')) throw new Error('client bundle 没有 __ModuleLoader__ 包装')
      if (!/id\s*:\s*["']taktflow["']/.test(body)) throw new Error('client bundle 没有 id=taktflow')
      return { path: finalUrl.pathname, bytes: body.length }
    }, (value) => value)

    await step('ping', async () => {
      const { response } = await fetchWithJar(
        apiUrl(page.pageUrl, 'api/taktflow.ping'),
        { headers: { accept: 'application/json' } },
        page.jar,
        { secrets, label: 'taktflow.ping' },
      )
      const body = await readJson(response, 'taktflow.ping', secrets)
      if (body?.ok !== true) throw new Error('taktflow.ping 没有返回 ok=true')
      if (typeof body.version !== 'string' || body.version === '') {
        throw new Error('taktflow.ping 没有返回 version')
      }
      return { version: body.version }
    }, (value) => value)

    await step('preset-list', async () => {
      const value = await rpcCall({
        baseUrl: page.pageUrl,
        method: 'agentPresets/list',
        args: {},
        jar: page.jar,
        secrets,
      })
      const presets = Array.isArray(value) ? value : value?.presets
      if (!Array.isArray(presets)) throw new Error('agentPresets/list 没有返回 presets 数组')
      const preset = presets.find((item) => item?.id === 'taktflow')
      if (preset === undefined) throw new Error('agentPresets/list 中没有 taktflow')
      if (Object.hasOwn(preset, 'broken')) {
        throw new Error(`taktflow preset 不可组合：${preset.broken}`)
      }
      return { count: presets.length, isDefault: preset.isDefault === true }
    }, (value) => value)

    await step('preset-read', async () => {
      const value = await rpcCall({
        baseUrl: page.pageUrl,
        method: 'agentPresets/read',
        args: { agentPreset: 'taktflow' },
        jar: page.jar,
        secrets,
      })
      if (value?.agentPreset !== 'taktflow') {
        throw new Error(`agentPresets/read 返回的 preset 是 ${String(value?.agentPreset)}`)
      }
      if (typeof value.content !== 'string' || value.content.trim() === '') {
        throw new Error('agentPresets/read 没有返回 content')
      }
      if (Object.hasOwn(value, 'broken')) {
        throw new Error(`agentPresets/read 返回 broken：${value.broken}`)
      }
      return { contentBytes: value.content.length }
    }, (value) => value)

    const created = await step('session-create', async () => {
      const value = await rpcCall({
        baseUrl: page.pageUrl,
        method: 'session/create',
        args: { request: { agentPreset: 'standard', cwd: workspace } },
        jar: page.jar,
        secrets,
      })
      if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
        throw new Error('session/create 没有返回 sessionId')
      }
      if (value.agentPreset !== 'standard') {
        throw new Error(`session/create 返回的 agentPreset 是 ${String(value.agentPreset)}`)
      }
      result.sessionId = value.sessionId
      return { sessionId: value.sessionId, agentPreset: value.agentPreset }
    }, (value) => value)

    await step('session-prompt', async () => {
      const value = await rpcCall({
        baseUrl: page.pageUrl,
        method: 'session/prompt',
        args: {
          request: {
            requestId: randomUUID(),
            sessionId: created.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: 'reply with the single word: pong' }],
          },
        },
        jar: page.jar,
        secrets,
      })
      if (value?.accepted !== true) throw new Error('session/prompt 没有返回 accepted=true')
      return { accepted: true }
    }, (value) => value)

    const assistant = await step('assistant-pong', async () => {
      const found = await poll(
        async () => {
          if (host.child.exitCode !== null || host.child.signalCode !== null) {
            throw new Error('dsh 在等待回复时退出')
          }
          const texts = await readAssistantTexts(home, created.sessionId)
          const latest = texts.at(-1)
          if (latest === undefined) return undefined
          if (latest.trim().toLowerCase() !== 'pong') throw new Error('assistant 最终文本并非确切 pong')
          return { text: latest }
        },
        { timeoutMs: 180_000, intervalMs: 500 },
      )
      if (found === undefined) {
        const seen = await readAssistantTexts(home, created.sessionId)
        throw new Error(
          `等待 assistant pong 超时；assistant 消息数：${seen.length}`,
        )
      }
      result.assistantText = sanitize(found.text, secrets)
      return { text: result.assistantText, source: 'assistant/message' }
    }, (value) => value)
    void assistant
  } catch (error) {
    failure = error
    result.error = sanitize(error instanceof Error ? error.message : String(error), secrets)
  } finally {
    for (const [name, action] of [
      ['process-stop', () => host?.stop()],
      ['home-cleanup', () => cleanupOwnedHome(home)],
    ]) {
      try { await step(name, action, () => ({ completed: true })) } catch (error) {
        result.cleanupError = sanitize(error instanceof Error ? error.message : String(error), secrets)
        failure ??= error
      }
    }
    result.finishedAt = new Date().toISOString()
    result.ok = failure === undefined && result.checks.every((check) => check.status === 'pass')
    // 写结果失败也是失败；绝不能在缺失证据时打印 passed。
    await writeJson(path.join(outDir, 'boot-result.json'), result, secrets)
  }

  if (failure !== undefined) throw failure
  console.log(`S4 boot e2e passed: ${result.checks.filter((check) => check.status === 'pass').length}/${CHECK_NAMES.length}`)
  console.log(`结果：${path.join(outDir, 'boot-result.json')}`)
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[e2e:boot] 失败：${sanitize(error instanceof Error ? error.stack ?? error.message : String(error), currentSecrets())}`,
    )
    process.exit(1)
  })
}
