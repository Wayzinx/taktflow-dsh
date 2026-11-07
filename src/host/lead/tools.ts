import { isUtf8 } from 'node:buffer'
import { access, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import {
  assertArtifactPath,
  assertRequirementId,
  assertRunId,
  canonicalJson,
  createInsights,
  initProject,
  readJsonFile,
  readLease,
  resolvePaths,
  toJsonText,
  writeFileAtomic,
  type Actor,
  type ArtifactRecord,
  type AttentionItem,
  type DefectDetail,
  type DefectReportRequest,
  type EventVerifyReason,
  type ExternalLink,
  type Requirement,
  type RunState,
  assertNoSymlinks, withFileLock,
} from '@taktflow/core'
import { BUNDLED_ROLE_FILES } from '../../roles/defaults.js'
import { BUNDLED_WORKFLOW_FILES, DEFAULT_WORKFLOW_FILE, LITE_WORKFLOW_FILE } from '../../templates/bundled.js'
import { withSpaceMutationLock } from '../space-lock.js'
import type {
  Agent,
  ContentBlock,
  DefineTool,
  DefineToolOptions,
  HostContext,
  JsonValue,
  ToolDefinition,
  ToolExecutionContext,
  ValueSchemaSpec,
} from '../dsh-types.js'
import type { M3Service } from '../m3.js'
import { TaktToolError, type SpaceHandle, type TaktErrorCode, type TaktflowService } from '../types.js'
import { bindingActor, bindingsUser } from '../bindings.js'
import { escalationForRequest } from '../approvals.js'
import { isAutonomyAnswering } from '../autonomy-state.js'
import { buildRunStatus, type RunStatusReport } from './run-status.js'
import {
  assertRequestKey,
  fingerprintCreateInput,
  requirementIdForRequest,
  withCreateLedger,
  type CreateLedger,
  type CreateRequestRecord,
} from './ledger.js'
import { taktConfigTool } from './config-tool.js'

const QUICK_WORKFLOW_FILE = 'quick-fix.workflow.ts'

/** Lead 行对外承诺的工具清单；顺序与注册顺序一致，便于宿主与测试核对。 */
export const LEAD_TOOL_NAMES = [
  'takt_status',
  'takt_requirement',
  'takt_artifact',
  'takt_run',
  'takt_trace',
  'takt_ask_human',
  'takt_config',
] as const

/**
 * Lead 的 7 个工具（技术方案 5.8；takt_config 见设计 21）。
 *
 * 设计约束：
 * - 身份只从 dsh 可信上下文拿：exec.agent + ctx.agents.get/roots；绝不信任模型
 *   参数里的 by/user。
 * - 除 takt_status 的未绑定只读视图外，所有动作都要求调用方是绑定该需求的根
 *   Agent；create/bind 额外走初始化授权（空间根 + 未绑定 + 租约）。
 * - 所有错误转成 { code, message, hint } 的结构化结果，不把原始异常抛给模型。
 * - 每个结果都有 summary（一行渲染）和 next_actions（下一步工具）。
 */
export type LeadErrorCode =
  | TaktErrorCode
  | 'TAKT_INVALID_INPUT'
  | 'TAKT_UNSUPPORTED_ACTION'
  | 'TAKT_INTERNAL'

export interface LeadError {
  code: LeadErrorCode
  message: string
  hint?: string
}

export interface LeadToolResult {
  ok: boolean
  summary: string
  next_actions: string[]
  error?: LeadError
  [key: string]: unknown
}

/** Lead 行注入的测试 seam：正式环境由 dsh-runtime.loadDefineTool 提供 defineTool。 */
export interface LeadToolOptions {
  ctx?: Pick<HostContext, 'agents'>
  /** 配置里的人；缺省用 os.userInfo().username。 */
  user?: string
}

export interface ToolDeps {
  service: TaktflowService
  agents: HostContext['agents'] | undefined
  human: string
}

interface BaseCaller {
  agent: Agent
  service: TaktflowService
  sessionId: string
  space: SpaceHandle
  human: string
}

interface BoundCaller extends BaseCaller {
  requirementId: string
}

/** Lead 只能写这两个位置；其它路径交给流程或人。 */
export const LEAD_DECISION_PATH = 'decisions/lead-notes.md'
/** 路径段不能含控制字符、空白、路径分隔符或百分号；中文等 Unicode 文件名合法。 */
const CONTROL_OR_SPACE = /[\u0000-\u001f\u007f\s]/

/** 工具输出 schema：结构化 JSON 的公共骨架，具体字段按工具追加。 */
export const OUTPUT_SCHEMA: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
    next_actions: { type: 'array', items: { type: 'string' }, required: true },
    error: { type: 'json' },
  },
}

/**
 * 注册 Lead 工具。
 *
 * 调用方：taktflow/lead 行的 apply（正式环境）与单测（注入 defineTool stub）。
 * 返回：ToolDefinition[]，由 Lead 行用 ctx.tools.register 逐个注册。
 * 身份：options.ctx 缺失时所有工具都拒绝调用；不会因为缺少 ctx 而放宽权限。
 */
export function registerLeadTools(
  defineTool: DefineTool,
  service: TaktflowService,
  options: LeadToolOptions = {},
): ToolDefinition[] {
  const deps: ToolDeps = {
    service,
    agents: options.ctx?.agents,
    // 优先用 createLeadServices 登记在绑定表上的配置人；模型参数无法覆盖。
    human: options.user ?? bindingsUser(service.bindings) ?? defaultUser(),
  }
  return [
    defineTool(taktStatusTool(deps)),
    defineTool(taktRequirementTool(deps)),
    defineTool(taktArtifactTool(deps)),
    defineTool(taktRunTool(deps)),
    defineTool(taktTraceTool(deps)),
    defineTool(taktAskHumanTool(deps)),
    defineTool(taktConfigTool(deps)),
  ]
}

// ---------------------------------------------------------------- 身份与空间

function defaultUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

export function requireRootAgent(exec: ToolExecutionContext, deps: ToolDeps): Agent {
  const caller = exec.agent
  if (caller === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '当前调用没有 Agent 身份，不能执行 Lead 操作',
      'Lead 工具只能在 taktflow Lead 会话里调用。',
    )
  }
  if (deps.agents === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      'Lead 行没有接入可信的 agents 服务，无法校验调用者身份',
      '让宿主以完整 dsh 服务加载 taktflow/lead 行后再试。',
    )
  }
  const live = deps.agents.get(caller.id)
  // 必须是同一个对象，不能只比对 id：伪造相同 id 的调用者不能借壳通过。
  if (live === undefined || live !== caller) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '调用方不是仍然存活的 Agent 会话',
      '请在仍打开的 taktflow Lead 会话里调用。',
    )
  }
  if (!deps.agents.roots().includes(caller)) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '只有根 Agent 能调用 Lead 工具，子 Agent 不能代替 Lead 操作',
      '请回到 Lead 根会话执行。',
    )
  }
  if (currentPreset(caller) !== 'taktflow') {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '当前会话不是 taktflow preset，不能执行 Lead 操作',
      'Lead 工具只挂在 taktflow preset 下；请从 taktflow 会话调用，标准会话不要创建绑定。',
    )
  }
  return caller
}

/**
 * Agent 当前挂载的 preset。
 *
 * 桌面版先建 standard 会话、再用 agent-preset/selected 切换，header.agentPreset 只记
 * 创建时的值；以 preset 注册表的 composedPreset 为准（dsh-subagent 同样这样读）。
 * 注册表不可用时退回 header。
 */
function currentPreset(agent: Agent): string | undefined {
  const presets = agent.ctx?.get('agentPresets') as { composedPreset?(ctx: unknown): string | undefined } | undefined
  return presets?.composedPreset?.(agent.ctx) ?? agent.session.header.agentPreset
}

async function resolveSpace(deps: ToolDeps, agent: Agent): Promise<SpaceHandle> {
  return deps.service.spaces.forSession(agent.session.header.cwd)
}

async function resolveBoundCaller(exec: ToolExecutionContext, deps: ToolDeps): Promise<BoundCaller> {
  const agent = requireRootAgent(exec, deps)
  const space = await resolveSpace(deps, agent)
  const requirementId = await deps.service.bindings.bySession(space, agent.id)
  if (requirementId === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '当前 Lead 会话还没有绑定需求',
      '先用 takt_requirement create 新建需求并自动绑定，或用 takt_requirement bind 绑定已有需求。',
    )
  }
  // 双向核对：损坏或并发写坏的绑定表不能让会话凭单向记录越权。
  const owner = await deps.service.bindings.byRequirement(space, requirementId)
  if (owner !== agent.id) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `需求 ${requirementId} 的绑定关系不一致`,
      '绑定表可能已损坏；请 takt_status 确认，必要时由维护者修复 .takt/dsh/bindings.json。',
    )
  }
  return { agent, service: deps.service, sessionId: agent.id, space, human: deps.human, requirementId }
}

function leadActor(agent: Agent, human: string): Actor {
  return {
    type: 'agent',
    role: 'lead',
    harness: 'dsh-host',
    ...(agent.options.model !== undefined ? { model: agent.options.model } : {}),
    onBehalfOf: human,
  }
}

function humanActor(human: string): Actor {
  return { type: 'human', id: human }
}

// ---------------------------------------------------------------- takt_status

function taktStatusTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_status',
    description: [
      '只读查看 Taktflow 空间、绑定需求、最近运行、待办和可用流程。',
      '何时用：会话开始、接手需求、汇报前；也用来判断下一步该 create/bind/start/ask_human。',
      '何时不用：不要用它修改任何状态；不要用它读取未绑定的需求数据。',
      '示例：{"requirement":"REQ-001"}；不传参数时查看当前绑定。',
    ].join('\n'),
    parameters: {
      requirement: { type: 'string', description: '可选；只允许当前已绑定的需求 ID。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const agent = requireRootAgent(exec, deps)
        const space = await resolveSpace(deps, agent)
        const bound = await deps.service.bindings.bySession(space, agent.id)
        const requested = optionalString(args, 'requirement')
        if (requested !== undefined) {
          if (bound === undefined) {
            throw new TaktToolError(
              'TAKT_NOT_BOUND',
              '当前会话还没有绑定需求，不能查看需求数据',
              '先 takt_requirement create 或 takt_requirement bind。',
            )
          }
          if (requested !== bound) {
            throw new TaktToolError(
              'TAKT_NOT_BOUND',
              `只能查看当前绑定的需求 ${bound}`,
              '切换需求需要新的 Lead 会话；不要尝试读取其它需求。',
            )
          }
        }

        // 空间流程要动态读配置并 import；旧 catalog 没有 list 时回退同步 ids。
        const workflows = deps.service.workflows.list === undefined
          ? deps.service.workflows.ids()
          : await deps.service.workflows.list(space)
        const lease = await leaseInfo(deps.service, space)
        if (bound === undefined) {
          return success(
            `空间 ${space.root} 尚未绑定需求；可用流程：${formatList(workflows)}`,
            {
              bound: false,
              space: { root: space.root },
              workflows,
              lease,
              initialization: {
                steps: [
                  '确认会话工作目录正好是空间根（包含 takt.config.json）',
                  '用 takt_requirement create 新建需求并自动绑定',
                  '或对已有需求调用 takt_requirement bind',
                ],
              },
            },
            [
              'takt_requirement create title="需求标题" requestKey="<稳定唯一键>"',
              'takt_requirement bind requirementId="REQ-001"',
            ],
          )
        }

        const owner = await deps.service.bindings.byRequirement(space, bound)
        if (owner !== agent.id) {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            `需求 ${bound} 的绑定关系不一致`,
            '绑定表可能已损坏；请由维护者修复 .takt/dsh/bindings.json 后再试。',
          )
        }
        const requirement = await space.stores.workspaces.getRequirement(bound)
        const runs = await space.stores.runs.list({ requirementId: bound })
        const latest = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
        const pending = await space.stores.attention.list({ pending: true, requirementId: bound })
        const pendingNote = pending.length === 0
          ? '没有待办'
          : `${pending.length} 条待办待处理（${pending.map((item) => item.requestId).join('、')}）`
        const runNote = latest === undefined ? '还没有运行' : `最近运行 ${latest.runId} ${latest.status}`
        const nextActions = [
          latest === undefined || isTerminal(latest.status)
            ? 'takt_run start requestKey="<稳定唯一键>"'
            : `takt_run get runId="${latest.runId}"`,
          'takt_artifact list',
          ...pending.slice(0, 3).map((item) => `takt_ask_human requestId="${item.requestId}"`),
        ]
        const runStatus = latest === undefined ? null : await runStatusFor(space, latest)
        return success(
          `空间 ${space.root}；需求 ${bound}；${runNote}；${pendingNote}`,
          {
            bound: true,
            space: { root: space.root },
            requirement: requirement === undefined ? null : requirementSummary(requirement),
            ...(requirement === undefined ? { warning: `绑定表中的需求 ${bound} 已不存在` } : {}),
            run: latest === undefined ? null : runSummary(latest),
            attention: pending.map(attentionSummary),
            runStatus,
            lease,
            workflows,
          },
          nextActions,
        )
      } catch (error) {
        const result = toFailure(error)
        if (result.error?.code === 'TAKT_NO_SPACE') {
          // 新目录是正常入口，不是失败终点：把 init 放在最前面，避免模型先让用户切目录。
          return {
            ...result,
            space: null,
            error: { ...result.error, hint: defaultHint('TAKT_NO_SPACE') },
            next_actions: ['takt_requirement action="init"', 'takt_status'],
          }
        }
        return result
      }
    },
  }
}

// ------------------------------------------------------------ takt_requirement

function taktRequirementTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_requirement',
    description: [
      '初始化空间，或创建/绑定一个需求。create 成功后会自动把当前会话绑定到该需求。',
      '何时用：takt_status 返回 TAKT_NO_SPACE 时先 init（在当前会话 cwd 初始化，已存在则幂等）；',
      '已有空间但未绑定需求时用 create（必须带稳定 requestKey，重试时保持不变）或 bind。',
      '何时不用：已经绑定需求后不要再次 create/bind；update、import_link 是 P1。',
      '示例：{"action":"init"}',
      '示例：{"action":"create","title":"支付回调重试","requestKey":"req-20261105-01"}',
      '示例：{"action":"bind","requirementId":"REQ-001"}',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        enum: ['init', 'create', 'bind', 'update', 'import_link'],
        required: true,
        description: 'P0 支持 init / create / bind；update、import_link 返回 P1 提示。',
      },
      title: { type: 'string', description: 'create 必填：需求标题。' },
      requestKey: {
        type: 'string',
        description: 'create 必填：稳定幂等键；重试必须使用同一个键，输入变化会被拒绝。',
      },
      requirementId: { type: 'string', description: 'bind 必填：已有需求 ID。' },
      id: { type: 'string', description: 'create 可选：指定需求 ID；不填由宿主生成。' },
      links: {
        type: 'array',
        items: { type: 'json' },
        description: 'create 可选：外部链接数组，元素形如 {"type":"url","url":"https://…","title":"…"}。',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const action = requiredString(args, 'action')
        const agent = requireRootAgent(exec, deps)
        // init 必须能在“还没有空间”时工作，所以先于 resolveSpace。
        if (action === 'init') return await initSpace(deps, agent)
        const space = await resolveSpace(deps, agent)
        if (action === 'update' || action === 'import_link') return p1('takt_requirement', action)
        if (action === 'create') return await createRequirement(deps, agent, space, args)
        if (action === 'bind') return await bindRequirement(deps, agent, space, args)
        throw invalidAction('takt_requirement', action, ['init', 'create', 'bind'])
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

// ------------------------------------------------------------ takt_requirement init

/** core initProject 会创建的 `.takt` 子目录；vendor 未导出，这里按同一顺序核对。 */
const INIT_SUBDIRS = ['objects', 'runs', 'chat'] as const
/** 新空间布局的顶层目录；旧布局（`.takt/*`）也一并保护。 */
const SPACE_PATHS = ['agents', 'workflows', 'skills', 'knowledge', 'requirements'] as const

/**
 * 在当前会话 cwd 初始化空间。
 *
 * 授权：调用方已经过 requireRootAgent（存活的 taktflow preset 根 Agent），cwd
 * 只从可信的 session header 读取，模型参数无法指定目录。
 *
 * 布局：新空间使用 M2 的空间布局（顶层 agents/workflows/skills/knowledge/
 * requirements），并复制随包模板；旧布局的 `.takt/*` 目录仍然兼容。
 *
 * 幂等与冲突（全部在任何磁盘写入之前判断）：
 * - cwd 本身已有 takt.config.json：打开并补齐缺失角色/流程模板，返回 alreadyInitialized；
 * - cwd 在已配置/已打开的空间根里面：TAKT_SPACE_ROOT_MISMATCH；
 * - 已有空间根在 cwd 里面（会产生嵌套空间）：TAKT_SPACE_ROOT_MISMATCH；
 * - 向上找到未注册的 takt.config.json：说明 cwd 是既有空间的子目录，拒绝。
 *
 * 成功后通过 SpaceRegistry.open 绑定根，后续 takt_status / 面板都能看到。
 */
async function initSpace(deps: ToolDeps, agent: Agent): Promise<LeadToolResult> {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new TaktToolError(
      'TAKT_NO_SPACE',
      '当前会话没有工作目录，无法初始化空间',
      '请从要初始化的项目目录打开 taktflow 会话。',
    )
  }
  let resolved: string
  try {
    resolved = await realpath(path.resolve(cwd))
  } catch {
    throw new TaktToolError(
      'TAKT_NO_SPACE',
      '会话工作目录不存在或不可访问',
      '确认目录存在后重新打开会话；init 不会创建会话目录。',
    )
  }

  return await withSpaceMutationLock(async () => {
    // 与 open 共用锁；写盘前先拒绝符号链接/同名特殊文件，避免写到空间根之外。
    await assertInitPathsSafe(resolved)

    // 跨进程也只允许一个 init 执行“检查 → initProject → 复制模板”这一段。
    // 文件锁在配置路径上；后到进程拿到锁后会重新检查配置是否已出现。
    const configFile = path.join(resolved, 'takt.config.json')
    return await withFileLock(configFile, async () => {
      // 已经是空间：幂等打开；仍补齐缺失的默认角色与流程模板，但绝不覆盖用户档案。
      if (await exists(configFile)) return await initExistingSpace(deps, resolved)

      // 多空间：可以在新目录初始化另一个空间，但必须在宿主配置的 spaces 里、不能和已有空间嵌套。写盘前拒绝。
      await deps.service.spaces.assertOpenable?.(resolved)
      const roots = await deps.service.spaces.roots()
      for (const root of roots) {
        if (root === resolved) continue
        if (isInside(resolved, root)) {
          throw spaceConflict(
            `会话目录在已有空间根 ${root} 里面，不能初始化嵌套空间：${resolved}`,
            `把会话工作目录切到 ${root}，或换一个不在任何空间内的空目录。`,
          )
        }
        if (isInside(root, resolved)) {
          throw spaceConflict(
            `已有空间根 ${root} 在会话目录里面，P0 只支持一个空间根：${resolved}`,
            '换一个与已有空间无包含关系的目录，或继续使用已有空间。',
          )
        }
      }

      // 向上查找未注册的空间：cwd 是既有空间的子目录时，同样不能在这里新建。
      const ancestor = await findAncestorSpace(resolved)
      if (ancestor !== undefined) {
        throw spaceConflict(
          `会话目录在已有空间根 ${ancestor} 里面，不能初始化嵌套空间：${resolved}`,
          `把会话工作目录切到 ${ancestor}，或换一个不在任何空间内的空目录。`,
        )
      }

      // core initProject 写新布局的 takt.config.json 和 .takt 运行时目录；随后补模板。
      const stores = await initProject(resolved)
      // 新空间默认流程必须是 taktflow-standard；core 当前默认写 sdlc，只在本次新建时修正。
      await ensureDefaultWorkflowOrder(stores)
      // 用注册表重新打开：拿到刚写入的新 config/paths，并统一做单根校验。
      const opened = await deps.service.spaces.open(resolved)
      await ensureInitLease(deps, opened)
      await preflightTemplateTargets(opened)
      const copied = await copyBundledTemplates(opened)
      return initSuccess(opened, copied, false)
    })
  })
}

/** 已存在空间的幂等路径：先租约、再按真实 paths 预检模板目标，最后只补缺失文件。 */
async function initExistingSpace(deps: ToolDeps, resolved: string): Promise<LeadToolResult> {
  const space = await deps.service.spaces.open(resolved)
  await ensureInitLease(deps, space)
  await preflightTemplateTargets(space)
  const copied = await copyBundledTemplates(space)
  return initSuccess(space, copied, true)
}

/** init 会写空间公共文件；已有空间也必须先拿到租约，避免两个宿主同时补模板。 */
async function ensureInitLease(deps: ToolDeps, space: SpaceHandle): Promise<void> {
  const ownership = deps.service.ownership
  if (ownership === undefined) return
  await ownership.ensureLease(space)
}

/** 按空间真实 paths 预检全部模板目标：任何同名目录/符号链接在第一次写之前失败。 */
async function preflightTemplateTargets(space: SpaceHandle): Promise<void> {
  for (const file of BUNDLED_ROLE_FILES) {
    await assertFileSafe(space.root, path.join(space.stores.paths.agents, file.fileName), `角色文件 ${file.fileName}`)
  }
  for (const file of BUNDLED_WORKFLOW_FILES) {
    await assertFileSafe(space.root, path.join(space.stores.paths.workflows, file.fileName), `流程模板 ${file.fileName}`)
  }
}

interface CopyResult {
  /** 本次实际写入的默认文件。 */
  copied: string[]
  /** 已存在、保留用户文件的条目。 */
  kept: string[]
}

interface InitCopyResult {
  roles: CopyResult
  workflows: CopyResult
}

/**
 * 新空间默认流程顺序：标准流水线、轻量改动、精简 sdlc。
 *
 * 只由 initSpace 在“本次新建空间”时调用；已有空间的 config 一律不改，避免覆盖
 * 用户调整过的流程顺序。返回写入后的配置对象，供随后的 SpaceHandle 使用。
 */
async function ensureDefaultWorkflowOrder(stores: Awaited<ReturnType<typeof initProject>>) {
  const relative = (fileName: string): string =>
    path.relative(stores.projectDir, path.join(stores.paths.workflows, fileName)).split(path.sep).join('/')
  // 三个模板都登记（标准、轻量、精简）；默认流程写进 route.defaultWorkflow，设置页可改。
  const wanted = [relative(DEFAULT_WORKFLOW_FILE), relative(QUICK_WORKFLOW_FILE), relative(LITE_WORKFLOW_FILE)]
  const current = stores.config.workflows ?? []
  const same = current.length === wanted.length && current.every((item, index) => item === wanted[index]) && stores.config.route?.defaultWorkflow !== undefined
  if (same) return stores.config
  const config = { ...stores.config, workflows: wanted, route: { ...stores.config.route, defaultWorkflow: DEFAULT_WORKFLOW_FILE.replace(/\.workflow\.ts$/, '') } }
  await writeFileAtomic(path.join(stores.projectDir, 'takt.config.json'), toJsonText(config))
  return config
}

/**
 * 只补缺：已存在的角色/流程文件一律保留，不覆盖用户修改。
 *
 * 目录或符号链接不能被当成“已存在文件”静默保留：符号链接可能指向空间外，
 * 目录会让运行期读取模板时悄悄回退。两种情况都明确失败。
 */
async function copyBundledTemplates(space: SpaceHandle): Promise<InitCopyResult> {
  return {
    // 角色结果对用户/模型展示角色名（不带 .md）；磁盘文件仍保留扩展名。
    roles: await copyFiles(space, space.stores.paths.agents, BUNDLED_ROLE_FILES.map((file) => ({
      fileName: file.fileName,
      displayName: file.fileName.replace(/\.md$/, ''),
      content: file.content,
    })), '角色文件'),
    workflows: await copyFiles(space, space.stores.paths.workflows, BUNDLED_WORKFLOW_FILES, '流程模板'),
  }
}

async function copyFiles(
  space: SpaceHandle,
  dir: string,
  files: readonly { fileName: string; content: string; displayName?: string }[],
  label: string,
): Promise<CopyResult> {
  await mkdir(dir, { recursive: true })
  const copied: string[] = []
  const kept: string[] = []
  for (const file of files) {
    const target = path.join(dir, file.fileName)
    const info = await assertNoSymlinkPath(space.root, target, `${label} ${file.fileName}`)
    if (info !== undefined && !info.isFile()) {
      throw spaceConflict(
        `${label}不是普通文件：${target}`,
        '删除同名目录或特殊文件后重试；不会用默认模板覆盖它。',
      )
    }
    const name = file.displayName ?? file.fileName
    try {
      await writeFile(target, `${file.content}\n`, { encoding: 'utf8', flag: 'wx' })
      copied.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        kept.push(name)
        continue
      }
      throw error
    }
  }
  return { copied, kept }
}

function initSuccess(space: SpaceHandle, copied: InitCopyResult, alreadyInitialized: boolean): LeadToolResult {
  const summary = alreadyInitialized
    ? `空间 ${space.root} 已初始化；补齐默认角色 ${copied.roles.copied.length} 个、流程模板 ${copied.workflows.copied.length} 个`
    : `已初始化空间 ${space.root}；复制默认角色 ${copied.roles.copied.length} 个、流程模板 ${copied.workflows.copied.length} 个`
  return success(
    summary,
    {
      initialized: true,
      alreadyInitialized,
      space: { root: space.root },
      roles: copied.roles,
      workflows: copied.workflows,
    },
    [
      'takt_status',
      'takt_requirement create title="需求标题" requestKey="<稳定唯一键>"',
    ],
  )
}

function spaceConflict(message: string, hint: string): TaktToolError {
  return new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', message, hint)
}

/** child 是否在 parent 内部（不包含相等）；与 SpaceRegistry 的判定保持一致。 */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** 从 start 的父目录向上找 takt.config.json；start 本身已确认不是空间。 */
async function findAncestorSpace(start: string): Promise<string | undefined> {
  let current = path.dirname(start)
  for (;;) {
    if (await exists(path.join(current, 'takt.config.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * init 写盘前的路径安全检查。
 *
 * core initProject 会写 `takt.config.json`、`.takt/{objects,runs,chat}` 以及空间
 * 布局的顶层目录；模板复制还会写 `agents/`、`workflows/`。任一组件是符号链接
 * 都会把写入导向空间根之外，必须在任何写入（包括幂等补齐模板）之前拒绝。
 * 已有配置里的自定义 `paths` 也纳入检查，不能只按默认目录判断。
 */
async function assertInitPathsSafe(root: string): Promise<void> {
  const configFile = path.join(root, 'takt.config.json')
  const config = await assertNoSymlinkPath(root, configFile, '配置文件')
  if (config !== undefined && !config.isFile()) {
    throw spaceConflict(`配置文件不是普通文件：${configFile}`, '移走同名目录或特殊文件后重试。')
  }
  const taktDir = path.join(root, '.takt')
  const takt = await assertNoSymlinkPath(root, taktDir, '.takt 目录')
  if (takt !== undefined && !takt.isDirectory()) {
    throw spaceConflict(`.takt 不是普通目录：${taktDir}`, '移走同名文件后重试。')
  }
  for (const sub of INIT_SUBDIRS) {
    await assertDirectorySafe(root, path.join(taktDir, sub), `.takt/${sub}`)
  }

  // 旧布局的 agents/workflows/workspaces 仍然兼容；新布局的顶层目录也要保护。
  const legacy = ['agents', 'workflows', 'workspaces'] as const
  for (const sub of legacy) await assertDirectorySafe(root, path.join(taktDir, sub), `.takt/${sub}`)
  for (const sub of SPACE_PATHS) await assertDirectorySafe(root, path.join(root, sub), sub)

  // 已有 config 的自定义 paths：用户可以把 agents 指到任意子目录。
  if (config !== undefined) {
    const value = await readJsonFile<unknown>(configFile).catch(() => undefined)
    const paths = isRecord(value) && isRecord(value.paths) ? value.paths : undefined
    if (paths !== undefined) {
      for (const [key, relative] of Object.entries(paths)) {
        if (typeof relative !== 'string' || relative.trim() === '') continue
        await assertDirectorySafe(root, path.resolve(root, relative), `paths.${key}`)
      }
    }
  }

  // 模板目标文件：同名的目录/特殊文件必须在复制前拒绝。
  for (const file of BUNDLED_ROLE_FILES) {
    await assertFileSafe(root, path.join(root, 'agents', file.fileName), `角色文件 ${file.fileName}`)
  }
  for (const file of BUNDLED_WORKFLOW_FILES) {
    await assertFileSafe(root, path.join(root, 'workflows', file.fileName), `流程模板 ${file.fileName}`)
  }
}

async function assertDirectorySafe(root: string, target: string, label: string): Promise<void> {
  const info = await assertNoSymlinkPath(root, target, `${label} 目录`)
  if (info !== undefined && !info.isDirectory()) {
    throw spaceConflict(`${label} 不是普通目录：${target}`, '移走同名文件后重试。')
  }
}

async function assertFileSafe(root: string, target: string, label: string): Promise<void> {
  const info = await assertNoSymlinkPath(root, target, label)
  if (info !== undefined && !info.isFile()) {
    throw spaceConflict(`${label} 不是普通文件：${target}`, '删除同名目录或特殊文件后重试；不会用默认模板覆盖它。')
  }
}

/** 从 root 到 target 的每个已存在组件都不能是符号链接；返回 target 的 lstat。 */
async function assertNoSymlinkPath(
  root: string,
  target: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    await assertNoSymlinks(root, target)
  } catch {
    throw spaceConflict(
      `${label}不能包含符号链接：${target}`,
      '移走符号链接后重试；init 不会把文件写到空间根之外。',
    )
  }
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function createRequirement(
  deps: ToolDeps,
  agent: Agent,
  space: SpaceHandle,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const title = requiredString(args, 'title')
  const requestKey = requestKeyArg(requiredString(args, 'requestKey'))
  const requestedId = optionalString(args, 'id')
  if (requestedId !== undefined) validateRequirementIdArg(requestedId)
  const links = parseLinks(args.links)
  const fingerprint = fingerprintCreateInput({ title, id: requestedId, links })
  const sessionId = agent.id
  const human = deps.human
  const reservedId = requestedId ?? requirementIdForRequest(requestKey)

  const outcome = await withCreateLedger(space, async (ledger) => {
    await deps.service.ownership.ensureLease(space)
    const existing = ledger.get(requestKey)
    const currentSession = await deps.service.bindings.bySession(space, sessionId)

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new LeadToolFailure(
          'TAKT_INVALID_INPUT',
          `requestKey ${requestKey} 已用于不同的创建请求`,
          '重试请保持 title/id/links 不变；要新建另一个需求请换一个 requestKey。',
        )
      }
      if (existing.sessionId !== sessionId) {
        throw new TaktToolError(
          'TAKT_NOT_BOUND',
          `requestKey ${requestKey} 已由另一个 Lead 会话用于创建需求`,
          'requestKey 按会话隔离；请换一个只属于当前会话的 requestKey，或在新会话里重新发起创建。',
        )
      }
      if (currentSession !== undefined && currentSession !== existing.requirementId) {
        throw new TaktToolError(
          'TAKT_NOT_BOUND',
          `当前会话已绑定需求 ${currentSession}，不能复用 ${requestKey} 创建的需求 ${existing.requirementId}`,
          '一个 Lead 会话只能绑定一个需求；请开新会话创建新需求。',
        )
      }
      const requirement = await space.stores.workspaces.getRequirement(existing.requirementId)
      if (requirement === undefined) {
        if (existing.status === 'completed') {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            `requestKey ${requestKey} 对应的需求已不存在：${existing.requirementId}`,
            '换一个 requestKey 重新创建，或先确认空间是否被清理。',
          )
        }
        // pending 但需求尚未落盘：继续用预留 ID 创建，属于崩溃恢复。
      } else {
        if (existing.status === 'pending') {
          try {
            assertRequirementMatches(requirement, title, links)
          } catch (error) {
            // 预留 ID 已被无关需求占用：清掉 pending，避免后续重试继续撞同一个 ID。
            await ledger.delete(requestKey)
            throw error
          }
        }
        const completed = await finishCreate(deps, space, sessionId, existing, human, ledger)
        return { requirement, deduped: true, record: completed }
      }
    }

    if (currentSession !== undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `当前会话已绑定需求 ${currentSession}，不能再次创建`,
        '一个 Lead 会话只能绑定一个需求；请开新会话创建新需求。',
      )
    }

    // 先写 pending 预留 ID，再创建需求：即使创建后进程崩溃，重试也能按预留 ID 恢复。
    const pending: CreateRequestRecord = {
      requestKey,
      requirementId: existing?.requirementId ?? reservedId,
      sessionId,
      fingerprint,
      status: 'pending',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      by: humanActor(human),
    }
    if (existing === undefined) await ledger.put(pending)

    let requirement: Requirement
    try {
      requirement = await space.stores.workspaces.createRequirement({
        title,
        id: pending.requirementId,
        ...(links !== undefined ? { links } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('需求已存在')) throw error
      const found = await space.stores.workspaces.getRequirement(pending.requirementId)
      if (found !== undefined && requirementMatches(found, title, links)) {
        // 上次创建成功但账本没来得及标记完成：按同一需求恢复。
        requirement = found
      } else {
        await ledger.delete(requestKey)
        throw new LeadToolFailure(
          'TAKT_INVALID_INPUT',
          message,
          `需求 ID ${pending.requirementId} 已被其它内容占用；换一个 requestKey，或改用 takt_requirement bind 绑定已有需求。`,
        )
      }
    }

    const completed = await finishCreate(deps, space, sessionId, pending, human, ledger)
    return { requirement, deduped: existing !== undefined, record: completed }
  })

  const { requirement, deduped, record } = outcome
  return success(
    `${deduped ? '复用' : '已创建'}需求 ${requirement.id} 并绑定到当前会话；用户要求启动时，下一步直接 takt_run start`,
    {
      bound: true,
      requirement: requirementSummary(requirement),
      deduped,
      audit: { by: human, at: record.createdAt },
    },
    // 模型常在 create 后停下等用户确认；第一条就给出可直接执行的 start。
    [`takt_run action="start" requestKey="start-${requirement.id}"`, 'takt_status'],
  )
}

/**
 * 创建/恢复流程的最后一步：确保绑定属于当前会话，并把账本标为 completed。
 *
 * 调用方：createRequirement 在文件锁内调用。绑定失败时不标完成，重试会重新
 * 进入这里；已经绑定到当前会话时是幂等 no-op。
 */
async function finishCreate(
  deps: ToolDeps,
  space: SpaceHandle,
  sessionId: string,
  record: CreateRequestRecord,
  human: string,
  ledger: CreateLedger,
): Promise<CreateRequestRecord> {
  const boundSession = await deps.service.bindings.byRequirement(space, record.requirementId)
  if (boundSession !== undefined && boundSession !== sessionId) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `需求 ${record.requirementId} 已绑定到另一个 Lead 会话`,
      'P0 不支持重新绑定；请开新的 Lead 会话并新建需求，或等待人工整合处理。',
    )
  }
  if (boundSession === undefined) {
    await deps.service.bindings.bind(space, record.requirementId, sessionId, humanActor(human))
  }
  if (record.status === 'completed') return record
  const completed: CreateRequestRecord = {
    ...record,
    status: 'completed',
    completedAt: new Date().toISOString(),
  }
  // 复用外层账本锁，不能再嵌套 withCreateLedger（文件锁不可重入）。
  await ledger.put(completed)
  return completed
}

async function bindRequirement(
  deps: ToolDeps,
  agent: Agent,
  space: SpaceHandle,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const requirementId = validateRequirementIdArg(requiredString(args, 'requirementId'))
  const sessionId = agent.id
  // 与 create 共用初始化事务锁：create 在创建需求期间暂停时，bind 不能抢先
  // 绑定别的需求，否则 create 随后会在 finishCreate 失败并留下孤儿需求。
  // 锁序固定为 createLedger -> bindings，和 createRequirement 保持一致。
  const requirement = await withCreateLedger(space, async () => {
    await deps.service.ownership.ensureLease(space)
    // 必须在锁内重读绑定：等锁期间 create 可能已经完成绑定。
    const currentSession = await deps.service.bindings.bySession(space, sessionId)
    if (currentSession !== undefined && currentSession !== requirementId) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `当前会话已绑定需求 ${currentSession}，不能再绑定 ${requirementId}`,
        '一个 Lead 会话只能绑定一个需求；请结束当前需求，或在新会话里绑定。',
      )
    }
    const found = await space.stores.workspaces.getRequirement(requirementId)
    if (found === undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `需求不存在：${requirementId}`,
        '用 takt_requirement create 新建，或确认需求 ID 是否正确。',
      )
    }
    await deps.service.bindings.bind(space, requirementId, sessionId, humanActor(deps.human))
    return found
  })
  return success(
    `已把需求 ${requirementId} 绑定到当前会话`,
    {
      bound: true,
      requirement: requirementSummary(requirement),
      audit: { by: deps.human, at: new Date().toISOString() },
    },
    // 模型常在 create 后停下等用户确认；第一条就给出可直接执行的 start。
    [`takt_run action="start" requestKey="start-${requirement.id}"`, 'takt_status'],
  )
}

// --------------------------------------------------------------- takt_artifact

function taktArtifactTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_artifact',
    description: [
      '查看、读取、查看版本历史，或写入公共存放区产物。',
      '何时用：list/read/log 了解需求产物；write 记录 Lead 的决策或澄清。',
      '何时不用：Lead 只能写 decisions/lead-notes.md 和 clarifications/**；其它改动用 takt_run 派发。',
      'write 必须带 reason 和 baseVersion（0 表示新建），版本不匹配会被拒绝。',
      '示例：{"action":"read","path":"design/design.md"}',
      '示例：{"action":"write","path":"clarifications/q1.md","content":"…","reason":"记录澄清结论","baseVersion":0}',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'log', 'write', 'diff', 'revert', 'comment'],
        required: true,
        description: 'P0 支持 list / read / log / write；diff、revert、comment 是 P1。',
      },
      path: { type: 'string', description: '产物路径，相对公共存放区，例如 design/design.md。' },
      version: { type: 'integer', description: 'read 可选：版本号；不填读最新版。' },
      content: { type: 'string', description: 'write 必填：新内容（可以是空字符串）。' },
      reason: { type: 'string', description: 'write 必填：修改原因，写入版本审计。' },
      baseVersion: {
        type: 'integer',
        description: 'write 必填：写入所基于的最新版本；0 表示新建。',
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const action = requiredString(args, 'action')
        const caller = await resolveBoundCaller(exec, deps)
        if (action === 'diff' || action === 'revert' || action === 'comment') {
          return p1('takt_artifact', action)
        }
        if (action === 'list') return await listArtifacts(caller)
        if (action === 'read') return await readArtifact(caller, args)
        if (action === 'log') return await artifactLog(caller, args)
        if (action === 'write') return await writeArtifact(caller, args)
        throw invalidAction('takt_artifact', action, ['list', 'read', 'log', 'write'])
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

async function listArtifacts(caller: BoundCaller): Promise<LeadToolResult> {
  const records = await caller.space.stores.workspaces.listArtifacts(caller.requirementId)
  const artifacts = records.map(artifactSummary)
  return success(
    `需求 ${caller.requirementId} 共 ${artifacts.length} 个产物`,
    { artifacts },
    ['takt_artifact read path="<产物路径>"', 'takt_artifact log path="<产物路径>"'],
  )
}

async function readArtifact(
  caller: BoundCaller,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const target = validateArtifactPathArg(requiredString(args, 'path'))
  const version = optionalInteger(args, 'version', 1)
  const records = await caller.space.stores.workspaces.listArtifacts(caller.requirementId)
  const record = records.find((item) => item.path === target)
  const content = await caller.space.stores.workspaces.readArtifact({
    workspace: caller.requirementId,
    path: target,
    ...(version !== undefined ? { version } : {}),
  })
  if (content === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `产物不存在：${target}${version !== undefined ? ` v${version}` : ''}`,
      '用 takt_artifact list 查看已有产物和版本。',
    )
  }
  const text = isUtf8(content) && !content.includes(0)
  const latest = record?.versions.at(-1)
  return success(
    `读取 ${target}${version !== undefined ? ` v${version}` : ''}（${content.byteLength} B）`,
    {
      path: target,
      version: version ?? latest?.version ?? null,
      mediaType: record?.mediaType ?? 'application/octet-stream',
      encoding: text ? 'utf8' : 'base64',
      content: content.toString(text ? 'utf8' : 'base64'),
      bytes: content.byteLength,
    },
    [`takt_artifact log path="${target}"`],
  )
}

async function artifactLog(
  caller: BoundCaller,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const pathArg = optionalString(args, 'path')
  const records = await caller.space.stores.workspaces.listArtifacts(caller.requirementId)
  let selected: ArtifactRecord[]
  if (pathArg !== undefined) {
    const target = validateArtifactPathArg(pathArg)
    selected = records.filter((item) => item.path === target)
    if (selected.length === 0) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `产物不存在：${target}`,
        '用 takt_artifact list 查看已有产物。',
      )
    }
  } else {
    selected = records
  }
  const versions = selected.flatMap((record) =>
    record.versions.map((version) => ({
      path: record.path,
      version: version.version,
      sha256: version.sha256,
      size: version.size,
      createdAt: version.createdAt,
      author: version.author,
      reason: version.reason ?? null,
      producedBy: version.producedBy ?? null,
    })),
  )
  versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const limit = 100
  return success(
    `共 ${versions.length} 个版本${versions.length > limit ? `（只显示最近 ${limit} 个）` : ''}`,
    { versions: versions.slice(0, limit), truncated: versions.length > limit },
    ['takt_artifact read path="<产物路径>"'],
  )
}

async function writeArtifact(
  caller: BoundCaller,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const target = assertLeadWritablePath(requiredString(args, 'path'))
  const content = requiredStringAllowEmpty(args, 'content')
  const reason = requiredString(args, 'reason')
  const baseVersion = requiredInteger(args, 'baseVersion', 0)

  await caller.service.ownership.ensureLease(caller.space)
  // CAS 的读版本 + 写入必须在同一把锁里；Lead 的写入路径只有 Lead 会写，
  // 用跨进程文件锁覆盖即可（不能嵌套 core writeArtifact 自带的进程内锁，会死锁）。
  const manifestKey = path.join(
    caller.space.stores.taktDir,
    'workspaces',
    caller.requirementId,
    'manifest.json',
  )
  const written = await withFileLock(manifestKey, async () => {
    const records = await caller.space.stores.workspaces.listArtifacts(caller.requirementId)
    const record = records.find((item) => item.path === target)
    const current = record?.versions.at(-1)?.version ?? 0
    if (current !== baseVersion) {
      throw new TaktToolError(
        'TAKT_STALE_VERSION',
        `产物 ${target} 当前版本是 ${current}，不是 ${baseVersion}`,
        `先 takt_artifact read path="${target}" 读取最新内容，再用 baseVersion=${current} 重试。`,
      )
    }
    return caller.space.stores.workspaces.writeArtifact({
      ref: { workspace: caller.requirementId, path: target },
      content,
      kind: target === LEAD_DECISION_PATH ? 'decision' : 'clarification',
      author: leadActor(caller.agent, caller.human),
      reason,
    })
  })

  const unchanged = baseVersion > 0 && written.version === baseVersion
  return success(
    `已写入 ${target} v${written.version}${unchanged ? '（内容未变化）' : ''}`,
    {
      path: target,
      version: written.version,
      baseVersion,
      unchanged,
      audit: { reason, by: caller.human, actor: leadActor(caller.agent, caller.human) },
    },
    [`takt_artifact read path="${target}"`, 'takt_status'],
  )
}

/**
 * Lead 可写路径白名单：decisions/lead-notes.md 或 clarifications/**。
 *
 * 先过 core 的 assertArtifactPath（绝对路径、`..`、反斜杠、空段、元数据文件），
 * 再拒绝控制字符、空白和百分号编码，避免日志注入与 URL 编码绕过。
 * 文件名允许中文等 Unicode 字符，例如 `clarifications/需求澄清.md`。
 */
export function assertLeadWritablePath(raw: string): string {
  let artifactPath: string
  try {
    artifactPath = assertArtifactPath(raw)
  } catch (error) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
      '路径必须是相对公共存放区的 POSIX 路径，不能是绝对路径、不能包含 .. 或反斜杠。',
    )
  }
  if (artifactPath.includes('%')) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      `产物路径不能包含百分号编码：${oneLine(raw)}`,
      '使用普通路径，不要做 URL 编码。',
    )
  }
  for (const segment of artifactPath.split('/')) {
    if (CONTROL_OR_SPACE.test(segment) || segment === '.' || segment === '..') {
      throw new LeadToolFailure(
        'TAKT_INVALID_INPUT',
        `产物路径段不合法：${oneLine(segment)}`,
        '路径段不能包含控制字符、空白或路径穿越；中文等 Unicode 文件名可以直接使用。',
      )
    }
  }
  const allowed = artifactPath === LEAD_DECISION_PATH
    || (artifactPath.startsWith('clarifications/') && artifactPath.split('/').length >= 2)
  if (!allowed) {
    throw new TaktToolError(
      'TAKT_FORBIDDEN_FOR_LEAD',
      `Lead 不能写 ${artifactPath}`,
      `Lead 只能写 ${LEAD_DECISION_PATH} 和 clarifications/**；其它改动请用 takt_run start 派发，或请人批准后人工修改。`,
    )
  }
  return artifactPath
}

// -------------------------------------------------------------------- takt_run

function taktRunTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_run',
    description: [
      '启动、取消或查看交付运行。start 立即返回 runId，进度由通知器推送。',
      '何时用：需求已绑定且需要推进流程时；用 get 查看节点状态和待办。',
      '何时不用：不要用未支持的 action 绕过审批；cancel 只用于确实要终止的运行。',
      '示例：{"action":"start","requestKey":"run-20261105-01"}',
      '示例：{"action":"get","runId":"run-20261105-0001"}',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        enum: ['start', 'cancel', 'get', 'rerun_from', 'dispatch', 'ask'],
        required: true,
        description: 'P0 支持 start / cancel / get；rerun_from、dispatch、ask 是 P1。',
      },
      workflow: { type: 'string', description: 'start 可选：流程 ID，默认当前空间配置的第一个流程（无空间流程时 p0-delivery）。' },
      requestKey: { type: 'string', description: 'start 必填：稳定幂等键；重试必须相同。' },
      runId: { type: 'string', description: 'cancel 必填；get 可选（不填取最近一次运行）。' },
      args: { type: 'json', description: 'start 可选：传给流程的参数对象。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const action = requiredString(args, 'action')
        const caller = await resolveBoundCaller(exec, deps)
        if (action === 'rerun_from' || action === 'dispatch' || action === 'ask') {
          return p1('takt_run', action)
        }
        if (action === 'start') return await startRun(deps, caller, args)
        if (action === 'cancel') return await cancelRun(deps, caller, args)
        if (action === 'get') return await getRun(caller, args)
        throw invalidAction('takt_run', action, ['start', 'cancel', 'get'])
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

async function startRun(
  deps: ToolDeps,
  caller: BoundCaller,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const requestKey = requestKeyArg(requiredString(args, 'requestKey'))
  const requested = optionalString(args, 'workflow')
  // 省略 workflow 时取当前空间目录的首个流程；旧 catalog 没有 defaultId 时保留 p0 兼容。
  const workflowId = requested ?? (deps.service.workflows.defaultId === undefined
    ? 'p0-delivery'
    : await deps.service.workflows.defaultId(caller.space))
  // 有效目录必须按空间动态读取（list），不能依赖 ids() 的进程内缓存。
  const ids = deps.service.workflows.list === undefined
    ? deps.service.workflows.ids()
    : await deps.service.workflows.list(caller.space)
  if (!ids.includes(workflowId)) {
    throw new TaktToolError(
      'TAKT_UNSUPPORTED_NODE',
      `未知流程：${workflowId}`,
      `可用流程：${formatList(ids)}；请确认流程已在当前空间的 takt.config.json 中配置。`,
    )
  }
  const runArgs = optionalJsonObject(args, 'args') ?? {}
  await deps.service.ownership.ensureLease(caller.space)
  const started = await deps.service.runs.start({
    space: caller.space,
    requirementId: caller.requirementId,
    workflowId,
    args: runArgs,
    ownerSessionId: caller.sessionId,
    requestKey,
  })
  return success(
    `${started.deduped ? '复用' : '已启动'}运行 ${started.runId}`,
    {
      runId: started.runId,
      deduped: started.deduped,
      workflow: workflowId,
      audit: { by: caller.human, actor: leadActor(caller.agent, caller.human) },
    },
    [`takt_run get runId="${started.runId}"`, `takt_trace audit runId="${started.runId}"`],
  )
}

async function cancelRun(
  deps: ToolDeps,
  caller: BoundCaller,
  args: Record<string, unknown>,
): Promise<LeadToolResult> {
  const runId = validateRunIdArg(requiredString(args, 'runId'))
  await ownedRun(caller, runId)
  await deps.service.ownership.ensureLease(caller.space)
  await deps.service.runs.cancel(caller.space, runId, leadActor(caller.agent, caller.human))
  return success(
    `已请求取消运行 ${runId}`,
    {
      runId,
      cancelled: true,
      audit: { by: caller.human, actor: leadActor(caller.agent, caller.human) },
    },
    [`takt_run get runId="${runId}"`],
  )
}

async function getRun(caller: BoundCaller, args: Record<string, unknown>): Promise<LeadToolResult> {
  const runId = optionalString(args, 'runId')
  const state = runId === undefined ? await latestRun(caller) : await ownedRun(caller, runId)
  if (state === undefined) {
    return success(
      `需求 ${caller.requirementId} 还没有运行`,
      { run: null },
      ['takt_run start requestKey="<稳定唯一键>"'],
    )
  }
  const pending = await caller.space.stores.attention.list({
    pending: true,
    requirementId: caller.requirementId,
  })
  const runPending = pending.filter((item) => item.runId === state.runId)
  const runStatus = await runStatusFor(caller.space, state)
  return success(
    `运行 ${state.runId}：${state.status}${runPending.length > 0 ? `；${runPending.length} 条待办` : ''}`,
    {
      run: runSummary(state),
      nodes: nodeDetails(state),
      attention: runPending.map(attentionSummary),
      runStatus,
    },
    runPending.length > 0
      ? runPending.map((item) => `takt_ask_human requestId="${item.requestId}"`)
      : [`takt_trace audit runId="${state.runId}"`],
  )
}

// ------------------------------------------------------------------ takt_trace

function taktTraceTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_trace',
    description: [
      '查看运行审计、逃逸缺陷与归因，以及节点/配方/技能成绩单。',
      '何时用：',
      '- audit：汇报前确认运行事件链完整；',
      '- defects：列出当前需求的缺陷及归因状态；',
      '- why：查某个缺陷的候选归因（auditor 候选）或已确认归因；不传 defectId 时列出歧义候选；',
      '- report：运行中发现需求外的问题，录入逃逸缺陷（必须说明 reason）；',
      '- attribute：为缺陷启动后台归因，立即返回；',
      '- scorecard：空间级成绩单（跨全部需求），按 node/recipe/skill 汇总。',
      '何时不用：不要用 why 猜结论；没有记录先 report；候选归因必须由人确认，模型没有确认通道。',
      '示例：{"action":"defects"}；{"action":"why","defectId":"D-1"}；{"action":"report","title":"…","description":"…","severity":"major","reason":"…"}',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        enum: ['audit', 'defects', 'why', 'report', 'attribute', 'scorecard'],
        required: true,
        description: '要执行的动作。',
      },
      runId: { type: 'string', description: 'audit 必填：要校验的运行 ID。' },
      defectId: { type: 'string', description: 'why/attribute 必填：缺陷 ID，如 D-1。' },
      title: { type: 'string', description: 'report 必填：缺陷标题。' },
      description: { type: 'string', description: 'report 必填：缺陷现象、影响和复现信息。' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'report 必填：严重程度。' },
      reason: { type: 'string', description: 'report 必填：为什么现在录入。' },
      acs: { type: 'array', items: { type: 'string' }, description: 'report 可选：关联的验收标准 ID，如 AC-1。' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'report 可选：证据（日志、复现步骤、截图说明）。' },
      links: { type: 'array', description: 'report 可选：外部链接，元素形如 {"type":"url","url":"…","title":"…"}。' },
      by: { type: 'string', enum: ['node', 'recipe', 'skill'], description: 'scorecard 可选：汇总维度，缺省 node。' },
      workflowId: { type: 'string', description: 'scorecard 可选：只看某个流程。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const action = requiredString(args, 'action')
        const caller = await resolveBoundCaller(exec, deps)
        if (action === 'audit') {
          const runId = validateRunIdArg(requiredString(args, 'runId'))
          await ownedRun(caller, runId)
          const result = await caller.space.stores.events.verify(runId)
          const explained = explainVerify(runId, result)
          return success(
            explained.summary,
            {
              runId,
              verified: result.ok,
              brokenAt: result.brokenAt ?? null,
              reason: result.reason ?? null,
              position: explained.position,
              ...(result.ok
                ? {}
                : { hint: '保留现场：不要手工修改 events.jsonl 或 chain.json；把 brokenAt/reason 交给维护者。' }),
            },
            result.ok
              ? [`takt_run get runId="${runId}"`]
              : [`takt_run get runId="${runId}"`, 'takt_status'],
          )
        }
        if (action === 'defects') return await traceDefects(caller)
        if (action === 'why') return await traceWhy(caller, optionalString(args, 'defectId'))
        if (action === 'report') return await traceReport(caller, args)
        if (action === 'attribute') return await traceAttribute(caller, requiredString(args, 'defectId'))
        if (action === 'scorecard') return await traceScorecard(caller, args)
        return failure(
          'TAKT_UNSUPPORTED_ACTION',
          `takt_trace 不支持 action "${action}"`,
          '使用 audit/defects/why/report/attribute/scorecard。',
        )
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

/**
 * 绑定人的可信身份。
 *
 * report 的 onBehalfOf 必须取绑定记录里的真实人，不能用插件配置的当前用户，
 * 也不能用模型参数；绑定记录缺失时明确失败。
 */
async function boundLeadActor(caller: BoundCaller): Promise<Actor> {
  const bound = await bindingActor(caller.space, caller.requirementId)
  if (bound === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `需求 ${caller.requirementId} 的绑定记录缺少录入人`,
      '重新绑定需求后再录入缺陷；不要用当前配置用户冒充绑定人。',
    )
  }
  return leadActor(caller.agent, bound.id)
}

function requireM3(caller: BoundCaller): M3Service {
  const m3 = caller.service.m3
  if (m3 === undefined) {
    throw new TaktToolError(
      'TAKT_UNSUPPORTED_NODE',
      '当前宿主没有接入 M3 评测/归因服务',
      '通过完整 dsh 宿主加载 taktflow 后再试。',
    )
  }
  return m3
}

/** 归因状态只按持久化数据判定：auditor 候选未确认时不能写成已确认。 */
function attributionState(defect: DefectDetail): 'confirmed' | 'candidate' | 'attributing' | 'none' {
  if (defect.attribution?.confirmed !== undefined) return 'confirmed'
  if (defect.attribution !== undefined) return 'candidate'
  if (defect.attributing === true) return 'attributing'
  return 'none'
}

function summarizeDefect(defect: DefectDetail): Record<string, unknown> {
  return {
    defectId: defect.id,
    title: defect.title,
    severity: defect.severity,
    status: defect.status,
    attributing: defect.attributing === true,
    attributionState: attributionState(defect),
  }
}

async function traceDefects(caller: BoundCaller): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const defects = await m3.listDefects(caller.space, caller.requirementId)
  const items = defects.map(summarizeDefect)
  const counts = { open: 0, attributed: 0, confirmed: 0, closed: 0 }
  for (const defect of defects) counts[defect.status] += 1
  if (defects.length === 0) {
    return success(
      `需求 ${caller.requirementId} 还没有录入缺陷`,
      { requirementId: caller.requirementId, count: 0, counts, defects: [] },
      [
        'takt_trace report title="…" description="…" severity="major" reason="…"',
        'takt_run get',
      ],
    )
  }
  return success(
    `需求 ${caller.requirementId} 共 ${defects.length} 个缺陷（open ${counts.open}、attributed ${counts.attributed}、confirmed ${counts.confirmed}、closed ${counts.closed}）`,
    { requirementId: caller.requirementId, count: defects.length, counts, defects: items },
    [
      `takt_trace why defectId="${defects[0]!.id}"`,
      `takt_trace attribute defectId="${defects[0]!.id}"`,
      'takt_trace report title="…" description="…" severity="major" reason="…"',
    ],
  )
}

async function traceWhy(caller: BoundCaller, defectId: string | undefined): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const defects = await m3.listDefects(caller.space, caller.requirementId)
  if (defectId === undefined) {
    if (defects.length === 0) {
      return success(
        `需求 ${caller.requirementId} 没有缺陷记录；不要从运行状态推测“谁的锅”`,
        { requirementId: caller.requirementId, count: 0, defects: [] },
        ['takt_trace report title="…" description="…" severity="major" reason="…"'],
      )
    }
    if (defects.length === 1) return explainDefectWhy(defects[0]!)
    const items = defects.map((defect) => ({ ...summarizeDefect(defect), hint: whyHint(defect) }))
    return success(
      `需求 ${caller.requirementId} 有 ${defects.length} 个缺陷，请用 defectId 指定要查的缺陷`,
      { requirementId: caller.requirementId, ambiguous: true, count: defects.length, defects: items },
      defects.map((defect) => `takt_trace why defectId="${defect.id}"`),
    )
  }
  const defect = defects.find((entry) => entry.id === defectId)
  if (defect === undefined) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `当前需求没有缺陷 ${defectId}`,
      '用 takt_trace defects 查看当前需求的缺陷；不要引用其它需求的缺陷。',
    )
  }
  return explainDefectWhy(defect)
}

function whyHint(defect: DefectDetail): string {
  switch (attributionState(defect)) {
    case 'confirmed':
      return '归因已由人确认'
    case 'candidate':
      return '有 auditor 候选归因，尚未人工确认'
    case 'attributing':
      return '归因进行中'
    default:
      return '还没有归因，先 takt_trace attribute'
  }
}

function explainDefectWhy(defect: DefectDetail): LeadToolResult {
  const state = attributionState(defect)
  const base = {
    defectId: defect.id,
    title: defect.title,
    severity: defect.severity,
    status: defect.status,
    attributing: defect.attributing === true,
    attributionState: state,
  }
  if (state === 'none' || state === 'attributing' || defect.attribution === undefined) {
    return success(
      state === 'attributing'
        ? `缺陷 ${defect.id} 的归因仍在进行，还没有可确认的候选`
        : `缺陷 ${defect.id} 还没有归因记录；不要凭运行状态猜引入点`,
      base,
      [`takt_trace attribute defectId="${defect.id}"`, `takt_trace why defectId="${defect.id}"`],
    )
  }
  const attribution = defect.attribution
  const confirmed = attribution.confirmed
  const detail = {
    ...base,
    confirmed: confirmed !== undefined,
    by: attribution.by,
    at: attribution.at,
    introducedAt: attribution.introducedAt,
    missedBy: attribution.missedBy,
    confidence: attribution.confidence,
    suggestions: attribution.suggestions,
    precheck: attribution.precheck,
    ...(confirmed === undefined
      ? {}
      : { confirmedBy: confirmed.by, confirmedAt: confirmed.at, note: confirmed.note ?? null, edited: confirmed.edited }),
  }
  if (confirmed !== undefined) {
    return success(
      `缺陷 ${defect.id} 的归因已由人确认（${confirmed.edited ? '人工修改后确认' : '按候选确认'}）`,
      detail,
      [`takt_trace scorecard`, `takt_trace defects`],
    )
  }
  return success(
    `缺陷 ${defect.id} 有 auditor 候选归因（尚未人工确认，不能当结论）`,
    detail,
    [`takt_ask_human defectId="${defect.id}"`, `takt_trace defects`],
  )
}

async function traceReport(caller: BoundCaller, args: Record<string, unknown>): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const title = requiredString(args, 'title')
  const description = requiredString(args, 'description')
  const severity = requiredString(args, 'severity')
  if (severity !== 'critical' && severity !== 'major' && severity !== 'minor') {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', 'severity 只能是 critical/major/minor', '按工具参数枚举传值。')
  }
  const reason = requiredString(args, 'reason')
  const acs = parseStringArray(args.acs, 'acs')
  if (acs !== undefined) {
    const invalid = acs.find((id) => !/^AC-\d+(?:-\d+)?$/.test(id))
    if (invalid !== undefined) {
      throw new LeadToolFailure('TAKT_INVALID_INPUT', `acs 不合法：${invalid}`, '验收标准 ID 形如 AC-1 或 AC-1-2。')
    }
  }
  const evidence = parseStringArray(args.evidence, 'evidence')
  const links = parseLinks(args.links)
  const request: DefectReportRequest = {
    title,
    description,
    severity,
    reason,
    ...(acs === undefined ? {} : { acs }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(links === undefined ? {} : { links }),
  }
  // 身份来自当前绑定 Lead（agent + onBehalfOf）；模型参数不能指定录入人。
  const defect = await m3.report(
    caller.space,
    caller.requirementId,
    request,
    await boundLeadActor(caller),
  )
  return success(
    `已录入缺陷 ${defect.id}（${defect.severity}，${defect.status}）`,
    { defectId: defect.id, title: defect.title, severity: defect.severity, status: defect.status },
    [`takt_trace attribute defectId="${defect.id}"`, `takt_trace why defectId="${defect.id}"`],
  )
}

async function traceAttribute(caller: BoundCaller, defectId: string): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const defect = await m3.attribute(
    caller.space,
    caller.requirementId,
    defectId,
    await boundLeadActor(caller),
  )
  return success(
    `已启动缺陷 ${defectId} 的后台归因，工具立即返回；完成后用 why 查看候选`,
    {
      defectId,
      status: defect.status,
      attributing: defect.attributing === true,
      attributionState: attributionState(defect),
    },
    [`takt_trace why defectId="${defectId}"`, `takt_ask_human defectId="${defectId}"`],
  )
}

async function traceScorecard(caller: BoundCaller, args: Record<string, unknown>): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const by = optionalString(args, 'by') ?? 'node'
  if (by !== 'node' && by !== 'recipe' && by !== 'skill') {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', 'by 只能是 node/recipe/skill', '按工具参数枚举传值。')
  }
  const workflowId = optionalString(args, 'workflowId')
  const entries = await m3.scorecards(caller.space, { by, ...(workflowId === undefined ? {} : { workflowId }) })
  return success(
    `空间级成绩单（跨全部需求，按 ${by} 汇总）：${entries.length} 项${entries.length === 0 ? '；空成绩单不代表缺陷已修复' : ''}`,
    { scope: 'space', requirementId: caller.requirementId, by, workflowId: workflowId ?? null, count: entries.length, entries },
    [
      '在面板评测页对失败用例执行 eval.run（按用例来源运行唯一确定需求）',
      'takt_trace defects',
    ],
  )
}

function explainVerify(
  runId: string,
  result: { ok: boolean; brokenAt?: number; reason?: EventVerifyReason },
): { summary: string; position: { seq: number; file: string } | null } {
  if (result.ok) return { summary: `运行 ${runId} 的事件链完整`, position: null }
  const seq = result.brokenAt
  const position = seq === undefined ? null : { seq, file: 'events.jsonl' }
  switch (result.reason) {
    case 'tampered':
      return { summary: `运行 ${runId} 的事件链在 seq ${seq ?? '?'} 处被篡改`, position }
    case 'truncated':
      return { summary: `运行 ${runId} 的事件日志在 seq ${seq ?? '?'} 之后被截断（链尾锚点更靠后）`, position }
    case 'missing':
      return { summary: `运行 ${runId} 的事件日志缺失，但链尾锚点存在`, position: { seq: 0, file: 'events.jsonl' } }
    case 'incomplete':
      return { summary: `运行 ${runId} 在 seq ${seq ?? '?'} 已追加事件但链尾锚点未更新（追加与更新锚点之间中断）`, position }
    default:
      return { summary: `运行 ${runId} 的事件链校验失败（seq ${seq ?? '?'}）`, position }
  }
}

// -------------------------------------------------------------- takt_ask_human

function taktAskHumanTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_ask_human',
    description: [
      '把一条待办（审批/回答）或缺陷归因确认卡片呈现给人，等待人在卡片上处理。',
      '何时用：takt_status / takt_run get 显示有待办时传 requestId；takt_trace why 显示有候选归因时传 defectId。',
      '何时不用：不要代替人回答；不要用模型参数提交确认或修改；取消/多选/跳过都不算确认。',
      '示例：{"requestId":"run-20261105-0001:design"}；{"defectId":"D-1"}',
    ].join('\n'),
    parameters: {
      requestId: { type: 'string', description: '待办 ID，来自 takt_status / takt_run get；与 defectId 二选一。' },
      defectId: { type: 'string', description: '缺陷 ID；打开原生归因确认卡片，与 requestId 二选一。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw, exec) {
      try {
        const args = asRecord(raw)
        const caller = await resolveBoundCaller(exec, deps)
        const defectId = optionalString(args, 'defectId')
        const requestIdArg = optionalString(args, 'requestId')
        if ((defectId === undefined) === (requestIdArg === undefined)) {
          throw new LeadToolFailure(
            'TAKT_INVALID_INPUT',
            'requestId 与 defectId 必须二选一',
            '处理运行待办传 requestId；确认缺陷归因传 defectId。',
          )
        }
        if (defectId !== undefined) return await confirmDefectCard(caller, defectId, exec)
        const requestId = requestIdArg!
        const items = await caller.space.stores.attention.list()
        const item = items.find((entry) => entry.requestId === requestId)
        if (item === undefined) {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            `待办不存在：${requestId}`,
            '用 takt_status 查看当前待办。',
          )
        }
        if (item.requirementId !== caller.requirementId) {
          throw new TaktToolError(
            'TAKT_NOT_BOUND',
            `待办 ${requestId} 不属于当前需求 ${caller.requirementId}`,
            '只能处理当前绑定需求的待办。',
          )
        }
        if (item.answeredAt !== undefined) {
          return success(
            `待办 ${requestId} 已经回答过`,
            {
              requestId,
              answered: true,
              decision: item.decision ?? null,
              answer: item.answer ?? null,
            },
            [`takt_run get runId="${item.runId}"`],
          )
        }
        await deps.service.approvals.present(exec, caller.space, requestId)
        // present 会等待人回答后才返回；必须重读待办，不能把“卡片已关闭”当成还在等待。
        const after = (await caller.space.stores.attention.list())
          .find((entry) => entry.requestId === requestId)
        if (after === undefined) {
          return success(
            `待办 ${requestId} 已不在待办列表中`,
            { requestId, presented: true, answered: false, missing: true },
            ['takt_status'],
          )
        }
        if (after.answeredAt !== undefined) {
          return success(
            `待办 ${requestId} 已回答`,
            {
              requestId,
              presented: true,
              answered: true,
              decision: after.decision ?? null,
              answer: after.answer ?? null,
            },
            [`takt_run get runId="${item.runId}"`],
          )
        }
        return success(
          `待办 ${requestId} 尚未回答（卡片可能被取消或跳过）`,
          {
            requestId,
            presented: true,
            answered: false,
            pending: true,
            attempt: after.attempt ?? null,
            subjects: after.subjects ?? [],
          },
          [
            `takt_ask_human requestId="${requestId}"`,
            `takt_run get runId="${item.runId}"`,
          ],
        )
      } catch (error) {
        return toFailure(error)
      }
    },
  }
}

/**
 * 缺陷归因确认卡片。
 *
 * 只有 ctx.userQuestions 返回的人工答案会写入确认；模型无法通过工具参数提交
 * 确认或修改。卡片内容与哈希由 M3 服务冻结，人回答后还会重读比对。
 */
async function confirmDefectCard(
  caller: BoundCaller,
  defectId: string,
  exec: ToolExecutionContext,
): Promise<LeadToolResult> {
  const m3 = requireM3(caller)
  const result = await m3.confirmWithCard(exec, caller.space, caller.requirementId, defectId, caller.human)
  if (result.confirmed) {
    return success(
      `已确认缺陷 ${defectId} 的归因`,
      {
        defectId,
        answered: true,
        confirmed: true,
        rejected: false,
        status: result.defect?.status ?? 'confirmed',
        ...(result.defect?.attribution === undefined ? {} : { attribution: result.defect.attribution }),
      },
      [`takt_trace why defectId="${defectId}"`, 'takt_trace scorecard'],
    )
  }
  if (result.rejected) {
    return success(
      `已驳回缺陷 ${defectId} 的候选归因；候选保留，未写入确认状态`,
      { defectId, answered: true, confirmed: false, rejected: true },
      [`takt_trace defects`, `takt_trace attribute defectId="${defectId}"`],
    )
  }
  return success(
    `缺陷 ${defectId} 未确认：${result.message}`,
    { defectId, answered: result.answered, confirmed: false, rejected: false },
    [`takt_ask_human defectId="${defectId}"`, `takt_trace why defectId="${defectId}"`],
  )
}

// ---------------------------------------------------------------- 结果与工具函数

export function success(
  summary: string,
  fields: Record<string, unknown>,
  nextActions: string[],
): LeadToolResult {
  // 固定字段放在最后：业务字段即使重名也不能把工具调用结果改成失败。
  return {
    ...fields,
    ok: true,
    summary: oneLine(summary),
    next_actions: nextActions.map(oneLine),
  }
}

export function failure(code: LeadErrorCode, message: string, hint?: string): LeadToolResult {
  const cleanMessage = oneLine(message) || '操作失败'
  const cleanHint = oneLine(hint ?? '') || defaultHint(code)
  return {
    ok: false,
    summary: `失败：${cleanMessage}`,
    next_actions: [defaultNextAction(code)],
    error: { code, message: cleanMessage, hint: cleanHint },
  }
}

/** 已知错误码白名单；用于识别其它 bundle 里抛出的 TaktToolError。 */
const TAKT_ERROR_CODES: ReadonlySet<string> = new Set<LeadErrorCode>([
  'TAKT_NO_SPACE',
  'TAKT_SPACE_ROOT_MISMATCH',
  'TAKT_NOT_BOUND',
  'TAKT_LEASE_HELD',
  'TAKT_RUN_BUSY',
  'TAKT_STALE_VERSION',
  'TAKT_FORBIDDEN_FOR_LEAD',
  'TAKT_UNSUPPORTED_NODE',
  'TAKT_INVALID_INPUT',
  'TAKT_UNSUPPORTED_ACTION',
  'TAKT_INTERNAL',
])

/**
 * 识别错误对象。
 *
 * host 与 lead 可能各自打包一份 TaktToolError 类，不能只靠 instanceof；
 * 这里按“Error 实例 + 已知 code 白名单”识别跨 bundle 错误，避免把
 * TAKT_LEASE_HELD 误判成 TAKT_RUN_BUSY 或内部错误。
 */
function taktErrorOf(error: unknown): { code: LeadErrorCode; message?: string; hint?: string } | undefined {
  if (error instanceof TaktToolError) return { code: error.code, message: error.message, hint: error.hint }
  if (error instanceof LeadToolFailure) return { code: error.code, message: error.message, hint: error.hint }
  if (!(error instanceof Error)) return undefined
  const code = (error as Error & { code?: unknown }).code
  if (typeof code !== 'string' || !TAKT_ERROR_CODES.has(code)) return undefined
  const hint = (error as Error & { hint?: unknown }).hint
  return {
    code: code as LeadErrorCode,
    message: error.message,
    ...(typeof hint === 'string' ? { hint } : {}),
  }
}

export function toFailure(error: unknown): LeadToolResult {
  const known = taktErrorOf(error)
  if (known !== undefined) return failure(known.code, known.message ?? '', known.hint)
  // 未知异常不把原始 message/stack 交给模型：可能包含路径、密钥或内部实现。
  return failure(
    'TAKT_INTERNAL',
    '操作失败：内部错误',
    '先 takt_status 确认空间与绑定；如果持续失败，请把工具名和时间点交给维护者。',
  )
}

function defaultHint(code: LeadErrorCode): string {
  switch (code) {
    case 'TAKT_NO_SPACE':
      return '当前目录还不是空间：用 takt_requirement action="init" 在当前会话目录初始化。'
    case 'TAKT_SPACE_ROOT_MISMATCH':
      return '会话工作目录必须是空间根；子目录或其它根请切回正确目录。'
    case 'TAKT_NOT_BOUND':
      return '先用 takt_status 确认空间与绑定，再执行 create/bind。'
    case 'TAKT_LEASE_HELD':
      return '空间被另一个宿主占用；等它释放或由人在主面板处理。'
    case 'TAKT_RUN_BUSY':
      return '当前运行还没结束；用 takt_run get 查看状态。'
    case 'TAKT_STALE_VERSION':
      return '先读取最新版本，再用最新的 baseVersion 重试。'
    case 'TAKT_FORBIDDEN_FOR_LEAD':
      return 'Lead 只能写决策与澄清文件；其它改动走运行或人工。'
    case 'TAKT_UNSUPPORTED_NODE':
      return '从 takt_status 返回的可用流程里选择。'
    case 'TAKT_INVALID_INPUT':
      return '按工具 description 里的参数说明和示例修正。'
    case 'TAKT_UNSUPPORTED_ACTION':
      return 'P0 只开放工具参数里列出的 action。'
    case 'TAKT_INTERNAL':
      return '先重试；持续失败请联系维护者。'
  }
}

function defaultNextAction(code: LeadErrorCode): string {
  switch (code) {
    case 'TAKT_NO_SPACE':
      return 'takt_requirement action="init"（在当前会话目录初始化空间）'
    case 'TAKT_SPACE_ROOT_MISMATCH':
      return '把会话工作目录切到包含 takt.config.json 的空间根，再调用 takt_status'
    case 'TAKT_NOT_BOUND':
      return 'takt_status；未绑定则用 takt_requirement create title="…" requestKey="…" 或 bind requirementId="REQ-001"'
    case 'TAKT_LEASE_HELD':
      return 'takt_status 确认租约；等占用结束或在主面板释放后重试'
    case 'TAKT_RUN_BUSY':
      return 'takt_run get（查看当前运行状态），等运行结束后再操作'
    case 'TAKT_STALE_VERSION':
      return 'takt_artifact read path="…"（读取最新版本后带新的 baseVersion 重试）'
    case 'TAKT_FORBIDDEN_FOR_LEAD':
      return 'takt_run start requestKey="…" 派发，或请人批准后由人工修改'
    case 'TAKT_UNSUPPORTED_NODE':
      return 'takt_status（查看可用流程），再用 takt_run start workflow="<可用流程>"'
    case 'TAKT_INVALID_INPUT':
      return '按错误提示修正参数后重试（示例见工具 description）'
    case 'TAKT_UNSUPPORTED_ACTION':
      return '改用该工具 P0 支持的 action，例如 takt_artifact list'
    case 'TAKT_INTERNAL':
      return '先 takt_status 确认空间与绑定；持续失败请报告工具名和时间点'
  }
}

/** 工具结果对外只保留单行文本，防止标题或异常里的换行破坏渲染。 */
function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()
}

/** 非冻结错误码（参数/未支持/内部）用独立错误类，避免污染 TaktErrorCode。 */
class LeadToolFailure extends Error {
  readonly code: LeadErrorCode
  readonly hint?: string

  constructor(code: LeadErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'LeadToolFailure'
    this.code = code
    this.hint = hint
  }
}

function p1(tool: string, action: string): LeadToolResult {
  return {
    ok: false,
    summary: `${tool}.${action} 在 P1 才支持`,
    error: {
      code: 'TAKT_UNSUPPORTED_ACTION',
      message: `${tool} 的 action "${action}" 不在 P0 范围`,
      hint: 'P0 只开放工具参数里列出的 action；不要用未支持的 action 绕过权限。',
    },
    next_actions: [`改用 ${tool} 的 P0 action`],
  }
}

function invalidAction(tool: string, action: string, supported: readonly string[]): LeadToolFailure {
  return new LeadToolFailure(
    'TAKT_INVALID_INPUT',
    `${tool} 不支持 action "${action}"`,
    `P0 支持的 action：${supported.join('、')}。`,
  )
}

/**
 * 工具渲染：一行摘要 + 完整结构化 JSON。
 *
 * dsh ToolRuntime 保存并送模型的是 render 的 content，而不是 execute 的 canonical
 * value；只给摘要会让模型拿不到 requestId / next_actions / error.hint。JSON 放在
 * 独立的 text block，模型与验收脚本都能直接解析。
 */
export function renderResult(_args: unknown, value: JsonValue): ContentBlock[] {
  const summary = isRecord(value) && typeof value.summary === 'string'
    ? value.summary
    : 'taktflow 工具已完成'
  const blocks: ContentBlock[] = [{ type: 'text', text: oneLine(summary) || 'taktflow 工具已完成' }]
  try {
    blocks.push({ type: 'text', text: JSON.stringify(value, null, 2) })
  } catch {
    // execute 的返回值本应始终可 JSON 序列化；极端情况下保留摘要，不让渲染失败。
  }
  return blocks
}

// ---------------------------------------------------------------- 参数与数据

export function asRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', '参数必须是对象', '按工具 description 里的示例传参。')
  }
  return raw
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必须是非空字符串`, '按工具 description 里的示例传参。')
  }
  return value
}

function requiredStringAllowEmpty(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必须是字符串`, '按工具 description 里的示例传参。')
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必须是非空字符串`, '不使用时不要传该字段。')
  }
  return value
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必须是 >= ${min} 的整数`, '版本号从 0 或 1 开始。')
  }
  return value
}

function requiredInteger(args: Record<string, unknown>, key: string, min: number): number {
  const value = optionalInteger(args, key, min)
  if (value === undefined) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必填`, 'write 需要 baseVersion；新建时传 0。')
  }
  return value
}

function optionalJsonObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `参数 ${key} 必须是对象`, '流程参数用 JSON 对象传入。')
  }
  return value
}

function requestKeyArg(value: string): string {
  try {
    return assertRequestKey(value)
  } catch (error) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
      'requestKey 用字母或数字开头，只含字母、数字、点、下划线、冒号和短横线。',
    )
  }
}

function validateRequirementIdArg(value: string): string {
  try {
    return assertRequirementId(value)
  } catch (error) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
      '需求 ID 以字母或数字开头，只含字母、数字、点、下划线和短横线。',
    )
  }
}

function validateRunIdArg(value: string): string {
  try {
    return assertRunId(value)
  } catch (error) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
      '运行 ID 由宿主生成，不要手写；从 takt_status 或 takt_run get 的结果里取。',
    )
  }
}

function validateArtifactPathArg(value: string): string {
  try {
    return assertArtifactPath(value)
  } catch (error) {
    throw new LeadToolFailure(
      'TAKT_INVALID_INPUT',
      error instanceof Error ? error.message : String(error),
      '路径必须是相对公共存放区的 POSIX 路径，不能是绝对路径、不能包含 .. 或反斜杠。',
    )
  }
}

function parseLinks(value: unknown): ExternalLink[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', 'links 必须是数组', '元素形如 {"type":"url","url":"https://…"}。')
  }
  return value.map((item, index) => {
    if (!isRecord(item)
      || typeof item.type !== 'string'
      || item.type.trim() === ''
      || typeof item.url !== 'string'
      || item.url.trim() === '') {
      throw new LeadToolFailure(
        'TAKT_INVALID_INPUT',
        `links[${index}] 不合法`,
        '每个元素至少包含非空 type 和 url 字符串。',
      )
    }
    const link: ExternalLink = { type: item.type, url: item.url }
    if (typeof item.title === 'string' && item.title !== '') link.title = item.title
    return link
  })
}

/** 可选字符串数组；用于缺陷 acs/evidence，元素必须非空。 */
function parseStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new LeadToolFailure('TAKT_INVALID_INPUT', `${key} 必须是数组`, '元素为非空字符串。')
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new LeadToolFailure('TAKT_INVALID_INPUT', `${key}[${index}] 必须是非空字符串`, '不要传空元素。')
    }
    return item
  })
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '（无）' : values.join('、')
}

function isTerminal(status: RunState['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function requirementMatches(
  requirement: Requirement,
  title: string,
  links: readonly ExternalLink[] | undefined,
): boolean {
  if (requirement.title !== title) return false
  return canonicalJson(requirement.links ?? []) === canonicalJson(links ?? [])
}

/** pending 账本恢复时核对需求内容，避免把别人的同 ID 需求当成自己的。 */
function assertRequirementMatches(
  requirement: Requirement,
  title: string,
  links: readonly ExternalLink[] | undefined,
): void {
  if (requirementMatches(requirement, title, links)) return
  throw new LeadToolFailure(
    'TAKT_INVALID_INPUT',
    `需求 ${requirement.id} 已存在，但标题/链接与 requestKey 记录不一致`,
    '换一个 requestKey 重新创建，或改用 takt_requirement bind 绑定已有需求。',
  )
}

function requirementSummary(requirement: Requirement): Record<string, unknown> {
  return {
    id: requirement.id,
    title: requirement.title,
    status: requirement.status,
    stage: requirement.stage ?? null,
    owner: requirement.owner ?? null,
    updatedAt: requirement.updatedAt,
  }
}

function artifactSummary(record: ArtifactRecord): Record<string, unknown> {
  const latest = record.versions.at(-1)
  return {
    path: record.path,
    kind: record.kind,
    title: record.title ?? null,
    versions: record.versions.length,
    latestVersion: latest?.version ?? 0,
    updatedAt: latest?.createdAt ?? null,
  }
}

/**
 * takt_status / takt_run get 的运行增量视图。
 *
 * 旧运行可能没有 workflow 快照（helper 会明确抛错），只读工具不能让整条状态
 * 失败：此时保留旧字段并给出可见警告。AI 处理中标记与升级原因都来自真实
 * 持久化状态（进程内 claim 标记 / 决策产物），不按运行模式猜测。
 */
async function runStatusFor(space: SpaceHandle, state: RunState): Promise<RunStatusReport | { error: string }> {
  try {
    return await buildRunStatus(space, state, {
      isAiHandling: (item) => isAutonomyAnswering(space.root, item.requestId),
      getEscalation: (item) => escalationForRequest(space, item),
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function runSummary(state: RunState): Record<string, unknown> {
  let running = 0
  let waiting = 0
  let failed = 0
  let succeeded = 0
  let blocked = 0
  let stale = 0
  let skipped = 0
  let cancelled = 0
  for (const node of Object.values(state.nodes)) {
    switch (node.status) {
      case 'running': running += 1; break
      case 'waiting_human': waiting += 1; break
      case 'failed': failed += 1; break
      case 'succeeded': succeeded += 1; break
      case 'blocked': blocked += 1; break
      case 'stale': stale += 1; break
      case 'skipped': skipped += 1; break
      case 'cancelled': cancelled += 1; break
      default: break
    }
  }
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    status: state.status,
    startedAt: state.startedAt,
    endedAt: state.endedAt ?? null,
    nodes: {
      total: Object.keys(state.nodes).length,
      running,
      waiting_human: waiting,
      failed,
      succeeded,
      blocked,
      stale,
      skipped,
      cancelled,
    },
  }
}

function nodeDetails(state: RunState): Array<Record<string, unknown>> {
  return Object.values(state.nodes)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => ({
      id: node.id,
      status: node.status,
      attempts: node.attempts,
      error: node.error ?? null,
      sessionId: node.sessionRef?.sessionId ?? null,
    }))
}

function attentionSummary(item: AttentionItem): Record<string, unknown> {
  return {
    requestId: item.requestId,
    runId: item.runId,
    nodeId: item.nodeId,
    ask: item.ask,
    form: item.form,
    attempt: item.attempt ?? null,
    subjects: item.subjects ?? [],
  }
}

async function leaseInfo(
  service: TaktflowService,
  space: SpaceHandle,
): Promise<Record<string, unknown>> {
  try {
    const lease = await readLease(space.stores.taktDir)
    if (lease === undefined) return { held: false }
    return {
      held: true,
      owner: lease.owner,
      host: lease.host,
      heartbeatAt: lease.heartbeatAt,
      ttlMs: lease.ttlMs,
      mine: lease.owner === service.ownership.hostOwner,
    }
  } catch {
    // 租约文件损坏的原始异常可能包含本机路径，只给稳定的诊断结论。
    return { held: false, error: '读取租约状态失败' }
  }
}

async function latestRun(caller: BoundCaller): Promise<RunState | undefined> {
  const runs = await caller.space.stores.runs.list({ requirementId: caller.requirementId })
  return runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

async function ownedRun(caller: BoundCaller, runIdRaw: string): Promise<RunState> {
  const runId = validateRunIdArg(runIdRaw)
  const state = await caller.space.stores.runs.get(runId)
  if (state === undefined || state.requirementId !== caller.requirementId) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      `运行 ${runId} 不存在或不属于当前需求`,
      '只能操作当前绑定需求的运行；用 takt_status 查看最近运行。',
    )
  }
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
