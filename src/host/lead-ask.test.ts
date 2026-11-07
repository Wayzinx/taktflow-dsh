import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, HostContext } from './dsh-types.js'
import { askLead, dshModelOption, hostModels } from './lead-ask.js'
import type { SpaceHandle } from './types.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function setup(liveAgents: Agent[] = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-ask-')))
  dirs.push(root)
  const controller = {
    create: vi.fn(async () => ({ sessionId: 'session-new' })),
    prompt: vi.fn(async () => ({ accepted: true })),
    modelCatalog: vi.fn(async () => ({ groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] })),
  }
  const ctx = {
    get: (name: string) => (name === 'sessionController' ? controller : undefined),
    agents: { get: () => undefined, roots: () => liveAgents },
  } as unknown as HostContext
  return { root, ctx, controller, space: { root } as SpaceHandle }
}

const agent = (id: string, cwd: string, preset = 'taktflow'): Agent => ({ id, options: {}, session: { header: { id, cwd, agentPreset: preset } }, followup: () => undefined, inject: () => undefined })

describe('lead.ask', () => {
  it('有在线 Lead 会话时投递过去，标注来自哪一页', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-ask-')))
    dirs.push(root)
    const s = await setup([agent('session-other', '/elsewhere'), agent('session-standard', root, 'standard'), agent('session-lead', root)])
    const space = { root } as SpaceHandle
    const result = await askLead(s.ctx, space, { text: ' 把 PRD 评审改成 2 轮 ', page: 'workflows' })
    expect(result).toEqual({ sessionId: 'session-lead', created: false })
    expect(s.controller.create).not.toHaveBeenCalled()
    const request = (s.controller.prompt.mock.calls as unknown as Array<[{ sessionId: string; content: Array<{ text: string }> }]>)[0]![0]
    expect(request.sessionId).toBe('session-lead')
    expect(request.content[0]!.text).toBe('把 PRD 评审改成 2 轮\n\n（来自Taktflow 面板 · Workflow）')
  })

  it('没有在线 Lead 时在空间根新建 taktflow 会话再投递', async () => {
    const s = await setup()
    const result = await askLead(s.ctx, s.space, { text: '加一个安全评审角色', page: 'settings:agents' })
    expect(result).toEqual({ sessionId: 'session-new', created: true })
    expect(s.controller.create).toHaveBeenCalledWith({ cwd: s.root, agentPreset: 'taktflow' })
  })

  it('空文本和超长文本拒绝，不创建会话', async () => {
    const s = await setup()
    await expect(askLead(s.ctx, s.space, { text: '   ' })).rejects.toMatchObject({ status: 400 })
    await expect(askLead(s.ctx, s.space, { text: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 })
    expect(s.controller.create).not.toHaveBeenCalled()
  })

  it('模型：列出 App 模型；只有 App 里存在的“提供方/模型”才传给子 Agent', async () => {
    const s = await setup()
    expect(await hostModels(s.ctx)).toEqual([{ id: 'deepseek/deepseek-flash', label: 'Flash · DeepSeek' }])
    expect(await dshModelOption(s.ctx, 'deepseek/deepseek-flash')).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(await dshModelOption(s.ctx, 'sonnet')).toBeUndefined()
    expect(await dshModelOption(s.ctx, 'openai/gpt-x')).toBeUndefined()
    expect(await dshModelOption(s.ctx, undefined)).toBeUndefined()
  })
})
