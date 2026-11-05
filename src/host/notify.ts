import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  assertRequirementId,
  type EventEnvelope,
  type EventPayloads,
  type RequirementId,
  type RunState,
  type RunStatus,
} from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import type { HostContext, UserMessage } from './dsh-types.js'
import { notImplemented } from './errors.js'
import type { Bindings, Notifier, SpaceHandle } from './types.js'

/** 默认轮询间隔；宿主内文件轮询，取 1 秒兼顾及时性与开销。 */
const DEFAULT_POLL_INTERVAL_MS = 1_000
/** 同一需求的通知合并窗口（技术方案 5.10）。 */
const DEFAULT_MERGE_WINDOW_MS = 5_000
/** 单条通知的最大字符数（按 Unicode 码点计）。 */
const MAX_MESSAGE_CHARS = 200

/** 需要唤醒 Lead 的原因；合并时按优先级保留最需要人处理的那个。 */
type WakeReason = 'human' | 'guard' | 'failed' | 'cancelled' | 'succeeded'

const WAKE_PRIORITY: Record<WakeReason, number> = {
  human: 5,
  guard: 4,
  failed: 3,
  cancelled: 2,
  succeeded: 1,
}

interface Notice {
  requirementId: RequirementId
  runId: string
  line: string
  wake?: WakeReason
  /** 需要保留的待办 ID；用于离线唤醒和过期判断。 */
  requestIds?: string[]
}

interface PendingBatch {
  requirementId: RequirementId
  runIds: Set<string>
  /** 待审批 / 越界 / 终态等必须保留的短句。 */
  priorityLines: string[]
  /** 普通进度；空间不足时优先截断。 */
  normalLines: string[]
  requestIds: Set<string>
  wake?: WakeReason
  timer: ReturnType<typeof setTimeout>
}

/** Lead 离线时未送达的唤醒；上线后且待办仍存在时补发。 */
interface Undelivered {
  text: string
  wake: WakeReason
  requestIds: string[]
}

interface AttachedSpace {
  space: SpaceHandle
  closed: boolean
  initialized: boolean
  polling: boolean
  timer?: ReturnType<typeof setTimeout>
  /** 每个运行已处理到的最后事件序号；避免重复通知。 */
  lastSeq: Map<string, number>
  /** 每个运行上次通知过的状态；避免同状态重复唤醒。 */
  lastStatus: Map<string, RunStatus>
  /** 需要重写快照的需求。 */
  dirty: Set<RequirementId>
  pending: Map<RequirementId, PendingBatch>
  /** 在途的轮询 / 投递任务；detach 时等待它们结束，避免卸载后继续写。 */
  inflight: Set<Promise<void>>
  /** 最近一条已投递文本，供快照展示。 */
  lastMessage: Map<RequirementId, string>
  /** 本空间的脱敏器；attach 时纳入 provider headers。 */
  redact: (text: string) => string
  /** Lead 离线时未送达的唤醒。 */
  undelivered: Map<RequirementId, Undelivered>
}

interface SnapshotNode {
  id: string
  status: string
  attempts: number
  error?: string
}

interface SnapshotPending {
  requestId: string
  runId: string
  nodeId: string
  form: string
  ask: string
  createdAt: string
}

interface SnapshotRun {
  runId: string
  workflowId: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  nodes: SnapshotNode[]
  pending: SnapshotPending[]
}

interface StatusSnapshot {
  requirement: RequirementId
  updatedAt: string
  runs: SnapshotRun[]
  pending: SnapshotPending[]
  lastMessage?: string
}

export interface NotifierDeps {
  /** 用来按 sessionId 取绑定的 Lead 根 Agent。 */
  ctx: Pick<HostContext, 'agents'>
  bindings: Bindings
  pollIntervalMs?: number
  mergeWindowMs?: number
}

/**
 * 通知桥占位实现。
 *
 * 宿主行尚未接线真实通知器时保留，attach/detach 显式失败，避免宿主以为通知已送达。
 */
export class PlaceholderNotifier implements Notifier {
  async attach(_space: SpaceHandle): Promise<void> {
    notImplemented('notifier.attach')
  }

  async detach(_space: SpaceHandle): Promise<void> {
    notImplemented('notifier.detach')
  }
}

/**
 * 创建真实通知器。
 *
 * 实现选择轮询而不是文件 watch：事件日志按运行分文件、运行会动态增加，轮询 runs.list
 * 后按 runId 读增量最简单，也不会漏掉 attach 之后新建的运行；单次轮询内部串行，
 * 不与上一轮重叠。
 *
 * 调用方：宿主行接线时调用一次，空间打开后 attach。
 * 失败语义：attach / detach 不因磁盘或 Agent 故障抛错；错误只影响本轮通知。
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  const mergeWindowMs = Math.max(1, deps.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS)
  const states = new Map<string, AttachedSpace>()

  function track(state: AttachedSpace, task: Promise<void>): void {
    state.inflight.add(task)
    task.then(
      () => state.inflight.delete(task),
      () => state.inflight.delete(task),
    )
  }

  function schedule(state: AttachedSpace): void {
    if (state.closed) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      const task = pollOnce(state)
      track(state, task)
    }, pollIntervalMs)
    state.timer.unref?.()
  }

  async function pollOnce(state: AttachedSpace): Promise<void> {
    if (state.closed || state.polling) return
    state.polling = true
    try {
      await poll(state)
    } catch {
      // 轮询失败不能让宿主或定时器回调崩溃；下一轮继续。
    } finally {
      state.polling = false
      schedule(state)
    }
  }

  async function poll(state: AttachedSpace): Promise<void> {
    if (state.closed) return
    let runs: RunState[]
    try {
      runs = await state.space.stores.runs.list()
    } catch {
      return
    }
    for (const run of runs) {
      if (state.closed) return
      try {
        await pollRun(state, run)
      } catch {
        // 单个运行的事件日志损坏不能拖住其它运行的通知。
      }
    }
    state.initialized = true
    if (state.closed) return
    for (const requirementId of [...state.dirty]) {
      state.dirty.delete(requirementId)
      // 瞬时写失败保留 dirty，下一轮没有新事件也能重试。
      const written = await writeSnapshot(state, requirementId)
      if (!written && !state.closed) state.dirty.add(requirementId)
    }
    await flushUndelivered(state)
  }

  /**
   * Lead 离线时只落了快照；这里在后续轮询里检查绑定和 Agent 是否恢复。
   * 待审批唤醒会先确认对应 requestId 仍在待办里，避免回答后补发过期提醒。
   */
  async function flushUndelivered(state: AttachedSpace): Promise<void> {
    if (state.closed || state.undelivered.size === 0) return
    for (const [requirementId, pending] of [...state.undelivered]) {
      if (state.closed) return
      // 已有合并批次在等窗口，交给正常投递即可。
      if (state.pending.has(requirementId)) continue
      try {
        const sessionId = await deps.bindings.byRequirement(state.space, requirementId)
        if (state.closed) return
        const agent = sessionId ? deps.ctx.agents.get(sessionId) : undefined
        if (!agent) continue
        if (pending.wake === 'human' && pending.requestIds.length > 0) {
          const items = await state.space.stores.attention.list({ requirementId, pending: true })
          if (state.closed) return
          const stillPending = items.some((item) => pending.requestIds.includes(item.requestId))
          if (!stillPending) {
            state.undelivered.delete(requirementId)
            continue
          }
        }
        agent.followup(userMessage(pending.text))
        state.undelivered.delete(requirementId)
      } catch {
        // 绑定 / 待办暂时读不到时保留，下一轮再试。
      }
    }
  }

  async function pollRun(state: AttachedSpace, run: RunState): Promise<void> {
    const previousStatus = state.lastStatus.get(run.runId)
    const firstSeen = !state.lastStatus.has(run.runId) && !state.lastSeq.has(run.runId)
    const afterSeq = state.lastSeq.get(run.runId) ?? 0
    const events = await state.space.stores.events.read(run.runId, { afterSeq })

    // 首次 attach 只补当前状态，不回放历史事件；attach 之后新建的运行仍从头处理。
    if (firstSeen && !state.initialized) {
      const last = events.at(-1)
      if (last) state.lastSeq.set(run.runId, last.seq)
      state.lastStatus.set(run.runId, run.status)
      state.dirty.add(run.requirementId)
      await enqueueInitialStatus(state, run)
      return
    }

    let sawHumanRequest = false
    let sawFinish = false
    for (const event of events) {
      state.lastSeq.set(run.runId, event.seq)
      if (event.type === 'human.requested') sawHumanRequest = true
      if (event.type === 'run.finished') sawFinish = true
      handleEvent(state, run, event)
    }
    state.lastStatus.set(run.runId, run.status)
    if (previousStatus !== undefined && previousStatus !== run.status) {
      // 事件里已经有更具体的描述时不再重复一条状态行。
      const covered = (run.status === 'waiting_human' && sawHumanRequest) ||
        (['failed', 'succeeded', 'cancelled'].includes(run.status) && sawFinish)
      if (!covered) enqueueStatus(state, run, run.status)
    }
  }

  async function enqueueInitialStatus(state: AttachedSpace, run: RunState): Promise<void> {
    if (run.status === 'waiting_human') {
      let ids: string[] = []
      try {
        const pending = await state.space.stores.attention.list({ requirementId: run.requirementId, pending: true })
        ids = pending.filter((item) => item.runId === run.runId).map((item) => item.requestId)
      } catch {
        // 待办读不到时仍通知状态，不让一次读失败吞掉唤醒。
      }
      enqueue(state, {
        requirementId: run.requirementId,
        runId: run.runId,
        line: `当前状态：waiting_human${ids.length ? `，待审批 requestId=${ids.join(',')}` : ''}`,
        wake: 'human',
        requestIds: ids,
      })
      return
    }
    // 历史终态只补快照和普通上下文，不用唤醒打扰 Lead。
    enqueue(state, {
      requirementId: run.requirementId,
      runId: run.runId,
      line: `当前状态：${run.status}`,
    })
  }

  function enqueueStatus(state: AttachedSpace, run: RunState, status: RunStatus): void {
    const wake = status === 'waiting_human' ? 'human'
      : status === 'failed' ? 'failed'
        : status === 'cancelled' ? 'cancelled'
          : status === 'succeeded' ? 'succeeded'
            : undefined
    enqueue(state, {
      requirementId: run.requirementId,
      runId: run.runId,
      line: `运行状态：${status}`,
      wake,
    })
  }

  function handleEvent(state: AttachedSpace, run: RunState, event: EventEnvelope): void {
    const requirementId = run.requirementId
    const runId = run.runId
    const node = event.nodeId ? `节点=${event.nodeId} ` : ''
    state.dirty.add(requirementId)
    switch (event.type) {
      case 'human.requested': {
        const data = event.data as EventPayloads['human.requested']
        enqueue(state, {
          requirementId,
          runId,
          line: `待审批 requestId=${data.requestId} ${node}：${data.ask}`,
          wake: 'human',
          requestIds: [data.requestId],
        })
        return
      }
      case 'guard.violation': {
        const data = event.data as EventPayloads['guard.violation']
        enqueue(state, {
          requirementId,
          runId,
          line: `写入越界（${data.rule}）${node}路径=${data.paths.join(', ')}`,
          wake: 'guard',
        })
        return
      }
      case 'run.finished': {
        const data = event.data as EventPayloads['run.finished']
        enqueue(state, {
          requirementId,
          runId,
          line: `运行结束：${data.status}`,
          wake: wakeForStatus(data.status),
        })
        return
      }
      case 'run.started':
        enqueue(state, { requirementId, runId, line: '运行开始' })
        return
      case 'node.started': {
        const data = event.data as EventPayloads['node.started']
        enqueue(state, { requirementId, runId, line: `${node}开始（第 ${data.attempt} 次）` })
        return
      }
      case 'node.finished': {
        const data = event.data as EventPayloads['node.finished']
        enqueue(state, { requirementId, runId, line: `${node}完成：${data.status}` })
        return
      }
      case 'node.failed': {
        const data = event.data as EventPayloads['node.failed']
        enqueue(state, { requirementId, runId, line: `${node}失败：${data.error}` })
        return
      }
      case 'human.answered': {
        const data = event.data as EventPayloads['human.answered']
        const pending = state.undelivered.get(requirementId)
        if (pending?.requestIds.includes(data.requestId)) state.undelivered.delete(requirementId)
        enqueue(state, {
          requirementId,
          runId,
          line: `待办 requestId=${data.requestId} 已回答：${data.decision ?? '文本回答'}`,
        })
        return
      }
      case 'artifact.written': {
        const data = event.data as EventPayloads['artifact.written']
        enqueue(state, {
          requirementId,
          runId,
          line: `产物 ${data.ref.path}${data.ref.version === undefined ? '' : ` v${data.ref.version}`}`,
        })
        return
      }
      default:
        // 日志、harness 流式消息等不进通知，避免刷屏；快照仍会随 dirty 更新。
        return
    }
  }

  function wakeForStatus(status: RunStatus): WakeReason | undefined {
    if (status === 'waiting_human') return 'human'
    if (status === 'failed') return 'failed'
    if (status === 'cancelled') return 'cancelled'
    if (status === 'succeeded') return 'succeeded'
    return undefined
  }

  function enqueue(state: AttachedSpace, notice: Notice): void {
    if (state.closed) return
    state.dirty.add(notice.requirementId)
    let batch = state.pending.get(notice.requirementId)
    if (!batch) {
      batch = {
        requirementId: notice.requirementId,
        runIds: new Set(),
        priorityLines: [],
        normalLines: [],
        requestIds: new Set(),
        timer: setTimeout(() => {
          state.pending.delete(notice.requirementId)
          const task = deliver(state, batch!)
          track(state, task)
        }, mergeWindowMs),
      }
      batch.timer.unref?.()
      state.pending.set(notice.requirementId, batch)
    }
    batch.runIds.add(notice.runId)
    // 唤醒类短句优先保留；普通进度在 200 字预算里最后填充。
    const target = notice.wake ? batch.priorityLines : batch.normalLines
    const other = notice.wake ? batch.normalLines : batch.priorityLines
    if (!target.includes(notice.line) && !other.includes(notice.line)) target.push(notice.line)
    for (const requestId of notice.requestIds ?? []) batch.requestIds.add(requestId)
    if (notice.wake && (!batch.wake || WAKE_PRIORITY[notice.wake] > WAKE_PRIORITY[batch.wake])) {
      batch.wake = notice.wake
    }
  }

  async function deliver(state: AttachedSpace, batch: PendingBatch): Promise<void> {
    if (state.closed) return
    const text = formatMessage(batch, state.redact)
    state.lastMessage.set(batch.requirementId, text)
    try {
      const sessionId = await deps.bindings.byRequirement(state.space, batch.requirementId)
      // 等待绑定期间可能已经 detach，不能再向已卸载的会话投递。
      if (state.closed) return
      const agent = sessionId ? deps.ctx.agents.get(sessionId) : undefined
      if (agent) {
        const message = userMessage(text)
        if (batch.wake) agent.followup(message)
        else agent.inject(message)
        state.undelivered.delete(batch.requirementId)
      } else if (batch.wake) {
        // Lead 离线：先记下唤醒，后续轮询在 Agent 恢复时补发。
        state.undelivered.set(batch.requirementId, {
          text,
          wake: batch.wake,
          requestIds: [...batch.requestIds],
        })
      }
    } catch {
      // Agent 或绑定故障时只保留快照，不让通知回调把错误抛回定时器；
      // 唤醒类消息记下来，绑定恢复后由 flushUndelivered 补发。
      if (batch.wake && !state.closed) {
        state.undelivered.set(batch.requirementId, {
          text,
          wake: batch.wake,
          requestIds: [...batch.requestIds],
        })
      }
    }
    if (state.closed) return
    const written = await writeSnapshot(state, batch.requirementId)
    if (!written && !state.closed) state.dirty.add(batch.requirementId)
  }

  /**
   * 写状态快照。
   *
   * 返回 false 表示瞬时失败，调用方应保留 dirty 下一轮重试；返回 true 表示已写入
   * 或因为 detach 主动放弃（无需重试）。
   */
  async function writeSnapshot(state: AttachedSpace, requirementId: RequirementId): Promise<boolean> {
    if (state.closed) return true
    try {
      assertRequirementId(requirementId)
      const statusDir = resolve(state.space.stores.taktDir, 'status')
      const base = resolve(statusDir, requirementId)
      // 双保险：需求 ID 已限制为单段，这里再确认解析结果没有逃出 status 目录。
      if (dirname(base) !== statusDir) return true
      const snapshot = await buildSnapshot(state, requirementId)
      // buildSnapshot 可能很慢；期间 detach 后不能再落盘。
      if (state.closed) return true
      const json = await writeAtomic(`${base}.json`, `${JSON.stringify(snapshot, null, 2)}\n`, () => state.closed)
      if (!json) return true
      if (state.closed) return true
      const markdown = await writeAtomic(`${base}.md`, renderMarkdown(snapshot), () => state.closed)
      return markdown || state.closed
    } catch {
      // 快照是旁路信息，写失败不影响运行与通知；保留 dirty 供下一轮重试。
      return false
    }
  }

  async function buildSnapshot(state: AttachedSpace, requirementId: RequirementId): Promise<StatusSnapshot> {
    const runs = (await state.space.stores.runs.list({ requirementId }))
      .slice()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId))
    const pending = (await state.space.stores.attention.list({ requirementId, pending: true }))
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId))
    const pendingView = pending.map((item) => redactPending(item, state.redact))
    const snapshot: StatusSnapshot = {
      requirement: requirementId,
      updatedAt: new Date().toISOString(),
      runs: runs.map((run) => ({
        runId: run.runId,
        workflowId: run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt } : {}),
        nodes: Object.values(run.nodes)
          .slice()
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((node) => ({
            id: node.id,
            status: node.status,
            attempts: node.attempts,
            ...(node.error ? { error: state.redact(node.error) } : {}),
          })),
        pending: pendingView.filter((item) => item.runId === run.runId),
      })),
      pending: pendingView,
    }
    const lastMessage = state.lastMessage.get(requirementId)
    if (lastMessage) snapshot.lastMessage = lastMessage
    return snapshot
  }

  async function attach(space: SpaceHandle): Promise<void> {
    if (states.has(space.root)) return
    const state: AttachedSpace = {
      space,
      closed: false,
      initialized: false,
      polling: false,
      lastSeq: new Map(),
      lastStatus: new Map(),
      dirty: new Set(),
      pending: new Map(),
      inflight: new Set(),
      lastMessage: new Map(),
      // provider 的 apiKeyEnv / 敏感 header 也纳入脱敏，不能只依赖进程环境变量。
      redact: createRedactor(collectSecrets(undefined, space.stores.config.providers)),
      undelivered: new Map(),
    }
    states.set(space.root, state)
    // 首次 attach 立即补当前状态；把它登记为在途任务，detach 会等待它结束。
    // 失败也不让宿主加载失败，后续定时轮询会继续尝试。
    const initial = poll(state)
    track(state, initial)
    try {
      await initial
    } catch {
      // 忽略：后续定时轮询会继续尝试。
    }
    schedule(state)
  }

  async function detach(space: SpaceHandle): Promise<void> {
    const state = states.get(space.root)
    if (!state) return
    states.delete(space.root)
    state.closed = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    for (const batch of state.pending.values()) clearTimeout(batch.timer)
    state.pending.clear()
    // 等在途轮询 / 投递结束；它们会在写之前检查 closed，避免卸载后继续写。
    await Promise.allSettled([...state.inflight])
  }

  return { attach, detach }
}

function userMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // 官方 MessageSource 是已知 kind 的联合；插件消息使用既有的 user 来源，
    // 不自定义 kind，避免运行时校验拒绝。
    source: { kind: 'user' },
  }
}

function redactPending(
  item: { requestId: string; runId: string; nodeId: string; form: string; ask: string; createdAt: string },
  redact: (text: string) => string,
): SnapshotPending {
  return {
    requestId: item.requestId,
    runId: item.runId,
    nodeId: item.nodeId,
    form: item.form,
    ask: redact(item.ask),
    createdAt: item.createdAt,
  }
}

function formatMessage(batch: PendingBatch, redact: (text: string) => string): string {
  const runLabel = batch.runIds.size === 1 ? [...batch.runIds][0]! : [...batch.runIds].join(',')
  const header = `[taktflow] REQ=${batch.requirementId} run=${runLabel}`
  // 顺序固定为：头部 → next action → 唤醒类短句 → 普通进度。
  // 这样进度再多，requestId 和下一步也不会被截掉。
  const primary = redact([header, nextStep(batch.wake), ...batch.priorityLines].join('；'))
  if (batch.normalLines.length === 0) return truncate(primary, MAX_MESSAGE_CHARS)
  const room = MAX_MESSAGE_CHARS - Array.from(primary).length - 1
  if (room <= 0) return truncate(primary, MAX_MESSAGE_CHARS)
  const progress = truncate(redact(batch.normalLines.join('；')), room)
  return truncate(`${primary}；${progress}`, MAX_MESSAGE_CHARS)
}

function nextStep(wake: WakeReason | undefined): string {
  switch (wake) {
    case 'human': return '下一步：调用 takt_ask_human 呈现给人工'
    case 'guard': return '下一步：用 takt_run get 查看越界节点并处理'
    case 'failed': return '下一步：用 takt_run get 查看失败原因，必要时 takt_ask_human'
    case 'cancelled': return '下一步：确认后用 takt_run start 重新启动'
    case 'succeeded': return '下一步：用 takt_status / takt_trace 汇报结果'
    default: return '下一步：用 takt_status 查看进度'
  }
}

/** 按 Unicode 码点截断，避免把代理对切成半个字符。 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 原子写：先写临时文件，再 rename。
 *
 * `aborted` 在每一步异步边界后复查；detach 后不再 rename，并清掉临时文件，
 * 避免卸载后留下新快照。返回 false 表示因 detach 主动放弃。
 */
async function writeAtomic(file: string, content: string, aborted: () => boolean): Promise<boolean> {
  if (aborted()) return false
  await mkdir(dirname(file), { recursive: true })
  if (aborted()) return false
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    // 临时名符合 core guard.metadata 的 <name>.<hex>.tmp 规则；
    // 写完后再查一次，detach 时清掉临时文件而不是改名落盘。
    if (aborted()) {
      await rm(temporary, { force: true }).catch(() => undefined)
      return false
    }
    await rename(temporary, file)
    return true
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function renderMarkdown(snapshot: StatusSnapshot): string {
  const lines = [`# ${snapshot.requirement} 状态`, '', `更新：${snapshot.updatedAt}`, '']
  lines.push('## 待办', '')
  if (snapshot.pending.length === 0) lines.push('（无）')
  else {
    for (const item of snapshot.pending) {
      lines.push(`- \`${item.requestId}\`（${item.nodeId}，${item.form}）：${item.ask}`)
    }
  }
  lines.push('', '## 运行', '')
  if (snapshot.runs.length === 0) lines.push('（无）')
  else {
    for (const run of snapshot.runs) {
      lines.push(`- \`${run.runId}\` ${run.status}（${run.workflowId}）`)
      for (const node of run.nodes) {
        lines.push(`  - ${node.id}：${node.status}（第 ${node.attempts} 次）${node.error ? `；${node.error}` : ''}`)
      }
    }
  }
  if (snapshot.lastMessage) lines.push('', '## 最近通知', '', snapshot.lastMessage)
  lines.push('')
  return lines.join('\n')
}
