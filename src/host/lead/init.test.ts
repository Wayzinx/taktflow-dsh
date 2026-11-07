import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import type {
  Agent,
  DefineTool,
  HostContext,
  ToolDefinition,
  ToolExecutionContext,
} from '../dsh-types.js'
import { loadRunProfiles } from '../run-runtime.js'
import { FsSpaceRegistry } from '../space.js'
import { BUNDLED_ROLE_FILES } from '../../roles/defaults.js'
import type { TaktflowService } from '../types.js'

const ROLE_NAMES = BUNDLED_ROLE_FILES.map((file) => file.fileName.replace(/\.md$/, ''))
import { registerLeadTools, type LeadToolResult } from './tools.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix = 'takt-init-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const defineToolStub: DefineTool = (options) => options as unknown as ToolDefinition

function makeAgent(id: string, cwd: string | undefined, preset = 'taktflow'): Agent {
  return {
    id,
    options: { model: 'test-model' },
    session: { header: { id, cwd: cwd as string, agentPreset: preset } },
    followup: () => undefined,
    inject: () => undefined,
  }
}

function execFor(agent: Agent): ToolExecutionContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'test',
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: Symbol('test'),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  }
}

interface Harness {
  registry: FsSpaceRegistry
  tools: Map<string, ToolDefinition>
  rootAgent: Agent
  call(name: string, args: Record<string, unknown>, agent?: Agent): Promise<LeadToolResult>
}

function makeHarness(options: { cwd: string; spaces?: string[] }): Harness {
  const registry = new FsSpaceRegistry(options.spaces === undefined ? {} : { spaces: options.spaces })
  // init 只依赖 spaces；其余服务在注册阶段不会被调用。
  const service = { spaces: registry } as unknown as TaktflowService
  const rootAgent = makeAgent('session-1', options.cwd)
  const agents: HostContext['agents'] = {
    get: (id: string) => (id === rootAgent.id ? rootAgent : undefined),
    roots: () => [rootAgent],
  }
  const tools = new Map(
    registerLeadTools(defineToolStub, service, { ctx: { agents }, user: 'alice' })
      .map((tool) => [tool.name, tool]),
  )
  return {
    registry,
    tools,
    rootAgent,
    async call(name, args, agent = rootAgent) {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`未注册工具：${name}`)
      return await tool.execute(args, execFor(agent)) as LeadToolResult
    },
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('takt_requirement init', () => {
  it('在会话 cwd 初始化空间并只补缺失的默认角色', async () => {
    const project = await tempDir()
    const h = makeHarness({ cwd: project })
    const result = await h.call('takt_requirement', { action: 'init' })

    expect(result.ok).toBe(true)
    expect(result.alreadyInitialized).toBe(false)
    expect(result.roles).toEqual({
      copied: ROLE_NAMES,
      kept: [],
    })
    expect(await exists(path.join(project, 'takt.config.json'))).toBe(true)
    for (const role of ROLE_NAMES) {
      expect(await exists(path.join(project, 'agents', `${role}.md`))).toBe(true)
    }
    const space = await h.registry.open(project)
    const profiles = await loadRunProfiles(space)
    expect(profiles.dev).toMatchObject({ allowBash: false })
    expect(profiles.dev?.writeScope).toEqual(expect.arrayContaining(['src/**']))
    expect(result.next_actions.some((action) => action.includes('takt_requirement create'))).toBe(true)
  })

  it('已是空间时幂等，且不覆盖用户修改过的角色档案', async () => {
    const project = await tempDir()
    const h = makeHarness({ cwd: project })
    await h.call('takt_requirement', { action: 'init' })
    const analyst = path.join(project, 'agents', 'analyst.md')
    await writeFile(analyst, '用户自定义分析角色\n', 'utf8')

    const again = await h.call('takt_requirement', { action: 'init' })
    expect(again.ok).toBe(true)
    expect(again.alreadyInitialized).toBe(true)
    expect(again.roles).toEqual({
      copied: [],
      kept: ROLE_NAMES,
    })
    expect(await readFile(analyst, 'utf8')).toBe('用户自定义分析角色\n')
  })

  it('cwd 在已配置的空间根里面时，在任何写盘前拒绝', async () => {
    const spaceRoot = await tempDir()
    await initProject(spaceRoot)
    const sub = path.join(spaceRoot, 'sub')
    await mkdir(sub)
    const h = makeHarness({ cwd: sub, spaces: [spaceRoot] })

    const result = await h.call('takt_requirement', { action: 'init' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(result.error?.hint).toContain(spaceRoot)
    expect(await exists(path.join(sub, 'takt.config.json'))).toBe(false)
    expect(await exists(path.join(sub, '.takt'))).toBe(false)
  })

  it('向上发现未注册的既有空间时拒绝，不创建嵌套空间', async () => {
    const spaceRoot = await tempDir()
    await initProject(spaceRoot)
    const sub = path.join(spaceRoot, 'nested')
    await mkdir(sub)
    const h = makeHarness({ cwd: sub })

    const result = await h.call('takt_requirement', { action: 'init' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(result.error?.message).toContain(spaceRoot)
    expect(await exists(path.join(sub, 'takt.config.json'))).toBe(false)
  })

  it('与配置的其它空间根冲突时，在任何写盘前拒绝', async () => {
    const configured = await tempDir()
    await initProject(configured)
    const project = await tempDir()
    const h = makeHarness({ cwd: project, spaces: [configured] })

    const result = await h.call('takt_requirement', { action: 'init' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(await exists(path.join(project, 'takt.config.json'))).toBe(false)
    expect(await exists(path.join(project, '.takt'))).toBe(false)
  })

  it('已打开一个空间后，另一个目录也能 init（多空间）', async () => {
    const first = await tempDir()
    await initProject(first)
    const registry = new FsSpaceRegistry()
    await registry.open(first)
    const second = await tempDir()
    const service = { spaces: registry } as unknown as TaktflowService
    const agent = makeAgent('session-2', second)
    const agents: HostContext['agents'] = {
      get: (id: string) => (id === agent.id ? agent : undefined),
      roots: () => [agent],
    }
    const tool = registerLeadTools(defineToolStub, service, { ctx: { agents } })
      .find((item) => item.name === 'takt_requirement')!
    const result = await tool.execute({ action: 'init' }, execFor(agent)) as LeadToolResult
    expect(result.ok).toBe(true)
    expect(await exists(path.join(second, 'takt.config.json'))).toBe(true)
    expect(await registry.roots()).toEqual([await realpath(first), await realpath(second)])
  })

  it('.takt 是符号链接时在写盘前拒绝', async () => {
    const project = await tempDir()
    const outside = await tempDir('takt-init-outside-')
    await symlink(outside, path.join(project, '.takt'))
    const h = makeHarness({ cwd: project })

    const result = await h.call('takt_requirement', { action: 'init' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(result.error?.message).toContain('符号链接')
    expect(await exists(path.join(project, 'takt.config.json'))).toBe(false)
    expect(await exists(path.join(outside, 'agents'))).toBe(false)
  })

  it('默认角色文件同名目录存在时在写盘前拒绝', async () => {
    const project = await tempDir()
    await mkdir(path.join(project, 'agents', 'dev.md'), { recursive: true })
    const h = makeHarness({ cwd: project })

    const result = await h.call('takt_requirement', { action: 'init' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(await exists(path.join(project, 'takt.config.json'))).toBe(false)
  })

  it('并发 init 两个不同目录都成功，各自独立', async () => {
    const first = await tempDir()
    const second = await tempDir()
    const registry = new FsSpaceRegistry()
    const service = { spaces: registry } as unknown as TaktflowService
    const a = makeAgent('session-a', first)
    const b = makeAgent('session-b', second)
    const agents: HostContext['agents'] = {
      get: (id: string) => (id === a.id ? a : id === b.id ? b : undefined),
      roots: () => [a, b],
    }
    const tool = registerLeadTools(defineToolStub, service, { ctx: { agents } })
      .find((item) => item.name === 'takt_requirement')!
    const [ra, rb] = await Promise.all([
      tool.execute({ action: 'init' }, execFor(a)) as Promise<LeadToolResult>,
      tool.execute({ action: 'init' }, execFor(b)) as Promise<LeadToolResult>,
    ])
    expect(ra.ok && rb.ok).toBe(true)
    expect(await exists(path.join(first, 'takt.config.json'))).toBe(true)
    expect(await exists(path.join(second, 'takt.config.json'))).toBe(true)
  })

  it('非根 Agent 或非 taktflow preset 不能初始化', async () => {
    const project = await tempDir()
    const h = makeHarness({ cwd: project })
    const child = makeAgent('child-1', project)
    const childResult = await h.call('takt_requirement', { action: 'init' }, child)
    expect(childResult.error?.code).toBe('TAKT_NOT_BOUND')

    const standard = makeAgent('session-standard', project, 'standard')
    const agents = {
      get: (id: string) => (id === standard.id ? standard : undefined),
      roots: () => [standard],
    }
    const service = { spaces: h.registry } as unknown as TaktflowService
    const tool = registerLeadTools(defineToolStub, service, { ctx: { agents } })
      .find((item) => item.name === 'takt_requirement')!
    const result = await tool.execute({ action: 'init' }, execFor(standard)) as LeadToolResult
    expect(result.error?.code).toBe('TAKT_NOT_BOUND')
    expect(await exists(path.join(project, 'takt.config.json'))).toBe(false)
  })

  it('takt_status 无空间时把 init 作为下一步', async () => {
    const project = await tempDir()
    const h = makeHarness({ cwd: project })
    const result = await h.call('takt_status', {})
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TAKT_NO_SPACE')
    expect(result.error?.hint).toContain('init')
    expect(result.next_actions[0]).toContain('init')
    expect(result.space).toBeNull()
  })
})
