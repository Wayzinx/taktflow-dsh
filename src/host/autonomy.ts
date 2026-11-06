/**
 * AI 自主代答的决策层（M-J 增量）。
 *
 * 职责边界：
 * - 只处理普通 `human` 节点的 answer/approve；choice、review 签字、judge 裁决、
 *   loop 耗尽一律交人（由 core 生成 choice/approve 待办，本模块按节点 kind 拒绝）。
 * - 决策依据只来自本次冻结的产物版本；模型引用的证据必须命中这份清单，落账时
 *   由 approvals 再次校验版本未变。
 * - 落账走 `Approvals.answerAsAgent`（只持久化，不调用 onAnswered），调用方随后
 *   直接 `engine.resume`，避免等待当前运行任务造成自锁。
 * - 低置信、blocker、输出不合法、证据缺失、代答失败都升级：写一条 disposition
 *   为 escalate 的决策产物，再通过 Notifier 唤醒 Lead；待办本身保持未回答。
 *
 * 本模块不直接改运行状态；`autonomyStep` 返回“答了 / 升级了 / 无事可做”，由
 * RunManager 决定是否 resume。
 */
import { canonicalJson, extractJsonBlock, sha256, type Actor, type AgentProfile, type ArtifactRef, type AttentionItem, type NodeDef, type RunState, type WorkflowDefinition } from '@taktflow/core'
import { bindingActor } from './bindings.js'
import type { DshHarness } from './dsh-harness.js'
import { ApprovalInputError } from './approvals.js'
import type { AgentDecisionInput, Approvals, Autonomy, Notifier, SpaceHandle, TaktToolError } from './types.js'

export interface AutonomyDriveDeps {
  space: SpaceHandle
  runId: string
  requirementId: string
  workflow: WorkflowDefinition
  profiles: Record<string, AgentProfile>
  autonomy: Autonomy
  harness: DshHarness
  approvals: Approvals
  notifier?: Notifier
  /** 旧数据回退：需求没有绑定记录时使用配置里的用户。 */
  configUser?: string
  /** 取消信号：stop/卸载/租约丢失时中止子会话。 */
  signal: AbortSignal
  /**
   * 调用模型前持久化“本 requestId 已尝试”。宿主重启后这些待办直接交人，
   * 不会重复消耗模型或覆盖已升级的结论。
   */
  claim?(requestId: string): Promise<void>
  log(message: string): void
}

export type AutonomyStep =
  | { kind: 'none' }
  | { kind: 'answered'; requestId: string }
  | { kind: 'escalated'; requestId: string; reason: string }

/** 一次自主判定最多读入的产物内容；超出部分只列路径与版本，避免提示词无限膨胀。 */
const MAX_ARTIFACT_CHARS = 24000
const MAX_ARTIFACT_FILES = 40
const DECISION_TIMEOUT_MS = 180000

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'confidence', 'evidence', 'blockers', 'unresolved', 'rationale'],
  properties: {
    disposition: { type: 'string', enum: ['answer', 'approve', 'escalate'] },
    answer: { type: 'string' },
    confidence: { type: 'number' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['workspace', 'path', 'version'],
        properties: {
          workspace: { type: 'string' },
          path: { type: 'string' },
          version: { type: 'integer' },
        },
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}

/**
 * 判断某个节点是否允许 AI 代答。
 *
 * 只有普通 human 节点可以；review 的 humanSignoff、judge 的 human 路由、loop
 * 耗尽的待办即使表单也是 approve，也必须由人处理。
 */
export function autonomyFormOf(
  item: AttentionItem,
  autonomy: Autonomy,
  workflow: WorkflowDefinition,
  state: RunState,
): 'answer' | 'approve' | undefined {
  if (autonomy === 'manual') return undefined
  if (nodeKindOf(workflow, state, item.nodeId) !== 'human') return undefined
  if (item.form === 'answer') return 'answer'
  if (item.form === 'approve' && autonomy === 'full') return 'approve'
  return undefined
}

/** 节点 kind：静态节点按引擎的 loop 前缀规则展开，planner 动态节点读运行快照。 */
export function nodeKindOf(workflow: WorkflowDefinition, state: RunState | undefined, nodeId: string): NodeDef['kind'] | undefined {
  for (const expansion of state?.expansions ?? []) {
    const snapshot = (expansion.nodes ?? []).find((node) => node.id === nodeId)
    if (snapshot !== undefined) return snapshot.kind
  }
  const visit = (nodes: NodeDef[], prefix: string): NodeDef['kind'] | undefined => {
    for (const node of nodes) {
      const id = `${prefix}${node.id}`
      if (id === nodeId) return node.kind
      if (node.kind === 'loop') {
        const nested = visit(node.body, `${id}/`)
        if (nested !== undefined) return nested
      }
      if (node.kind === 'subflow') {
        const nested = visit(node.workflow.nodes, `${id}/`)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  return visit(workflow.nodes, '')
}

/**
 * 选一条可自主处理的待办并尝试回答。
 *
 * `attempted` 由调用方维护：同一 requestId 只尝试一次，升级/失败/中断后不重试，
 * 重启恢复也交给人。人已抢先回答时返回 answered，让调用方 resume 消费真人答案。
 */
export async function autonomyStep(deps: AutonomyDriveDeps, state: RunState, attempted: ReadonlySet<string>): Promise<AutonomyStep> {
  if (deps.autonomy === 'manual' || state.status !== 'waiting_human') return { kind: 'none' }
  if (deps.signal.aborted) return { kind: 'none' }
  const pending = (await deps.space.stores.attention.list({ requirementId: deps.requirementId, pending: true }))
    .filter((item) => item.runId === deps.runId && item.answeredAt === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId))
  const item = pending.find((candidate) => !attempted.has(candidate.requestId) && autonomyFormOf(candidate, deps.autonomy, deps.workflow, state) !== undefined)
  if (item === undefined) return { kind: 'none' }
  // 已经被别人回答（人工入口或上一轮 drive）：直接让调用方 resume。
  if (item.answeredAt !== undefined) return { kind: 'answered', requestId: item.requestId }
  const form = autonomyFormOf(item, deps.autonomy, deps.workflow, state)!
  const node = state.nodes[item.nodeId]
  if (node === undefined || node.status !== 'waiting_human') return { kind: 'none' }

  const trusted = await trustedHuman(deps)
  if (trusted === undefined) {
    const reason = `需求 ${deps.requirementId} 没有绑定人，也没有配置 user，AI 不能代答`
    await notifyEscalation(deps, item, reason)
    return { kind: 'escalated', requestId: item.requestId, reason }
  }

  const attempt = item.attempt ?? node.attempts
  const role = form === 'answer' ? 'pm' : 'release-reviewer'
  const profile = deps.profiles[role]
  if (profile === undefined) {
    const reason = `缺少自主审批角色档案：${role}`
    await escalate(deps, item, trusted, role, reason, [], [], [], attempt)
    return { kind: 'escalated', requestId: item.requestId, reason }
  }

  let decision: Decision
  let frozen: FrozenEvidence
  try {
    // 先落“已尝试”再调用模型：中途崩溃/重启时该待办交人，不重复自动处理。
    await deps.claim?.(item.requestId)
    frozen = await freezeEvidence(deps, item, form)
    // 准出关键材料缺失/截断时不消耗模型：直接升级，避免模型按残缺证据批准。
    if (frozen.critical !== undefined) {
      const reason = frozen.critical
      await escalate(deps, item, trusted, role, reason, [reason], [], [], attempt)
      return { kind: 'escalated', requestId: item.requestId, reason }
    }
    decision = await askModel(deps, item, form, role, profile, frozen)
  } catch (error) {
    if (deps.signal.aborted) return { kind: 'none' }
    const reason = `自主判定失败：${errorText(error)}`
    await escalate(deps, item, trusted, role, reason, [], [], [], attempt)
    return { kind: 'escalated', requestId: item.requestId, reason }
  }
  if (deps.signal.aborted) return { kind: 'none' }

  const normalized = normalizeDecision(decision, item, form, frozen)
  if (normalized.kind === 'escalate') {
    await escalate(deps, item, trusted, role, normalized.reason, normalized.blockers, normalized.unresolved, evidenceRefs(decision.evidence, frozen), attempt)
    return { kind: 'escalated', requestId: item.requestId, reason: normalized.reason }
  }

  const input: AgentDecisionInput = {
    requestId: item.requestId,
    attempt,
    disposition: normalized.disposition,
    ...(normalized.answer === undefined ? {} : { answer: normalized.answer }),
    by: {
      type: 'agent',
      role,
      harness: 'dsh-host',
      onBehalfOf: trusted.id,
    },
    confidence: normalized.confidence,
    evidence: normalized.evidence,
    basis: frozen.refs,
    basisDigest: frozen.digest,
    signal: deps.signal,
    blockers: normalized.blockers,
    unresolved: normalized.unresolved,
    rationale: normalized.rationale,
  }
  try {
    const result = await deps.approvals.answerAsAgent!(deps.space, input)
    if (result.answered) return { kind: 'answered', requestId: item.requestId }
    // 人抢先回答或待办已答：不写第二份决定，但仍要 resume 消费真人答案。
    return { kind: 'answered', requestId: item.requestId }
  } catch (error) {
    if (deps.signal.aborted) return { kind: 'none' }
    const reason = `自主落账失败：${errorText(error)}`
    await escalate(deps, item, trusted, role, reason, normalized.blockers, normalized.unresolved, normalized.evidence, attempt)
    return { kind: 'escalated', requestId: item.requestId, reason }
  }
}

interface Decision {
  disposition?: unknown
  answer?: unknown
  confidence?: unknown
  evidence?: unknown
  blockers?: unknown
  unresolved?: unknown
  rationale?: unknown
}

interface FrozenEvidence {
  /** 本次判定的全体依据（全部产物最新版本），审批层落账前会整表核对。 */
  refs: ArtifactRef[]
  /** 全体依据的摘要；用于检测新增、删除和版本变化。 */
  digest: string
  /** 正文完整进入提示词的产物；模型只能引用这些路径/版本。 */
  provided: ArtifactRef[]
  /** 准出关键材料缺失/被截断时的升级原因；空表示可以继续让模型判断。 */
  critical?: string
  prompt: string
}

/** 准出必要材料的优先级：质量报告、影响面、评审记录必须排在最前。 */
function evidenceRank(artifactPath: string): number {
  if (artifactPath === 'reports/quality.md') return 0
  if (artifactPath === 'reports/impact.md') return 1
  if (artifactPath.startsWith('reviews/')) return 2
  return 3
}

/** 读取当前全部产物的最新版本；提示词里带内容，证据清单只带路径与版本。 */
async function freezeEvidence(deps: AutonomyDriveDeps, item: AttentionItem, form: 'answer' | 'approve'): Promise<FrozenEvidence> {
  const records = (await deps.space.stores.workspaces.listArtifacts(deps.requirementId))
    .filter((record) => record.versions.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path))
  // 依据清单必须覆盖全部产物（用于集合摘要），只有正文读取受条数/字符预算限制。
  const refs: ArtifactRef[] = records.map((record) => ({
    workspace: deps.requirementId,
    path: record.path,
    version: record.versions.at(-1)!.version,
  }))
  const blocks: string[] = []
  const provided: ArtifactRef[] = []
  /** 完整进入提示词的产物正文；准出必要材料还要求正文非空。 */
  const complete = new Map<string, string>()
  let used = 0
  let criticalTruncated = false
  const prioritized = [...records].sort((left, right) => evidenceRank(left.path) - evidenceRank(right.path)
    || left.path.localeCompare(right.path))
  for (const record of prioritized) {
    const version = record.versions.at(-1)!
    const ref: ArtifactRef = { workspace: deps.requirementId, path: record.path, version: version.version }
    const critical = evidenceRank(record.path) < 3
    if (blocks.length >= MAX_ARTIFACT_FILES) {
      if (critical) criticalTruncated = true
      continue
    }
    const content = (await deps.space.stores.workspaces.readArtifact(ref))?.toString('utf8') ?? ''
    const remaining = Math.max(0, MAX_ARTIFACT_CHARS - used)
    const excerpt = content.length > remaining ? `${content.slice(0, remaining)}\n…（已截断，禁止引用该产物）` : content
    used += Math.min(content.length, remaining)
    blocks.push(`<artifact workspace="${deps.requirementId}" path="${record.path}" kind="${record.kind}" version="${version.version}">\n${excerpt}\n</artifact>`)
    if (content.length <= remaining) {
      provided.push(ref)
      complete.set(record.path, content)
    } else if (critical) criticalTruncated = true
  }
  const subjects = item.subjects ?? []
  const subjectLine = subjects.length
    ? `本次待审/待回答节点冻结的输入：${subjects.map((ref) => `${ref.path}@v${ref.version ?? '?'}`).join('、')}`
    : '本次待办没有冻结输入；请依据下方产物自行引用证据版本。'
  let critical: string | undefined
  if (form === 'approve') {
    const hasContent = (path: string): boolean => (complete.get(path) ?? '').trim() !== ''
    const missing = ['reports/quality.md', 'reports/impact.md'].filter((path) => !hasContent(path))
    const reviews = [...complete.entries()].filter(([path, content]) => path.startsWith('reviews/') && content.trim() !== '')
    if (reviews.length === 0) missing.push('reviews/**（评审记录）')
    if (missing.length > 0) critical = `准出必要材料缺失或正文为空：${missing.join('、')}`
    else if (criticalTruncated) critical = '准出必要材料超出内容预算被截断'
  }
  const referenceList = provided.length === 0
    ? '（无：没有正文完整进入提示词的产物，不能引用任何证据）'
    : provided.map((ref) => `- workspace="${ref.workspace}" path="${ref.path}" version=${ref.version}`).join('\n')
  return {
    refs,
    digest: sha256(canonicalJson(refs)),
    provided,
    ...(critical === undefined ? {} : { critical }),
    prompt: [
      '你是 Taktflow 标准流程里的自主审批代理。只在证据充分时回答或批准；证据不足、仍有 blocker 或未解决项时升级给人。',
      `需求 requirementId（evidence.workspace 必须使用这个值）：${deps.requirementId}`,
      `待办 requestId：${item.requestId}`,
      `节点：${item.nodeId}（第 ${item.attempt ?? 0} 次尝试）`,
      `表单：${item.form}`,
      `问题：${item.ask}`,
      subjectLine,
      '',
      '可引用证据清单（只有以下 workspace/path/version 组合合法；正文被截断或未列出的产物禁止引用）：',
      referenceList,
      '',
      '可用产物（只有正文完整列出的产物可被引用；路径、版本与内容均来自本次冻结读取）：',
      ...blocks,
      '',
      '只输出一个 JSON 对象，字段如下：',
      '{"disposition":"answer|approve|escalate","answer":"...","confidence":0到1,"evidence":[{"workspace":"...","path":"...","version":n}],"blockers":["..."],"unresolved":["..."],"rationale":"..."}',
      '规则：',
      '- answer 表单只能输出 answer 或 escalate；approve 表单只能输出 approve 或 escalate。',
      '- 不能准出或需要打回时输出 escalate，由人决定；AI 没有 reject 语义。',
      '- answer 必须给出具体、可执行的答复；approve 至少引用一条产物证据，confidence 不低于 0.9；answer 的 confidence 不低于 0.8。',
      '- 任何 blocker 或 unresolved 非空都必须 escalate；evidence 的 workspace 必须等于上面的 requirementId，且每一项都要命中可引用证据清单。',
      '- escalate 时说明还缺什么，不要编造已经完成的检查。',
    ].join('\n'),
  }
}

async function askModel(
  deps: AutonomyDriveDeps,
  item: AttentionItem,
  form: 'answer' | 'approve',
  role: string,
  profile: AgentProfile,
  frozen: FrozenEvidence,
): Promise<Decision> {
  const result = await deps.harness.run({
    prompt: frozen.prompt,
    cwd: deps.space.root,
    systemAppend: profile.instructions,
    env: {
      TAKT_ROLE: role,
      TAKT_NODE: item.nodeId,
      TAKT_RUN_ID: deps.runId,
      TAKT_REQ: deps.requirementId,
    },
    tools: { writeScope: [], allowBash: false },
    resultSchema: DECISION_SCHEMA,
    signal: deps.signal,
    timeoutMs: DECISION_TIMEOUT_MS,
  }, () => {})
  if (!result.ok) throw new Error(result.error ?? '自主审批子 Agent 未成功')
  const raw = result.structured ?? extractJsonBlock(result.finalText)
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('自主审批输出不是 JSON 对象')
  }
  return raw as Decision
}

type NormalizedDecision =
  | { kind: 'answer'; disposition: 'answer' | 'approve'; answer?: string; confidence: number; evidence: ArtifactRef[]; blockers: string[]; unresolved: string[]; rationale: string }
  | { kind: 'escalate'; reason: string; blockers: string[]; unresolved: string[] }

/** 模型输出必须完全符合表单、阈值和冻结证据；任何一项不满足都升级而不是硬改。 */
function normalizeDecision(decision: Decision, item: AttentionItem, form: 'answer' | 'approve', frozen: FrozenEvidence): NormalizedDecision {
  const blockers = stringArray(decision.blockers)
  const unresolved = stringArray(decision.unresolved)
  if (blockers === undefined || unresolved === undefined) {
    return { kind: 'escalate', reason: '自主审批的 blockers/unresolved 不是字符串数组', blockers: [], unresolved: [] }
  }
  const rationale = typeof decision.rationale === 'string' ? decision.rationale.trim() : ''
  if (rationale === '') return { kind: 'escalate', reason: '自主审批没有给出 rationale', blockers, unresolved }
  const disposition = decision.disposition
  if (disposition !== 'answer' && disposition !== 'approve' && disposition !== 'escalate') {
    return { kind: 'escalate', reason: `自主审批输出未知处置：${String(disposition)}`, blockers, unresolved }
  }
  if (disposition === 'escalate') {
    return { kind: 'escalate', reason: rationale, blockers, unresolved }
  }
  if (form === 'answer' && disposition !== 'answer') {
    return { kind: 'escalate', reason: `answer 待办收到 ${disposition}，交给人处理`, blockers, unresolved }
  }
  if (form === 'approve' && disposition === 'answer') {
    return { kind: 'escalate', reason: 'approve 待办收到文本回答，交给人处理', blockers, unresolved }
  }
  if (blockers.length > 0 || unresolved.length > 0) {
    return { kind: 'escalate', reason: '仍有 blocker 或未解决项', blockers, unresolved }
  }
  const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence)
    ? decision.confidence : Number.NaN
  const threshold = disposition === 'approve' ? 0.9 : 0.8
  if (!(confidence >= 0 && confidence <= 1) || confidence < threshold) {
    return { kind: 'escalate', reason: `置信度不足（${Number.isFinite(confidence) ? confidence : '缺失'} < ${threshold}）`, blockers, unresolved }
  }
  const answer = typeof decision.answer === 'string' ? decision.answer.trim() : undefined
  if (disposition === 'answer' && (answer === undefined || answer === '')) {
    return { kind: 'escalate', reason: 'answer 处置没有给出非空答复', blockers, unresolved }
  }
  if (!Array.isArray(decision.evidence)) {
    return { kind: 'escalate', reason: 'evidence 不是数组', blockers, unresolved }
  }
  const evidence: ArtifactRef[] = []
  for (const raw of decision.evidence) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { kind: 'escalate', reason: 'evidence 项不是对象', blockers, unresolved }
    }
    const ref = raw as Record<string, unknown>
    if (typeof ref.workspace !== 'string' || typeof ref.path !== 'string'
      || !Number.isSafeInteger(ref.version) || (ref.version as number) < 1) {
      return { kind: 'escalate', reason: 'evidence 项缺少 workspace/path/正整数 version', blockers, unresolved }
    }
    // 只允许引用正文完整进入提示词的产物：basis 里的其它路径只能证明集合未变，
    // 不能作为“模型读过内容”的批准依据。
    const match = frozen.provided.find((candidate) => candidate.workspace === ref.workspace
      && candidate.path === ref.path && candidate.version === ref.version)
    if (match === undefined) {
      return { kind: 'escalate', reason: `evidence 不在本次完整提供的产物清单：${ref.path}@v${String(ref.version)}`, blockers, unresolved }
    }
    if (!evidence.some((candidate) => candidate.path === match.path && candidate.version === match.version)) evidence.push({ ...match })
  }
  if (disposition === 'approve' && evidence.length === 0) {
    return { kind: 'escalate', reason: '准出没有引用冻结产物', blockers, unresolved }
  }
  return {
    kind: 'answer',
    disposition,
    ...(answer === undefined || answer === '' ? {} : { answer }),
    confidence,
    evidence,
    blockers,
    unresolved,
    rationale,
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.map((entry) => entry.trim()).filter(Boolean) : undefined
}

/** 升级审计里只保留确实来自冻结清单的引用；模型编造或过期的引用一律丢弃。 */
function evidenceRefs(value: unknown, frozen: FrozenEvidence): ArtifactRef[] {
  if (!Array.isArray(value)) return []
  const result: ArtifactRef[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const ref = raw as Record<string, unknown>
    if (typeof ref.workspace !== 'string' || typeof ref.path !== 'string' || !Number.isSafeInteger(ref.version)) continue
    const match = frozen.provided.find((candidate) => candidate.workspace === ref.workspace
      && candidate.path === ref.path && candidate.version === ref.version)
    if (match !== undefined && !result.some((candidate) => candidate.path === match.path)) result.push({ ...match })
  }
  return result
}

async function trustedHuman(deps: AutonomyDriveDeps): Promise<{ id: string } | undefined> {
  const bound = await bindingActor(deps.space, deps.requirementId)
  if (bound !== undefined) return { id: bound.id }
  const configured = deps.configUser?.trim()
  return configured === undefined || configured === '' ? undefined : { id: configured }
}

/** 写一条升级决策产物并唤醒 Lead；写产物失败只记日志，不阻断人工处理。 */
async function escalate(
  deps: AutonomyDriveDeps,
  item: AttentionItem,
  trusted: { id: string },
  role: string,
  reason: string,
  blockers: string[],
  unresolved: string[],
  evidence: readonly ArtifactRef[],
  attempt: number,
  signal: AbortSignal = deps.signal,
): Promise<void> {
  const actor: Extract<Actor, { type: 'agent' }> = {
    type: 'agent',
    role,
    harness: 'dsh-host',
    onBehalfOf: trusted.id,
  }
  try {
    const result = await deps.approvals.answerAsAgent!(deps.space, {
      requestId: item.requestId,
      attempt,
      disposition: 'escalate',
      by: actor,
      confidence: 0,
      evidence: evidence.map((ref) => ({ ...ref })),
      signal,
      blockers: blockers.length === 0 ? [reason] : blockers,
      unresolved,
      rationale: reason,
    })
    if (result.artifact === undefined) deps.log(`自主审批升级未写入产物：${reason}`)
  } catch (error) {
    deps.log(`自主审批升级产物写入失败：${errorText(error)}`)
  }
  await notifyEscalation(deps, item, reason)
}

/**
 * 升级后唤醒 Lead。
 *
 * 取消/卸载后不能再发新卡；发送前还要确认该 requestId 仍未回答——AI 升级与
 * 真人抢答可能同时发生，过期唤醒会让人重复处理。读取失败时不发，宁可少打扰。
 */
async function notifyEscalation(deps: AutonomyDriveDeps, item: AttentionItem, reason: string): Promise<void> {
  if (deps.signal.aborted) return
  try {
    const current = (await deps.space.stores.attention.list({ requirementId: deps.requirementId, pending: true }))
      .find((candidate) => candidate.requestId === item.requestId)
    if (current === undefined || current.answeredAt !== undefined) return
  } catch (error) {
    deps.log(`升级通知前读取待办失败：${errorText(error)}`)
    return
  }
  if (deps.signal.aborted) return
  try {
    await deps.notifier?.notifyEscalation?.(deps.space, {
      requirementId: deps.requirementId,
      runId: deps.runId,
      requestId: item.requestId,
      line: `自主审批已升级，需要人处理 requestId=${item.requestId}：${reason}`,
    })
  } catch (error) {
    deps.log(`升级通知失败：${errorText(error)}`)
  }
}

function errorText(error: unknown): string {
  if (error instanceof ApprovalInputError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 兼容旧调用方：判断一个错误是否属于输入不合法（仅用于日志/测试）。 */
export function isDecisionInputError(error: unknown): boolean {
  return error instanceof ApprovalInputError || (error instanceof Error && error.name === 'TaktToolError')
}
