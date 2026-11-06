import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { assertNodeId, assertNoSymlinks, assertRunId, writeFileAtomic } from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import type { SessionEvent } from './dsh-types.js'
import type { AgentTrace, SpaceHandle } from './types.js'

/** prompt/systemAppend 的上限；超过后先脱敏再按 UTF-8 字节截断并标注。 */
const PROMPT_BYTES = 64 * 1024
/** finalText 的上限。 */
const FINAL_BYTES = 4 * 1024
/** error 的上限；错误里可能带完整路径或响应片段。 */
const ERROR_BYTES = 4 * 1024
/** denial.reason 的上限。 */
const DENIAL_BYTES = 2 * 1024
/** 单个工具参数摘要的字数上限。 */
const SUMMARY_CHARS = 200
/** 工具调用只保留最近这么多条。 */
const MAX_TOOLS = 200
/** 运行中写盘的最小间隔；结束时的最终刷新不受此限制。 */
const DEFAULT_THROTTLE_MS = 2_000
const TRUNCATED = '\n[truncated]'
const STATUSES: ReadonlySet<string> = new Set(['starting', 'running', 'completed', 'failed', 'cancelled'])

/** dsh-host 在 startActivation 前冻结的追溯输入；文本由本模块统一脱敏和截断。 */
export interface AgentTraceStart {
  runId: string
  nodeId: string
  attempt: number
  label: string
  role: string
  sessionId: string
  preset: { id: string; cfgHash: string; plugins: string[]; skills?: string[] }
  profile: AgentTrace['profile']
  prompt: string
  systemAppend?: string
  outputSchema?: Record<string, unknown>
  /**
   * 本次请求的密钥值（只在内存里用于脱敏，绝不写入记录）。
   * 由 dsh-host 按当前 HarnessRequest 与冻结的 provider 配置收集；
   * 同一空间后续运行的 provider 变化不会影响本次记录的脱敏集合。
   */
  secrets?: readonly string[]
}

/** 节点结束时的终态；由 dsh-host 适配器根据真实 result 和清理结果给出。 */
export interface AgentTraceOutcome {
  status: 'completed' | 'failed' | 'cancelled'
  stopReason?: string
  finalText?: string
  error?: string
}

/** 写权限守卫拒绝的一次操作；守卫是同步的，这里只登记内存并异步落盘。 */
export interface AgentTraceDenial {
  tool: string
  path?: string
  reason: string
}

/** 一次节点尝试的写入句柄；dsh-host 持有，直到最终刷新和 dispose 完成。 */
export interface AgentTraceHandle {
  /** 子 Agent 发布后调用；model/effort 取宿主实际使用的值，拿不到就留空。 */
  running(model?: string, effort?: string): void
  /** 订阅到子会话事件后调用；只处理 tool/usage/model 相关事件。 */
  sessionEvent(event: SessionEvent): void
  /** 写权限守卫拒绝时同步调用；不会抛出，也不会改变拒绝结果。 */
  denial(input: AgentTraceDenial): void
  /** 写入终态并等待落盘；重复调用复用同一个结果。 */
  finish(outcome: AgentTraceOutcome): Promise<void>
  /** 等待挂起写入、移除活动映射；重复调用幂等。 */
  dispose(): Promise<void>
}

/** 守卫只依赖这个窄接口，避免权限模块反向依赖追溯实现。 */
export interface AgentTraceRecorder {
  recordDenial(
    root: string,
    nodeRef: { runId: string; nodeId: string; attempt: number },
    denial: AgentTraceDenial,
  ): void
}

/** 路由只依赖读取接口；运行中的最新状态由实现合并。 */
export interface AgentTraceReader {
  read(space: SpaceHandle, runId: string, nodeId?: string): Promise<AgentTrace[]>
}

/**
 * 权限登记表 → 追溯中心的内部关联。
 *
 * 调用方：RunManager 创建/注入追溯中心时登记；写权限守卫和 HTTP 路由按同一个
 * 权限登记表取回。这样宿主 index 不需要改冻结服务面，守卫也能默认接通拒绝记录。
 */
const hubs = new WeakMap<object, AgentTraceHub>()

/** RunManager 持有追溯中心时登记；同一登记表重复登记以最后一次为准。 */
export function bindAgentTraceHub(registry: object, hub: AgentTraceHub): void {
  hubs.set(registry, hub)
}

/** 守卫/路由按权限登记表取回追溯中心；未登记时返回 undefined。 */
export function agentTraceHubFor(registry: object | undefined): AgentTraceHub | undefined {
  return registry === undefined ? undefined : hubs.get(registry)
}

export interface AgentTraceHubOptions {
  /** 运行中刷新失败只记录诊断，最终刷新仍会重试并交给调用方。 */
  log?: (message: string) => void
  /** 仅供测试缩短节流；生产使用默认 2 秒。 */
  throttleMs?: number
}

interface ActiveTrace {
  key: string
  spaceRoot: string
  file: string
  record: AgentTrace
  /** 本次 begin 冻结的脱敏器；拒绝记录与会话事件都复用它。 */
  redact: (text: string) => string
  /** 已处理的会话事件序号；重复投递不能重复累计工具或 token。 */
  seenSeq: Set<number>
  /** model/effort 的来源优先级：options < header/context（实际请求解析值）。 */
  modelSource?: 'options' | 'header' | 'context'
  effortSource?: 'options' | 'header'
  startedMs: number
  lastWriteAt: number
  tail: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  dirty: boolean
  /** 内存记录每次变更 +1；写盘完成只确认自己开始写时的 revision。 */
  revision: number
  closed: boolean
  finalized: boolean
  /** 尚未返回结果的工具调用；结束时保留 ok=undefined。 */
  pending: Map<string, { entry: AgentTrace['tools'][number]; atMs: number }>
  finishPromise?: Promise<void>
  disposePromise?: Promise<void>
}

interface SpaceTraceStore {
  byKey: Map<string, ActiveTrace>
  bySession: Map<string, ActiveTrace>
  /** 已同步占位、尚未完成首次落盘的键与会话；并发 begin 必须在 await 前就互斥。 */
  pendingKeys: Set<string>
  pendingSessions: Set<string>
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 读取单条落盘记录；损坏或半写文件视为不存在，由调用方按首次执行处理。 */
async function readTraceFile(file: string): Promise<AgentTrace | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isAgentTrace(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function traceKey(runId: string, nodeId: string, attempt: number): string {
  return `${runId}\0${nodeId}#${attempt}`
}

/** 一条落盘记录的合并键；同一 node/attempt 的不同 session 各保留一条。 */
function recordKey(runId: string, nodeId: string, attempt: number, sessionId: string): string {
  return `${runId}\0${nodeId}#${attempt}\0${sessionId}`
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`非法尝试序号：${attempt}`)
}

/** sessionId 只作为文件名片段；URI 编码后再转义 `~`，避免路径分隔符和分隔符歧义。 */
function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/~/g, '%7E')
}

/** 记录文件路径；nodeId 允许 `/`，因此可能落在 agents 下的子目录。 */
export function agentTraceFile(space: SpaceHandle, runId: string, nodeId: string, attempt: number): string {
  assertRunId(runId)
  assertNodeId(nodeId)
  assertAttempt(attempt)
  return join(space.stores.taktDir, 'runs', runId, 'agents', `${nodeId}#${attempt}.json`)
}

/**
 * 同一 node/attempt 的后续执行文件；review 节点会顺序调用多个评审者/作者，
 * 首次执行仍写旧的 `node#attempt.json`，后续执行用本函数生成带 sessionId 的独立文件。
 */
export function agentTraceSessionFile(
  space: SpaceHandle,
  runId: string,
  nodeId: string,
  attempt: number,
  sessionId: string,
): string {
  assertRunId(runId)
  assertNodeId(nodeId)
  assertAttempt(attempt)
  return join(
    space.stores.taktDir,
    'runs',
    runId,
    'agents',
    `${nodeId}#${attempt}~${encodeSessionId(sessionId)}.json`,
  )
}

/** 按 UTF-8 字节截断，附带标记；先脱敏再截断由调用方保证。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(TRUNCATED, 'utf8')
  if (maxBytes <= markerBytes) return TRUNCATED.slice(0, Math.max(0, maxBytes))
  const budget = maxBytes - markerBytes
  let sliced = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8')
  // 字节切点可能落在多字节字符中间；去掉解码产生的替换字符。
  while (sliced.endsWith('\uFFFD')) sliced = sliced.slice(0, -1)
  while (Buffer.byteLength(sliced, 'utf8') > budget) sliced = sliced.slice(0, -1)
  return `${sliced}${TRUNCATED}`
}

/** 按字符（code point）截断；用于工具摘要和短字段。 */
function truncateChars(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]))
  }
  return value
}

function isoTime(value: number): string {
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 工具参数摘要：优先展示路径/命令，原始 JSON 只作为兜底。 */
function summarizeArguments(value: unknown, redact: (text: string) => string): string {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { parsed = value }
  }
  let text: string
  if (typeof parsed === 'string') text = parsed
  else if (isRecord(parsed)) {
    if (typeof parsed.file_path === 'string') text = parsed.file_path
    else if (typeof parsed.path === 'string') text = parsed.path
    else if (typeof parsed.command === 'string') text = parsed.command
    else {
      try { text = JSON.stringify(parsed) } catch { text = String(parsed) }
    }
  } else text = String(parsed)
  return truncateChars(redact(text), SUMMARY_CHARS)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 校验落盘 JSON 的必需字段与嵌套元素；损坏、被篡改或半写的记录直接跳过。 */
function isAgentTrace(value: unknown): value is AgentTrace {
  if (!isRecord(value)) return false
  if (typeof value.runId !== 'string' || typeof value.nodeId !== 'string') return false
  try { assertRunId(value.runId); assertNodeId(value.nodeId) } catch { return false }
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) return false
  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) return false
  if (typeof value.startedAt !== 'string' || typeof value.label !== 'string') return false
  if (typeof value.role !== 'string' || typeof value.sessionId !== 'string') return false
  if (typeof value.prompt !== 'string') return false
  if (!isRecord(value.preset) || typeof value.preset.id !== 'string' || typeof value.preset.cfgHash !== 'string') return false
  if (!isStringArray(value.preset.plugins)) return false
  if (value.preset.skills !== undefined && !isStringArray(value.preset.skills)) return false
  if (!isRecord(value.profile)) return false
  if (typeof value.profile.title !== 'string' || typeof value.profile.description !== 'string') return false
  if (!isStringArray(value.profile.skills) || !isStringArray(value.profile.writeScope)) return false
  if (value.profile.declaredSkills !== undefined && !isStringArray(value.profile.declaredSkills)) return false
  if (typeof value.profile.readOnly !== 'boolean') return false
  if (value.profile.source !== 'space' && value.profile.source !== 'bundled') return false
  if (!Array.isArray(value.tools)) return false
  for (const tool of value.tools) {
    if (!isRecord(tool)) return false
    if (typeof tool.name !== 'string' || typeof tool.summary !== 'string' || typeof tool.at !== 'string') return false
    if (tool.ok !== undefined && typeof tool.ok !== 'boolean') return false
    if (tool.durationMs !== undefined && !isNonNegative(tool.durationMs)) return false
  }
  if (!Array.isArray(value.denials)) return false
  for (const denial of value.denials) {
    if (!isRecord(denial)) return false
    if (typeof denial.tool !== 'string' || typeof denial.reason !== 'string' || typeof denial.at !== 'string') return false
    if (denial.path !== undefined && typeof denial.path !== 'string') return false
  }
  if (value.endedAt !== undefined && typeof value.endedAt !== 'string') return false
  if (value.durationMs !== undefined && !isNonNegative(value.durationMs)) return false
  if (value.model !== undefined && typeof value.model !== 'string') return false
  if (value.effort !== undefined && typeof value.effort !== 'string') return false
  if (value.stopReason !== undefined && typeof value.stopReason !== 'string') return false
  if (value.finalText !== undefined && typeof value.finalText !== 'string') return false
  if (value.error !== undefined && typeof value.error !== 'string') return false
  if (value.systemAppend !== undefined && typeof value.systemAppend !== 'string') return false
  if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) return false
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) return false
    if (!isNonNegative(value.usage.inputTokens) || !isNonNegative(value.usage.outputTokens)) return false
    if (value.usage.cacheReadTokens !== undefined && !isNonNegative(value.usage.cacheReadTokens)) return false
  }
  return true
}

function compareTrace(a: AgentTrace, b: AgentTrace): number {
  const at = Date.parse(a.startedAt)
  const bt = Date.parse(b.startedAt)
  const left = Number.isNaN(at) ? 0 : at
  const right = Number.isNaN(bt) ? 0 : bt
  if (left !== right) return left - right
  const byNode = a.nodeId.localeCompare(b.nodeId)
  if (byNode !== 0) return byNode
  const byAttempt = a.attempt - b.attempt
  return byAttempt !== 0 ? byAttempt : a.sessionId.localeCompare(b.sessionId)
}

/**
 * 按空间隔离的追溯中心。
 *
 * 调用方：宿主行创建一份，传给 RunManager、写权限守卫和 HTTP 路由。
 * 时机：节点启动前 begin，发布后 running，结束时 finish，最终 dispose。
 * 失败语义：首次写盘失败则不启动子 Agent；最终刷新失败向调用方抛出，不能假成功。
 * 并发：同一记录的所有写盘串行；运行中的刷新最多每 2 秒一次，denial 同步入内存。
 * 同一 node/attempt 同时只允许一个活动执行（byKey 互斥）；前一个 dispose 后，
 * 下一个执行写独立的 session 文件，read 按 sessionId 合并保留每次调用。
 */
export class AgentTraceHub implements AgentTraceRecorder {
  private readonly spaces = new Map<string, SpaceTraceStore>()

  constructor(private readonly options: AgentTraceHubOptions = {}) {}

  /** 节点启动前调用；返回前已把 starting 记录原子写入磁盘。 */
  async begin(space: SpaceHandle, input: AgentTraceStart): Promise<AgentTraceHandle> {
    const store = this.storeFor(space)
    const key = traceKey(input.runId, input.nodeId, input.attempt)
    // 占位必须在任何 await 之前完成；否则两个并发 begin 都能通过检查后互相覆盖。
    if (store.byKey.has(key) || store.pendingKeys.has(key)) throw new Error(`该节点尝试已有追溯记录：${input.runId}/${input.nodeId}#${input.attempt}`)
    if (store.bySession.has(input.sessionId) || store.pendingSessions.has(input.sessionId)) throw new Error(`该子会话已有追溯记录：${input.sessionId}`)
    store.pendingKeys.add(key)
    store.pendingSessions.add(input.sessionId)
    try {
      const legacyFile = agentTraceFile(space, input.runId, input.nodeId, input.attempt)
      await assertNoSymlinks(space.root, legacyFile)
      // 首次执行沿用旧文件名；同一 node/attempt 的后续执行（review 的多位评审者/作者）
      // 必须写独立文件，否则前一位的 trace 会被覆盖。
      const legacyExists = await pathExists(legacyFile)
      const file = legacyExists
        ? agentTraceSessionFile(space, input.runId, input.nodeId, input.attempt, input.sessionId)
        : legacyFile
      if (legacyExists) {
        await assertNoSymlinks(space.root, file)
        if (await pathExists(file)) throw new Error(`该子会话已有追溯记录：${input.sessionId}`)
        // 生产 sessionId 不应复用，但旧格式文件不经过 bySession：第二次 begin
        // 会选 `node#attempt~session.json` 而看不到 legacy 文件。读 legacy 的
        // 合法记录，同 session 重用时明确拒绝，避免 read 按 session 归并覆盖视图。
        const legacy = await readTraceFile(legacyFile)
        if (legacy !== undefined && legacy.sessionId === input.sessionId) {
          throw new Error(`该子会话已有追溯记录：${input.sessionId}`)
        }
      }
      // 每次 begin 冻结本次请求的密钥集合；同一空间后续换 provider 不能影响旧记录。
      const redact = createRedactor([
        ...collectSecrets(undefined, space.stores.config?.providers ?? {}),
        ...(input.secrets ?? []),
      ])
      const startedMs = Date.now()
      const record: AgentTrace = {
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      label: truncateChars(redact(input.label), 200),
      role: truncateChars(redact(input.role), 200),
      sessionId: input.sessionId,
      status: 'starting',
      startedAt: new Date(startedMs).toISOString(),
      preset: {
        id: truncateChars(redact(input.preset.id), 200),
        cfgHash: truncateChars(redact(input.preset.cfgHash), 200),
        plugins: input.preset.plugins.map((name) => truncateChars(redact(name), 200)),
        ...(input.preset.skills === undefined
          ? {}
          : { skills: input.preset.skills.map((skill) => truncateChars(redact(skill), 200)) }),
      },
      profile: {
        title: truncateChars(redact(input.profile.title), 200),
        description: truncateChars(redact(input.profile.description), 1_000),
        skills: input.profile.skills.map((skill) => truncateChars(redact(skill), 200)),
        ...(input.profile.declaredSkills === undefined
          ? {}
          : { declaredSkills: input.profile.declaredSkills.map((skill) => truncateChars(redact(skill), 200)) }),
        writeScope: input.profile.writeScope.map((scope) => truncateChars(redact(scope), 200)),
        readOnly: input.profile.readOnly,
        source: input.profile.source,
      },
      prompt: truncateUtf8(redact(input.prompt), PROMPT_BYTES),
      ...(input.systemAppend === undefined
        ? {}
        : { systemAppend: truncateUtf8(redact(input.systemAppend), PROMPT_BYTES) }),
      ...(input.outputSchema === undefined
        ? {}
        : { outputSchema: redactJson(input.outputSchema, redact) as Record<string, unknown> }),
        tools: [],
        denials: [],
      }
      const active: ActiveTrace = {
        key, spaceRoot: space.root, file, record, redact, seenSeq: new Set(),
        startedMs, lastWriteAt: 0,
        tail: Promise.resolve(), dirty: true, revision: 0, closed: false, finalized: false, pending: new Map(),
      }
      store.byKey.set(key, active)
      store.bySession.set(input.sessionId, active)
      try {
        await this.writeSnapshot(active)
      } catch (error) {
        store.byKey.delete(key)
        store.bySession.delete(input.sessionId)
        throw error
      }
      return this.handle(store, active)
    } finally {
      store.pendingKeys.delete(key)
      store.pendingSessions.delete(input.sessionId)
    }
  }

  /** 读取一次运行的全部尝试；活动记录覆盖同键的磁盘快照。 */
  async read(space: SpaceHandle, runId: string, nodeId?: string): Promise<AgentTrace[]> {
    assertRunId(runId)
    if (nodeId !== undefined) assertNodeId(nodeId)
    const persisted = await this.readPersisted(space, runId, nodeId)
    const merged = new Map<string, AgentTrace>()
    for (const trace of persisted) {
      merged.set(recordKey(trace.runId, trace.nodeId, trace.attempt, trace.sessionId), trace)
    }
    const store = this.spaces.get(space.root)
    if (store !== undefined) {
      for (const active of store.byKey.values()) {
        if (active.record.runId !== runId) continue
        if (nodeId !== undefined && active.record.nodeId !== nodeId) continue
        const record = active.record
        merged.set(recordKey(record.runId, record.nodeId, record.attempt, record.sessionId), structuredClone(record))
      }
    }
    return [...merged.values()].sort(compareTrace)
  }

  /** 守卫同步调用；只登记内存并安排刷新，任何失败都不能放行原本被拒的工具。 */
  recordDenial(
    root: string,
    nodeRef: { runId: string; nodeId: string; attempt: number },
    denial: AgentTraceDenial,
  ): void {
    try {
      const store = this.spaces.get(root)
      if (store === undefined) return
      const active = store.byKey.get(traceKey(nodeRef.runId, nodeRef.nodeId, nodeRef.attempt))
      if (active === undefined || active.closed) return
      const redact = active.redact
      active.record.denials.push({
        tool: truncateChars(redact(denial.tool), 200),
        ...(denial.path === undefined ? {} : { path: truncateChars(redact(denial.path), 500) }),
        reason: truncateUtf8(redact(denial.reason), DENIAL_BYTES),
        at: new Date().toISOString(),
      })
      this.touch(active)
      this.markDirty(active, true)
    } catch (error) {
      this.log(`追溯拒绝记录失败：${error instanceof Error ? error.name : 'unknown'}`)
    }
  }

  /** 宿主卸载或测试收尾：冲刷所有活动记录并等待挂起写入，不删除活动映射。 */
  async disposeAll(): Promise<void> {
    const active = [...this.spaces.values()].flatMap((store) => [...store.byKey.values()])
    const results = await Promise.allSettled(active.map(async (item) => {
      this.clearTimer(item)
      // 定时器被取消时内存里可能还有未落盘的终态或拒绝记录；卸载前必须补写。
      if (item.dirty && !item.closed) await this.writeSnapshot(item)
      await item.tail
    }))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), '追溯记录刷新失败')
  }

  private storeFor(space: SpaceHandle): SpaceTraceStore {
    let store = this.spaces.get(space.root)
    if (store === undefined) {
      store = { byKey: new Map(), bySession: new Map(), pendingKeys: new Set(), pendingSessions: new Set() }
      this.spaces.set(space.root, store)
    }
    return store
  }

  private handle(store: SpaceTraceStore, active: ActiveTrace): AgentTraceHandle {
    const hub = this
    return {
      running(model, effort) {
        if (active.closed || active.finalized) return
        active.record.status = 'running'
        // 发布时只补缺失值；request/header 的实际解析配置优先，不能被 options 覆盖。
        if (model !== undefined && model !== '' && (active.modelSource === undefined || active.modelSource === 'options')) {
          active.record.model = truncateChars(active.redact(model), 200)
          active.modelSource = 'options'
        }
        if (effort !== undefined && effort !== '' && (active.effortSource === undefined || active.effortSource === 'options')) {
          active.record.effort = truncateChars(active.redact(effort), 200)
          active.effortSource = 'options'
        }
        hub.touch(active)
        hub.markDirty(active)
      },
      sessionEvent(event) {
        if (active.closed) return
        hub.applyEvent(active, event)
      },
      denial(input) {
        if (active.closed) return
        try {
          active.record.denials.push({
            tool: truncateChars(active.redact(input.tool), 200),
            ...(input.path === undefined ? {} : { path: truncateChars(active.redact(input.path), 500) }),
            reason: truncateUtf8(active.redact(input.reason), DENIAL_BYTES),
            at: new Date().toISOString(),
          })
          hub.touch(active)
          hub.markDirty(active, true)
        } catch (error) {
          hub.log(`追溯拒绝记录失败：${error instanceof Error ? error.name : 'unknown'}`)
        }
      },
      finish(outcome) {
        if (active.finishPromise !== undefined) return active.finishPromise
        const promise = (async () => {
          if (active.closed) return
          hub.clearTimer(active)
          active.finalized = true
          active.record.status = outcome.status
          active.record.endedAt = new Date().toISOString()
          active.record.durationMs = Math.max(0, Date.now() - active.startedMs)
          if (outcome.stopReason !== undefined) {
            active.record.stopReason = truncateChars(active.redact(outcome.stopReason), 200)
          }
          if (outcome.finalText !== undefined) {
            active.record.finalText = truncateUtf8(active.redact(outcome.finalText), FINAL_BYTES)
          }
          if (outcome.error !== undefined) {
            active.record.error = truncateUtf8(active.redact(outcome.error), ERROR_BYTES)
          }
          hub.touch(active)
          try {
            await hub.writeSnapshot(active)
          } catch (error) {
            // 写盘失败不能留下 completed 假成功：允许调用方用 failed 终态重试；
            // 即使只由 dispose 兜底刷新，落盘的也只会是 failed。
            active.record.status = 'failed'
            active.record.error = truncateUtf8(active.redact(`追溯记录写入失败：${errorMessage(error)}`), ERROR_BYTES)
            active.finalized = false
            hub.touch(active)
            throw error
          }
        })()
        active.finishPromise = promise
        // 失败后清除记忆，让调用方能用 failed 终态再次 finish；成功则保持幂等。
        void promise.catch(() => { if (active.finishPromise === promise) active.finishPromise = undefined })
        return promise
      },
      dispose() {
        if (active.disposePromise !== undefined) return active.disposePromise
        active.disposePromise = (async () => {
          hub.clearTimer(active)
          active.closed = true
          try {
            if (active.dirty) await hub.writeSnapshot(active)
            await active.tail
          } finally {
            store.byKey.delete(active.key)
            store.bySession.delete(active.record.sessionId)
          }
        })()
        return active.disposePromise
      },
    }
  }

  private applyEvent(active: ActiveTrace, event: SessionEvent): void {
    if (!isRecord(event)) return
    const data = isRecord(event.data) ? event.data : undefined
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined
    // 订阅和宿主可能重复投递同一事件；按 seq 去重，避免工具和 token 重复累计。
    if (seq !== undefined) {
      if (active.seenSeq.has(seq)) return
      active.seenSeq.add(seq)
    }
    const atMs = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
    const redact = active.redact
    switch (event.type) {
      case 'tool/call': {
        if (data === undefined) return
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        const name = typeof data.name === 'string' ? data.name : undefined
        if (callId === undefined || name === undefined) return
        const entry: AgentTrace['tools'][number] = {
          name: truncateChars(redact(name), 200),
          summary: summarizeArguments(data.arguments, redact),
          at: isoTime(atMs),
        }
        active.record.tools.push(entry)
        if (active.record.tools.length > MAX_TOOLS) active.record.tools.shift()
        active.pending.set(callId, { entry, atMs })
        this.touch(active)
        this.markDirty(active)
        return
      }
      case 'tool/result': {
        if (data === undefined) return
        const message = isRecord(data.message) ? data.message : undefined
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : undefined
        if (callId === undefined) return
        const pending = active.pending.get(callId)
        if (pending === undefined) return
        pending.entry.ok = message?.isError !== true
        pending.entry.durationMs = Math.max(0, atMs - pending.atMs)
        active.pending.delete(callId)
        this.touch(active)
        this.markDirty(active)
        return
      }
      case 'assistant/message': {
        const usage = isRecord(data?.usage) ? data.usage
          : isRecord(data?.message) && isRecord(data.message.usage) ? data.message.usage : undefined
        if (usage === undefined) return
        const input = tokenCount(usage.inputTokens)
        const output = tokenCount(usage.outputTokens)
        const cache = tokenCount(usage.cacheReadTokens)
        if (input === undefined && output === undefined && cache === undefined) return
        active.record.usage ??= { inputTokens: 0, outputTokens: 0 }
        active.record.usage.inputTokens += input ?? 0
        active.record.usage.outputTokens += output ?? 0
        if (cache !== undefined) active.record.usage.cacheReadTokens = (active.record.usage.cacheReadTokens ?? 0) + cache
        this.touch(active)
        this.markDirty(active)
        return
      }
      case 'request/header': {
        const header = isRecord(data?.header) ? data.header : undefined
        const config = isRecord(header?.config) ? header.config : undefined
        if (config === undefined) return
        let changed = false
        // prepareCall 之后的 config 是实际请求配置，优先于发布时的 options 与 context。
        if (typeof config.model === 'string' && config.model !== '') {
          active.record.model = truncateChars(redact(config.model), 200)
          active.modelSource = 'header'
          changed = true
        }
        if (typeof config.reasoningEffort === 'string' && config.reasoningEffort !== '') {
          active.record.effort = truncateChars(redact(config.reasoningEffort), 200)
          active.effortSource = 'header'
          changed = true
        } else {
          // 实际请求没有 effort 时，发布默认值和上一次请求的值都不能继续冒充真实值。
          if (active.record.effort !== undefined) {
            delete active.record.effort
            changed = true
          }
          active.effortSource = 'header'
        }
        if (changed) {
          this.touch(active)
          this.markDirty(active)
        }
        return
      }
      case 'request/context': {
        if (data === undefined) return
        if (typeof data.model !== 'string' || data.model === '') return
        // header 与 context 来自同一份 resolved config；只有 options 来源才用 context 修正。
        if (active.modelSource === 'header') return
        active.record.model = truncateChars(redact(data.model), 200)
        active.modelSource = 'context'
        this.touch(active)
        this.markDirty(active)
        return
      }
      default:
        return
    }
  }

  private markDirty(active: ActiveTrace, force = false): void {
    if (active.closed) return
    if (active.finalized && !force) return
    active.dirty = true
    if (active.timer !== undefined) return
    const throttle = this.options.throttleMs ?? DEFAULT_THROTTLE_MS
    const delay = Math.max(0, throttle - (Date.now() - active.lastWriteAt))
    active.timer = setTimeout(() => {
      active.timer = undefined
      void this.writeSnapshot(active).catch((error: unknown) => {
        this.log(`追溯记录刷新失败：${error instanceof Error ? error.name : 'unknown'}`)
      })
    }, delay)
    active.timer.unref?.()
  }

  private clearTimer(active: ActiveTrace): void {
    if (active.timer === undefined) return
    clearTimeout(active.timer)
    active.timer = undefined
  }

  /** 内存记录发生变更：递增 revision；写盘完成只确认自己开始写时的快照。 */
  private touch(active: ActiveTrace): void {
    active.revision += 1
    active.dirty = true
  }

  /** 同一记录的所有写盘串行，避免旧快照覆盖终态。 */
  private writeSnapshot(active: ActiveTrace): Promise<void> {
    const task = async (): Promise<void> => {
      // 先在当前 revision 上取快照，再等待 IO；IO 期间的新变更不会被误清 dirty。
      const revision = active.revision
      const text = `${JSON.stringify(active.record, null, 2)}\n`
      await assertNoSymlinks(active.spaceRoot, active.file)
      await writeFileAtomic(active.file, text)
      active.lastWriteAt = Date.now()
      if (active.revision === revision) active.dirty = false
    }
    const next = active.tail.then(task, task)
    active.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async readPersisted(space: SpaceHandle, runId: string, nodeId?: string): Promise<AgentTrace[]> {
    const agentsDir = join(space.stores.taktDir, 'runs', runId, 'agents')
    // 从空间根逐段检查，覆盖 `.takt` 本身是符号链接的情况。
    await assertNoSymlinks(space.root, agentsDir)
    const files: string[] = []
    await walkJson(agentsDir, files)
    const traces: AgentTrace[] = []
    for (const file of files.sort()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        // 损坏或正在写入的半文件不阻断整个列表。
        continue
      }
      if (!isAgentTrace(parsed)) continue
      if (parsed.runId !== runId) continue
      if (nodeId !== undefined && parsed.nodeId !== nodeId) continue
      // 内容必须与文件名位置一致；防止手工放置的文件冒充其它节点。
      // 兼容旧格式 `node#attempt.json` 和同 node/attempt 后续执行的 `node#attempt~session.json`。
      const relativePath = relative(agentsDir, file).split(sep).join('/')
      const expected = [
        `${parsed.nodeId}#${parsed.attempt}.json`,
        `${parsed.nodeId}#${parsed.attempt}~${encodeSessionId(parsed.sessionId)}.json`,
      ]
      if (!expected.includes(relativePath)) continue
      traces.push(parsed)
    }
    return traces
  }

  private log(message: string): void {
    try {
      (this.options.log ?? ((value: string) => console.warn(`[taktflow] ${value}`)))(message)
    } catch {
      // 诊断失败不能影响节点执行。
    }
  }
}

async function walkJson(dir: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const target = join(dir, entry.name)
    if (entry.isDirectory()) await walkJson(target, files)
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target)
  }
}
