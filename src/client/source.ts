import type { AttentionItem, RunDetail } from '@taktflow/core'
import { ApiRequestError, type DataSource } from '@taktflow/web/embed'

/**
 * 基于 dsh 路由的数据源（技术方案 5.12）。
 *
 * - 读：`GET ./api/taktflow?space=&p=<op>&...`，参数原样放在查询串里；
 * - 写：`POST ./api/taktflow.op`，body `{ space, p: <op>, ...字段 }`，操作名走白名单；
 * - 响应统一是 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`；
 * - 事件流：`GET ./api/taktflow.stream?space=&run=`（SSE）。
 * 失败一律抛 ApiRequestError，页面显示错误；不回退演示数据。
 */
export function createDshSource(space: string, base = './api'): DataSource {
  async function parse<T>(res: Response, label: string): Promise<T> {
    const text = await res.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      throw new ApiRequestError(res.status, `${label} 返回的不是 JSON`)
    }
    const envelope = data as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; hint?: string } } | undefined
    if (!res.ok || envelope?.ok !== true) {
      const err = envelope?.error
      throw new ApiRequestError(res.status, err?.message ?? `${label} → ${res.status}`, err)
    }
    return envelope.data as T
  }

  async function read<T>(op: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const query = new URLSearchParams({ space, p: op })
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v))
    const res = await fetch(`${base}/taktflow?${query}`, { credentials: 'same-origin' })
    return parse<T>(res, op)
  }

  async function write<T>(op: string, fields: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${base}/taktflow.op`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fields, space, p: op }),
    })
    return parse<T>(res, op)
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
    return write('attention.answer', { requestId, attempt, ...body })
  }

  const p1 = (what: string) => Promise.reject(new ApiRequestError(501, `${what}在 dsh 面板里还不支持，请在需求群里让 Lead 处理`))

  return {
    mock: false,
    project: () => read('project'),
    requirements: () => read('requirements'),
    requirement: (id) => read('requirement', { id }),
    artifacts: (id) => read('artifacts', { id }),
    artifact: (id, path, version) => read('artifact', { id, path, version }),
    editArtifact: () => p1('编辑产物'),
    comments: (id, path) => read('comments', { id, path }),
    addComment: () => p1('评论'),
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
    subscribe(runId, onEvent) {
      const es = new EventSource(`${base}/taktflow.stream?${new URLSearchParams({ space, run: runId })}`, { withCredentials: true })
      es.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data as string))
        } catch {
          // 非 JSON 的保活行忽略
        }
      }
      return () => es.close()
    },
  }
}
