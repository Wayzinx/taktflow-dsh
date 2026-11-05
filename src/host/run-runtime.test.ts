import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, type WorkflowDefinition } from '@taktflow/core'
import { FsSpaceRegistry } from './space.js'
import { knowledgeForRun, loadRunProfiles, loadRunRuntime } from './run-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-runtime-'))
  roots.push(root)
  const stores = await initProject(root)
  const space = await new FsSpaceRegistry().open(root)
  return { root, stores, space }
}

it('角色解析保留allowBash与skills，错误的allowBash不能静默忽略', async () => {
  const { space, stores } = await fixture()
  const file = join(stores.taktDir, 'agents/dev.md')
  const markdown = '---\nrole: dev\nharness: dsh-host\nallowBash: true\nskills: [review]\nwriteScope: ["src/**"]\n---\n角色说明'
  await writeFile(file, markdown)
  expect((await loadRunProfiles(space)).dev).toMatchObject({ allowBash: true, skills: ['review'], instructions: '角色说明' })
  await writeFile(file, markdown.replace('allowBash: true', 'allowBash: yes'))
  await expect(loadRunProfiles(space)).rejects.toThrow('allowBash 必须是 boolean')
})

it('随包默认角色覆盖 p0-delivery 的四个角色且都不允许 shell', async () => {
  const { space } = await fixture()
  const profiles = await loadRunProfiles(space)
  expect(Object.keys(profiles).sort()).toEqual(['analyst', 'architect', 'dev', 'reporter'])
  expect(profiles.analyst).toMatchObject({ harness: { harness: 'dsh-host' }, allowBash: false, writeScope: [] })
  expect(profiles.architect).toMatchObject({ allowBash: false, writeScope: ['.takt/workspaces/*/design/**'] })
  expect(profiles.dev).toMatchObject({ allowBash: false, writeScope: ['src/**'] })
  expect(profiles.reporter).toMatchObject({ allowBash: false, writeScope: ['.takt/workspaces/*/reports/**'] })
  for (const profile of Object.values(profiles)) expect(profile.instructions.length).toBeGreaterThan(0)
})

it('角色文件是目录或符号链接时拒绝，不静默回退默认角色', async () => {
  const { root, space, stores } = await fixture()
  const agents = join(stores.taktDir, 'agents')
  const outside = join(root, 'outside')
  await mkdir(outside)

  await mkdir(join(agents, 'dev.md'))
  await expect(loadRunProfiles(space)).rejects.toThrow('角色文件不是普通文件')
  await rm(join(agents, 'dev.md'), { recursive: true, force: true })

  const outsideFile = join(outside, 'dev.md')
  await writeFile(outsideFile, '---\nrole: dev\nharness: dsh-host\n---\n空间外角色')
  await symlink(outsideFile, join(agents, 'dev.md'))
  await expect(loadRunProfiles(space)).rejects.toThrow('不能是符号链接')
})

it('角色目录是符号链接时拒绝', async () => {
  const { root, space, stores } = await fixture()
  const agents = join(stores.taktDir, 'agents')
  const outside = join(root, 'outside-agents')
  await mkdir(outside)
  await rm(agents, { recursive: true, force: true })
  await symlink(outside, agents)
  await expect(loadRunProfiles(space)).rejects.toThrow('角色目录不是普通目录')
})

it('祖先 .takt 是符号链接时拒绝，不能读到空间外的角色', async () => {
  const { root, space, stores } = await fixture()
  const taktDir = stores.taktDir
  const outside = join(root, 'outside-takt')
  await rename(taktDir, outside)
  await symlink(outside, taktDir)
  await expect(loadRunProfiles(space)).rejects.toThrow('符号链接')
})

it('文件名与声明 role 不一致时拒绝，避免同时顶掉两个角色', async () => {
  const { space, stores } = await fixture()
  await writeFile(
    join(stores.taktDir, 'agents/dev.md'),
    '---\nrole: analyst\nharness: dsh-host\n---\n冒充分析师',
  )
  await expect(loadRunProfiles(space)).rejects.toThrow('角色名与文件名不一致')
})

it('空间同名角色覆盖默认档案，并进入运行冻结', async () => {
  const { root, space, stores } = await fixture()
  const workflow: WorkflowDefinition = { id: 'test', version: '1', title: '测试', stages: [], nodes: [] }
  const before = await loadRunRuntime(space, workflow)
  await writeFile(
    join(stores.taktDir, 'agents/dev.md'),
    '---\nrole: dev\nharness: dsh-host\nallowBash: false\nwriteScope: ["custom/**"]\n---\n空间自定义开发角色',
  )
  const after = await loadRunRuntime(space, workflow)
  expect(before.profiles.dev?.instructions).not.toBe('空间自定义开发角色')
  expect(after.profiles.dev).toMatchObject({
    instructions: '空间自定义开发角色',
    writeScope: ['custom/**'],
    allowBash: false,
  })
  // 来源在开始时冻结：默认角色 bundled，空间同名覆盖为 space。
  expect(before.profileSources.dev).toBe('bundled')
  expect(after.profileSources.dev).toBe('space')
  expect(after.profileSources.analyst).toBe('bundled')
  // 运行开始时冻结：之后改磁盘不影响已加载的 runtime。
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, contextBudgetTokens: 4321 }))
  expect(after.space.stores.config.contextBudgetTokens).not.toBe(4321)
})

it('新运行读取最新配置并隔离其对象，workflow函数保留且容器不共享', async () => {
  const { root, space, stores } = await fixture()
  const fn = async () => {}
  const workflow: WorkflowDefinition = { id: 'test', version: '1', title: '旧标题', stages: [], nodes: [{ id: 'script', kind: 'script', title: '脚本', run: fn }] }
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, contextBudgetTokens: 1234 }))
  const runtime = await loadRunRuntime(space, workflow)
  workflow.title = '新标题'
  workflow.nodes[0]!.title = '修改'
  stores.config.contextBudgetTokens = 99
  expect(runtime.space.stores.config.contextBudgetTokens).toBe(1234)
  expect(runtime.workflow.title).toBe('旧标题')
  expect(runtime.workflow.nodes[0]).toMatchObject({ title: '脚本', run: fn })
})

it('knowledge未配置有默认源，配置显式空数组保持空，非法kind与重复ID拒绝', async () => {
  const { space } = await fixture()
  expect(knowledgeForRun(space).length).toBeGreaterThan(0)
  space.stores.config.knowledge = []
  expect(knowledgeForRun(space)).toEqual([])
  space.stores.config.knowledge = [{ id: 'bad', kind: 'unknown' }]
  expect(() => knowledgeForRun(space)).toThrow('未知知识源类型')
  space.stores.config.knowledge = [{ id: 'same', kind: 'workspace' }, { id: 'same', kind: 'workspace' }]
  expect(() => knowledgeForRun(space)).toThrow('ID 为空或重复')
})

it('知识源配置重映射sourceId，拒绝错误类型的选项', async () => {
  const { space } = await fixture()
  space.stores.config.knowledge = [{ id: 'project-history', kind: 'workspace' }]
  const sources = knowledgeForRun(space)
  expect(sources.map((source) => source.id)).toEqual(['project-history'])
  space.stores.config.knowledge = [{ id: 'search', kind: 'grep', options: { ignore: 'not-an-array' } }]
  expect(() => knowledgeForRun(space)).toThrow('ignore 必须是字符串数组')
  space.stores.config.knowledge = [{ id: 'search', kind: 'grep', options: { unsafe: true } }]
  expect(() => knowledgeForRun(space)).toThrow('不支持的选项')
})
