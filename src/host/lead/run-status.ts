import type {
  AttentionItem,
  EventEnvelope,
  EventPayloads,
  NodeState,
  RunState,
  RunStatus,
  SnapshotNode,
  WorkflowSnapshot,
} from '@taktflow/core'
import type { SpaceHandle } from '../types.js'

/**
 * 运行状态增量视图（takt_status 的补充数据）。
 *
 * 设计约束：
 * - 只读现有 core stores：runs.getWorkflow / events.read / attention.list。
 * - 事件按 runId 读取，待办再按 run.runId 过滤，不混入同一需求的其它运行。
 * - 当前阶段是数组：并行节点、并行阶段都按真实状态列出，不强行归并成一个。
 * - 累计评审轮次按 review.round 事件数统计；节点上的 round 会在打回后归零，
 *   只能作为“当前轮次”，不能当累计值。
 * - loop 的 node.started.iteration 会在 generation 重置后重来，所以只报
 *   “已观察最高轮次”，不把它叫作累计执行轮数。
 * - 缺节点定义时 kind 返回 null 并标来源，不伪造 subflow。
 * - 缺 workflow 快照时直接抛错，不用空数组假装“没有评审/没有循环”。
 * - 每个分区都带 source，说明数据来源，便于接入方核对。
 */
export type ReviewConclusion =
  | 'passed'
  | 'awaiting_signoff'
  | 'revising'
  | 'rework'
  | 'exhausted'
  | 'failed'
  | 'cancelled'
  | 'in_review'
  | 'pending'

export interface RunStatusStageNode {
  id: string
  title: string
  /** 节点定义里的 kind；旧运行缺定义时为 null，不推断成 subflow。 */
  kind: SnapshotNode['kind'] | null
  /** 节点定义来源；缺定义时为 null。 */
  definitionSource: 'snapshot' | 'run.expansion' | null
  status: NodeState['status']
  attempts: number
  iteration: number | null
  round: number | null
}

export interface RunStatusStage {
  /** 快照阶段 ID；旧运行缺少节点定义时为 null。 */
  id: string | null
  title: string | null
  nodes: RunStatusStageNode[]
}

export interface RunStatusReview {
  nodeId: string
  title: string
  target: NonNullable<SnapshotNode['review']>['target']
  currentRound: number
  /** 当前运行内 review.round 事件总数；打回后不会归零。 */
  cumulativeRounds: number
  maxRounds: number
  humanSignoff: boolean
  onExhausted: NonNullable<SnapshotNode['review']>['onExhausted']
  /** 本评审节点打回上游的次数（rework.started.data.from === nodeId）。 */
  reworks: number
  /** 本评审节点 review.exhausted 事件次数。 */
  exhausted: number
  conclusion: ReviewConclusion
  latestRound?: {
    round: number
    passed: boolean
    verdicts: EventPayloads['review.round']['verdicts']
  }
  exhaustedAction?: EventPayloads['review.exhausted']['action']
  source: string
}

export interface RunStatusLoop {
  nodeId: string
  title: string
  /** 节点当前 generation 的轮次（run.nodes[nodeId].iteration）。 */
  currentIteration: number
  /**
   * 当前运行内已观察到的最高轮次（node.started.iteration 与节点当前值取大）。
   * generation 重置后 iteration 会重来，因此这不是累计执行次数。
   */
  maxObservedIteration: number
  maxIterations: number | null
  /** 仅在轮次达到 maxIterations 且存在待办/节点失败时才算预算耗尽。 */
  exhausted: boolean
  exhaustedSource: 'attention' | 'node.failed' | null
  /** 节点失败状态单列；早期失败不代表 loop 轮次预算耗尽。 */
  failed: boolean
  pendingRequestIds: string[]
  source: string
}

export interface RunStatusPendingMarker {
  type: 'review.exhausted' | 'judge.verdict' | 'loop.exhausted' | 'autonomy.escalated'
  /** 真实事件/状态的可核对描述；不是推断的原因。 */
  detail: string
}

/** 宿主 AI 自主升级的真实来源；reason/source 必须非空。 */
export interface RunStatusEscalation {
  reason: string
  source: string
}

export interface RunStatusPending {
  requestId: string
  nodeId: string
  ask: string
  form: AttentionItem['form']
  choices?: string[]
  attempt?: number
  createdAt: string
  /** ai：调用方判定已有 AI 在处理；human：需要人（或未知）。 */
  handling: 'ai' | 'human'
  /** 仅当 handling=human 且存在真实升级标记时为 true。 */
  escalation: boolean
  escalationReason: string | null
  /** 自主升级来源（决策产物路径/事件）；仅 marker=autonomy.escalated 时非空。 */
  escalationSource: string | null
  /** 真实升级标记；AI 处理中的待办也可能保留标记，但不计为升级。 */
  marker: RunStatusPendingMarker | null
  source: string
}

export interface RunStatusSources {
  currentStages: string
  reviews: string
  loops: string
  pending: string
}

export interface RunStatusReport {
  runId: string
  requirementId: string
  workflowId: string
  workflowTitle: string
  workflowVersion: string
  status: RunStatus
  startedAt: string
  endedAt: string | null
  ended: boolean
  currentStages: RunStatusStage[]
  reviews: RunStatusReview[]
  loops: RunStatusLoop[]
  pending: RunStatusPending[]
  sources: RunStatusSources
}

export interface BuildRunStatusOptions {
  /**
   * 判定某条待办是否已有 AI 在处理（例如 full/checkpoints 下的自动回答）。
   * 返回 true 时 handling=ai，且不算升级；返回 false/不传时 handling=human。
   * 判定函数抛错会原样向上抛出，不静默降级。
   */
  isAiHandling?: (item: AttentionItem) => boolean | Promise<boolean>
  /**
   * 查询宿主 AI 的真实升级（低置信/blocker/证据不足等）。
   * 只在 handling=human 且没有内置 review/judge/loop 标记时调用；
   * 返回 { reason, source } 才算升级，返回 null/undefined 表示普通人工待办。
   * 不得仅凭 handling=human 推断升级；返回缺少 reason/source 会抛错。
   */
  getEscalation?: (item: AttentionItem) =>
    RunStatusEscalation | null | undefined |
    Promise<RunStatusEscalation | null | undefined>
}

const ACTIVE_STATUSES: ReadonlySet<NodeState['status']> = new Set([
  'running',
  'ready',
  'waiting_human',
  'blocked',
])

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled'])

const SOURCES: RunStatusSources = {
  currentStages: 'core.runs.getWorkflow(runId) + run.nodes.status',
  reviews: 'core.events.read(runId):review.round|review.exhausted|rework.started|human.answered + run.nodes.round',
  loops: 'run.nodes.iteration + core.events.read(runId):node.started(iteration) + core.attention.list(pending)',
  pending: 'core.attention.list({pending:true, requirementId}) + runId 过滤 + core.events:review.exhausted|judge.verdict|loop 轮次 + options.getEscalation(autonomy.escalated)',
}

interface DefinitionEntry {
  /** 快照/展开里的真实节点定义；旧运行缺定义时为 undefined。 */
  node?: SnapshotNode
  parent?: string
  stage?: string
  /** 定义来源；缺定义时用 run.expansion 标出，不能伪装成快照节点。 */
  source: 'snapshot' | 'run.expansion'
}

/**
 * 收集工作流节点定义（含 loop body 与 planner 动态展开节点）。
 *
 * ID 规则与 core insights/graph 一致：
 * - 顶层节点用定义 ID；
 * - loop body 用 `<loopId>/<childId>`；
 * - planner 展开节点在快照里已经带前缀，按原 ID 使用。
 */
function collectDefinitions(snapshot: WorkflowSnapshot, run: RunState): Map<string, DefinitionEntry> {
  const definitions = new Map<string, DefinitionEntry>()
  const visit = (
    nodes: SnapshotNode[],
    parent: string | undefined,
    stage: string | undefined,
    prefix: string,
    source: DefinitionEntry['source'],
  ): void => {
    for (const node of nodes) {
      const id = prefix === '' ? node.id : `${prefix}${node.id}`
      const resolvedStage = node.stage ?? stage
      definitions.set(id, {
        node,
        ...(parent !== undefined ? { parent } : {}),
        ...(resolvedStage !== undefined ? { stage: resolvedStage } : {}),
        source,
      })
      if (node.body !== undefined) visit(node.body, id, resolvedStage, `${id}/`, source)
    }
  }
  visit(snapshot.nodes, undefined, undefined, '', 'snapshot')
  for (const expansion of run.expansions) {
    const planner = definitions.get(expansion.plannerId)
    const stage = planner?.node?.stage ?? planner?.stage
    visit(expansion.nodes ?? [], expansion.plannerId, stage, '', 'run.expansion')
    for (const id of expansion.nodeIds) {
      if (definitions.has(id)) continue
      definitions.set(id, {
        parent: expansion.plannerId,
        ...(stage !== undefined ? { stage } : {}),
        source: 'run.expansion',
      })
    }
  }
  return definitions
}

function sortedEvents(events: EventEnvelope[]): EventEnvelope[] {
  return events.slice().sort((a, b) => a.seq - b.seq)
}

function groupEventsByNode(events: EventEnvelope[]): Map<string, EventEnvelope[]> {
  const grouped = new Map<string, EventEnvelope[]>()
  for (const event of events) {
    if (event.nodeId === undefined) continue
    const list = grouped.get(event.nodeId)
    if (list === undefined) grouped.set(event.nodeId, [event])
    else list.push(event)
  }
  return grouped
}

function lastEvent<T extends EventEnvelope['type']>(
  events: EventEnvelope[],
  type: T,
): EventEnvelope<T> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type) return event as EventEnvelope<T>
  }
  return undefined
}

function reviewConclusion(
  nodeEvents: EventEnvelope[],
  ns: NodeState | undefined,
  humanSignoff: boolean,
): ReviewConclusion {
  // 取消优先：即使最近一轮 AI 结论是 passed，取消后也不能显示已通过。
  if (ns?.status === 'cancelled') return 'cancelled'
  const latest = nodeEvents
    .filter((event) => event.type === 'review.round'
      || event.type === 'review.exhausted'
      || event.type === 'human.answered'
      || event.type === 'rework.started')
    .at(-1)
  if (latest?.type === 'review.exhausted') {
    const data = latest.data as EventPayloads['review.exhausted']
    return data.action === 'rework' ? 'rework' : 'exhausted'
  }
  if (latest?.type === 'rework.started') return 'rework'
  if (latest?.type === 'human.answered') {
    const data = latest.data as EventPayloads['human.answered']
    if (data.decision === 'approve' || data.answer === '放行') return 'passed'
    if (data.answer === '打回') return 'rework'
    if (data.answer === '终止') return 'failed'
    if (data.decision === 'reject') return 'revising'
    if (data.decision === 'cancelled') return 'cancelled'
  }
  if (latest?.type === 'review.round') {
    const data = latest.data as EventPayloads['review.round']
    if (!data.passed) return 'revising'
    return ns?.status === 'waiting_human' && humanSignoff ? 'awaiting_signoff' : 'passed'
  }
  if (ns?.status === 'failed') return 'failed'
  if (ns?.status === 'succeeded') {
    const result = ns.result as { passed?: boolean } | undefined
    return result?.passed === false ? 'failed' : 'passed'
  }
  if (ns?.status === 'waiting_human') return 'in_review'
  return 'pending'
}

function buildStages(
  definitions: Map<string, DefinitionEntry>,
  snapshot: WorkflowSnapshot,
  run: RunState,
): RunStatusStage[] {
  if (run.endedAt !== undefined || TERMINAL_RUN_STATUSES.has(run.status)) return []
  const stageOrder = new Map(snapshot.stages.map((stage, index) => [stage.id, index]))
  const stageTitles = new Map(snapshot.stages.map((stage) => [stage.id, stage.title]))
  const groups = new Map<string | null, RunStatusStage>()
  const active = Object.values(run.nodes)
    .filter((node) => ACTIVE_STATUSES.has(node.status))
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const node of active) {
    const entry = definitions.get(node.id)
    const stageId = entry?.stage ?? null
    let group = groups.get(stageId)
    if (group === undefined) {
      group = {
        id: stageId,
        title: stageId === null ? null : stageTitles.get(stageId) ?? stageId,
        nodes: [],
      }
      groups.set(stageId, group)
    }
    group.nodes.push({
      id: node.id,
      title: entry?.node?.title ?? node.id,
      kind: entry?.node?.kind ?? null,
      definitionSource: entry?.source ?? null,
      status: node.status,
      attempts: node.attempts,
      iteration: node.iteration ?? null,
      round: node.round ?? null,
    })
  }
  return [...groups.values()].sort((a, b) => {
    const left = a.id === null ? Number.MAX_SAFE_INTEGER : stageOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const right = b.id === null ? Number.MAX_SAFE_INTEGER : stageOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return left - right
  })
}

function buildReviews(
  definitions: Map<string, DefinitionEntry>,
  run: RunState,
  eventsByNode: Map<string, EventEnvelope[]>,
): RunStatusReview[] {
  const reviews: RunStatusReview[] = []
  for (const [nodeId, entry] of definitions) {
    const config = entry.node?.review
    if (config === undefined) continue
    const ns = run.nodes[nodeId]
    const nodeEvents = eventsByNode.get(nodeId) ?? []
    const roundEvents = nodeEvents.filter((event) => event.type === 'review.round') as Array<EventEnvelope<'review.round'>>
    const exhaustedEvents = nodeEvents.filter((event) => event.type === 'review.exhausted') as Array<EventEnvelope<'review.exhausted'>>
    const latestRound = roundEvents.at(-1)
    const latestExhausted = exhaustedEvents.at(-1)
    reviews.push({
      nodeId,
      title: entry.node?.title ?? nodeId,
      target: config.target,
      currentRound: ns?.round ?? 0,
      cumulativeRounds: roundEvents.length,
      maxRounds: config.maxRounds,
      humanSignoff: config.humanSignoff ?? false,
      onExhausted: config.onExhausted,
      reworks: nodeEvents.filter((event) => event.type === 'rework.started'
        && (event.data as EventPayloads['rework.started']).from === nodeId).length,
      exhausted: exhaustedEvents.length,
      conclusion: reviewConclusion(nodeEvents, ns, config.humanSignoff ?? false),
      ...(latestRound === undefined ? {} : {
        latestRound: {
          round: latestRound.data.round,
          passed: latestRound.data.passed,
          verdicts: latestRound.data.verdicts,
        },
      }),
      ...(latestExhausted === undefined ? {} : { exhaustedAction: latestExhausted.data.action }),
      source: 'core.events:review.round|review.exhausted|rework.started + run.nodes.round',
    })
  }
  return reviews
}

/** 节点所属的最近一层 loop（用于把 node.started.iteration 归到正确的循环）。 */
function nearestLoop(definitions: Map<string, DefinitionEntry>, nodeId: string): string | undefined {
  let parent = definitions.get(nodeId)?.parent
  while (parent !== undefined) {
    const entry = definitions.get(parent)
    if (entry === undefined) return undefined
    if (entry.node?.kind === 'loop') return parent
    parent = entry.parent
  }
  return undefined
}

function buildLoops(
  definitions: Map<string, DefinitionEntry>,
  run: RunState,
  events: EventEnvelope[],
  pending: AttentionItem[],
): RunStatusLoop[] {
  const loops: RunStatusLoop[] = []
  for (const [nodeId, entry] of definitions) {
    if (entry.node?.kind !== 'loop') continue
    const members = new Set<string>()
    for (const candidateId of definitions.keys()) {
      if (nearestLoop(definitions, candidateId) === nodeId) members.add(candidateId)
    }
    let observedIteration = 0
    for (const event of events) {
      if (event.type !== 'node.started' || event.nodeId === undefined || !members.has(event.nodeId)) continue
      const iteration = (event.data as EventPayloads['node.started']).iteration
      if (iteration !== undefined && iteration > observedIteration) observedIteration = iteration
    }
    const ns = run.nodes[nodeId]
    const currentIteration = ns?.iteration ?? 0
    const maxObservedIteration = Math.max(observedIteration, currentIteration)
    const maxIterations = entry.node?.maxIterations ?? null
    const pendingHere = pending.filter((item) => item.nodeId === nodeId)
    const failed = ns?.status === 'failed'
    // 只有“达到 maxIterations 且存在待办或节点失败”才是预算耗尽；
    // 早期失败/环境失败单独记在 failed，不冒充轮次用尽。
    const exhausted = maxIterations !== null
      && maxObservedIteration >= maxIterations
      && (pendingHere.length > 0 || failed)
    loops.push({
      nodeId,
      title: entry.node?.title ?? nodeId,
      currentIteration,
      maxObservedIteration,
      maxIterations,
      exhausted,
      exhaustedSource: exhausted ? (pendingHere.length > 0 ? 'attention' : 'node.failed') : null,
      failed,
      pendingRequestIds: pendingHere.map((item) => item.requestId),
      source: 'run.nodes.iteration + core.events:node.started(iteration) + core.attention(pending)',
    })
  }
  return loops
}

function pendingMarker(
  item: AttentionItem,
  definitions: Map<string, DefinitionEntry>,
  run: RunState,
  eventsByNode: Map<string, EventEnvelope[]>,
): RunStatusPendingMarker | null {
  const nodeEvents = eventsByNode.get(item.nodeId) ?? []
  const exhausted = lastEvent(nodeEvents, 'review.exhausted')
  if (exhausted !== undefined && exhausted.data.action !== 'fail') {
    // action=rework 但随后没有 rework.started，说明打回次数已用完、实际转成了人工裁决。
    const reworkedAfter = nodeEvents.some((event) => event.type === 'rework.started' && event.seq > exhausted.seq)
    if (!reworkedAfter) {
      return {
        type: 'review.exhausted',
        detail: `review.exhausted action=${exhausted.data.action} rounds=${exhausted.data.rounds}`,
      }
    }
  }
  const verdict = lastEvent(nodeEvents, 'judge.verdict')
  if (verdict !== undefined) {
    const humanRoutes = verdict.data.routed.filter((route) => route.to === 'human')
    if (humanRoutes.length > 0) {
      return {
        type: 'judge.verdict',
        detail: `judge.verdict routed=human subjects=${humanRoutes.map((route) => route.subject).join('、')}`,
      }
    }
  }
  const entry = definitions.get(item.nodeId)
  if (entry?.node?.kind === 'loop') {
    const ns = run.nodes[item.nodeId]
    const maxIterations = entry.node.maxIterations
    if (ns?.iteration !== undefined && maxIterations !== undefined && ns.iteration >= maxIterations) {
      return {
        type: 'loop.exhausted',
        detail: `loop iteration=${ns.iteration} maxIterations=${maxIterations}`,
      }
    }
  }
  return null
}

/**
 * 生成运行状态增量视图。
 *
 * @param space 当前空间（只读访问 stores）
 * @param run 当前运行（调用方需保证属于该空间；helper 用 run.runId 读事件）
 * @param options.isAiHandling 判定待办是否已有 AI 处理
 * @param options.getEscalation 从真实决策产物/持久化状态提供自主升级来源
 */
export async function buildRunStatus(
  space: SpaceHandle,
  run: RunState,
  options: BuildRunStatusOptions = {},
): Promise<RunStatusReport> {
  const snapshot = await space.stores.runs.getWorkflow(run.runId)
  if (snapshot === undefined) {
    throw new Error(`运行 ${run.runId} 缺少 workflow 快照（runs/${run.runId}/workflow.json），无法生成状态`)
  }
  const [rawEvents, rawPending] = await Promise.all([
    space.stores.events.read(run.runId),
    space.stores.attention.list({ pending: true, requirementId: run.requirementId }),
  ])
  const events = sortedEvents(rawEvents)
  const eventsByNode = groupEventsByNode(events)
  const definitions = collectDefinitions(snapshot, run)
  const pendingItems = rawPending.filter((item) => item.runId === run.runId)

  const pending: RunStatusPending[] = []
  for (const item of pendingItems) {
    const handling = options.isAiHandling !== undefined && await options.isAiHandling(item) ? 'ai' : 'human'
    let marker = pendingMarker(item, definitions, run, eventsByNode)
    let escalationSource: string | null = null
    // 自主升级只能来自调用方提供的真实决策来源；handling=human 本身不是升级。
    // 已有 review/judge/loop 标记时以真实事件为准，不再重复查询。
    if (handling === 'human' && marker === null && options.getEscalation !== undefined) {
      const escalation = await options.getEscalation(item)
      if (escalation !== null && escalation !== undefined) {
        const reason = escalation.reason.trim()
        const source = escalation.source.trim()
        if (reason === '' || source === '') {
          throw new Error(`待办 ${item.requestId} 的 getEscalation 返回缺少 reason/source，无法确认真实升级来源`)
        }
        marker = { type: 'autonomy.escalated', detail: reason }
        escalationSource = source
      }
    }
    const escalation = handling === 'human' && marker !== null
    pending.push({
      requestId: item.requestId,
      nodeId: item.nodeId,
      ask: item.ask,
      form: item.form,
      ...(item.choices === undefined ? {} : { choices: item.choices }),
      ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
      createdAt: item.createdAt,
      handling,
      escalation,
      escalationReason: escalation && marker !== null ? marker.detail : null,
      escalationSource: escalation ? escalationSource : null,
      marker,
      source: 'core.attention.list({pending:true}) + runId 过滤 + options.getEscalation(autonomy.escalated)',
    })
  }

  return {
    runId: run.runId,
    requirementId: run.requirementId,
    workflowId: snapshot.id,
    workflowTitle: snapshot.title,
    workflowVersion: snapshot.version,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    ended: run.endedAt !== undefined || TERMINAL_RUN_STATUSES.has(run.status),
    currentStages: buildStages(definitions, snapshot, run),
    reviews: buildReviews(definitions, run, eventsByNode),
    loops: buildLoops(definitions, run, events, pendingItems),
    pending,
    sources: SOURCES,
  }
}
