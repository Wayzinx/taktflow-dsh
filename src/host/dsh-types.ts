/**
 * dsh 宿主 API 的本地结构类型。
 *
 * 本包不安装 `@deepseek-ai/*`：这里只摘抄实际用到的字段，运行时值只允许从
 * `dsh-runtime.ts` 取。来源注释指向 dsh 0.2.2-rc.1 的已发布包（npm）或桌面版随附的包源码。类型只约束本插件消费的字段，不追求与
 * 官方声明逐字段相同；升级 dsh 时按注释里的来源对账。
 */

/** 来源：@deepseek-ai/cordis（桌面版随附）/src/fiber.ts:70-86（Disposable/Effect）。 */
export type Disposer = () => void | Promise<void>

/** 来源：@deepseek-ai/cordis（桌面版随附）/src/fiber.ts:184-196（dispose(): Promise<void>）。 */
export interface Fiber {
  dispose(): Promise<void>
}

/** 来源：@deepseek-ai/cordis（桌面版随附）/src/fiber.ts:405-418（同步/异步/迭代清理）。 */
export type EffectBody = Disposer | Promise<Disposer> | Iterable<Disposer> | AsyncIterable<Disposer>

/** 来源：@deepseek-ai/cordis（桌面版随附）/src/registry.ts:164-176。 */
export type InjectCallback = (ctx: HostContext) => void

/** 来源：@deepseek-ai/dsh-llm（桌面版随附）/lib/typert.host.js:316-321（ContentBlockMap）。 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

export interface ImageBlock {
  readonly type: 'image'
  readonly attachment: unknown
  readonly offloaded?: true
}

export interface FileBlock {
  readonly type: 'file'
  readonly attachment: unknown
}

export interface ToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface ToolAdditionBlock {
  readonly type: 'tool-addition'
  readonly toolName: string
  readonly tool?: never
}

export interface ToolRemovalBlock {
  readonly type: 'tool-removal'
  readonly toolName: string
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | FileBlock
  | ToolCallBlock
  | ToolAdditionBlock
  | ToolRemovalBlock

/** 来源：@deepseek-ai/dsh-api-session-controller（桌面版随附）/lib/typert.host.js:2530-2534。 */
export interface MessageBase {
  readonly id: string
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

/**
 * 来源：同上 :2562-2567（MessageSourceMap）。
 * 这里只保留所有官方 source 都有的 kind；具体联合成员不展开。
 */
export interface MessageSource {
  readonly kind: string
}

/** 来源：同上 :3190-3193（UserMessage extends MessageBase）。 */
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}

/** 来源：@deepseek-ai/dsh-agent@0.2.2-rc.1/lib/types/types.d.ts:11-14。 */
export interface Agent {
  /** Session-backed Agent identity。 */
  readonly id: string
  /** 来源：@deepseek-ai/dsh-agent@0.2.2-rc.1/lib/types/runtime-types.d.ts:139-145；官方为必填。 */
  readonly options: AgentOptions
  /** 来源：同上 :141；官方为必填，这里只约束 id/header。 */
  readonly session: Session
  /**
   * Agent 所在的 Cordis 上下文。来源：同上 :149；官方为必填，这里可选以兼容旧替身。
   * 用来查询当前挂载的 preset（agentPresets.composedPreset），见 lead/tools.ts。
   */
  readonly ctx?: { get(name: string): unknown }
  /** 来源：同上 :202-231；官方为必填。 */
  followup(message: UserMessage): void
  inject(message: UserMessage): void
  /** 来源：同上；进入下一步的输入并唤醒。旧替身可省略。 */
  steer?(message: UserMessage): void
}

/**
 * agent/turn-stopping：本轮本该结束（没有工具调用、没有待处理的下一步输入）时串行派发；
 * 监听者 steer 一条消息就能让同一轮继续。来源：@deepseek-ai/dsh-agent-loop/lib/index.js（serial 派发）。
 */
export interface AgentTurnStoppingEvent {
  readonly agent: Agent
  readonly turn: number
  readonly signal: AbortSignal
}

/** 来源：@deepseek-ai/dsh-agent@0.2.2-rc.1/lib/types/runtime-types.d.ts:22-34。 */
export interface AgentOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/**
 * 来源：@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/types.d.ts:59-95。
 * 只约束消费字段；官方还要求 version/createdAt/isSeeded 等。
 */
export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/**
 * 会话事件流里的单条事件。
 * 来源：@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/types.d.ts:256-405（SessionEvent）。
 * data 的具体形状随 type 变化，消费方必须按事件类型自行收窄。
 */
export interface SessionEvent {
  readonly type: string
  readonly seq: number
  /** Unix 毫秒。 */
  readonly time: number
  readonly data: unknown
}

/**
 * 来源：@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/index.d.ts:295-312（requestHeader/requestContext）。
 * 这里只约束 Agent.session 上实际读取的字段。
 */
export interface Session {
  /** 官方 Session 实例 id；旧替身可能只填 header，因此调用方需兼容 header.id。 */
  readonly id?: string
  readonly header: SessionHeader
}

/**
 * 来源：@deepseek-ai/dsh-llm@0.2.2-rc.1/lib/types/index.d.ts（TokenUsage）。
 * assistant/message 事件里的用量；缺字段表示该次响应没有报告。
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** 来源：@deepseek-ai/dsh-subagent@0.2.2-rc.1/lib/types/types.d.ts:127-144。 */
export interface SubagentStartRequest {
  readonly cwd?: string
  readonly agentPreset?: string
  readonly label?: string
  /** 官方为 ContentBlock[]，不是 string。 */
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: Record<string, unknown>
  readonly maxDepth?: number
}

/** 来源：@deepseek-ai/dsh-subagent@0.2.2-rc.1/lib/types/types.d.ts:25-38。 */
export interface SubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly childId?: string
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** 来源：@deepseek-ai/dsh-subagent@0.2.2-rc.1/lib/types/types.d.ts:40-56。 */
export interface SubagentActivation {
  readonly childId: string
  readonly messageId?: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** 来源：@deepseek-ai/dsh-subagent@0.2.2-rc.1/lib/types/types.d.ts:237-258。 */
export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

/**
 * 来源：@deepseek-ai/dsh-agent@0.2.1-rc.3/lib/types/runtime-types.d.ts:402-407；
 * 桌面随附 dsh-agent-loop 的 agent/error 与官方 API 目录保持同形。
 * 失败可能发生在 turn 建立前，因此不能只读会话 turn/end。
 */
export interface AgentErrorEvent {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly error: unknown
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:216-241。 */
export interface ToolExecutionInput {
  readonly callId: string
  readonly rootCallId?: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
  /** 官方必填：调用方拥有的取消信号。 */
  readonly signal: AbortSignal
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:282-286。 */
export interface ToolExecution extends ToolExecutionInput {
  readonly rootCallId: string
  readonly token: symbol
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:305-321。 */
export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void
  concludeTurn(): void
}

/** 本包对官方 ToolRunContext 的别名；审批与守卫只需要这套字段。 */
export type ToolExecutionContext = ToolRunContext

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:522（同步守卫）。 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

/** 来源：@deepseek-ai/dsh-api-session-controller（桌面版随附）/lib/typert.host.js:3170-3176。 */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly deferLoading?: true
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:106-113。 */
export interface ToolOutputDefinition {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: JsonValue): ContentBlock[]
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/index.d.ts:115-175。 */
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/schema.d.ts:1-72。 */
export interface ValueSchemaAnnotations {
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}

export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
export type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/schema.d.ts:178-210。 */
export interface DefineToolOptions {
  readonly name: string
  readonly description: string
  readonly parameters: ParameterSchemaSpec
  readonly output: {
    readonly schema: ValueSchemaSpec
    render(args: unknown, value: JsonValue): ContentBlock[]
  }
  readonly deferLoading?: true
  readonly timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/types/schema.d.ts:248。 */
export type DefineTool = (options: DefineToolOptions) => ToolDefinition

/** 来源：@deepseek-ai/dsh-agent-preset-registry（桌面版随附）/lib/typert.host.js:660-661。 */
export interface AgentPresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly unknown[]
}

/** 来源：@deepseek-ai/dsh-agent-preset-registry/lib/index.js:570-610，声明及挂载诊断。 */
export interface AgentPresetSummary {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
}

/** 来源：@deepseek-ai/dsh-system-prompt@0.2.2-rc.1/lib/types/index.d.ts:47-67。 */
export interface SystemPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
}

/** 来源：@deepseek-ai/dsh-skill@0.2.2-rc.1/lib/types/index.d.ts:20,37-44,78-84。 */
export type SkillSource =
  | 'project-dsh'
  | 'project-agents'
  | 'runtime'
  | 'user-dsh'
  | 'user-agents'
  | 'custom'
  | 'bundled'
  | (string & {})

/** 提供 invocation 时两个布尔值都必填。 */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** 来源：同上 :78-84（SkillRegistration）；source 必填。 */
export interface SkillRegistration {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly source: SkillSource
  readonly invocation?: SkillInvocationPolicy
  readonly provider?: string
}

/** 来源：@deepseek-ai/dsh-client-connection@0.2.2-rc.1/lib/types/rpc.d.ts:119-132。 */
export interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/index.js:26-31（optionSchema）。 */
export interface UserQuestionOption {
  readonly label: string
  readonly description?: string
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/typert.host.js:276。 */
export interface UserQuestionIntent {
  readonly kind: 'plan-review'
  readonly approve: string
  readonly callId?: string
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/index.js:33-46（questionSchema）。 */
export interface UserQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly UserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: UserQuestionIntent
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/index.js:58-66（answerSchema）。 */
export interface UserAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/index.js:76（answers 必填数组）。 */
export interface UserQuestionsResult {
  readonly answers: readonly UserAnswer[]
}

/** 来源：@deepseek-ai/dsh-user-questions（桌面版随附）/lib/index.js:668-684。 */
export interface UserQuestionsRequest {
  readonly questions: readonly UserQuestion[]
  /** 传入时必须是与 agents.get(id) 相同的活根 Agent（index.js:531-534）。 */
  readonly agent?: Agent
  readonly signal?: AbortSignal
}

/** 来源：@deepseek-ai/dsh-agent-preset-registry（桌面版随附）/lib/index.js:466-494。 */
export type AgentPresetDisposer = () => Promise<void>

/** 本包用到的 cordis/dsh 服务面；来源见各字段注释。 */
export interface HostContext {
  /** 来源：@deepseek-ai/cordis 的 Context 内置 logger；不是 inject 服务。 */
  readonly logger?: { warn(message: string): void }
  /** 来源：@deepseek-ai/cordis（桌面版随附）/src/registry.ts:164-176。 */
  inject(deps: string[], callback: InjectCallback): Fiber & PromiseLike<Fiber>
  /** 来源：@deepseek-ai/cordis（桌面版随附）/src/fiber.ts:405-418。 */
  effect(execute: () => EffectBody, label?: string): Disposer
  /** 来源：@deepseek-ai/cordis（桌面版随附）/src/events.ts:288。 */
  on(event: string, listener: (...args: never[]) => void): Disposer
  /** 来源：@deepseek-ai/cordis（桌面版随附）/src/reflect.ts:233。 */
  get<T = unknown>(name: string): T | undefined
  /** 来源：@deepseek-ai/cordis（桌面版随附）/src/reflect.ts:277-304。 */
  provide(name: string, value: unknown): Disposer
  connection: {
    fetch: {
      register(route: ConnectionFetchRoute): Disposer
    }
  }
  tools: {
    register(definition: ToolDefinition): Disposer
    guard(guard: ToolGuard): Disposer
    /**
     * 来源：@deepseek-ai/dsh-tools@0.2.2-rc.1/lib/index.js:2991-3006。只能在 agent 作用域调用；
     * 屏蔽这个 Agent 继承的全局工具，名字必须是已注册的全局工具。旧测试替身可省略。
     */
    restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): Disposer
  }
  subagents: {
    startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
  }
  agents: {
    get(id: string): Agent | undefined
    roots(): Agent[]
  }
  agentPresets: {
    register(definition: AgentPresetDefinition): Promise<AgentPresetDisposer>
    /** 来源：@deepseek-ai/dsh-agent-preset-registry/lib/index.js:570；旧测试替身可省略。 */
    list?(): Promise<AgentPresetSummary[]>
    /** 来源：同上 :596；不存在时拒绝，挂载失败则返回 broken。 */
    resolve?(id: string): Promise<AgentPresetSummary>
  }
  userQuestions: {
    ask(request: UserQuestionsRequest): Promise<UserQuestionsResult>
  }
  systemPrompt: {
    section(section: SystemPromptSection): Disposer
  }
  skills: {
    register(skill: SkillRegistration): Disposer
  }
}
