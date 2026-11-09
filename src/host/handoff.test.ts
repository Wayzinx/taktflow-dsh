import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, HostContext, ToolExecutionContext, UserQuestionsRequest } from './dsh-types.js'
import { HANDOFF_TOOL_NAME, createHandoffTool, hideHandoff, markHandoffRegistered } from './handoff.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const agent = (id: string, cwd: string, preset = 'standard'): Agent => ({ id, options: {}, session: { header: { id, cwd, agentPreset: preset } }, followup: () => undefined, inject: () => undefined })
const exec = (caller: Agent | undefined): ToolExecutionContext => ({
  callId: 'c1', rootCallId: 'c1', name: HANDOFF_TOOL_NAME, arguments: {}, agent: caller,
  signal: new AbortController().signal, token: Symbol('t'), deferContext: () => undefined, concludeTurn: () => undefined,
} as ToolExecutionContext)

async function setup(choice: string | undefined, roots?: (main: Agent) => Agent[]) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-handoff-')))
  dirs.push(dir)
  const main = agent('session-main', dir)
  const asked: UserQuestionsRequest[] = []
  const controller = {
    create: vi.fn(async () => ({ sessionId: 'session-taktflow' })),
    prompt: vi.fn(async () => ({ accepted: true })),
    modelCatalog: vi.fn(),
  }
  const questions = { ask: async (request: UserQuestionsRequest) => { asked.push(request); return { answers: choice === undefined ? [] : [{ id: 'taktflow-handoff', selected: [choice] }] } } }
  const ctx = {
    get: (name: string) => (name === 'sessionController' ? controller : name === 'userQuestions' ? questions : undefined),
    agents: { get: (id: string) => (id === main.id ? main : undefined), roots: () => roots?.(main) ?? [main] },
    // 和真实宿主一样：没有 inject 的服务不能按属性读
    get userQuestions(): never { throw new Error('cannot get property "userQuestions" without inject') },
  } as unknown as HostContext
  const tool = createHandoffTool({ ctx })
  const run = (args: Record<string, unknown>, caller: Agent | undefined = main) => tool.execute(args, exec(caller)) as Promise<{ handedOff: boolean; message: string; sessionId?: string }>
  return { dir, main, controller, asked, run }
}

describe('taktflow_handoff', () => {
  it('用户同意后在空间目录新开 taktflow 会话，带上需求原话、转交说明和仓库地址', async () => {
    const s = await setup('交给 Taktflow')
    const result = await s.run({ request: '给工作室页加批量导出 CSV，验收：选中 3 条导出 3 行', repo: 'git@code.example.com:team/portal.git' })
    expect(result).toMatchObject({ handedOff: true, sessionId: 'session-taktflow' })
    expect(s.asked[0]!.agent).toBe(s.main)
    expect(s.asked[0]!.questions[0]!.detail).toContain('git@code.example.com:team/portal.git')
    expect(s.controller.create).toHaveBeenCalledWith({ cwd: s.dir, agentPreset: 'taktflow' })
    const text = (s.controller.prompt.mock.calls as unknown as Array<[{ content: Array<{ text: string }> }]>)[0]![0].content[0]!.text
    expect(text.startsWith('给工作室页加批量导出 CSV')).toBe(true)
    expect(text).toContain('由标准会话转交，用户已同意用 Taktflow 交付')
    expect(text).toContain('代码仓库：git@code.example.com:team/portal.git')
    expect(result.message).toContain('不要在本会话继续实现')
  })

  it('用户不同意、取消或没选时不开会话，并告诉模型别再调用', async () => {
    for (const choice of ['不用，在这里继续', undefined]) {
      const s = await setup(choice)
      const result = await s.run({ request: '做个功能' })
      expect(result.handedOff).toBe(false)
      expect(result.message).toContain('不要再次调用')
      expect(s.controller.create).not.toHaveBeenCalled()
    }
  })

  it('子 Agent、Lead 会话、空需求、不存在的目录都拒绝，且不弹卡片', async () => {
    const s = await setup('交给 Taktflow')
    const child = agent('session-child', s.dir)
    expect((await s.run({ request: '做个功能' }, child)).handedOff).toBe(false)
    const lead = await setup('交给 Taktflow', (main) => [main])
    const leadAgent = agent('session-main', lead.dir, 'taktflow')
    expect((await lead.run({ request: '做个功能' }, leadAgent)).handedOff).toBe(false)
    expect((await s.run({ request: '   ' })).handedOff).toBe(false)
    expect((await s.run({ request: '做个功能', space: '/definitely/not/here' })).handedOff).toBe(false)
    expect(s.asked).toHaveLength(0)
    expect(s.controller.create).not.toHaveBeenCalled()
  })
})

describe('hideHandoff', () => {
  afterEach(() => markHandoffRegistered(false))

  it('工具已注册时立即在 Agent 作用域里屏蔽；宿主不支持 restrict 时什么都不做', () => {
    markHandoffRegistered(true)
    const undo = vi.fn()
    const restrict = vi.fn(() => undo)
    const dispose = hideHandoff({ tools: { register: vi.fn(), guard: vi.fn(), restrict } } as unknown as HostContext)
    expect(restrict).toHaveBeenCalledWith({ deny: [HANDOFF_TOOL_NAME] })
    dispose()
    expect(undo).toHaveBeenCalled()
    expect(() => hideHandoff({ tools: { register: vi.fn(), guard: vi.fn() } } as unknown as HostContext)()).not.toThrow()
  })

  it('Lead 行先于全局工具加载：先排队，宿主注册后补上屏蔽；卸载后的不再补', () => {
    let known = false
    const restrict = vi.fn(() => { if (!known) throw new Error('names unknown global tool'); return () => undefined })
    const lead = { tools: { register: vi.fn(), guard: vi.fn(), restrict } } as unknown as HostContext
    hideHandoff(lead)
    const goneRestrict = vi.fn(() => () => undefined)
    const gone = hideHandoff({ tools: { register: vi.fn(), guard: vi.fn(), restrict: goneRestrict } } as unknown as HostContext)
    gone()
    known = true
    markHandoffRegistered(true)
    expect(restrict).toHaveBeenCalledTimes(1)
    expect(goneRestrict).not.toHaveBeenCalled()
  })
})
