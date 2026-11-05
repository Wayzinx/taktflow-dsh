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
    const root = realpathSync.native(this.options.spaceRoot?.(copy) ?? copy.cwd)
    Object.freeze(copy.nodeRef)
    Object.freeze(copy.writeScope)
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
 * 工具契约来自 dsh-tool-fs@0.2.1-rc.3（write/edit.file_path）及
 * dsh-tool-working-directory@0.2.1-rc.3（working_directory.cd）。
 */
export function createWriteGuard(registry: PermissionRegistry, options: WriteGuardOptions = {}): ToolGuard {
  return (exec) => {
    if (!exec.agent) return undefined
    const scope = registry.lookup(exec.agent.id)
    if (!scope) return undefined
    const args = exec.arguments && typeof exec.arguments === 'object'
      ? exec.arguments as Record<string, unknown> : undefined
    const target = typeof args?.file_path === 'string' ? args.file_path : '(缺少 file_path)'
    const denialRoot = (): string | undefined => {
      if (registry instanceof InMemoryPermissionRegistry) return registry.spaceRoot(scope.childId)
      try { return realpathSync.native(scope.cwd) } catch { return undefined }
    }
    const deny = (reason: string, attempted = target, denialPath?: string) => {
      const root = denialRoot()
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
      return `拒绝 ${exec.name}：目标 ${JSON.stringify(attempted)}；${reason}。允许的写入范围（相对空间根）：${scope.writeScope.join(', ') || '(无)'}。`
    }
    const filePath = typeof args?.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
    if (exec.name === 'working_directory') {
      // 全局工具会继承到子 Agent；禁止动态 cwd 与已登记 cwd 脱节形成旁路。
      return args && 'cd' in args ? deny('节点执行期间不能切换工作目录', String(args.cd), String(args.cd)) : undefined
    }
    if (exec.name === 'bash' || exec.name === 'pwsh') {
      return scope.allowBash ? undefined : deny('该节点不允许 shell', exec.name)
    }
    if (exec.name !== 'write' && exec.name !== 'edit') return undefined
    if (scope.readOnly || scope.writeScope.length === 0) return deny('该节点为只读', target, filePath)
    if (typeof args?.file_path !== 'string' || !args.file_path.trim()) return deny('file_path 必须是非空路径')
    try {
      const root = registry instanceof InMemoryPermissionRegistry
        ? registry.spaceRoot(scope.childId) : realpathSync.native(scope.cwd)
      if (!root) return deny('空间根不可确认', target, filePath)
      const cwd = realpathSync.native(scope.cwd)
      if (!within(root, cwd)) return deny('节点工作目录不在空间根内', target, filePath)
      const absolute = path.isAbsolute(args.file_path) ? args.file_path : `${cwd}${path.sep}${args.file_path}`
      const resolved = physicalPath(absolute)
      if (!within(root, resolved)) return deny('实际目标位于空间根之外', target, filePath)
      const relative = path.relative(root, resolved).split(path.sep).join('/')
      if (!relative || !scope.writeScope.some((pattern) => matchGlob(pattern, relative))) {
        return deny(`实际目标 ${JSON.stringify(relative || '.')} 不在写入范围内`, target, filePath)
      }
      return undefined
    } catch {
      return deny('无法安全解析目标路径', target, filePath)
    }
  }
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
