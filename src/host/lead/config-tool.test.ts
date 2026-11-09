import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it } from 'vitest'
import { createInsights, initProject } from '@taktflow/core'
import type { Agent, DefineTool, HostContext, ToolDefinition, ToolExecutionContext } from '../dsh-types.js'
import type { SpaceHandle, TaktflowService } from '../types.js'
import { registerLeadTools, type LeadToolResult } from './tools.js'
import { checkRoleScopes, droppedGates } from './config-tool.js'

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

  it('repo_add 绑定本机仓库并立即同步，show 能看到；url 和 path 必须二选一；show 仍是合法 JSON', async () => {
    const h = await harness()
    const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-repo-')))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't')
    await writeFile(path.join(repo, 'README.md'), 'portal\n'); git('add', '.'); git('commit', '-q', '-m', 'init')
    try {
      await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '准备' })
      const both = await h.call({ action: 'repo_add', url: 'git@example.com:a/b.git', path: repo, reason: '用户：绑定仓库' })
      expect(both.ok).toBe(false)
      const added = await h.call({ action: 'repo_add', path: repo, reason: '用户：在这个仓库上开发' })
      expect(added.ok).toBe(true)
      expect(added).toMatchObject({ id: 'app', synced: true, topLevel: ['README.md'] })
      // 模板 dev 写 src/** + package.json：这个仓库里一条都匹配不上，绑定时就告诉 Lead
      expect(added.scopeWarnings).toContainEqual({ role: 'dev', patterns: ['src/**', 'package.json'] })
      expect((added.next_actions as string[])[0]).toContain('先修写范围')
      expect(isJsonValue(added)).toBe(true)
      const shown = await h.call({ action: 'show' })
      expect(isJsonValue(shown)).toBe(true)
      expect(shown.repos).toEqual([expect.objectContaining({ id: 'app', path: repo, defaultBranch: 'main', status: 'ready' })])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('去掉质量关口要当场确认', () => {
  it('droppedGates 按评审、门禁、acceptance 计数；保留或新增不算', () => {
    const before = "nodes: [review({ id: 'a' }), review({ id: 'b' }), gate({ id: 'g', checks: [{ id: 'acceptance', kind: 'acceptance' }] }), human({ id: 'h' })]"
    expect(droppedGates(before, before)).toEqual([])
    expect(droppedGates(before, "nodes: [human({ id: 'h' })]")).toEqual(['2 个评审节点', '1 个门禁 / 交付校验节点', '1 个 acceptance 交付校验'])
    expect(droppedGates(before, before.replace("{ id: 'acceptance', kind: 'acceptance' }", "{ id: 't', kind: 'function', fn: run }"))).toEqual(['1 个 acceptance 交付校验'])
    expect(droppedGates("nodes: []", before)).toEqual([])
  })

  it('workflow_edit 去掉评审 / 交付校验时没有 confirmed 就拒绝且不改文件；确认后放行到源码校验', async () => {
    const h = await harness()
    await h.call({ action: 'upgrade', dryRun: false, confirmed: true, reason: '准备' })
    const file = path.join(h.root, 'workflows', 'taktflow-standard.workflow.ts')
    const original = await readFile(file, 'utf8')
    expect(original).toMatch(/\breview\(\{/)
    // 只留一个人工准出：评审和交付校验都没了（真实事故里的 studio-signoff）
    const stripped = original.replace(/nodes: \[[\s\S]*\],\s*\}\)\s*$/, "nodes: [human({ id: 'acceptance', title: '准出', ask: '准出？', form: 'approve' })],\n})\n")
    expect(stripped).not.toBe(original)
    const refused = await h.call({ action: 'workflow_edit', id: 'taktflow-standard', baseRev: 'x', source: stripped, reason: '用户：可以，按这个开工' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'TAKT_FORBIDDEN_FOR_LEAD', message: expect.stringContaining('评审节点') } })
    expect(await readFile(file, 'utf8')).toBe(original)
    // 带 confirmed 后不再被这道关拦（之后由源码校验 / baseRev 决定）
    const confirmed = await h.call({ action: 'workflow_edit', id: 'taktflow-standard', baseRev: 'x', source: stripped, confirmed: true, reason: '用户刚确认去掉评审' })
    expect(confirmed.error?.code).not.toBe('TAKT_FORBIDDEN_FOR_LEAD')
  })
})

describe('checkRoleScopes', () => {
  it('按默认分支顶层对照代码写范围：bare 副本也能读；有一条能匹配就不报；产物范围和只读角色不查', async () => {
    const work = await realpath(await mkdtemp(path.join(tmpdir(), 'taktflow-scope-')))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    try {
      const src = path.join(work, 'src-repo')
      execFileSync('mkdir', ['-p', path.join(src, 'case_portal')])
      git(src, 'init', '-q', '-b', 'main'); git(src, 'config', 'user.email', 't@example.com'); git(src, 'config', 'user.name', 't')
      await writeFile(path.join(src, 'case_portal', 'app.py'), 'x = 1\n'); await writeFile(path.join(src, 'pyproject.toml'), '[project]\n')
      git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'init')
      git(work, 'clone', '-q', '--bare', src, 'bare')
      const roles = [
        { role: 'dev', writeScope: ['src/**', 'package.json', 'requirements/**/tasks/**'] },
        { role: 'dev2', writeScope: ['src/**', 'case_portal/**'] },
        { role: 'pm', writeScope: ['.takt/workspaces/**', 'requirements/**'] },
        { role: 'any', writeScope: ['**/*.py'] },
        { role: 'ro', writeScope: ['src/**'], readOnly: true },
      ]
      const result = await checkRoleScopes(path.join(work, 'bare'), 'main', roles)
      expect(result.warnings).toEqual([{ role: 'dev', patterns: ['src/**', 'package.json'] }])
      expect(result.topLevel).toEqual(['case_portal/', 'pyproject.toml'])
      // 分支名不对时退到 HEAD；目录不是仓库时不报
      expect((await checkRoleScopes(path.join(work, 'bare'), 'nope', roles)).warnings).toHaveLength(1)
      expect(await checkRoleScopes(work, 'main', roles)).toEqual({ warnings: [], topLevel: [] })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
