/**
 * S4 e2e 的共享工具。
 *
 * 这里只做三件事：隔离目录、带 cookie 的 HTTP、脱敏。所有断言和业务判断留在
 * profile.mjs / boot.mjs，方便失败时定位到具体一步。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export const outDir = path.join(packageRoot, 'e2e', 'out')
export const ownedMarkerName = '.taktflow-e2e-owned'
export const ownedMarkerBody = 'taktflow dsh e2e profile\n'

const DEFAULT_DSH_BIN =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** 解析 dsh 可执行文件；显式 DSH_BIN 优先，缺失时回退到本机安装路径。 */
export async function resolveDshBin() {
  const configured = process.env.DSH_BIN?.trim()
  if (configured !== undefined && configured !== '') {
    await access(configured, fsConstants.X_OK)
    return configured
  }
  try {
    await access(DEFAULT_DSH_BIN, fsConstants.X_OK)
    return DEFAULT_DSH_BIN
  } catch {
    return 'dsh'
  }
}

/**
 * 只检查环境变量是否存在，返回值仅用于当前进程；错误信息里只出现变量名。
 */
export function requireEnv(names) {
  const missing = names.filter((name) => {
    const value = process.env[name]
    return value === undefined || value.trim() === ''
  })
  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量：${missing.join(', ')}。请通过进程环境传入；不要把值写进仓库或日志。`,
    )
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]]))
}

export function defaultE2eHome() {
  return path.join(tmpdir(), 'taktflow-dsh-e2e')
}

export function resolveE2eHome() {
  const configured = process.env.TAKT_E2E_HOME?.trim()
  return path.resolve(configured === undefined || configured === '' ? defaultE2eHome() : configured)
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
}

/**
 * 对要进入 stderr/结果文件的文本脱敏。
 *
 * secrets 是本次运行实际使用的 baseURL/key/token URL；正则兜底常见凭证形态。
 * 不要把原始文本先打印再调用这里。
 */
export function sanitize(value, secrets = []) {
  let text = stripAnsi(String(value))
  const ordered = [...new Set(secrets.filter((item) => typeof item === 'string' && item !== ''))]
    .sort((a, b) => b.length - a.length)
  for (const secret of ordered) text = text.split(secret).join('<redacted>')
  text = text.replace(/https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)[^\s"'<>]+/gi, '<redacted-url>')
  text = text.replace(/([?&]token=)[^&\s"'<>]+/gi, '$1<redacted>')
  text = text.replace(/((?:set-)?cookie\s*:\s*)[^\n\r]+/gi, '$1<redacted>')
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-<redacted>')
  text = text.replace(
    /((?:api[_-]?key|authorization|openai_api_key)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    '$1<redacted>',
  )
  return text
}

export class CommandError extends Error {
  constructor(message, { code, stdout, stderr }) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * 跑一个子进程并收集输出。失败/超时都只保留脱敏后的尾部，避免把 token 或
 * 内网地址带进日志。
 */
export async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 120_000,
    secrets = [],
    label = command,
    outputLimit = 200_000,
  } = options

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer

    const append = (current, chunk) => {
      const next = current + chunk.toString()
      return next.length > outputLimit ? next.slice(-outputLimit) : next
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      killTimer.unref?.()
    }, timeoutMs)

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      fn()
    }

    child.on('error', (error) => {
      finish(() =>
        reject(
          new Error(
            `${label} 无法启动：${sanitize(error instanceof Error ? error.message : String(error), secrets)}`,
          ),
        ),
      )
    })

    child.on('close', (code, signal) => {
      finish(() => {
        const cleanStdout = sanitize(stdout, secrets)
        const cleanStderr = sanitize(stderr, secrets)
        if (timedOut) {
          reject(
            new CommandError(
              `${label} 超时（${timeoutMs}ms，signal=${signal ?? 'none'}）\n${cleanStderr || cleanStdout}`.trim(),
              { code, stdout: cleanStdout, stderr: cleanStderr },
            ),
          )
          return
        }
        if (code !== 0) {
          reject(
            new CommandError(
              `${label} 失败（退出码 ${code ?? 'null'}）\n${cleanStderr || cleanStdout}`.trim(),
              { code, stdout: cleanStdout, stderr: cleanStderr },
            ),
          )
          return
        }
        resolve({ stdout: cleanStdout, stderr: cleanStderr, code })
      })
    })
  })
}

export class CookieJar {
  #cookies = new Map()
  #origin

  forOrigin(origin) {
    if (this.#origin !== undefined && this.#origin !== origin) {
      throw new Error('拒绝向其他 origin 发送认证 cookie')
    }
    this.#origin = origin
  }

  store(headers) {
    let values = []
    if (typeof headers.getSetCookie === 'function') {
      values = headers.getSetCookie()
    } else {
      const raw = headers.get('set-cookie')
      if (raw !== null) values = [raw]
    }
    for (const raw of values) {
      const pair = raw.split(';', 1)[0]
      const equals = pair.indexOf('=')
      if (equals <= 0) continue
      const name = pair.slice(0, equals).trim()
      const value = pair.slice(equals + 1).trim()
      if (name !== '') this.#cookies.set(name, value)
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get size() {
    return this.#cookies.size
  }
}

function directoryUrl(url) {
  const parsed = new URL(url)
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed
}

/**
 * 手动跟随重定向并维护 cookie。
 *
 * dsh 的 launch-token 交换是 GET /?token=... → 303 + signed cookie → 200；Node
 * 的 fetch 默认不暴露中间 Set-Cookie，所以这里必须手动处理。
 */
export async function fetchWithJar(url, init = {}, jar, options = {}) {
  const { maxRedirects = 8, label = 'HTTP request', timeoutMs = 30_000 } = options
  let current = new URL(url)
  const origin = current.origin
  jar.forOrigin(origin)
  const signal = init.signal === undefined ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
  const redirectStatuses = []
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const headers = new Headers(init.headers)
    const cookie = jar.header()
    if (cookie !== '') headers.set('cookie', cookie)
    const response = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
      signal,
    })
    jar.store(response.headers)
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current, redirects: redirect, redirectStatuses }
    }
    const location = response.headers.get('location')
    if (location === null || location === '') {
      throw new Error(`${label} 返回 ${response.status} 但没有 Location`)
    }
    const next = new URL(location, current)
    await response.body?.cancel()
    if (next.origin !== origin) throw new Error(`${label} 拒绝跨 origin 重定向`)
    redirectStatuses.push(response.status)
    if (response.status === 303 || (response.status <= 302 && method === 'POST')) {
      method = 'GET'
      body = undefined
      headers.delete('content-type')
      headers.delete('content-length')
    }
    current = next
  }
  throw new Error(`${label} 重定向超过 ${maxRedirects} 次`)
}

export async function readJson(response, label, secrets = []) {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${label} HTTP ${response.status}（响应正文不记录）`,
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 返回的不是 JSON（响应正文不记录）`)
  }
}

/**
 * dsh Host RPC。
 *
 * 信封来自 @deepseek-ai/dsh-client-connection：
 * {type:'client-request', rpcId, method, payload:{args}}；
 * 响应是 {type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}。
 */
export async function rpcCall({ baseUrl, method, args, jar, secrets = [], timeoutMs = 60_000 }) {
  const rpcId = randomUUID()
  const endpoint = new URL(`api/${method}`, directoryUrl(baseUrl))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { response } = await fetchWithJar(
      endpoint,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload: { args },
        }),
        signal: controller.signal,
      },
      jar,
      { secrets, label: `RPC ${method}` },
    )
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(
        `RPC ${method} 返回非 JSON（HTTP ${response.status}；响应正文不记录）`,
      )
    }
    if (!response.ok) {
      throw new Error(
        `RPC ${method} HTTP ${response.status}（响应正文不记录）`,
      )
    }
    if (body?.type !== 'server-response' || body?.rpcId !== rpcId) {
      throw new Error(`RPC ${method} 响应信封不匹配`)
    }
    if (body.result?.ok !== true) {
      const error = body.result?.error
      throw new Error(
        `RPC ${method} 失败：${error?.code ?? 'UNKNOWN'} ${sanitize(error?.message ?? '', secrets)}`.trim(),
      )
    }
    return body.result.value
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`RPC ${method} 超时（${timeoutMs}ms）`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 从 HTML 中截取 window.__DSH_BOOT__ 的平衡 JSON 对象。 */
export function extractBootPayload(html) {
  const marker = '__DSH_BOOT__'
  let from = 0
  while (from < html.length) {
    const markerAt = html.indexOf(marker, from)
    if (markerAt < 0) break
    const start = html.indexOf('{', markerAt + marker.length)
    if (start >= 0) {
      const end = matchingBrace(html, start)
      if (end > start) {
        const raw = html.slice(start, end + 1)
        try {
          return JSON.parse(raw)
        } catch {
          // 继续找下一个出现位置；页面里可能还有 preload 的引用。
        }
      }
    }
    from = markerAt + marker.length
  }
  throw new Error('页面里没有可解析的 window.__DSH_BOOT__')
}

function matchingBrace(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** 展平 entries 和 batches[].entries，返回所有 id 匹配的 boot 行。 */
export function findBootEntries(payload, id) {
  const candidates = []
  if (Array.isArray(payload?.entries)) candidates.push(...payload.entries)
  if (Array.isArray(payload?.batches)) {
    for (const batch of payload.batches) {
      if (Array.isArray(batch?.entries)) {
        for (const entry of batch.entries) {
          if (typeof entry === 'string') candidates.push({ id: entry, url: batch.url, rev: batch.rev })
          else candidates.push(entry)
        }
      }
    }
  }
  return candidates.filter((entry) => entry?.id === id)
}

export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function assistantTextFromEvent(record) {
  const event = record?.type === 'event' && record.event !== undefined ? record.event : record
  if (event?.type !== 'assistant/message') return undefined
  const message = event.data?.message ?? event.message ?? event.data
  const text = contentText(message?.content)
  return text === '' ? undefined : text
}

async function listFiles(root, suffix) {
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
      else if (entry.isFile() && target.endsWith(suffix)) files.push(target)
    }
  }
  await walk(root)
  return files
}

/**
 * 从会话日志里找 assistant 文本。
 *
 * 隔离 profile 把 session-persistence-jsonl 的 compression 设为 none，日志是
 * 可直接读的 JSONL；同时兼容 Node 自带 zstd 的 .jsonl.zstd（Node ≥ 22.15）。
 */
export async function readAssistantTexts(home, sessionId) {
  const sessionsRoot = path.join(home, 'sessions')
  const files = [
    ...(await listFiles(sessionsRoot, '.jsonl')),
    ...(await listFiles(sessionsRoot, '.jsonl.zstd')),
  ]
  const texts = []
  for (const file of files) {
    let text
    try {
      const raw = await readFile(file)
      if (file.endsWith('.zstd')) {
        const zlib = await import('node:zlib')
        if (typeof zlib.zstdDecompressSync !== 'function') {
          throw new Error('当前 Node 不支持 zstd；e2e profile 应设置 compression: none')
        }
        text = zlib.zstdDecompressSync(raw).toString('utf8')
      } else {
        text = raw.toString('utf8')
      }
    } catch {
      continue
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    let header
    try {
      header = JSON.parse(lines[0])
    } catch {
      continue
    }
    if (header?.type !== 'session' || header?.id !== sessionId) continue
    for (const line of lines.slice(1)) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const assistant = assistantTextFromEvent(record)
      if (assistant !== undefined) texts.push(assistant)
    }
  }
  return texts
}

async function canonicalPath(target) {
  let current = path.resolve(target)
  const suffix = []
  for (;;) {
    try {
      return path.join(await realpath(current), ...suffix)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

function isWithin(target, root) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function assertSafeHome(home) {
  const resolved = path.resolve(home)
  const canonical = await canonicalPath(resolved)
  const userDsh = await canonicalPath(path.join(homedir(), '.dsh'))
  if (isWithin(canonical, userDsh) || isWithin(userDsh, canonical)) {
    throw new Error('拒绝使用 ~/.dsh、它的后代或祖先作为 e2e DSH_HOME')
  }
  const stats = await lstat(resolved).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (stats?.isSymbolicLink()) throw new Error('DSH_HOME 不能是符号链接')
  if (stats !== undefined && !stats.isDirectory()) throw new Error('DSH_HOME 不是目录')
  return canonical
}

export async function prepareOwnedHome(home) {
  const resolved = await assertSafeHome(home)
  const entries = await readdir(resolved).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (entries !== undefined && entries.length > 0) {
    await assertOwnedHome(resolved)
    await rm(resolved, { recursive: true, force: true })
  }
  await mkdir(resolved, { recursive: true })
  await writeFile(path.join(resolved, ownedMarkerName), ownedMarkerBody, { encoding: 'utf8', mode: 0o600 })
  return resolved
}

export async function assertOwnedHome(home) {
  await assertSafeHome(home)
  const markerPath = path.join(home, ownedMarkerName)
  const stats = await lstat(markerPath).catch(() => undefined)
  if (stats?.isFile() !== true || stats.isSymbolicLink()) {
    throw new Error('DSH_HOME 缺少安全的 e2e 所有权标记，拒绝使用或清理')
  }
  const marker = await readFile(markerPath, 'utf8')
  if (marker !== ownedMarkerBody) throw new Error('DSH_HOME 所有权标记不匹配，拒绝使用或清理')
}

export async function cleanupOwnedHome(home) {
  await assertOwnedHome(home)
  await rm(home, { recursive: true, force: true })
  const remains = await lstat(home).catch((error) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (remains !== undefined) throw new Error('隔离 DSH_HOME 清理后仍存在')
  return true
}

export async function writeJson(file, value, secrets = []) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${sanitize(JSON.stringify(value, null, 2), secrets)}\n`, 'utf8')
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询直到 fn 返回真值；超时返回 undefined，由调用方给出带上下文的错误。 */
export async function poll(fn, { timeoutMs, intervalMs = 500, signal }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return undefined
    const value = await fn()
    if (value !== undefined && value !== false && value !== null) return value
    await delay(intervalMs)
  }
  return undefined
}

export function isDirectRun(metaUrl) {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href
}
