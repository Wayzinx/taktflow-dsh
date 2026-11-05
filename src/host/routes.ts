import { realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import {
  AttentionAlreadyAnsweredError,
  createInsights,
  type Actor,
  type EventEnvelope,
  type ProjectStores,
} from '@taktflow/core'
import {
  ApiError,
  createApiCore,
  type ApiCore,
  type EventStream,
  type ReadOp,
  type WriteLease,
} from '@taktflow/server'
import { VERSION } from '../version.js'
import { ApprovalInputError } from './approvals.js'
import type { HostContext } from './dsh-types.js'
import { TaktToolError, type SpaceHandle, type SpaceRegistry, type TaktflowService } from './types.js'

/** ping 的响应体；S4 与客户端面板都用它确认宿主半已加载。 */
export interface PingPayload {
  ok: true
  version: string
  /** 已打开的空间根（P0 最多一个）；面板用第一个。没有传 spaces 时省略。 */
  spaces?: string[]
}

/** 路由配置：审计里代表的人。模型和客户端都不能覆盖它。 */
export interface RoutesConfig {
  /** 默认 os.userInfo().username。 */
  user?: string
}

/**
 * POST 白名单。只有这些操作会落到真实服务；GET 永远不执行它们。
 *
 * P1 再按需加入 artifact.edit / comment.add 等操作，不能直接把 core.write 的
 * 全部写操作暴露给浏览器。
 */
export const WRITE_OPS = ['attention.answer', 'run.start', 'run.cancel', 'lease.release'] as const
export type TaktWriteOp = (typeof WRITE_OPS)[number]

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

interface ActiveStream {
  close(): void
}

/**
 * 注册只读 ping 路由。
 *
 * 调用方：宿主行 apply。
 * 时机：宿主加载时注册；ctx.effect 负责在卸载时注销（disposer 是异步的）。
 * 失败语义：dsh 的 connection.fetch.register 在路径不以 /api/ 开头或路径冲突时
 * 同步抛错，由宿主加载失败暴露，不吞掉。
 */
export function registerPingRoute(ctx: HostContext, spaces?: Pick<SpaceRegistry, 'roots'>): void {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.ping',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(): Promise<Response> {
          const payload: PingPayload = { ok: true, version: VERSION }
          if (spaces) payload.spaces = await spaces.roots().catch(() => [])
          return Response.json(payload)
        },
      }),
    'taktflow ping route',
  )
}

/**
 * 注册面板使用的全部 HTTP 路由（含 ping）。
 *
 * - `GET  /api/taktflow?space=&p=`：只读操作，委托 server 的 api-core；
 * - `POST /api/taktflow.op`：写操作白名单，所有写先 ensureLease；
 * - `GET  /api/taktflow.stream?space=&run=`：SSE，支持 Last-Event-ID 重放；
 * - `GET  /api/taktflow.ping`：最小存活探针。
 *
 * 空间只接受已经注册的根：请求路径先 realpath，再和 SpaceRegistry.roots()
 * 精确比较，避免浏览器通过查询参数打开任意目录。所有响应都不带原始异常。
 */
export function registerRoutes(ctx: HostContext, service: TaktflowService, config: RoutesConfig = {}): void {
  const user = resolveUser(config)
  // api-core 与直接 dispatch 共用同一个租约包装器：所有写入口都必须先 ensureLease。
  const withWriteLease = makeWriteLease(service)
  const core = createApiCore({ withWriteLease })
  const active = new Set<ActiveStream>()
  // 宿主卸载信号：让还在读取空间/运行的 SSE 请求也能立刻结束，而不是挂在磁盘 IO 上。
  const shutdown = new AbortController()

  // 宿主卸载时先结束所有 SSE，再让 effect 逆序注销路由，避免订阅和定时器悬挂。
  ctx.effect(
    () => () => {
      shutdown.abort()
      for (const stream of [...active]) stream.close()
    },
    'taktflow stream cleanup',
  )

  registerPingRoute(ctx, service.spaces)

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleRead(request, service, core),
      }),
    'taktflow read route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.op',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleWrite(request, service, user, withWriteLease),
      }),
    'taktflow write route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.stream',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleStream(request, service, core, active, shutdown.signal),
      }),
    'taktflow stream route',
  )
}

async function handleRead(request: Request, service: TaktflowService, core: ApiCore): Promise<Response> {
  try {
    const url = new URL(request.url)
    const op = url.searchParams.get('p') ?? undefined
    if (op === undefined || op === '') throw new ApiError(400, '缺少读操作参数 p')
    if (isWriteOp(op)) throw new ApiError(400, 'GET 只能执行读操作，写操作请用 POST /api/taktflow.op')

    const space = await resolveSpace(service, url.searchParams.get('space'))
    const params: Record<string, string | undefined> = {}
    for (const [key, value] of url.searchParams) {
      if (key !== 'space' && key !== 'p') params[key] = value
    }

    const data = await core.read(space.stores, op as ReadOp, params)
    return json({ ok: true, data })
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleWrite(
  request: Request,
  service: TaktflowService,
  user: string,
  withWriteLease: WriteLease,
): Promise<Response> {
  // 写入口自身也检查方法：即使有人绕过注册元数据直接 dispatch，GET/HEAD 也永远不写。
  if (request.method !== 'POST') {
    return json({ ok: false, error: { code: 'TAKT_BAD_REQUEST', message: '写操作只接受 POST' } }, 405)
  }
  try {
    const url = new URL(request.url)
    const body = await readJsonBody(request)
    // body 优先，query 只作为兼容回退；其余字段只从 body 读。
    const op = optionalText(body.p, 'p') ?? url.searchParams.get('p') ?? undefined
    if (op === undefined || op === '') throw new ApiError(400, '缺少写操作参数 p')
    if (!isWriteOp(op)) throw new ApiError(400, `未知写操作：${op}`)

    const requestedSpace = optionalText(body.space, 'space') ?? url.searchParams.get('space')
    const space = await resolveSpace(service, requestedSpace)
    const data = await dispatchWrite(service, user, space, op, body, withWriteLease)
    return json({ ok: true, data })
  } catch (error) {
    return errorResponse(error)
  }
}

/** 由 stores 反查已注册空间；直接 dispatch 与 api-core 写包装器共用。 */
async function spaceForStores(service: TaktflowService, stores: ProjectStores): Promise<SpaceHandle> {
  for (const root of await service.spaces.roots()) {
    const handle = await service.spaces.open(root)
    if (handle.stores === stores) return handle
  }
  // 理论上不会走到这里；兜底构造一个只用于租约校验的 handle，不扩大空间注册范围。
  return { root: stores.projectDir, stores, insights: createInsights(stores) }
}

function makeWriteLease(service: TaktflowService): WriteLease {
  return async (stores, fn) => {
    const space = await spaceForStores(service, stores)
    await service.ownership.ensureLease(space)
    return fn()
  }
}

async function dispatchWrite(
  service: TaktflowService,
  user: string,
  space: SpaceHandle,
  op: TaktWriteOp,
  body: Record<string, unknown>,
  withWriteLease: WriteLease,
): Promise<unknown> {
  // 单写者：任何写入口都先确认本宿主持有空间租约；被 CLI/其它宿主占用时 409。
  return withWriteLease(space.stores, async () => {
    switch (op) {
      case 'attention.answer': {
        const requestId = requiredText(body.requestId, 'requestId')
        const attempt = requiredInteger(body.attempt, 'attempt', 0)
        const artifactVersion = body.artifactVersion === undefined
          ? undefined
          : requiredInteger(body.artifactVersion, 'artifactVersion', 1)
        const decision = optionalText(body.decision, 'decision')
        const answer = optionalText(body.answer, 'answer')
        // by 只由宿主决定：忽略 body 里的 by，人的入口固定是 dsh-web。
        const by: Actor = { type: 'human', id: user, via: 'dsh-web' }
        return service.approvals.answer(space, {
          requestId,
          attempt,
          ...(artifactVersion === undefined ? {} : { artifactVersion }),
          ...(decision === undefined ? {} : { decision }),
          ...(answer === undefined ? {} : { answer }),
          by,
        })
      }
      case 'run.start': {
        const requirementId = requiredText(body.requirementId, 'requirementId')
        const workflowId = optionalText(body.workflowId, 'workflowId') ?? 'p0-delivery'
        const requestKey = requiredText(body.requestKey, 'requestKey')
        const args = body.args === undefined ? undefined : requiredObject(body.args, 'args')
        // 归属会话只认绑定表；客户端显式传值时必须与绑定一致，不能自行决定归属。
        const boundSession = await service.bindings.byRequirement(space, requirementId)
        if (boundSession === undefined) {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            `需求 ${requirementId} 还没有绑定 Lead 会话`,
            '先在需求群里创建或绑定 Lead 会话，再从面板启动运行。',
          )
        }
        const requestedSession = optionalText(body.ownerSessionId ?? body.sessionId, 'ownerSessionId')
        if (requestedSession !== undefined && requestedSession !== boundSession) {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            'ownerSessionId 与需求当前绑定的 Lead 会话不一致',
            '不要手动指定归属会话；运行归属由绑定表决定。',
          )
        }
        return service.runs.start({
          space,
          requirementId,
          workflowId,
          ...(args === undefined ? {} : { args }),
          ownerSessionId: boundSession,
          requestKey,
        })
      }
      case 'run.cancel': {
        const runId = requiredText(body.runId, 'runId')
        const by: Actor = { type: 'human', id: user, via: 'dsh-web' }
        await service.runs.cancel(space, runId, by)
        return { runId }
      }
      case 'lease.release': {
        // running 和 waiting_human 都拒绝释放：待人运行仍可能被审批唤醒，释放后
        // 本宿主会在失去单写者身份的情况下继续写入，CLI 也可能同时接管。
        const unfinished = (await space.stores.runs.list()).find(
          (run) => run.status === 'running' || run.status === 'waiting_human',
        )
        if (unfinished !== undefined) {
          throw new TaktToolError(
            'TAKT_RUN_BUSY',
            `运行 ${unfinished.runId} 仍在${unfinished.status === 'waiting_human' ? '等待人工处理' : '执行'}，不能释放租约`,
            '先完成或取消运行，再释放租约。',
          )
        }
        await service.ownership.release(space)
        return { released: true }
      }
      default:
        // 白名单类型已收窄，这里只防御运行时被篡改的调用。
        throw new ApiError(400, `未知写操作：${String(op)}`)
    }
  })
}

async function handleStream(
  request: Request,
  service: TaktflowService,
  core: ApiCore,
  active: Set<ActiveStream>,
  shutdown: AbortSignal,
): Promise<Response> {
  const signals = [request.signal, shutdown]
  try {
    if (signals.some((signal) => signal.aborted)) return new Response(null, { status: 204 })
    const url = new URL(request.url)
    // 空间解析与运行读取也可能被磁盘 IO 卡住；与 abort/宿主卸载竞速，避免悬挂。
    const space = await abortable(resolveSpace(service, url.searchParams.get('space')), signals)
    const runId = url.searchParams.get('run')?.trim()
    if (runId === undefined || runId === '') throw new ApiError(400, '缺少 run 参数')

    // 先确认运行存在：这样“运行不存在”还能返回 JSON 404，而不是一条空 SSE。
    const state = await abortable(space.stores.runs.get(runId), signals)
    if (state === undefined) throw new ApiError(404, '运行不存在')

    // 查询参数 after 优先；断线重连时浏览器会带 Last-Event-ID。
    const cursor = parseCursor(url.searchParams.get('after'), request.headers.get('last-event-id'))
    return await openStream(request, core, space, runId, cursor, active, shutdown)
  } catch (error) {
    if (error instanceof StreamAborted) return new Response(null, { status: 204 })
    return errorResponse(error)
  }
}

async function openStream(
  request: Request,
  core: ApiCore,
  space: SpaceHandle,
  runId: string,
  cursor: number,
  active: Set<ActiveStream>,
  shutdown: AbortSignal,
): Promise<Response> {
  if (shutdown.aborted) return new Response(null, { status: 204 })
  const abort = new AbortController()
  const events = core.events(space.stores, runId, cursor, abort.signal) as EventStream
  const iterator = events[Symbol.asyncIterator]()
  const encoder = new TextEncoder()

  let closed = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const closeStream = (): void => {
    try {
      streamController?.close()
    } catch {
      // 流已经关闭/取消，重复 close 不抛给调用方。
    }
  }

  const finish = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    request.signal.removeEventListener('abort', onAbort)
    active.delete(record)
    abort.abort()
    const returned = iterator.return?.()
    if (returned !== undefined) void Promise.resolve(returned).catch(() => {})
  }

  const onAbort = (): void => {
    finish()
    closeStream()
  }

  const record: ActiveStream = {
    close: () => {
      finish()
      closeStream()
    },
  }

  active.add(record)
  request.signal.addEventListener('abort', onAbort, { once: true })
  // 注册监听后立即检查：请求在进入本函数前就已 abort 时，不能等到 ready 才退出。
  if (request.signal.aborted || shutdown.aborted) {
    finish()
    return new Response(null, { status: 204 })
  }

  try {
    await events.ready
  } catch (error) {
    // finish() 会把 closed 置 true；必须先记录“是否真的取消”，否则真实的历史读取
    // 失败（坏事件日志、磁盘错误）会被误判成 204 而吞掉。
    const cancelled = closed || request.signal.aborted || shutdown.aborted
    finish()
    if (cancelled) return new Response(null, { status: 204 })
    throw error
  }
  // ready 等待期间宿主卸载（close(record)）或请求取消：绝不能继续创建流和心跳。
  if (closed || request.signal.aborted || shutdown.aborted) {
    finish()
    return new Response(null, { status: 204 })
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 防御性检查：finish 可能刚好发生在构造流之前。
      if (closed) {
        try {
          controller.close()
        } catch {
          // 已关闭。
        }
        return
      }
      streamController = controller
      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'))
        } catch {
          finish()
          closeStream()
        }
      }, 15_000)
      heartbeat.unref?.()
      void pump(controller)
    },
    cancel() {
      // 客户端 reader.cancel()：释放 core 订阅和 AbortController。
      finish()
    },
  })

  return new Response(body, { headers: SSE_HEADERS })

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      while (!closed) {
        const next = await iterator.next()
        if (closed) break
        if (next.done === true) break
        controller.enqueue(encoder.encode(formatEvent(next.value)))
      }
    } catch {
      // 响应头已经发出，无法再转成 JSON 错误；结束流即可。
    } finally {
      if (!closed) {
        finish()
        closeStream()
      }
    }
  }
}

function formatEvent(event: EventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
}

/** SSE 请求在真正建立流之前被 abort/宿主卸载；对外统一转成 204。 */
class StreamAborted extends Error {
  constructor() {
    super('SSE 请求已取消')
    this.name = 'StreamAborted'
  }
}

/**
 * 让任意异步准备步骤与 abort/宿主卸载竞速。
 *
 * 正常完成或失败时移除监听，避免在长连接信号上累积回调；任一信号先触发都
 * 立即拒绝为 StreamAborted，调用方据此返回 204。
 */
function abortable<T>(promise: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  if (signals.some((signal) => signal.aborted)) return Promise.reject(new StreamAborted())
  return new Promise<T>((resolve, reject) => {
    const listeners: Array<() => void> = []
    const cleanup = (): void => {
      for (const [index, signal] of signals.entries()) {
        signal.removeEventListener('abort', listeners[index]!)
      }
    }
    for (const signal of signals) {
      const listener = (): void => {
        cleanup()
        reject(new StreamAborted())
      }
      listeners.push(listener)
      signal.addEventListener('abort', listener, { once: true })
    }
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function parseCursor(after: string | null, lastEventId: string | null): number {
  const raw = after ?? lastEventId
  if (raw === null || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw new ApiError(400, 'after 不合法')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, 'after 不合法')
  return value
}

/**
 * 严格解析空间：只接受 SpaceRegistry 已注册的根。
 *
 * 先 realpath 再比较，symlink 不能绕过；未注册的路径不调用 open，避免通过 HTTP
 * 顺手把一个任意目录绑成空间。roots() 为空（宿主还没打开/配置空间）时一律拒绝。
 */
async function resolveSpace(service: TaktflowService, requested: string | null | undefined): Promise<SpaceHandle> {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  if (raw === '') throw new ApiError(400, '缺少 space 参数')

  let resolved: string
  try {
    resolved = await realpath(path.resolve(raw))
  } catch {
    throw new ApiError(404, '空间根不存在或不可访问')
  }

  const roots = await service.spaces.roots()
  if (!roots.includes(resolved)) throw new ApiError(404, '空间未注册')
  return service.spaces.open(resolved)
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new ApiError(400, '请求体必须是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, '请求体必须是对象')
  }
  return value as Record<string, unknown>
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError(400, `${name} 必须是字符串`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value, name)
  if (text === undefined) throw new ApiError(400, `${name} 必须是非空字符串`)
  return text
}

function requiredInteger(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new ApiError(400, `${name} 必须是 >= ${min} 的整数`)
  }
  return value
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, `${name} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function isWriteOp(op: string): op is TaktWriteOp {
  return (WRITE_OPS as readonly string[]).includes(op)
}

function resolveUser(config: RoutesConfig): string {
  const configured = config.user?.trim()
  return configured === undefined || configured === '' ? userInfo().username : configured
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

/** 浏览器只拿到稳定错误码和可读文案，不暴露堆栈、文件路径或原始异常。 */
function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { ok: false, error: { code: error.status >= 500 ? 'TAKT_INTERNAL' : 'TAKT_BAD_REQUEST', message: error.message } },
      error.status,
    )
  }
  if (error instanceof ApprovalInputError) {
    return json(
      {
        ok: false,
        error: {
          code: 'TAKT_BAD_INPUT',
          message: error.message,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        },
      },
      400,
    )
  }
  if (error instanceof TaktToolError) {
    return json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        },
      },
      statusForCode(error.code),
    )
  }
  if (error instanceof AttentionAlreadyAnsweredError) {
    return json({ ok: false, error: { code: 'TAKT_RUN_BUSY', message: '待办已处理，不会重复推进' } }, 409)
  }
  return json({ ok: false, error: { code: 'TAKT_INTERNAL', message: '服务器内部错误' } }, 500)
}

function statusForCode(code: TaktToolError['code']): number {
  switch (code) {
    case 'TAKT_NOT_BOUND':
    case 'TAKT_NO_SPACE':
      return 404
    case 'TAKT_FORBIDDEN_FOR_LEAD':
      return 403
    case 'TAKT_LEASE_HELD':
    case 'TAKT_RUN_BUSY':
    case 'TAKT_STALE_VERSION':
      return 409
    case 'TAKT_SPACE_ROOT_MISMATCH':
    case 'TAKT_UNSUPPORTED_NODE':
      return 400
  }
}
