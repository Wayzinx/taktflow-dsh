import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { initProject, type NodeDef, type PlannerNodeDef, type WorkflowDefinition } from '@taktflow/core'
import { BUNDLED_ROLE_NAMES } from '../roles/defaults.js'
import { FsSpaceRegistry } from './space.js'
import { knowledgeForRun, loadRunProfiles, loadRunRuntime, prepareRunArgs, repoBindingsForRun } from './run-runtime.js'

const exec = promisify(execFile)
async function git(dir: string, args: readonly string[]): Promise<void> {
  await exec('git', ['-C', dir, ...args], { timeout: 5_000 })
}
async function initGit(root: string, branch = 'master'): Promise<void> {
  await exec('git', ['init', '-b', branch, root], { timeout: 5_000 })
  await git(root, ['config', 'user.email', 'test@example.com'])
  await git(root, ['config', 'user.name', '测试'])
  await writeFile(join(root, 'README.md'), '# 仓库\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'init'])
}

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
  const file = join(stores.paths.agents, 'dev.md')
  const markdown = '---\nrole: dev\nharness: dsh-host\nallowBash: true\nskills: [review]\nwriteScope: ["src/**"]\n---\n角色说明'
  await writeFile(file, markdown)
  expect((await loadRunProfiles(space)).dev).toMatchObject({ allowBash: true, skills: ['review'], instructions: '角色说明' })
  await writeFile(file, markdown.replace('allowBash: true', 'allowBash: yes'))
  await expect(loadRunProfiles(space)).rejects.toThrow('allowBash 必须是 boolean')
})

it('随包默认角色覆盖模板与 p0-delivery 角色且都不允许 shell', async () => {
  const { space } = await fixture()
  const profiles = await loadRunProfiles(space)
  expect(Object.keys(profiles).sort()).toEqual([...BUNDLED_ROLE_NAMES].sort())
  expect(profiles.analyst).toMatchObject({ harness: { harness: 'dsh-host' }, allowBash: false, writeScope: [] })
  expect(profiles.architect).toMatchObject({ allowBash: false, writeScope: ['.takt/workspaces/**', 'requirements/**'] })
  expect(profiles.dev).toMatchObject({ allowBash: false, writeScope: ['src/**', 'package.json', '.takt/workspaces/**/tasks/**', 'requirements/**/tasks/**'] })
  expect(profiles.reporter).toMatchObject({ allowBash: false, writeScope: ['.takt/workspaces/*/reports/**', 'requirements/*/reports/**'] })
  for (const profile of Object.values(profiles)) expect(profile.instructions.length).toBeGreaterThan(0)
})

it('角色文件是目录或符号链接时拒绝，不静默回退默认角色', async () => {
  const { root, space, stores } = await fixture()
  const agents = stores.paths.agents
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
  const agents = stores.paths.agents
  const outside = join(root, 'outside-agents')
  await mkdir(outside)
  await rm(agents, { recursive: true, force: true })
  await symlink(outside, agents)
  await expect(loadRunProfiles(space)).rejects.toThrow('角色目录不是普通目录')
})

it('角色目录的祖先目录是符号链接时拒绝，不能读到空间外的角色', async () => {
  const { root, stores } = await fixture()
  const outside = join(root, 'outside-agents')
  await mkdir(outside)
  // 自定义 agents 路径位于符号链接目录下；openProject 按真实 paths 解析后必须拒绝。
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({
    ...stores.config,
    paths: { ...(stores.config.paths ?? {}), agents: 'linked/agents' },
  }))
  await symlink(outside, join(root, 'linked'))
  const space = await new FsSpaceRegistry().open(root)
  await expect(loadRunProfiles(space)).rejects.toThrow('符号链接')
})

it('文件名与声明 role 不一致时拒绝，避免同时顶掉两个角色', async () => {
  const { space, stores } = await fixture()
  await writeFile(
    join(stores.paths.agents, 'dev.md'),
    '---\nrole: analyst\nharness: dsh-host\n---\n冒充分析师',
  )
  await expect(loadRunProfiles(space)).rejects.toThrow('角色名与文件名不一致')
})

it('空间同名角色覆盖默认档案，并进入运行冻结', async () => {
  const { root, space, stores } = await fixture()
  const workflow: WorkflowDefinition = { id: 'test', version: '1', title: '测试', stages: [], nodes: [] }
  const before = await loadRunRuntime(space, workflow)
  await writeFile(
    join(stores.paths.agents, 'dev.md'),
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

it('full 克隆并强制关闭 args.review/args.reviews 的人工签字，manual/checkpoints 保持原样', () => {
  const args = {
    review: { humanSignoff: true, maxRounds: 3 },
    reviews: { 'plan/item': { humanSignoff: true, maxReworks: 2 } },
    other: { keep: true },
  }
  const full = prepareRunArgs(args, 'full')
  expect(full.review).toEqual({ humanSignoff: false, maxRounds: 3 })
  expect(full.reviews).toEqual({ 'plan/item': { humanSignoff: false, maxReworks: 2 } })
  expect(full.other).toEqual({ keep: true })
  // 入参不能被修改：同一份 args 后续还可能被 manual 运行复用。
  expect(args.review.humanSignoff).toBe(true)
  expect(args.reviews['plan/item']!.humanSignoff).toBe(true)
  expect(prepareRunArgs(args, 'manual')).toBe(args)
  expect(prepareRunArgs(args, 'checkpoints')).toBe(args)
  // 非对象值不能被强制改写成对象；空/数组保持。
  expect(prepareRunArgs({ review: null, reviews: [] }, 'full')).toMatchObject({ review: null, reviews: [] })
})

it('标准流程唯一 legacy main 补 app 别名并保留 main，缺省分支读真实 HEAD（master）', async () => {
  const { root, space, stores } = await fixture()
  await initGit(root, 'master')
  await writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, repos: [{ id: 'main', path: '.' }] }))
  const workflow: WorkflowDefinition = { id: 'taktflow-standard', version: '1', title: '标准', stages: [], nodes: [] }
  const runtime = await loadRunRuntime(space, workflow)
  const repos = runtime.space.stores.config.repos ?? []
  expect(repos.map((repo) => repo.id)).toEqual(['main', 'app'])
  expect(repos.find((repo) => repo.id === 'main')).toMatchObject({ id: 'main', path: '.' })
  expect(repos.find((repo) => repo.id === 'app')).toMatchObject({ id: 'app', path: '.', purpose: 'app', defaultBranch: '' })
  const bindings = await repoBindingsForRun(runtime.space)
  expect(bindings.map((repo) => [repo.id, repo.defaultBranch])).toEqual([['main', 'master'], ['app', 'master']])
})

it('多仓库或已有 app 时不做 main→app 别名；非标准流程完全不动', async () => {
  const { root, space, stores } = await fixture()
  const standard: WorkflowDefinition = { id: 'taktflow-standard', version: '1', title: '标准', stages: [], nodes: [] }
  const writeRepos = (repos: unknown[]) => writeFile(join(root, 'takt.config.json'), JSON.stringify({ ...stores.config, repos }))

  await writeRepos([{ id: 'main', path: '.' }, { id: 'app', path: 'repos/app' }])
  const runtime = await loadRunRuntime(space, standard)
  expect(runtime.space.stores.config.repos?.map((repo) => repo.id)).toEqual(['main', 'app'])

  await writeRepos([{ id: 'main', path: '.' }, { id: 'other', path: 'repos/other' }])
  const multi = await loadRunRuntime(space, standard)
  expect(multi.space.stores.config.repos?.map((repo) => repo.id)).toEqual(['main', 'other'])

  await writeRepos([{ id: 'main', path: '.' }])
  const other: WorkflowDefinition = { id: 'custom', version: '1', title: '自定义', stages: [], nodes: [] }
  const custom = await loadRunRuntime(space, other)
  expect(custom.space.stores.config.repos?.map((repo) => repo.id)).toEqual(['main'])
})

it('缺省 defaultBranch 无法确定唯一分支时明确拒绝，不假定 main', async () => {
  const { root, space } = await fixture()
  await initGit(root, 'master')
  await git(root, ['branch', 'other'])
  await git(root, ['checkout', '--detach'])
  space.stores.config.repos = [{ id: 'main', path: '.', defaultBranch: '' }]
  await expect(repoBindingsForRun(space)).rejects.toMatchObject({
    code: 'TAKT_UNSUPPORTED_NODE',
    message: expect.stringContaining('无法从仓库确定唯一默认分支'),
  })
})

it('full/dsh-host 的 planner 展开先克隆，不污染后续 manual/profile 运行', async () => {
  const { space } = await fixture()
  const shared: NodeDef[] = [{
    id: 'review', kind: 'review', title: '共享评审', needs: [], target: ['reports/quality.md'],
    author: { role: 'pm' }, reviewers: [{ role: 'release-reviewer', harness: { harness: 'profile' } }],
    maxRounds: 1, onExhausted: 'human', humanSignoff: true,
  }]
  const planner: PlannerNodeDef = {
    id: 'plan', kind: 'planner', title: '计划', role: 'pm', prompt: '展开任务', maxItems: 2,
    expand: () => shared, harness: { harness: 'dsh-host', model: 'app-model' },
  }
  const workflow: WorkflowDefinition = { id: 'test', version: '1', title: '展开测试', stages: [], nodes: [planner] }
  const item = { key: 'item-1', title: '条目' } as Parameters<PlannerNodeDef['expand']>[0]

  const full = await loadRunRuntime(space, workflow, { autonomy: 'full', roleHarness: 'dsh-host' })
  const expandedFull = (full.workflow.nodes[0] as PlannerNodeDef).expand(item)
  expect(expandedFull[0]).toMatchObject({ humanSignoff: false, reviewers: [{ harness: { harness: 'dsh-host' } }] })
  expect((full.workflow.nodes[0] as PlannerNodeDef).harness).toEqual({ harness: 'dsh-host' })

  const manual = await loadRunRuntime(space, workflow, { autonomy: 'manual', roleHarness: 'profile' })
  const expandedManual = (manual.workflow.nodes[0] as PlannerNodeDef).expand(item)
  expect(expandedManual[0]).toMatchObject({ humanSignoff: true, reviewers: [{ harness: { harness: 'profile' } }] })
  expect((manual.workflow.nodes[0] as PlannerNodeDef).harness).toEqual({ harness: 'dsh-host', model: 'app-model' })
  // 闭包里的共享数组必须原样保留，否则 full 会把后续 manual 也改成无签字。
  expect(shared[0]).toMatchObject({ humanSignoff: true, reviewers: [{ harness: { harness: 'profile' } }] })
})
