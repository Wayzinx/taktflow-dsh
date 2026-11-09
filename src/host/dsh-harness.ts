import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { extractJsonBlock, type AgentProfile, type HarnessAdapter, type HarnessEvent, type HarnessRequest, type HarnessResult, type WorkflowDefinition } from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import type { AgentTraceHandle, AgentTraceHub, AgentTraceOutcome } from './agent-trace.js'
import type { AgentTurnStoppingEvent, HostContext, SessionEvent, SubagentActivation, ToolExecution, UserMessage } from './dsh-types.js'
import type { RoleSkillSnapshots } from './role-skills.js'
import { canUseSelftest } from './selftest-capability.js'
import type { SelftestRegistration, SelftestService } from './selftest.js'
import { supportsDshOutputSchema } from './dsh-schema.js'
import { TaktToolError, type Ownership, type PermissionRegistry, type RolePresetHandle, type RolePresets, type SpaceHandle } from './types.js'
import { dshModelOption } from './lead-ask.js'

export interface DshHarnessDeps {
  ctx: HostContext
  space: SpaceHandle
  ownership?: Ownership
  presets: RolePresets
  permissions: PermissionRegistry
  ownerSessionId: string
  profiles?: Record<string, AgentProfile>
  /** 运行开始时冻结的角色来源；有 traces 时必填，禁止从角色名猜测。 */
  profileSources?: Record<string, 'space' | 'bundled'>
  /** 运行开始时冻结的角色技能；提供时校验 preset 实际注册的 skills 与之一致。 */
  roleSkills?: RoleSkillSnapshots
  /** 追溯中心；缺失时保持原执行语义，不写追溯文件。 */
  traces?: AgentTraceHub
  /** M-K：受控自测服务；缺失时角色工具仍可注册，但执行会明确拒绝。 */
  selftests?: SelftestService
  /** 受控自测命令的系统写入窗口；由 RunManager 绑定到同一引擎的 WriteGuard。 */
  withSystemWrites?: <T>(paths: string[], fn: () => Promise<T>) => Promise<T>
  /** 运行开始时冻结的流程定义；用于判断节点 strictOutputs 的证据路径。 */
  workflow?: WorkflowDefinition
  /** RunManager 取消整条运行；回调不可等待当前 harness 所属任务。 */
  onLeadOffline(nodeRef: { runId: string; nodeId: string; attempt: number }): Promise<void>
  /** 启动子 Agent 前把选用的 preset 写进 owner 审计。 */
  onPreset?(role: string, handle: { id: string; cfgHash: string }, nodeRef: { runId: string; nodeId: string; attempt: number }): Promise<void>
  /** 只用于调整满额排队轮询间隔；不限制重试次数。 */
  queueIntervalMs?: number
}

/** RunManager 取消后等待清理；引擎把节点异常转为 failed 也不能丢失清理错误。 */
export interface DshHarness extends HarnessAdapter {
  drain(): Promise<void>
}

/** 取消信号拥有定时器；满额时无限期排队，取消立即移除等待。 */
function waitForCapacity(signal: AbortSignal, milliseconds: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** preset 组合里的插件包名；旧替身没有扩展字段时留空，不编造。 */
function presetPlugins(handle: RolePresetHandle): string[] {
  const value = (handle as RolePresetHandle & { plugins?: unknown }).plugins
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** preset 实际注册成功的角色 skill；旧替身没有该字段时返回 undefined，表示未知。 */
function presetSkills(handle: RolePresetHandle): string[] | undefined {
  const value = (handle as RolePresetHandle & { skills?: unknown }).skills
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((name, index) => name === sortedRight[index])
}

/** 结果 schema 的顶层必填字段；只读对象 schema 的 required，不猜嵌套结构。 */
function requiredFields(schema: Record<string, unknown> | undefined): string[] {
  if (schema === undefined) return []
  const required = schema.required
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === 'string' && field !== '') : []
}

/**
 * 识别“把 schema 定义本身当结果”的明显形态：对象 schema 的 type/properties/required
 * 都在，但顶层缺少实际 required 字段。正常结果只要 required 齐全就不会命中。
 */
function missingResultFields(value: unknown, required: readonly string[]): string[] {
  if (required.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const properties = record.properties
  if (record.type !== 'object' || properties === null || typeof properties !== 'object' || Array.isArray(properties)) return []
  const declared = record.required
  if (!Array.isArray(declared) || declared.length === 0 || !declared.every((field) => typeof field === 'string')) return []
  return required.filter((field) => !Object.hasOwn(record, field))
}

/** 泛化停止诊断（如 error/failed）才允许被格式诊断替换；实质错误必须保留。 */
function genericDiagnostic(value: string | undefined): boolean {
  if (value === undefined) return true
  const text = value.trim()
  return text === '' || /^(?:error|failed|failure|unknown|子\s*agent\s*停止[:：]?\s*(?:error|failed)?)$/i.test(text)
}

/**
 * 原生 structured_output 缺失时的诊断。
 * 只陈述“没有收到有效提交”这一观察，不推断 SDK 校验、模型或鉴权原因。
 */
const NATIVE_MISSING_DIAGNOSTIC = '未收到 structured_output 的有效提交；文本/JSON代码块不能替代原生结构化结果'

/**
 * 子 Agent 想结束却还没提交原生结果时，在同一轮里提醒的次数上限。
 * 模型常把结论写成文字里的 JSON 代码块就收尾（评审最常见）；提醒只要求把已有结论用工具交一次，
 * 不重做任务，结构化工具和 schema 校验都还在同一个 activation 里，结果仍然只认工具提交。
 */
const SUBMIT_REMINDERS = 2
const SUBMIT_REMINDER = '你还没有调用 structured_output，本次结果不会被记录。现在立即调用 structured_output，'
  + '把你已经得出的结论按它的参数 schema 原样提交一次：不要重新检查、不要再写长文，文字或代码块里的 JSON 不算提交。'

/** 提醒后仍未提交时补充的说明：把“没调工具”和“截断 / 模型报错”分清，免得 Lead 误判。 */
function missingSubmissionDetail(reminders: number): string {
  return reminders > 0
    ? `子 Agent 正常结束了对话，但没有调用 structured_output（同一轮内提醒 ${reminders} 次仍未提交）；不是输出被截断或模型报错，SDK 没收到工具提交时会把停止原因记为 error`
    : '子 Agent 正常结束了对话，但没有调用 structured_output；不是输出被截断或模型报错，SDK 没收到工具提交时会把停止原因记为 error'
}

function reminderMessage(): UserMessage {
  // 官方 MessageSource 只接受已知 kind；插件消息沿用 user 来源（同 notify.ts）。
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: SUBMIT_REMINDER }], source: { kind: 'user' } }
}

/** 结果格式提示：只描述格式，不替模型填写任何结论或默认通过。 */
function structuredPrompt(schema: Record<string, unknown>, native: boolean): string {
  const required = requiredFields(schema)
  const fields = required.length > 0 ? `必须包含顶层字段：${required.join('、')}。` : '按 schema 的 properties 填写实际结果字段。'
  const submission = native
    ? '结果格式要求：完成时必须调用 structured_output 工具提交实际结果，且只调用一次；工具参数是实际结果字段，不是 schema 定义。不要用纯文本或代码块结束，只有 structured_output 的成功提交才算结果。'
    : '最后输出一个 JSON 代码块；最终只提交实际结果 JSON 对象。'
  return [
    submission,
    fields,
    'type/properties/required 是 schema 格式定义，不是结果内容，禁止把 schema 定义本身当作结果提交。',
    '不要用长文、批准话术或已读的人类报告替代结果；字段值按本次真实检查结论填写，不得伪造通过。',
  ].join('')
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 读取当前 attempt 已记录的节点配方。
 *
 * 引擎在 harness.run 之前写入 node.recipe；这里按“最近一次 node.started 之后 +
 * nodeId + role”匹配，避免 review 节点的多位评审者互相串用配方。
 * 事件读取失败或配方缺失时返回 undefined，追溯仍可继续，不能因附加信息中断运行。
 */
async function currentRecipe(
  space: SpaceHandle,
  runId: string,
  nodeId: string,
  role: string,
  attempt: number,
): Promise<{ key: string; seq: number } | undefined> {
  try {
    const events = await space.stores.events.read(runId, { nodeId })
    const start = events.map((event) => event.type).lastIndexOf('node.started')
    if (start < 0 || (events[start]!.data as { attempt?: number }).attempt !== attempt) return undefined
    for (let index = events.length - 1; index > start; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      if (event.type !== 'node.recipe') continue
      const data = event.data as { role?: unknown; recipeKey?: unknown } | undefined
      if (data?.role !== role) continue
      if (typeof data.recipeKey !== 'string' || data.recipeKey === '') continue
      return { key: data.recipeKey, seq: event.seq }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * RunManager 为每次运行创建的 dsh 子 Agent 适配器。
 * 固定 parent 与空间；开始前登记权限，等待真实结果和 teardown 后才释放授权。
 * 启动、审计、取消和清理错误全部向引擎传播，不能当作节点成功。
 */
export function createDshHarness(deps?: DshHarnessDeps): DshHarness {
  const active = new Set<Promise<HarnessResult>>()
  const cleanupFailures: unknown[] = []
  const selftestChildren = new Set<string>()
  const adapter: HarnessAdapter = {
    id: 'dsh-host',
    displayName: 'DeepSeek Harness (dsh-host)',
    capabilities: {
      resume: false,
      structuredOutput: true,
      toolEvents: false,
      usage: false,
      customProvider: false,
      sandbox: false,
      mcp: true,
    },
    async available() {
      return deps === undefined ? { ok: false, reason: 'dsh-host 缺少宿主运行上下文' } : { ok: true }
    },
    async run(req: HarnessRequest, onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
      if (deps === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 缺少宿主运行上下文')
      const { ctx, space } = deps
      // 本次请求的密钥集合只用于内存脱敏；追溯和错误诊断共用同一份，避免错误文本泄露密钥。
      const secrets = collectSecrets(req, space.stores.config?.providers ?? {})
      const redact = createRedactor(secrets)
      const baseSignal = req.signal ?? new AbortController().signal
      const signal = req.timeoutMs === undefined ? baseSignal : AbortSignal.any([baseSignal, AbortSignal.timeout(req.timeoutMs)])
      signal.throwIfAborted()
      const role = req.env?.TAKT_ROLE
      const runId = req.env?.TAKT_RUN_ID
      const nodeId = req.env?.TAKT_NODE
      if (!role || !runId || !nodeId) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 请求缺少角色、运行或节点身份')
      // cwd 可以是空间内 worktree；只要求 realpath containment，不再要求等于空间根。
      const requestedCwd = await realpath(req.cwd)
      const spaceRoot = await realpath(space.root)
      if (!within(spaceRoot, requestedCwd)) throw new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', '节点 cwd 必须在空间根内')
      // core 会传入本地 sandbox；只接受 provider=local 且 workdir 与 cwd 一致，外部 sandbox 仍拒绝。
      if (req.sandbox !== undefined) {
        if (req.sandbox.provider !== 'local') {
          throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `dsh-host 只接受本地 sandbox，拒绝外部 sandbox：${req.sandbox.provider}`)
        }
        const workdir = req.sandbox.spec?.workdir
        if (typeof workdir !== 'string' || workdir.trim() === '') {
          throw new TaktToolError('TAKT_UNSUPPORTED_NODE', '本地 sandbox 缺少 workdir')
        }
        const sandboxCwd = await realpath(path.isAbsolute(workdir) ? workdir : path.resolve(requestedCwd, workdir))
        if (sandboxCwd !== requestedCwd) {
          throw new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', '本地 sandbox 的 workdir 与节点 cwd 不一致')
        }
      }
      if (req.provider !== undefined || req.sessionId !== undefined) {
        throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 不支持独立 provider 或会话续聊')
      }
      const run = await space.stores.runs.get(runId)
      const node = run?.nodes[nodeId]
      if (run === undefined || node === undefined || node.attempts < 1) {
        throw new TaktToolError('TAKT_RUN_BUSY', `运行中的节点身份不可用：${runId}/${nodeId}`)
      }
      const nodeRef = { runId, nodeId, attempt: node.attempts }
      const profile = deps.profiles?.[role]
      const allowBash = req.tools?.allowBash === true || profile?.allowBash === true
      if (allowBash) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'P0 dsh-host 不支持 shell')
      const artifactDir = space.stores.workspaces?.dir(run.requirementId)
      if (typeof artifactDir !== 'string' || artifactDir === '') {
        throw new TaktToolError('TAKT_UNSUPPORTED_NODE', '空间缺少当前需求的公共产物目录')
      }
      const artifactRoot = await realpath(artifactDir)
      if (!within(spaceRoot, artifactRoot)) {
        throw new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', '当前需求产物目录不在空间根内')
      }
      const writeScope = [...(req.tools?.writeScope ?? profile?.writeScope ?? [])]
      const readScope = profile?.readScope === undefined ? undefined : [...profile.readScope]
      const readOnly = writeScope.length === 0
      // 与 preset 共用同一能力判定：只写需求产物/知识库的文档型角色不登记自测，
      // 也不在启动前冻结一条它根本不会用的 QA 命令。权限范围本身不变。
      const selftestEnabled = canUseSelftest(space, writeScope, readOnly)
      const requireParent = async () => {
        const parent = ctx.agents.get(deps.ownerSessionId)
        if (parent !== undefined) return parent
        await deps.onLeadOffline(nodeRef)
        throw new TaktToolError('TAKT_RUN_BUSY', 'Lead Agent 已离线，本次运行已取消', '重新打开 Lead 会话后发起新运行')
      }
      await requireParent()
      const childId = randomUUID()
      const releasePermission = deps.permissions.register({
        childId, nodeRef, cwd: requestedCwd, spaceRoot, artifactRoot, writeScope,
        ...(readScope === undefined ? {} : { readScope }),
        allowBash: false, readOnly,
      })
      let preset: RolePresetHandle | undefined
      let activation: SubagentActivation | undefined
      let disposal: Promise<void> | undefined
      let trace: AgentTraceHandle | undefined
      let unsubscribeSession: (() => void | Promise<void>) | undefined
      let unsubscribeSubmit: Array<() => void | Promise<void>> = []
      let reminders = 0
      let outcome: AgentTraceOutcome | undefined
      let selftest: SelftestRegistration | undefined
      let runError: unknown
      const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(() => activation?.dispose())
      const abort = () => { selftest?.cancel(signal.reason); void dispose().catch(() => {}) }
      try {
        // 启动子 Agent 前冻结受控自测上下文；没有可信命令时只登记错误，不阻断节点启动。
        // 文档型角色不登记：它们没有代码/测试写入范围，也不应该拿到自测工具。
        if (deps.selftests !== undefined && selftestEnabled) {
          selftest = await deps.selftests.register({
            childId, space, nodeRef, role, requirementId: run.requirementId,
            cwd: requestedCwd, env: { ...(req.env ?? {}) }, writeScope,
            signal, sessionId: childId, readOnly, allowBash: false,
            ...(deps.workflow === undefined ? {} : { workflow: deps.workflow }),
            ...(deps.withSystemWrites === undefined ? {} : { withSystemWrites: deps.withSystemWrites }),
          })
          selftestChildren.add(childId)
        }
        preset = await deps.presets.acquire(space, role, {
          readOnly, allowBash: false,
          // 旧 fake/旧调用方没有自测服务时保持原 variant 形状；生产始终传实际范围。
          ...(deps.selftests === undefined ? {} : { writeScope }),
        })
        signal.throwIfAborted()
        const actualSkills = presetSkills(preset)
        // 生产 preset 必须报告实际注册的 skills；旧 fake preset 没有该字段时保持兼容。
        if (deps.roleSkills !== undefined && actualSkills !== undefined) {
          const expected = (deps.roleSkills[role] ?? []).map((skill) => skill.name)
          if (!sameNames(expected, actualSkills)) {
            throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `角色 ${role} 的 preset 实际注册技能与冻结快照不一致`)
          }
        }
        await deps.onPreset?.(role, { id: preset.id, cfgHash: preset.cfgHash }, nodeRef)
        const outputSchema = supportsDshOutputSchema(req.resultSchema) ? req.resultSchema : undefined
        const prompt = [req.systemAppend, req.prompt,
          req.resultSchema === undefined ? '' : structuredPrompt(req.resultSchema, outputSchema !== undefined),
        ].filter(Boolean).join('\n\n')
        const label = `${req.env?.TAKT_REQ ?? run?.requirementId ?? runId}/${nodeId}#${nodeRef.attempt}`
        if (deps.traces !== undefined) {
          // 来源在 loadRunProfiles 时冻结；缺失时明确失败，不能按角色名猜 bundled/space。
          if (profile === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `追溯缺少角色档案：${role}`)
          const source = deps.profileSources?.[role]
          if (source === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `追溯缺少冻结的角色来源：${role}`)
          const recipe = await currentRecipe(space, runId, nodeId, role, nodeRef.attempt)
          trace = await deps.traces.begin(space, {
            runId, nodeId, attempt: nodeRef.attempt, label, role, sessionId: childId,
            ...(recipe === undefined ? {} : { recipeKey: recipe.key, recipeEventSeq: recipe.seq }),
            preset: {
              id: preset.id, cfgHash: preset.cfgHash, plugins: presetPlugins(preset),
              ...(actualSkills === undefined ? {} : { skills: [...actualSkills] }),
            },
            profile: {
              title: profile.title, description: profile.description,
              // 有 handle 实际技能时以它为准；旧 fake preset 缺字段才退回声明名。
              skills: actualSkills === undefined ? [...profile.skills] : [...actualSkills],
              declaredSkills: [...profile.skills],
              writeScope: [...profile.writeScope], readOnly, source,
            },
            prompt,
            ...(req.systemAppend === undefined ? {} : { systemAppend: req.systemAppend }),
            ...(outputSchema === undefined ? {} : { outputSchema }),
            // 本次请求的密钥集合（含 req.env 与冻结 providers）只用于内存脱敏。
            secrets,
          })
          // 官方 dsh-subagent 在 result resolve 前就 dispose 子 Agent，必须在启动前订阅。
          const listener = ((session: { id?: string; header?: { id?: string } }, event: SessionEvent) => {
            const id = session.id ?? session.header?.id
            if (id === childId) trace?.sessionEvent(event)
          }) as (...args: never[]) => void
          unsubscribeSession = ctx.on('session/event', listener)
        }
        if (outputSchema !== undefined) {
          // 原生结果只认 structured_output：子 Agent 想结束却还没提交时，在同一轮里提醒它把已有结论交上来。
          // turn-stopping 在本轮关闭前串行派发，steer 进下一步的输入让本轮继续，不和 activation 结算竞争。
          let submitted = false
          unsubscribeSubmit = [
            ctx.on('tools/result', ((exec: ToolExecution, result: { isError?: boolean } | undefined) => {
              if (exec.agent?.id === childId && exec.name === 'structured_output' && result?.isError !== true) submitted = true
            }) as (...args: never[]) => void),
            ctx.on('agent/turn-stopping', ((event: AgentTurnStoppingEvent) => {
              const agent = event?.agent
              if (agent?.id !== childId || submitted || reminders >= SUBMIT_REMINDERS) return
              if (signal.aborted || event.signal?.aborted || typeof agent.steer !== 'function') return
              reminders += 1
              agent.steer(reminderMessage())
            }) as (...args: never[]) => void),
          ]
        }
        // 角色档案选了 App 里的模型（<provider>/<model>）时用它；模板里的别名等其它写法跟随 App 当前模型。
        const modelOption = await dshModelOption(ctx, req.model)
        while (activation === undefined) {
          signal.throwIfAborted()
          const parent = await requireParent()
          try {
            activation = await ctx.subagents.startActivation({
              provider: 'spawn', label, childId, signal, delivery: 'caller',
              request: {
                prompt: [{ type: 'text', text: prompt }], agentPreset: preset.id,
                ...(outputSchema === undefined ? {} : { outputSchema }), parent, cwd: requestedCwd,
                // 只在角色明确选了 App 模型时传 agentOptions；否则子 Agent 用 App 模型，req.model 不能谎报为实际模型。
                ...(modelOption === undefined ? {} : { agentOptions: modelOption }),
              },
            })
          } catch (error) {
            if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ACTIVATION_LIMIT_REACHED')) throw error
            await waitForCapacity(signal, deps.queueIntervalMs ?? 100)
          }
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        if (activation.childId !== childId) throw new Error('dsh 返回的子 Agent 身份与预留 childId 不一致')
        // child 在 result 前就可能被销毁；这里只取发布瞬间的真实 options。
        const child = ctx.agents.get(childId)
        trace?.running(child?.options.model, child?.options.reasoningEffort)
        onEvent({
          type: 'started', sessionId: childId,
          ...(child?.options.model === undefined ? {} : { model: child.options.model }),
        })
        const result = await activation.result
        const finalText = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (finalText !== '') onEvent({ type: 'message', role: 'assistant', text: finalText })
        const required = requiredFields(req.resultSchema)
        const native = outputSchema !== undefined
        const parsedFinal = req.resultSchema === undefined ? undefined : extractJsonBlock(finalText)
        // 原生 outputSchema 只认 structured_output 的提交；finalText 仅用于区分
        // “把 schema 定义当结果”和“根本没有提交原生结果”，不能回退成成功。
        const nativeStructured = native ? result.structured : parsedFinal
        const missing = missingResultFields(nativeStructured === undefined ? parsedFinal : nativeStructured, required)
        const schemaError = missing.length === 0 ? undefined
          : `结构化结果格式错误：返回了 schema 定义，缺少实际结果字段：${missing.join('、')}`
        // SDK 在原生 schema 下没有捕获到 tool 结果时会把 completed 改成 error；
        // completed/error/failed 且无 structured 都明确报告“未提交”，取消/超时保留原停止原因。
        const nativeMissing = native && result.structured === undefined
        const nativeMissingError = nativeMissing
          && (result.stopReason === 'completed' || result.stopReason === 'error' || result.stopReason === 'failed')
          ? `${NATIVE_MISSING_DIAGNOSTIC}。${missingSubmissionDetail(reminders)}` : undefined
        // 实质诊断（鉴权、超时等）必须保留；schema 定义错误优先于泛化的未提交诊断。
        const specificError = schemaError ?? nativeMissingError
        const failure = specificError === undefined
          ? result.diagnostic ?? `子 Agent 停止：${result.stopReason}`
          : result.diagnostic !== undefined && !genericDiagnostic(result.diagnostic)
            ? `${result.diagnostic}；${specificError}`
            : specificError
        const ok = result.stopReason === 'completed' && schemaError === undefined && !nativeMissing
        // dsh 原生结果可能深冻结；core 会补齐归因 runId、规范化评审项，只能修改独立副本。
        const structured = nativeStructured === undefined ? undefined : structuredClone(nativeStructured)
        const status = ok ? 'completed'
          : result.stopReason === 'aborted' || result.stopReason === 'cancelled' ? 'cancelled' : 'failed'
        outcome = {
          status,
          stopReason: result.stopReason,
          ...(finalText === '' ? {} : { finalText }),
          ...(status === 'completed' ? {} : { error: redact(failure) }),
        }
        // 结果已经返回时仍要保留 stopReason/finalText；取消只覆盖状态，不丢已有信息。
        if (signal.aborted) {
          outcome = {
            status: 'cancelled',
            ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
            ...(outcome.finalText === undefined ? {} : { finalText: outcome.finalText }),
            error: redact(errorMessage(signal.reason ?? '运行已取消')),
          }
          signal.throwIfAborted()
        }
        return {
          ok, finalText, sessionId: childId,
          ...(structured === undefined ? {} : { structured }),
          ...(ok ? {} : { error: redact(failure) }),
        }
      } catch (error) {
        runError = error
        throw error
      } finally {
        signal.removeEventListener('abort', abort)
        // 无法确认子 Agent 已停止时保留守卫和 preset，避免清理失败后无权限保护。
        let cleanupError: unknown
        let activationStopped = true
        selftest?.cancel(new Error('节点执行已结束'))
        try {
          if (activation !== undefined) await dispose()
        } catch (error) {
          activationStopped = false
          cleanupFailures.push(error)
          cleanupError = error
        }
        // 先取消并等待受控自测进程组；即使 activation 清理失败也要收掉自测子进程。
        try {
          if (selftest !== undefined) await selftest.release()
        } catch (error) {
          cleanupFailures.push(error)
          cleanupError ??= error
        } finally {
          selftestChildren.delete(childId)
        }
        // 无法确认子 Agent 已停止时保留守卫和 preset，避免清理失败后无权限保护。
        if (activationStopped) {
          try {
            releasePermission()
            if (preset !== undefined) await Promise.resolve(preset.release())
          } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        if (trace !== undefined) {
          let finalOutcome: AgentTraceOutcome
          if (outcome !== undefined) finalOutcome = outcome
          else if (signal.aborted) {
            finalOutcome = { status: 'cancelled', ...(runError === undefined ? {} : { error: errorMessage(signal.reason ?? runError) }) }
          } else {
            finalOutcome = { status: 'failed', error: errorMessage(runError ?? '节点未产生结果') }
          }
          if (cleanupError !== undefined) {
            const cleanupText = errorMessage(cleanupError)
            const merged = finalOutcome.error === undefined ? `清理失败：${cleanupText}` : `${finalOutcome.error}；清理失败：${cleanupText}`
            finalOutcome = finalOutcome.status === 'cancelled'
              ? { ...finalOutcome, error: merged }
              : {
                  status: 'failed',
                  ...(finalOutcome.stopReason === undefined ? {} : { stopReason: finalOutcome.stopReason }),
                  ...(finalOutcome.finalText === undefined ? {} : { finalText: finalOutcome.finalText }),
                  error: merged,
                }
          }
          // 最终刷新必须先于 trace.dispose；失败作为清理错误传播，不能假成功。
          try { await trace.finish(finalOutcome) } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
            // 写盘失败后用 failed 终态重试一次：磁盘恢复时也不能留下 completed 假成功。
            try {
              await trace.finish({
                status: 'failed',
                ...(finalOutcome.stopReason === undefined ? {} : { stopReason: finalOutcome.stopReason }),
                ...(finalOutcome.finalText === undefined ? {} : { finalText: finalOutcome.finalText }),
                error: `追溯记录写入失败：${errorMessage(error)}`,
              })
            } catch (retryError) {
              cleanupFailures.push(retryError)
            }
          }
          try { await trace.dispose() } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        // 会话事件订阅保留到最终刷新和 dispose 完成，避免漏掉最后一条 usage/tool 结果。
        if (unsubscribeSession !== undefined) {
          try { await unsubscribeSession() } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        for (const off of unsubscribeSubmit) {
          try { await off() } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        if (cleanupError !== undefined) throw cleanupError
      }
    },
  }
  return {
    ...adapter,
    run(req, onEvent) {
      const task = adapter.run(req, onEvent)
      active.add(task)
      void task.then(() => { active.delete(task) }, () => { active.delete(task) })
      return task
    },
    async drain() {
      while (active.size > 0) await Promise.allSettled([...active])
      // 兜底等待：正常路径 release 已经等待；这里防止取消竞态留下未收敛的自测进程。
      if (deps?.selftests !== undefined) {
        for (const childId of [...selftestChildren]) await deps.selftests.drain(childId)
      }
      if (cleanupFailures.length > 0) throw new AggregateError([...cleanupFailures], 'dsh 子 Agent 资源清理失败')
    },
  }
}
