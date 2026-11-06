import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInsights, initProject } from '@taktflow/core'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTraceHub, agentTraceFile, agentTraceSessionFile, type AgentTraceStart } from './agent-trace.js'
import type { AgentTrace, SpaceHandle } from './types.js'

const dirs: string[] = []
const hubs: AgentTraceHub[] = []

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.disposeAll().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeSpace(options: { providers?: Record<string, unknown> } = {}): Promise<SpaceHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'takt-trace-'))
  dirs.push(dir)
  const stores = await initProject(dir, { name: 'trace' })
  if (options.providers !== undefined) {
    stores.config.providers = options.providers as NonNullable<typeof stores.config.providers>
  }
  return { root: dir, stores, insights: createInsights(stores) }
}

function start(overrides: Partial<AgentTraceStart> = {}): AgentTraceStart {
  return {
    runId: 'run-1',
    nodeId: 'design',
    attempt: 1,
    label: 'REQ-1/design#1',
    role: 'architect',
    sessionId: 'child-1',
    preset: { id: 'takt-preset', cfgHash: 'abc12345', plugins: ['persona', 'tool-fs'] },
    profile: {
      title: '架构师', description: '负责设计', skills: ['design'], writeScope: ['design/**'], readOnly: false, source: 'space',
    },
    prompt: '输出设计',
    ...overrides,
  }
}

function hub(options: ConstructorParameters<typeof AgentTraceHub>[0] = {}): AgentTraceHub {
  const instance = new AgentTraceHub({ throttleMs: 50, log: () => {}, ...options })
  hubs.push(instance)
  return instance
}

async function readRecord(space: SpaceHandle, runId: string, nodeId: string, attempt: number): Promise<AgentTrace> {
  return JSON.parse(await readFile(agentTraceFile(space, runId, nodeId, attempt), 'utf8')) as AgentTrace
}

describe('AgentTraceHub：生命周期', () => {
  it('begin 立即落盘 starting，发布后 running，结束时补全终态', async () => {
    const space = await makeSpace()
    const traces = hub()
    const handle = await traces.begin(space, start())
    const initial = await readRecord(space, 'run-1', 'design', 1)
    expect(initial.status).toBe('starting')
    expect(initial.prompt).toBe('输出设计')
    expect(initial.preset).toEqual({ id: 'takt-preset', cfgHash: 'abc12345', plugins: ['persona', 'tool-fs'] })
    expect(initial.profile.source).toBe('space')

    handle.running('model-a', 'high')
    // 运行中读取合并内存最新状态，不依赖节流写盘。
    expect((await traces.read(space, 'run-1'))[0]).toMatchObject({ status: 'running', model: 'model-a', effort: 'high' })
    expect((await readRecord(space, 'run-1', 'design', 1)).status).toBe('starting')

    await handle.finish({ status: 'completed', stopReason: 'completed', finalText: '设计完成' })
    await handle.dispose()
    const final = await readRecord(space, 'run-1', 'design', 1)
    expect(final).toMatchObject({ status: 'completed', stopReason: 'completed', finalText: '设计完成' })
    expect(final.endedAt).toBeTypeOf('string')
    expect(final.durationMs).toBeGreaterThanOrEqual(0)
    expect(await traces.read(space, 'run-1')).toEqual([final])
  })

  it('实际注册技能与档案声明技能落盘并可读回', async () => {
    const space = await makeSpace()
    const traces = hub()
    const handle = await traces.begin(space, start({
      preset: { id: 'takt-preset', cfgHash: 'abc12345', plugins: ['persona'], skills: ['design', 'review'] },
      profile: {
        title: '架构师', description: '负责设计', skills: ['design', 'review'], declaredSkills: ['design', 'review', 'missing'],
        writeScope: [], readOnly: false, source: 'space',
      },
    }))
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.preset.skills).toEqual(['design', 'review'])
    expect(record.profile.declaredSkills).toEqual(['design', 'review', 'missing'])
    expect((await traces.read(space, 'run-1'))[0]).toMatchObject({
      preset: { skills: ['design', 'review'] },
      profile: { declaredSkills: ['design', 'review', 'missing'] },
    })
  })

  it('legacy 文件记录同一 session 后拒绝重复 begin', async () => {
    const space = await makeSpace()
    const traces = hub()
    const first = await traces.begin(space, start())
    await first.dispose()
    // 第一次写 legacy node#attempt.json；同 session 第二次 begin 不能因为
    // session 文件尚不存在就绕过去重。
    await expect(traces.begin(space, start())).rejects.toThrow('子会话已有追溯记录')
  })

  it('失败与取消不会写成成功，清理错误保留在 error 里', async () => {
    const space = await makeSpace()
    const traces = hub()
    const failed = await traces.begin(space, start({ nodeId: 'dev', sessionId: 'child-dev' }))
    await failed.finish({ status: 'failed', stopReason: 'error', error: '模型错误' })
    await failed.dispose()

    const cancelled = await traces.begin(space, start({ nodeId: 'qa', sessionId: 'child-qa' }))
    await cancelled.finish({ status: 'cancelled', stopReason: 'aborted' })
    await cancelled.dispose()

    expect(await readRecord(space, 'run-1', 'dev', 1)).toMatchObject({ status: 'failed', error: '模型错误' })
    expect(await readRecord(space, 'run-1', 'qa', 1)).toMatchObject({ status: 'cancelled', stopReason: 'aborted' })
  })

  it('重复 begin 同一节点或同一会话时拒绝', async () => {
    const space = await makeSpace()
    const traces = hub()
    const first = await traces.begin(space, start())
    await expect(traces.begin(space, start({ nodeId: 'other' }))).rejects.toThrow('子会话已有追溯记录')
    await expect(traces.begin(space, start({ sessionId: 'child-2' }))).rejects.toThrow('节点尝试已有追溯记录')
    await first.dispose()
  })

  it('并发 begin 同一节点或同一会话时只有一个成功，占位在 await 之前互斥', async () => {
    const space = await makeSpace()
    const traces = hub()
    const sameKey = await Promise.allSettled([traces.begin(space, start()), traces.begin(space, start())])
    expect(sameKey.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const winner = sameKey.find((result) => result.status === 'fulfilled')
    if (winner?.status === 'fulfilled') await winner.value.dispose()

    const sameSession = await Promise.allSettled([
      traces.begin(space, start({ nodeId: 'dev', sessionId: 'child-shared' })),
      traces.begin(space, start({ nodeId: 'qa', sessionId: 'child-shared' })),
    ])
    expect(sameSession.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const sessionWinner = sameSession.find((result) => result.status === 'fulfilled')
    if (sessionWinner?.status === 'fulfilled') await sessionWinner.value.dispose()
  })

  it('dispose 幂等，disposeAll 冲刷所有挂起写入', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    handle.denial({ tool: 'write', path: 'other/outside.txt', reason: '不在写入范围内' })
    // 节流窗口内磁盘仍是 starting，disposeAll 必须把内存里的拒绝记录冲刷出去。
    expect((await readRecord(space, 'run-1', 'design', 1)).denials).toEqual([])
    await traces.disposeAll()
    expect((await readRecord(space, 'run-1', 'design', 1)).denials).toHaveLength(1)
    await handle.dispose()
    await handle.dispose()
  })

  it('终态写盘失败先降级为 failed；磁盘恢复后可用 failed 终态重试，不会留下 completed 假成功', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    const agents = join(space.stores.taktDir, 'runs', 'run-1', 'agents')
    await chmod(agents, 0o500)
    await expect(handle.finish({ status: 'completed', stopReason: 'completed', finalText: '完成' })).rejects.toThrow()
    // 写盘失败后内存状态立即降级；运行中路由不会短暂返回 completed。
    expect((await traces.read(space, 'run-1'))[0]).toMatchObject({ status: 'failed', finalText: '完成' })
    await chmod(agents, 0o700)
    await handle.finish({ status: 'failed', stopReason: 'completed', finalText: '完成', error: '追溯记录写入失败：测试注入' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.status).toBe('failed')
    expect(record.error).toContain('追溯记录写入失败')
    expect(record.finalText).toBe('完成')
  })
})

describe('AgentTraceHub：会话事件', () => {
  it('汇总工具调用、结果、token 和真实 model/effort', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    handle.running('发布时模型', '发布时档位')
    handle.sessionEvent({
      type: 'tool/call', seq: 1, time: 1_000,
      data: { callId: 'call-1', name: 'read', arguments: '{"file_path":"docs/requirement.md"}', turn: 1, step: 1 },
    })
    handle.sessionEvent({
      type: 'tool/result', seq: 2, time: 1_010,
      data: { message: { toolCallId: 'call-1', isError: false } },
    })
    handle.sessionEvent({
      type: 'tool/call', seq: 3, time: 1_020,
      data: { callId: 'call-2', name: 'write', arguments: { file_path: 'other/outside.txt' } },
    })
    handle.sessionEvent({
      type: 'tool/result', seq: 4, time: 1_030,
      data: { message: { toolCallId: 'call-2', isError: true } },
    })
    handle.sessionEvent({
      type: 'assistant/message', seq: 5, time: 1_040,
      data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } },
    })
    handle.sessionEvent({
      type: 'assistant/message', seq: 6, time: 1_050,
      data: { usage: { inputTokens: 50, outputTokens: 10 } },
    })
    handle.sessionEvent({
      type: 'request/header', seq: 7, time: 1_060,
      data: { header: { config: { provider: 'local', model: '真实模型', reasoningEffort: 'high' } } },
    })
    // 未知事件和无关键字段的事件都不能制造半条工具记录。
    handle.sessionEvent({ type: 'turn/start', seq: 8, time: 1_070, data: { turn: 2 } })
    handle.sessionEvent({ type: 'tool/call', seq: 9, time: 1_080, data: { name: 'read' } })

    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.model).toBe('真实模型')
    expect(record.effort).toBe('high')
    expect(record.tools).toEqual([
      { name: 'read', summary: 'docs/requirement.md', ok: true, at: new Date(1_000).toISOString(), durationMs: 10 },
      { name: 'write', summary: 'other/outside.txt', ok: false, at: new Date(1_020).toISOString(), durationMs: 10 },
    ])
    expect(record.usage).toEqual({ inputTokens: 150, outputTokens: 30, cacheReadTokens: 30 })
  })

  it('重复投递同一 seq 的事件不会重复累计工具或 token', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    const call = {
      type: 'tool/call' as const, seq: 1, time: 1_000,
      data: { callId: 'call-1', name: 'read', arguments: { file_path: 'a.md' } },
    }
    const usage = { type: 'assistant/message' as const, seq: 2, time: 1_010, data: { usage: { inputTokens: 10, outputTokens: 2 } } }
    handle.sessionEvent(call)
    handle.sessionEvent(call)
    handle.sessionEvent(usage)
    handle.sessionEvent(usage)
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.tools).toHaveLength(1)
    expect(record.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  })

  it('header 缺失 effort 时清除发布默认值，迟到的 running 和后续 header 都不能保留旧值', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    handle.running('发布模型', 'high')
    handle.sessionEvent({
      type: 'request/header', seq: 1, time: 1_000, data: { header: { config: { provider: 'local', model: 'header-model' } } },
    })
    // 发布调用可能晚于 header；它只补缺失值，不能把已清除的 effort 填回去。
    handle.running('发布模型', 'high')
    handle.sessionEvent({
      type: 'request/header', seq: 2, time: 1_010,
      data: { header: { config: { provider: 'local', model: 'header-model', reasoningEffort: 'low' } } },
    })
    // 第二次实际请求又没带 effort 时，第一次的 low 也不能残留。
    handle.sessionEvent({
      type: 'request/header', seq: 3, time: 1_020, data: { header: { config: { provider: 'local', model: 'header-model' } } },
    })
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.model).toBe('header-model')
    expect(record.effort).toBeUndefined()
  })

  it('request/context 只修正 options 来源；header 与 context 冲突时以 header 为准', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    handle.running('发布模型', 'high')
    handle.sessionEvent({ type: 'request/context', seq: 1, time: 1_000, data: { model: 'context-model' } })
    expect((await traces.read(space, 'run-1'))[0]).toMatchObject({ model: 'context-model', effort: 'high' })
    handle.sessionEvent({
      type: 'request/header', seq: 2, time: 1_010,
      data: { header: { config: { provider: 'local', model: 'header-model', reasoningEffort: 'high' } } },
    })
    // 同一份 resolved config 的 context 可能晚到；不能覆盖 header 的实际请求模型。
    handle.sessionEvent({ type: 'request/context', seq: 3, time: 1_020, data: { model: 'context-model-2' } })
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    expect((await readRecord(space, 'run-1', 'design', 1)).model).toBe('header-model')
  })

  it('工具只保留最近 200 条，未返回结果的调用保留 ok 为空', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    for (let index = 0; index < 205; index++) {
      handle.sessionEvent({
        type: 'tool/call', seq: index, time: 1_000 + index,
        data: { callId: `call-${index}`, name: 'read', arguments: { file_path: `docs/${index}.md` } },
      })
    }
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.tools).toHaveLength(200)
    expect(record.tools[0]!.summary).toBe('docs/5.md')
    expect(record.tools.at(-1)!.summary).toBe('docs/204.md')
    expect(record.tools[0]!.ok).toBeUndefined()
  })

  it('没有 usage/header 时 model、effort、usage 留空，不杜撰', async () => {
    const space = await makeSpace()
    const traces = hub()
    const handle = await traces.begin(space, start())
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.model).toBeUndefined()
    expect(record.effort).toBeUndefined()
    expect(record.usage).toBeUndefined()
  })
})

describe('AgentTraceHub：脱敏、截断与拒绝记录', () => {
  it('prompt/finalText/工具摘要/拒绝原因先脱敏再按字节截断', async () => {
    const space = await makeSpace({
      providers: { local: { protocol: 'openai-chat', headers: { authorization: 'Bearer test-secret-value' } } },
    })
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start({
      prompt: `token=test-secret-value ${'长'.repeat(40_000)}`,
    }))
    handle.sessionEvent({
      type: 'tool/call', seq: 1, time: 1_000,
      data: { callId: 'call-1', name: 'read', arguments: { file_path: `test-secret-value/${'a'.repeat(300)}` } },
    })
    handle.denial({ tool: 'write', path: 'test-secret-value/outside.txt', reason: `test-secret-value ${'原因'.repeat(2_000)}` })
    await handle.finish({ status: 'completed', stopReason: 'completed', finalText: `test-secret-value ${'尾'.repeat(5_000)}` })
    await handle.dispose()

    const raw = await readFile(agentTraceFile(space, 'run-1', 'design', 1), 'utf8')
    expect(raw).not.toContain('test-secret-value')
    const record = JSON.parse(raw) as AgentTrace
    expect(record.prompt.endsWith('[truncated]')).toBe(true)
    expect(Buffer.byteLength(record.prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(record.finalText!.endsWith('[truncated]')).toBe(true)
    expect(Buffer.byteLength(record.finalText!, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect([...record.tools[0]!.summary].length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(record.denials[0]!.reason, 'utf8')).toBeLessThanOrEqual(2 * 1024)
    expect(record.denials[0]!.path).not.toContain('test-secret-value')
  })

  it('每次 begin 独立冻结密钥集合：请求里的密钥和后续 provider 变更都不漏脱敏', async () => {
    const space = await makeSpace({
      providers: { local: { protocol: 'openai-chat', headers: { authorization: 'Bearer first-provider-secret' } } },
    })
    const traces = hub({ throttleMs: 5_000 })
    const first = await traces.begin(space, start({ prompt: 'first-provider-secret req-only-secret', secrets: ['req-only-secret'] }))
    await first.finish({ status: 'completed', stopReason: 'completed', finalText: 'req-only-secret' })
    await first.dispose()
    const firstRaw = await readFile(agentTraceFile(space, 'run-1', 'design', 1), 'utf8')
    expect(firstRaw).not.toContain('first-provider-secret')
    expect(firstRaw).not.toContain('req-only-secret')

    // 同一空间换 provider 后，新记录必须用新密钥集合，而不是沿用第一次创建的脱敏器。
    space.stores.config.providers = {
      remote: { protocol: 'openai-chat', headers: { authorization: 'Bearer second-provider-secret' } },
    } as NonNullable<typeof space.stores.config.providers>
    const second = await traces.begin(space, start({ nodeId: 'dev', sessionId: 'child-2', prompt: 'second-provider-secret' }))
    await second.finish({ status: 'completed', stopReason: 'completed', finalText: 'second-provider-secret' })
    await second.dispose()
    const secondRaw = await readFile(agentTraceFile(space, 'run-1', 'dev', 1), 'utf8')
    expect(secondRaw).not.toContain('second-provider-secret')
  })

  it('recordDenial 同步登记，未知空间或未知节点静默忽略', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    traces.recordDenial(space.root, { runId: 'run-1', nodeId: 'design', attempt: 1 }, {
      tool: 'write', path: 'other/outside.txt', reason: '不在写入范围内',
    })
    traces.recordDenial(space.root, { runId: 'run-1', nodeId: 'design', attempt: 2 }, { tool: 'write', reason: '不存在' })
    traces.recordDenial('/not-registered', { runId: 'run-1', nodeId: 'design', attempt: 1 }, { tool: 'write', reason: '不存在' })
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const record = await readRecord(space, 'run-1', 'design', 1)
    expect(record.denials).toHaveLength(1)
    expect(record.denials[0]).toMatchObject({ tool: 'write', path: 'other/outside.txt', reason: '不在写入范围内' })
  })
})

describe('AgentTraceHub：读取与路径安全', () => {
  it('nodeId 含 / 时写入子目录，读取按开始时间和节点排序', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const beta = await traces.begin(space, start({ nodeId: 'design', attempt: 1, sessionId: 'child-1' }))
    const alpha = await traces.begin(space, start({ nodeId: 'design/api', attempt: 2, sessionId: 'child-2' }))
    await beta.finish({ status: 'completed', stopReason: 'completed' })
    await alpha.finish({ status: 'completed', stopReason: 'completed' })
    await beta.dispose()
    await alpha.dispose()

    expect(agentTraceFile(space, 'run-1', 'design/api', 2)).toContain(`${join('design', 'api')}#2.json`)
    const all = await traces.read(space, 'run-1')
    expect(all.map((trace) => `${trace.nodeId}#${trace.attempt}`)).toEqual(['design#1', 'design/api#2'])
    expect(await traces.read(space, 'run-1', 'design/api')).toHaveLength(1)
    expect(await traces.read(space, 'run-1', 'design')).toHaveLength(1)
  })

  it('损坏 JSON、文件名与内容不一致、符号链接文件都不会进入结果', async () => {
    const space = await makeSpace()
    const traces = hub()
    const handle = await traces.begin(space, start())
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const agents = join(space.stores.taktDir, 'runs', 'run-1', 'agents')

    await writeFile(join(agents, 'bad.json'), '{not-json', 'utf8')
    const valid = await readFile(agentTraceFile(space, 'run-1', 'design', 1), 'utf8')
    await writeFile(join(agents, 'other.json'), valid, 'utf8')
    const outside = join(space.root, 'outside.json')
    await writeFile(outside, valid, 'utf8')
    await symlink(outside, join(agents, 'link.json'))

    expect(await traces.read(space, 'run-1')).toHaveLength(1)
  })

  it('落盘记录缺少嵌套必填字段或工具/拒绝元素字段时整条跳过', async () => {
    const space = await makeSpace()
    const traces = hub()
    const handle = await traces.begin(space, start())
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    const agents = join(space.stores.taktDir, 'runs', 'run-1', 'agents')
    const valid = JSON.parse(await readFile(agentTraceFile(space, 'run-1', 'design', 1), 'utf8')) as AgentTrace

    const noDescription = structuredClone(valid) as unknown as { nodeId: string; profile: Record<string, unknown> }
    delete noDescription.profile.description
    noDescription.nodeId = 'no-description'
    await writeFile(join(agents, 'no-description#1.json'), JSON.stringify(noDescription), 'utf8')

    const badTool = structuredClone(valid)
    badTool.nodeId = 'bad-tool'
    badTool.tools = [{ summary: '缺少 name', at: '2026-01-01T00:00:00.000Z' }] as AgentTrace['tools']
    await writeFile(join(agents, 'bad-tool#1.json'), JSON.stringify(badTool), 'utf8')

    const badDenial = structuredClone(valid)
    badDenial.nodeId = 'bad-denial'
    badDenial.denials = [{ tool: 'write', at: '2026-01-01T00:00:00.000Z' }] as AgentTrace['denials']
    await writeFile(join(agents, 'bad-denial#1.json'), JSON.stringify(badDenial), 'utf8')

    const badUsage = structuredClone(valid)
    badUsage.nodeId = 'bad-usage'
    badUsage.usage = { inputTokens: 1 } as AgentTrace['usage']
    await writeFile(join(agents, 'bad-usage#1.json'), JSON.stringify(badUsage), 'utf8')

    expect(await traces.read(space, 'run-1')).toHaveLength(1)
  })

  it('非法 run/node 拒绝读取；agents 目录是符号链接时拒绝写入', async () => {
    const space = await makeSpace()
    const traces = hub()
    await expect(traces.read(space, '../run')).rejects.toThrow()
    await expect(traces.read(space, 'run-1', '..')).rejects.toThrow()

    const runDir = join(space.stores.taktDir, 'runs', 'run-2')
    await mkdir(runDir, { recursive: true })
    const outside = join(space.root, 'outside-agents')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(runDir, 'agents'))
    await expect(traces.begin(space, start({ runId: 'run-2' }))).rejects.toThrow()
    // 读取同样拒绝符号链接目录，而不是静默返回空列表。
    await expect(traces.read(space, 'run-2')).rejects.toThrow('符号链接')
  })

  it('活动记录覆盖同键磁盘快照，dispose 后只返回落盘终态', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    handle.sessionEvent({
      type: 'tool/call', seq: 1, time: 1_000, data: { callId: 'call-1', name: 'read', arguments: { file_path: 'a.md' } },
    })
    expect((await traces.read(space, 'run-1'))[0]!.tools).toHaveLength(1)
    expect((await readRecord(space, 'run-1', 'design', 1)).tools).toEqual([])
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    expect((await traces.read(space, 'run-1'))[0]!.tools).toHaveLength(1)
  })
})

describe('AgentTraceHub：同一节点尝试的多次执行', () => {
  it('review 节点顺序执行多个角色时保留每次记录，首条不被覆盖，usage/denials 不串', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const first = await traces.begin(space, start({ role: 'reviewer-a', sessionId: 'child-a', label: 'REQ-1/review#1' }))
    first.denial({ tool: 'write', path: 'a.txt', reason: '评审只读' })
    first.sessionEvent({
      type: 'assistant/message', seq: 1, time: 1_000, data: { usage: { inputTokens: 10, outputTokens: 2 } },
    })
    await first.finish({ status: 'completed', stopReason: 'completed' })
    await first.dispose()

    const second = await traces.begin(space, start({ role: 'author', sessionId: 'child-b', label: 'REQ-1/review#1' }))
    second.running('model-b')
    second.denial({ tool: 'write', path: 'b.txt', reason: '只改产物' })
    second.sessionEvent({
      type: 'assistant/message', seq: 1, time: 1_000, data: { usage: { inputTokens: 20, outputTokens: 4 } },
    })
    // 运行中的第二次与磁盘上的第一次必须同时可见，不能被 byKey 合并成一条。
    const during = await traces.read(space, 'run-1')
    expect(during.map((trace) => trace.sessionId)).toEqual(['child-a', 'child-b'])
    expect(during[0]).toMatchObject({ status: 'completed', role: 'reviewer-a' })
    expect(during[1]).toMatchObject({ status: 'running', role: 'author', model: 'model-b' })

    await second.finish({ status: 'completed', stopReason: 'completed' })
    await second.dispose()

    const all = await traces.read(space, 'run-1')
    expect(all).toHaveLength(2)
    expect(all.map((trace) => trace.sessionId)).toEqual(['child-a', 'child-b'])
    expect(all[0]).toMatchObject({
      role: 'reviewer-a',
      usage: { inputTokens: 10, outputTokens: 2 },
      denials: [expect.objectContaining({ path: 'a.txt' })],
    })
    expect(all[1]).toMatchObject({
      role: 'author',
      usage: { inputTokens: 20, outputTokens: 4 },
      denials: [expect.objectContaining({ path: 'b.txt' })],
    })
    expect(all[0]!.denials).toHaveLength(1)
    expect(all[1]!.denials).toHaveLength(1)

    // 首次执行保留旧文件名；后续执行写独立 session 文件。
    expect(await readRecord(space, 'run-1', 'design', 1)).toMatchObject({ sessionId: 'child-a' })
    expect(JSON.parse(
      await readFile(agentTraceSessionFile(space, 'run-1', 'design', 1, 'child-b'), 'utf8'),
    )).toMatchObject({ sessionId: 'child-b', role: 'author' })

    // 已落盘的同一 session 文件不能被下一次执行静默覆盖。
    await expect(traces.begin(space, start({ role: 'author', sessionId: 'child-b', label: 'REQ-1/review#1' })))
      .rejects.toThrow('该子会话已有追溯记录')
  })

  it('sessionId 安全编码进文件名，读取只接受与内容一致的旧格式或 session 文件名', async () => {
    const space = await makeSpace()
    const traces = hub({ throttleMs: 5_000 })
    const handle = await traces.begin(space, start())
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()

    const agents = join(space.stores.taktDir, 'runs', 'run-1', 'agents')
    const valid = JSON.parse(await readFile(agentTraceFile(space, 'run-1', 'design', 1), 'utf8')) as AgentTrace

    const encoded = structuredClone(valid)
    encoded.sessionId = 'child/with/slash'
    const sessionFile = agentTraceSessionFile(space, 'run-1', 'design', 1, 'child/with/slash')
    // `/` 必须编码成文件名片段，不能变成目录层级。
    expect(sessionFile).not.toContain(join('agents', 'child'))
    await writeFile(sessionFile, JSON.stringify(encoded), 'utf8')

    const mismatch = structuredClone(valid)
    mismatch.sessionId = 'child-ok'
    await writeFile(join(agents, 'design#1~child-other.json'), JSON.stringify(mismatch), 'utf8')

    expect(await traces.read(space, 'run-1')).toHaveLength(2)
    expect((await traces.read(space, 'run-1')).map((trace) => trace.sessionId)).toEqual(['child-1', 'child/with/slash'])
  })
})
