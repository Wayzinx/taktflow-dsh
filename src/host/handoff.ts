import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Agent, DefineToolOptions, HostContext, ToolExecutionContext } from './dsh-types.js'
import { LEAD_PRESET, type SessionControllerService } from './lead-ask.js'

/**
 * “交给 Taktflow”：普通会话（标准模式等）里的 Agent 遇到需求开发类任务时，征得用户同意后把需求转交给
 * Taktflow 流水线——在空间目录新开一个 taktflow 会话，由 Lead 建需求、绑定仓库、启动流程。
 *
 * 宿主行注册为全局工具；Lead 与职责角色的会话各自用 tools.restrict 隐藏它（它们本身就在流水线里）。
 * 同意由工具自己弹原生卡片取得，模型不能代替用户同意；不同意就在原会话继续，不会自动接管。
 */
export const HANDOFF_TOOL_NAME = 'taktflow_handoff'
const AGREE = '交给 Taktflow'
const DECLINE = '不用，在这里继续'

export interface HandoffDeps {
  ctx: Pick<HostContext, 'agents' | 'get'>
}

function presetOf(agent: Agent): string | undefined {
  const presets = agent.ctx?.get('agentPresets') as { composedPreset?(ctx: unknown): string | undefined } | undefined
  return presets?.composedPreset?.(agent.ctx) ?? agent.session.header.agentPreset
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function createHandoffTool(deps: HandoffDeps): DefineToolOptions {
  return {
    name: HANDOFF_TOOL_NAME,
    description: [
      '把一个软件开发需求交给 Taktflow 交付流水线：新开一个 Taktflow 会话，由 Lead 建需求、绑定代码仓库，按“需求澄清 → PRD / 设计交叉评审 → 实现与自测 → 代码评审 → 测试 → 准出”交付，全程留痕。',
      '何时用：用户要给某个代码项目开发或修改功能、修复较大的缺陷，并且适合走评审、测试的完整交付；或用户提到“需求”“交付”“走流程”“Taktflow”。',
      '何时不用：问答、查资料、一次性小改动或命令、运维操作（部署、扩缩容、发布）、用户已经明确要你直接做。',
      '调用后会弹卡片请用户确认；用户选“在这里继续”就照常在本会话做，不要再次调用。转交成功后不要在本会话继续实现这个需求，告诉用户去新的 Taktflow 会话看进度。',
      '示例：{"request":"给工作室页加批量导出，导出 CSV，验收：…","repo":"git@code.example.com:team/portal.git"}',
    ].join('\n'),
    parameters: {
      request: { type: 'string', required: true, description: '需求本身：用户原话、背景、要改什么、验收标准。只写需求，不要写“用户要求转交 / 重试”这类过程话（它会成为新会话的第一句和标题）。' },
      repo: { type: 'string', description: '代码仓库：git 地址或本机路径（知道的话）。' },
      space: { type: 'string', description: 'Taktflow 空间目录（绝对路径）；不填用当前会话目录。' },
      title: { type: 'string', description: '一句话标题（可选）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { handedOff: { type: 'boolean', required: true }, message: { type: 'string', required: true } } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String((value as { message?: unknown }).message ?? '') }],
    },
    async execute(raw: unknown, exec: ToolExecutionContext) {
      const args = (raw ?? {}) as Record<string, unknown>
      const request = typeof args.request === 'string' ? args.request.trim() : ''
      if (request === '') return { handedOff: false, message: 'request 不能为空：写清要做什么。' }
      const caller = exec.agent
      if (caller === undefined || deps.ctx.agents.get(caller.id) !== caller || !deps.ctx.agents.roots().includes(caller)) {
        return { handedOff: false, message: '只有用户直接对话的主会话能转交给 Taktflow；子 Agent 不要调用。' }
      }
      if (presetOf(caller) === LEAD_PRESET) return { handedOff: false, message: '当前已经是 Taktflow 会话，直接用 takt_* 工具。' }
      const dir = typeof args.space === 'string' && args.space.trim() ? args.space.trim() : caller.session.header.cwd
      if (dir === undefined || !path.isAbsolute(dir) || !(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        return { handedOff: false, message: `空间目录不可用：${dir ?? '（会话没有工作目录）'}。请让用户指定一个目录。` }
      }
      const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : clip(request, 60)

      // 宿主行没有 inject userQuestions，直接读属性会被 Cordis 拒绝；按名字取服务。
      const questions = deps.ctx.get<HostContext['userQuestions']>('userQuestions')
      if (questions === undefined) return { handedOff: false, message: '宿主没有确认卡片服务，不能转交；请在本会话继续。' }
      const result = await questions.ask({
        agent: caller,
        signal: exec.signal,
        questions: [{
          id: 'taktflow-handoff',
          header: '交给 Taktflow',
          question: '用 Taktflow 交付流水线来做这个需求吗？',
          // 卡片不保留换行：用分号分隔，说明另起一句。
          detail: `${[`需求：${title}`, repo ? `代码仓库：${repo}` : '', `空间：${dir}`].filter(Boolean).join('；')}。会新开一个 Taktflow 会话：Lead 建需求、绑定仓库并启动流程，文档和代码由不同角色 Agent 交叉评审；需要你拍板时会弹卡片。`,
          options: [
            { label: AGREE, description: '新开 Taktflow 会话，按流水线交付' },
            { label: DECLINE, description: '当前会话直接做' },
          ],
        }],
      })
      if (exec.signal.aborted) return { handedOff: false, message: '已取消。' }
      const choice = result.answers.find((answer) => answer.id === 'taktflow-handoff')?.selected[0]
      if (choice !== AGREE) return { handedOff: false, message: '用户选择在当前会话继续，不要再次调用 taktflow_handoff 处理这个需求。' }

      const sessions = deps.ctx.get<SessionControllerService>('sessionController')
      if (sessions === undefined) return { handedOff: false, message: '宿主没有会话服务，不能新开 Taktflow 会话；请在本会话继续。' }
      const created = await sessions.create({ cwd: dir, agentPreset: LEAD_PRESET })
      const message = [
        request,
        '',
        `（由${caller.session.header.agentPreset === 'standard' ? '标准' : '普通'}会话转交，用户已同意用 Taktflow 交付）`,
        repo ? `代码仓库：${repo}` : '',
      ].filter((line) => line !== undefined && line !== null).join('\n').replace(/\n+$/, '')
      const accepted = await sessions.prompt({ sessionId: created.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: message }] }, AbortSignal.timeout(30_000))
      if (!accepted.accepted) return { handedOff: false, message: 'Taktflow 会话没有接收需求；请在本会话继续或让用户手动新开。' }
      return {
        handedOff: true,
        sessionId: created.sessionId,
        message: `已转交：新开了 Taktflow 会话（侧栏「${path.basename(dir)}」下，标题以“${clip(request, 16)}”开头），Lead 会建需求并启动流程。告诉用户去那个会话看进度；不要在本会话继续实现这个需求。`,
      }
    },
  }
}

/**
 * 宿主行（host.js）和 Lead / 角色行（lead.js、role.js）是不同的 bundle，模块变量不共享；
 * 用 globalThis 上的登记表协调：Lead 的 preset 行在宿主启动时就加载，早于异步注册的全局工具，
 * 那时 restrict 会报“未知工具”，所以先排队，工具注册后再屏蔽。
 */
interface HandoffRegistry { registered: boolean; waiting: Set<() => void> }
const REGISTRY = Symbol.for('taktflow.handoff.registry')
function registry(): HandoffRegistry {
  const holder = globalThis as unknown as Record<symbol, HandoffRegistry | undefined>
  return (holder[REGISTRY] ??= { registered: false, waiting: new Set() })
}

/** 宿主注册 / 注销全局 taktflow_handoff 后调用；注册时让排队的 Agent 作用域补上屏蔽。 */
export function markHandoffRegistered(registered: boolean): void {
  const state = registry()
  state.registered = registered
  if (registered) for (const hide of [...state.waiting]) hide()
}

/**
 * 在当前 Agent 作用域里屏蔽 taktflow_handoff（Lead、职责角色用）。
 * 工具还没注册时排队等注册；关闭了 handoff、宿主不支持 restrict 时什么都不做。
 */
export function hideHandoff(ctx: Pick<HostContext, 'tools'>): () => void {
  const state = registry()
  let undo: (() => unknown) | undefined
  let closed = false
  const attempt = (): void => {
    if (closed || undo !== undefined) return
    try {
      undo = ctx.tools.restrict?.({ deny: [HANDOFF_TOOL_NAME] }) ?? (() => undefined)
      state.waiting.delete(attempt)
    } catch {
      // 未知工具：等宿主注册后再试；其它错误（不在 Agent 作用域）也不影响加载。
    }
  }
  state.waiting.add(attempt)
  if (state.registered) attempt()
  return () => {
    closed = true
    state.waiting.delete(attempt)
    void undo?.()
  }
}
