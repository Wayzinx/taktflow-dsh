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
  ArtifactRef,
  AttentionItem,
  Insights,
  ProjectStores,
  RequirementId,
  RunId,
  RunState,
  WorkflowDefinition,
} from '@taktflow/core'
import type { ToolExecutionContext } from './dsh-types.js'

/**
 * 自主程度（M-J 增量）。
 *
 * - full：review 不需要人工签字；human 节点由 AI 代答，答不了/置信度不足才升级。
 * - checkpoints：保留 review 人工签字和准出，其它 human 节点 AI 代答。
 * - manual：全部按流程原样等人。
 *
 * 空间 `takt.config.json` 的 autonomy 覆盖插件配置；非法值明确失败，不静默降级。
 */
export type Autonomy = 'full' | 'checkpoints' | 'manual'

/**
 * 角色子 Agent 的执行方式（M-J 增量）。
 *
 * dsh-host：所有角色都作为 dsh 原生子 Agent（默认，使用 App 模型与“编队”能力）。
 * profile：按角色档案里的 harness 走 @taktflow/harness 的外部适配器。
 */
export type RoleHarness = 'dsh-host' | 'profile'

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
 *   配置了 spaces 时只接受这些根，其它根和互相嵌套的根抛 TAKT_SPACE_ROOT_MISMATCH。
 * - forSession(cwd)：cwd 必须正好是空间根；子目录抛 ROOT_MISMATCH，空间外抛
 *   NO_SPACE。不隐式创建空间，也不接受 core.openProject 的向上查找结果。
 * - roots()：已解析的 realpath 根列表（多空间，设计 21）：配置的根在前，然后是运行中打开过的根。
 * - assertOpenable(root)（增量，可选）：init 写盘前确认这个根将来能打开（在配置的 spaces 里、
 *   不与已打开空间嵌套），不能时抛 ROOT_MISMATCH。
 */
export interface SpaceRegistry {
  open(root: string): Promise<SpaceHandle>
  forSession(cwd: string | undefined): Promise<SpaceHandle>
  roots(): Promise<string[]>
  assertOpenable?(root: string): Promise<void>
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
export interface RunInterruption {
  at: string
  reason: 'host_exit' | 'host_crash' | 'lead_offline'
}

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
  /**
   * 运行被打断但没有终止（宿主退出 / 崩溃 / Lead 会话离线）：磁盘状态仍是 running，
   * 已完成节点保留。Lead 会话重新打开时自动从断点继续，也可 takt_run resume / cancel。
   */
  interrupted?: RunInterruption
  /**
   * M-J 增量：运行时冻结的自主程度。
   *
   * 开始时从空间配置/插件配置解析一次并落盘；resume 不再读取新配置，避免运行
   * 中途从 manual 切到 full 后改变审批语义。历史运行没有该字段时必须按 manual
   * 保守恢复（或拒绝冷恢复），绝不能拿新宿主的 full 默认改写旧人工审批语义。
   */
  autonomy?: Autonomy
  /** M-J 增量：运行时冻结的角色 harness 模式；身份校验会拒绝中途切换。 */
  roleHarness?: RoleHarness
  /**
   * M-J 增量：已经尝试过自主代答的 requestId。
   *
   * 在调用模型前落盘；宿主重启后据此把中断的待办交给人，不重复尝试。
   */
  autonomyAttempts?: string[]
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
  /** 运行被打断但未终止；旧实现 / 测试替身可省略（省略时按旧语义取消）。 */
  markInterrupted?(space: SpaceHandle, runId: RunId, reason: RunInterruption['reason']): Promise<void>
}

/** RunManager.start 的输入；requestKey 由 Lead 工具生成，用于同会话重复提交去重。 */
export interface StartRunInput {
  space: SpaceHandle
  requirementId: RequirementId
  workflowId: string
  args?: Record<string, unknown>
  ownerSessionId: string
  requestKey: string
  /** 写进运行日志的启动说明（例如为什么不用默认流程）。 */
  note?: string
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
  /**
   * 增量（可选）：宿主通道在运行期间写当前需求公共产物时，在本空间在册运行的写入守卫上开系统窗口，
   * 避免把这些已审计的写入算成正在执行节点的越界。paths 相对空间根。
   */
  withHostWrites?<T>(space: SpaceHandle, paths: string[], fn: () => Promise<T>): Promise<T>
  /**
   * 增量（可选）：从断点继续被打断的运行（宿主退出 / 崩溃 / Lead 会话离线；磁盘仍是 running、
   * 本进程没在跑）。Lead 会话必须在线；已完成节点保留，被打断的那次尝试重跑。
   */
  resumeInterrupted?(space: SpaceHandle, runId: RunId, by: Actor): Promise<void>
  /** 增量（可选）：Lead 会话上线时调用，继续它名下被打断的运行；返回已继续的 runId。 */
  resumeForSession?(sessionId: string, cwd: string | undefined): Promise<RunId[]>
}

/** 一个子 Agent 的权限范围；执行器在启动子 Agent 前登记。 */
export interface PermissionScope {
  /** dsh 子 Agent 的 childId。 */
  childId: string
  nodeRef: { runId: RunId; nodeId: string; attempt: number }
  cwd: string
  /**
   * glob，相对空间根；空数组表示不可写。
   * 提供 spaceRoot 后按两域计算：代码写入相对 cwd，公共产物相对空间根且仅限
   * 当前需求；缺省保持旧版“相对空间根”语义。
   */
  writeScope: string[]
  allowBash: boolean
  readOnly: boolean
  /**
   * 空间根 realpath（可选）。有值时 cwd 可以是空间内 worktree；代码 writeScope
   * 只按 cwd 相对路径匹配，不能再同时按空间根授权。
   */
  spaceRoot?: string
  /**
   * 当前需求公共产物根 realpath（可选，空间根内）。布局由 stores.paths 的实际目录
   * 决定（如 `.takt/workspaces/<需求ID>` 或 `requirements/<需求ID>`）；只有该目录
   * 能按空间根相对 writeScope 写入，其父目录下的兄弟需求一律拒绝。
   */
  artifactRoot?: string
  /**
   * 读取范围 glob（可选）。数组项按 cwd 相对或空间根相对匹配；缺省不额外限制，
   * 空数组拒绝所有 read/read_image/glob/grep/list；绝对模式在登记时拒绝。
   */
  readScope?: string[]
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
  /** 本次 preset 实际注册成功的角色 skill 名；旧实现可省略。 */
  skills?: string[]
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
    variant: {
      readOnly: boolean
      allowBash: boolean
      /**
       * M-K 增量（可选）：本次节点实际生效的写入范围。
       *
       * 执行器传入 req.tools.writeScope 或角色档案范围；preset 用它决定是否挂载
       * `takt_selftest`。缺省时仍回退角色档案 writeScope，旧调用方不受影响。
       */
      writeScope?: string[]
    },
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
 * AI 自主代答的输入（M-J 增量）。
 *
 * 只允许普通 human 节点的 answer/approve；escalate 只写审计、不落回答。
 * `by` 必须是 dsh-host 子 Agent，且 `onBehalfOf` 等于需求绑定的真实人；
 * `evidence` 是 AI 实际依据的产物版本，落账前会再次核对未变化。
 */
export interface AgentDecisionInput {
  requestId: string
  attempt: number
  artifactVersion?: number
  /** answer/approve 会落账并推进；escalate 只写审计产物。AI 没有 reject 语义。 */
  disposition: 'answer' | 'approve' | 'escalate'
  answer?: string
  by: Extract<Actor, { type: 'agent' }>
  /** 0..1；由运行层按阈值决定是否升级，审批层只校验范围。 */
  confidence: number
  evidence: ArtifactRef[]
  /** 运行层在调用模型前冻结的全部产物引用；缺省时只校验 evidence。 */
  basis?: ArtifactRef[]
  /** 上述冻结清单的摘要；提供 basis 时必须一致。 */
  basisDigest?: string
  /** 取消谓词：stop/卸载/租约丢失后不能再落回答或新增升级产物。 */
  signal?: AbortSignal
  blockers: string[]
  unresolved: string[]
  rationale: string
}

/** AI 自主代答的结果；人抢先回答时 answered=false 且不写新版本。 */
export interface AgentDecisionResult {
  disposition: AgentDecisionInput['disposition']
  /** 当前待办（可能已由人回答）。 */
  item?: AttentionItem
  /** 本次写入的审计产物；人抢先回答或待办已答时可能没有。 */
  artifact?: ArtifactRef & { version: number }
  /** true 表示本次真的写入了回答并推进。 */
  answered: boolean
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
  /**
   * M-J 增量（可选）：AI 自主代答入口。
   *
   * 与 answer 共用同一把审批守卫锁和 freshness/attempt/lease 校验，但只落账，
   * 不调用 runs.onAnswered（否则会等待当前运行任务而自锁）。调用方落账后
   * 直接 `engine.resume`。
   */
  answerAsAgent?(space: SpaceHandle, input: AgentDecisionInput): Promise<AgentDecisionResult>
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
  /**
   * M-J 增量（可选）：AI 自主代答升级后主动唤醒 Lead。
   *
   * 普通 human.requested 在 AI 处理期间会被抑制；只有升级才通过这里补一条
   * 带唤醒的短句，提醒 Lead 调用 takt_ask_human。实现缺失时调用方只记日志。
   */
  notifyEscalation?(space: SpaceHandle, notice: {
    requirementId: RequirementId
    runId: RunId
    requestId: string
    line: string
  }): Promise<void>
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
  /**
   * 按 id 加载流程。
   *
   * M-J 增量（向后兼容）：可选传入 space，把查找限制在该空间，避免多个空间
   * 出现同名流程时 start 拿错定义；不传时保持旧行为（跨已注册空间查找）。
   */
  load(workflowId: string, space?: SpaceHandle): Promise<WorkflowDefinition>
  /**
   * M-J 增量（可选，向后兼容）：异步列出空间配置里的全部流程。
   *
   * 为什么需要：`ids()` 是同步的，而空间流程要读配置并动态 import 后才能知道
   * 真实 id；`takt_status` 与面板应使用 `list()`。旧实现不提供时调用方回退
   * `ids()`。
   */
  list?(space?: SpaceHandle): Promise<string[]>
  /** M-J 增量（可选）：空间配置里的第一个流程；无空间时回退演示流程。 */
  defaultId?(space?: SpaceHandle): Promise<string>
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
  /**
   * M-K 增量（可选）：评测、缺陷归因与成绩单服务。
   *
   * 旧测试替身/纯程序化组装可以不带；缺失时面板 eval.run/defect.attribute 保持
   * 501，Lead 的 M3 动作明确失败，不会退化成假成功。
   */
  m3?: import('./m3.js').M3Service
  /**
   * M-K 增量（可选）：受控自测服务。
   *
   * 旧测试替身/纯程序化组装可以不带；角色工具仍会按 preset 条件注册，但执行时
   * 明确拒绝，不会退化成任意 shell。服务由宿主 createService 创建并随卸载释放。
   */
  selftests?: import('./selftest.js').SelftestService
}

/**
 * 一次职责 Agent 执行（节点的一次尝试）的追溯记录（阶段 3 增量）。
 *
 * dsh-host 适配器在启动时写入、结束时补全，存放在 `.takt/runs/<runId>/agents/`：
 * 首次执行写 `<nodeId>#<attempt>.json`，同一 node/attempt 的后续执行（review 节点的
 * 多位评审者/作者）写 `<nodeId>#<attempt>~<编码 sessionId>.json`。因此同一 nodeId+attempt
 * 可能有多条记录，前端渲染/详情选择应以 sessionId 区分。运行中的记录由路由合并活动状态返回。
 * 文本字段都已脱敏并截断，不含密钥。
 */
export interface AgentTrace {
  runId: string
  nodeId: string
  attempt: number
  /** startActivation 的 label，例如 `REQ-1/design#1`。 */
  label: string
  role: string
  /**
   * 本次执行对应的节点配方（node.recipe 事件）标识。
   * 旧记录没有该字段；有值时可在评测/归因面板里按配方回看当时的 prompt、模型与技能。
   */
  recipeKey?: string
  /** node.recipe 事件的 seq；用于在同一 nodeId 的多次尝试间精确定位配方。 */
  recipeEventSeq?: number
  /** dsh 子会话 id（= 预留的 childId），可在 dsh 的“编队”和会话列表里打开。 */
  sessionId: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
  durationMs?: number
  /** 动态注册的角色 preset：id、配置哈希、组合里的插件包名、实际注册的 skill。 */
  preset: { id: string; cfgHash: string; plugins: string[]; skills?: string[] }
  /**
   * 角色档案摘要（来源：空间 .takt/agents 或随包默认）。
   * skills 是本次实际注册成功的 skill；declaredSkills 是档案声明的名字。
   */
  profile: { title: string; description: string; skills: string[]; declaredSkills?: string[]; writeScope: string[]; readOnly: boolean; source: 'space' | 'bundled' }
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
