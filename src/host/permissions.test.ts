import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentTraceHub, bindAgentTraceHub, type AgentTraceDenial } from './agent-trace.js'
import type { Agent, ToolExecution } from './dsh-types.js'
import { createWriteGuard, InMemoryPermissionRegistry } from './permissions.js'
import type { PermissionScope, SpaceHandle } from './types.js'

let root: string
let outside: string
const child: Agent = { id: 'child', options: {}, session: { header: { id: 'child' } }, followup() {}, inject() {} }
const scope = (overrides: Partial<PermissionScope> = {}): PermissionScope => ({
  childId: 'child', nodeRef: { runId: 'run-test', nodeId: 'dev', attempt: 1 }, cwd: root,
  writeScope: ['allowed/**'], allowBash: false, readOnly: false, ...overrides,
})
function exec(name: string, args: unknown, agent: Agent | undefined = child): ToolExecution {
  return { callId: 'call', rootCallId: 'call', token: Symbol(), name, arguments: args, agent, signal: new AbortController().signal }
}
function setup(overrides: Partial<PermissionScope> = {}) {
  const registry = new InMemoryPermissionRegistry()
  const release = registry.register(scope(overrides))
  return { registry, release, guard: createWriteGuard(registry) }
}

function denialRecorder() {
  const calls: Array<{
    root: string
    nodeRef: { runId: string; nodeId: string; attempt: number }
    denial: AgentTraceDenial
  }> = []
  return {
    calls,
    recorder: {
      recordDenial(root: string, nodeRef: { runId: string; nodeId: string; attempt: number }, denial: AgentTraceDenial) {
        calls.push({ root, nodeRef: { ...nodeRef }, denial })
      },
    },
  }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-permission-')))
  outside = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-permission-outside-')))
  await mkdir(path.join(root, 'allowed'))
  await mkdir(path.join(root, 'other', 'sub'), { recursive: true })
})
afterEach(async () => { await Promise.all([root, outside].map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('InMemoryPermissionRegistry', () => {
  it('重复登记拒绝，释放幂等且旧 release 不删除新登记', () => {
    const { registry, release } = setup()
    expect(() => registry.register(scope())).toThrow('已登记')
    release(); release()
    expect(registry.lookup('child')).toBeUndefined()
    registry.register(scope({ writeScope: ['other/**'] }))
    release()
    expect(registry.lookup('child')?.writeScope).toEqual(['other/**'])
  })
  it('固定登记数据，调用方不能在登记后扩大范围', () => {
    const registry = new InMemoryPermissionRegistry()
    const input = scope()
    registry.register(input)
    input.writeScope.push('other/**')
    expect(registry.lookup('child')?.writeScope).toEqual(['allowed/**'])
    expect(() => registry.lookup('child')?.writeScope.push('**')).toThrow()
  })
  it('读取范围拒绝空模式和绝对 glob，登记失败不占用 childId', () => {
    const registry = new InMemoryPermissionRegistry()
    expect(() => registry.register(scope({ readScope: [''] }))).toThrow('非空字符串')
    expect(() => registry.register(scope({ readScope: ['/**'] }))).toThrow('相对 glob')
    expect(() => registry.register(scope({ readScope: ['/src/**'] }))).toThrow('相对 glob')
    expect(registry.lookup('child')).toBeUndefined()
    registry.register(scope({ readScope: ['src/**'] }))
    expect(registry.lookup('child')?.readScope).toEqual(['src/**'])
  })
})

describe('createWriteGuard', () => {
  it('未登记及无 agent 放行；登记按 exec.agent.id 而非 header', () => {
    const { guard } = setup()
    expect(guard(exec('write', { file_path: '../out' }, { ...child, id: 'ordinary' }))).toBeUndefined()
    const noAgent = exec('write', { file_path: '../out' }); delete (noAgent as { agent?: Agent }).agent
    expect(guard(noAgent)).toBeUndefined()
    expect(guard(exec('write', { file_path: '../out' }, { ...child, session: { header: { id: 'other' } } }))).toContain('拒绝')
  })
  it.each(['write', 'edit'])('%s 放行 scope 内相对、绝对、新建父目录路径', (name) => {
    const { guard } = setup()
    for (const file_path of ['allowed/file.ts', './allowed/new/deep/file.ts', `${root}/allowed/file.ts`]) {
      expect(guard(exec(name, { file_path }))).toBeUndefined()
    }
  })
  it.each(['other/file.ts', 'allowed-neighbor/file.ts', '../escape.txt', '../../escape.txt'])('拒绝范围外路径 %s 并给出目标和范围', (file_path) => {
    const text = setup().guard(exec('write', { file_path }))
    expect(text).toContain(file_path)
    expect(text).toContain('allowed/**')
  })
  it('空间根外的绝对路径即使 ** 也拒绝', () => {
    expect(setup({ writeScope: ['**'] }).guard(exec('write', { file_path: `${outside}/file` }))).toContain('空间根之外')
  })
  it('普通物理 .. 回到 scope 内可写，穿过不存在父目录拒绝', () => {
    const { guard } = setup()
    expect(guard(exec('write', { file_path: 'other/../allowed/new.txt' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: 'allowed/missing/../new.txt' }))).toContain('拒绝')
  })
  it('拒绝 symlink 到空间外或同空间其他 scope，允许链接到授权目标', async () => {
    await symlink(outside, path.join(root, 'allowed', 'external'))
    await symlink(path.join(root, 'other'), path.join(root, 'allowed', 'internal'))
    await symlink(path.join(root, 'allowed'), path.join(root, 'alias'))
    const { guard } = setup()
    expect(guard(exec('write', { file_path: 'allowed/external/new/file' }))).toContain('拒绝')
    expect(guard(exec('write', { file_path: 'allowed/internal/new/file' }))).toContain('拒绝')
    expect(guard(exec('write', { file_path: 'alias/new/file' }))).toBeUndefined()
  })
  it('symlink + .. 组合按真实物理父目录拒绝，包含已有和不存在目标', async () => {
    await symlink(path.join(root, 'other', 'sub'), path.join(root, 'allowed', 'link'))
    await writeFile(path.join(root, 'other', 'exists.txt'), 'outside scope')
    for (const target of ['exists.txt', 'new.txt', 'new/deep.txt']) {
      expect(setup().guard(exec('write', { file_path: `allowed/link/../${target}` }))).toContain('拒绝')
    }
  })
  it('拒绝悬空链接、循环链接和不是目录的父组件', async () => {
    await symlink(path.join(outside, 'missing'), path.join(root, 'allowed', 'dangling'))
    await symlink('cycle', path.join(root, 'allowed', 'cycle'))
    await writeFile(path.join(root, 'allowed', 'file'), '')
    const { guard } = setup()
    for (const file_path of ['allowed/dangling', 'allowed/dangling/child', 'allowed/cycle/new', 'allowed/file/child']) {
      expect(guard(exec('write', { file_path }))).toContain('拒绝')
    }
  })
  it.each([{ readOnly: true }, { writeScope: [] }])('只读或空范围拒绝所有写 %o', (overrides) => {
    const { guard } = setup(overrides)
    expect(guard(exec('write', { file_path: 'allowed/file' }))).toContain('只读')
    expect(guard(exec('edit', { file_path: 'allowed/file' }))).toContain('只读')
    expect(guard(exec('read', { file_path: '../elsewhere' }))).toBeUndefined()
  })
  it.each([undefined, null, {}, { path: 'allowed/file' }, { file_path: '' }, { file_path: '\u0000' }])('参数错误时关闭写入 %o', (args) => {
    expect(setup().guard(exec('write', args))).toContain('拒绝')
  })
  it('按 glob 完整匹配，不误把路径前缀当 scope', () => {
    const { guard } = setup({ writeScope: ['allowed/*.ts', 'other/ok?.json'] })
    expect(guard(exec('write', { file_path: 'allowed/new.ts' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: 'allowed/new.ts.js' }))).toContain('拒绝')
    expect(guard(exec('write', { file_path: 'allowed/deep/new.ts' }))).toContain('拒绝')
    expect(guard(exec('write', { file_path: 'other/ok1.json' }))).toBeUndefined()
  })
  it('bash/pwsh 双重拦截；working_directory 仅查询放行且 cd 不可变更', () => {
    const { guard } = setup()
    for (const name of ['bash', 'pwsh']) expect(guard(exec(name, { command: 'anything' }))).toContain('shell')
    expect(guard(exec('working_directory', {}))).toBeUndefined()
    expect(guard(exec('working_directory', { cd: root }))).toContain('不能切换')
    expect(guard(exec('working_directory', { cd: outside }))).toContain('不能切换')
  })
  it('显式空间根使子 cwd 的相对 scope 仍按空间根匹配', () => {
    const registry = new InMemoryPermissionRegistry({ spaceRoot: () => root })
    registry.register(scope({ cwd: path.join(root, 'allowed') }))
    const guard = createWriteGuard(registry)
    expect(guard(exec('write', { file_path: 'new.ts' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: '../other/new.ts' }))).toContain('拒绝')
  })
  it('不同 child 不共享 scope；lookup 自身 cwd 越界失败关闭', () => {
    const registry = new InMemoryPermissionRegistry({ spaceRoot: () => root })
    registry.register(scope())
    registry.register(scope({ childId: 'other-child', cwd: outside, writeScope: ['**'] }))
    expect(createWriteGuard(registry)(exec('write', { file_path: 'file' }, { ...child, id: 'other-child' }))).toContain('不在空间根内')
  })

  it('拒绝时同步登记工具、目标路径和原因，同时保持原拒绝文案', () => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope())
    const { calls, recorder } = denialRecorder()
    const guard = createWriteGuard(registry, { denials: recorder })
    const text = guard(exec('write', { file_path: 'other/file.ts' }))
    expect(text).toContain('拒绝')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.root).toBe(root)
    expect(calls[0]!.nodeRef).toEqual({ runId: 'run-test', nodeId: 'dev', attempt: 1 })
    expect(calls[0]!.denial).toMatchObject({ tool: 'write', path: 'other/file.ts' })
    expect(calls[0]!.denial.reason).toContain('不在写入范围内')
  })

  it('放行不登记；working_directory 和 shell 拒绝也登记', () => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope())
    const { calls, recorder } = denialRecorder()
    const guard = createWriteGuard(registry, { denials: recorder })
    expect(guard(exec('write', { file_path: 'allowed/file.ts' }))).toBeUndefined()
    expect(calls).toHaveLength(0)

    expect(guard(exec('working_directory', { cd: outside }))).toContain('不能切换')
    expect(calls[0]!.denial).toMatchObject({ tool: 'working_directory', path: outside })

    expect(guard(exec('bash', { command: 'rm -rf' }))).toContain('shell')
    expect(calls[1]!.denial).toMatchObject({ tool: 'bash' })
    expect(calls[1]!.denial.path).toBeUndefined()
  })

  it('未显式注入 denials 时按权限登记表取回 RunManager 登记的追溯中心', async () => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope())
    const traces = new AgentTraceHub({ throttleMs: 5_000, log: () => {} })
    bindAgentTraceHub(registry, traces)
    const space = { root, stores: { taktDir: path.join(root, '.takt') } } as unknown as SpaceHandle
    const handle = await traces.begin(space, {
      runId: 'run-test', nodeId: 'dev', attempt: 1, label: 'REQ/dev#1', role: 'dev', sessionId: 'child-trace',
      preset: { id: 'preset', cfgHash: 'hash', plugins: [] },
      profile: { title: '开发', description: '实现', skills: [], writeScope: ['allowed/**'], readOnly: false, source: 'space' },
      prompt: '任务',
    })
    const guard = createWriteGuard(registry)
    expect(guard(exec('write', { file_path: 'other/file.ts' }))).toContain('拒绝')
    // 拒绝同步进入内存记录，不依赖异步写盘完成。
    expect((await traces.read(space, 'run-test'))[0]!.denials[0]).toMatchObject({ tool: 'write', path: 'other/file.ts' })
    await handle.finish({ status: 'completed', stopReason: 'completed' })
    await handle.dispose()
    await traces.disposeAll()
  })

  it('追溯登记失败不能把拒绝变成放行', () => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope())
    const guard = createWriteGuard(registry, {
      denials: { recordDenial() { throw new Error('追溯不可用') } },
    })
    expect(guard(exec('write', { file_path: 'other/file.ts' }))).toContain('拒绝')
  })
})

describe('readScope 读取范围', () => {
  const readGuard = (overrides: Partial<PermissionScope> = {}) => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope(overrides))
    return { registry, guard: createWriteGuard(registry) }
  }

  it('缺省不限制读取；空数组拒绝 read/read_image/glob/grep/list', () => {
    expect(readGuard().guard(exec('read', { file_path: '../elsewhere' }))).toBeUndefined()
    const { guard } = readGuard({ readScope: [] })
    for (const [name, args] of [
      ['read', { file_path: 'allowed/file.ts' }],
      ['read_image', { file_path: 'allowed/pic.png' }],
      ['glob', { pattern: '**/*.ts', path: 'allowed' }],
      ['grep', { pattern: 'x', path: 'allowed' }],
      ['list', { path: 'allowed' }],
    ] as const) expect(guard(exec(name, args))).toContain('不在读取范围内')
  })

  it('文件读取按 cwd 相对与空间根相对匹配，绝对路径同样校验', async () => {
    const artifact = path.join(root, '.takt', 'workspaces', 'REQ-1')
    const worktree = path.join(root, 'worktrees', 'REQ-1')
    await mkdir(path.join(artifact, 'tasks'), { recursive: true })
    await mkdir(path.join(root, 'requirements', 'REQ-1'), { recursive: true })
    await mkdir(worktree, { recursive: true })
    const { guard } = readGuard({
      cwd: worktree, spaceRoot: root, artifactRoot: artifact,
      readScope: ['src/**', '.takt/workspaces/**', 'requirements/**'],
    })
    expect(guard(exec('read', { file_path: 'src/file.ts' }))).toBeUndefined()
    expect(guard(exec('read', { file_path: `${worktree}/src/file.ts` }))).toBeUndefined()
    expect(guard(exec('read', { file_path: `${artifact}/tasks/spec.md` }))).toBeUndefined()
    expect(guard(exec('read', { file_path: 'requirements/REQ-1/spec.md' }))).toBeUndefined()
    expect(guard(exec('read', { file_path: `${root}/other/secret.txt` }))).toContain('不在读取范围内')
    expect(guard(exec('read_image', { file_path: 'src/pic.png' }))).toBeUndefined()
    expect(guard(exec('read_image', { file_path: 'other/pic.png' }))).toContain('不在读取范围内')
  })

  it('物理 .. 回到范围内放行，symlink 指向范围外或其它范围拒绝', async () => {
    await mkdir(path.join(root, 'allowed', 'sub'), { recursive: true })
    await symlink(outside, path.join(root, 'allowed', 'external'))
    await symlink(path.join(root, 'other'), path.join(root, 'allowed', 'internal'))
    await symlink(path.join(root, 'allowed'), path.join(root, 'alias'))
    const { guard } = readGuard({ readScope: ['allowed/**'] })
    expect(guard(exec('read', { file_path: 'other/../allowed/file.ts' }))).toBeUndefined()
    expect(guard(exec('read', { file_path: 'allowed/missing/../file.ts' }))).toContain('无法安全解析')
    expect(guard(exec('read', { file_path: 'allowed/external/secret' }))).toContain('空间根之外')
    expect(guard(exec('read', { file_path: 'allowed/internal/secret' }))).toContain('不在读取范围内')
    expect(guard(exec('read', { file_path: 'alias/file.ts' }))).toBeUndefined()
  })

  it('目录搜索必须证明整棵子树在范围内；省略 path 等于 cwd', async () => {
    await mkdir(path.join(root, 'allowed', 'sub'), { recursive: true })
    await writeFile(path.join(root, 'allowed', 'sub', 'file.ts'), '')
    const scoped = readGuard({ readScope: ['allowed/**'] }).guard
    expect(scoped(exec('glob', { pattern: '**/*.ts', path: 'allowed' }))).toBeUndefined()
    expect(scoped(exec('glob', { pattern: '**/*.ts', path: 'allowed/sub' }))).toBeUndefined()
    expect(scoped(exec('grep', { pattern: 'x', path: 'allowed' }))).toBeUndefined()
    expect(scoped(exec('grep', { pattern: 'x', path: 'allowed/sub/file.ts' }))).toBeUndefined()
    expect(scoped(exec('list', { path: 'allowed' }))).toBeUndefined()
    expect(scoped(exec('glob', { pattern: '**/*.ts', path: 'other' }))).toContain('整棵子树不在读取范围内')
    expect(scoped(exec('glob', { pattern: '**/*.ts' }))).toContain('整棵子树不在读取范围内')
    expect(scoped(exec('grep', { pattern: 'x', path: 'other' }))).toContain('整棵子树不在读取范围内')
    expect(scoped(exec('list', { path: '.' }))).toContain('整棵子树不在读取范围内')
    const all = readGuard({ readScope: ['**'] }).guard
    expect(all(exec('glob', { pattern: '**/*.ts' }))).toBeUndefined()
    expect(all(exec('grep', { pattern: 'x', path: '.' }))).toBeUndefined()
    expect(all(exec('list', {}))).toBeUndefined()
  })

  it('合法通配符前缀按目录及祖先证明整树覆盖，不误拒合法 glob', async () => {
    await mkdir(path.join(root, 'src', 'host', 'role'), { recursive: true })
    const { guard } = readGuard({ readScope: ['src/**/role/**'] })
    expect(guard(exec('read', { file_path: 'src/host/role/index.ts' }))).toBeUndefined()
    expect(guard(exec('grep', { pattern: 'x', path: 'src/host/role' }))).toBeUndefined()
    expect(guard(exec('glob', { pattern: '**/*.ts', path: 'src/host/role/sub' }))).toBeUndefined()
    expect(guard(exec('grep', { pattern: 'x', path: 'src/host' }))).toContain('整棵子树不在读取范围内')
    expect(guard(exec('grep', { pattern: 'x', path: '.' }))).toContain('整棵子树不在读取范围内')
    expect(guard(exec('read', { file_path: 'src/host/index.ts' }))).toContain('不在读取范围内')
  })

  it('绝对 readScope 不会比文件读取更宽；[]/**/正常 ** 保持一致', () => {
    const raw = (patterns: string[]) => ({
      register: () => () => {},
      lookup: () => scope({ readScope: patterns }),
    })
    for (const patterns of [['/**'], ['/src/**']]) {
      const guard = createWriteGuard(raw(patterns))
      expect(guard(exec('read', { file_path: 'src/host/index.ts' }))).toContain('不在读取范围内')
      expect(guard(exec('grep', { pattern: 'x', path: '.' }))).toContain('整棵子树不在读取范围内')
      expect(guard(exec('list', {}))).toContain('整棵子树不在读取范围内')
    }
    const empty = readGuard({ readScope: [] }).guard
    expect(empty(exec('read', { file_path: 'src/host/index.ts' }))).toContain('不在读取范围内')
    expect(empty(exec('grep', { pattern: 'x', path: '.' }))).toContain('整棵子树不在读取范围内')
    const all = readGuard({ readScope: ['**'] }).guard
    expect(all(exec('read', { file_path: 'src/host/index.ts' }))).toBeUndefined()
    expect(all(exec('grep', { pattern: 'x', path: '.' }))).toBeUndefined()
  })

  it('读取拒绝同样登记 trace.denials，且不影响放行', () => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope({ readScope: ['allowed/**'] }))
    const { calls, recorder } = denialRecorder()
    const guard = createWriteGuard(registry, { denials: recorder })
    expect(guard(exec('read', { file_path: 'allowed/file.ts' }))).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(guard(exec('read', { file_path: 'other/file.ts' }))).toContain('拒绝')
    expect(calls[0]!.denial).toMatchObject({ tool: 'read', path: 'other/file.ts' })
    expect(calls[0]!.denial.reason).toContain('不在读取范围内')
  })
})

describe('两域写权限（worktree + 当前需求产物）', () => {
  let artifact: string
  let worktree: string
  const patterns = ['src/**', 'package.json', '.takt/workspaces/**/tasks/**', 'requirements/**/tasks/**']

  beforeEach(async () => {
    artifact = path.join(root, '.takt', 'workspaces', 'REQ-1')
    worktree = path.join(root, 'worktrees', 'REQ-1')
    await mkdir(path.join(artifact, 'tasks'), { recursive: true })
    await mkdir(path.join(root, '.takt', 'workspaces', 'REQ-2', 'tasks'), { recursive: true })
    await mkdir(path.join(root, 'requirements', 'REQ-1', 'tasks'), { recursive: true })
    await mkdir(path.join(root, 'requirements', 'REQ-2', 'tasks'), { recursive: true })
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    await mkdir(path.join(root, 'src'), { recursive: true })
  })

  const twoDomain = (cwd: string) => {
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope({ cwd, spaceRoot: root, artifactRoot: artifact, writeScope: patterns }))
    return createWriteGuard(registry)
  }

  it('worktree 代码按 cwd 相对匹配，空间根同名代码不能借 src/** 授权', () => {
    const guard = twoDomain(worktree)
    expect(guard(exec('write', { file_path: 'src/file.ts' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: `${worktree}/src/file.ts` }))).toBeUndefined()
    expect(guard(exec('write', { file_path: `${root}/src/file.ts` }))).toContain('代码写入必须在当前工作目录内')
    expect(guard(exec('write', { file_path: `${root}/package.json` }))).toContain('代码写入必须在当前工作目录内')
  })

  it('只允许真实 artifactRoot；不凭 basename 额外放行 legacy 同 ID 目录', () => {
    const guard = twoDomain(worktree)
    expect(guard(exec('write', { file_path: `${artifact}/tasks/t.md` }))).toBeUndefined()
    expect(guard(exec('write', { file_path: `${root}/requirements/REQ-1/tasks/t.md` }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: `${root}/.takt/workspaces/REQ-2/tasks/t.md` }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: `${root}/requirements/REQ-2/tasks/t.md` }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: `${root}/.takt/runs/run-1/x.json` }))).toContain('代码写入必须在当前工作目录内')
  })

  it('cwd 为空间根时保留 P0 代码路径，但兄弟需求仍按当前需求隔离', () => {
    const guard = twoDomain(root)
    expect(guard(exec('write', { file_path: 'src/file.ts' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: 'package.json' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: '.takt/workspaces/REQ-1/tasks/t.md' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: '.takt/workspaces/REQ-2/tasks/t.md' }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: 'requirements/REQ-1/tasks/t.md' }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: 'requirements/REQ-2/tasks/t.md' }))).toContain('公共产物只允许写入当前需求目录')
  })

  it('自定义需求目录按实际父目录保护兄弟，兄弟目录不能落入 cwd 代码域', async () => {
    const customArtifact = path.join(root, 'src', 'host', 'lead')
    await mkdir(customArtifact, { recursive: true })
    await mkdir(path.join(root, 'src', 'host', 'role'), { recursive: true })
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope({
      spaceRoot: root, artifactRoot: customArtifact, writeScope: ['src/host/**'],
    }))
    const guard = createWriteGuard(registry)
    expect(guard(exec('write', { file_path: 'src/host/lead/design.md' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: 'src/host/role/index.ts' }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: 'src/host/lead-neighbor/file.ts' }))).toContain('公共产物只允许写入当前需求目录')
  })

  it('legacy requirements 布局只允许实际当前需求，另一布局不能创建第二份产物', () => {
    const legacyArtifact = path.join(root, 'requirements', 'REQ-1')
    const registry = new InMemoryPermissionRegistry()
    registry.register(scope({
      spaceRoot: root, artifactRoot: legacyArtifact,
      writeScope: ['requirements/**/tasks/**', '.takt/workspaces/**/tasks/**'],
    }))
    const guard = createWriteGuard(registry)
    expect(guard(exec('write', { file_path: 'requirements/REQ-1/tasks/t.md' }))).toBeUndefined()
    expect(guard(exec('write', { file_path: 'requirements/REQ-2/tasks/t.md' }))).toContain('公共产物只允许写入当前需求目录')
    expect(guard(exec('write', { file_path: '.takt/workspaces/REQ-1/tasks/t.md' }))).toContain('公共产物只允许写入当前需求目录')
  })

  it('worktree 内 symlink 指向空间根代码仍按物理目标拒绝', async () => {
    await symlink(path.join(root, 'src'), path.join(worktree, 'src-link'))
    const guard = twoDomain(worktree)
    expect(guard(exec('write', { file_path: 'src-link/file.ts' }))).toContain('代码写入必须在当前工作目录内')
  })
})
