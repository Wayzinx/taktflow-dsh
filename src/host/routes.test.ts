import { appendFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AttentionAlreadyAnsweredError,
  createInsights,
  initProject,
  snapshotWorkflow,
  type Actor,
  type AttentionItem,
  type ProjectStores,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalInputError } from './approvals.js'
import { WRITE_OPS, registerRoutes } from './routes.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import {
  TaktToolError,
  type Approvals,
  type Bindings,
  type Notifier,
  type Ownership,
  type PermissionRegistry,
  type RolePresets,
  type RunManager,
  type SpaceHandle,
  type SpaceRegistry,
  type TaktflowService,
  type WorkflowCatalog,
} from './types.js'

const dirs: string[] = []
const hosts: FakeHostContext[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const workflow: WorkflowDefinition = {
  id: 'route-wf',
  title: '路由测试',
  version: '1',
  stages: [],
  nodes: [],
}

interface Fixture {
  host: FakeHostContext
  space: SpaceHandle
  stores: ProjectStores
  requirementId: string
  service: TaktflowService
  ownership: Ownership & { ensureLease: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  runs: RunManager & { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
  approvals: Approvals & { answer: ReturnType<typeof vi.fn>; present: ReturnType<typeof vi.fn> }
}

async function makeFixture(): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'takt-routes-')))
  dirs.push(dir)
  const stores = await initProject(dir, { name: 'routes' })
  const requirement = await stores.workspaces.createRequirement({ title: '路由需求' })
  const space: SpaceHandle = { root: dir, stores, insights: createInsights(stores) }

  const registry: SpaceRegistry = {
    async open(root) {
      if (root !== dir) throw new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', `不是已注册空间：${root}`)
      return space
    },
    async forSession() { return space },
    async roots() { return [dir] },
  }

  const ensureLease = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  const ownership = {
    hostOwner: 'dsh:test',
    ensureLease,
    release,
    takeover: vi.fn(async () => {}),
    recordRun: vi.fn(async () => {}),
    readRun: vi.fn(async () => undefined),
    setEndReason: vi.fn(async () => {}),
  } satisfies Ownership

  const start = vi.fn(async () => ({ runId: 'run-x', deduped: false }))
  const cancel = vi.fn(async () => {})
  const runs = {
    start,
    cancel,
    resume: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    onAnswered: vi.fn(async () => {}),
    disposeAll: vi.fn(async () => {}),
  } satisfies RunManager

  const answered: AttentionItem = {
    requestId: 'run-1:approve',
    runId: 'run-1',
    nodeId: 'approve',
    requirementId: requirement.id,
    ask: '请审批',
    form: 'approve',
    createdAt: new Date().toISOString(),
    answeredAt: new Date().toISOString(),
    decision: 'approve',
    answeredBy: { type: 'human', id: '面板用户', via: 'dsh-web' },
  }
  const approvals = {
    present: vi.fn(async () => {}),
    answer: vi.fn(async () => answered),
  } satisfies Approvals

  const bindings = {
    bind: vi.fn(async () => {}),
    byRequirement: vi.fn(async (_space: SpaceHandle, requirementId: string) =>
      requirementId === 'req-1' ? 'session-1' : undefined),
    bySession: vi.fn(async () => undefined),
  } satisfies Bindings

  const service: TaktflowService = {
    spaces: registry,
    ownership,
    runs,
    permissions: {} as PermissionRegistry,
    presets: {} as RolePresets,
    bindings,
    approvals,
    notifier: { attach: async () => {}, detach: async () => {} } satisfies Notifier,
    workflows: { ids: () => [], load: async () => { throw new Error('no workflow') } } satisfies WorkflowCatalog,
  }

  const host = new FakeHostContext()
  hosts.push(host)
  registerRoutes(host, service, { user: '面板用户' })

  return { host, space, stores, requirementId: requirement.id, service, ownership, runs, approvals }
}

function route(host: FakeHostContext, path: string) {
  const found = host.routes.find((entry) => entry.path === path)
  if (found === undefined) throw new Error(`路由未注册：${path}`)
  return found
}

async function getJson(
  host: FakeHostContext,
  path: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await route(host, path).fetch(new Request(url, { headers }))
  return { status: response.status, body: await response.json() }
}

async function postJson(
  host: FakeHostContext,
  body: Record<string, unknown>,
  query: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const url = new URL('http://localhost/api/taktflow.op')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await route(host, '/api/taktflow.op').fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

async function createRun(stores: ProjectStores, requirementId: string): Promise<string> {
  const runId = 'run-test-1'
  const state: RunState = {
    runId,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    requirementId,
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    args: {},
    nodes: {},
    expansions: [],
  }
  await stores.runs.create(state, snapshotWorkflow(workflow))
  await stores.events.append(runId, {
    type: 'run.started',
    actor: { type: 'system', id: 'test' },
    data: { workflowId: workflow.id, workflowVersion: workflow.version, args: {} },
  })
  return runId
}

/**
 * 用真实 EventStore 的 subscribe 包装一层 spy：返回的 unsubscribe 也是 spy。
 *
 * 这样能区分“body 已关闭”和“core 订阅已清理”，避免测试只看 reader 结束就通过。
 */
function spyEvents(stores: ProjectStores): { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(() => unsubscribe)
  stores.events.subscribe = subscribe
  return { subscribe, unsubscribe }
}

const decoder = new TextDecoder()

function withTimeout<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取超时')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const result = await withTimeout(reader.read())
  return result.done === true ? '' : decoder.decode(result.value)
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const result = await withTimeout(reader.read())
    if (result.done === true) return
  }
}

describe('registerRoutes：路由与读操作', () => {
  it('同时注册 ping、会话、读、写、SSE 路由', async () => {
    const { host } = await makeFixture()
    expect(host.routes.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '/api/taktflow.ping',
      '/api/taktflow.session',
      '/api/taktflow',
      '/api/taktflow.op',
      '/api/taktflow.stream',
    ]))

    const response = await route(host, '/api/taktflow.ping').fetch(new Request('http://localhost/api/taktflow.ping'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, version: expect.any(String) })
  })

  it('会话路由：绑定了需求返回空间和需求；未绑定只返回空间；缺参数 400', async () => {
    const { host, space, service } = await makeFixture()
    vi.mocked(service.bindings.bySession).mockImplementation(async (_space, sessionId) =>
      sessionId === 'session-1' ? 'req-1' : undefined)

    const bound = await getJson(host, '/api/taktflow.session', { sessionId: 'session-1' })
    expect(bound).toEqual({ status: 200, body: { ok: true, data: { space: space.root, requirementId: 'req-1' } } })

    const unbound = await getJson(host, '/api/taktflow.session', { sessionId: 'session-2' })
    expect(unbound).toEqual({ status: 200, body: { ok: true, data: { space: space.root } } })

    const missing = await getJson(host, '/api/taktflow.session')
    expect(missing.status).toBe(400)
    expect(missing.body.ok).toBe(false)
  })

  it('GET 读操作委托 api-core，只返回已注册空间的数据', async () => {
    const { host, space, requirementId } = await makeFixture()
    const { status, body } = await getJson(host, '/api/taktflow', { space: space.root, p: 'requirements' })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data).toEqual([expect.objectContaining({ id: requirementId })])
  })

  it('GET 不能分派写操作', async () => {
    const { host, space, approvals } = await makeFixture()
    const { status, body } = await getJson(host, '/api/taktflow', { space: space.root, p: 'attention.answer' })

    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('GET 只能执行读操作')
    expect(approvals.answer).not.toHaveBeenCalled()
  })

  it('缺少 p / space 或空间未注册时返回安全错误', async () => {
    const { host, space } = await makeFixture()
    expect((await getJson(host, '/api/taktflow', { space: space.root })).status).toBe(400)
    expect((await getJson(host, '/api/taktflow', { p: 'requirements' })).status).toBe(400)

    const outside = await realpath(await mkdtemp(join(tmpdir(), 'takt-outside-')))
    dirs.push(outside)
    const unregistered = await getJson(host, '/api/taktflow', { space: outside, p: 'requirements' })
    expect(unregistered.status).toBe(404)
    expect(unregistered.body.error.message).toBe('空间未注册')

    const missing = await getJson(host, '/api/taktflow', { space: join(outside, 'missing'), p: 'requirements' })
    expect(missing.status).toBe(404)
  })

  it('未知读操作返回 400，不泄露内部异常', async () => {
    const { host, space } = await makeFixture()
    const { status, body } = await getJson(host, '/api/taktflow', { space: space.root, p: 'not-a-read-op' })
    expect(status).toBe(400)
    expect(body.error.message).toContain('未知读操作')
  })
})

describe('registerRoutes：写操作白名单', () => {
  it('attention.answer 调用同一个 approvals.answer，by 由宿主决定', async () => {
    const { host, space, approvals, ownership } = await makeFixture()
    const { status, body } = await postJson(host, {
      space: space.root,
      p: 'attention.answer',
      requestId: 'run-1:approve',
      attempt: 1,
      artifactVersion: 1,
      decision: 'approve',
      answer: '同意',
      by: { type: 'human', id: '伪造用户' },
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, data: { requestId: 'run-1:approve', decision: 'approve' } })
    expect(approvals.answer).toHaveBeenCalledWith(space, {
      requestId: 'run-1:approve',
      attempt: 1,
      artifactVersion: 1,
      decision: 'approve',
      answer: '同意',
      by: { type: 'human', id: '面板用户', via: 'dsh-web' },
    })
    expect(ownership.ensureLease).toHaveBeenCalled()
    expect(ownership.ensureLease.mock.invocationCallOrder[0]!)
      .toBeLessThan(approvals.answer.mock.invocationCallOrder[0]!)
  })

  it('POST 支持 query 回退，且 body 字段优先', async () => {
    const { host, space, ownership, runs } = await makeFixture()
    const released = await postJson(host, {}, { space: space.root, p: 'lease.release' })
    expect(released.status).toBe(200)
    expect(ownership.release).toHaveBeenCalledWith(space)

    const cancelled = await postJson(host, { space: space.root, p: 'run.cancel', runId: 'run-1' }, { p: 'lease.release' })
    expect(cancelled.status).toBe(200)
    expect(runs.cancel).toHaveBeenCalledWith(space, 'run-1', { type: 'human', id: '面板用户', via: 'dsh-web' })
    expect(ownership.release).toHaveBeenCalledTimes(1)
  })

  it('run.start 归属会话来自绑定表，显式 session 必须匹配绑定', async () => {
    const { host, space, runs, ownership, service } = await makeFixture()
    runs.start.mockResolvedValue({ runId: 'run-9', deduped: false })

    const { status, body } = await postJson(host, {
      space: space.root,
      p: 'run.start',
      requirementId: 'req-1',
      workflowId: 'wf-1',
      sessionId: 'session-1',
      requestKey: 'key-1',
      args: { branch: 'main' },
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, data: { runId: 'run-9', deduped: false } })
    expect(runs.start).toHaveBeenCalledWith({
      space,
      requirementId: 'req-1',
      workflowId: 'wf-1',
      args: { branch: 'main' },
      ownerSessionId: 'session-1',
      requestKey: 'key-1',
    })
    expect(service.bindings.byRequirement).toHaveBeenCalledWith(space, 'req-1')
    expect(ownership.ensureLease).toHaveBeenCalled()
  })

  it('run.start 不传 session 时使用绑定会话，workflowId 默认 p0-delivery', async () => {
    const { host, space, runs } = await makeFixture()

    const { status } = await postJson(host, {
      space: space.root,
      p: 'run.start',
      requirementId: 'req-1',
      requestKey: 'key-1',
    })

    expect(status).toBe(200)
    expect(runs.start).toHaveBeenCalledWith({
      space,
      requirementId: 'req-1',
      workflowId: 'p0-delivery',
      ownerSessionId: 'session-1',
      requestKey: 'key-1',
    })
  })

  it('run.start 的 session 与绑定不一致或需求未绑定时 404，不启动运行', async () => {
    const { host, space, runs } = await makeFixture()

    const mismatch = await postJson(host, {
      space: space.root,
      p: 'run.start',
      requirementId: 'req-1',
      ownerSessionId: 'session-2',
      requestKey: 'key-1',
    })
    expect(mismatch.status).toBe(404)
    expect(mismatch.body.error.code).toBe('TAKT_NOT_BOUND')

    const unbound = await postJson(host, {
      space: space.root,
      p: 'run.start',
      requirementId: 'req-2',
      requestKey: 'key-1',
    })
    expect(unbound.status).toBe(404)
    expect(unbound.body.error.code).toBe('TAKT_NOT_BOUND')
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('run.start 缺字段时 400，不调用 RunManager', async () => {
    const { host, space, runs } = await makeFixture()
    const { status, body } = await postJson(host, {
      space: space.root,
      p: 'run.start',
      requirementId: 'req-1',
      workflowId: 'wf-1',
      sessionId: 'session-1',
    })
    expect(status).toBe(400)
    expect(body.error.message).toContain('requestKey')
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('未知写操作 400，且不拿租约、不调用任何服务', async () => {
    const { host, space, ownership, approvals, runs } = await makeFixture()
    const { status, body } = await postJson(host, { space: space.root, p: 'artifact.edit' })
    expect(status).toBe(400)
    expect(body.error.message).toContain('未知写操作')
    expect(ownership.ensureLease).not.toHaveBeenCalled()
    expect(approvals.answer).not.toHaveBeenCalled()
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('白名单固定为四个操作', () => {
    expect([...WRITE_OPS]).toEqual(['attention.answer', 'run.start', 'run.cancel', 'lease.release'])
  })

  it('租约被 CLI 占用时所有写都返回 409', async () => {
    const { host, space, ownership, approvals, runs } = await makeFixture()
    ownership.ensureLease.mockRejectedValue(new TaktToolError('TAKT_LEASE_HELD', '空间已被 CLI 占用'))

    for (const body of [
      { space: space.root, p: 'attention.answer', requestId: 'run-1:approve', attempt: 1, decision: 'approve' },
      { space: space.root, p: 'run.start', requirementId: 'req-1', workflowId: 'wf-1', ownerSessionId: 's', requestKey: 'k' },
      { space: space.root, p: 'run.cancel', runId: 'run-1' },
      { space: space.root, p: 'lease.release' },
    ]) {
      const result = await postJson(host, body)
      expect(result.status).toBe(409)
      expect(result.body.error.code).toBe('TAKT_LEASE_HELD')
    }
    expect(approvals.answer).not.toHaveBeenCalled()
    expect(runs.start).not.toHaveBeenCalled()
    expect(runs.cancel).not.toHaveBeenCalled()
  })

  it('业务错误映射成稳定状态码，原始异常不外泄', async () => {
    const { host, space, approvals } = await makeFixture()

    approvals.answer.mockRejectedValueOnce(new TaktToolError('TAKT_STALE_VERSION', '待审内容已变化'))
    const stale = await postJson(host, { space: space.root, p: 'attention.answer', requestId: 'r', attempt: 1, decision: 'approve' })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: 'TAKT_STALE_VERSION', message: '待审内容已变化' })

    approvals.answer.mockRejectedValueOnce(new ApprovalInputError('缺少 decision', '请明确选择'))
    const invalid = await postJson(host, { space: space.root, p: 'attention.answer', requestId: 'r', attempt: 1 })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toMatchObject({ code: 'TAKT_BAD_INPUT', hint: '请明确选择' })

    approvals.answer.mockRejectedValueOnce(new AttentionAlreadyAnsweredError('r'))
    const answered = await postJson(host, { space: space.root, p: 'attention.answer', requestId: 'r', attempt: 1 })
    expect(answered.status).toBe(409)

    approvals.answer.mockRejectedValueOnce(new Error('内部路径 /redacted-test-root/secret/space 崩了'))
    const internal = await postJson(host, { space: space.root, p: 'attention.answer', requestId: 'r', attempt: 1 })
    expect(internal.status).toBe(500)
    expect(JSON.stringify(internal.body)).not.toContain('secret')
    expect(internal.body.error.message).toBe('服务器内部错误')
  })

  it('lease.release 遇到仍在执行的运行时 409，不释放租约', async () => {
    const { host, space, stores, requirementId, ownership } = await makeFixture()
    await stores.runs.create({
      runId: 'run-running-1',
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      requirementId,
      status: 'running',
      startedAt: new Date().toISOString(),
      args: {},
      nodes: {},
      expansions: [],
    }, snapshotWorkflow(workflow))

    const { status, body } = await postJson(host, { space: space.root, p: 'lease.release' })
    expect(status).toBe(409)
    expect(body.error.code).toBe('TAKT_RUN_BUSY')
    expect(ownership.release).not.toHaveBeenCalled()
  })

  it('GET 直接 dispatch 写路由也返回 405，不拿租约、不执行写', async () => {
    const { host, space, ownership } = await makeFixture()
    const response = await route(host, '/api/taktflow.op').fetch(
      new Request(`http://localhost/api/taktflow.op?space=${encodeURIComponent(space.root)}&p=lease.release`, {
        method: 'GET',
      }),
    )
    expect(response.status).toBe(405)
    expect(ownership.ensureLease).not.toHaveBeenCalled()
    expect(ownership.release).not.toHaveBeenCalled()
  })

  it('请求体必须是 JSON 对象', async () => {
    const { host } = await makeFixture()
    const response = await route(host, '/api/taktflow.op').fetch(new Request('http://localhost/api/taktflow.op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('合法 JSON')
  })
})

describe('registerRoutes：SSE', () => {
  it('校验运行存在并回放历史事件，支持 Last-Event-ID 重放', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    await stores.events.append(runId, {
      type: 'run.finished',
      actor: { type: 'system', id: 'test' },
      data: { status: 'succeeded' },
    })

    const first = await route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`),
    )
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/event-stream')
    const firstReader = first.body!.getReader()
    const firstChunk = await readText(firstReader) + await readText(firstReader)
    expect(firstChunk).toContain('"seq":1')
    expect(firstChunk).toContain('"seq":2')
    await firstReader.cancel()

    const replayed = await route(host, '/api/taktflow.stream').fetch(
      new Request(
        `http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`,
        { headers: { 'last-event-id': '1' } },
      ),
    )
    const replayReader = replayed.body!.getReader()
    const replayChunk = await readText(replayReader)
    expect(replayChunk).toContain('"seq":2')
    expect(replayChunk).not.toContain('"seq":1')
    await replayReader.cancel()

    const after = await route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}&after=1`),
    )
    const afterReader = after.body!.getReader()
    expect(await readText(afterReader)).toContain('"seq":2')
    await afterReader.cancel()
  })

  it('运行不存在、缺 run、after 非法时返回 JSON 错误', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)

    const missing = await getJson(host, '/api/taktflow.stream', { space: space.root, run: 'run-missing' })
    expect(missing.status).toBe(404)

    const noRun = await getJson(host, '/api/taktflow.stream', { space: space.root })
    expect(noRun.status).toBe(400)

    const badAfter = await getJson(host, '/api/taktflow.stream', { space: space.root, run: runId, after: 'x' })
    expect(badAfter.status).toBe(400)
  })

  it('客户端 reader.cancel() 恰好取消一次 core 订阅', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)

    const response = await route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`),
    )
    const reader = response.body!.getReader()
    await readText(reader)
    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).not.toHaveBeenCalled()

    await reader.cancel()
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('请求 abort 恰好取消一次 core 订阅', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)

    const controller = new AbortController()
    const response = await route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`, {
        signal: controller.signal,
      }),
    )
    const reader = response.body!.getReader()
    controller.abort()
    await drain(reader)

    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('请求进入时已经 abort，立即返回 204 而不等待 ready', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const controller = new AbortController()
    controller.abort()

    const response = await withTimeout(
      route(host, '/api/taktflow.stream').fetch(
        new Request(
          `http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`,
          { signal: controller.signal },
        ),
      ),
    )
    expect(response.status).toBe(204)
  })

  it('ready 阻塞期间请求 abort：返回 204，不创建流和心跳，订阅只清理一次', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)
    // 让历史读取永远不完成，模拟 ready 一直阻塞。
    stores.events.read = () => new Promise(() => {})

    const controller = new AbortController()
    const pending = route(host, '/api/taktflow.stream').fetch(
      new Request(
        `http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`,
        { signal: controller.signal },
      ),
    )
    await waitFor(() => events.subscribe.mock.calls.length === 1)
    controller.abort()

    const response = await withTimeout(pending)
    expect(response.status).toBe(204)
    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ready 阻塞期间宿主卸载：返回 204，不创建流和心跳，订阅只清理一次', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)
    stores.events.read = () => new Promise(() => {})

    const pending = route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`),
    )
    await waitFor(() => events.subscribe.mock.calls.length === 1)
    await withTimeout(host.dispose())

    const response = await withTimeout(pending)
    expect(response.status).toBe(204)
    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('runs.get 阻塞期间请求 abort：返回 204，不悬挂', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    stores.runs.get = () => new Promise(() => {})

    const controller = new AbortController()
    const pending = route(host, '/api/taktflow.stream').fetch(
      new Request(
        `http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`,
        { signal: controller.signal },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    const response = await withTimeout(pending)
    expect(response.status).toBe(204)
  })

  it('runs.get 阻塞期间宿主卸载：返回 204，不悬挂', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    stores.runs.get = () => new Promise(() => {})

    const pending = route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await withTimeout(host.dispose())

    const response = await withTimeout(pending)
    expect(response.status).toBe(204)
  })

  it('宿主卸载时清理活动 SSE，并只取消一次 core 订阅', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)

    const response = await route(host, '/api/taktflow.stream').fetch(
      new Request(`http://localhost/api/taktflow.stream?space=${encodeURIComponent(space.root)}&run=${runId}`),
    )
    const reader = response.body!.getReader()
    await readText(reader)
    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).not.toHaveBeenCalled()

    await host.dispose()
    await drain(reader)
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('事件日志损坏时返回安全 500，而不是吞成 204，且订阅只清理一次', async () => {
    const { host, space, stores, requirementId } = await makeFixture()
    const runId = await createRun(stores, requirementId)
    const events = spyEvents(stores)
    // 在合法历史事件后追加一行坏 JSON：read 必须失败，ready 不能当成“请求已取消”。
    await appendFile(join(stores.taktDir, 'runs', runId, 'events.jsonl'), '{"broken": true\n', 'utf8')

    const { status, body } = await getJson(host, '/api/taktflow.stream', { space: space.root, run: runId })
    expect(status).toBe(500)
    expect(body).toEqual({ ok: false, error: { code: 'TAKT_INTERNAL', message: '服务器内部错误' } })
    expect(events.subscribe).toHaveBeenCalledTimes(1)
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
