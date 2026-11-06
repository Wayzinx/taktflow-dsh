import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  initProject,
  type Actor,
  type EventPayloads,
  type EventType,
  type Insights,
  type ProjectStores,
  type RunState,
  type RunStatus,
  type WorkflowSnapshot,
} from '@taktflow/core'
import { beginAutonomyAnswer } from './autonomy-state.js'
import type { Agent, UserMessage } from './dsh-types.js'
import { createNotifier } from './notify.js'
import type { Bindings, SpaceHandle } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface Recorded {
  kind: 'followup' | 'inject'
  text: string
}

function fakeAgent(id: string, calls: Recorded[]): Agent {
  return {
    id,
    options: {},
    session: { header: { id } },
    followup(message: UserMessage): void {
      calls.push({ kind: 'followup', text: messageText(message) })
    },
    inject(message: UserMessage): void {
      calls.push({ kind: 'inject', text: messageText(message) })
    },
  }
}

function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function bindingsFor(sessionId: string | undefined, hooks?: { onByRequirement?: () => void }): Bindings {
  return {
    async bind() {},
    async byRequirement() {
      hooks?.onByRequirement?.()
      return sessionId
    },
    async bySession() {
      return undefined
    },
  }
}

function emptySnapshot(): WorkflowSnapshot {
  return { id: 'probe', title: '探针', version: '1', stages: [], nodes: [] }
}

function runState(requirementId: string, runId: string, status: RunStatus = 'running'): RunState {
  return {
    runId,
    workflowId: 'probe',
    workflowVersion: '1',
    requirementId,
    status,
    startedAt: new Date().toISOString(),
    args: {},
    nodes: { 'node-1': { id: 'node-1', status: status === 'running' ? 'running' : 'waiting_human', attempts: 1, outputs: [] } },
    expansions: [],
  }
}

async function fixture(options: { status?: RunStatus; pending?: boolean; ask?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-notify-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '通知验收' })
  const runId = 'run-notify-1'
  await stores.runs.create(runState(requirement.id, runId, options.status ?? 'running'), emptySnapshot())
  if (options.pending) {
    await stores.attention.create({
      requestId: `${runId}:node-1`,
      runId,
      nodeId: 'node-1',
      requirementId: requirement.id,
      ask: options.ask ?? '请审批 design/design.md',
      form: 'approve',
      attempt: 1,
      subjects: [],
    })
  }
  const space: SpaceHandle = { root, stores, insights: {} as Insights }
  return { root, stores, requirementId: requirement.id, runId, space }
}

function appendEvent<T extends EventType>(
  stores: ProjectStores,
  runId: string,
  event: { type: T; actor: Actor; nodeId?: string; data: EventPayloads[T] },
): Promise<unknown> {
  return stores.events.append(runId, event)
}

async function saveStatus(stores: ProjectStores, runId: string, status: RunStatus): Promise<void> {
  const state = await stores.runs.get(runId)
  if (!state) throw new Error(`运行不存在：${runId}`)
  state.status = status
  await stores.runs.save(state)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('通知器', () => {
  it('首次 attach 补当前状态并写快照；重复 attach 幂等', async () => {
    const { root, stores, requirementId, runId, space } = await fixture({ status: 'waiting_human', pending: true })
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })

    await notifier.attach(space)
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)

    expect(calls[0]!.kind).toBe('followup')
    expect(calls[0]!.text).toContain(`REQ=${requirementId}`)
    expect(calls[0]!.text).toContain(`run=${runId}`)
    expect(calls[0]!.text).toContain(`${runId}:node-1`)
    expect(calls[0]!.text).toContain('下一步：调用 takt_ask_human')

    const json = JSON.parse(await readFile(join(root, '.takt/status', `${requirementId}.json`), 'utf8')) as {
      requirement: string
      pending: Array<{ requestId: string }>
      runs: Array<{ runId: string; status: string }>
    }
    expect(json.requirement).toBe(requirementId)
    expect(json.pending[0]?.requestId).toBe(`${runId}:node-1`)
    expect(json.runs[0]).toMatchObject({ runId, status: 'waiting_human' })
    const markdown = await readFile(join(root, '.takt/status', `${requirementId}.md`), 'utf8')
    expect(markdown).toContain(`${runId}:node-1`)

    // 幂等：再次 attach 不产生第二个轮询器，也不会重复通知同一状态。
    await sleep(80)
    expect(calls).toHaveLength(1)
    await notifier.detach(space)
  })

  it('普通事件用 inject；guard.violation 用 followup；同 seq/state 不重复', async () => {
    const { stores, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)
    expect(calls[0]!.kind).toBe('inject')
    expect(calls[0]!.text).toContain('当前状态：running')

    await appendEvent(stores, runId, {
      type: 'node.started',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { attempt: 1 },
    })
    await waitFor(() => calls.length === 2)
    expect(calls[1]!.kind).toBe('inject')
    expect(calls[1]!.text).toContain('节点=node-1 开始（第 1 次）')

    await appendEvent(stores, runId, {
      type: 'guard.violation',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { rule: 'writeScope', paths: ['secret.txt'], action: 'blocked' },
    })
    await waitFor(() => calls.length === 3)
    expect(calls[2]!.kind).toBe('followup')
    expect(calls[2]!.text).toContain('写入越界')
    expect(calls[2]!.text).toContain('下一步：用 takt_run get')

    // 同样的 seq / 状态再轮询多次也不能重复通知。
    await sleep(100)
    expect(calls).toHaveLength(3)
    await notifier.detach(space)
  })

  it('同一需求合并窗口内的多条事件只发一条，终态唤醒不会被普通事件覆盖', async () => {
    const { stores, requirementId, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 120,
    })
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)
    const before = calls.length

    await appendEvent(stores, runId, {
      type: 'node.finished',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { status: 'succeeded', outputs: [] },
    })
    await appendEvent(stores, runId, {
      type: 'run.finished',
      actor: { type: 'system', id: 'test' },
      data: { status: 'succeeded' },
    })
    await saveStatus(stores, runId, 'succeeded')

    await waitFor(() => calls.length === before + 1)
    const merged = calls.at(-1)!
    expect(merged.kind).toBe('followup')
    expect(merged.text).toContain('节点=node-1 完成：succeeded')
    expect(merged.text).toContain('运行结束：succeeded')
    expect(merged.text).toContain(`REQ=${requirementId}`)
    expect(merged.text).toContain('下一步：用 takt_status / takt_trace')
    expect(calls).toHaveLength(before + 1)
    await notifier.detach(space)
  })

  it('通知文本先 redact 再按 Unicode 码点截断到 200 字以内', async () => {
    const { stores, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)
    const before = calls.length
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const longAsk = `密钥 ${secret} ${'很长的待审批说明'.repeat(40)} 结束`
    await appendEvent(stores, runId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId: `${runId}:node-1`, ask: longAsk, form: 'approve' },
    })
    await waitFor(() => calls.length === before + 1)
    const text = calls.at(-1)!.text
    expect(Array.from(text).length).toBeLessThanOrEqual(200)
    expect(text.endsWith('…')).toBe(true)
    expect(text).not.toContain(secret)
    expect(text).toContain('[REDACTED]')
    expect(calls.at(-1)!.kind).toBe('followup')
    await notifier.detach(space)
  })

  it('Lead 离线时只写快照，不调用 inject/followup', async () => {
    const { root, requirementId, stores, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: () => undefined, roots: () => [] } },
      bindings: bindingsFor('missing-session'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await appendEvent(stores, runId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId: `${runId}:node-1`, ask: '请审批', form: 'approve' },
    })
    await saveStatus(stores, runId, 'waiting_human')
    await waitFor(() => true)
    await sleep(100)
    expect(calls).toHaveLength(0)
    const json = JSON.parse(await readFile(join(root, '.takt/status', `${requirementId}.json`), 'utf8')) as {
      runs: Array<{ status: string }>
    }
    expect(json.runs[0]?.status).toBe('waiting_human')
    await notifier.detach(space)
  })

  it('detach 清理定时器并在途结束后不再写；未 attach 的 detach 是 no-op；可重新 attach', async () => {
    const { root, stores, requirementId, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await expect(notifier.detach(space)).resolves.toBeUndefined()

    await notifier.attach(space)
    await waitFor(() => calls.length === 1)
    await notifier.detach(space)

    const snapshotFile = join(root, '.takt/status', `${requirementId}.json`)
    const before = await readFile(snapshotFile, 'utf8')
    await appendEvent(stores, runId, {
      type: 'guard.violation',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { rule: 'writeScope', paths: ['x'], action: 'blocked' },
    })
    await sleep(120)
    expect(calls).toHaveLength(1)
    expect(await readFile(snapshotFile, 'utf8')).toBe(before)

    // 重新 attach 后恢复轮询，并补当前状态。
    await notifier.attach(space)
    await waitFor(() => calls.length === 2)
    await notifier.detach(space)
  })

  it('磁盘/绑定故障不外抛，attach 与 detach 都能正常返回', async () => {
    const { root, stores, space } = await fixture({ status: 'waiting_human', pending: true })
    const brokenStores = {
      ...stores,
      runs: {
        ...stores.runs,
        list: async () => {
          throw new Error('磁盘故障')
        },
      },
    } as unknown as ProjectStores
    const brokenSpace: SpaceHandle = { root, stores: brokenStores, insights: {} as Insights }
    const notifier = createNotifier({
      ctx: { agents: { get: () => undefined, roots: () => [] } },
      bindings: bindingsFor('session-1', { onByRequirement: () => { throw new Error('绑定故障') } }),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await expect(notifier.attach(brokenSpace)).resolves.toBeUndefined()
    await sleep(60)
    await expect(notifier.detach(brokenSpace)).resolves.toBeUndefined()

    const bindingFailure = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, []) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1', { onByRequirement: () => { throw new Error('绑定故障') } }),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await expect(bindingFailure.attach(space)).resolves.toBeUndefined()
    await sleep(60)
    await expect(bindingFailure.detach(space)).resolves.toBeUndefined()
  })

  it('超过 200 字的普通进度不会截掉后到的待审批 requestId 和 next action', async () => {
    const { stores, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 1_000,
    })
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)
    const before = calls.length

    // 先灌入远超 200 字的普通进度。
    for (let index = 0; index < 20; index++) {
      await appendEvent(stores, runId, {
        type: 'node.started',
        actor: { type: 'system', id: 'test' },
        nodeId: `node-${'x'.repeat(30)}-${index}`,
        data: { attempt: 1 },
      })
    }
    const requestId = `${runId}:node-1`
    await appendEvent(stores, runId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId, ask: '请审批', form: 'approve' },
    })

    await waitFor(() => calls.slice(before).some((call) => call.text.includes(requestId)))
    const human = calls.slice(before).find((call) => call.text.includes(requestId))!
    expect(human.kind).toBe('followup')
    expect(Array.from(human.text).length).toBeLessThanOrEqual(200)
    expect(human.text).toContain('下一步：调用 takt_ask_human')
    await notifier.detach(space)
  })

  it('Lead 离线时只落快照，上线后补发待审批唤醒', async () => {
    const { root, requirementId, runId, space } = await fixture({ status: 'waiting_human', pending: true })
    const calls: Recorded[] = []
    let agent: Agent | undefined
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? agent : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    const snapshotFile = join(root, '.takt/status', `${requirementId}.json`)

    await notifier.attach(space)
    await waitFor(async () => {
      try {
        await access(snapshotFile)
        return true
      } catch {
        return false
      }
    })
    expect(calls).toHaveLength(0)

    // Agent 上线后不需要新事件，下一轮轮询应补发未送达的待审批唤醒。
    agent = fakeAgent('session-1', calls)
    await waitFor(() => calls.length === 1)
    expect(calls[0]!.kind).toBe('followup')
    expect(calls[0]!.text).toContain(`${runId}:node-1`)
    await notifier.detach(space)
  })

  it('快照瞬时失败保留 dirty，下一轮没有新事件也能重试', async () => {
    const { root, requirementId, stores, space } = await fixture({ status: 'waiting_human', pending: true })
    let failures = 1
    let attempts = 0
    const flakyStores = {
      ...stores,
      runs: {
        ...stores.runs,
        list: async (options?: { requirementId?: string }) => {
          if (options?.requirementId !== undefined) {
            attempts++
            if (failures > 0) {
              failures--
              throw new Error('瞬时磁盘故障')
            }
          }
          return stores.runs.list(options)
        },
      },
    } as unknown as ProjectStores
    const flakySpace: SpaceHandle = { root, stores: flakyStores, insights: {} as Insights }
    const notifier = createNotifier({
      ctx: { agents: { get: () => undefined, roots: () => [] } },
      bindings: bindingsFor(undefined),
      pollIntervalMs: 10,
      mergeWindowMs: 5_000,
    })

    await notifier.attach(flakySpace)
    await waitFor(async () => {
      try {
        await access(join(root, '.takt/status', `${requirementId}.json`))
        return true
      } catch {
        return false
      }
    })
    expect(attempts).toBeGreaterThanOrEqual(2)
    await notifier.detach(flakySpace)
  })

  it('detach 等待首次 poll，buildSnapshot 后不再写快照', async () => {
    const { root, requirementId, stores, space } = await fixture({ status: 'waiting_human', pending: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = false
    const slowStores = {
      ...stores,
      runs: {
        ...stores.runs,
        list: async (options?: { requirementId?: string }) => {
          if (options?.requirementId !== undefined) {
            entered = true
            await gate
          }
          return stores.runs.list(options)
        },
      },
    } as unknown as ProjectStores
    const slowSpace: SpaceHandle = { root, stores: slowStores, insights: {} as Insights }
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })

    const attaching = notifier.attach(slowSpace)
    await waitFor(() => entered)
    let detached = false
    const detaching = notifier.detach(slowSpace).then(() => { detached = true })
    await sleep(30)
    expect(detached).toBe(false)

    release()
    await attaching
    await detaching
    expect(calls).toHaveLength(0)
    await expect(access(join(root, '.takt/status', `${requirementId}.json`))).rejects.toBeTruthy()
  })

  it('detach 期间阻塞的投递不再发送，重 attach 后旧状态不覆盖新快照', async () => {
    const { root, requirementId, runId, stores, space } = await fixture()
    let blockNext = false
    let release: () => void = () => {}
    let gate = Promise.resolve()
    let entered = false
    const calls: Recorded[] = []
    const bindings: Bindings = {
      async bind() {},
      async byRequirement() {
        if (blockNext) {
          blockNext = false
          entered = true
          await gate
        }
        return 'session-1'
      },
      async bySession() {
        return undefined
      },
    }
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings,
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await waitFor(() => calls.length === 1)

    // 触发一条带唤醒的投递，并卡在绑定读取上。
    gate = new Promise<void>((resolve) => { release = resolve })
    blockNext = true
    await appendEvent(stores, runId, {
      type: 'guard.violation',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { rule: 'writeScope', paths: ['secret.txt'], action: 'blocked' },
    })
    await waitFor(() => entered)

    const detaching = notifier.detach(space)
    // detach 已同步移除旧状态；立即重 attach 出新状态。
    await notifier.attach(space)
    await waitFor(() => calls.length === 2)
    await sleep(50)
    const snapshotFile = join(root, '.takt/status', `${requirementId}.json`)
    const afterReattach = await readFile(snapshotFile, 'utf8')

    release()
    await detaching
    await sleep(50)
    expect(calls).toHaveLength(2)
    expect(await readFile(snapshotFile, 'utf8')).toBe(afterReattach)
    await notifier.detach(space)
  })

  it('attach 时纳入 provider 敏感 header 脱敏，快照不落密钥', async () => {
    const secret = 'provider-header-secret-123456'
    const { root, requirementId, stores, space } = await fixture({
      status: 'waiting_human',
      pending: true,
      ask: `请审批 ${secret}`,
    })
    const calls: Recorded[] = []
    // 先创建通知器，再补 provider 配置，证明脱敏器在 attach 时收集。
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    stores.config.providers = {
      probe: {
        protocol: 'openai-chat',
        baseURL: 'https://example.invalid/v1',
        headers: { Authorization: `Bearer ${secret}` },
      },
    }

    await notifier.attach(space)
    const snapshotFile = join(root, '.takt/status', `${requirementId}.json`)
    await waitFor(async () => {
      try {
        await access(snapshotFile)
        return true
      } catch {
        return false
      }
    })
    const snapshot = await readFile(snapshotFile, 'utf8')
    expect(snapshot).not.toContain(secret)
    expect(snapshot).toContain('[REDACTED]')
    await notifier.detach(space)
  })

  it('run.finished(waiting_human) 按当前待办判定：AI 处理中不唤醒，marker 释放后也不补旧卡', async () => {
    const { root, stores, requirementId, runId, space } = await fixture({ status: 'waiting_human', pending: true })
    const calls: Recorded[] = []
    const release = beginAutonomyAnswer(root, `${runId}:node-1`)
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await appendEvent(stores, runId, {
      type: 'run.finished',
      actor: { type: 'system', id: 'test' },
      data: { status: 'waiting_human' },
    })
    await sleep(120)
    expect(calls.filter((call) => call.kind === 'followup')).toHaveLength(0)
    // 释放 marker 后没有新事件，不能把历史 run.finished 再补发成人工唤醒。
    release()
    await sleep(80)
    expect(calls.filter((call) => call.kind === 'followup')).toHaveLength(0)
    expect(await readFile(join(root, '.takt/status', `${requirementId}.json`), 'utf8')).toContain(`${runId}:node-1`)
    await notifier.detach(space)
  })

  it('run.finished(waiting_human) 在待办已回答时只记进度，不唤醒人', async () => {
    const { stores, requirementId, runId, space } = await fixture({ status: 'waiting_human', pending: true })
    const item = (await stores.attention.list({ requirementId, pending: true }))[0]!
    await stores.attention.answer(item.requestId, { decision: 'approve', by: { type: 'human', id: '审批人' } })
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await appendEvent(stores, runId, {
      type: 'run.finished',
      actor: { type: 'system', id: 'test' },
      data: { status: 'waiting_human' },
    })
    await sleep(120)
    expect(calls.every((call) => call.kind === 'inject')).toBe(true)
    await notifier.detach(space)
  })

  it('历史 human.requested 在待办已回答后回放不再唤醒人', async () => {
    const { stores, requirementId, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)

    // attach 之后新建运行，模拟历史事件在新一轮轮询里从头回放。
    const secondRunId = 'run-notify-2'
    await stores.runs.create(runState(requirementId, secondRunId, 'waiting_human'), emptySnapshot())
    const requestId = `${secondRunId}:node-1`
    await stores.attention.create({
      requestId, runId: secondRunId, nodeId: 'node-1', requirementId, ask: '历史待办', form: 'approve', attempt: 1, subjects: [],
    })
    await stores.attention.answer(requestId, { decision: 'approve', by: { type: 'human', id: '审批人' } })
    await appendEvent(stores, secondRunId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId, ask: '历史待办', form: 'approve' },
    })
    await sleep(120)
    expect(calls.filter((call) => call.kind === 'followup')).toHaveLength(0)
    expect(calls.some((call) => call.text.includes(requestId))).toBe(false)
    await notifier.detach(space)
  })

  it('投递前复核：合并窗口内待办已回答则撤掉人工唤醒', async () => {
    const { stores, requirementId, runId, space } = await fixture()
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 80,
    })
    await notifier.attach(space)
    const requestId = `${runId}:node-1`
    await stores.attention.create({
      requestId, runId, nodeId: 'node-1', requirementId, ask: '待审批', form: 'approve', attempt: 1, subjects: [],
    })
    await appendEvent(stores, runId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId, ask: '待审批', form: 'approve' },
    })
    // 等事件被轮询读入并进入合并窗口，再在窗口内直接落账（不产生 human.answered 事件）。
    await sleep(40)
    await stores.attention.answer(requestId, { decision: 'approve', by: { type: 'human', id: '审批人' } })
    await sleep(120)
    expect(calls.filter((call) => call.kind === 'followup')).toHaveLength(0)
    await notifier.detach(space)
  })

  it('待办所属运行记录不存在时不唤醒人，不把未知运行当成可回答', async () => {
    const { stores, requirementId, runId, space } = await fixture()
    const requestId = 'ghost-run:node-1'
    await stores.attention.create({
      requestId, runId: 'ghost-run', nodeId: 'node-1', requirementId,
      ask: '孤儿待办', form: 'approve', attempt: 1, subjects: [],
    })
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 20,
    })
    await notifier.attach(space)
    await appendEvent(stores, runId, {
      type: 'human.requested',
      actor: { type: 'system', id: 'test' },
      nodeId: 'node-1',
      data: { requestId, ask: '孤儿待办', form: 'approve' },
    })
    await sleep(120)
    expect(calls.filter((call) => call.kind === 'followup')).toHaveLength(0)
    expect(calls.some((call) => call.text.includes(requestId))).toBe(false)
    await notifier.detach(space)
  })

  it('同空间另一个人工 run 不被 AI 处理中的 run 误挡', async () => {
    const { root, stores, requirementId, runId, space } = await fixture({ status: 'waiting_human', pending: true })
    const secondRunId = 'run-notify-2'
    await stores.runs.create(runState(requirementId, secondRunId, 'waiting_human'), emptySnapshot())
    const secondRequest = `${secondRunId}:node-1`
    await stores.attention.create({
      requestId: secondRequest, runId: secondRunId, nodeId: 'node-1', requirementId, ask: '另一个待审批', form: 'approve', attempt: 1, subjects: [],
    })
    const release = beginAutonomyAnswer(root, `${runId}:node-1`)
    const calls: Recorded[] = []
    const notifier = createNotifier({
      ctx: { agents: { get: (id) => (id === 'session-1' ? fakeAgent(id, calls) : undefined), roots: () => [] } },
      bindings: bindingsFor('session-1'),
      pollIntervalMs: 10,
      mergeWindowMs: 30,
    })
    await notifier.attach(space)
    await waitFor(() => calls.some((call) => call.kind === 'followup' && call.text.includes(secondRequest)))
    const followups = calls.filter((call) => call.kind === 'followup')
    expect(followups.some((call) => call.text.includes(`${runId}:node-1`))).toBe(false)
    release()
    await notifier.detach(space)
  })
})
