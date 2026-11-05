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
