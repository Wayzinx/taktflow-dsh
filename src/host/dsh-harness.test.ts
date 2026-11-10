import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, HarnessEvent, HarnessRequest } from '@taktflow/core'
import type { AgentTraceHandle, AgentTraceHub, AgentTraceOutcome, AgentTraceStart } from './agent-trace.js'
import type { Agent, SessionEvent, SubagentActivation, SubagentActivationSpec, SubagentResult } from './dsh-types.js'
import { createDshHarness, type DshHarnessDeps } from './dsh-harness.js'
import type { SelftestContextInput, SelftestService } from './selftest.js'
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

/** 记录 harness 是否登记受控自测，以及登记时的冻结范围。 */
function selftestSpy() {
  const registrations: Array<{
    input: SelftestContextInput
    cancel: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }> = []
  const service: SelftestService = {
    register: vi.fn(async (input: SelftestContextInput) => {
      const cancel = vi.fn()
      const release = vi.fn(async () => {})
      registrations.push({ input, cancel, release })
      return { childId: input.childId, cancel, release }
    }),
    cancel: vi.fn(),
    drain: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async () => { throw new Error('此测试只验证能力分配') }),
  }
  return { service, registrations }
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
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('必须包含顶层字段：ok') }])
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('type/properties/required 是 schema 格式定义') }])
      const prompt = promptText(spec)
      expect(prompt).toContain('structured_output')
      expect(prompt).toContain('只调用一次')
      expect(prompt).toContain('工具参数是实际结果字段')
      expect(prompt).not.toContain('最后输出一个 JSON 代码块')
      expect(prompt).not.toContain('JSON 代码块')
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
    f.req.resultSchema = { type: 'object', properties: { value: { type: 'number', minimum: 0 } }, required: ['value'] }
    f.req.systemAppend = '角色说明'
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      expect(Object.hasOwn(spec.request, 'outputSchema')).toBe(false)
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('必须包含顶层字段：value') }])
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('最后输出一个 JSON 代码块') }])
      expect(spec.request.prompt).toEqual([{ type: 'text', text: expect.stringContaining('角色说明') }])
      const prompt = promptText(spec)
      expect(prompt).toContain('最后输出一个 JSON 代码块')
      expect(prompt).not.toContain('structured_output')
      expect(prompt).not.toContain('必须调用')
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
    await expect(f.run()).rejects.toThrow('Lead 会话不在线，运行已暂停')
    expect(f.deps.onLeadOffline).toHaveBeenCalledWith({ runId: 'run-1', nodeId: 'build', attempt: 2 })
    expect(f.acquire).not.toHaveBeenCalled()
  })

  it('排队期间 Lead 离线也取消，释放已获取资源', async () => {
    const f = fixture()
    f.ctx.subagents.startActivation = async () => {
      f.ctx.agents.get = () => undefined
      throw Object.assign(new Error('满额'), { code: 'ACTIVATION_LIMIT_REACHED' })
    }
    await expect(f.run()).rejects.toThrow('Lead 会话不在线，运行已暂停')
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

describe('M3 配方关联', () => {
  it.each(['missing-start','wrong-attempt','correct'])('只关联当前attempt及角色：%s', async mode => {
    const f=fixture({trace:true})
    const recipe=(seq:number,role:string,key:string)=>({type:'node.recipe',seq,nodeId:'build',data:{role,recipeKey:key}})
    const events=[...(mode==='missing-start'?[]:[{type:'node.started',seq:1,nodeId:'build',data:{attempt:mode==='wrong-attempt'?1:2}}]),
      recipe(2,'dev','own-recipe'),recipe(3,'reviewer','other-recipe')]
    f.deps.space.stores.events={read:async()=>events} as unknown as SpaceHandle['stores']['events']
    await f.run()
    if(mode==='correct')expect(f.traces!.starts[0]).toMatchObject({recipeKey:'own-recipe',recipeEventSeq:2})
    else expect(f.traces!.starts[0]!.recipeKey).toBeUndefined()
  })
})

describe('原生深冻结结构化结果', () => {
  it('交给 core 的嵌套对象和数组可规范化，SDK 原结果仍冻结且未变', async () => {
    const f = fixture()
    const structured = Object.freeze({ issues: Object.freeze([
      Object.freeze({ nodeId: 'build', evidence: Object.freeze(['原始证据']) }),
    ]) })
    f.req.resultSchema = { type: 'object', properties: {
      issues: { type: 'array', items: { type: 'object', properties: {
        nodeId: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
      }, required: ['nodeId', 'evidence'] } },
    }, required: ['issues'] }
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!, result: Promise.resolve({ output: [], stopReason: 'completed', structured }), dispose: f.dispose,
    }))
    const result = await f.run()
    const mutable = result.structured as { issues: Array<{ nodeId: string; runId?: string; evidence: string[] }> }
    expect(mutable).toEqual(structured)
    expect(mutable).not.toBe(structured)
    mutable.issues[0]!.runId = 'run-1'
    mutable.issues[0]!.evidence.push('core 补充证据')
    expect(mutable.issues[0]).toMatchObject({ runId: 'run-1', evidence: ['原始证据', 'core 补充证据'] })
    expect(structured.issues[0]).toEqual({ nodeId: 'build', evidence: ['原始证据'] })
    expect(Object.isFrozen(structured.issues)).toBe(true)
    expect(Object.isFrozen(structured.issues[0])).toBe(true)
    expect(Object.isFrozen(structured.issues[0]!.evidence)).toBe(true)
  })
})

/** review-code 节点的结构化结果 schema；用于验证“把 schema 定义当结果”的边界。 */
function reviewSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'request_changes', 'blocked'] },
      summary: { type: 'string' },
      issues: { type: 'array', items: { type: 'object' } },
    },
    required: ['verdict', 'summary', 'issues'],
    additionalProperties: false,
  }
}

/** 把对象渲染成 finalText 末尾的 JSON 代码块，模拟模型原样粘贴 schema 定义。 */
function jsonBlock(value: unknown): string {
  return ['检查完成。', '```json', JSON.stringify(value, null, 2), '```'].join('\n')
}

/** 读取发给子 Agent 的纯文本 prompt，便于断言提示词边界。 */
function promptText(spec: SubagentActivationSpec): string {
  return spec.request.prompt.map((block) => block.type === 'text' ? block.text : '').join('\n')
}

describe('结构化结果格式诊断', () => {
  it('finalText 最后一块是 schema 定义时明确报告格式错误，不当作泛化停止', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({
        output: [{ type: 'text', text: jsonBlock(reviewSchema()) }],
        stopReason: 'error',
        diagnostic: 'error',
      }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('结构化结果格式错误')
    expect(result.error).toContain('返回了 schema 定义')
    expect(result.error).toContain('verdict、summary、issues')
    // 泛化 error 必须被具体格式诊断替换，不能原样返回。
    expect(result.error).not.toBe('error')
  })

  it('原生 structured 直接返回 schema 定义时判失败并指出缺字段', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({ output: [], structured: reviewSchema(), stopReason: 'completed' }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('结构化结果格式错误')
    expect(result.error).toContain('返回了 schema 定义')
    expect(result.error).toContain('verdict、summary、issues')
  })

  it('正常实际结果不受格式诊断影响', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    const structured = {
      verdict: 'request_changes',
      summary: '实现缺少边界处理',
      issues: [{ nodeId: 'build', detail: '越界写入' }],
    }
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result).toMatchObject({ ok: true, structured })
    expect(result.error).toBeUndefined()
  })

  it('实质错误诊断保留，并追加格式错误', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({
        output: [{ type: 'text', text: jsonBlock(reviewSchema()) }],
        stopReason: 'error',
        diagnostic: '模型鉴权失败',
      }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('模型鉴权失败')
    expect(result.error).toContain('结构化结果格式错误')
  })

  it('格式错误诊断不泄露密钥', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.req.env = { ...f.req.env, OPENAI_API_KEY: 'sk-secret-should-not-leak' }
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({
        output: [{ type: 'text', text: jsonBlock(reviewSchema()) }],
        stopReason: 'error',
        diagnostic: '模型鉴权失败：sk-secret-should-not-leak',
      }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('[REDACTED]')
    expect(result.error).not.toContain('sk-secret-should-not-leak')
  })

  it('原生 prompt 要求调用 structured_output，不要求 JSON 代码块，也不注入默认结论', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    let prompt = ''
    const structured = { verdict: 'request_changes', summary: '缺少边界处理', issues: [] }
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      prompt = promptText(spec)
      return {
        childId: spec.childId!,
        result: Promise.resolve({ output: [], structured, stopReason: 'completed' }),
        dispose: f.dispose,
      }
    })
    const result = await f.run()
    // 空 finalText + 有效原生 structured 仍是成功。
    expect(result).toMatchObject({ ok: true, structured })
    expect(prompt).toContain('structured_output')
    expect(prompt).toContain('只调用一次')
    expect(prompt).toContain('工具参数是实际结果字段')
    expect(prompt).toContain('只有 structured_output 的成功提交才算结果')
    expect(prompt).not.toContain('最后输出一个 JSON 代码块')
    expect(prompt).not.toContain('JSON 代码块')
    // 不把 approve/request_changes 等结论预置进提示词。
    expect(prompt).not.toContain('approve')
    expect(prompt).not.toContain('request_changes')
  })

  it('原生 schema 下 finalText 是有效 JSON 但缺少 structured_output 时判失败并说明未提交', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({
        output: [{ type: 'text', text: jsonBlock({ verdict: 'approve', summary: '通过', issues: [] }) }],
        stopReason: 'error',
        diagnostic: 'error',
      }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.structured).toBeUndefined()
    expect(result.error).toContain('未收到 structured_output 的有效提交')
    expect(result.error).toContain('文本/JSON代码块不能替代原生结构化结果')
    // 泛化 error 必须被具体诊断替换，且不能从文本 JSON 回退成成功。
    expect(result.error).not.toBe('error')
  })

  it('原生 schema completed 但没有 structured_output 提交仍判失败', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.structured).toBeUndefined()
    expect(result.error).toContain('未收到 structured_output 的有效提交')
  })

  it('子 Agent 想不提交就结束时同一轮提醒它提交；提交后不再提醒，别的 Agent 不受影响', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    const steered: string[] = []
    const others: string[] = []
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      const child: Agent = {
        id: spec.childId!, options: {}, session: { header: { id: spec.childId!, cwd: root } }, followup() {}, inject() {},
        steer: (message) => { steered.push(message.content.map((c) => (c as { text: string }).text).join('')) },
      }
      const other: Agent = { id: 'other', options: {}, session: { header: { id: 'other', cwd: root } }, followup() {}, inject() {}, steer: () => { others.push('x') } }
      const fire = (event: string, ...args: unknown[]) => {
        for (const l of f.ctx.listeners.filter((x) => x.event === event)) (l.listener as (...a: unknown[]) => void)(...args)
      }
      const stopping = (agent: Agent) => fire('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
      // 第一次想结束：没提交 → 提醒；别的 Agent 的同名事件不处理
      stopping(child)
      stopping(other)
      // 模型按提醒调用 structured_output；失败的提交不算
      fire('tools/result', { agent: child, name: 'structured_output' }, { isError: true })
      stopping(child)
      fire('tools/result', { agent: child, name: 'structured_output' }, { isError: false })
      stopping(child)
      return { childId: spec.childId!, result: Promise.resolve({ output: [], structured: { verdict: 'approve', summary: '通过', issues: [] }, stopReason: 'completed' }), dispose: f.dispose }
    })
    const result = await f.run()
    expect(result.ok).toBe(true)
    expect(steered).toHaveLength(2)
    expect(steered[0]).toContain('调用 structured_output')
    expect(steered[0]).toContain('不要重新检查')
    expect(others).toHaveLength(0)
    // 结束后监听全部注销
    expect(f.ctx.listeners.filter((x) => x.event === 'agent/turn-stopping' || x.event === 'tools/result')).toHaveLength(0)
  })

  it('最多提醒两次；仍未提交时说明是没调工具，不是截断或模型报错', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    let steers = 0
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
      const child: Agent = { id: spec.childId!, options: {}, session: { header: { id: spec.childId!, cwd: root } }, followup() {}, inject() {}, steer: () => { steers += 1 } }
      for (let i = 0; i < 4; i++) {
        for (const l of f.ctx.listeners.filter((x) => x.event === 'agent/turn-stopping')) {
          (l.listener as (e: unknown) => void)({ agent: child, turn: 1, signal: new AbortController().signal })
        }
      }
      return { childId: spec.childId!, result: Promise.resolve({ output: [{ type: 'text', text: jsonBlock({ verdict: 'approve', summary: '通过', issues: [] }) }], stopReason: 'error' }), dispose: f.dispose }
    })
    const result = await f.run()
    expect(steers).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.structured).toBeUndefined()
    expect(result.error).toContain('未收到 structured_output 的有效提交')
    expect(result.error).toContain('提醒 2 次仍未提交')
    expect(result.error).toContain('不是输出被截断或模型报错')
  })

  it('没有原生 schema 时不挂提醒', async () => {
    const f = fixture()
    await f.run()
    expect(f.ctx.listeners.some((x) => x.event === 'agent/turn-stopping')).toBe(false)
  })

  it('原生 schema 缺少 structured_output 时保留实质诊断并脱敏', async () => {
    const f = fixture()
    f.req.resultSchema = reviewSchema()
    f.req.env = { ...f.req.env, OPENAI_API_KEY: 'sk-secret-native-missing' }
    f.ctx.subagents.startActivation = vi.fn(async (spec: SubagentActivationSpec): Promise<SubagentActivation> => ({
      childId: spec.childId!,
      result: Promise.resolve({
        output: [{ type: 'text', text: '鉴权失败' }],
        stopReason: 'error',
        diagnostic: '模型鉴权失败：sk-secret-native-missing',
      }),
      dispose: f.dispose,
    }))
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('模型鉴权失败')
    expect(result.error).toContain('未收到 structured_output 的有效提交')
    expect(result.error).toContain('[REDACTED]')
    expect(result.error).not.toContain('sk-secret-native-missing')
  })
})

describe('受控自测能力分配', () => {
  it('文档型角色不登记自测，也不冻结命令', async () => {
    const f = fixture()
    const { service } = selftestSpy()
    f.deps.selftests = service
    f.req.tools = { writeScope: ['.takt/workspaces/**', 'requirements/**'] }
    expect((await f.run()).ok).toBe(true)
    expect(service.register).not.toHaveBeenCalled()
    expect(f.acquire).toHaveBeenCalledWith(f.deps.space, 'dev', {
      readOnly: false, allowBash: false, writeScope: ['.takt/workspaces/**', 'requirements/**'],
    })
  })

  it('代码/自定义代码角色登记自测，节点结束时取消并释放', async () => {
    const f = fixture()
    const { service, registrations } = selftestSpy()
    f.deps.selftests = service
    f.req.tools = { writeScope: ['services/api/src/**'] }
    expect((await f.run()).ok).toBe(true)
    expect(service.register).toHaveBeenCalledOnce()
    expect(registrations[0]!.input).toMatchObject({ role: 'dev', writeScope: ['services/api/src/**'] })
    expect(registrations[0]!.cancel).toHaveBeenCalled()
    expect(registrations[0]!.release).toHaveBeenCalledOnce()
  })

  it('只读/空写范围不登记自测', async () => {
    const f = fixture()
    const { service } = selftestSpy()
    f.deps.selftests = service
    f.req.tools = { writeScope: [] }
    expect((await f.run()).ok).toBe(true)
    expect(service.register).not.toHaveBeenCalled()
  })
})
