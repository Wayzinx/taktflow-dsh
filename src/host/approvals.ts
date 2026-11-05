import { userInfo } from 'node:os'
import path from 'node:path'
import {
  AttentionAlreadyAnsweredError,
  checkAnswerFreshness,
  type Actor,
  type ArtifactRecord,
  type ArtifactRef,
  type AttentionItem,
  type NodeState,
  type WorkflowSnapshot,
} from '@taktflow/core'
import { withFileLock } from '../../vendor/taktflow/packages/core/src/store/file-lock.js'
import type { Agent, HostContext, ToolExecutionContext, UserAnswer, UserQuestion } from './dsh-types.js'
import { notImplemented } from './errors.js'
import { TaktToolError, type AnswerInput, type Approvals, type Ownership, type RunManager, type SpaceHandle } from './types.js'

/** 原生问题卡片上的两个固定选项；present 与 answer 共用，避免文案漂移。 */
export const APPROVE_LABEL = '批准'
export const REJECT_LABEL = '打回'

/**
 * 回答本身不合法（缺字段、选项不在 choices 里、空回答等）。
 *
 * 这不是“待审内容过期”，也不是权限错误；HTTP 路由映射成 400。单独成类是为了
 * 让 TaktErrorCode 保持冻结，不把输入校验塞进业务错误码。
 */
export class ApprovalInputError extends Error {
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ApprovalInputError'
    this.hint = hint
  }
}

/** createApprovals 的依赖；ctx 只需要 agents 与可选的 userQuestions。 */
export interface ApprovalsDeps {
  ctx: Pick<HostContext, 'agents'> & Partial<Pick<HostContext, 'userQuestions'>>
  ownership: Ownership
  runs: RunManager
  /** 审计里代表的人；默认取 os.userInfo().username。 */
  config?: { user?: string }
}

/**
 * 真实审批链路：core AttentionStore 是权威，dsh userQuestions 只负责把问题卡片
 * 呈现给人。
 *
 * 谁调用：
 * - Lead 工具 `takt_ask_human` 调 present；
 * - 主面板 HTTP 路由 `attention.answer` 与 present 拿到答案后都调 answer。
 *
 * 单写者：answer 先 ensureLease；同一 requestId 的并发回答在进程内串行化，
 * 跨进程/跨工厂由空间级审批守卫文件锁把“重读 + freshness + 落账”包成原子段。
 *
 * 幂等：已回答的 requestId 直接返回已有 AttentionItem，不再调 onAnswered；
 * 重复回答不会重复推进运行。
 */
export function createApprovals(deps: ApprovalsDeps): Approvals {
  const user = resolveUser(deps.config)
  const inflight = new Map<string, Promise<AttentionItem>>()
  // present 与路由必须共用同一个 answer 实例：present 内部也通过 api.answer 落账，
  // 这样测试可以用 spy 证明工具层没有复制第二套回答路径。
  const api: Approvals = { present, answer }

  return api

  /**
   * 弹出原生问题卡片并等待人回答。
   *
   * 失败语义：
   * - 没有可信的根 Agent、requestId 不存在、宿主没有 userQuestions 服务：
   *   抛带 hint 的 TaktToolError，工具层会转成结构化结果；
   * - 卡片被取消/超时：不推进运行，抛 TAKT_RUN_BUSY 并提示重新发起或去面板；
   * - 人给出空答案（取消、跳过、超时、未选择）：安静返回，不落任何回答。
   */
  async function present(exec: ToolExecutionContext, space: SpaceHandle, requestId: string): Promise<void> {
    const agent = exec.agent
    if (agent === undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        '审批卡片必须由 Lead 会话的根 Agent 发起',
        '请从需求群里的 Lead 会话调用 takt_ask_human；人也可以直接在 dsh 主面板处理待办。',
      )
    }
    assertLiveRoot(deps.ctx, agent)

    const item = await findAttention(space, requestId)
    if (item === undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `待办不存在：${requestId}`,
        '先调用 takt_status 查看当前待办；不要自己编造 requestId。',
      )
    }
    // 已经回答过：不再弹卡片，也不重复推进。
    if (item.answeredAt !== undefined) return

    const questions = deps.ctx.userQuestions
    if (questions === undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `当前宿主没有 userQuestions 服务，无法弹出审批卡片（${requestId}）`,
        '请在 dsh 主面板的待办里处理该请求；处理后会唤醒运行。',
      )
    }

    // 先确认本宿主能写，避免人答完才发现空间被 CLI 占用。
    await deps.ownership.ensureLease(space)

    const snapshot = await space.stores.runs.getWorkflow(item.runId)
    const question = buildQuestion(item, snapshot)
    if (exec.signal.aborted) throw cancelledError()
    let result
    try {
      result = await questions.ask({ questions: [question], agent, signal: exec.signal })
    } catch (error) {
      if (exec.signal.aborted) throw cancelledError()
      throw error
    }
    // ask 正常 resolve 也可能发生在取消之后：此时绝不能把结果当成人的真实批准。
    if (exec.signal.aborted) throw cancelledError()

    // 只接受与本卡片 id 匹配的答案；无关卡片的答案一律忽略，不能拿来批准本待办。
    const userAnswer = result.answers.find((entry) => entry.id === question.id)
    const mapped = mapUserAnswer(item, userAnswer)
    // 取消、跳过、超时、空答案都不算批准；不落回答，运行保持等待。
    if (mapped === undefined) return

    await api.answer(space, {
      requestId: item.requestId,
      attempt: await currentAttempt(space, item),
      ...(mapped.decision === undefined ? {} : { decision: mapped.decision }),
      ...(mapped.answer === undefined ? {} : { answer: mapped.answer }),
      by: { type: 'human', id: user, via: 'dsh:user-questions' },
    })
  }

  /**
   * 落账一条审批回答并唤醒运行。
   *
   * - by 必须是 human；via 由调用方（present/路由）写入，不接受模型参数；
   * - 已回答：幂等返回已有结果，不调 onAnswered；
   * - attempt 与冻结值、subjects 最新版本任一不一致：TAKT_STALE_VERSION；
   * - 只有 approve 会批准；reject 会按 core 现有语义把节点记为失败；
   * - 落账成功后才调 runs.onAnswered；该调用失败时回答已经持久化，错误原样暴露。
   */
  async function answer(space: SpaceHandle, input: AnswerInput): Promise<AttentionItem> {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
      throw new ApprovalInputError('attempt 必须是非负整数', '重新读取待办后再回答。')
    }

    const key = `${space.root}\0${input.requestId}`
    const previous = inflight.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => answerOnce(space, input))
    inflight.set(key, task)
    try {
      return await task
    } finally {
      if (inflight.get(key) === task) inflight.delete(key)
    }
  }

  async function answerOnce(space: SpaceHandle, input: AnswerInput): Promise<AttentionItem> {
    const human = input.by
    assertHuman(human)
    const current = await findAttention(space, input.requestId)
    if (current === undefined) {
      throw new TaktToolError(
        'TAKT_NOT_BOUND',
        `待办不存在：${input.requestId}`,
        '先调用 takt_status 查看当前待办；不要自己编造 requestId。',
      )
    }
    // 已回答：幂等返回，不重复唤醒。
    if (current.answeredAt !== undefined) return current

    // 跨工厂/跨进程的检查-落账必须原子：同一空间的审批共用一把守卫锁。
    // 锁内重读、核对 freshness 并写入；onAnswered 在锁外，避免与引擎写锁嵌套。
    const guard = path.join(space.stores.taktDir, 'dsh', 'approvals.guard')
    const outcome = await withFileLock(guard, async (): Promise<{ item: AttentionItem; wrote: boolean }> => {
      const item = await findAttention(space, input.requestId)
      if (item === undefined) {
        throw new TaktToolError('TAKT_NOT_BOUND', `待办不存在：${input.requestId}`, '重新读取待办列表。')
      }
      if (item.answeredAt !== undefined) return { item, wrote: false }

      // 单写者：租约校验放在锁内、紧邻落账。
      await deps.ownership.ensureLease(space)

      const run = await space.stores.runs.get(item.runId)
      const node = run?.nodes[item.nodeId]
      if (run === undefined || node === undefined) {
        throw new TaktToolError(
          'TAKT_NOT_BOUND',
          `待办对应的运行或节点不存在：${item.runId}/${item.nodeId}`,
          '运行记录可能已被清理；重新发起运行。',
        )
      }
      if (run.status !== 'running' && run.status !== 'waiting_human') {
        throw new TaktToolError(
          'TAKT_RUN_BUSY',
          `运行已结束（${run.status}），不能再回答待办`,
          '重新发起运行；终态运行不会被回答唤醒。',
        )
      }
      // 待办必须对应当前仍在等待人工的节点；failed/succeeded/stale 等状态不能靠
      // 一条历史待办隐式推进，取消也不能被当成批准。
      if (node.status !== 'waiting_human') {
        throw new TaktToolError(
          'TAKT_RUN_BUSY',
          `节点当前不在等待人工回答（${node.status}），不能回答该待办`,
          '重新调用 takt_status 查看当前待办；历史待办不会推进运行。',
        )
      }
      // 同一节点可能有多轮待办：只有最新一条未回答的才是当前待办。
      const pendingForNode = (await space.stores.attention.list({ requirementId: item.requirementId }))
        .filter((entry) => entry.runId === item.runId && entry.nodeId === item.nodeId && entry.answeredAt === undefined)
      const latestPending = pendingForNode.at(-1)
      if (latestPending !== undefined && latestPending.requestId !== item.requestId) {
        throw staleError(`节点已有更新的待办：${latestPending.requestId}`)
      }

      // 冻结的 attempt 是创建待办时的尝试次数；历史待办没有该字段时退回当前节点尝试次数。
      const expectedAttempt = item.attempt ?? node.attempts
      if (input.attempt !== expectedAttempt) {
        throw staleError(`待办是第 ${expectedAttempt} 次尝试，回答带的是第 ${input.attempt} 次`)
      }
      assertArtifactVersion(item, input.artifactVersion)

      const latest = await latestSubjectRefs(space, item.subjects ?? [])
      const freshness = checkAnswerFreshness(item, node, latest)
      if (!freshness.ok) throw staleError(freshness.reason)

      const payload = validateAnswerInput(item, input)
      const by: Actor = {
        type: 'human',
        id: human.id,
        ...(human.via === undefined ? {} : { via: human.via }),
      }

      // 全部异步 freshness 读取已经结束；落账前紧邻再确认一次租约。
      // 否则“读取期间租约被释放、CLI 接管”时，本宿主仍会继续写入。
      // 释放侧同时拒绝 waiting_human 运行，双重收口这个交错窗口。
      await deps.ownership.ensureLease(space)

      try {
        return { item: await space.stores.attention.answer(item.requestId, { ...payload, by }), wrote: true }
      } catch (error) {
        // 另一个进程/请求已经先写入：返回已有结果，不重复推进。
        if (error instanceof AttentionAlreadyAnsweredError) {
          const existing = await findAttention(space, input.requestId)
          if (existing?.answeredAt !== undefined) return { item: existing, wrote: false }
        }
        throw error
      }
    })

    // 只有真正写入的那一次才唤醒运行，重复回答不会重复 onAnswered。
    if (outcome.wrote) await deps.runs.onAnswered(space, outcome.item)
    return outcome.item
  }
}

/**
 * 未接线宿主的占位实现。
 *
 * host/index.ts 在 Claude 整合前仍使用它；实现前必须显式失败，避免运行进入
 * “等人”后无人能答。真实实现走 createApprovals 工厂。
 */
export class PlaceholderApprovals implements Approvals {
  async present(
    _exec: ToolExecutionContext,
    _space: SpaceHandle,
    _requestId: string,
  ): Promise<void> {
    notImplemented('approvals.present')
  }

  async answer(_space: SpaceHandle, _input: AnswerInput): Promise<AttentionItem> {
    notImplemented('approvals.answer')
  }
}

function resolveUser(config?: { user?: string }): string {
  const configured = config?.user?.trim()
  return configured === undefined || configured === '' ? userInfo().username : configured
}

/** 只有当前存活的根 Agent 能发起人工交互；子 Agent 必须把问题带回 Lead。 */
function assertLiveRoot(ctx: ApprovalsDeps['ctx'], agent: Agent): void {
  if (ctx.agents.get(agent.id) !== agent) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '审批必须由当前存活的 Lead 根 Agent 发起',
      '从需求群的 Lead 会话重新调用 takt_ask_human。',
    )
  }
  if (!ctx.agents.roots().includes(agent)) {
    throw new TaktToolError(
      'TAKT_NOT_BOUND',
      '审批只能由根 Agent 发起，子 Agent 不能直接找人',
      '把需要人决定的问题带回 Lead 会话，由 Lead 调用 takt_ask_human。',
    )
  }
}

function assertHuman(by: Actor): asserts by is Extract<Actor, { type: 'human' }> {
  if (by.type !== 'human' || by.id.trim() === '') {
    throw new TaktToolError(
      'TAKT_FORBIDDEN_FOR_LEAD',
      '审批只能由人回答，Agent 不能代替人批准',
      '把决定交给人：由人在问题卡片或 dsh 主面板里回答。',
    )
  }
  if (by.via !== undefined && by.via.trim() === '') {
    throw new ApprovalInputError('via 必须是非空字符串', '入口由宿主写入，不要手工传空值。')
  }
}

async function findAttention(space: SpaceHandle, requestId: string): Promise<AttentionItem | undefined> {
  if (typeof requestId !== 'string' || requestId.trim() === '') return undefined
  return (await space.stores.attention.list()).find((item) => item.requestId === requestId)
}

/** 历史待办没有冻结 attempt 时，用当前节点尝试次数补齐，保证 answer 仍能核对。 */
async function currentAttempt(space: SpaceHandle, item: AttentionItem): Promise<number> {
  if (item.attempt !== undefined) return item.attempt
  const run = await space.stores.runs.get(item.runId)
  return run?.nodes[item.nodeId]?.attempts ?? 0
}

/** 冻结的 subjects 逐项取最新版本；找不到的条目保留 undefined，交给 freshness 拒绝。 */
async function latestSubjectRefs(space: SpaceHandle, subjects: readonly ArtifactRef[]): Promise<ArtifactRef[]> {
  const cache = new Map<string, ArtifactRecord[]>()
  const refs: ArtifactRef[] = []
  for (const subject of subjects) {
    let records = cache.get(subject.workspace)
    if (records === undefined) {
      records = await space.stores.workspaces.listArtifacts(subject.workspace)
      cache.set(subject.workspace, records)
    }
    const record = records.find((entry) => entry.path === subject.path)
    refs.push({ workspace: subject.workspace, path: subject.path, version: record?.versions.at(-1)?.version })
  }
  return refs
}

/**
 * artifactVersion 是调用方对待审版本的额外声明。
 *
 * 冻结的 subjects 可能有多个，但输入只有一个版本号；这里只核对主产物（第一个
 * subject）。多产物的过期判断仍由 checkAnswerFreshness 逐项完成。
 */
function assertArtifactVersion(item: AttentionItem, artifactVersion: number | undefined): void {
  if (artifactVersion === undefined) return
  if (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1) {
    throw new ApprovalInputError('artifactVersion 必须是正整数', '去掉该字段，或传待办里冻结的版本号。')
  }
  const primary = item.subjects?.[0]
  if (primary === undefined) {
    throw staleError('待办没有冻结产物，无法按 artifactVersion 批准')
  }
  if (primary.version !== artifactVersion) {
    throw staleError(`待办冻结的是 ${primary.path} v${primary.version ?? '未知'}，回答带的是 v${artifactVersion}`)
  }
}

/** 回答形状按待办表单校验；只有 approve 才算批准。 */
function validateAnswerInput(item: AttentionItem, input: AnswerInput): { decision?: string; answer?: string } {
  if (item.form === 'approve') {
    if (input.decision !== 'approve' && input.decision !== 'reject') {
      throw new ApprovalInputError(
        `审批待办只接受 approve 或 reject，收到 ${input.decision ?? '空决定'}`,
        '取消、跳过、超时和空答案都不算批准；请明确选择批准或打回。',
      )
    }
    const note = input.answer?.trim()
    return { decision: input.decision, ...(note === undefined || note === '' ? {} : { answer: note }) }
  }

  if (item.form === 'choice') {
    if (input.decision !== 'choice') {
      throw new ApprovalInputError('选项待办只接受 choice 回答', '请选择一个选项。')
    }
    if (input.answer === undefined || !(item.choices ?? []).includes(input.answer)) {
      throw new ApprovalInputError(
        `回答必须是以下选项之一：${(item.choices ?? []).join(', ')}`,
        '重新读取待办后再选择。',
      )
    }
    return { decision: 'choice', answer: input.answer }
  }

  if (input.decision !== undefined) {
    throw new ApprovalInputError('文本待办不接受 decision', '只提交 answer 文本。')
  }
  const text = input.answer?.trim()
  if (text === undefined || text === '') {
    throw new ApprovalInputError('回答不能为空', '空答案不会推进运行；请填写回答。')
  }
  return { answer: text }
}

/** 把 dsh 的选项/自定义文本映射成待办决定；返回 undefined 表示不推进。 */
function mapUserAnswer(
  item: AttentionItem,
  answer: UserAnswer | undefined,
): { decision?: string; answer?: string } | undefined {
  if (answer === undefined) return undefined
  const selected = answer.selected.map((label) => label.trim()).filter((label) => label !== '')
  const custom = answer.custom?.trim()

  if (item.form === 'approve') {
    // 只认识批准/打回两个选项；混入其它选项说明答案不属于本卡片，不能默认批准。
    const known = selected.every((label) => label === APPROVE_LABEL || label === REJECT_LABEL)
    if (!known) return undefined
    const approve = selected.includes(APPROVE_LABEL)
    const reject = selected.includes(REJECT_LABEL)
    if (approve && reject) return undefined
    if (approve) return { decision: 'approve', ...(custom === undefined || custom === '' ? {} : { answer: custom }) }
    if (reject) return { decision: 'reject', ...(custom === undefined || custom === '' ? {} : { answer: custom }) }
    // 只填了意见、没有点选项：按打回处理；绝不把自定义文本当成批准。
    if (custom !== undefined && custom !== '') return { decision: 'reject', answer: custom }
    return undefined
  }

  if (item.form === 'choice') {
    const choice = custom !== undefined && custom !== '' ? custom : selected[0]
    return choice === undefined || choice === '' ? undefined : { decision: 'choice', answer: choice }
  }

  const text = custom !== undefined && custom !== '' ? custom : selected[0]
  return text === undefined || text === '' ? undefined : { answer: text }
}

/** 卡片内容必须来自待办冻结的真实产物和版本，并写清 approve/reject 的真实后果。 */
function buildQuestion(item: AttentionItem, snapshot: WorkflowSnapshot | undefined): UserQuestion {
  const subjects = item.subjects ?? []
  const frozen = subjects.length === 0
    ? '（历史待办没有记录冻结产物）'
    : subjects.map((subject) => `- ${subject.path}${subject.version === undefined ? '（未记录版本）' : ` v${subject.version}`}`).join('\n')
  const next = downstreamNodes(snapshot, item.nodeId)
  const continueText = next.length === 0
    ? '运行继续执行后续步骤。'
    : `运行继续执行：${next.map((node) => `${node.id}（${node.title}）`).join('、')}。`
  const lines = [
    `运行：${item.runId}`,
    `节点：${item.nodeId}${item.attempt === undefined ? '' : `（第 ${item.attempt} 次尝试）`}`,
    `冻结产物：\n${frozen}`,
  ]
  if (item.form === 'approve') {
    lines.push(`批准后：${continueText}`)
    // core 当前把 reject 记为节点失败，不会自动回到上一步；卡片必须如实说明。
    lines.push('打回：该节点会被标记为失败，运行以失败结束，不会自动回到上一步；请在意见里写明修改要求，修改后需要重新发起运行。')
  } else {
    lines.push(`回答后：${continueText}`)
  }
  lines.push('取消、跳过、超时和空答案都不算批准，运行会保持等待。')

  return {
    id: item.requestId,
    header: 'taktflow 审批',
    question: item.ask,
    detail: lines.join('\n'),
    ...(item.form === 'approve'
      ? {
          options: [
            { label: APPROVE_LABEL, description: '按冻结版本批准，运行继续' },
            { label: REJECT_LABEL, description: '打回；该节点记为失败，运行结束（可附意见）' },
          ],
        }
      : item.form === 'choice' && item.choices !== undefined
        ? { options: item.choices.map((label) => ({ label })) }
        : {}),
  }
}

/** 从运行快照里找直接依赖当前节点的下游节点；历史运行没有快照时返回空。 */
function downstreamNodes(snapshot: WorkflowSnapshot | undefined, nodeId: string): WorkflowSnapshot['nodes'] {
  if (snapshot === undefined) return []
  return snapshot.nodes.filter((node) => (node.needs ?? []).includes(nodeId))
}

function cancelledError(): TaktToolError {
  return new TaktToolError(
    'TAKT_RUN_BUSY',
    '审批卡片已取消，运行仍在等待',
    '重新调用 takt_ask_human，或到 dsh 主面板处理待办。',
  )
}

function staleError(reason: string): TaktToolError {
  return new TaktToolError(
    'TAKT_STALE_VERSION',
    `待审内容已变化：${reason}`,
    '重新调用 takt_ask_human 获取最新卡片，或到 dsh 主面板处理最新待办。',
  )
}

/** 供测试与诊断复用：节点状态是否仍允许回答。 */
export function answerableNode(node: NodeState | undefined): node is NodeState {
  return node !== undefined && node.status === 'waiting_human'
}
