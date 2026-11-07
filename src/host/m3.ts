import {
  canonicalJson, getDefect as readDefect, listDefects as readDefects, listEvalCases,
  requireRole, scorecards as readScorecards, sha256, waitDefectAttribution, waitEvalRun,
  type Actor, type CommandRegistry, type CommandRunResponse, type DefectConfirmRequest,
  type DefectDetail, type DefectReportRequest, type EvalTarget, type NodeScorecard,
  type ProjectStores, type ScorecardOptions,
} from '@taktflow/core'
import { auditSpace, projectCommands, type WriteLease } from '@taktflow/server'
import { bindingActor } from './bindings.js'
import type { HostContext, ToolExecutionContext } from './dsh-types.js'
import { createM3RuntimeFactory, requireM3Lead, type M3Engine } from './m3-runtime.js'
import { TaktToolError, type Bindings, type Ownership, type PermissionRegistry, type RolePresets, type SpaceHandle, type SpaceRegistry } from './types.js'

export const DEFECT_CONFIRM_LABEL = '确认候选归因'
export const DEFECT_EDIT_LABEL = '修改后确认'
export const DEFECT_REJECT_LABEL = '驳回候选'
/** 输入错误沿用工具的 TAKT_INVALID_INPUT，不扩充冻结宿主错误码。 */
export class M3InputError extends Error { readonly code = 'TAKT_INVALID_INPUT'; constructor(message: string, readonly hint?: string) { super(message); this.name = 'M3InputError' } }
/** Lead 工具在原生卡片结束后读取；answered 不代表确认，只有 confirmed 表示已人工落账。 */
export interface DefectCardResult { answered: boolean; confirmed: boolean; rejected: boolean; stale?: boolean; defect?: DefectDetail; message: string }
/** 宿主初始化时注入的可信依赖；不接受模型输入替代身份、绑定或租约服务。 */
export interface M3ServiceDeps {
  ctx: HostContext; spaces: Pick<SpaceRegistry, 'open'>; ownership: Ownership; presets: RolePresets
  permissions: PermissionRegistry; bindings: Bindings; log?: (message: string) => void
}
/**
 * Lead 工具及面板在绑定需求后调用的共享 M3 入口。
 * 写入共用身份、租约和并发守卫；无权、失租、过期卡片或非法输入明确失败。
 * attribute 只返回后台启动结果，最终归因以持久化记录及通知为准；dispose 等待收尾，
 * 清理失败抛错，调用方不能继续声称安全释放了租约。
 */
export interface M3Service {
  getCommands(stores: ProjectStores): CommandRegistry
  report(space: SpaceHandle, requirementId: string, request: DefectReportRequest, by: Actor): Promise<DefectDetail>
  attribute(space: SpaceHandle, requirementId: string, defectId: string, by: Actor): Promise<DefectDetail>
  confirmWithCard(exec: ToolExecutionContext, space: SpaceHandle, requirementId: string, defectId: string, human: string): Promise<DefectCardResult>
  listDefects(space: SpaceHandle, requirementId: string): Promise<DefectDetail[]>
  getDefect(space: SpaceHandle, requirementId: string, defectId: string): Promise<DefectDetail>
  scorecards(space: SpaceHandle, options: ScorecardOptions): Promise<NodeScorecard[]>
  cancelSpace(space: SpaceHandle): Promise<void>
  dispose(): Promise<void>
}

/** 宿主加载时创建；后台任务持有自己的缺陷守卫，关闭必须等待 core 收尾。 */
export function createM3Service(deps: M3ServiceDeps): M3Service {
  const shutdown = new AbortController()
  const stoppedSpaces = new Set<string>()
  const guards = new Map<string, symbol>()
  const engines = new Map<M3Engine, string>()
  const jobs = new Set<Promise<unknown>>()
  const failures: unknown[] = []
  const runtime = createM3RuntimeFactory({ ...deps, shutdown: shutdown.signal,
    beforeWrite: async (space) => { assertOpen(space.stores); await deps.ownership.ensureLease(space); assertOpen(space.stores) },
  })
  function assertOpen(stores: ProjectStores): void {
    shutdown.signal.throwIfAborted()
    if (stoppedSpaces.has(stores.projectDir)) throw new TaktToolError('TAKT_LEASE_HELD', 'M3 空间租约已丢失，请重新加载宿主后重试')
  }
  function claim(stores: ProjectStores, req: string, id: string): () => void {
    assertOpen(stores)
    const key = guardKey(stores, req, id)
    if (guards.has(key)) throw new TaktToolError('TAKT_RUN_BUSY', '该缺陷正在归因或确认，请稍后重试')
    const token = Symbol(id); guards.set(key, token)
    return () => { if (guards.get(key) === token) guards.delete(key) }
  }
  const withWriteLease: WriteLease = async (stores, task) => {
    assertOpen(stores)
    await deps.ownership.ensureLease(await deps.spaces.open(stores.projectDir))
    assertOpen(stores)
    return task()
  }
  async function release(engine: M3Engine): Promise<void> {
    try { await engine.dispose() } finally { engines.delete(engine) }
  }
  function background(task: Promise<unknown>): void {
    jobs.add(task)
    void task.catch((error: unknown) => { failures.push(error); deps.log?.(`M3 后台收尾失败：${errorMessage(error)}`) })
      .finally(() => jobs.delete(task))
  }
  async function reject(stores: ProjectStores, id: string, input: Record<string, unknown>, context: { actor: Actor; reason?: string }, message: string): Promise<CommandRunResponse> {
    requireRole(stores, context.actor, 'member', id)
    if (!context.reason?.trim()) return { ok: false, message: '写操作必须说明原因' }
    await withWriteLease(stores, () => auditSpace(stores, context.actor, context.reason!, JSON.stringify({ id, input, phase: 'finished', response: { ok: false, message } })))
    return { ok: false, message }
  }
  function getCommands(stores: ProjectStores): CommandRegistry {
    const base = projectCommands(stores, {}, undefined, withWriteLease)
    return { list: () => base.list(), async run(id, input, context, lease) {
      try {
        assertOpen(stores)
        if (id === 'defect.confirm') return await confirm(stores, base, input, context, lease)
        if (id !== 'defect.attribute' && id !== 'eval.run') return await base.run(id, input, context, lease)
        requireRole(stores, context.actor, 'member', id)
        if (!context.reason?.trim()) return { ok: false, message: '写操作必须说明原因' }
        const requirementId = id === 'eval.run' ? await resolveEvalRequirement(stores, input) : textValue(input.requirementId)
        const defectId = textValue(input.defectId)
        if (!requirementId || (id === 'defect.attribute' && !defectId)) return reject(stores, id, input, context, '缺少 requirementId 或 defectId')
        const unlock = id === 'defect.attribute' ? claim(stores, requirementId, defectId!) : () => {}
        let engine: M3Engine | undefined
        let published = false
        try {
          const space = await deps.spaces.open(stores.projectDir)
          await deps.ownership.ensureLease(space)
          engine = await runtime.create(space, requirementId, id === 'eval.run' ? 'eval' : 'attribute')
          engines.set(engine, space.root)
          // 必须把受保护的 stores 作为第一参数；projectCommands 会覆盖 runtime.stores。
          const commands = projectCommands(engine.deps.stores, {}, engine.deps, withWriteLease)
          const response = await commands.run(id, input, context, lease)
          if (!response.ok) return response
          const held = engine
          let wait: Promise<unknown>
          if (id === 'eval.run') {
            const runId = evalRunId(response.result)
            if (!runId) throw new Error('M3 没有返回评测运行身份')
            held.bindEval(runId)
            wait = waitEvalRun(stores, runId)
          } else wait = waitDefectAttribution(stores, requirementId, defectId!)
          published = true
          background(wait.finally(async () => { try { await release(held) } finally { unlock() } }))
          return response
        } finally {
          if (!published) { try { if (engine) await release(engine) } finally { unlock() } }
        }
      } catch (error) { return { ok: false, message: errorMessage(error) } }
    } }
  }
  async function confirm(stores: ProjectStores, base: CommandRegistry, input: Record<string, unknown>, context: { actor: Actor; reason?: string },
    lease?: Parameters<CommandRegistry['run']>[3], frozenHash?: string, revalidate?: () => Promise<void>): Promise<CommandRunResponse> {
    const req = textValue(input.requirementId), id = textValue(input.defectId)
    if (!req || !id) return reject(stores, 'defect.confirm', input, context, '缺少 requirementId 或 defectId')
    if (context.actor.type !== 'human') return reject(stores, 'defect.confirm', input, context, '缺陷归因必须由人确认')
    const unlock = claim(stores, req, id)
    try {
      const space = await deps.spaces.open(stores.projectDir)
      await deps.ownership.ensureLease(space)
      await revalidate?.()
      assertOpen(stores)
      const current = await fresh(space, req, id, frozenHash)
      if (current.attributing) throw new TaktToolError('TAKT_RUN_BUSY', '归因仍在进行，不能确认旧候选')
      await revalidate?.()
      // core 在校验后仍有异步写入；每次写入前再次校验卡片身份、取消和租约。
      const checkWrite = async () => { await deps.ownership.ensureLease(space); await revalidate?.(); assertOpen(stores) }
      const workspaces = Object.create(stores.workspaces) as typeof stores.workspaces
      workspaces.writeArtifact = async (value) => { await checkWrite(); return stores.workspaces.writeArtifact(value) }
      const events = Object.create(stores.events) as typeof stores.events
      events.append = (async (runId: string, event: Parameters<typeof stores.events.append>[1]) => {
        await checkWrite(); return stores.events.append(runId, event)
      }) as typeof stores.events.append
      return await projectCommands({ ...stores, workspaces, events }, {}, undefined, withWriteLease)
        .run('defect.confirm', input, context, lease)
    } finally { unlock() }
  }
  async function fresh(space: SpaceHandle, req: string, id: string, hash?: string): Promise<DefectDetail> {
    const current = await readDefect(space.stores, req, id)
    if (current.attributing || current.status !== 'attributed' || !current.attribution || current.attribution.confirmed
      || (hash !== undefined && attributionHash(current) !== hash)) throw new TaktToolError('TAKT_STALE_VERSION', '缺陷状态或候选归因已变化，卡片已过期')
    return current
  }
  async function assertLeadActor(space: SpaceHandle, req: string, by: Actor): Promise<void> {
    const human = await bindingActor(space, req)
    if (by.type !== 'agent' || by.role !== 'lead' || by.harness !== 'dsh-host' || !human || by.onBehalfOf !== human.id) {
      throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', 'Lead 必须以 agent 身份代表当前绑定人操作')
    }
    await requireM3Lead(deps, space, req)
  }
  async function report(space: SpaceHandle, req: string, request: DefectReportRequest, by: Actor): Promise<DefectDetail> {
    await assertLeadActor(space, req, by)
    if (!request.reason?.trim()) throw new M3InputError('录入缺陷必须填写 reason')
    const { reason, ...input } = request
    const result = await getCommands(space.stores).run('defect.report', { ...input, requirementId: req }, { actor: by, reason })
    if (!result.ok) throw new M3InputError(result.message)
    return result.result as DefectDetail
  }
  async function attribute(space: SpaceHandle, req: string, id: string, by: Actor): Promise<DefectDetail> {
    await assertLeadActor(space, req, by)
    const result = await getCommands(space.stores).run('defect.attribute', { requirementId: req, defectId: id }, { actor: by, reason: 'Lead 发起缺陷归因' })
    if (!result.ok) throw new M3InputError(result.message)
    return result.result as DefectDetail
  }
  async function confirmWithCard(exec: ToolExecutionContext, space: SpaceHandle, req: string, id: string, _human: string): Promise<DefectCardResult> {
    const signal = AbortSignal.any([exec.signal, shutdown.signal])
    const agent = exec.agent
    if (!agent) throw new TaktToolError('TAKT_NOT_BOUND', '卡片缺少 Lead 身份')
    await requireM3Lead(deps, space, req, agent)
    const bound = await bindingActor(space, req)
    if (!bound) throw new TaktToolError('TAKT_NOT_BOUND', '需求缺少绑定人')
    const revalidate = async () => {
      signal.throwIfAborted(); assertOpen(space.stores)
      await requireM3Lead(deps, space, req, agent)
      if ((await bindingActor(space, req))?.id !== bound.id) throw new TaktToolError('TAKT_STALE_VERSION', '卡片绑定人已变化')
      signal.throwIfAborted()
    }
    const questions = deps.ctx.get<HostContext['userQuestions']>('userQuestions') ?? deps.ctx.userQuestions
    if (!questions) throw new TaktToolError('TAKT_NOT_BOUND', '宿主没有原生问题卡片服务')
    await deps.ownership.ensureLease(space)
    const current = await fresh(space, req, id)
    const hash = attributionHash(current), question = buildDefectQuestion(current, hash)
    await revalidate()
    const result = await questions.ask({ questions: [question], agent, signal })
    await revalidate()
    const answer = result.answers.find((entry) => entry.id === question.id)
    const selected = answer?.selected.map((value) => value.trim()).filter(Boolean) ?? []
    if (selected.length !== 1) return { answered: false, confirmed: false, rejected: false, message: '取消、空回答或多选均未确认' }
    const choice = selected[0], custom = answer?.custom?.trim() ?? ''
    if (choice === DEFECT_REJECT_LABEL) {
      const unlock = claim(space.stores, req, id)
      try {
        await deps.ownership.ensureLease(space); await revalidate(); await fresh(space, req, id, hash)
        requireRole(space.stores, humanActor(bound.id), 'member', 'defect.reject')
        await revalidate()
        await space.stores.events.append(`defect-${req}`, { type: 'log', actor: humanActor(bound.id),
          data: { level: 'info', message: JSON.stringify({ action: 'defect.reject', defectId: id, hash, reason: custom || '人工驳回候选归因' }) } })
      } finally { unlock() }
      return { answered: true, confirmed: false, rejected: true, message: '已记录人工驳回，候选保留且未确认' }
    }
    if (choice !== DEFECT_CONFIRM_LABEL && choice !== DEFECT_EDIT_LABEL) return { answered: false, confirmed: false, rejected: false, message: '未知选项，未确认' }
    const request = choice === DEFECT_EDIT_LABEL ? parseHumanEdit(custom) : { note: `人工确认候选归因（${hash.slice(0, 12)}）${custom ? `：${custom}` : ''}` }
    const response = await confirm(space.stores, projectCommands(space.stores, {}, undefined, withWriteLease),
      { requirementId: req, defectId: id, ...request }, { actor: humanActor(bound.id), reason: request.note ?? '人工确认归因' }, undefined, hash, revalidate)
    if (!response.ok) throw new M3InputError(response.message)
    return { answered: true, confirmed: true, rejected: false, defect: response.result as DefectDetail, message: `已确认缺陷 ${id} 的归因` }
  }
  async function cancelSpace(space: SpaceHandle): Promise<void> {
    stoppedSpaces.add(space.root)
    const outcomes = await Promise.allSettled([...engines].filter(([, root]) => root === space.root).map(([engine]) => release(engine)))
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason)
  }
  async function dispose(): Promise<void> {
    shutdown.abort()
    const outcomes = await Promise.allSettled([runtime.dispose(), ...jobs])
    const errors = [...failures, ...outcomes.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map((value) => value.reason)]
    if (errors.length) throw new AggregateError(errors, 'M3 后台执行或清理失败')
  }
  return { getCommands, report, attribute, confirmWithCard,
    listDefects: (space, req) => readDefects(space.stores, req), getDefect: (space, req, id) => readDefect(space.stores, req, id),
    scorecards: (space, options) => readScorecards(space.stores, options), cancelSpace, dispose,
  }
}
/**
 * eval.run 的归属解析：选中用例的 source.runId 必须唯一指向一个需求。
 *
 * 不能广播到整个空间，也不能按第一个运行猜；多来源/无来源明确拒绝并提示补归属。
 */
export async function resolveEvalRequirement(stores: ProjectStores, input: Record<string, unknown>): Promise<string> {
  const target = input.target
  if (!isRecord(target) || (target.kind !== 'node' && target.kind !== 'skill')) {
    throw new Error('eval.run 需要合法的 target（node 或 skill）')
  }
  const caseIds = input.caseIds
  if (caseIds !== undefined && (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== 'string'))) {
    throw new Error('caseIds 必须是字符串数组')
  }
  const cases = await listEvalCases(stores, target as unknown as EvalTarget)
  const selected = caseIds === undefined ? cases : cases.filter((value) => (caseIds as string[]).includes(value.id))
  if (selected.length === 0) {
    throw new Error(caseIds === undefined ? '没有匹配的评测用例' : '选中的评测用例不存在')
  }
  const requirements = new Set<string>()
  for (const value of selected) {
    if (value.source.runId === undefined) {
      throw new Error(`评测用例 ${value.id} 没有来源运行，无法确定归属需求；请先补归属后再运行`)
    }
    const run = await stores.runs.get(value.source.runId)
    if (run === undefined) throw new Error(`评测用例 ${value.id} 的来源运行不存在：${value.source.runId}`)
    requirements.add(run.requirementId)
  }
  if (requirements.size !== 1) {
    throw new Error(`选中的评测用例来自多个需求（${[...requirements].join('、')}），请按需求分开运行`)
  }
  return [...requirements][0]!
}

/** 卡片冻结的归因身份；确认前后必须完全一致。 */
export function attributionHash(defect: DefectDetail): string {
  return sha256(canonicalJson({
    requirementId: defect.requirementId,
    defectId: defect.id,
    status: defect.status,
    attribution: defect.attribution ?? null,
  }))
}

/** 卡片内容只来自当前持久化候选归因；不把模型参数拼进人可确认的内容。 */
function buildDefectQuestion(defect: DefectDetail, hash: string): import('./dsh-types.js').UserQuestion {
  const attribution = defect.attribution!
  const introduced = attribution.introducedAt
  const missed = attribution.missedBy
  const lines = [
    `缺陷：${defect.id} ${defect.title}（${defect.severity}）`,
    `需求：${defect.requirementId}`,
    `归因哈希：${hash.slice(0, 12)}`,
    `引入环节：${introduced.origin}${introduced.runId === undefined ? '' : `；运行 ${introduced.runId}`}${introduced.nodeId === undefined ? '' : `；节点 ${introduced.nodeId}`}${introduced.artifact === undefined ? '' : `；产物 ${introduced.artifact.path} v${introduced.artifact.version}`}`,
    `引入证据：${introduced.evidence.join('；')}`,
    `漏检环节：${missed.length === 0 ? '（无）' : missed.map((item) => `${item.nodeId}（${item.reason}）：${item.evidence.join("；")}`).join('；')}`,
    `置信度：${attribution.confidence}`,
    `改进建议：${attribution.suggestions.length === 0 ? '（无）' : attribution.suggestions.map((item) => `${item.target.kind}:${item.target.ref} → ${item.change}`).join('；')}`,
    '确认后：候选归因写入 confirmed，并生成评测用例。',
    `修改后确认：请在自定义回答里填写 JSON，例如 {"note":"修改原因","suggestions":[{"target":{"kind":"prompt","ref":"design"},"change":"补充边界"}]}；只允许 note/introducedAt/missedBy/suggestions，修改必须填写 note。`,
    '驳回：只记录人工驳回审计，候选归因保留，不写入 confirmed。',
    '取消、多选、空回答都不算确认。',
  ]
  return {
    id: `defect:${defect.requirementId}:${defect.id}:${hash.slice(0, 12)}`,
    header: 'taktflow 归因确认',
    question: `确认缺陷 ${defect.id} 的候选归因？`,
    detail: lines.join('\n'),
    options: [
      { label: DEFECT_CONFIRM_LABEL, description: '按当前候选归因确认' },
      { label: DEFECT_EDIT_LABEL, description: '在自定义回答里填写修改 JSON 后确认' },
      { label: DEFECT_REJECT_LABEL, description: '驳回候选；只记审计，不写 confirmed' },
    ],
  }
}

/** 只接受人从卡片自定义回答里填写的 JSON；Lead 工具参数不能冒充修改。 */
function parseHumanEdit(custom: string): DefectConfirmRequest {
  if (custom === '') {
    throw new M3InputError('修改后确认需要在自定义回答里填写 JSON', '包含 note 和要修改的 introducedAt/missedBy/suggestions。')
  }
  let parsed: unknown
  try { parsed = JSON.parse(custom) } catch {
    throw new M3InputError('修改内容不是合法 JSON，未确认', '按卡片示例填写 JSON。')
  }
  if (!isRecord(parsed)) throw new M3InputError('修改内容必须是 JSON 对象，未确认', '按卡片示例填写 JSON。')
  const allowed = new Set(['note', 'introducedAt', 'missedBy', 'suggestions'])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new M3InputError(`修改内容包含不允许的字段：${key}`, '只允许 note/introducedAt/missedBy/suggestions。')
  }
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
  const attribution: DefectConfirmRequest['attribution'] = {}
  for (const field of ['introducedAt', 'missedBy', 'suggestions'] as const) {
    if (parsed[field] !== undefined) (attribution as Record<string, unknown>)[field] = parsed[field]
  }
  const edited = Object.keys(attribution).length > 0
  if (!edited || note === '' || (attribution.introducedAt !== undefined && !isRecord(attribution.introducedAt))
    || (attribution.missedBy !== undefined && !Array.isArray(attribution.missedBy))
    || (attribution.suggestions !== undefined && !Array.isArray(attribution.suggestions))) {
    throw new M3InputError('修改归因必须填写 note，未确认', '在 JSON 里加 note 说明修改原因。')
  }
  return {
    ...(edited ? { attribution } : {}),
    ...(note === '' ? {} : { note }),
  }
}

function evalRunId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  return typeof result.id === 'string' && result.id !== '' ? result.id : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function guardKey(stores: ProjectStores, requirementId: string, defectId: string): string {
  return `${stores.projectDir}\0${requirementId}\0${defectId}`
}

function humanActor(human: string): Actor {
  return { type: 'human', id: human, via: 'dsh:user-questions' }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
