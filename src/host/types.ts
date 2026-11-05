/**
 * Taktflow dsh 宿主的冻结内部接口。
 *
 * M-C（执行）、M-D（Lead 工具）、M-F（客户端/面板）按这些接口并行实现；改动
 * 字段前先在本文件里加注释说明兼容性，并在交付说明里列出最终版本。
 *
 * 约定：
 * - 涉及空间的方法都收 SpaceHandle，调用方先用 SpaceRegistry 解析。
 * - 失败统一抛 TaktToolError：code 稳定，message 给人看，hint 给下一步建议。
 */
import type {
  Actor,
  AttentionItem,
  Insights,
  ProjectStores,
  RequirementId,
  RunId,
  RunState,
  WorkflowDefinition,
} from '@taktflow/core'
import type { ToolExecutionContext } from './dsh-types.js'

/** 技术方案 5.8 的稳定错误码；新增码要同步工具文档和客户端文案。 */
export type TaktErrorCode =
  | 'TAKT_NO_SPACE'
  | 'TAKT_SPACE_ROOT_MISMATCH'
  | 'TAKT_NOT_BOUND'
  | 'TAKT_LEASE_HELD'
  | 'TAKT_RUN_BUSY'
  | 'TAKT_STALE_VERSION'
  | 'TAKT_FORBIDDEN_FOR_LEAD'
  | 'TAKT_UNSUPPORTED_NODE'

/** 工具层可捕获的结构化错误；message 直接给模型/用户看。 */
export class TaktToolError extends Error {
  readonly code: TaktErrorCode
  readonly hint?: string

  constructor(code: TaktErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'TaktToolError'
    this.code = code
    this.hint = hint
  }
}

/** 一个已打开的空间；root 已 realpath，stores.projectDir 与 root 相同。 */
export interface SpaceHandle {
  readonly root: string
  readonly stores: ProjectStores
  readonly insights: Insights
}

/**
 * 空间注册表。
 *
 * P0 只支持一个空间根：配置里多个不同根、或先后打开两个不同根都拒绝；同根
 * symlink 在 realpath 后去重。open 串行化，失败不绑定根，可重试。
 *
 * - open(root)：root 目录必须直接包含 takt.config.json，否则 TAKT_NO_SPACE；
 *   配置了 spaces 时只接受该根，第二个不同根抛 TAKT_SPACE_ROOT_MISMATCH。
 * - forSession(cwd)：cwd 必须正好是空间根；子目录抛 ROOT_MISMATCH，空间外抛
 *   NO_SPACE。不隐式创建空间，也不接受 core.openProject 的向上查找结果。
 * - roots()：已解析的 realpath 根列表，P0 最多一个；未配置且尚未 open 时为 []。
 */
export interface SpaceRegistry {
  open(root: string): Promise<SpaceHandle>
  forSession(cwd: string | undefined): Promise<SpaceHandle>
  roots(): Promise<string[]>
}

/**
 * 非正常终止原因。成功/失败/人取消是运行状态本身，不写在这里；这两个值只
 * 表示离线或宿主丢失导致的终止。
 */
export interface EndReason {
  reason: 'lead_offline' | 'host_lost'
  /** ISO 时间戳。 */
  at: string
}

/** 运行所有权元数据，落在空间的租约/运行元数据里（执行层实现）。 */
export interface RunOwnerMeta {
  /** 宿主实例标识，格式 dsh:<hostId>；与审计用的人（Config.user）无关。 */
  owner: string
  ownerSessionId: string
  /** 同一会话重复提交时用于去重的幂等键。 */
  requestKey?: string
  createdAt: string
  /** 运行使用的 preset 及其配置哈希，用于审计“当时用了什么组合”。 */
  presets?: Record<string, { id: string; cfgHash: string }>
  /** 有值表示该运行因离线/宿主丢失终止，不能再 resume。 */
  endReason?: EndReason
}

/**
 * 运行所有权与租约。
 *
 * start 前 ensureLease；进程退出/会话结束时 release；检测到旧宿主时 takeover。
 * 租约被其他活宿主持有时抛 TAKT_LEASE_HELD；终态运行不允许改回。
 */
export interface Ownership {
  readonly hostOwner: string
  ensureLease(space: SpaceHandle): Promise<void>
  release(space: SpaceHandle): Promise<void>
  takeover(space: SpaceHandle, by: Actor): Promise<void>
  recordRun(space: SpaceHandle, runId: RunId, meta: RunOwnerMeta): Promise<void>
  readRun(space: SpaceHandle, runId: RunId): Promise<RunOwnerMeta | undefined>
  /** 重复写入同一原因幂等；不同原因抛 TAKT_RUN_BUSY。 */
  setEndReason(space: SpaceHandle, runId: RunId, endReason: EndReason): Promise<void>
}

/** RunManager.start 的输入；requestKey 由 Lead 工具生成，用于同会话重复提交去重。 */
export interface StartRunInput {
  space: SpaceHandle
  requirementId: RequirementId
  workflowId: string
  args?: Record<string, unknown>
  ownerSessionId: string
  requestKey: string
}

/**
 * 运行生命周期管理。
 *
 * 同一 requestKey 已存在返回 deduped=true；运行中重复 start 抛 TAKT_RUN_BUSY；
 * 终态运行 cancel/resume 抛 TAKT_RUN_BUSY。disposeAll 可重复调用，第二次 no-op。
 */
export interface RunManager {
  start(input: StartRunInput): Promise<{ runId: RunId; deduped: boolean }>
  cancel(space: SpaceHandle, runId: RunId, by: Actor): Promise<void>
  resume(space: SpaceHandle, runId: RunId, by: Actor): Promise<void>
  get(space: SpaceHandle, runId: RunId): Promise<RunState | undefined>
  onAnswered(space: SpaceHandle, item: AttentionItem): Promise<void>
  disposeAll(): Promise<void>
}

/** 一个子 Agent 的权限范围；执行器在启动子 Agent 前登记。 */
export interface PermissionScope {
  /** dsh 子 Agent 的 childId。 */
  childId: string
  nodeRef: { runId: RunId; nodeId: string; attempt: number }
  cwd: string
  /** glob，相对空间根；空数组表示不可写。 */
  writeScope: string[]
  allowBash: boolean
  readOnly: boolean
}

/**
 * 子 Agent 权限登记表。
 *
 * startActivation 前 register；activation.dispose 后调用返回的 release。
 * lookup 未登记返回 undefined：守卫对未登记 Agent 放行，普通会话不受本插件
 * 影响；只有登记过的子 Agent 才按 scope 校验。
 */
export interface PermissionRegistry {
  register(scope: PermissionScope): () => void
  lookup(agentId: string): PermissionScope | undefined
}

/** 角色 preset 的租用句柄；release 由 RunManager 在运行结束时调用。 */
export interface RolePresetHandle {
  id: string
  cfgHash: string
  release(): void
}

/**
 * 角色 preset 注册表。
 *
 * 执行层在执行节点前 acquire，Lead 层派发子 Agent 时使用返回的 id；相同 variant
 * 可复用。角色不在白名单、variant 越权时抛 TAKT_FORBIDDEN_FOR_LEAD。
 */
export interface RolePresets {
  acquire(
    space: SpaceHandle,
    role: string,
    variant: { readOnly: boolean; allowBash: boolean },
  ): Promise<RolePresetHandle>
}

/**
 * 需求 ↔ 会话绑定。
 *
 * 需求群聊建立时 bind；会话结束不自动解绑（审计需要）。未绑定时查询返回
 * undefined，不抛错。
 */
export interface Bindings {
  bind(space: SpaceHandle, requirementId: RequirementId, sessionId: string, by: Actor): Promise<void>
  byRequirement(space: SpaceHandle, requirementId: RequirementId): Promise<string | undefined>
  bySession(space: SpaceHandle, sessionId: string): Promise<RequirementId | undefined>
}

/** 审批回答输入；artifactVersion 用于拒绝过期版本的批准。 */
export interface AnswerInput {
  requestId: string
  attempt: number
  artifactVersion?: number
  decision?: string
  answer?: string
  by: Actor
}

/**
 * 待人事项的呈现与回答。
 *
 * present 用 exec.agent + exec.signal 调 ctx.userQuestions.ask（根 Agent 身份
 * 由 userQuestions 校验）；answer 落库并唤醒运行。requestId 不存在抛
 * TAKT_NOT_BOUND；attempt/artifactVersion 过期抛 TAKT_STALE_VERSION；已回答时
 * 幂等返回已有 AttentionItem，不抛错。
 */
export interface Approvals {
  present(exec: ToolExecutionContext, space: SpaceHandle, requestId: string): Promise<void>
  answer(space: SpaceHandle, input: AnswerInput): Promise<AttentionItem>
}

/**
 * 需求群聊/运行事件的通知桥。
 *
 * 空间打开后 attach，宿主卸载时 detach；重复 attach 幂等，detach 未 attach 的
 * 空间是 no-op。
 */
export interface Notifier {
  attach(space: SpaceHandle): Promise<void>
  detach(space: SpaceHandle): Promise<void>
}

/**
 * 随包流程目录（阶段 2 增量）。
 *
 * Lead 层（src/workflows）实现，执行层的 RunManager 在 start/resume 时按 id 加载。
 * P0 只有随包流程，不加载用户的 .workflow.ts。未知 id 抛 TAKT_UNSUPPORTED_NODE；
 * 流程里出现 P0 不支持的节点（review、声明 allowBash 的 dsh-host 节点等）同样
 * 抛 TAKT_UNSUPPORTED_NODE，由 load 负责校验。
 */
export interface WorkflowCatalog {
  ids(): string[]
  load(workflowId: string): Promise<WorkflowDefinition>
}

/** 宿主行提供给所有 dsh 行/工具的服务门面。 */
export interface TaktflowService {
  spaces: SpaceRegistry
  ownership: Ownership
  runs: RunManager
  permissions: PermissionRegistry
  presets: RolePresets
  bindings: Bindings
  approvals: Approvals
  notifier: Notifier
  workflows: WorkflowCatalog
}

/**
 * 一次职责 Agent 执行（节点的一次尝试）的追溯记录（阶段 3 增量）。
 *
 * dsh-host 适配器在启动时写入、结束时补全，存放在 `.takt/runs/<runId>/agents/<nodeId>#<attempt>.json`；
 * 运行中的记录由路由合并活动状态返回。面板的节点抽屉和“子 Agent”页按它渲染。
 * 文本字段都已脱敏并截断，不含密钥。
 */
export interface AgentTrace {
  runId: string
  nodeId: string
  attempt: number
  /** startActivation 的 label，例如 `REQ-1/design#1`。 */
  label: string
  role: string
  /** dsh 子会话 id（= 预留的 childId），可在 dsh 的“编队”和会话列表里打开。 */
  sessionId: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  durationMs?: number
  /** 动态注册的角色 preset：id、配置哈希、组合里的插件包名。 */
  preset: { id: string; cfgHash: string; plugins: string[] }
  /** 角色档案摘要（来源：空间 .takt/agents 或随包默认）。 */
  profile: { title: string; description: string; skills: string[]; writeScope: string[]; readOnly: boolean; source: 'space' | 'bundled' }
  /** 发给子 Agent 的完整 prompt（脱敏）。 */
  prompt: string
  systemAppend?: string
  outputSchema?: Record<string, unknown>
  model?: string
  effort?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  /** 子会话里的工具调用（按时间顺序，最多保留最近 200 条）。 */
  tools: Array<{ name: string; summary: string; ok?: boolean; at: string; durationMs?: number }>
  /** 被写权限守卫拒绝的操作。 */
  denials: Array<{ tool: string; path?: string; reason: string; at: string }>
  stopReason?: string
  /** 最终回复（截断）。 */
  finalText?: string
  error?: string
}
