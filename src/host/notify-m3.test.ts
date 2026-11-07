import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attributeDefect,
  confirmDefect,
  initProject,
  reportDefect,
  runEval,
  saveEvalCase,
  waitEvalRun,
  type AgentProfile,
  type EvalCase,
  type HarnessAdapter,
  type Insights,
  type RunState,
} from '@taktflow/core'
import { createLocalSandboxProvider } from '@taktflow/sandbox'
import type { Agent, UserMessage } from './dsh-types.js'
import { createNotifier } from './notify.js'
import type { Bindings, Notifier, SpaceHandle } from './types.js'

const roots: string[] = []
const attached: Array<{ notifier: Notifier; space: SpaceHandle }> = []
afterEach(async () => {
  await Promise.all(attached.splice(0).map(({ notifier, space }) => notifier.detach(space)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function waitFor(test: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (await test()) return
    await sleep(10)
  }
  throw new Error('等待 M3 通知超时')
}

function profile(role: string): AgentProfile {
  return { role, title: role, description: '', instructions: '', harness: { harness: 'test' }, skills: [], writeScope: [] }
}

async function fixture(options: { offline?: boolean; mergeWindowMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-notify-m3-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: '通知归属甲' })
  const other = await stores.workspaces.createRequirement({ title: '通知归属乙' })
  const space: SpaceHandle = { root, stores, insights: {} as Insights }
  const calls: Array<{ kind: 'followup' | 'inject'; sessionId: string; text: string }> = []
  let online = !options.offline
  const agent = (sessionId: string): Agent => {
    const record = (kind: 'followup' | 'inject', message: UserMessage) => {
      calls.push({ kind, sessionId, text: message.content.filter((part) => part.type === 'text').map((part) => part.text).join('') })
    }
    return {
      id: sessionId, options: {}, session: { header: { id: sessionId } },
      followup: (message) => record('followup', message),
      inject: (message) => record('inject', message),
    }
  }
  const bindings: Bindings = {
    async bind() {}, async bySession() { return undefined },
    async byRequirement(_space, id) { return `lead-${id}` },
  }
  const notifier = createNotifier({
    ctx: { agents: { get: (id) => online ? agent(id) : undefined, roots: () => [] } },
    bindings, pollIntervalMs: 10, mergeWindowMs: options.mergeWindowMs ?? 40,
  })
  attached.push({ notifier, space })
  const harness: HarnessAdapter = {
    id: 'test', displayName: '测试替身', available: async () => ({ ok: true }),
    async run() {
      return { ok: true, finalText: '', structured: {
        introducedAt: { origin: 'unknown', evidence: ['现有产物不足以定位引入节点'] },
        missedBy: [], confidence: 0.2, suggestions: [],
      } }
    },
  }
  const deps = {
    stores, profiles: { auditor: profile('auditor'), coder: profile('coder') },
    knowledge: [], harnesses: { test: harness }, sandbox: createLocalSandboxProvider(),
  }
  const by = { type: 'human' as const, id: 'tester', via: 'dsh:user-questions' }
  async function candidate() {
    const defect = await reportDefect(stores, requirement.id, { title: '线上缺陷', description: '边界输入报错', severity: 'major' }, by)
    await attributeDefect(deps, requirement.id, defect.id)
    return defect.id
  }
  async function source(id: string, req = requirement.id) {
    const state: RunState = {
      runId: id, workflowId: 'probe', workflowVersion: '1', requirementId: req,
      status: 'succeeded', startedAt: new Date().toISOString(), args: {}, expansions: [],
      nodes: { task: { id: 'task', status: 'succeeded', attempts: 1, outputs: [] } },
    }
    await stores.runs.create(state, { id: 'probe', title: '来源', version: '1', stages: [], nodes: [] })
    return id
  }
  function evalCase(id: string, runId?: string): EvalCase {
    return {
      id, title: '冻结回放', target: { kind: 'node', workflowId: 'probe', nodeId: 'task' },
      source: { kind: runId ? 'history' : 'manual', ...(runId ? { runId, nodeId: 'task' } : {}) },
      node: { id: 'task', kind: 'agent', title: '回放', role: 'coder', needs: [], prompt: '仅返回完成', outputs: [], writeScope: [] },
      inputs: [], grading: {}, createdAt: new Date().toISOString(),
    }
  }
  async function startEval(cases: EvalCase[]) {
    for (const value of cases) await saveEvalCase(stores, value)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const replay: HarnessAdapter = { ...harness, async run() { await gate; return { ok: true, finalText: '完成' } } }
    const run = await runEval({ ...deps, harnesses: { test: replay } }, {
      target: cases[0]!.target, caseIds: cases.map((value) => value.id), variants: [{ id: 'baseline', label: '基线' }],
    }, by)
    return { run, release }
  }
  return {
    root, stores, requirementId: requirement.id, otherId: other.id, space, notifier, calls, by,
    candidate, source, evalCase, startEval, setOnline: (value: boolean) => { online = value },
    m3Calls: () => calls.filter((call) => /缺陷|评测/.test(call.text)),
  }
}

describe('M3 通知：真实 core 落盘与会话投递', () => {
  it('auditor 候选和人工确认分别 followup，重复审计不重复通知且每条不超过 200 字', async () => {
    const f = await fixture()
    await f.notifier.attach(f.space)
    const defectId = await f.candidate()
    // 录入与模型完成可能跨合并窗口；普通“已录入”inject 不属于归因完成通知。
    const candidates = () => f.m3Calls().filter((call) => call.text.includes('候选归因已生成（auditor），待人工确认'))
    const confirmed = () => f.m3Calls().filter((call) => call.text.includes('归因已由人确认'))
    await waitFor(() => candidates().length === 1)
    expect(candidates()[0]).toMatchObject({ kind: 'followup', sessionId: `lead-${f.requirementId}` })
    await confirmDefect(f.stores, f.requirementId, defectId, {}, f.by)
    await waitFor(() => confirmed().length === 1)
    expect(confirmed()[0]!.kind).toBe('followup')
    await sleep(100)
    expect(candidates()).toHaveLength(1)
    expect(confirmed()).toHaveLength(1)
    expect(f.m3Calls().every((call) => Array.from(call.text).length <= 200)).toBe(true)
    expect((await f.stores.events.verify(`defect-${f.requirementId}`)).ok).toBe(true)
  })

  it('候选在同一窗口已确认时去掉待确认提示，同时保留确认完成唤醒', async () => {
    const f = await fixture({ mergeWindowMs: 250 })
    await f.notifier.attach(f.space)
    // 两次真实写入完成后才让同一轮轮询读取，保证测试不依赖模型/磁盘耗时。
    const read = f.stores.events.read.bind(f.stores.events)
    f.stores.events.read = async (id, options) => id === `defect-${f.requirementId}` ? [] : read(id, options)
    const defectId = await f.candidate()
    await confirmDefect(f.stores, f.requirementId, defectId, {}, f.by)
    f.stores.events.read = read
    await waitFor(() => f.m3Calls().length === 1)
    expect(f.m3Calls()[0]!.kind).toBe('followup')
    expect(f.m3Calls()[0]!.text).toContain('归因已由人确认')
    expect(f.m3Calls()[0]!.text).not.toContain('待人工确认')
    expect(f.m3Calls()[0]!.text).not.toContain('调用 takt_ask_human')
    await sleep(300)
    expect(f.m3Calls()).toHaveLength(1)
  })

  it('离线候选在上线前已确认，即使确认事件暂不可读也不补发旧待办', async () => {
    const f = await fixture({ offline: true })
    await f.notifier.attach(f.space)
    const defectId = await f.candidate()
    const snapshot = join(f.root, '.takt', 'status', `${f.requirementId}.json`)
    await waitFor(async () => {
      const data = JSON.parse(await readFile(snapshot, 'utf8').catch(() => '{}')) as { lastMessage?: string }
      return data.lastMessage?.includes('待人工确认') === true
    })
    const read = f.stores.events.read.bind(f.stores.events)
    f.stores.events.read = async (id, options) => {
      if (id === `defect-${f.requirementId}`) throw new Error('审计流暂不可读')
      return read(id, options)
    }
    await confirmDefect(f.stores, f.requirementId, defectId, {}, f.by)
    f.setOnline(true)
    await sleep(120)
    expect(f.m3Calls()).toHaveLength(0)
    f.stores.events.read = read
    await waitFor(() => f.m3Calls().length === 1)
    expect(f.m3Calls()[0]!.kind).toBe('followup')
    expect(f.m3Calls()[0]!.text).toContain('归因已由人确认')
    expect(f.m3Calls()[0]!.text).not.toContain('待人工确认')
  })

  it('评测归属只读取该次冻结用例，当前用例改到另一需求也不串 Lead', async () => {
    const f = await fixture()
    const original = await f.source('source-original')
    const changed = await f.source('source-changed', f.otherId)
    await f.notifier.attach(f.space)
    const value = f.evalCase('frozen-case', original)
    const { run, release } = await f.startEval([value])
    await saveEvalCase(f.stores, { ...value, source: { kind: 'history', runId: changed, nodeId: 'task' } })
    release()
    const done = await waitEvalRun(f.stores, run.id)
    expect(done.status).toBe('done')
    expect(done.results).toHaveLength(1)
    await waitFor(() => f.m3Calls().length === 1)
    expect(f.m3Calls()[0]).toMatchObject({ kind: 'followup', sessionId: `lead-${f.requirementId}` })
    expect(f.m3Calls()[0]!.text).toContain('完成：通过 1/1')
    expect(Array.from(f.m3Calls()[0]!.text).length).toBeLessThanOrEqual(200)
  })

  it('有来源和无来源用例混合评测，不假定唯一归属也不广播', async () => {
    const f = await fixture()
    const source = await f.source('source-mixed')
    await f.notifier.attach(f.space)
    const { run, release } = await f.startEval([f.evalCase('sourced', source), f.evalCase('manual')])
    release()
    expect((await waitEvalRun(f.stores, run.id)).status).toBe('done')
    await sleep(180)
    expect(f.m3Calls()).toHaveLength(0)
  })

  it('冻结用例瞬时缺失时不推进终态游标，恢复后补发一次', async () => {
    const f = await fixture()
    const source = await f.source('source-retry')
    await f.notifier.attach(f.space)
    const { run, release } = await f.startEval([f.evalCase('retry-case', source)])
    const frozen = join(f.stores.taktDir, 'evals', 'runs', run.id, 'cases', 'retry-case.json')
    await rename(frozen, `${frozen}.held`)
    release()
    await waitEvalRun(f.stores, run.id)
    await sleep(120)
    expect(f.m3Calls()).toHaveLength(0)
    await rename(`${frozen}.held`, frozen)
    await waitFor(() => f.m3Calls().length === 1)
    await sleep(100)
    expect(f.m3Calls()).toHaveLength(1)
  })

  it('首次 attach 不回放历史确认或历史评测完成', async () => {
    const f = await fixture()
    const defectId = await f.candidate()
    await confirmDefect(f.stores, f.requirementId, defectId, {}, f.by)
    const source = await f.source('source-history')
    const { run, release } = await f.startEval([f.evalCase('history-case', source)])
    release()
    await waitEvalRun(f.stores, run.id)
    await f.notifier.attach(f.space)
    await sleep(150)
    expect(f.m3Calls()).toHaveLength(0)
    expect(f.calls.every((call) => call.kind === 'inject')).toBe(true)
  })

  it('attach 首次读历史记录失败，恢复后只建基线，不重放历史完成', async () => {
    const f = await fixture()
    const defectId = await f.candidate()
    await confirmDefect(f.stores, f.requirementId, defectId, {}, f.by)
    const source = await f.source('source-history-retry')
    const { run, release } = await f.startEval([f.evalCase('history-retry', source)])
    release()
    await waitEvalRun(f.stores, run.id)
    const file = join(f.stores.taktDir, 'evals', 'runs', `${run.id}.json`)
    const contents = await readFile(file, 'utf8')
    await writeFile(file, '{')
    const read = f.stores.events.read.bind(f.stores.events)
    f.stores.events.read = async (id, options) => {
      if (id === `defect-${f.requirementId}`) throw new Error('首次读取失败')
      return read(id, options)
    }
    await f.notifier.attach(f.space)
    await sleep(60)
    await writeFile(file, contents)
    f.stores.events.read = read
    await sleep(150)
    expect(f.m3Calls()).toHaveLength(0)
  })

  it('detach 丢弃尚在合并窗口的缺陷唤醒，重新 attach 也不重放', async () => {
    const f = await fixture({ mergeWindowMs: 200 })
    await f.notifier.attach(f.space)
    await f.candidate()
    await sleep(30)
    await f.notifier.detach(f.space)
    await sleep(230)
    expect(f.m3Calls()).toHaveLength(0)
    await f.notifier.attach(f.space)
    await sleep(230)
    expect(f.m3Calls()).toHaveLength(0)
  })
})
