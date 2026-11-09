import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it } from 'vitest'
import { createInsights, initProject } from '@taktflow/core'
import type { Agent, DefineTool, HostContext, ToolDefinition, ToolExecutionContext } from '../dsh-types.js'
import type { SpaceHandle, TaktflowService } from '../types.js'
import { registerLeadTools, type LeadToolResult } from './tools.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const defineToolStub: DefineTool = (options) => options as unknown as ToolDefinition

function makeAgent(id: string, cwd: string, preset = 'taktflow'): Agent {
  return { id, options: { model: 'test-model' }, session: { header: { id, cwd, agentPreset: preset } }, followup: () => undefined, inject: () => undefined }
}

function execFor(agent: Agent): ToolExecutionContext {
  return {
    callId: 'call-1', rootCallId: 'call-1', name: 'takt_config', arguments: {}, agent,
    signal: new AbortController().signal, token: Symbol('test'), deferContext: () => undefined, concludeTurn: () => undefined,
  }
}

async function harness() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-config-')))
  roots.push(root)
  const stores = await initProject(root, { name: 'config-test' })
  const space: SpaceHandle = { root, stores, insights: createInsights(stores) }
  const leases: string[] = []
  const lead = makeAgent('session-lead', root)
  const agents: HostContext['agents'] = { get: (id) => (id === lead.id ? lead : undefined), roots: () => [lead] }
  const service = {
    spaces: { open: async () => space, forSession: async () => space, roots: async () => [root] },
    ownership: { ensureLease: async (s: SpaceHandle) => { leases.push(s.root) } },
    bindings: { byRequirement: async () => undefined, bySession: async () => undefined, bind: async () => undefined },
  } as unknown as TaktflowService
  const tool = registerLeadTools(defineToolStub, service, { ctx: { agents }, user: 'wayne' }).find((t) => t.name === 'takt_config')!
  const call = (args: Record<string, unknown>, agent = lead) => tool.execute(args, execFor(agent)) as Promise<LeadToolResult>
  return { root, space, call, leases, lead }
}

describe('takt_config', () => {
  it('show 输出通过宿主 lossless JSON 契约，嵌套可选字段都有 JSON 缺省', async () => {
    const h = await harness()
    const before = await h.call({ action: 'show' })
    expect(before.ok).toBe(true)
    expect(isJsonValue(before)).toBe(true)
    // 旧布局先给出问题清单；没有 legacy 时用显式 null，而不是 undefined。
    expect(Array.isArray(before.legacy)).toBe(true)

    await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '准备' })
    const after = await h.call({ action: 'show' })
    expect(after.ok).toBe(true)
    expect(isJsonValue(after)).toBe(true)
    const roles = after.roles as Array<Record<string, unknown>>
    expect(roles.length).toBeGreaterThan(0)
    for (const role of roles) {
      // 这些字段来自 AgentProfile 的可选部分；undefined 会让 dsh 拒绝整个工具结果。
      expect(Object.prototype.hasOwnProperty.call(role, 'readScope')).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(role, 'model')).toBe(true)
      expect(role.readScope === null || Array.isArray(role.readScope)).toBe(true)
      expect(role.model === null || typeof role.model === 'string').toBe(true)
      expect(Object.values(role).every((value) => value !== undefined)).toBe(true)
    }
    // 升级后不再有旧布局问题；显式 null 而不是 undefined。
    expect(after.legacy).toBeNull()
  })

  it('旧布局先预览升级，确认后执行；show 能看到流程与角色', async () => {
    const h = await harness()
    const before = await h.call({ action: 'show' })
    expect(before.ok).toBe(true)
    expect(before.legacy).toBeDefined()

    const preview = await h.call({ action: 'upgrade', reason: '用户：帮我升级空间' })
    expect(preview.ok).toBe(true)
    expect((preview.plan as { applied: boolean }).applied).toBe(false)

    const refused = await h.call({ action: 'upgrade', dryRun: false, reason: '用户：升级' })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe('TAKT_FORBIDDEN_FOR_LEAD')

    const applied = await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '用户：确认升级' })
    expect(applied.ok).toBe(true)
    const after = await h.call({ action: 'show' })
    expect((after.workflows as Array<{ id: string; default: boolean }>).find((w) => w.default)?.id).toBe('taktflow-standard')
    expect((after.roles as Array<{ role: string }>).some((r) => r.role === 'pm')).toBe(true)
    expect(h.leases.length).toBeGreaterThan(0)
  })

  it('改运行策略与新建角色：写入审计记 Lead 代表的人，结果给出撤回方式', async () => {
    const h = await harness()
    await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '准备' })
    const set = await h.call({ action: 'set_config', patch: { autonomy: 'checkpoints' }, reason: '用户：评审签字我自己来' })
    expect(set.ok).toBe(true)
    expect(set.next_actions.some((a) => a.includes('rollback'))).toBe(true)
    expect(JSON.parse(await readFile(path.join(h.root, 'takt.config.json'), 'utf8')).autonomy).toBe('checkpoints')

    const created = await h.call({ action: 'save_role', role: 'security', create: true, copyFrom: 'reviewer', profile: { title: '安全评审' }, reason: '用户：加一个安全评审' })
    expect(created.ok).toBe(true)
    expect(await readFile(path.join(h.root, 'agents/security.md'), 'utf8')).toContain('安全评审')

    const history = await h.call({ action: 'history', kind: 'config' })
    const latest = (history.revisions as Array<{ summary: string }>)[0]
    expect(latest?.summary).toBe('修改运行策略')
    const audit = await readFile(path.join(h.root, '.takt/space-events.jsonl'), 'utf8')
    expect(audit).toContain('"onBehalfOf":"wayne"')
  })

  it('删除要先征得同意；被流程使用的角色删除给出原因', async () => {
    const h = await harness()
    await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '准备' })
    const unconfirmed = await h.call({ action: 'delete_role', role: 'pm', reason: '用户：删掉 pm' })
    expect(unconfirmed.error?.code).toBe('TAKT_FORBIDDEN_FOR_LEAD')
    const inUse = await h.call({ action: 'delete_role', role: 'pm', confirmed: true, reason: '用户：删掉 pm' })
    expect(inUse.ok).toBe(false)
    expect(inUse.error?.message).toContain('正被流程使用')
  })

  it('非 taktflow 会话不能改配置；未知动作明确失败', async () => {
    const h = await harness()
    const standard = makeAgent('session-lead', h.root, 'standard')
    const denied = await h.call({ action: 'show' }, standard)
    expect(denied.ok).toBe(false)
    const unknown = await h.call({ action: 'nuke' })
    expect(unknown.error?.code).toBe('TAKT_INVALID_INPUT')
  })
})
