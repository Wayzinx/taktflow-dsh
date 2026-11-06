import { lstat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import {
  AttentionAlreadyAnsweredError,
  assertNoSymlinks,
  canonicalJson,
  checkAnswerFreshness,
  sha256,
  type Actor,
  type ArtifactRecord,
  type ArtifactRef,
  type AttentionItem,
  type Expansion,
  type NodeState,
  type SnapshotNode,
  type WorkflowSnapshot,
  withFileLock,
} from '@taktflow/core'
import { bindingActor } from './bindings.js'
import type { Agent, HostContext, ToolExecutionContext, UserAnswer, UserQuestion } from './dsh-types.js'
import { notImplemented } from './errors.js'
import {
  TaktToolError,
  type AgentDecisionInput,
  type AgentDecisionResult,
  type AnswerInput,
  type Approvals,
  type Ownership,
  type RunManager,
  type SpaceHandle,
} from './types.js'

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
  // 人工回答与 AI 代答共用同一条串行队列：同 requestId 的“重读 + 落账”不会交叉。
  const inflight = new Map<string, Promise<unknown>>()
  // present 与路由必须共用同一个 answer 实例：present 内部也通过 api.answer 落账，
  // 这样测试可以用 spy 证明工具层没有复制第二套回答路径。
  const api: Approvals = { present, answer, answerAsAgent }

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
    // AI 升级过的待办要让人一眼看到“为什么升级、还差什么”，不能只复述原问题。
    const escalation = await latestEscalation(space, item)
    const question = buildQuestion(item, snapshot, escalation)
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
    // 串行队列只包“重读 + 落账”；唤醒运行必须在队列释放后进行。否则真人先
    // 落账后 await record.task，而同一 requestId 的 AI 落账排在真人 promise
    // 后面，会形成互相等待。
    const outcome = await serialized(space, input.requestId, () => answerPersist(space, input))
    if (outcome.wrote) await deps.runs.onAnswered(space, outcome.item)
    return outcome.item
  }

  /** 同一空间、同一 requestId 的落账串行化；人工与 AI 共用。 */
  function serialized<T>(space: SpaceHandle, requestId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${space.root}\0${requestId}`
    const previous = inflight.get(key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    inflight.set(key, task)
    return task.finally(() => {
      if (inflight.get(key) === task) inflight.delete(key)
    })
  }

  async function answerPersist(space: SpaceHandle, input: AnswerInput): Promise<{ item: AttentionItem; wrote: boolean }> {
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
    if (current.answeredAt !== undefined) return { item: current, wrote: false }

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

    return outcome
  }

  /**
   * AI 自主代答：落账 + 留痕，但不调用 runs.onAnswered。
   *
   * 调用方：RunManager 在引擎本轮收敛到 waiting_human 后调用；随后直接
   * `engine.resume` 消费回答。与人工 answer 共用同一把守卫锁、attempt/
   * freshness/lease 检查和串行队列，人抢先回答时不会覆盖。
   */
  async function answerAsAgent(space: SpaceHandle, input: AgentDecisionInput): Promise<AgentDecisionResult> {
    validateAgentInput(input)
    assertAgentLive(input)
    return serialized(space, input.requestId, () => autoOnce(space, input))
  }

  async function autoOnce(space: SpaceHandle, input: AgentDecisionInput): Promise<AgentDecisionResult> {
    const agent = input.by
    const current = await findAttention(space, input.requestId)
    if (current === undefined) {
      throw new TaktToolError('TAKT_NOT_BOUND', `待办不存在：${input.requestId}`, '重新读取待办列表。')
    }
    // 模型调用期间运行可能已被取消或产物被更新；锁外先快速失败，锁内再核对。
    assertAgentLive(input)
    await assertHumanSnapshot(space, current)
    await assertBasisFresh(space, input, current)
    const trusted = await trustedHumanFor(space, current.requirementId, deps.config?.user)
    if (agent.onBehalfOf !== trusted.id) {
      throw new TaktToolError(
        'TAKT_FORBIDDEN_FOR_LEAD',
        `AI 代答必须代表需求绑定的人（${trusted.id}），收到 ${agent.onBehalfOf ?? '空'}`,
        '不要手工构造 onBehalfOf；由运行层从 bindings.json 读取。',
      )
    }

    const guard = path.join(space.stores.taktDir, 'dsh', 'approvals.guard')
    const outcome = await withFileLock(guard, async (): Promise<{
      item: AttentionItem
      artifact?: ArtifactRef & { version: number }
      answered: boolean
    }> => {
      const item = await findAttention(space, input.requestId)
      if (item === undefined) {
        throw new TaktToolError('TAKT_NOT_BOUND', `待办不存在：${input.requestId}`, '重新读取待办列表。')
      }
      // 人已经在锁外回答：不写第二份决定，也不覆盖真人答案。
      if (item.answeredAt !== undefined) return { item, answered: false }

      await deps.ownership.ensureLease(space)
      assertAgentLive(input)
      await assertHumanSnapshot(space, item)
      await assertBasisFresh(space, input, item)

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
        throw new TaktToolError('TAKT_RUN_BUSY', `运行已结束（${run.status}），不能再回答待办`, '重新发起运行。')
      }
      if (node.status !== 'waiting_human') {
        throw new TaktToolError(
          'TAKT_RUN_BUSY',
          `节点当前不在等待人工回答（${node.status}），不能回答该待办`,
          '重新调用 takt_status 查看当前待办。',
        )
      }
      const pendingForNode = (await space.stores.attention.list({ requirementId: item.requirementId }))
        .filter((entry) => entry.runId === item.runId && entry.nodeId === item.nodeId && entry.answeredAt === undefined)
      const latestPending = pendingForNode.at(-1)
      if (latestPending !== undefined && latestPending.requestId !== item.requestId) {
        throw staleError(`节点已有更新的待办：${latestPending.requestId}`)
      }

      const expectedAttempt = item.attempt ?? node.attempts
      if (input.attempt !== expectedAttempt) {
        throw staleError(`待办是第 ${expectedAttempt} 次尝试，回答带的是第 ${input.attempt} 次`)
      }
      assertArtifactVersion(item, input.artifactVersion)

      const latest = await latestSubjectRefs(space, item.subjects ?? [])
      const freshness = checkAnswerFreshness(item, node, latest)
      if (!freshness.ok) throw staleError(freshness.reason)

      assertAgentDecision(item, input)
      const payload = agentPayload(item, input)
      // 依据产物必须仍是 AI 声称读到的版本；升级路径允许证据缺失/失效。
      if (input.disposition !== 'escalate') {
        await assertEvidenceFresh(space, item.requirementId, input.evidence)
      }

      // 全部异步读取结束；写产物前紧邻再确认租约与取消。
      await deps.ownership.ensureLease(space)
      assertAgentLive(input)
      const actor: Actor = {
        type: 'agent',
        role: agent.role,
        harness: agent.harness,
        ...(agent.model === undefined ? {} : { model: agent.model }),
        onBehalfOf: trusted.id,
      }
      const content = renderDecision(item, input, trusted, actor)
      const artifact = await space.stores.workspaces.writeArtifact({
        ref: { workspace: item.requirementId, path: autoAnswerPath(item.requestId) },
        content,
        kind: 'decision',
        author: actor,
        reason: `自主${input.disposition === 'escalate' ? '升级' : '代答'}：${input.rationale}`,
        derivedFrom: input.evidence.map((ref) => ({ ...ref })),
        producedBy: { runId: item.runId, nodeId: item.nodeId },
        title: `自主审批记录 ${item.requestId}`,
      })
      // 写产物期间可能已经取消；事件落盘前再查一次。
      assertAgentLive(input)
      await space.stores.events.append(item.runId, {
        type: 'artifact.written',
        nodeId: item.nodeId,
        actor,
        data: {
          ref: { workspace: artifact.workspace, path: artifact.path, version: artifact.version },
          kind: 'decision',
          sha256: sha256(content),
        },
      })

      if (input.disposition === 'escalate') return { item, artifact, answered: false }

      // 写产物期间证据可能被更新；落回答前再核一次，并再次确认取消/租约。
      assertAgentLive(input)
      await assertBasisFresh(space, input, item)
      await assertEvidenceFresh(space, item.requirementId, input.evidence)
      await deps.ownership.ensureLease(space)
      // ensureLease 本身是 await：租约检查期间可能刚好 abort，落回答前必须再查。
      assertAgentLive(input)
      try {
        return { item: await space.stores.attention.answer(item.requestId, { ...payload, by: actor }), artifact, answered: true }
      } catch (error) {
        if (error instanceof AttentionAlreadyAnsweredError) {
          const existing = await findAttention(space, input.requestId)
          if (existing?.answeredAt !== undefined) return { item: existing, artifact, answered: false }
        }
        throw error
      }
    })

    return {
      disposition: input.disposition,
      item: outcome.item,
      answered: outcome.answered,
      ...(outcome.artifact === undefined ? {} : { artifact: outcome.artifact }),
    }
  }
}

/** AI 代答的最低置信度：文本回答 0.8，准出批准 0.9。 */
const AUTO_ANSWER_MIN_CONFIDENCE = 0.8
const AUTO_APPROVE_MIN_CONFIDENCE = 0.9

function validateAgentInput(input: AgentDecisionInput): void {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    throw new ApprovalInputError('attempt 必须是非负整数', '重新读取待办后再回答。')
  }
  if (!['answer', 'approve', 'escalate'].includes(input.disposition)) {
    throw new ApprovalInputError(`不支持的自主处置：${String(input.disposition)}`)
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new ApprovalInputError('confidence 必须是 0..1 的有限数值')
  }
  if (!Array.isArray(input.blockers) || !input.blockers.every((item) => typeof item === 'string')) {
    throw new ApprovalInputError('blockers 必须是字符串数组')
  }
  if (!Array.isArray(input.unresolved) || !input.unresolved.every((item) => typeof item === 'string')) {
    throw new ApprovalInputError('unresolved 必须是字符串数组')
  }
  if (typeof input.rationale !== 'string' || input.rationale.trim() === '') {
    throw new ApprovalInputError('rationale 不能为空', '说明判断依据；证据不足时输出 escalate。')
  }
  if (!Array.isArray(input.evidence)) throw new ApprovalInputError('evidence 必须是数组')
  for (const ref of input.evidence) {
    if (typeof ref.workspace !== 'string' || ref.workspace.trim() === ''
      || typeof ref.path !== 'string' || ref.path.trim() === ''
      || !Number.isSafeInteger(ref.version) || (ref.version ?? 0) < 1) {
      throw new ApprovalInputError('evidence 每一项必须是带 workspace/path/正整数 version 的产物引用')
    }
  }
  if (input.by.type !== 'agent' || input.by.role.trim() === '') {
    throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', 'AI 代答必须由职责 Agent 发起')
  }
  if (input.by.harness !== 'dsh-host') {
    throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', 'AI 代答只允许 dsh-host 子 Agent', '由运行层使用 App 模型执行自主审批。')
  }
  if (input.by.onBehalfOf === undefined || input.by.onBehalfOf.trim() === '') {
    throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', 'AI 代答缺少 onBehalfOf', '由运行层从需求绑定记录读取真实人。')
  }
}

/** 表单、角色和处置必须严格对应；review/judge/choice 不走 AI 代答。 */
function assertAgentDecision(item: AttentionItem, input: AgentDecisionInput): void {
  if (item.form === 'choice') {
    throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', '选项待办必须由人回答，AI 不能替人做选择')
  }
  const expectedRole = item.form === 'answer' ? 'pm' : 'release-reviewer'
  if (input.by.role !== expectedRole) {
    throw new TaktToolError(
      'TAKT_FORBIDDEN_FOR_LEAD',
      `${item.form} 待办只能由 ${expectedRole} 自主处理，收到 ${input.by.role}`,
      '由运行层按节点表单选择固定角色。',
    )
  }
  if (input.disposition === 'answer' && item.form !== 'answer') {
    throw new ApprovalInputError('文本回答只能用于 answer 待办')
  }
  if (input.disposition === 'approve' && item.form !== 'approve') {
    throw new ApprovalInputError('批准只能用于 approve 待办')
  }
  if (input.disposition === 'escalate') return
  if (input.blockers.some((entry) => entry.trim() !== '') || input.unresolved.some((entry) => entry.trim() !== '')) {
    throw new ApprovalInputError('仍有 blocker 或未解决项时不能自主回答', '输出 escalate 交给人。')
  }
  const threshold = input.disposition === 'approve' ? AUTO_APPROVE_MIN_CONFIDENCE : AUTO_ANSWER_MIN_CONFIDENCE
  if (input.confidence < threshold) {
    throw new ApprovalInputError(`置信度 ${input.confidence} 低于自主处置阈值 ${threshold}`, '输出 escalate 交给人。')
  }
  if (input.disposition === 'approve' && input.evidence.length === 0) {
    throw new ApprovalInputError('准出必须至少引用一条冻结产物')
  }
}

function agentPayload(item: AttentionItem, input: AgentDecisionInput): { decision?: string; answer?: string } {
  if (input.disposition === 'escalate') return {}
  if (input.disposition === 'answer') {
    const text = input.answer?.trim()
    if (text === undefined || text === '') throw new ApprovalInputError('AI 文本回答不能为空')
    return { answer: text }
  }
  const note = input.answer?.trim()
  return {
    decision: 'approve',
    ...(note === undefined || note === '' ? {} : { answer: note }),
  }
}

async function trustedHumanFor(
  space: SpaceHandle,
  requirementId: string,
  configUser: string | undefined,
): Promise<{ id: string; source: 'binding' | 'config' }> {
  const bound = await bindingActor(space, requirementId)
  if (bound !== undefined) return { id: bound.id, source: 'binding' }
  const configured = configUser?.trim()
  if (configured !== undefined && configured !== '') return { id: configured, source: 'config' }
  throw new TaktToolError(
    'TAKT_NOT_BOUND',
    `无法确认需求 ${requirementId} 绑定的人`,
    '先由人在 Lead 会话里绑定需求，或在宿主配置 user；AI 不能凭空指定代表。',
  )
}

/**
 * 依据产物必须仍是 AI 声称读到的版本。
 *
 * 这里只接受明确版本号：没有版本就无法证明 AI 读的是哪一版，按证据不足拒绝。
 */
async function assertEvidenceFresh(space: SpaceHandle, requirementId: string, evidence: readonly ArtifactRef[]): Promise<void> {
  if (evidence.length === 0) return
  const records = await space.stores.workspaces.listArtifacts(requirementId)
  const byPath = new Map(records.map((record) => [record.path, record]))
  for (const ref of evidence) {
    if (ref.workspace !== requirementId) {
      throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `证据引用了其它需求：${ref.workspace}/${ref.path}`)
    }
    const record = byPath.get(ref.path)
    if (record === undefined) throw staleError(`证据产物不存在：${ref.path}`)
    const latest = record.versions.at(-1)?.version
    if (ref.version === undefined) throw staleError(`证据没有冻结版本：${ref.path}`)
    if (latest !== ref.version) {
      throw staleError(`证据已有更新版本：${ref.path}（AI 读的是 v${ref.version}，当前 v${latest ?? '未知'}）`)
    }
  }
}

/** 自主落账的取消谓词；每个持久化点前都要确认运行没有停止。 */
function assertAgentLive(input: AgentDecisionInput): void {
  if (input.signal?.aborted === true) {
    throw new TaktToolError('TAKT_RUN_BUSY', '自主代答已取消，不能继续落账', '等待运行重新进入可处理状态。')
  }
}

/**
 * 当前需求全部产物的最新版本清单。
 *
 * 排除本次 AI 自己写入的决策产物，避免“落账后再核依据”把自己当成新增 blocker；
 * 其他任何新增、删除或版本变化都说明模型依据已经过期。
 */
async function artifactBasis(space: SpaceHandle, requirementId: string, excludePath: string): Promise<ArtifactRef[]> {
  const records = (await space.stores.workspaces.listArtifacts(requirementId))
    .filter((record) => record.versions.length > 0 && record.path !== excludePath)
    .sort((left, right) => left.path.localeCompare(right.path))
  return records.map((record) => ({ workspace: requirementId, path: record.path, version: record.versions.at(-1)!.version }))
}

/**
 * 运行层冻结的全体依据必须与当前产物集合完全一致。
 *
 * 只挑几条没变化的 evidence 不足以证明审批依据仍然有效：新增报告、删除评审记录
 * 或任一版本变化都必须让 AI 升级给人，而不是按旧快照批准。
 */
async function assertBasisFresh(space: SpaceHandle, input: AgentDecisionInput, item: AttentionItem): Promise<void> {
  if (input.disposition === 'escalate') return
  const excludePath = autoAnswerPath(item.requestId)
  if (input.basis !== undefined || input.basisDigest !== undefined) {
    if (input.basis === undefined || input.basisDigest === undefined) {
      throw new ApprovalInputError('basis 与 basisDigest 必须同时提供')
    }
    const current = await artifactBasis(space, item.requirementId, excludePath)
    const normalized = [...input.basis].sort((left, right) => left.path.localeCompare(right.path))
    if (sha256(canonicalJson(current)) !== input.basisDigest || canonicalJson(current) !== canonicalJson(normalized)) {
      throw staleError('自主判定期间产物集合或版本发生变化，不能按旧依据落账')
    }
  }
  // 清单只能证明已登记版本；工作副本被直接改/删或出现未登记文件同样会让
  // “当前批准依据”失效。这里逐项确认登记产物仍在磁盘上，并复用 core 的
  // detectUntracked 检测未登记改动；只排除本次即将写入的 auto-answer 记录。
  await assertWorkspaceFilesFresh(space, item.requirementId, excludePath)
}

/**
 * 工作区文件与 manifest 的一致性校验。
 *
 * - 已登记产物被删除：listArtifacts 仍有记录，但工作副本不存在，必须过期；
 * - 已登记产物被直接改：detectUntracked 会报 sha 不一致；
 * - 新增未登记文件（例如评审期间人补的 blocker）：同样不能被当成旧依据批准。
 *
 * 内容对象库（readArtifact 带 version）不受工作副本影响，因此这里查磁盘副本；
 * 只读 manifest 无法发现这些变化，不能只做版本集合比较。
 */
async function assertWorkspaceFilesFresh(space: SpaceHandle, requirementId: string, excludePath: string): Promise<void> {
  const records = await space.stores.workspaces.listArtifacts(requirementId)
  const dir = space.stores.workspaces.dir(requirementId)
  for (const record of records) {
    if (record.versions.length === 0) continue
    const file = path.join(dir, record.path)
    try {
      await assertNoSymlinks(space.root, file)
      await lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw staleError(`工作副本已删除：${record.path}`)
      }
      throw error
    }
  }
  const untracked = await space.stores.workspaces.detectUntracked(requirementId)
  const dirty = untracked.filter((entry) => entry.path !== excludePath)
  if (dirty.length > 0) {
    throw staleError(`工作区出现未登记或被直接修改的文件：${dirty.map((entry) => entry.path).join('、')}`)
  }
}

/**
 * 落账前核验实际运行快照：只有普通 human 节点允许 AI 代答。
 *
 * planner 动态展开的节点只存在于运行状态 `expansions[].nodes`，静态 workflow
 * 快照里查不到；两者必须统一解析，否则合法动态 human 会被当成未知类型拒绝。
 */
async function assertHumanSnapshot(space: SpaceHandle, item: AttentionItem): Promise<void> {
  const snapshot = await space.stores.runs.getWorkflow(item.runId)
  if (snapshot === undefined) {
    throw new TaktToolError('TAKT_NOT_BOUND', `运行没有冻结的流程快照：${item.runId}`, '重新启动运行后再自主处理。')
  }
  const state = await space.stores.runs.get(item.runId)
  const kind = snapshotNodeKind(snapshot.nodes, item.nodeId) ?? expansionNodeKind(state?.expansions, item.nodeId)
  if (kind !== 'human') {
    throw new TaktToolError(
      'TAKT_FORBIDDEN_FOR_LEAD',
      `自主代答只处理普通 human 节点，${item.nodeId} 的实际类型是 ${kind ?? '未知'}`,
      '评审签字、裁决和选项待办必须由人处理。',
    )
  }
}

function snapshotNodeKind(nodes: readonly SnapshotNode[], nodeId: string, prefix = ''): SnapshotNode['kind'] | undefined {
  for (const node of nodes) {
    const id = `${prefix}${node.id}`
    if (id === nodeId) return node.kind
    if (node.kind === 'loop' && node.body !== undefined) {
      const nested = snapshotNodeKind(node.body, nodeId, `${id}/`)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** planner 动态展开节点：id 已带 `planner/item/` 前缀，直接按运行状态查。 */
function expansionNodeKind(expansions: readonly Expansion[] | undefined, nodeId: string): SnapshotNode['kind'] | undefined {
  for (const expansion of expansions ?? []) {
    const match = (expansion.nodes ?? []).find((node) => node.id === nodeId)
    if (match !== undefined) return match.kind
  }
  return undefined
}

/** requestId 含冒号/斜杠/井号；文件名安全编码并追加哈希，避免碰撞。 */
export function autoAnswerPath(requestId: string): string {
  const readable = requestId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  return `decisions/auto-answers/${readable}-${sha256(requestId).slice(0, 12)}.md`
}

function renderDecision(
  item: AttentionItem,
  input: AgentDecisionInput,
  trusted: { id: string; source: 'binding' | 'config' },
  actor: Extract<Actor, { type: 'agent' }>,
): string {
  const evidence = input.evidence.length === 0
    ? '（无）'
    : input.evidence.map((ref) => `- ${ref.path} v${ref.version}`).join('\n')
  const blockers = input.blockers.length === 0 ? '（无）' : input.blockers.map((entry) => `- ${entry}`).join('\n')
  const unresolved = input.unresolved.length === 0 ? '（无）' : input.unresolved.map((entry) => `- ${entry}`).join('\n')
  return [
    '# 自主审批记录',
    '',
    `- 待办：\`${item.requestId}\``,
    `- 运行：${item.runId}`,
    `- 节点：${item.nodeId}（第 ${input.attempt} 次尝试）`,
    `- 表单：${item.form}`,
    `- 处置：${input.disposition}`,
    `- 置信度：${input.confidence}`,
    `- 代表：${trusted.id}（来源：${trusted.source}）`,
    `- 角色：${actor.role}`,
    `- harness：${actor.harness}`,
    ...(actor.model === undefined ? [] : [`- 模型：${actor.model}`]),
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 回答',
    '',
    input.disposition === 'escalate' ? '（升级给人，未落回答）' : (input.answer?.trim() || '（无文字说明）'),
    '',
    '## 依据产物',
    '',
    evidence,
    '',
    '## Blocker',
    '',
    blockers,
    '',
    '## 未解决项',
    '',
    unresolved,
    '',
    '## 理由',
    '',
    input.rationale.trim(),
    '',
  ].join('\n')
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

interface EscalationSummary {
  reason: string
  blockers: string[]
  unresolved: string[]
  /** 决策产物路径与版本；takt_status 用它证明升级来自真实持久化记录。 */
  source: string
}

/**
 * 读取本待办最近一次 AI 升级记录；没有或不是升级时返回 undefined。
 *
 * 导出给 takt_status 复用：升级原因必须来自真实决策产物，不能靠
 * “handling=human”推断；source 同时可作为人核对用的产物引用。
 */
export async function escalationForRequest(
  space: SpaceHandle,
  item: AttentionItem,
): Promise<EscalationSummary | undefined> {
  const decisionPath = autoAnswerPath(item.requestId)
  try {
    const record = (await space.stores.workspaces.listArtifacts(item.requirementId))
      .find((entry) => entry.path === decisionPath && entry.versions.length > 0)
    if (record === undefined) return undefined
    const version = record.versions.at(-1)!.version
    const ref: ArtifactRef = { workspace: item.requirementId, path: decisionPath, version }
    const text = (await space.stores.workspaces.readArtifact(ref))?.toString('utf8') ?? ''
    if (!text.includes('处置：escalate')) return undefined
    const reason = markdownSection(text, '理由')
    const blockers = markdownList(text, 'Blocker')
    const unresolved = markdownList(text, '未解决项')
    return {
      reason: reason === '' ? '自主审批未给出升级理由' : reason,
      blockers,
      unresolved,
      source: `${decisionPath}@v${version}`,
    }
  } catch {
    // 升级记录是旁路信息；读取失败不能阻止人打开正常审批卡。
    return undefined
  }
}

async function latestEscalation(space: SpaceHandle, item: AttentionItem): Promise<EscalationSummary | undefined> {
  return escalationForRequest(space, item)
}

function markdownSection(text: string, heading: string): string {
  const marker = `## ${heading}\n\n`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const rest = text.slice(start + marker.length)
  const end = rest.indexOf('\n## ')
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

function markdownList(text: string, heading: string): string[] {
  return markdownSection(text, heading)
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter((line) => line !== '' && line !== '（无）')
}

/** 卡片内容必须来自待办冻结的真实产物和版本，并写清 approve/reject 的真实后果。 */
function buildQuestion(
  item: AttentionItem,
  snapshot: WorkflowSnapshot | undefined,
  escalation?: EscalationSummary,
): UserQuestion {
  const subjects = item.subjects ?? []
  const frozen = subjects.length === 0
    ? '（历史待办没有记录冻结产物）'
    : subjects.map((subject) => `- ${subject.path}${subject.version === undefined ? '（未记录版本）' : ` v${subject.version}`}`).join('\n')
  const next = downstreamNodes(snapshot, item.nodeId)
  const continueText = next.length === 0
    ? '运行继续执行后续步骤。'
    : `运行继续执行：${next.map((node) => `${node.id}（${node.title}）`).join('、')}。`
  const node = snapshotNode(snapshot?.nodes, item.nodeId)
  const lines = [
    `运行：${item.runId}`,
    `节点：${item.nodeId}${node === undefined ? '' : `（${node.title}）`}${item.attempt === undefined ? '' : `，第 ${item.attempt} 次尝试`}`,
    `冻结产物：\n${frozen}`,
  ]
  if (escalation !== undefined) {
    // 只保留人做决定需要的上下文：哪一步、为什么升级、还差什么。
    lines.push(`AI 自主审批已升级：${truncateText(escalation.reason, 240)}`)
    if (escalation.blockers.length > 0) lines.push(`Blocker：${truncateText(escalation.blockers.join('；'), 200)}`)
    if (escalation.unresolved.length > 0) lines.push(`未解决项：${truncateText(escalation.unresolved.join('；'), 200)}`)
  }
  if (item.form === 'approve') {
    lines.push(`批准后：${continueText}`)
    // core 当前把 reject 记为节点失败，不会自动回到上一步；卡片必须如实说明。
    lines.push('打回：该节点会被标记为失败，运行以失败结束，不会自动回到上一步；请在意见里写明修改要求，修改后需要重新发起运行。')
  } else if (item.form === 'choice') {
    // 选项的真实语义由流程决定：可能继续、终止或打回，不能统一写成“继续运行”。
    lines.push('选择后：流程按所选选项处理，可能继续、终止或打回，不是所有选项都会继续运行。')
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

/** 在快照（含 loop body）里找节点；动态展开节点不在静态快照中，返回 undefined。 */
function snapshotNode(nodes: readonly SnapshotNode[] | undefined, nodeId: string, prefix = ''): SnapshotNode | undefined {
  for (const node of nodes ?? []) {
    const id = `${prefix}${node.id}`
    if (id === nodeId) return node
    if (node.kind === 'loop' && node.body !== undefined) {
      const nested = snapshotNode(node.body, nodeId, `${id}/`)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function truncateText(text: string, max: number): string {
  const chars = Array.from(text.trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
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
