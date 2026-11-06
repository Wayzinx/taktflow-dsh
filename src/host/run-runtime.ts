import { execFile } from 'node:child_process'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  assertRunId, canonicalJson, createInsights, openProject, parseFrontmatter, sha256,
  type AgentProfile, type HarnessSelector, type KnowledgeSource, type NodeDef, type RepoBinding,
  type WorkflowDefinition, assertNoSymlinks, readJsonFile, writeFileAtomic,
} from '@taktflow/core'
import {
  createApiRegistrySource, createCodeGraphSource, createDatabaseSource, createDefaultSources,
  createGitHistorySource, createGrepSource, createWikiSource, createWorkspaceSource,
} from '@taktflow/knowledge'
import { BUNDLED_ROLE_FILES } from '../roles/defaults.js'
import { loadRoleSkills, type RoleSkillSnapshots } from './role-skills.js'
import { TaktToolError, type Autonomy, type RoleHarness, type SpaceHandle } from './types.js'

/** 角色档案来源；运行开始时冻结，结束再 stat 会因磁盘变化漂移。 */
export type ProfileSource = 'space' | 'bundled'

/** 一次角色读取的结果：档案本身与每个角色的来源。 */
export interface LoadedProfiles {
  profiles: Record<string, AgentProfile>
  sources: Record<string, ProfileSource>
}

/** RunManager 在开始时固定的执行配置；等待审批期间仍复用这一份。 */
export interface RunRuntime {
  space: SpaceHandle
  workflow: WorkflowDefinition
  profiles: Record<string, AgentProfile>
  /** 每个角色在读取时的来源；追溯按它记录，不从角色名或结束状态猜测。 */
  profileSources: Record<string, ProfileSource>
  /** 运行开始时冻结的角色技能内容；技能文件后续变化不影响本次运行。 */
  roleSkills: RoleSkillSnapshots
  knowledge: KnowledgeSource[]
  /** 自主程度与角色 harness 在执行期间冻结，重启恢复必须完全一致。 */
  autonomy: Autonomy
  roleHarness: RoleHarness
}

/** loadRunRuntime 的调用方覆盖项；空间配置优先于这里，非法值不静默降级。 */
export interface RunRuntimeOptions {
  autonomy?: Autonomy
  roleHarness?: RoleHarness
}

interface RuntimeIdentity {
  version: 2
  hasFunctions: boolean
  config: string
  profiles: string
  /** 来源也参与身份：同名角色由 bundled 换成 space 时不能恢复旧运行。 */
  profileSources: string
  roleSkills: string
  workflow: string
  autonomy: Autonomy
  roleHarness: RoleHarness
}

/**
 * preset 和 RunManager 共用的角色读取器；按 CLI runtime-profiles 的格式读取。
 *
 * 合并顺序：随包默认角色（模板角色 + P0 演示角色）→ 空间
 * `agents/*.md`（新布局）或旧布局 `.takt/agents/*.md`。同名空间文件覆盖默认，
 * 用户可以直接改；空间内部出现同名角色仍然报错。合并结果参与 RunRuntime 的
 * 身份摘要和运行冻结。
 *
 * 失败直接交给调用方，尤其不能把 allowBash:true 静默丢掉。
 */
export async function loadRunProfiles(space: SpaceHandle): Promise<Record<string, AgentProfile>> {
  return (await loadRunProfilesDetailed(space)).profiles
}

/** 与 loadRunProfiles 相同，同时返回每个角色读取时的来源（bundled/space）。 */
export async function loadRunProfilesDetailed(space: SpaceHandle): Promise<LoadedProfiles> {
  const defaults = Object.create(null) as Record<string, AgentProfile>
  const sources: Record<string, ProfileSource> = Object.create(null)
  for (const file of BUNDLED_ROLE_FILES) {
    const profile = parseProfile(file.fileName, file.content, space)
    if (Object.hasOwn(defaults, profile.role)) throw new Error(`随包角色名称重复：${profile.role}`)
    defaults[profile.role] = profile
    sources[profile.role] = 'bundled'
  }

  // M2 新布局在顶层 `agents/`，旧空间仍是 `.takt/agents/`；一律以本次 openProject
  // 得到的真实 paths 为准，避免只读旧目录或写死布局。
  const dir = space.stores.paths.agents
  // 角色目录本身是符号链接时，readdir 会把空间外的文件当成本空间角色；直接拒绝。
  const dirInfo = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (dirInfo !== undefined && !dirInfo.isDirectory()) {
    throw new Error(`角色目录不是普通目录：${dir}`)
  }
  // lstat 只保护最后一段；`.takt` 本身是符号链接时仍会读到空间外，必须逐段核对。
  await assertNoSymlinks(space.root, dir)
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const overrides: Record<string, AgentProfile> = Object.create(null)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue
    // 目录/符号链接同名角色文件不能静默跳过，否则会悄悄回退到随包默认角色。
    if (entry.isSymbolicLink()) throw new Error(`角色文件不能是符号链接：${entry.name}`)
    if (!entry.isFile()) throw new Error(`角色文件不是普通文件：${entry.name}`)
    const profile = parseProfile(entry.name, await readFile(join(dir, entry.name), 'utf8'), space)
    // 文件名即角色名：dev.md 声明 role: analyst 会同时顶掉 analyst 并让 dev 回退默认。
    if (profile.role !== entry.name.slice(0, -3)) {
      throw new Error(`角色名与文件名不一致：${entry.name} 声明 role=${profile.role}`)
    }
    if (Object.hasOwn(overrides, profile.role)) throw new Error(`角色名称冲突：${profile.role}`)
    overrides[profile.role] = profile
    sources[profile.role] = 'space'
  }
  return {
    profiles: Object.assign(Object.create(null) as Record<string, AgentProfile>, defaults, overrides),
    sources,
  }
}

/** 解析单个角色文件；默认角色与空间角色共用，避免两套字段规则漂移。 */
function parseProfile(fileName: string, content: string, space: SpaceHandle): AgentProfile {
  const { data, body } = parseFrontmatter(content)
  const text = (key: string, fallback: string): string => typeof data[key] === 'string' && data[key] !== '' ? data[key] : fallback
  const list = (key: string): string[] => {
    const value = data[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`角色 ${fileName} 的 ${key} 必须是字符串数组`)
    return [...value] as string[]
  }
  const role = text('role', fileName.slice(0, -3))
  const harness = typeof data.harness === 'string' ? { harness: data.harness } : data.harness ?? space.stores.config.roles?.[role]
  if (!harness || typeof harness !== 'object' || typeof (harness as HarnessSelector).harness !== 'string') throw new Error(`角色 ${role} 缺少 harness`)
  if (data.allowBash !== undefined && typeof data.allowBash !== 'boolean') throw new Error(`角色 ${role} 的 allowBash 必须是 boolean`)
  return {
    role, title: text('title', role), description: text('description', ''),
    instructions: body.trim(), harness: structuredClone(harness as HarnessSelector),
    skills: list('skills'), writeScope: list('writeScope'), allowBash: data.allowBash === true,
    ...(data.readScope === undefined ? {} : { readScope: list('readScope') }),
  }
}

/**
 * RunManager 开始时调用；配置来自本次磁盘读取，既有运行不受后续修改影响。
 *
 * 必须重新 `openProject` 并整体替换 stores：M2 的空间布局把 agents/workflows/
 * requirements 等目录挪到顶层，只替换 config 会继续用旧 `.takt` 路径，导致角色、
 * 知识源和产物都读错目录。`insights` 也按新 stores 重建。
 */
export async function loadRunRuntime(
  space: SpaceHandle,
  workflow: WorkflowDefinition,
  options: RunRuntimeOptions = {},
): Promise<RunRuntime> {
  const current = await openProject(space.root)
  const frozenSpace: SpaceHandle = {
    ...space,
    stores: {
      ...current,
      config: structuredClone(current.config),
      // events/runs 只依赖 .takt 目录，不随 M2 布局变化；复用调用方已装饰的实例，
      // 保留订阅、测试替身和生命周期包装。paths/workspaces 等布局相关字段用本次
      // openProject 的结果，避免继续读旧 `.takt/workspaces`。
      events: space.stores.events,
      runs: space.stores.runs,
    },
    insights: createInsights(current),
  }
  const loaded = await loadRunProfilesDetailed(frozenSpace)
  const autonomy = resolveAutonomy(frozenSpace, options.autonomy)
  const roleHarness = resolveRoleHarness(options.roleHarness)
  const definition = cloneDefinition(workflow)
  // full 模式必须关闭评审人工签字，包括 loop body、subflow 和 planner 动态展开。
  if (autonomy === 'full') sanitizeReviewSignoff(definition)
  // 标准流程按 app 引用主仓库；只有“唯一 legacy main”这一种旧数据才补 app 别名，
  // 且原 main 必须保留。其它流程/多仓库配置一律不动，避免把真实 ID 改名后冲突。
  applyStandardRepoAlias(frozenSpace, definition)
  // dsh-host 模式统一使用 App 模型：清掉角色与节点选择里的 model/provider/fallback，
  // 否则 core 的 selectHarness(override) 会保留它们，自定义 provider 会被拒绝。
  const profiles = roleHarness === 'dsh-host' ? sanitizeProfiles(loaded.profiles) : loaded.profiles
  if (roleHarness === 'dsh-host') sanitizeDshSelectors(definition)
  // 技能内容在运行开始时冻结；dsh-host 的角色局部 skill 工具只服务这份快照。
  const roleSkills = await loadRoleSkills(frozenSpace, profiles)
  return {
    space: frozenSpace,
    workflow: definition,
    profiles,
    profileSources: loaded.sources,
    roleSkills,
    knowledge: knowledgeForRun(frozenSpace),
    autonomy,
    roleHarness,
  }
}

/** 空间配置 autonomy 覆盖插件默认；非法值明确失败，不静默降级成 full。 */
function resolveAutonomy(space: SpaceHandle, fallback: Autonomy | undefined): Autonomy {
  const raw = (space.stores.config as unknown as { autonomy?: unknown }).autonomy
  if (raw === undefined) return fallback ?? 'full'
  if (raw === 'full' || raw === 'checkpoints' || raw === 'manual') return raw
  throw new Error(`takt.config.json 的 autonomy 不合法：${String(raw)}（只允许 full/checkpoints/manual）`)
}

function resolveRoleHarness(value: RoleHarness | undefined): RoleHarness {
  if (value === undefined) return 'dsh-host'
  if (value === 'dsh-host' || value === 'profile') return value
  throw new Error(`roleHarness 不合法：${String(value)}（只允许 dsh-host/profile）`)
}

/** dsh-host 只用 App 模型；effort 仍可由角色选择，但 model/provider/fallback 必须清掉。 */
function sanitizeSelector(selector: HarnessSelector): HarnessSelector {
  return {
    harness: 'dsh-host',
    ...(selector.effort === undefined ? {} : { effort: selector.effort }),
  }
}

function sanitizeProfiles(profiles: Record<string, AgentProfile>): Record<string, AgentProfile> {
  const result = Object.create(null) as Record<string, AgentProfile>
  for (const [role, profile] of Object.entries(profiles)) {
    result[role] = { ...profile, harness: sanitizeSelector(profile.harness) }
  }
  return result
}

/** 静态节点 + loop body + subflow + planner 动态展开都要清理选择器。 */
function sanitizeDshSelectors(workflow: WorkflowDefinition): void {
  const visit = (nodes: NodeDef[]): void => {
    for (const node of nodes) {
      if (node.kind === 'agent' || node.kind === 'judge' || node.kind === 'planner') {
        if (node.harness !== undefined) node.harness = sanitizeSelector(node.harness)
        if (node.kind === 'planner') {
          const original = node.expand
          node.expand = (item) => {
            // planner 可能返回 workflow 模块闭包里缓存的共享数组；必须先克隆再改，
            // 否则本次 dsh-host 的清理会污染后续 profile 运行。
            const expanded = cloneDefinition(original(item))
            visit(expanded)
            return expanded
          }
        }
      } else if (node.kind === 'review') {
        if (node.author.harness !== undefined) node.author.harness = sanitizeSelector(node.author.harness)
        for (const reviewer of node.reviewers) {
          if (reviewer.harness !== undefined) reviewer.harness = sanitizeSelector(reviewer.harness)
        }
      } else if (node.kind === 'loop') {
        visit(node.body)
      } else if (node.kind === 'subflow') {
        visit(node.workflow.nodes)
      }
    }
  }
  visit(workflow.nodes)
}

/** full 自主模式关闭所有评审的人工签字；checkpoints/manual 保持原流程。 */
function sanitizeReviewSignoff(workflow: WorkflowDefinition): void {
  const visit = (nodes: NodeDef[]): void => {
    for (const node of nodes) {
      if (node.kind === 'review') {
        node.humanSignoff = false
      } else if (node.kind === 'loop') {
        visit(node.body)
      } else if (node.kind === 'subflow') {
        visit(node.workflow.nodes)
      } else if (node.kind === 'planner') {
        const original = node.expand
        node.expand = (item) => {
          // 同 sanitizeDshSelectors：共享展开结果不能原地改，否则 full 会污染 manual。
          const expanded = cloneDefinition(original(item))
          visit(expanded)
          return expanded
        }
      }
    }
  }
  visit(workflow.nodes)
}

/**
 * 标准流程 + 唯一 legacy main 的兼容别名。
 *
 * 旧数据常写 `{ id: 'main', path: '.' }` 且没有 defaultBranch，而标准流程按 `app`
 * 引用主仓库。这里只在内存中的运行时配置追加一个 app 别名，原 main 保留、磁盘配置
 * 不改；标准 integration 脚本直接从 `stores.config.repos` 创建 RepoManager，所以
 * 必须改运行时 config，而不是只给 EngineDeps 注入。多仓库或已有 app 时不动。
 */
function applyStandardRepoAlias(space: SpaceHandle, workflow: WorkflowDefinition): void {
  if (workflow.id !== 'taktflow-standard') return
  const repos = space.stores.config.repos
  // 只有“唯一 legacy main”这一种旧数据才补别名。main + 其它仓库时，
  // 不能把主仓库再映射成 app：真实 ID 必须全部保留，多仓库流程自行引用 ID。
  if (!Array.isArray(repos) || repos.length !== 1 || repos.some((repo) => repo.id === 'app')) return
  const legacy = repos.filter((repo) => repo.id === 'main' && (repo.path === '.' || repo.path === './'))
  if (legacy.length !== 1) return
  const main = legacy[0] as RepoBinding & { defaultBranch?: string }
  repos.push({
    ...main,
    id: 'app',
    purpose: main.purpose ?? 'app',
    // 空值交给 repoBindingsForRun 从本地仓库解析真实分支，不能凭空假定 main。
    defaultBranch: typeof main.defaultBranch === 'string' && main.defaultBranch.trim() !== '' ? main.defaultBranch : '',
  })
}

/**
 * 运行使用的仓库绑定：保留全部真实 ID，只补齐旧数据缺省的 defaultBranch。
 *
 * 不再把 main 改名成 app：用户显式配置的 main 必须原样可用，改名会让
 * `[{main,'.'},{app,'repos/app'}]` 变成两个重复 app。标准流程的旧 main 兼容由
 * applyStandardRepoAlias 追加别名完成。
 */
export async function repoBindingsForRun(space: SpaceHandle): Promise<RepoBinding[]> {
  const raw = (space.stores.config.repos ?? []) as Array<RepoBinding & { defaultBranch?: string }>
  const result: RepoBinding[] = []
  for (const repo of raw) {
    const configured = typeof repo.defaultBranch === 'string' ? repo.defaultBranch.trim() : ''
    if (configured !== '') {
      result.push({ ...repo, defaultBranch: configured })
      continue
    }
    // 旧示例常省略 defaultBranch。这里读取本地仓库的真实当前分支，而不是
    // 假定 main：worktree 的 base 会记录实际 SHA，master 等布局也能直接运行。
    const branch = await resolveDefaultBranch(space, repo)
    result.push({ ...repo, defaultBranch: branch })
  }
  return result
}

const execFileAsync = promisify(execFile)

async function gitOutput(dir: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout: 5_000, maxBuffer: 1024 * 1024 })
    const text = stdout.trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** 本地仓库取当前分支；分离 HEAD 时只有唯一本地分支才可采用，否则明确拒绝。 */
async function resolveDefaultBranch(
  space: SpaceHandle,
  repo: RepoBinding & { defaultBranch?: string },
): Promise<string> {
  const source = repo.url === undefined
    ? resolve(space.root, repo.path)
    : join(space.stores.taktDir, 'repos', repo.id)
  if (repo.url === undefined) {
    const current = await gitOutput(source, ['symbolic-ref', '--short', 'HEAD'])
    if (current !== undefined) return current
  } else {
    // 远端仓库只在镜像已存在时读取 origin/HEAD；未同步前无法可靠判断，明确要求配置。
    const remote = await gitOutput(source, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (remote !== undefined && remote.startsWith('origin/')) return remote.slice('origin/'.length)
    const refs = (await gitOutput(source, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']))?.split('\n') ?? []
    const branches = refs.filter((ref) => ref !== '' && ref !== 'origin/HEAD')
    if (branches.length === 1) return branches[0]!
  }
  // 分离 HEAD 或远端镜像不可读时，只在恰好一个本地分支时采用它。
  const local = (await gitOutput(source, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))?.split('\n') ?? []
  const branches = local.filter((ref) => ref !== '')
  if (branches.length === 1) return branches[0]!
  throw new TaktToolError(
    'TAKT_UNSUPPORTED_NODE',
    `仓库 ${repo.id} 未配置 defaultBranch，且无法从仓库确定唯一默认分支`,
    '在 takt.config.json 的 repos 里补 defaultBranch（例如 main 或 master）后重新运行。',
  )
}

/**
 * full 模式的运行参数规范化。
 *
 * core 的 configureReviews 让 args.review / args.reviews 的优先级高于工作流定义，
 * 因此只在 workflow 上关闭 humanSignoff 不够：调用方显式传 true 会重新打开人工
 * 签字。这里克隆并强制两层 humanSignoff=false，保留 maxRounds/maxReworks 等其它
 * 字段；checkpoints/manual 原样返回。动态节点键也一并覆盖。
 */
export function prepareRunArgs(args: Record<string, unknown>, autonomy: Autonomy): Record<string, unknown> {
  if (autonomy !== 'full') return args
  const next: Record<string, unknown> = { ...args }
  const force = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return { ...(value as Record<string, unknown>), humanSignoff: false }
  }
  if (next.review !== undefined) next.review = force(next.review)
  if (next.reviews !== undefined && next.reviews !== null && typeof next.reviews === 'object' && !Array.isArray(next.reviews)) {
    next.reviews = Object.fromEntries(
      Object.entries(next.reviews as Record<string, unknown>).map(([nodeId, value]) => [nodeId, force(value)]),
    )
  }
  return next
}

/**
 * 与 CLI knowledgeFromConfig 相同的知识源组合；错误配置拒绝执行，不降级为空数组。
 * 自定义远端源沿用 knowledge 包本身的不可用语义。
 */
export function knowledgeForRun(space: SpaceHandle): KnowledgeSource[] {
  const { stores } = space
  if (stores.config.knowledge === undefined) {
    // 默认源要覆盖新布局：requirements/ 下的需求物料与 knowledge/ 的 Wiki。
    // grep 源本身扫空间根，但 workspace 源只认 taktDir/workspaces；这里补一个
    // requirements 维度的 Markdown 源，避免新布局的需求文档检索不到。
    const sources = createDefaultSources({
      projectDir: space.root,
      taktDir: stores.taktDir,
      wikiDir: stores.paths.knowledge,
    })
    const requirements = createWikiSource({ root: stores.paths.requirements })
    sources.push({
      ...requirements,
      id: 'requirements',
      describe: () => `需求物料 Markdown：${stores.paths.requirements}`,
    })
    return sources
  }
  const seen = new Set<string>()
  return stores.config.knowledge.map(({ id, kind, options = {} }) => {
    if (!id || seen.has(id)) throw new Error(`知识源 ID 为空或重复：${id}`)
    seen.add(id)
    const path = (key: string, fallback: string): string => {
      const value = options[key] ?? fallback
      if (typeof value !== 'string' || !value.trim()) throw new Error(`知识源 ${id} 的 ${key} 必须是非空路径`)
      return resolve(space.root, value)
    }
    const allowed = kind === 'grep' ? ['root', 'ignore'] : kind === 'workspace' ? ['taktDir'] : ['wiki', 'git-history'].includes(kind) ? ['root'] : []
    if (Object.keys(options).some((key) => !allowed.includes(key))) throw new Error(`知识源 ${id} 包含不支持的选项`)
    let source: KnowledgeSource
    switch (kind) {
      case 'grep': {
        const ignore = options.ignore
        if (ignore !== undefined && (!Array.isArray(ignore) || !ignore.every((value) => typeof value === 'string'))) throw new Error(`知识源 ${id} 的 ignore 必须是字符串数组`)
        source = createGrepSource({ root: path('root', space.root), ignore: ignore as string[] | undefined })
        break
      }
      case 'wiki': source = createWikiSource({ root: path('root', 'docs/wiki') }); break
      case 'workspace': source = createWorkspaceSource({ taktDir: path('taktDir', stores.taktDir) }); break
      case 'git-history': source = createGitHistorySource({ root: path('root', space.root) }); break
      case 'codegraph': source = createCodeGraphSource(); break
      case 'database': source = createDatabaseSource(); break
      case 'api-registry': source = createApiRegistrySource(); break
      default: throw new Error(`未知知识源类型：${kind}`)
    }
    return { ...source, id, query: async (query) => (await source.query(query)).map((hit) => ({ ...hit, sourceId: id })) }
  })
}

function cloneDefinition<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneDefinition) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneDefinition(child)])) as T
  return value
}

function identity(runtime: RunRuntime): RuntimeIdentity {
  // 只存摘要，不把模型连接的凭据复制进运行目录。函数字段也参与 workflow 身份。
  const workflow = JSON.parse(JSON.stringify(runtime.workflow, (_key, value: unknown) => typeof value === 'function' ? { functionSource: value.toString() } : value)) as unknown
  return {
    version: 2,
    hasFunctions: containsFunction(runtime.workflow),
    config: sha256(canonicalJson(runtime.space.stores.config)),
    profiles: sha256(canonicalJson(runtime.profiles)),
    profileSources: sha256(canonicalJson(runtime.profileSources)),
    roleSkills: sha256(canonicalJson(runtime.roleSkills)),
    workflow: sha256(canonicalJson(workflow)),
    autonomy: runtime.autonomy,
    roleHarness: runtime.roleHarness,
  }
}

function containsFunction(value: unknown): boolean {
  if (typeof value === 'function') return true
  return value !== null && typeof value === 'object' && Object.values(value).some(containsFunction)
}

function runtimeFile(space: SpaceHandle, runId: string): string {
  return join(space.stores.taktDir, 'runs', assertRunId(runId), 'dsh-runtime.json')
}

/** runs.create 装饰器调用；调度前保存身份，写失败不能发布 runId。 */
export async function recordRuntimeIdentity(runtime: RunRuntime, runId: string): Promise<void> {
  const file = runtimeFile(runtime.space, runId)
  await assertNoSymlinks(runtime.space.stores.taktDir, file)
  await writeFileAtomic(file, JSON.stringify(identity(runtime)))
}

/** 重启恢复时调用；无法证明配置和可执行流程一致就拒绝，绝不热替换旧运行。 */
export async function assertRuntimeIdentity(runtime: RunRuntime, runId: string): Promise<void> {
  const file = runtimeFile(runtime.space, runId)
  await assertNoSymlinks(runtime.space.stores.taktDir, file)
  const saved = await readJsonFile<RuntimeIdentity>(file)
  // 函数源码相同不能证明闭包或外部依赖相同；P0 不据此恢复新进程执行。
  if (saved?.hasFunctions || containsFunction(runtime.workflow)) {
    throw new TaktToolError('TAKT_RUN_BUSY', '当前版本不能在新宿主恢复包含函数的流程', '在原宿主继续等待中的运行；原宿主已退出时，请取消旧运行并重新启动。')
  }
  if (!saved || canonicalJson(saved) !== canonicalJson(identity(runtime))) {
    throw new TaktToolError('TAKT_RUN_BUSY', '运行配置、角色或流程与开始时不一致，不能恢复', '恢复原配置及插件版本，或重新启动一个运行。')
  }
}
