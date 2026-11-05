import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertRunId, canonicalJson, openProject, parseFrontmatter, sha256,
  type AgentProfile, type HarnessSelector, type KnowledgeSource, type WorkflowDefinition,
} from '@taktflow/core'
import {
  createApiRegistrySource, createCodeGraphSource, createDatabaseSource, createDefaultSources,
  createGitHistorySource, createGrepSource, createWikiSource, createWorkspaceSource,
} from '@taktflow/knowledge'
import { assertNoSymlinks, readJsonFile, writeFileAtomic } from '../../vendor/taktflow/packages/core/src/store/fs-utils.js'
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
 * 失败直接交给调用方，尤其不能把 allowBash:true 静默丢掉。
 */
export async function loadRunProfiles(space: SpaceHandle): Promise<Record<string, AgentProfile>> {
  const dir = join(space.stores.taktDir, 'agents')
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const result: Record<string, AgentProfile> = Object.create(null)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const { data, body } = parseFrontmatter(await readFile(join(dir, entry.name), 'utf8'))
    const text = (key: string, fallback: string): string => typeof data[key] === 'string' && data[key] !== '' ? data[key] : fallback
    const list = (key: string): string[] => {
      const value = data[key]
      if (value === undefined) return []
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`角色 ${entry.name} 的 ${key} 必须是字符串数组`)
      return [...value] as string[]
    }
    const role = text('role', entry.name.slice(0, -3))
    const harness = typeof data.harness === 'string' ? { harness: data.harness } : data.harness ?? space.stores.config.roles?.[role]
    if (!harness || typeof harness !== 'object' || typeof (harness as HarnessSelector).harness !== 'string') throw new Error(`角色 ${role} 缺少 harness`)
    if (data.allowBash !== undefined && typeof data.allowBash !== 'boolean') throw new Error(`角色 ${role} 的 allowBash 必须是 boolean`)
    if (Object.hasOwn(result, role)) throw new Error(`角色名称冲突：${role}`)
    result[role] = {
      role, title: text('title', role), description: text('description', ''),
      instructions: body.trim(), harness: structuredClone(harness as HarnessSelector),
      skills: list('skills'), writeScope: list('writeScope'), allowBash: data.allowBash === true,
      ...(data.readScope === undefined ? {} : { readScope: list('readScope') }),
    }
  }
  return result
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
