import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isBuiltin, registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { validateWorkflow, type WorkflowDefinition } from '@taktflow/core'

/**
 * 插件随包提供的 Node 运行时库。
 *
 * 空间流程可以 import 这些 `@taktflow/*` 包；loader 统一解析到插件自己的打包产物，
 * 保证 core 单例、也不要求用户空间安装 taktflow。web/cli 是程序入口而非运行时库，
 * 不在支持范围。
 */
const RUNTIME_PACKAGES = ['core', 'sandbox', 'harness', 'knowledge', 'server', 'workflow-source'] as const
type RuntimePackage = typeof RUNTIME_PACKAGES[number]
const PACKAGE_MODULES = new Map<string, RuntimePackage>(
  RUNTIME_PACKAGES.map((name) => [`@taktflow/${name}`, name]),
)
/** 冻结版本放在 URL 查询串里；module hook 按它找回当时快照。 */
const VERSION_PARAM = 'taktv'
/** 允许进入闭包的文件类型；JSON 等资源不在闭包承诺内，明确拒绝。 */
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.js', '.mjs'])

export interface WorkflowLoaderOptions {
  /** `lib/core.js` 的绝对路径；缺省按宿主 bundle 位置推断，推断不到时交给 Node 解析。 */
  coreEntry?: string
  /** `lib/sandbox.js` 的绝对路径。 */
  sandboxEntry?: string
  /** 其余随包运行时库入口；缺省按宿主 bundle 位置推断。 */
  packageEntries?: Partial<Record<RuntimePackage, string>>
}

/** 一次加载的结果；files 是参与哈希的完整依赖闭包。 */
export interface LoadedWorkflowFile {
  file: string
  workflow: WorkflowDefinition
  files: string[]
  hash: string
}

interface CacheEntry {
  version: string
  workflow: WorkflowDefinition
  files: string[]
}

/** 一条冻结的解析边；运行时只按边表查目标，不再访问磁盘。 */
type ResolutionEdge =
  | { kind: 'file'; file: string }
  | { kind: 'package'; name: RuntimePackage }
  | { kind: 'builtin' }

/** 冻结快照：先完整读取、解析并哈希闭包，再用同一份源码和边表求值。 */
interface Snapshot {
  version: string
  entry: string
  files: Map<string, string>
  /** importer 绝对路径 → specifier → 冻结目标。 */
  edges: Map<string, Map<string, ResolutionEdge>>
  /** 本快照构造时的随包入口；不同 bundle 的版本互不串用。 */
  packageUrls: Partial<Record<RuntimePackage, string>>
}

/** 本插件产物的运行时入口；按 root 限定作用范围，避免全局抢占其它插件。 */
interface RuntimeBinding {
  root: string
  packageUrls: Partial<Record<RuntimePackage, string>>
}

/**
 * 进程级加载状态。Node 的 module hook 是进程级的，不能按 loader 实例隔离；
 * 版本号由闭包内容 + 运行时入口决定，因此两个 loader/两个 service 看到同一路径时
 * 共享同一份冻结源码，而不是依赖各自的计数器。不同 core/sandbox 入口会得到不同
 * 版本，第二个 loader 不会命中第一个 loader 的模块。
 *
 * 用 `Symbol.for` 挂在 globalThis：插件 reload 或同一进程装入两份 bundle 时，
 * 模块级变量各自独立，但 hook 与快照表必须共享；否则第一份 bundle 安装的 hook
 * 看不到第二份 bundle 登记的版本，会把合法的 taktv URL 当成快照丢失。
 */
const LOADER_STATE_KEY = Symbol.for('taktflow.workflow.loader.state')

interface LoaderState {
  snapshots: Map<string, Snapshot>
  runtimeBindings: RuntimeBinding[]
  hooksInstalled: boolean
}

const state: LoaderState = (() => {
  const existing = (globalThis as Record<symbol, unknown>)[LOADER_STATE_KEY]
  if (isLoaderState(existing)) return existing
  const created: LoaderState = { snapshots: new Map(), runtimeBindings: [], hooksInstalled: false }
  Object.defineProperty(globalThis, LOADER_STATE_KEY, {
    value: created,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return created
})()

function isLoaderState(value: unknown): value is LoaderState {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<LoaderState>
  return candidate.snapshots instanceof Map
    && Array.isArray(candidate.runtimeBindings)
    && typeof candidate.hooksInstalled === 'boolean'
}

const snapshots = state.snapshots
/** 已登记的插件运行时根；同一进程可有多个 loader/多份 bundle。 */
const runtimeBindings = state.runtimeBindings

/**
 * 空间 `.workflow.ts` 加载器。
 *
 * 调用方：WorkflowCatalog 在 start/status 时按空间配置加载。
 * 时机：每次 load 先 snapshot 整个依赖闭包（源文本 + 解析边）并计算内容哈希；
 * 未变化直接复用，变化则用新的 `taktv=<hash>` URL 重新求值。运行开始时 RunManager
 * 复制流程定义，之后的磁盘变化不会影响已经启动的运行。
 * 失败语义：语法/导出/validateWorkflow 错误原样上抛；变量动态 import、非字面量
 * 模块名、未打包的 `@taktflow/*` 包、第三方裸包、闭包外相对依赖和带查询串的本地
 * 路径都明确失败，不静默降级到另一份模块。
 *
 * 为什么需要 module hook：宿主是 Node 24，原生支持 strip TS，但模板 import 写
 * `./x.js` 而磁盘是 `./x.ts`，并且 `@taktflow/core` 必须解析到插件打包的同一份
 * 模块。hook 只处理带 `taktv` 的 URL 和本插件 lib 根下的 `@taktflow/*`，不会影响
 * 同进程其它插件的 TS 导入。
 */
export class WorkflowFileLoader {
  private readonly cache = new Map<string, CacheEntry>()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly packageUrls: Partial<Record<RuntimePackage, string>>

  constructor(options: WorkflowLoaderOptions = {}) {
    const entries: Partial<Record<RuntimePackage, string>> = { ...options.packageEntries }
    if (options.coreEntry !== undefined) entries.core = options.coreEntry
    if (options.sandboxEntry !== undefined) entries.sandbox = options.sandboxEntry
    // 入口保留宿主实际加载到的 URL 形态（dsh 的 asar/boot 包装或 Node
    // --preserve-symlinks 都可能让宿主模块停在 logical 路径）；再登记一份
    // canonical 物理别名，只用于匹配另一形态的 parentURL。不能只留 canonical：
    // workflow 的 @taktflow/core 会解析到物理路径，而宿主 core 仍在 logical 路径，
    // 同一文件被 Node 当成两个模块，出现两份 core。
    const loadedUrls: Partial<Record<RuntimePackage, string>> = {}
    const canonicalUrls: Partial<Record<RuntimePackage, string>> = {}
    for (const name of RUNTIME_PACKAGES) {
      const entry = entries[name] ?? findBundledEntry(name)
      if (entry === undefined) continue
      loadedUrls[name] = pathToFileURL(entry).href
      canonicalUrls[name] = pathToFileURL(canonical(entry)).href
    }
    this.packageUrls = loadedUrls
    // 即使只跑 P0 演示流程，core 也会动态 import('@taktflow/sandbox')；hook 必须
    // 在 loader 构造时登记，不能等第一次空间 workflow load 才安装。
    registerRuntimeBinding(loadedUrls, canonicalUrls)
  }

  /** 串行加载，避免并发闭包扫描/求值串扰；失败不会卡住后续加载。 */
  load(file: string): Promise<LoadedWorkflowFile> {
    const operation = this.tail.then(() => this.loadOnce(file), () => this.loadOnce(file))
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  /** 诊断用：已缓存的依赖闭包。 */
  cachedFiles(file: string): readonly string[] | undefined {
    return this.cache.get(canonical(file))?.files
  }

  private async loadOnce(file: string): Promise<LoadedWorkflowFile> {
    const absolute = canonical(file)
    const snapshot = snapshotClosure(absolute, this.packageUrls)
    const cached = this.cache.get(absolute)
    if (cached !== undefined && cached.version === snapshot.version) {
      return { file: absolute, workflow: cached.workflow, files: [...cached.files], hash: snapshot.version }
    }
    // 先登记快照再求值：workflow 回调里延迟 import('./helper.js') 也要命中同一版本。
    snapshots.set(snapshot.version, snapshot)
    const url = pathToFileURL(absolute)
    url.searchParams.set(VERSION_PARAM, snapshot.version)
    const module = await import(url.href) as { default?: unknown }
    const workflow = module.default
    validateWorkflow(workflow)
    const files = [...snapshot.files.keys()].sort()
    this.cache.set(absolute, { version: snapshot.version, workflow, files })
    return { file: absolute, workflow, files, hash: snapshot.version }
  }
}

/**
 * 登记一份插件运行时入口并安装进程级 hook。
 *
 * 调用方：WorkflowFileLoader 构造时。
 * 时机：Node 的 module hook 只能安装一次，之后所有 loader 只追加各自的 root；
 * 解析时按 parentURL 是否落在某个 root 内选择入口，而不是全局 first-wins。
 * 失败语义：不抛错；没有对应入口时交给 Node 自身解析。
 */
function registerRuntimeBinding(
  loadedUrls: Partial<Record<RuntimePackage, string>>,
  canonicalUrls: Partial<Record<RuntimePackage, string>>,
): void {
  // 同一入口登记 logical 与 physical 两个 root：--preserve-symlinks 下宿主 chunk
  // 的 parentURL 是 logical，默认解析下是 physical；两边都必须能命中，但各自
  // 解析到与自身模块图一致的入口 URL，避免同一文件出现两份模块实例。
  const roots = new Map<string, Partial<Record<RuntimePackage, string>>>()
  for (const urls of [loadedUrls, canonicalUrls]) {
    for (const name of RUNTIME_PACKAGES) {
      const url = urls[name]
      if (url === undefined) continue
      const root = path.dirname(fileURLToPath(url))
      const current = roots.get(root) ?? {}
      // loaded 形态优先；canonical 只补该 root 下缺失的入口。
      if (current[name] === undefined) current[name] = url
      roots.set(root, current)
    }
  }
  for (const [root, urls] of roots) {
    // 混合入口（例如测试显式给 canonical coreEntry）时，缺失项回退到 loaded 形态，
    // 保证该 root 下 core 动态 import 的 sandbox 等仍能解析。
    for (const name of RUNTIME_PACKAGES) {
      if (urls[name] !== undefined) continue
      const fallback = loadedUrls[name] ?? canonicalUrls[name]
      if (fallback !== undefined) urls[name] = fallback
    }
    // 同一 root 多次登记（reload/两个 service）合并最新入口；版本快照仍各自携带
    // 构造时的入口表，不受这里覆盖影响。
    const existing = runtimeBindings.find((binding) => binding.root === root)
    if (existing !== undefined) {
      existing.packageUrls = { ...existing.packageUrls, ...urls }
    } else {
      runtimeBindings.push({ root, packageUrls: { ...urls } })
    }
  }
  if (state.hooksInstalled) return
  state.hooksInstalled = true
  installHooks()
}

/** 安装一次进程级 hook；所有解析都先看 parentURL 版本/root，再做受控映射。 */
function installHooks(): void {
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const version = versionOf(context.parentURL)
      if (version !== undefined) {
        const snapshot = snapshots.get(version)
        if (snapshot === undefined) throw new Error(`空间流程依赖快照已丢失：${version}`)
        const parent = parentFilePath(context.parentURL)
        if (parent === undefined) throw new Error(`空间流程依赖的父模块不是文件 URL：${context.parentURL ?? ''}`)
        const edges = snapshot.edges.get(parent)
        if (edges === undefined) {
          throw new Error(`空间流程依赖的父模块不在冻结闭包内：${parent}`)
        }
        const edge = edges.get(specifier)
        if (edge === undefined) {
          throw new Error(`空间流程引用了未冻结的模块：${specifier}（来自 ${parent}）`)
        }
        switch (edge.kind) {
          case 'file':
            return versionedUrl(edge.file, version)
          case 'package': {
            const url = snapshot.packageUrls[edge.name]
            if (url === undefined) throw new Error(`空间流程引用了 @taktflow/${edge.name}，但插件未打包该入口`)
            return { url, shortCircuit: true }
          }
          case 'builtin':
            return nextResolve(specifier, context)
        }
      }
      // 非冻结模块（插件自己的 runtime/chunk）：只在本插件 lib 根内把已打包的
      // @taktflow/* 映射到该 root 的随包入口；其它 import 原样交给 Node。
      const runtimePackage = PACKAGE_MODULES.get(specifier)
      if (runtimePackage !== undefined) {
        const binding = runtimeForParent(context.parentURL)
        if (binding !== undefined) {
          const url = binding.packageUrls[runtimePackage]
          if (url !== undefined) return { url, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    },
    load: (url, context, nextLoad) => {
      const parsed = new URL(url)
      const version = parsed.searchParams.get(VERSION_PARAM)
      if (version !== null) {
        const snapshot = snapshots.get(version)
        if (snapshot === undefined) throw new Error(`空间流程依赖快照已丢失：${version}`)
        const file = fileURLToPath(parsed)
        const source = snapshot.files.get(file)
        if (source === undefined) throw new Error(`空间流程加载了未冻结的模块：${file}`)
        // .ts 必须显式用 module-typescript：带查询串的 URL 不会自动按扩展名擦除
        // 类型，返回普通 module 会把 `type Foo` 留给 V8 报语法错误。
        return {
          format: path.extname(file) === '.ts' ? 'module-typescript' : 'module',
          source,
          shortCircuit: true,
        }
      }
      return nextLoad(url, context)
    },
  })
}

/**
 * 完整快照依赖闭包：读取全部源文本、解析 AST、冻结每条解析边并计算内容哈希。
 * 求值阶段只使用这里的 `files`/`edges`，不再 exists/stat/realpath 磁盘。
 */
function snapshotClosure(entry: string, packageUrls: Partial<Record<RuntimePackage, string>>): Snapshot {
  if (!existsSync(entry)) throw new Error(`空间流程入口不存在：${entry}`)
  const files = new Map<string, string>()
  const edges = new Map<string, Map<string, ResolutionEdge>>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.has(file)) continue
    const source = readFileSync(file, 'utf8')
    files.set(file, source)
    const fileEdges = new Map<string, ResolutionEdge>()
    edges.set(file, fileEdges)
    for (const specifier of scanSpecifiers(source, file)) {
      if (fileEdges.has(specifier)) continue
      const edge = resolveSpecifier(file, specifier)
      fileEdges.set(specifier, edge)
      if (edge.kind === 'file') {
        if (!SUPPORTED_EXTENSIONS.has(path.extname(edge.file))) {
          throw new Error(`空间流程依赖类型不受支持：${edge.file}；只允许 .ts/.js/.mjs`)
        }
        queue.push(edge.file)
      }
    }
  }
  const hash = createHash('sha256')
  // 入口和全部运行时入口都参与哈希：同一份源码配不同 bundle 必须得到不同版本，
  // 否则第二个 loader 会命中第一个 loader 的模块。
  hash.update(entry)
  hash.update('\0')
  for (const name of RUNTIME_PACKAGES) {
    hash.update(name)
    hash.update('\0')
    hash.update(packageUrls[name] ?? '')
    hash.update('\0')
  }
  for (const file of [...files.keys()].sort()) {
    hash.update(file)
    hash.update('\0')
    hash.update(files.get(file)!)
    hash.update('\0')
    const fileEdges = edges.get(file)!
    for (const [specifier, edge] of [...fileEdges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(specifier)
      hash.update('\0')
      hash.update(edge.kind)
      hash.update('\0')
      hash.update(edge.kind === 'file' ? edge.file : '')
      hash.update('\0')
    }
  }
  return { version: hash.digest('hex'), entry, files, edges, packageUrls: { ...packageUrls } }
}

/**
 * 用 TypeScript AST 提取真实模块引用。
 *
 * 覆盖：`import`、`export ... from`、字面量 `import(...)`；跳过 type-only 导入/导出。
 * 注释、普通字符串、正则和 prompt 示例里的 `import` 不会误报；模板表达式里的
 * `import('./helper.js')` 会正常收集。非字面量动态 import 明确拒绝，避免留下
 * 无法冻结的运行时路径。
 */
function scanSpecifiers(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file) === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Node 24 只擦除声明级 `import type`；`import { type X }` 仍保留 import 语句
      // 并解析模块，因此这里只跳过 clause.isTypeOnly，不能把内联 type 当成无依赖。
      if (!node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isExportDeclaration(node)) {
      // 同理，只有 `export type ... from` 会被擦除；`export { type X } from` 仍解析。
      if (!node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments.length === 1 ? unwrapParens(node.arguments[0]!) : undefined
      if (argument === undefined || !ts.isStringLiteralLike(argument)) {
        throw new Error(
          `空间流程 ${file} 含非字面量动态 import，无法冻结依赖闭包；请改成字面量路径或静态 import`,
        )
      }
      specifiers.push(argument.text)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

/** `import(('./x.js'))` 仍是静态可解析的，但变量/拼接/模板插值一律拒绝。 */
function unwrapParens(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

/**
 * 解析一条 specifier 到冻结目标；这是唯一允许访问磁盘的解析阶段。
 * 相对路径、绝对路径和 file: URL 进入闭包；node 内置放行；两个随包 @taktflow
 * 入口单独标记；其它裸包和带查询串的本地路径明确拒绝。
 */
function resolveSpecifier(parent: string, specifier: string): ResolutionEdge {
  if (specifier.startsWith('.')) return resolveFileEdge(parent, specifier)
  if (specifier.startsWith('file:')) {
    let parsed: URL
    try {
      parsed = new URL(specifier)
    } catch {
      throw new Error(`空间流程含非法 file: URL：${specifier}（来自 ${parent}）`)
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`空间流程不允许带查询串/fragment 的本地依赖：${specifier}（来自 ${parent}）`)
    }
    if (parsed.protocol !== 'file:') {
      throw new Error(`空间流程只允许 file: URL 本地依赖：${specifier}（来自 ${parent}）`)
    }
    return resolveFileEdge(parent, fileURLToPath(parsed))
  }
  if (path.isAbsolute(specifier)) return resolveFileEdge(parent, specifier)
  const runtimePackage = PACKAGE_MODULES.get(specifier)
  if (runtimePackage !== undefined) return { kind: 'package', name: runtimePackage }
  if (specifier.startsWith('@taktflow/')) {
    throw new Error(
      `空间流程引用了插件未提供的 @taktflow 包：${specifier}（来自 ${parent}）；` +
      `只支持 ${[...PACKAGE_MODULES.keys()].join('、')}`,
    )
  }
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return { kind: 'builtin' }
  throw new Error(
    `空间流程不允许引用未随插件打包的模块：${specifier}（来自 ${parent}）；` +
    '只允许相对路径、绝对路径、file: URL、已随插件打包的 @taktflow/* 和 node: 内置模块',
  )
}

/** 相对/绝对路径 → 闭包内真实文件；模板按 NodeNext 写 `./x.js`，优先同名 `.ts` 源文件。 */
function resolveFileEdge(parent: string, request: string): ResolutionEdge {
  if (request.includes('?') || request.includes('#')) {
    throw new Error(`空间流程不允许带查询串/fragment 的本地依赖：${request}（来自 ${parent}）`)
  }
  const base = path.isAbsolute(request) ? request : path.resolve(path.dirname(parent), request)
  const candidates: string[] = []
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'), base)
  else if (base.endsWith('.mjs')) candidates.push(base)
  else if (base.endsWith('.ts')) candidates.push(base)
  else candidates.push(`${base}.ts`, `${base}.js`, base)
  const found = candidates.find((candidate) => existsSync(candidate) && !isDirectory(candidate))
  if (found === undefined) throw new Error(`空间流程依赖不存在：${request}（来自 ${parent}）`)
  return { kind: 'file', file: canonical(found) }
}

/** 统一用 realpath：/tmp 与 /private/tmp 等别名必须落成同一个快照键（仅解析阶段使用）。 */
function canonical(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

function versionedUrl(file: string, version: string): { url: string; shortCircuit: true } {
  const url = pathToFileURL(file)
  url.searchParams.set(VERSION_PARAM, version)
  return { url: url.href, shortCircuit: true }
}

function versionOf(parentURL: string | undefined): string | undefined {
  if (parentURL === undefined) return undefined
  try {
    const parsed = new URL(parentURL)
    return parsed.searchParams.get(VERSION_PARAM) ?? undefined
  } catch {
    return undefined
  }
}

/** 从 parentURL 取绝对路径；不调用 realpath，运行时不得访问磁盘。 */
function parentFilePath(parentURL: string | undefined): string | undefined {
  if (parentURL === undefined) return undefined
  try {
    const parsed = new URL(parentURL)
    if (parsed.protocol !== 'file:') return undefined
    parsed.search = ''
    parsed.hash = ''
    return fileURLToPath(parsed)
  } catch {
    return undefined
  }
}

/** 找 parentURL 所属的插件运行时根；精确入口优先，其次最长 root 前缀。 */
function runtimeForParent(parentURL: string | undefined): RuntimeBinding | undefined {
  const parent = parentFilePath(parentURL)
  if (parent === undefined) return undefined
  const exact = runtimeBindings.find((binding) =>
    Object.values(binding.packageUrls).some((url) => url !== undefined && fileURLToPath(url) === parent))
  if (exact !== undefined) return exact
  let match: RuntimeBinding | undefined
  let matchLength = -1
  for (const binding of runtimeBindings) {
    const relative = path.relative(binding.root, parent)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      if (binding.root.length >= matchLength) {
        match = binding
        matchLength = binding.root.length
      }
    }
  }
  return match
}

/** 推断随包入口：先按宿主 bundle 目录，再按源码目录回退；不存在返回 undefined。 */
export function findBundledEntry(name: RuntimePackage | 'workflow-validation-runner'): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, `${name}.js`),
    path.join(here, '..', 'lib', `${name}.js`),
    path.join(here, '..', '..', 'lib', `${name}.js`),
    path.join(here, '..', '..', '..', 'lib', `${name}.js`),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}
