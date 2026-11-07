import { realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import {
  AttentionAlreadyAnsweredError,
  assertNodeId,
  assertRunId,
  createInsights,
  type Actor,
  type EventEnvelope,
  type HarnessInfo,
  type ModelInfo,
  type ProjectStores,
  type WorkflowChangedEvent,
} from '@taktflow/core'
import {
  ApiError,
  createApiCore,
  type ApiCore,
  type ApiCoreOptions,
  type EventStream,
  type ReadOp,
  type WriteLease,
  type WriteOp,
} from '@taktflow/server'
import { VERSION } from '../version.js'
import { BUNDLED_AGENT_FILES, BUNDLED_WORKFLOW_FILES } from '../templates/bundled.js'
import { askLead, hostModels } from './lead-ask.js'
import { agentTraceHubFor, type AgentTraceReader } from './agent-trace.js'
import { ApprovalInputError } from './approvals.js'
import type { HostContext } from './dsh-types.js'
import { TaktToolError, type AgentTrace, type SpaceHandle, type SpaceRegistry, type TaktflowService, type WorkflowCatalog } from './types.js'

/**
 * 面板 harnesses / models 读操作的运行时目录。
 *
 * 主实现（运行时组装）按空间配置提供；路由不自己编造空数组，缺省时读操作明确
 * 返回 501。结构与 server 包的 CatalogCallbacks 同形（该类型未从包入口导出）。
 */
export interface RoutesCatalog {
  /** 运行时组装已算好的静态目录；有函数回调时优先用函数。 */
  harnesses?: HarnessInfo[]
  models?: ModelInfo[]
  getHarnesses?(stores: ProjectStores): Promise<HarnessInfo[]>
  getModels?(stores: ProjectStores): Promise<ModelInfo[]>
  getCatalog?(stores: ProjectStores): Promise<{ harnesses: HarnessInfo[]; models: ModelInfo[] }>
}

/** 路由可用的服务面；追溯是阶段 3 增量，旧测试替身可以不带。 */
export type RoutesService = TaktflowService & { traces?: AgentTraceReader; catalog?: RoutesCatalog }

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
  /**
   * 仅供单测注入 api-core：用来观察 workflow-stream 的订阅与清理。
   * 生产不传，默认 createApiCore；注入者仍会收到路由构造的租约包装器。
   */
  createCore?: (options: ApiCoreOptions) => ApiCore
}

/** 插件自己的写操作：字段平铺在 POST body 里。 */
export const PLUGIN_WRITE_OPS = ['attention.answer', 'run.start', 'run.cancel', 'lease.release', 'lead.ask'] as const

/**
 * api-core 的写操作白名单：body 为 `{ space, p, params, body }`，全部走租约。
 *
 * 群聊写（room.members / chat.send）不开放：需求群就是 dsh 会话。
 */
export const CORE_WRITE_OPS = [
  'artifact.edit',
  'comment.add',
  'space.members',
  'space.repo.add',
  'space.repo.sync',
  'space.file.edit',
  'workflow.edit',
  'workflow.source.replace',
  'workflow.layout',
  'workflow.rollback',
  // M3：仓库更新、评审处置、路由预览、命令注册表、经验、评测与缺陷归因（docs/design/20）。
  // 权限、风险等级与写原因由 api-core / 命令注册表自己校验。
  'space.repo.update',
  'review.dispose',
  'route.preview',
  'command.run',
  'lesson.update',
  'eval.collect',
  'eval.run',
  'defect.report',
  'defect.attribute',
  'defect.confirm',
  // 可视化配置（docs/design/21）：设置页表单、流程增删改、修订恢复、旧空间升级。
  'space.config.update',
  'space.agent.save',
  'space.agent.delete',
  'space.skill.save',
  'space.skill.delete',
  'space.file.rollback',
  'workflow.create',
  'workflow.meta',
  'workflow.delete',
  'space.upgrade',
] as const

/**
 * POST 白名单。只有这些操作会落到真实服务；GET 永远不执行它们。
 *
 * 不能直接把 core.write 的全部写操作暴露给浏览器：插件操作和 api-core 操作
 * 的请求形状不同，且群聊写永远不开放。
 */
export const WRITE_OPS = [...PLUGIN_WRITE_OPS, ...CORE_WRITE_OPS] as const
export type TaktWriteOp = (typeof WRITE_OPS)[number]
export type TaktPluginWriteOp = (typeof PLUGIN_WRITE_OPS)[number]
export type TaktCoreWriteOp = (typeof CORE_WRITE_OPS)[number]

/** GET 明确不透出的 api-core 读操作；群聊只在 dsh 会话里发生。 */
const BLOCKED_READ_OPS: ReadonlySet<string> = new Set(['room', 'chat'])

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
 * - `GET  /api/taktflow?space=&p=`：只读操作，委托 server 的 api-core（群聊读除外）；
 * - `POST /api/taktflow.op`：写操作白名单，所有写先 ensureLease；
 * - `GET  /api/taktflow.stream?space=&run=`：运行 SSE，支持 Last-Event-ID 重放；
 * - `GET  /api/taktflow.workflow-stream?space=&id=`：流程修订 SSE；
 * - `GET  /api/taktflow.ping`：最小存活探针。
 *
 * 空间只接受已经注册的根：请求路径先 realpath，再和 SpaceRegistry.roots()
 * 精确比较，避免浏览器通过查询参数打开任意目录。所有响应都不带原始异常。
 */
export function registerRoutes(ctx: HostContext, service: TaktflowService, config: RoutesConfig = {}): void {
  const user = resolveUser(config)
  // api-core 与直接 dispatch 共用同一个租约包装器：所有写入口都必须先 ensureLease。
  const withWriteLease = makeWriteLease(service)
  const core = (config.createCore ?? createApiCore)({
    withWriteLease,
    catalog: routesCatalog(service),
    // M-K：把评测/归因命令注册表接到 api-core；没有 m3 的旧服务保持 501。
    ...(service.m3 === undefined ? {} : { getCommands: (stores: ProjectStores) => service.m3!.getCommands(stores) }),
    // 新建流程与空间升级用插件随包的模板（与 init 同一份）。
    templates: () => ({
      workflows: BUNDLED_WORKFLOW_FILES.map((file) => ({ name: file.fileName, content: file.content })),
      agents: BUNDLED_AGENT_FILES.map((file) => ({ name: file.fileName, content: file.content })),
    }),
  })
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
        path: '/api/taktflow.session',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleSession(request, service, ctx),
      }),
    'taktflow session route',
  )

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
        fetch: (request) => handleWrite(request, service, core, user, withWriteLease, ctx),
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

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.workflow-stream',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleWorkflowStream(request, service, core, active, shutdown.signal),
      }),
    'taktflow workflow stream route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.agents',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleAgents(request, service),
      }),
    'taktflow agents route',
  )

  // 角色表单的模型下拉：App 里可用的模型（宿主没有会话服务时 501，面板只显示“跟随 App”）。
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.models',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(): Promise<Response> {
          try { return json({ ok: true, data: await hostModels(ctx) }) } catch (error) { return errorResponse(error) }
        },
      }),
    'taktflow models route',
  )
}

async function handleRead(request: Request, service: TaktflowService, core: ApiCore): Promise<Response> {
  try {
    const url = new URL(request.url)
    const op = url.searchParams.get('p') ?? undefined
    if (op === undefined || op === '') throw new ApiError(400, '缺少读操作参数 p')
    if (isWriteOp(op)) throw new ApiError(400, 'GET 只能执行读操作，写操作请用 POST /api/taktflow.op')
    // 群聊读操作明确不透出：需求群就是 dsh 会话，面板不该再开一条消息通道。
    if (BLOCKED_READ_OPS.has(op)) throw new ApiError(400, `群聊读操作 ${op} 不开放：需求群就是 dsh 会话`)

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
  core: ApiCore,
  user: string,
  withWriteLease: WriteLease,
  ctx: HostContext,
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
    // 告诉 Lead：只是往会话里投递一句话，不写空间，不需要租约。
    if (op === 'lead.ask') return json({ ok: true, data: await askLead(ctx, space, { text: body.text, page: body.page, target: body.target }) })
    if (isPluginWriteOp(op)) {
      const data = await dispatchPluginWrite(service, user, space, op, body, withWriteLease)
      return json({ ok: true, data })
    }
    const data = await dispatchCoreWrite(core, space, op, body, user)
    // workflow 写入可能返回冲突/校验失败对象；必须在 ok:true 包装前识别，
    // 且只认 error 严格等于 'conflict' / 'validation' 的返回值，避免误判文档内容。
    const failure = workflowFailureResponse(data)
    if (failure !== undefined) return failure
    return json({ ok: true, data })
  } catch (error) {
    return errorResponse(error)
  }
}

/** api-core 写操作：params 只接受字符串值，body 原样交给 core，actor 由宿主决定。 */
async function dispatchCoreWrite(
  core: ApiCore,
  space: SpaceHandle,
  op: TaktCoreWriteOp,
  envelope: Record<string, unknown>,
  user: string,
): Promise<unknown> {
  const params = coreParams(envelope.params)
  // 忽略客户端可能塞进 body 的 author/by：人的入口固定是 dsh-web。
  const actor: Actor = { type: 'human', id: user, via: 'dsh-web' }
  return core.write(space.stores, op as WriteOp, params, envelope.body, actor)
}

/** api-core 的 params 与查询串同形：键值都必须是字符串。 */
function coreParams(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'params 必须是对象')
  const params: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new ApiError(400, `params.${key} 必须是字符串`)
    params[key] = item
  }
  return params
}

/**
 * 把 workflow 写操作的返回值转成 HTTP 响应。
 *
 * 返回 WorkflowConflict 时 409 并原样带出 conflict 对象；返回
 * `{ error: 'validation', diagnostics }` 时 400 并原样带出 validation 对象。
 * 其它对象（包括正常的 WorkflowDocument）都返回 undefined，继续按成功包装。
 */
function workflowFailureResponse(value: unknown): Response | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const kind = (value as { error?: unknown }).error
  if (kind === 'conflict') {
    return json({
      ok: false,
      error: { code: 'TAKT_WORKFLOW_CONFLICT', message: '工作流基线已变化，自动合并失败' },
      conflict: value,
    }, 409)
  }
  if (kind === 'validation') {
    const diagnostics = (value as { diagnostics?: unknown }).diagnostics
    const detail = Array.isArray(diagnostics)
      ? diagnostics
        .flatMap((item) => typeof item === 'object' && item !== null && typeof (item as { message?: unknown }).message === 'string'
          ? [(item as { message: string }).message]
          : [])
        .slice(0, 3)
        .join('；')
      : ''
    return json({
      ok: false,
      error: {
        code: 'TAKT_WORKFLOW_VALIDATION',
        message: detail === '' ? '工作流校验失败' : `工作流校验失败：${detail}`,
      },
      validation: value,
    }, 400)
  }
  return undefined
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

/**
 * 租约冲突对外的稳定错误：api-core 的写包装器只认 `code === 'TAKT_LEASE_HELD'`，
 * 会把它改写成普通 ApiError 并丢掉错误码；这里用 ApiError 子类保住 409 语义，
 * 由 errorResponse 还原成 TAKT_LEASE_HELD。
 */
class LeaseHeldApiError extends ApiError {
  constructor(message: string) {
    super(409, message)
    this.name = 'LeaseHeldApiError'
  }
}

function makeWriteLease(service: TaktflowService): WriteLease {
  return async (stores, fn) => {
    const space = await spaceForStores(service, stores)
    try {
      await service.ownership.ensureLease(space)
    } catch (error) {
      if (error instanceof TaktToolError && error.code === 'TAKT_LEASE_HELD') throw new LeaseHeldApiError(error.message)
      throw error
    }
    return fn()
  }
}

/**
 * 空间流程目录的向后兼容探测。
 *
 * 主实现会把 WorkflowCatalog 扩展为按空间列流程（list(space)）并让 load 接受
 * 空间参数；本路由只依赖可选的 list/defaultId，不修改冻结的 types.ts。
 * 没有空间流程或旧目录实现没有 list 时回退 P0 演示流程 p0-delivery。
 */
interface SpaceWorkflowCatalog {
  /** 冻结后的真实签名允许字符串数组或 `{ id }` 数组；路由两种都兼容。 */
  list?(space?: SpaceHandle): Promise<Array<string | { id: string }>>
  defaultId?(space?: SpaceHandle): Promise<string>
}

async function defaultWorkflowId(service: TaktflowService, space: SpaceHandle): Promise<string> {
  const catalog = service.workflows as SpaceWorkflowCatalog
  // 生产目录必须给出空间默认流程；损坏/导入失败时让它上抛，不能静默换成演示流程。
  if (typeof catalog.defaultId === 'function') {
    const id = await catalog.defaultId(space)
    if (typeof id === 'string' && id.trim() !== '') return id.trim()
    throw new ApiError(500, '空间流程目录返回了空默认流程')
  }
  // 兼容没有 defaultId 的旧目录实现：只认 list 返回的第一个字符串 id。
  if (typeof catalog.list === 'function') {
    const entries = await catalog.list(space)
    const first = entries[0]
    if (typeof first === 'string' && first.trim() !== '') return first.trim()
    if (first !== undefined && typeof first === 'object' && typeof first.id === 'string' && first.id.trim() !== '') return first.id.trim()
  }
  return 'p0-delivery'
}

/**
 * 面板目录回调：每次请求都从 service.catalog 取最新实现，便于运行时组装完成后
 * 再注入。没有目录时明确 501，不返回空数组冒充真实列表。
 */
function routesCatalog(service: RoutesService): RoutesCatalog {
  return {
    async getHarnesses(stores) {
      const catalog = service.catalog
      if (catalog?.getHarnesses !== undefined) return catalog.getHarnesses(stores)
      if (catalog?.harnesses !== undefined) return catalog.harnesses
      if (catalog?.getCatalog !== undefined) return (await catalog.getCatalog(stores)).harnesses
      throw new ApiError(501, '未接入运行时 harnesses 目录')
    },
    async getModels(stores) {
      const catalog = service.catalog
      if (catalog?.getModels !== undefined) return catalog.getModels(stores)
      if (catalog?.models !== undefined) return catalog.models
      if (catalog?.getCatalog !== undefined) return (await catalog.getCatalog(stores)).models
      throw new ApiError(501, '未接入运行时 models 目录')
    },
  }
}

async function dispatchPluginWrite(
  service: TaktflowService,
  user: string,
  space: SpaceHandle,
  op: TaktPluginWriteOp,
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
        // 默认用空间配置里的第一个流程；没有空间流程（或旧目录实现）时回退演示流程。
        const workflowId = optionalText(body.workflowId, 'workflowId') ?? await defaultWorkflowId(service, space)
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

/**
 * `GET /api/taktflow.workflow-stream?space=&id=`：流程修订 SSE。
 *
 * 先通过 api-core 读一次 workflow 确认 id 合法且流程存在（400/404 还是 JSON），
 * 再订阅。数据就是 api-core 的 WorkflowChangedEvent，不伪造初始快照或重放。
 */
async function handleWorkflowStream(
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
    const space = await abortable(resolveSpace(service, url.searchParams.get('space')), signals)
    const id = url.searchParams.get('id')?.trim() ?? ''
    if (id === '') throw new ApiError(400, '缺少 id 参数')

    // 校验期间同样可能与 abort/宿主卸载竞速；失败时保持 JSON 400/404 语义。
    await abortable(core.read(space.stores, 'workflow', { id }), signals)
    return await openWorkflowStream(request, core, space, id, active, shutdown)
  } catch (error) {
    if (error instanceof StreamAborted) return new Response(null, { status: 204 })
    return errorResponse(error)
  }
}

async function openWorkflowStream(
  request: Request,
  core: ApiCore,
  space: SpaceHandle,
  id: string,
  active: Set<ActiveStream>,
  shutdown: AbortSignal,
): Promise<Response> {
  if (shutdown.aborted) return new Response(null, { status: 204 })
  const encoder = new TextEncoder()

  let closed = false
  let responseStarted = false
  let startupFailed = false
  let startupFailure: unknown
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unwatch: (() => Promise<void>) | undefined

  const closeStream = (): void => {
    try {
      streamController?.close()
    } catch {
      // 流已经关闭/取消，重复 close 不抛给调用方。
    }
  }

  const stopWatch = (): void => {
    const stop = unwatch
    unwatch = undefined
    if (stop !== undefined) void Promise.resolve(stop()).catch(() => {})
  }

  const finish = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    request.signal.removeEventListener('abort', onAbort)
    active.delete(record)
    // 取消、断开、宿主卸载、订阅报错都必须释放 workflow watch（含轮询 timer）。
    stopWatch()
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
  if (request.signal.aborted || shutdown.aborted) {
    finish()
    return new Response(null, { status: 204 })
  }

  try {
    const subscribe = core.subscribeWorkflow(
      space.stores,
      id,
      (event: WorkflowChangedEvent) => {
        if (closed) return
        try {
          streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          finish()
          closeStream()
        }
      },
      (error) => {
        if (closed) return
        if (!responseStarted) {
          // subscribeWorkflow 可能在返回 stop 函数之前同步报错；此时响应还没发出，
          // 记下错误交给上层转成 JSON 500，不能 close 后返回 204 把错误吞掉。
          startupFailed = true
          startupFailure = error
          finish()
          return
        }
        // 响应头已经发出，订阅轮询失败无法再转 JSON；结束流让 EventSource 重连。
        finish()
        closeStream()
      },
    )
    if (typeof subscribe === 'function') unwatch = subscribe
  } catch (error) {
    finish()
    throw error
  }
  // 订阅可能在返回 stop 前同步报错（onError 已 finish）；此时补一次 stopWatch，避免 listener 泄漏。
  if (closed) {
    stopWatch()
    if (startupFailed) throw startupFailure
    return new Response(null, { status: 204 })
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
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
    },
    cancel() {
      // 客户端 reader.cancel()：释放 workflow 订阅和轮询 timer。
      finish()
    },
  })

  const response = new Response(body, { headers: SSE_HEADERS })
  responseStarted = true
  return response
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
/** 会话视图用：这个会话属于哪个空间、绑定了哪个需求。 */
export interface SessionInfo {
  space?: string
  requirementId?: string
}

/**
 * `GET /api/taktflow.session?sessionId=`：会话 Tab 用来定位空间和需求。
 *
 * 会话 Agent 在线时按它的 cwd 打开空间（cwd 必须正好是空间根，否则视为不属于任何空间）；
 * 不在线时只在已打开的空间里查绑定。查不到返回空对象，不报错：普通会话也会显示这个 Tab。
 */
async function handleSession(request: Request, service: TaktflowService, ctx: HostContext): Promise<Response> {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() ?? ''
    if (sessionId === '') throw new ApiError(400, '缺少 sessionId 参数')
    const candidates: SpaceHandle[] = []
    const cwd = ctx.agents.get(sessionId)?.session.header.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      const space = await service.spaces.forSession(cwd).catch(() => undefined)
      if (space !== undefined) candidates.push(space)
    } else {
      for (const root of await service.spaces.roots()) candidates.push(await service.spaces.open(root))
    }
    for (const space of candidates) {
      const requirementId = await service.bindings.bySession(space, sessionId)
      if (requirementId !== undefined) return json({ ok: true, data: { space: space.root, requirementId } satisfies SessionInfo })
    }
    const data: SessionInfo = candidates.length === 1 ? { space: candidates[0]!.root } : {}
    return json({ ok: true, data })
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * `GET /api/taktflow.agents?space=&run=[&node=]`：一次运行（或单个节点）的子 Agent 追溯。
 *
 * 空间与现有读路由一致，只接受已注册的根；run/node 先做与写盘相同的路径校验，
 * 非法值返回 400，运行不存在返回 404。运行中的记录由追溯中心合并最新内存状态。
 */
async function handleAgents(request: Request, service: RoutesService): Promise<Response> {
  try {
    const url = new URL(request.url)
    const space = await resolveSpace(service, url.searchParams.get('space'))
    const rawRun = url.searchParams.get('run')?.trim() ?? ''
    if (rawRun === '') throw new ApiError(400, '缺少 run 参数')
    try { assertRunId(rawRun) } catch { throw new ApiError(400, 'run 参数不合法') }
    const rawNode = url.searchParams.get('node')
    let nodeId: string | undefined
    if (rawNode !== null) {
      nodeId = rawNode.trim()
      if (nodeId === '') throw new ApiError(400, 'node 参数不能为空')
      try { assertNodeId(nodeId) } catch { throw new ApiError(400, 'node 参数不合法') }
    }
    const state = await space.stores.runs.get(rawRun)
    if (state === undefined) throw new ApiError(404, '运行不存在')
    // 显式注入优先（测试替身）；生产从同一权限登记表取 RunManager 自建的追溯中心。
    const reader = service.traces ?? agentTraceHubFor(service.permissions)
    if (reader === undefined) throw new ApiError(500, '追溯服务不可用')
    const traces: AgentTrace[] = await reader.read(space, rawRun, nodeId)
    return json({ ok: true, data: traces })
  } catch (error) {
    return errorResponse(error)
  }
}

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

function isPluginWriteOp(op: TaktWriteOp): op is TaktPluginWriteOp {
  return (PLUGIN_WRITE_OPS as readonly string[]).includes(op)
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
  if (error instanceof LeaseHeldApiError) {
    return json({ ok: false, error: { code: 'TAKT_LEASE_HELD', message: error.message } }, 409)
  }
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
