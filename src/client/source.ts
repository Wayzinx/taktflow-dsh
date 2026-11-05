import type { AttentionItem, RunDetail, WorkflowConflict } from '@taktflow/core'
import { ApiRequestError, WorkflowConflictError, type AgentTraceView, type DataSource } from '@taktflow/web/embed'

/**
 * 基于 dsh 路由的数据源（技术方案 5.12）。
 *
 * - 读：`GET ./api/taktflow?space=&p=<op>&...`，参数原样放在查询串里（op 即 api-core 的读操作名）；
 * - 写：`POST ./api/taktflow.op`。插件自己的操作（attention.answer、run.*、lease.release）字段平铺在 body 里；
 *   api-core 的操作用 `{ space, p, params, body }`；
 * - 响应统一是 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`；workflow 冲突是 409 + `conflict`；
 * - 事件流：运行 `./api/taktflow.stream?space=&run=`，workflow 修改 `./api/taktflow.workflow-stream?space=&id=`（SSE）；
 * - 子 Agent 追溯：`./api/taktflow.agents?space=&run=[&node=]`。
 * 失败一律抛 ApiRequestError，页面显示错误；不回退演示数据。群聊不经过这里：需求群就是 dsh 会话。
 */
export interface DshSourceOptions {
  base?: string
  /** 在 dsh 里打开子 Agent 会话（uiWorkspace.openSession）；拿不到宿主服务时不提供。 */
  openSession?: (sessionId: string) => void
}

type Params = Record<string, string | number | boolean | undefined>

export function createDshSource(space: string, options: DshSourceOptions = {}): DataSource {
  const base = options.base ?? './api'

  async function parse<T>(res: Response, label: string): Promise<T> {
    const text = await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      throw new ApiRequestError(res.status, `${label} 返回的不是 JSON`)
    }
    const envelope = data as { ok?: boolean; data?: unknown; conflict?: WorkflowConflict; error?: { code?: string; message?: string } } | undefined
    if (res.status === 409 && envelope?.conflict) throw new WorkflowConflictError(envelope.conflict)
    if (!res.ok || envelope?.ok !== true) {
      const err = envelope?.error
      throw new ApiRequestError(res.status, err?.message ?? `${label} → ${res.status}`, err)
    }
    return envelope.data as T
  }

  function query(params: Params): string {
    const q = new URLSearchParams({ space })
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v))
    return q.toString()
  }

  async function read<T>(op: string, params: Params = {}): Promise<T> {
    const res = await fetch(`${base}/taktflow?${query({ p: op, ...params })}`, { credentials: 'same-origin' })
    return parse<T>(res, op)
  }

  async function post<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${base}/taktflow.op`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, space, p: op }),
    })
    return parse<T>(res, op)
  }

  /** api-core 的写操作：路径参数和请求体分开传。 */
  const write = <T,>(op: string, params: Record<string, string>, body?: unknown) => post<T>(op, { params, body })

  function sse<T>(path: string, params: Params, onEvent: (e: T) => void): () => void {
    const es = new EventSource(`${base}/${path}?${query(params)}`, { withCredentials: true })
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as T)
      } catch {
        // 非 JSON 的保活行忽略
      }
    }
    return () => es.close()
  }

  /** 审批必须带待办冻结的尝试次数；旧待办没有冻结值时取节点当前的尝试次数。 */
  async function answer(requestId: string, body: { decision?: string; answer?: string }): Promise<AttentionItem> {
    const item = (await read<AttentionItem[]>('attention')).find((it) => it.requestId === requestId)
    if (!item) throw new ApiRequestError(404, '待办不存在或已被清理')
    let attempt = item.attempt
    if (attempt === undefined) {
      const run = await read<RunDetail>('run', { runId: item.runId })
      attempt = run.run.nodes[item.nodeId]?.attempts ?? 0
    }
    return post('attention.answer', { requestId, attempt, ...body })
  }

  const unsupported = (what: string) => () =>
    Promise.reject(new ApiRequestError(501, `${what}在 dsh 里不需要：需求群就是当前会话`))

  return {
    mock: false,
    project: () => read('project'),
    requirements: () => read('requirements'),
    requirement: (id) => read('requirement', { id }),
    artifacts: (id) => read('artifacts', { id }),
    artifact: (id, path, version) => read('artifact', { id, path, version }),
    editArtifact: (id, path, body) => write('artifact.edit', { id, path }, body),
    comments: (id, path) => read('comments', { id, path }),
    addComment: (id, body) => write('comment.add', { id }, body),
    trace: (id) => read('trace', { id }),
    metrics: (id) => read('metrics', { id }),
    runs: (requirement) => read('runs', { requirement }),
    run: (runId) => read('run', { runId }),
    events: (runId, opts = {}) => read('events', { runId, after: opts.after, node: opts.node }),
    node: (runId, nodeId) => read('node', { runId, nodeId }),
    audit: (runId) => read('audit', { runId }),
    attention: (pending) => read('attention', { pending: pending ? 1 : undefined }),
    answer,
    harnesses: () => read('harnesses'),
    models: () => read('models'),
    subscribe: (runId, onEvent) => sse('taktflow.stream', { run: runId }, onEvent),

    // 嵌入时只有一个空间（会话目录），不提供空间切换
    spaces: async () => [],
    space: () => read('space'),
    setMembers: (members) => write('space.members', {}, { members, reason: '在 dsh 面板里修改成员' }),
    addRepo: (repo) => write('space.repo.add', {}, { ...repo, reason: '在 dsh 面板里绑定仓库' }),
    syncRepo: (repoId) => write('space.repo.sync', { repoId }, { reason: '在 dsh 面板里同步仓库' }),
    spaceFile: (kind, name) => read('space.file', { kind, name }),
    saveSpaceFile: (kind, name, body) => write('space.file.edit', { kind, name }, body),

    room: unsupported('群聊'),
    addRoomMembers: unsupported('群聊'),
    chat: unsupported('群聊'),
    postChat: unsupported('群聊'),
    subscribeChat: () => () => {},

    requirementReviews: (id) => read('reviews', { id }),

    workflows: () => read('workflows'),
    workflow: (id) => read('workflow', { id }),
    editWorkflow: (id, body) => write('workflow.edit', { id }, body),
    replaceWorkflowSource: (id, body) => write('workflow.source.replace', { id }, body),
    saveWorkflowLayout: (id, layout) => write('workflow.layout', { id }, layout),
    workflowRevisions: (id) => read('workflow.revisions', { id }),
    workflowRevision: (id, rev) => read('workflow.revision', { id, rev }),
    rollbackWorkflow: (id, body) => write('workflow.rollback', { id }, body),
    subscribeWorkflow: (id, onChange) => sse('taktflow.workflow-stream', { id }, onChange),

    agents: async (runId, nodeId) => {
      const res = await fetch(`${base}/taktflow.agents?${query({ run: runId, node: nodeId })}`, { credentials: 'same-origin' })
      return parse<AgentTraceView[]>(res, 'agents')
    },
    ...(options.openSession ? { openAgentSession: (trace: AgentTraceView) => options.openSession!(trace.sessionId) } : {}),
  }
}
