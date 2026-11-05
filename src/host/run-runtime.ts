import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertRunId, canonicalJson, openProject, parseFrontmatter, sha256,
  type AgentProfile, type HarnessSelector, type KnowledgeSource, type WorkflowDefinition,
  assertNoSymlinks, readJsonFile, writeFileAtomic,
} from '@taktflow/core'
import {
  createApiRegistrySource, createCodeGraphSource, createDatabaseSource, createDefaultSources,
  createGitHistorySource, createGrepSource, createWikiSource, createWorkspaceSource,
} from '@taktflow/knowledge'
import { BUNDLED_ROLE_FILES } from '../roles/defaults.js'
import { TaktToolError, type SpaceHandle } from './types.js'

/** RunManager 在开始时固定的执行配置；等待审批期间仍复用这一份。 */
export interface RunRuntime {
  space: SpaceHandle
  workflow: WorkflowDefinition
  profiles: Record<string, AgentProfile>
  knowledge: KnowledgeSource[]
}

interface RuntimeIdentity {
  version: 1
  hasFunctions: boolean
  config: string
  profiles: string
  workflow: string
}

/**
 * preset 和 RunManager 共用的角色读取器；按 CLI runtime-profiles 的格式读取。
 *
 * 合并顺序：随包默认角色（analyst/architect/dev/reporter）→ 空间
 * `.takt/agents/*.md`。同名空间文件覆盖默认，用户可以直接改；空间内部出现
 * 同名角色仍然报错。合并结果参与 RunRuntime 的身份摘要和运行冻结。
 *
 * 失败直接交给调用方，尤其不能把 allowBash:true 静默丢掉。
 */
export async function loadRunProfiles(space: SpaceHandle): Promise<Record<string, AgentProfile>> {
  const defaults = Object.create(null) as Record<string, AgentProfile>
  for (const file of BUNDLED_ROLE_FILES) {
    const profile = parseProfile(file.fileName, file.content, space)
    if (Object.hasOwn(defaults, profile.role)) throw new Error(`随包角色名称重复：${profile.role}`)
    defaults[profile.role] = profile
  }

  const dir = join(space.stores.taktDir, 'agents')
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
  }
  return Object.assign(Object.create(null) as Record<string, AgentProfile>, defaults, overrides)
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

/** RunManager 开始时调用；配置来自本次磁盘读取，既有运行不受后续修改影响。 */
export async function loadRunRuntime(space: SpaceHandle, workflow: WorkflowDefinition): Promise<RunRuntime> {
  const current = await openProject(space.root)
  const frozenSpace: SpaceHandle = { ...space, stores: { ...space.stores, config: structuredClone(current.config) } }
  const profiles = await loadRunProfiles(frozenSpace)
  return { space: frozenSpace, workflow: cloneDefinition(workflow), profiles, knowledge: knowledgeForRun(frozenSpace) }
}

/**
 * 与 CLI knowledgeFromConfig 相同的知识源组合；错误配置拒绝执行，不降级为空数组。
 * 自定义远端源沿用 knowledge 包本身的不可用语义。
 */
export function knowledgeForRun(space: SpaceHandle): KnowledgeSource[] {
  const { stores } = space
  if (stores.config.knowledge === undefined) return createDefaultSources({ projectDir: space.root, taktDir: stores.taktDir })
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
  return { version: 1, hasFunctions: containsFunction(runtime.workflow), config: sha256(canonicalJson(runtime.space.stores.config)), profiles: sha256(canonicalJson(runtime.profiles)), workflow: sha256(canonicalJson(workflow)) }
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
