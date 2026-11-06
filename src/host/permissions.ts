import { lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { matchGlob } from '@taktflow/core'
import { agentTraceHubFor, type AgentTraceRecorder } from './agent-trace.js'
import type { ToolGuard } from './dsh-types.js'
import type { PermissionRegistry, PermissionScope } from './types.js'

/** 宿主可提供空间根解析器；当前 core 的节点 cwd 本身就是空间根。 */
export interface PermissionRegistryOptions {
  spaceRoot?: (scope: PermissionScope) => string
}

/** 写权限守卫的扩展点；拒绝记录失败不能改变守卫本身的拒绝结果。 */
export interface WriteGuardOptions {
  denials?: AgentTraceRecorder
}

/** 执行器在发布 childId 前登记；重复身份拒绝，释放幂等且不影响后来的登记。 */
export class InMemoryPermissionRegistry implements PermissionRegistry {
  private readonly scopes = new Map<string, PermissionScope>()
  private readonly roots = new Map<string, string>()

  constructor(private readonly options: PermissionRegistryOptions = {}) {}

  register(scope: PermissionScope): () => void {
    if (this.scopes.has(scope.childId)) throw new Error(`子 Agent ${scope.childId} 已登记权限`)
    const copy = structuredClone(scope)
    // 固定授权时的空间根，不允许调用方随后改数组/对象扩大范围。
    const root = realpathSync.native(copy.spaceRoot ?? this.options.spaceRoot?.(copy) ?? copy.cwd)
    // 新两域 scope 显式提供 spaceRoot；legacy scope 保持 spaceRoot 缺省，守卫走旧语义。
    if (copy.spaceRoot !== undefined) copy.spaceRoot = root
    if (copy.artifactRoot !== undefined) copy.artifactRoot = realpathSync.native(copy.artifactRoot)
    Object.freeze(copy.nodeRef)
    Object.freeze(copy.writeScope)
    if (copy.readScope !== undefined) {
      if (!Array.isArray(copy.readScope)) throw new Error('读取范围必须是 glob 数组')
      // 绝对 glob 永远不能匹配相对候选路径，却可能被目录搜索当成全树授权；登记时拒绝。
      for (const pattern of copy.readScope) {
        if (typeof pattern !== 'string' || pattern.trim() === '') {
          throw new Error('读取范围模式必须是非空字符串')
        }
        const normalized = pattern.split(path.sep).join('/')
        if (normalized.startsWith('/') || path.isAbsolute(pattern)) {
          throw new Error(`读取范围模式必须是相对 glob：${pattern}`)
        }
      }
      Object.freeze(copy.readScope)
    }
    Object.freeze(copy)
    this.scopes.set(copy.childId, copy)
    this.roots.set(copy.childId, root)
    return () => {
      if (this.scopes.get(copy.childId) !== copy) return
      this.scopes.delete(copy.childId)
      this.roots.delete(copy.childId)
    }
  }

  lookup(agentId: string): PermissionScope | undefined { return this.scopes.get(agentId) }

  /** 守卫读取登记时固定的空间根；未登记时不提供默认授权。 */
  spaceRoot(agentId: string): string | undefined { return this.roots.get(agentId) }
}

/** 旧骨架兼容入口；新宿主接线使用 InMemoryPermissionRegistry。 */
export class PlaceholderPermissionRegistry extends InMemoryPermissionRegistry {}

/**
 * 宿主以 ctx.tools.guard 注册的同步守卫；仅处理登记的 childId，路径错误一律拒绝。
 * 工具契约来自 dsh-tool-fs@0.2.2-rc.1（write/edit.file_path）及
 * dsh-tool-working-directory@0.2.2-rc.1（working_directory.cd）。
 */
export function createWriteGuard(registry: PermissionRegistry, options: WriteGuardOptions = {}): ToolGuard {
  return (exec) => {
    if (!exec.agent) return undefined
    const scope = registry.lookup(exec.agent.id)
    if (!scope) return undefined
    const args = exec.arguments && typeof exec.arguments === 'object'
      ? exec.arguments as Record<string, unknown> : undefined
    const target = typeof args?.file_path === 'string' ? args.file_path : '(缺少 file_path)'
    const scopeRoot = (): string | undefined => {
      if (registry instanceof InMemoryPermissionRegistry) return registry.spaceRoot(scope.childId)
      try { return realpathSync.native(scope.spaceRoot ?? scope.cwd) } catch { return undefined }
    }
    const record = (attempted: string, reason: string, denialPath?: string): void => {
      const root = scopeRoot()
      // 显式注入优先；生产由 RunManager 把追溯中心登记到同一权限表，守卫无需改冻结服务面。
      const recorder = options.denials ?? agentTraceHubFor(registry)
      if (recorder !== undefined && root !== undefined) {
        try {
          recorder.recordDenial(root, scope.nodeRef, {
            tool: exec.name,
            ...(denialPath === undefined ? {} : { path: denialPath }),
            reason,
          })
        } catch {
          // 追溯失败不能把“拒绝”变成“放行”。
        }
      }
      void attempted
    }
    const deny = (reason: string, attempted = target, denialPath?: string): string => {
      record(attempted, reason, denialPath)
      const hint = scope.spaceRoot === undefined
        ? `允许的写入范围（相对空间根）：${scope.writeScope.join(', ') || '(无)'}`
        : `允许的写入范围（代码相对 cwd，公共产物相对空间根且仅限当前需求）：${scope.writeScope.join(', ') || '(无)'}`
      return `拒绝 ${exec.name}：目标 ${JSON.stringify(attempted)}；${reason}。${hint}。`
    }
    const denyRead = (reason: string, attempted: string, denialPath?: string): string => {
      record(attempted, reason, denialPath)
      return `拒绝 ${exec.name}：目标 ${JSON.stringify(attempted)}；${reason}。允许的读取范围：${(scope.readScope ?? []).join(', ') || '(无)'}。`
    }
    const filePath = typeof args?.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
    if (exec.name === 'working_directory') {
      // 全局工具会继承到子 Agent；禁止动态 cwd 与已登记 cwd 脱节形成旁路。
      return args && 'cd' in args ? deny('节点执行期间不能切换工作目录', String(args.cd), String(args.cd)) : undefined
    }
    if (exec.name === 'bash' || exec.name === 'pwsh') {
      return scope.allowBash ? undefined : deny('该节点不允许 shell', exec.name)
    }
    if (READ_TOOLS.has(exec.name)) {
      try { return guardRead(exec.name, args, scope, denyRead) } catch {
        return denyRead('无法安全解析目标路径', target)
      }
    }
    if (exec.name !== 'write' && exec.name !== 'edit') return undefined
    if (scope.readOnly || scope.writeScope.length === 0) return deny('该节点为只读', target, filePath)
    if (typeof args?.file_path !== 'string' || !args.file_path.trim()) return deny('file_path 必须是非空路径')
    try {
      const root = scopeRoot()
      if (!root) return deny('空间根不可确认', target, filePath)
      const cwd = realpathSync.native(scope.cwd)
      if (!within(root, cwd)) return deny('节点工作目录不在空间根内', target, filePath)
      const absolute = path.isAbsolute(args.file_path) ? args.file_path : `${cwd}${path.sep}${args.file_path}`
      const resolved = physicalPath(absolute)
      if (!within(root, resolved)) return deny('实际目标位于空间根之外', target, filePath)
      if (scope.spaceRoot === undefined) {
        // 旧版 scope：writeScope 相对空间根，保持既有行为。
        const relative = relativePath(root, resolved)
        if (!relative || !scope.writeScope.some((pattern) => matchGlob(pattern, relative))) {
          return deny(`实际目标 ${JSON.stringify(relative || '.')} 不在写入范围内`, target, filePath)
        }
        return undefined
      }
      // 两域 scope：代码只相对 cwd；公共产物只允许真实 artifactRoot。
      const artifactRoot = scope.artifactRoot === undefined ? undefined : realpathSync.native(scope.artifactRoot)
      const artifactParent = artifactRoot === undefined ? undefined : path.dirname(artifactRoot)
      const requirementsRoot = path.join(root, 'requirements')
      const workspacesRoot = path.join(root, '.takt', 'workspaces')
      if (artifactRoot !== undefined && within(artifactRoot, resolved)) {
        const relative = relativePath(root, resolved)
        if (!relative || !scope.writeScope.some((pattern) => matchGlob(pattern, relative))) {
          return deny(`实际目标 ${JSON.stringify(relative || '.')} 不在当前需求的公共产物写入范围内`, target, filePath)
        }
        return undefined
      }
      // 实际需求目录的父目录就是真实公共产物区（stores.paths 决定布局）；
      // 其下除当前需求外的兄弟目录一律拒绝，不能落入 cwd 代码域。
      if (artifactParent !== undefined && within(artifactParent, resolved)) {
        return deny('公共产物只允许写入当前需求目录', target, filePath)
      }
      // 非本次实际布局的标准公共产物区也不允许借 writeScope 创建第二份产物。
      if (within(requirementsRoot, resolved) || within(workspacesRoot, resolved)) {
        return deny('公共产物只允许写入当前需求目录', target, filePath)
      }
      if (!within(cwd, resolved)) return deny('代码写入必须在当前工作目录内', target, filePath)
      const relative = relativePath(cwd, resolved)
      if (!relative || !scope.writeScope.some((pattern) => matchGlob(pattern, relative))) {
        return deny(`实际目标 ${JSON.stringify(relative || '.')} 不在写入范围内`, target, filePath)
      }
      return undefined
    } catch {
      return deny('无法安全解析目标路径', target, filePath)
    }
  }
}

/** 读取工具集合；dsh-tool-fs 的 read/read_image 与 dsh-tool-fs-search 的 glob/grep。 */
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'list'])
/** 只接受单个文件参数的读取工具；其余按搜索根处理。 */
const FILE_READ_TOOLS = new Set(['read', 'read_image'])

/**
 * 读取范围守卫：只有 scope.readScope 存在时启用。
 * 路径先按物理父目录解析（含 symlink/..），再按 cwd 相对与空间根相对匹配；
 * 目录搜索必须用能覆盖整棵子树的模式（如 `src/**`）证明不会扫到范围外。
 */
function guardRead(
  name: string,
  args: Record<string, unknown> | undefined,
  scope: PermissionScope,
  deny: (reason: string, attempted: string, denialPath?: string) => string,
): string | undefined {
  const patterns = scope.readScope
  if (patterns === undefined) return undefined
  const requested = readRequest(name, args)
  if (requested.error !== undefined) return deny(requested.error, requested.attempted, requested.attempted)
  const cwd = realpathSync.native(scope.cwd)
  const root = realpathSync.native(scope.spaceRoot ?? scope.cwd)
  if (!within(root, cwd)) return deny('节点工作目录不在空间根内', requested.attempted, requested.attempted)
  // 不能先 path.join/normalize：那会把 `missing/..` 折叠掉，绕过物理父目录检查。
  const absolute = path.isAbsolute(requested.path) ? requested.path : `${cwd}${path.sep}${requested.path}`
  let resolved: string
  try { resolved = physicalPath(absolute) } catch { return deny('无法安全解析目标路径', requested.attempted, requested.attempted) }
  if (!within(root, resolved)) return deny('实际目标位于空间根之外', requested.attempted, requested.attempted)
  const candidates = domains(resolved, cwd, root)
  if (FILE_READ_TOOLS.has(name)) {
    if (!matchesAny(patterns, candidates)) {
      return deny(`实际目标 ${JSON.stringify(relativeLabel(candidates))} 不在读取范围内`, requested.attempted, requested.attempted)
    }
    return undefined
  }
  let status: 'file' | 'directory' | 'missing'
  try {
    const stat = statSync(resolved)
    status = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'missing'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    status = 'missing'
  }
  if (status === 'file') {
    if (!matchesAny(patterns, candidates)) {
      return deny(`实际目标 ${JSON.stringify(relativeLabel(candidates))} 不在读取范围内`, requested.attempted, requested.attempted)
    }
    return undefined
  }
  if (!coversAnyTree(patterns, candidates)) {
    return deny(
      `搜索根 ${JSON.stringify(relativeLabel(candidates) || '.')} 的整棵子树不在读取范围内；目录搜索必须使用覆盖整棵树的模式（如 "src/**"）`,
      requested.attempted,
      requested.attempted,
    )
  }
  return undefined
}

function readRequest(
  name: string,
  args: Record<string, unknown> | undefined,
): { path: string; attempted: string; error?: string } {
  if (FILE_READ_TOOLS.has(name)) {
    const value = args?.file_path
    if (typeof value !== 'string' || !value.trim()) {
      return { path: '', attempted: typeof value === 'string' ? value : '(缺少 file_path)', error: 'file_path 必须是非空路径' }
    }
    return { path: value, attempted: value }
  }
  const value = args?.path ?? (name === 'list' ? args?.dir : undefined)
  if (value === undefined || value === null) return { path: '.', attempted: '.' }
  if (typeof value !== 'string') return { path: '', attempted: String(value), error: 'path 必须是字符串' }
  if (!value.trim()) return { path: '.', attempted: '.' }
  return { path: value, attempted: value }
}

/** 目标可能同时落在 cwd 与空间根；两个相对路径都尝试，避免 worktree 内代码漏匹配。 */
function domains(target: string, cwd: string, root: string): Array<{ base: string; relative: string }> {
  const result: Array<{ base: string; relative: string }> = []
  if (within(cwd, target)) result.push({ base: cwd, relative: relativePath(cwd, target) })
  if (root !== cwd && within(root, target)) result.push({ base: root, relative: relativePath(root, target) })
  return result
}

function matchesAny(patterns: readonly string[], candidates: readonly { relative: string }[]): boolean {
  return candidates.some(({ relative }) => relative !== '' && patterns.some((pattern) => matchGlob(pattern, relative)))
}

/** 目录搜索必须证明整棵子树在范围内。 */
function coversAnyTree(patterns: readonly string[], candidates: readonly { relative: string }[]): boolean {
  return candidates.some(({ relative }) => patterns.some((pattern) => coversTree(pattern, relative)))
}

/**
 * 模式以 `/**` 结尾时，目标目录自身或任一祖先匹配去掉 `/**` 的前缀，
 * 就证明该目录下的所有文件都在模式覆盖内（前缀里的 `**` 同样按 glob 匹配）。
 * 绝对模式和空前缀不能当成全树授权，保持 fail closed。
 */
function coversTree(pattern: string, relativeRoot: string): boolean {
  const normalized = pattern.split(path.sep).join('/')
  if (normalized === '**') return true
  if (normalized.startsWith('/') || !normalized.endsWith('/**')) return false
  const prefix = normalized.slice(0, -3)
  if (prefix === '' || prefix.startsWith('/')) return false
  let candidate = relativeRoot
  for (;;) {
    if (matchGlob(prefix, candidate)) return true
    if (candidate === '') return false
    const slash = candidate.lastIndexOf('/')
    candidate = slash === -1 ? '' : candidate.slice(0, slash)
  }
}

function relativeLabel(candidates: readonly { relative: string }[]): string {
  return candidates[0]?.relative ?? ''
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** 与 dsh-fs-local 的 POSIX 物理 .. 保持一致，不能先 path.resolve 或用非 native realpath。 */
function physicalPath(absolute: string): string {
  let current = absolute
  const missing: string[] = []
  for (;;) {
    try {
      const existing = realpathSync.native(current)
      if (missing.length && !statSync(existing).isDirectory()) throw new Error('目标父路径不是目录')
      if (missing.includes('..')) throw new Error('父级穿越不存在的目录')
      return path.join(existing, ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // 悬空符号链接不能作为普通的尚不存在文件放行。
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('目标包含悬空符号链接')
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}
