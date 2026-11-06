import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, HarnessEvent, HarnessRequest } from '@taktflow/core'
import type { AgentTraceHandle, AgentTraceHub, AgentTraceOutcome, AgentTraceStart } from './agent-trace.js'
import type { Agent, SessionEvent, SubagentActivation, SubagentActivationSpec, SubagentResult } from './dsh-types.js'
import { createDshHarness, type DshHarnessDeps } from './dsh-harness.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { PermissionScope, SpaceHandle } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function traceSpy() {
  const starts: AgentTraceStart[] = []
  const outcomes: AgentTraceOutcome[] = []
  const events: SessionEvent[] = []
  const handle = {
    running: vi.fn((_model?: string, _effort?: string) => {}),
    sessionEvent: vi.fn((event: SessionEvent) => { events.push(event) }),
    denial: vi.fn(),
    finish: vi.fn(async (outcome: AgentTraceOutcome) => { outcomes.push(outcome) }),
    dispose: vi.fn(async () => {}),
  } satisfies AgentTraceHandle
  const begin = vi.fn(async (_space: SpaceHandle, input: AgentTraceStart) => {
    starts.push(input)
    return handle
  })
  const hub = { begin, read: vi.fn(), recordDenial: vi.fn(), disposeAll: vi.fn() } as unknown as AgentTraceHub
  return { hub, begin, handle, starts, outcomes, events }
}

const devProfile: AgentProfile = {
  role: 'dev',
  title: '开发',
  description: '负责实现',
  instructions: '实现需求',
  harness: { harness: 'dsh-host' },
  skills: ['coding'],
  writeScope: ['out/**'],
  readScope: ['out/**'],
  allowBash: false,
}

let root: string
let artifact: string
let worktree: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-dsh-harness-')))
  artifact = path.join(root, '.takt', 'workspaces', 'REQ-1')
  worktree = path.join(root, 'worktrees', 'REQ-1')
  await mkdir(artifact, { recursive: true })
  await mkdir(worktree, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function fixture(options: { trace?: boolean } = {}) {
  const ctx = new FakeHostContext()
  const calls: string[] = []
  const permissions = new Map<string, PermissionScope>()
  const parent: Agent = { id: 'lead', options: {}, session: { header: { id: 'lead', cwd: root } }, followup() {}, inject() {} }
  ctx.agents.get = (id) => id === parent.id ? parent : undefined
  const releasePreset = vi.fn(async () => { calls.push('release-preset') })
  const acquire = vi.fn(async () => {
    calls.push('preset')
    return { id: 'role-preset', cfgHash: 'abcdef12', plugins: ['persona', 'tool-fs'], release: releasePreset }
  })
  const space = {
    root,
    stores: {
      runs: { get: async () => ({ requirementId: 'REQ-1', nodes: { build: { attempts: 2 } } }) },
      workspaces: { dir: () => artifact },
    },
  } as unknown as SpaceHandle
  const traces = options.trace === true ? traceSpy() : undefined
  const deps: DshHarnessDeps = {
    ctx, space, ownerSessionId: parent.id, presets: { acquire }, queueIntervalMs: 1,
    ...(traces === undefined ? {} : { traces: traces.hub, profiles: { dev: devProfile }, profileSources: { dev: 'space' } }),
    permissions: {
      register: (scope) => {
        calls.push('register')
        permissions.set(scope.childId, scope)
        return () => { calls.push('release-permission'); permissions.delete(scope.childId) }
      },
      lookup: (id) => permissions.get(id),
    },
    onLeadOffline: vi.fn(async () => { calls.push('lead-offline') }),
    onPreset: vi.fn(async () => { calls.push('audit') }),
  }
  const dispose = vi.fn(async () => { calls.push('dispose') })
  ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
    calls.push('start')
    ctx.activations.push(spec)
    expect(permissions.has(spec.childId!)).toBe(true)
    return { childId: spec.childId!, result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose }
  })
  const req: HarnessRequest = { prompt: '任务', cwd: root, env: { TAKT_ROLE: 'dev', TAKT_RUN_ID: 'run-1', TAKT_NODE: 'build', TAKT_REQ: 'REQ-1' }, tools: { writeScope: ['out/**'] } }
  const events: HarnessEvent[] = []
  return { ctx, calls, permissions, parent, acquire, releasePreset, deps, dispose, req, events, traces, run: () => createDshHarness(deps).run(req, (event) => events.push(event)) }
}

describe('dsh-host 节点生命周期', () => {
  it('先预留权限再创建子 Agent，审计完成后发布身份，并按顺序清理', async () => {
    const f = fixture()
    const result = await f.run()
    expect(f.calls).toEqual(['register', 'preset', 'audit', 'start', 'dispose', 'release-permission', 'release-preset'])
    const spec = f.ctx.activations[0]!
    expect(spec).toMatchObject({ provider: 'spawn', label: 'REQ-1/build#2', delivery: 'caller', request: { parent: f.parent, cwd: root, agentPreset: 'role-preset' } })
    expect(spec.childId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).toEqual({ ok: true, finalText: 'done', sessionId: spec.childId })
    expect(f.events[0]).toEqual({ type: 'started', sessionId: spec.childId })
    expect(f.permissions.size).toBe(0)
    expect(f.deps.onPreset).toHaveBeenCalledWith('dev', { id: 'role-preset', cfgHash: 'abcdef12' }, { runId: 'run-1', nodeId: 'build', attempt: 2 })
  })

  it('受支持 schema 直接交给 dsh，读取 structured', async () => {
    const f = fixture()
    f.req.resultSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    f.req.model = 'model-a'
    f.req.effort = 'high'
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      expect(spec.request.outputSchema).toEqual(f.req.resultSchema)
      // req.model/effort 不能覆盖 dsh 子 Agent；实际模型由 App 选择并只从 child options 报告。
      expect(Object.hasOwn(spec.request, 'agentOptions')).toBe(false)
      const child: Agent = {
        id: spec.childId!, options: { provider: 'local', model: 'app-model', reasoningEffort: 'high' },
        session: { header: { id: spec.childId!, cwd: root } }, followup() {}, inject() {},
      }
      f.ctx.agents.get = (id) => id === spec.childId ? child : f.parent
      return { childId: spec.childId!, result: Promise.resolve({ output: [], structured: { ok: true }, stopReason: 'completed' }), dispose: f.dispose }
    })
    const result = await f.run()
    expect(result).toMatchObject({ ok: true, structured: { ok: true } })
    expect(f.events[0]).toMatchObject({ type: 'started', model: 'app-model' })
  })

  it('不支持的 schema 不透传，从最后的 JSON 代码块提取', async () => {
    const f = fixture()
    f.req.resultSchema = { type: 'object', properties: { value: { type: 'number', minimum: 0 } } }
    f.req.systemAppend = '角色说明'
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      expect(Object.hasOwn(spec.request, 'outputSchema')).toBe(false)
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('角色说明') }])
      return { childId: spec.childId!, result: Promise.resolve({ output: [{ type: 'text', text: '```json\n{"value":1}\n```\n```json\n{"value":2}\n```' }], stopReason: 'completed' }), dispose: f.dispose }
    })
    expect(await f.run()).toMatchObject({ structured: { value: 2 } })
  })

  it('发布前已取消不登记资源', async () => {
    const f = fixture()
    f.req.signal = AbortSignal.abort(new Error('提前取消'))
    await expect(f.run()).rejects.toThrow('提前取消')
    expect(f.calls).toEqual([])
  })

  it('preset 获取期间取消，获取完成后清理且不发布', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.req.signal = controller.signal
    f.acquire.mockImplementationOnce(async () => { controller.abort(new Error('取消')); return { id: 'preset', cfgHash: 'hash', plugins: [], release: f.releasePreset } })
    await expect(f.run()).rejects.toThrow('取消')
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    expect(f.permissions.size).toBe(0)
    expect(f.releasePreset).toHaveBeenCalledOnce()
  })

  it('startActivation 返回前发生取消，返回后立即 dispose', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.req.signal = controller.signal
    const pending = deferred<SubagentActivation>()
    const entered = deferred<string>()
    f.ctx.subagents.startActivation = async (spec) => { entered.resolve(spec.childId!); return pending.promise }
    const running = f.run()
    const rejection = expect(running).rejects.toThrow('发布竞态取消')
    const childId = await entered.promise
    controller.abort(new Error('发布竞态取消'))
    pending.resolve({ childId, result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: f.dispose })
    await rejection
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.permissions.size).toBe(0)
  })

  it('发布后取消等待 dispose 与结果结束，之后才注销权限', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.req.signal = controller.signal
    const result = deferred<SubagentResult>()
    const started = deferred<void>()
    f.ctx.subagents.startActivation = async (spec) => ({
      childId: spec.childId!, result: result.promise,
      dispose: vi.fn(async () => {
        expect(f.permissions.has(spec.childId!)).toBe(true)
        f.calls.push('dispose')
        result.resolve({ output: [], stopReason: 'aborted' })
      }),
    })
    const running = createDshHarness(f.deps).run(f.req, (event) => { if (event.type === 'started') started.resolve() })
    const rejection = expect(running).rejects.toThrow('运行取消')
    await started.promise
    controller.abort(new Error('运行取消'))
    await rejection
    expect(f.calls.slice(-3)).toEqual(['dispose', 'release-permission', 'release-preset'])
  })

  it('满额排队没有固定重试上限，释放容量后成功', async () => {
    const f = fixture()
    let count = 0
    f.ctx.subagents.startActivation = async (spec) => {
      if (++count <= 12) throw Object.assign(new Error('满额'), { code: 'ACTIVATION_LIMIT_REACHED' })
      return { childId: spec.childId!, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: f.dispose }
    }
    expect((await f.run()).ok).toBe(true)
    expect(count).toBe(13)
    expect(f.acquire).toHaveBeenCalledOnce()
  })

  it('取消满额等待立即退出，不再尝试发布', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.req.signal = controller.signal
    f.deps.queueIntervalMs = 60_000
    f.ctx.subagents.startActivation = vi.fn(async () => {
      queueMicrotask(() => controller.abort(new Error('取消排队')))
      throw Object.assign(new Error('满额'), { code: 'ACTIVATION_LIMIT_REACHED' })
    })
    await expect(f.run()).rejects.toThrow('取消排队')
    expect(f.ctx.subagents.startActivation).toHaveBeenCalledOnce()
    expect(f.permissions.size).toBe(0)
  })

  it('Lead 离线取消整条运行，不启动 child', async () => {
    const f = fixture()
    f.ctx.agents.get = () => undefined
    await expect(f.run()).rejects.toThrow('Lead Agent 已离线')
    expect(f.deps.onLeadOffline).toHaveBeenCalledWith({ runId: 'run-1', nodeId: 'build', attempt: 2 })
    expect(f.acquire).not.toHaveBeenCalled()
  })

  it('排队期间 Lead 离线也取消，释放已获取资源', async () => {
    const f = fixture()
    f.ctx.subagents.startActivation = async () => {
      f.ctx.agents.get = () => undefined
      throw Object.assign(new Error('满额'), { code: 'ACTIVATION_LIMIT_REACHED' })
    }
    await expect(f.run()).rejects.toThrow('Lead Agent 已离线')
    expect(f.deps.onLeadOffline).toHaveBeenCalledOnce()
    expect(f.permissions.size).toBe(0)
    expect(f.releasePreset).toHaveBeenCalledOnce()
  })

  it.each(['preset', 'audit', 'start'])('%s 失败释放已获得资源', async (where) => {
    const f = fixture()
    if (where === 'preset') f.acquire.mockRejectedValueOnce(new Error('失败'))
    if (where === 'audit') f.deps.onPreset = async () => { throw new Error('失败') }
    if (where === 'start') f.ctx.subagents.startActivation = async () => { throw new Error('失败') }
    await expect(f.run()).rejects.toThrow('失败')
    expect(f.permissions.size).toBe(0)
    expect(f.releasePreset).toHaveBeenCalledTimes(where === 'preset' ? 0 : 1)
  })

  it('dispose 失败不宣称成功，并保留权限保护与 preset', async () => {
    const f = fixture()
    f.dispose.mockRejectedValueOnce(new Error('无法停止 child'))
    const harness = createDshHarness(f.deps)
    await expect(harness.run(f.req, () => {})).rejects.toThrow('无法停止 child')
    await expect(harness.drain()).rejects.toThrow('资源清理失败')
    await expect(harness.drain()).rejects.toThrow('资源清理失败')
    expect(f.permissions.size).toBe(1)
    expect(f.releasePreset).not.toHaveBeenCalled()
  })

  it('drain 等待在途节点完成，普通模型失败不会伪造清理失败', async () => {
    const f = fixture()
    const result = deferred<SubagentResult>()
    const started = deferred<void>()
    f.ctx.subagents.startActivation = async (spec) => ({ childId: spec.childId!, result: result.promise, dispose: f.dispose })
    const harness = createDshHarness(f.deps)
    const running = harness.run(f.req, (event) => { if (event.type === 'started') started.resolve() })
    await started.promise
    let drained = false
    const drain = harness.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    result.resolve({ output: [], stopReason: 'error' })
    expect((await running).ok).toBe(false)
    await drain
    expect(drained).toBe(true)
    expect(f.permissions.size).toBe(0)
  })

  it.each(['error', 'aborted', 'max-tokens', 'refusal'])('%s 结果不是成功', async (stopReason) => {
    const f = fixture()
    f.ctx.subagents.startActivation = async (spec) => ({ childId: spec.childId!, result: Promise.resolve({ output: [], stopReason, diagnostic: '未完成' }), dispose: f.dispose })
    expect(await f.run()).toMatchObject({ ok: false, error: '未完成' })
  })

  it('空写范围传递只读变体；shell 与空间外 cwd 均拒绝', async () => {
    const f = fixture()
    f.req.tools = { writeScope: [] }
    await f.run()
    expect(f.acquire).toHaveBeenCalledWith(f.deps.space, 'dev', { readOnly: true, allowBash: false })
    f.req.tools.allowBash = true
    await expect(f.run()).rejects.toMatchObject({ code: 'TAKT_UNSUPPORTED_NODE' })
    f.req.tools.allowBash = false
    f.req.cwd = tmpdir()
    await expect(f.run()).rejects.toMatchObject({ code: 'TAKT_SPACE_ROOT_MISMATCH' })
  })
})

describe('dsh-host worktree 与 sandbox', () => {
  it('接受空间内 worktree cwd 与 local sandbox，权限登记两域 scope', async () => {
    const f = fixture()
    f.deps.profiles = { dev: devProfile }
    f.req.cwd = worktree
    f.req.sandbox = {
      id: 'local', provider: 'local', spec: { workdir: worktree, mounts: [] },
    } as unknown as NonNullable<HarnessRequest['sandbox']>
    let captured: PermissionScope | undefined
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      captured = f.permissions.get(spec.childId!)
      expect(spec.request.cwd).toBe(worktree)
      return { childId: spec.childId!, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: f.dispose }
    })
    expect((await f.run()).ok).toBe(true)
    expect(captured).toMatchObject({
      cwd: worktree, spaceRoot: root, artifactRoot: artifact,
      writeScope: ['out/**'], readScope: ['out/**'], allowBash: false,
    })
    expect(f.permissions.size).toBe(0)
  })

  it('外部 sandbox 与 workdir 不一致都拒绝，且不登记资源', async () => {
    const f = fixture()
    f.req.sandbox = {
      id: 'docker', provider: 'docker', spec: { workdir: root, mounts: [] },
    } as unknown as NonNullable<HarnessRequest['sandbox']>
    await expect(f.run()).rejects.toThrow('只接受本地 sandbox')
    expect(f.calls).toEqual([])
    f.req.sandbox = {
      id: 'local', provider: 'local', spec: { workdir: tmpdir(), mounts: [] },
    } as unknown as NonNullable<HarnessRequest['sandbox']>
    await expect(f.run()).rejects.toThrow('workdir 与节点 cwd 不一致')
    expect(f.calls).toEqual([])
  })

  it('缺少当前需求产物目录或目录在空间根外时明确失败', async () => {
    const f = fixture()
    const stores = f.deps.space as unknown as { stores: { workspaces?: { dir: () => string } } }
    stores.stores.workspaces = undefined
    await expect(f.run()).rejects.toThrow('缺少当前需求的公共产物目录')
    expect(f.calls).toEqual([])
    stores.stores.workspaces = { dir: () => tmpdir() }
    await expect(f.run()).rejects.toThrow('当前需求产物目录不在空间根内')
    expect(f.calls).toEqual([])
  })
})

describe('dsh-host 追溯接线', () => {
  it('启动前订阅会话事件，记录冻结的 preset/profile/prompt 和真实 model/effort', async () => {
    const f = fixture({ trace: true })
    const trace = f.traces!
    const captured: Array<(...args: never[]) => void> = []
    let listenersAtStart = 0
    let childId = ''
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      childId = spec.childId!
      listenersAtStart = f.ctx.listeners.filter((entry) => entry.event === 'session/event').length
      captured.push(...f.ctx.listeners.filter((entry) => entry.event === 'session/event').map((entry) => entry.listener))
      const child: Agent = {
        id: spec.childId!, options: { provider: 'local', model: 'model-x', reasoningEffort: 'high' },
        session: { header: { id: spec.childId!, cwd: root } }, followup() {}, inject() {},
      }
      f.ctx.agents.get = (id) => id === spec.childId ? child : f.parent
      return {
        childId: spec.childId!,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: f.dispose,
      }
    })

    await f.run()
    expect(listenersAtStart).toBe(1)
    expect(trace.begin).toHaveBeenCalledOnce()
    const input = trace.starts[0]!
    expect(input).toMatchObject({
      runId: 'run-1', nodeId: 'build', attempt: 2, role: 'dev', label: 'REQ-1/build#2', prompt: '任务',
    })
    expect(input.sessionId).toBe(childId)
    expect(input.preset).toEqual({ id: 'role-preset', cfgHash: 'abcdef12', plugins: ['persona', 'tool-fs'] })
    expect(input.profile).toMatchObject({ title: '开发', description: '负责实现', skills: ['coding'], writeScope: ['out/**'], source: 'space' })
    expect(trace.handle.running).toHaveBeenCalledWith('model-x', 'high')
    expect(trace.outcomes[0]).toMatchObject({ status: 'completed', stopReason: 'completed', finalText: 'done' })

    const notify = captured[0] as unknown as (session: { id?: string }, event: SessionEvent) => void
    const event: SessionEvent = { type: 'tool/call', seq: 1, time: 1_000, data: { callId: 'call-1', name: 'read', arguments: '{}' } }
    notify({ id: childId }, event)
    notify({ id: 'other-child' }, event)
    expect(trace.handle.sessionEvent).toHaveBeenCalledTimes(1)
    expect(trace.handle.dispose).toHaveBeenCalledOnce()
    // 运行结束后订阅必须注销，不能留下监听器。
    expect(f.ctx.listeners.filter((entry) => entry.event === 'session/event')).toHaveLength(0)
  })

  it('启动失败写 failed，不伪造 completed', async () => {
    const f = fixture({ trace: true })
    f.ctx.subagents.startActivation = async () => { throw new Error('启动失败') }
    await expect(f.run()).rejects.toThrow('启动失败')
    expect(f.traces!.outcomes[0]).toMatchObject({ status: 'failed', error: '启动失败' })
    expect(f.traces!.handle.dispose).toHaveBeenCalledOnce()
  })

  it('取消写 cancelled，保留取消原因', async () => {
    const f = fixture({ trace: true })
    const controller = new AbortController()
    f.req.signal = controller.signal
    const result = deferred<SubagentResult>()
    const started = deferred<void>()
    f.ctx.subagents.startActivation = async (spec) => ({
      childId: spec.childId!, result: result.promise,
      dispose: vi.fn(async () => { result.resolve({ output: [], stopReason: 'aborted' }) }),
    })
    const running = createDshHarness(f.deps).run(f.req, (event) => { if (event.type === 'started') started.resolve() })
    const rejection = expect(running).rejects.toThrow('运行取消')
    await started.promise
    controller.abort(new Error('运行取消'))
    await rejection
    expect(f.traces!.outcomes[0]).toMatchObject({ status: 'cancelled', error: '运行取消' })
  })

  it('清理失败把终态改成 failed 并带清理原因', async () => {
    const f = fixture({ trace: true })
    f.dispose.mockRejectedValueOnce(new Error('无法停止 child'))
    const harness = createDshHarness(f.deps)
    await expect(harness.run(f.req, () => {})).rejects.toThrow('无法停止 child')
    expect(f.traces!.outcomes[0]).toMatchObject({ status: 'failed' })
    expect(f.traces!.outcomes[0]!.error).toContain('清理失败：无法停止 child')
    await expect(harness.drain()).rejects.toThrow('资源清理失败')
  })

  it('取消后清理失败仍写 cancelled，并保留清理原因', async () => {
    const f = fixture({ trace: true })
    const controller = new AbortController()
    f.req.signal = controller.signal
    const result = deferred<SubagentResult>()
    const started = deferred<void>()
    f.ctx.subagents.startActivation = async (spec) => ({
      childId: spec.childId!, result: result.promise,
      dispose: vi.fn(async () => {
        result.resolve({ output: [{ type: 'text', text: '已停止' }], stopReason: 'aborted' })
        throw new Error('停止后清理失败')
      }),
    })
    const running = createDshHarness(f.deps).run(f.req, (event) => { if (event.type === 'started') started.resolve() })
    const rejection = expect(running).rejects.toThrow('停止后清理失败')
    await started.promise
    controller.abort(new Error('运行取消'))
    await rejection
    expect(f.traces!.outcomes[0]).toMatchObject({ status: 'cancelled', finalText: '已停止' })
    expect(f.traces!.outcomes[0]!.error).toContain('运行取消；清理失败：停止后清理失败')
  })

  it('追溯最终刷新失败时用 failed 终态重试一次，并向引擎传播写盘错误', async () => {
    const f = fixture({ trace: true })
    f.traces!.handle.finish.mockRejectedValueOnce(new Error('追溯写盘失败'))
    const harness = createDshHarness(f.deps)
    await expect(harness.run(f.req, () => {})).rejects.toThrow('追溯写盘失败')
    expect(f.traces!.handle.finish).toHaveBeenCalledTimes(2)
    expect(f.traces!.outcomes.at(-1)).toMatchObject({ status: 'failed' })
    expect(f.traces!.outcomes.at(-1)!.error).toContain('追溯记录写入失败：追溯写盘失败')
    await expect(harness.drain()).rejects.toThrow('资源清理失败')
  })

  it('begin 带上本次请求与冻结 provider 的密钥，仅用于内存脱敏', async () => {
    const f = fixture({ trace: true })
    f.req.env = { ...f.req.env, TAKT_TEST_API_KEY: 'harness-env-secret' }
    const space = f.deps.space as unknown as { stores: { config?: Record<string, unknown> } }
    space.stores.config = {
      providers: { local: { protocol: 'openai-chat', headers: { authorization: 'Bearer provider-config-secret' } } },
    }
    await f.run()
    const secrets = f.traces!.starts[0]!.secrets ?? []
    expect(secrets).toContain('harness-env-secret')
    expect(secrets).toContain('provider-config-secret')
    // 密钥只随 begin 进入内存，不能出现在记录输入以外的持久化字段。
    expect(JSON.stringify(f.traces!.starts[0]!.prompt)).not.toContain('harness-env-secret')
  })

  it('追溯 begin 失败不启动子 Agent，并释放权限和 preset', async () => {
    const f = fixture({ trace: true })
    f.traces!.begin.mockRejectedValueOnce(new Error('追溯写入失败'))
    await expect(f.run()).rejects.toThrow('追溯写入失败')
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    expect(f.permissions.size).toBe(0)
    expect(f.releasePreset).toHaveBeenCalledOnce()
  })

  it('缺少冻结 profile 或来源时明确失败，不按角色名猜测', async () => {
    const f = fixture({ trace: true })
    f.deps.profileSources = {}
    await expect(f.run()).rejects.toThrow('追溯缺少冻结的角色来源')
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()

    f.deps.profileSources = { dev: 'space' }
    f.deps.profiles = {}
    await expect(f.run()).rejects.toThrow('追溯缺少角色档案')
  })

  it('trace 记录 handle 实际 skills 与档案声明名，不把声明名冒充成已注册', async () => {
    const f = fixture({ trace: true })
    f.deps.profiles = { dev: { ...devProfile, skills: ['coding', 'review'] } }
    f.deps.roleSkills = {
      dev: [{ name: 'coding', description: '编码约定', content: '正文', path: '.takt/skills/coding/SKILL.md' }],
    }
    f.acquire.mockImplementationOnce(async () => ({
      id: 'role-preset', cfgHash: 'abcdef12', plugins: ['persona'], skills: ['coding'], release: f.releasePreset,
    }))
    await f.run()
    expect(f.traces!.starts[0]!.preset).toMatchObject({ skills: ['coding'] })
    expect(f.traces!.starts[0]!.profile).toMatchObject({
      skills: ['coding'], declaredSkills: ['coding', 'review'],
    })
  })

  it('preset 实际 skills 与冻结快照不一致时明确失败并释放资源', async () => {
    const f = fixture({ trace: true })
    f.deps.roleSkills = {
      dev: [{ name: 'review', description: '评审', content: '正文', path: '.takt/skills/review/SKILL.md' }],
    }
    f.acquire.mockImplementationOnce(async () => ({
      id: 'role-preset', cfgHash: 'abcdef12', plugins: ['persona'], skills: ['coding'], release: f.releasePreset,
    }))
    await expect(f.run()).rejects.toThrow('实际注册技能与冻结快照不一致')
    expect(f.ctx.subagents.startActivation).not.toHaveBeenCalled()
    expect(f.permissions.size).toBe(0)
    expect(f.releasePreset).toHaveBeenCalledOnce()
  })
})
