/** 仅由 s1-s2.mjs 打包到隔离 profile；默认开关关闭时不注册入口。 */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { agent, defineWorkflow, initProject } from '../vendor/taktflow/packages/core/src/index.ts'

export const name = 'taktflow-e2e-probe'
export const inject = ['connection', 'agents', 'subagents', 'tools']

export function apply(ctx) {
  if (process.env.TAKTFLOW_DEBUG_ROUTES !== '1') return
  const root = process.env.TAKTFLOW_E2E_SPACE
  if (!root || !process.env.DSH_HOME || !root.startsWith(`${process.env.DSH_HOME}${path.sep}`)) throw new Error('隔离空间必须属于测试 home')
  const children = new Map(), runs = new Map(), modelTools = [], handles = new Map(), workflows = new Map()
  let service, space
  const clean = (value) => {
    if (typeof value === 'string') return value.split(root).join('<space>').split(process.env.DSH_HOME).join('<test-home>')
      .replace(/\/(?:Users|home)\/[^\s<>"']+/g, '<local-path>')
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
    return value
  }
  const outcome = (result) => ({ isError: result.isError, code: result.error?.info?.code,
    message: result.error?.message, text: result.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n').slice(0, 1000) })
  const presets = () => ctx.get('agentPresets')
  const tools = (child) => ctx.tools.schemas(child).map((tool) => tool.name).sort()

  ctx.on('tools/result', (exec, result) => {
    const scope = service?.permissions.lookup(exec.agent?.id)
    if (!scope || exec.callId.startsWith('s12-pipeline-')) return
    modelTools.push({ childId: exec.agent.id, runId: scope.nodeRef.runId, name: exec.name,
      filePath: exec.arguments?.file_path, cd: exec.arguments?.cd,
      ...(['write', 'edit', 'working_directory', 'bash', 'pwsh'].includes(exec.name) ? outcome(result) : { isError: result.isError }) })
  })
  ctx.on('subagent/start', (info) => {
    const child = ctx.agents.get(info.id), scope = service?.permissions.lookup(info.id)
    if (!child || !scope) return
    const record = { childId: info.id, runId: scope.nodeRef.runId, headerId: child.session.header.id,
      permissionAtStart: true, tools: tools(child), starts: 1, ends: 0, mode: runs.get(scope.nodeRef.runId)?.mode,
      preset: child.session.header.agentPreset, sandbox: ctx.get('sandboxPolicy')?.resolve({ session: child.session }), pipelines: [], pending: true }
    children.set(info.id, record)
    void (async () => {
      record.presetVisibleDuring = (await presets().list()).some((entry) => entry.id === record.preset)
      if (record.mode === 'normal' || record.mode === 'readonly') {
        const probes = record.mode === 'readonly' ? [
          { id: 'readonly-write', name: 'write', arguments: { file_path: 'allowed/readonly.txt', content: 'forbidden' } },
        ] : [
          { id: 'inside', name: 'write', arguments: { file_path: 'allowed/pipeline.txt', content: 'pipeline-ok' } },
          { id: 'outside-scope', name: 'write', arguments: { file_path: 'other/forbidden.txt', content: 'forbidden' } },
          { id: 'parent-escape', name: 'write', arguments: { file_path: '../outside/forbidden.txt', content: 'forbidden' } },
          { id: 'symlink-outside', name: 'write', arguments: { file_path: 'allowed/external/forbidden.txt', content: 'forbidden' } },
          { id: 'symlink-parent', name: 'write', arguments: { file_path: 'allowed/link/../forbidden.txt', content: 'forbidden' } },
          { id: 'cwd-change', name: 'working_directory', arguments: { cd: path.join(root, 'other') } },
          { id: 'bash', name: 'bash', arguments: { command: 'exit 0' } },
          { id: 'pwsh', name: 'pwsh', arguments: { command: 'exit 0' } },
        ]
        for (const probe of probes) {
          const result = await ctx.tools.execute({ callId: `s12-pipeline-${randomUUID()}`, name: probe.name,
            arguments: probe.arguments, agent: child, signal: AbortSignal.timeout(15_000) })
          record.pipelines.push({ id: probe.id, ...outcome(result) })
        }
      }
    })().catch((error) => { record.error = error.message }).finally(() => { record.pending = false })
  })
  ctx.on('subagent/end', (info) => {
    const record = children.get(info.id)
    if (record) { record.ends++; record.stopReason = info.stopReason }
  })
  ctx.effect(() => async () => {
    for (const handle of handles.values()) await handle.dispose()
    handles.clear()
  })

  async function initialize() {
    service = ctx.get('taktflow')
    if (!service) throw new Error('taktflow 宿主服务尚未就绪')
    await initProject(root, { name: 's12-isolated' })
    for (const dir of ['allowed', 'other/sub']) await mkdir(path.join(root, dir), { recursive: true })
    await mkdir(path.join(root, '..', 'outside'), { recursive: true })
    await symlink(path.join(root, '..', 'outside'), path.join(root, 'allowed', 'external')).catch((error) => { if (error.code !== 'EEXIST') throw error })
    await symlink(path.join(root, 'other', 'sub'), path.join(root, 'allowed', 'link')).catch((error) => { if (error.code !== 'EEXIST') throw error })
    for (const [role, scope] of [['writer', '["allowed/**"]'], ['reviewer', '[]']]) {
      await writeFile(path.join(root, '.takt', 'agents', `${role}.md`), [
        '---', `role: ${role}`, `title: ${role}`, 'harness: dsh-host', `writeScope: ${scope}`,
        'allowBash: false', 'skills: []', '---', '按任务执行；写文件只使用 write 工具，不使用 shell。', '',
      ].join('\n'))
    }
    space = await service.spaces.open(root)
    const originalLoad = service.workflows.load.bind(service.workflows)
    const originalIds = service.workflows.ids.bind(service.workflows)
    service.workflows.load = (id) => workflows.has(id) ? Promise.resolve(workflows.get(id)) : originalLoad(id)
    service.workflows.ids = () => [...originalIds(), ...workflows.keys()]
    const handle = await newLead('lead')
    return { ready: true, leadId: handle.agent.id, leadTools: tools(handle.agent), defaultMode: true }
  }
  async function newLead(key) {
    const handle = await ctx.agents.create({ sessionId: randomUUID(),
      agentOptions: ctx.get('agentDefaultModel').currentSelection(), meta: { cwd: root, agentPreset: 'taktflow' },
      setup: async (agentCtx) => { await presets().mount(agentCtx, 'taktflow') },
    })
    handles.set(key, handle)
    return handle
  }
  async function start(mode) {
    const role = mode === 'readonly' ? 'reviewer' : 'writer'
    const prompt = mode === 'runner'
      ? '只调用 write，file_path=allowed/runner.txt，content=RUNNER_OK，成功后回复 done。'
      : mode === 'normal'
      ? '必须实际调用 write 工具，file_path=allowed/model.txt，content=S12_MODEL_OK。不要创建其他文件。调用成功后仅回复 done。'
      : mode === 'readonly'
        ? '这是只读审阅。尝试把内容 forbidden 写到 allowed/readonly.txt；如果没有写工具，直接回答不能写。不要调用其他工具。'
        : `依次调用 write 工具创建 allowed/${mode}-001.txt 到 allowed/${mode}-100.txt，内容分别为序号。每次只写一个文件；完成100次前不要结束。`
    const workflowId = `s12-${mode}-${randomUUID()}`
    workflows.set(workflowId, defineWorkflow({ id: workflowId, title: '隔离单节点验收', version: '1', stages: [],
      nodes: [agent({ id: 'work', title: mode, role, prompt, writeScope: role === 'reviewer' ? [] : ['allowed/**'], timeoutMs: 120_000 })],
    }))
    const requirement = await space.stores.workspaces.createRequirement({ title: `s12-${mode}` })
    const lead = handles.get(mode === 'runner' ? 'runner' : 'lead')
    const input = { space, requirementId: requirement.id, workflowId, ownerSessionId: lead.agent.id, requestKey: randomUUID() }
    const result = await service.runs.start(input)
    runs.set(result.runId, { mode, requirementId: requirement.id, input })
    return { ...result, requirementId: requirement.id }
  }
  async function snapshot(runId) {
    const state = await space.stores.runs.get(runId), owner = await service.ownership.readRun(space, runId)
    const events = await space.stores.events.read(runId)
    const found = [...children.values()].filter((child) => child.runId === runId)
    return { state, owner, children: found.map((child) => ({ ...child, live: ctx.agents.get(child.childId) !== undefined,
      permissionPresent: service.permissions.lookup(child.childId) !== undefined })),
      modelTools: modelTools.filter((tool) => tool.runId === runId),
      events: events.filter((event) => ['harness.started', 'run.finished', 'node.failed', 'log'].includes(event.type)),
      registeredPresets: (await presets().list()).map((preset) => preset.id).filter((id) => id.startsWith('takt-')),
      servicePresent: ctx.get('taktflow') !== undefined,
      files: await files(path.join(root, 'allowed')), forbidden: {
        scope: await exists(path.join(root, 'other', 'forbidden.txt')),
        external: await exists(path.join(root, '..', 'outside', 'forbidden.txt')),
        readonly: await exists(path.join(root, 'allowed', 'readonly.txt')),
      }, modelFile: await readFile(path.join(root, 'allowed', 'model.txt'), 'utf8').catch(() => undefined),
      leasePresent: await exists(path.join(root, '.takt', 'lease.json')),
    }
  }
  ctx.connection.fetch.register({ path: '/api/taktflow.e2e', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const input = await request.json()
        let result
        switch (input.op) {
          case 'init': result = await initialize(); break
          case 'takeover': await service.ownership.takeover(space, { type: 'human', id: 'e2e-recovery' }); result = { takenOver: true }; break
          case 'start': result = await start(input.mode); break
          case 'get': result = await snapshot(input.runId); break
          case 'cancel': await service.runs.cancel(space, input.runId, { type: 'human', id: 'e2e' }); result = await snapshot(input.runId); break
          case 'close-lead': {
            const handle = handles.get('lead'); await handle.dispose()
            result = { leadId: handle.agent.id, live: ctx.agents.get(handle.agent.id) !== undefined }; break
          }
          case 'start-runner': { const handle = await newLead('runner'); result = { ...await start('runner'), runnerId: handle.agent.id }; break }
          case 'new-lead': { const handle = await newLead('lead'); result = { leadId: handle.agent.id }; break }
          case 'dedupe': result = await service.runs.start(runs.get(input.runId).input); break
          default: throw new Error('未知验收动作')
        }
        return Response.json({ ok: true, value: clean(result) })
      } catch (error) { return Response.json({ ok: false, error: clean({ message: error.message, code: error.code }) }, { status: 500 }) }
    },
  })
}
async function exists(file) { try { await readFile(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function files(root) {
  const found = {}
  const walk = async (dir, prefix = '') => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) await walk(path.join(dir, item.name), relative)
      else found[relative] = createHash('sha256').update(await readFile(path.join(dir, item.name))).digest('hex')
    }
  }
  await walk(root)
  return found
}
