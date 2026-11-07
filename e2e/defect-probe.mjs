/** 仅隔离 defect e2e 启用的只读 schema 探针；不调用工具、不生成业务结果。 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

export const name = 'taktflow-e2e-defect-schema-probe'
export const inject = ['connection', 'agents', 'subagents', 'tools']

export function apply(ctx) {
  if (process.env.TAKTFLOW_E2E_DEFECT_PROBE !== '1') return
  const root = process.env.TAKTFLOW_E2E_DEFECT_SPACE
  const home = process.env.DSH_HOME
  if (!root || !home || !realpathSync(root).startsWith(`${realpathSync(home)}${path.sep}`)) {
    throw new Error('schema 探针只允许本次隔离 home 中的空间')
  }
  const children = new Map()
  const timers = new Set()
  const parents = new Map()
  const starts = new Map()
  const errors = []
  const secrets = [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY]
    .filter((value) => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)
  const cleanText = (value) => {
    let text = String(value)
    for (const secret of secrets) text = text.split(secret).join('<redacted>')
    return text.split(root).join('<space>').split(home).join('<e2e-home>')
      .replace(/https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)[^\s\"'<>]+/gi, '<redacted-url>')
      .replace(/([?&]token=)[^&\s\"'<>]+/gi, '$1<redacted>')
      .replace(/\bBearer\s+[^\s\"']+/gi, 'Bearer <redacted>')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-<redacted>')
      .replace(/\/Users\/[^/\s\"']+/g, '<home>')
      .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[\w./-]+/g, '<tmp>')
  }
  const errorValue = (value, depth = 0, seen = new WeakSet()) => {
    if (typeof value === 'string') return cleanText(value)
    if (value === null || typeof value !== 'object') return value
    if (depth >= 6) return '[depth-limit]'
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => errorValue(item, depth + 1, seen))
    const keys = [...new Set([...Object.getOwnPropertyNames(value), ...(value instanceof Error ? ['name', 'message', 'stack'] : [])])]
    return Object.fromEntries(keys.filter((key) => key !== 'agent').map((key) => {
      if (/(?:api[_-]?key|authorization|cookie|token|secret|password|credential)/i.test(key)) return [key, '<redacted>']
      try { return [key, errorValue(value[key], depth + 1, seen)] } catch { return [key, '[unreadable]'] }
    }))
  }
  const schemas = (agent) => ctx.tools.schemas(agent)
  const capture = (agent, stage) => {
    const scope = ctx.get('taktflow')?.permissions.lookup(agent.id)
    if (!scope || !parents.has(agent.id)) return false
    if (children.get(agent.id)?.endedAt) return true
    const listed = schemas(agent)
    const tools = Array.isArray(listed) ? listed : []
    const livePreset = ctx.get('agentPresets')?.composedPreset?.(agent.ctx)
    const presetId = livePreset ?? agent.session?.header?.agentPreset
    const match = typeof presetId === 'string' ? /^takt-[a-f0-9]+-([a-z-]+)-[a-f0-9]+$/.exec(presetId) : null
    const role = match?.[1]
    const names = tools.map((tool) => tool.name).sort()
    const previous = children.get(agent.id)
    children.set(agent.id, {
      sessionId: agent.id,
      headerSessionId: agent.session?.header?.id ?? null,
      runId: scope.nodeRef?.runId,
      nodeId: scope.nodeRef?.nodeId,
      attempt: scope.nodeRef?.attempt,
      role,
      roleSource: livePreset === undefined ? 'session.header.agentPreset' : 'live-composed-preset',
      presetId,
      parentSessionId: parents.get(agent.id),
      startedAt: starts.get(agent.id) ?? null,
      readOnly: scope.readOnly,
      schemasAvailable: names.length > 0,
      toolNames: names,
      selftestSchema: tools.find((tool) => tool.name === 'takt_selftest') ?? null,
      observedAt: new Date().toISOString(),
      stage,
      observations: (previous?.observations ?? 0) + 1,
    })
    return role !== undefined && names.includes('skill') && (scope.readOnly || names.includes('takt_selftest'))
  }
  ctx.on('subagent/start', (info) => {
    // dsh 生命周期监听器只收到 info；直接父会话来自持久化 header.parentSession。
    const published = ctx.agents.get(info.id)
    const parent = ctx.agents.get(published?.session?.header?.parentSession)
    if (!parent?.session?.header?.cwd || realpathSync(parent.session.header.cwd) !== realpathSync(root)
      || !ctx.agents.roots().includes(parent)) return
    parents.set(info.id, parent.id)
    starts.set(info.id, new Date().toISOString())
    let observations = 0
    const observe = () => {
      const child = ctx.agents.get(info.id)
      if (!child || children.get(info.id)?.endedAt) return
      if (capture(child, observations === 0 ? 'subagent/start' : 'after-start') || ++observations >= 30) return
      const timer = setTimeout(() => { timers.delete(timer); observe() }, 100)
      timers.add(timer)
    }
    // 启动事件同步返回；挂载较晚时异步短轮询至真实角色工具就绪或会话结束。
    observe()
  })
  ctx.on('subagent/end', (info) => {
    const record = children.get(info.id)
    if (record) {
      record.endedAt = new Date().toISOString()
      record.stopReason = info.stopReason ?? null
    }
  })
  // 真实 local/spawn 的失败可能早于 turn 打开，不能仅等 session 的 turn/end。
  ctx.on('agent/error', (payload) => {
    const agent = payload?.agent
    const parent = ctx.agents.get(agent?.session?.header?.parentSession)
    if (!agent || !parent?.session?.header?.cwd || realpathSync(parent.session.header.cwd) !== realpathSync(root)
      || !ctx.agents.roots().includes(parent)) return
    parents.set(agent.id, parent.id)
    try { capture(agent, 'agent/error') } catch { /* 原始错误仍须保存，不能被 schema 读取失败吞掉。 */ }
    errors.push({ source: 'agent/error', sessionId: agent.id, parentSessionId: parent.id,
      turn: payload.turn ?? null, step: payload.step ?? null, at: new Date().toISOString(), error: errorValue(payload.error) })
  })
  ctx.on('tools/result', (exec) => {
    if (exec.agent) capture(exec.agent, 'tools/result')
  })
  ctx.effect(() => () => { for (const timer of timers) clearTimeout(timer); timers.clear() })
  ctx.connection.fetch.register({
    path: '/api/taktflow.e2e-defect-schemas', methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const id = new URL(request.url).searchParams.get('session')
        const lead = id ? ctx.agents.get(id) : undefined
        if (!lead || !ctx.agents.roots().includes(lead)
          || !lead.session?.header?.cwd || realpathSync(lead.session.header.cwd) !== realpathSync(root)) {
          return Response.json({ ok: false, error: '当前隔离空间的 Lead 不在线' }, { status: 404 })
        }
        const tools = schemas(lead)
        return Response.json({ ok: true, data: {
          source: 'ctx.tools.schemas(live-agent)',
          lead: { sessionId: lead.id, toolNames: tools.map((tool) => tool.name).sort(), observedAt: new Date().toISOString() },
          children: [...children.values()],
          errors: errors.filter((item) => item.parentSessionId === lead.id),
        } })
      } catch {
        return Response.json({ ok: false, error: '读取真实 schema 失败' }, { status: 500 })
      }
    },
  })
}
