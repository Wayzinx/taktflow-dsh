import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  archiveCaseEvidence,
  assertNoSymlinks,
  assertRunId,
  bindWorkspaceQaCommand,
  captureGitSnapshot,
  diffExecutionAssets,
  executionEvidenceDir,
  newExecutionId,
  readJsonFile,
  selectWorkspaceQaIntegration,
  snapshotExecutionAssets,
  withFileLock,
  writeExecutionReceipt,
  writeFileAtomic,
  matchGlob,
  runShellCommand,
  type ExecutionArchiveResult,
  type ExecutionAssetDiff,
  type ExecutionAssetFile,
  type ExecutionAssetSnapshot,
  type ExecutionGitSnapshot,
  type ExecutionReceiptRef,
  type HarnessRequest,
  type NodeDef,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import { createWriteGuard } from './permissions.js'
import type { HostContext, ToolRunContext } from './dsh-types.js'
import type { Ownership, PermissionRegistry, PermissionScope, SpaceHandle } from './types.js'

/** 受控自测结果尾部的固定上限；core 默认只保留 4KB，这里通过 redact 桥接拿 8KB。 */
export const SELFTEST_TAIL_BYTES = 8192
/** 默认 5 分钟；空间配置只能通过 selftest.timeoutMs 调整，模型不能传。 */
export const SELFTEST_DEFAULT_TIMEOUT_MS = 300_000
/** 防止错误配置把超时设成无限；范围与 e2e 约定一致。 */
export const SELFTEST_MIN_TIMEOUT_MS = 1_000
export const SELFTEST_MAX_TIMEOUT_MS = 3_600_000

/** 可信命令来源；证据和工具结果都原样返回，便于审计。 */
export type SelftestCommandSource =
  | 'run-args:caseCommand'
  | 'run-args:testCommand'
  | 'environment.testCommand'
  | 'quick-fix'
  | 'package-script'

/**
 * 命令作用域：空间根节点使用流程 QA 的 caseCommand；仓库/worktree 节点只使用
 * 仓库自身的 testCommand 或 environment/package 回退。登记时按冻结 cwd 与
 * space.root 的规范路径是否相等判定，不依赖角色名。
 */
export type SelftestCommandScope = 'workspace' | 'repo'

export type SelftestFilterMode = 'all' | 'files' | 'name'

export interface SelftestFilter {
  mode: SelftestFilterMode
  files?: string[]
  name?: string
}

/** 空间配置里的宿主扩展；core 允许未知顶层键，因此不需要改 vendor。 */
export interface SelftestConfig {
  allowedCommands?: string[]
  timeoutMs?: number
}

export interface SelftestCommand {
  text: string
  source: SelftestCommandSource
  hash: string
}

export interface PackageSnapshot {
  exists: boolean
  /** package.json 存在但 JSON 无效时为 true；此时不能信任 scripts。 */
  invalid?: boolean
  scripts?: Record<string, string>
  scriptsHash?: string
  test?: string
}

/** 证据只返回精确 ArtifactRef；不允许写时返回 null 和原因，绝不放宽 scope。 */
export interface SelftestEvidence {
  workspace: string
  path: string
  version: number
}

export interface SelftestResult {
  exitCode: number
  succeeded: boolean
  passed?: number
  failed?: number
  durationMs: number
  outputTail: string
  evidence: SelftestEvidence | null
  evidenceReason?: string
  timedOut: boolean
  cancelled: boolean
  trusted: boolean
  scriptsChanged: boolean
  /** 标准空间 QA 的入口目录树在本次执行期间是否变化；变化即不可信。 */
  executionAssetsChanged?: boolean
  command: string
  commandSource: SelftestCommandSource
  commandHash: string
  filter: SelftestFilter
  startedAt: string
  endedAt: string
}

/** 启动子 Agent 前冻结的上下文；工具执行时不再接受模型提供的命令/cwd/env/timeout。 */
export interface SelftestContextInput {
  childId: string
  space: SpaceHandle
  nodeRef: { runId: string; nodeId: string; attempt: number }
  role: string
  requirementId: string
  cwd: string
  env: Record<string, string>
  writeScope: string[]
  signal: AbortSignal
  sessionId?: string
  workflow?: WorkflowDefinition
  readOnly?: boolean
  allowBash?: boolean
  /** 仅宿主注入：可信自测子进程的产物归因窗口，绑定到同一引擎的 WriteGuard。 */
  withSystemWrites?: <T>(paths: string[], fn: () => Promise<T>) => Promise<T>
}

export interface SelftestRegistration {
  readonly childId: string
  cancel(reason?: unknown): void
  release(): Promise<void>
}

export interface SelftestService {
  register(input: SelftestContextInput): Promise<SelftestRegistration>
  cancel(childId: string, reason?: unknown): void
  drain(childId?: string): Promise<void>
  dispose(): Promise<void>
  run(childId: string, args: unknown, exec: ToolRunContext): Promise<SelftestResult>
}

export interface SelftestServiceOptions {
  permissions: PermissionRegistry
  /** 可信活 Agent 服务；缺失时执行拒绝，不从模型传入身份。 */
  agents?: HostContext['agents']
  ownership?: Ownership
  /** 仅测试替换；生产固定使用 core 的进程组执行器。 */
  runCommand?: typeof runShellCommand
  /** 仅测试替换 package.json 读取；生产读真实文件。 */
  readPackage?: (cwd: string) => Promise<PackageSnapshot>
}

/**
 * 标准流程空间 QA 的实际执行绑定。
 *
 * 权限登记仍使用空间根 cwd；这里只改变可信自测进程的 cwd/命令，避免把
 * 集成 worktree 当成角色权限范围。包脚本基线和源脚本哈希都在登记时冻结。
 */
interface WorkspaceQaExecution {
  cwd: string
  command: string
  commandHash: string
  packageState: string
  packageScriptsHash?: string
  scriptPath?: string
  scriptHash?: string
}

interface FrozenContext extends SelftestContextInput {
  command?: SelftestCommand
  commandError?: string
  execution?: WorkspaceQaExecution
  timeoutMs: number
  packageScripts?: Record<string, string>
  packageScriptsHash?: string
  environmentTestCommand?: string
  packageState: string
  redact: (text: string) => string
  secrets: string[]
}

interface Entry {
  context: FrozenContext
  controller: AbortController
  active: Set<Promise<unknown>>
}

const SAFE_FILTER = /^[\p{L}\p{N} ._/@:+-]+$/u
const RUNNER_ARG_SEPARATOR = /^\s*npm\s+(?:run\s+)?test(?:\s|$)/

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalScripts(scripts: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right)))
  return JSON.stringify(sorted)
}

interface CaseSummarySnapshot {
  path: string
  digest?: string
  cases: Array<{ id: string; status: string; evidence?: string }>
  error?: string
}

/** 只读取当前需求 evidence/summary.json，保留原始用例行供 receipt 关联。 */
async function readCaseSummary(root: string): Promise<CaseSummarySnapshot> {
  const relative = 'evidence/summary.json'
  const file = path.join(root, relative)
  let text: string
  try {
    await assertNoSymlinks(root, file)
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relative, cases: [] }
    return { path: relative, cases: [], error: errorMessage(error) }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const rows = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { cases?: unknown }).cases
      : undefined
    const cases: Array<{ id: string; status: string; evidence?: string }> = []
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
        const item = row as Record<string, unknown>
        if (typeof item.id !== 'string' || item.id === '' || typeof item.status !== 'string') continue
        cases.push({
          id: item.id,
          status: item.status,
          ...(typeof item.evidence === 'string' && item.evidence !== '' ? { evidence: item.evidence } : {}),
        })
      }
    }
    return { path: relative, digest: sha256(text), cases }
  } catch (error) {
    return { path: relative, digest: sha256(text), cases: [], error: `summary 不是有效 JSON：${errorMessage(error)}` }
  }
}

function caseRowsDigest(cases: Array<{ id: string; status: string; evidence?: string }>): string {
  return sha256(JSON.stringify(cases))
}

/** 冻结整个 scripts 映射；dev 合法改依赖不影响，但任何 test/pretest/posttest 变化都会被发现。 */
export async function readPackageSnapshot(cwd: string): Promise<PackageSnapshot> {
  let text: string
  try {
    await assertNoSymlinks(cwd, path.join(cwd, 'package.json'))
    text = await readFile(path.join(cwd, 'package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { exists: true, invalid: true }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { exists: true, invalid: true }
  }
  const raw = (parsed as { scripts?: unknown }).scripts
  if (raw === undefined) return { exists: true, scripts: {}, scriptsHash: sha256('{}') }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { exists: true, invalid: true }
  }
  const scripts: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return { exists: true, invalid: true }
    Object.defineProperty(scripts, name, { value, enumerable: true })
  }
  const test = scripts.test !== undefined && scripts.test.trim() !== '' ? scripts.test : undefined
  return {
    exists: true,
    scripts,
    scriptsHash: sha256(canonicalScripts(scripts)),
    ...(test === undefined ? {} : { test }),
  }
}

/** 只展开宿主环境变量；不接受模型提供的 env，也不执行 shell 展开。 */
export function expandEnvironmentReferences(
  input: Record<string, string> | undefined,
): { env: Record<string, string>; secrets: string[] } {
  const env: Record<string, string> = {}
  const secrets: string[] = []
  for (const [name, value] of Object.entries(input ?? {})) {
    if (typeof value !== 'string') continue
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => { const actual=process.env[key]; if(actual === undefined) throw new Error(`自测环境变量未设置：${key}`); return actual })
    env[name] = expanded
    if (expanded !== '') secrets.push(expanded)
  }
  return { env, secrets }
}

/** 严格解析 selftest 宿主扩展；非法值作为执行时错误返回，不阻断 spec 节点启动。 */
export function parseSelftestConfig(raw: unknown): { config: SelftestConfig; error?: string } {
  if (raw === undefined) return { config: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: {}, error: 'takt.config.json 的 selftest 必须是对象' }
  }
  const value = raw as { allowedCommands?: unknown; timeoutMs?: unknown }
  const config: SelftestConfig = {}
  if (value.allowedCommands !== undefined) {
    if (!Array.isArray(value.allowedCommands)
      || value.allowedCommands.some((item) => typeof item !== 'string' || item.trim() === '')) {
      return { config: {}, error: 'selftest.allowedCommands 必须是非空字符串数组' }
    }
    config.allowedCommands = [...new Set(value.allowedCommands.map((item) => (item as string).trim()))]
  }
  if (value.timeoutMs !== undefined) {
    if (!Number.isInteger(value.timeoutMs)
      || (value.timeoutMs as number) < SELFTEST_MIN_TIMEOUT_MS
      || (value.timeoutMs as number) > SELFTEST_MAX_TIMEOUT_MS) {
      return {
        config: {},
        error: `selftest.timeoutMs 必须是 ${SELFTEST_MIN_TIMEOUT_MS}..${SELFTEST_MAX_TIMEOUT_MS} 的整数`,
      }
    }
    config.timeoutMs = value.timeoutMs as number
  }
  return { config }
}

interface ResolvedCommand {
  command?: SelftestCommand
  error?: string
  timeoutMs: number
  packageScripts?: Record<string, string>
  packageScriptsHash?: string
  environmentTestCommand?: string
}

/**
 * 从冻结的启动参数和空间配置解析命令。
 *
 * run.args 来自 Lead 模型，不能天然受信：只有精确匹配 selftest.allowedCommands、
 * environment.testCommand 或 package test 允许形式时才执行；不匹配时明确拒绝，
 * 绝不静默回退到其它命令。未传命令时 environment.testCommand 优先，其次 quick-fix
 * 固定 npm test，最后才是 package.json 的 test 脚本。
 *
 * scope 缺省为 'workspace'，保留既有调用行为：caseCommand 优先，其次 testCommand。
 * 登记时仓库/worktree 传 'repo'：run.args.caseCommand 是标准流程后续在空间根执行的
 * QA 入口，不是当前仓库的单测命令，因此完全忽略；只接受显式 testCommand（仍需精确
 * 授权），未传时走 environment/package 回退。被忽略的 caseCommand 不是失败后的回退项。
 */
export async function resolveSelftestCommand(
  space: SpaceHandle,
  run: RunState | undefined,
  cwd: string,
  readPackage: (cwd: string) => Promise<PackageSnapshot> = readPackageSnapshot,
  scope: SelftestCommandScope = 'workspace',
): Promise<ResolvedCommand> {
  const rawConfig = (space.stores.config as unknown as { selftest?: unknown }).selftest
  const parsed = parseSelftestConfig(rawConfig)
  if (parsed.error !== undefined) return { error: parsed.error, timeoutMs: SELFTEST_DEFAULT_TIMEOUT_MS }
  const timeoutMs = parsed.config.timeoutMs ?? SELFTEST_DEFAULT_TIMEOUT_MS
  const allowed = parsed.config.allowedCommands ?? []
  const rawEnvironment = (space.stores.config as unknown as {
    environment?: { testCommand?: unknown; env?: Record<string, string> }
  }).environment
  let environmentTestCommand: string | undefined
  if (rawEnvironment?.testCommand !== undefined) {
    if (typeof rawEnvironment.testCommand !== 'string' || rawEnvironment.testCommand.trim() === '') {
      return { error: 'environment.testCommand 必须是非空字符串', timeoutMs }
    }
    environmentTestCommand = rawEnvironment.testCommand.trim()
  }
  let snapshot: PackageSnapshot
  try {
    snapshot = await readPackage(cwd)
  } catch (error) {
    return { error: `读取 package.json 失败：${errorMessage(error)}`, timeoutMs }
  }
  const packageScripts = snapshot.scripts
  const packageScriptsHash = snapshot.scriptsHash
  const packageTest = snapshot.test

  const authorize = (text: string): boolean => {
    if ((text === 'npm test' || text === 'npm run test') && packageTest === undefined) return false
    if (allowed.includes(text)) return true
    if (environmentTestCommand !== undefined && text === environmentTestCommand) return true
    if (packageTest !== undefined && (text === 'npm test' || text === 'npm run test')) return true
    if (packageTest !== undefined && text === packageTest) return true
    return false
  }

  const args = run?.args ?? {}
  // 空间根才把 caseCommand 当作本次自测入口；仓库/worktree 只认显式 testCommand，
  // 避免把流程 QA 的 run-cases 命令误当成仓库单测命令而阻断或覆盖 package test。
  const keys = scope === 'repo' ? ['testCommand'] as const : ['caseCommand', 'testCommand'] as const
  for (const key of keys) {
    if (!Object.hasOwn(args, key)) continue
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: `启动参数 ${key} 必须是非空字符串`, timeoutMs }
    }
    const text = value.trim()
    if (!authorize(text)) {
      return {
        error: `启动参数 ${key} 未受信：命令必须精确匹配 selftest.allowedCommands、environment.testCommand 或 package test 允许形式`,
        timeoutMs,
      }
    }
    return {
      command: { text, source: `run-args:${key}`, hash: sha256(text) },
      timeoutMs,
      ...(packageScripts === undefined ? {} : { packageScripts }),
      ...(packageScriptsHash === undefined ? {} : { packageScriptsHash }),
      ...(environmentTestCommand === undefined ? {} : { environmentTestCommand }),
    }
  }

  const base = {
    timeoutMs,
    ...(packageScripts === undefined ? {} : { packageScripts }),
    ...(packageScriptsHash === undefined ? {} : { packageScriptsHash }),
    ...(environmentTestCommand === undefined ? {} : { environmentTestCommand }),
  }
  if (environmentTestCommand !== undefined) {
    if ((environmentTestCommand === 'npm test' || environmentTestCommand === 'npm run test') && !packageTest) return { ...base, error: 'npm 测试入口需要登记时存在有效的 package.test' }
    return {
      ...base,
      command: { text: environmentTestCommand, source: 'environment.testCommand', hash: sha256(environmentTestCommand) },
    }
  }
  if (run?.workflowId === 'quick-fix' && packageTest !== undefined) {
    const text = 'npm test'
    return { ...base, command: { text, source: 'quick-fix', hash: sha256(text) } }
  }
  if (packageTest !== undefined) {
    const text = 'npm test'
    return { ...base, command: { text, source: 'package-script', hash: sha256(text) } }
  }
  return {
    ...base,
    error: '当前工作目录没有 package.json test 脚本，也没有 environment.testCommand；无法执行受控自测',
  }
}

/** 解析模型参数：只允许 all/files/name，其余字段（command/cwd/env/timeout）一律拒绝。 */
export function parseSelftestFilter(args: unknown): SelftestFilter {
  if (args === undefined || args === null) return { mode: 'all' }
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('takt_selftest 参数必须是对象')
  const value = args as Record<string, unknown>
  const allowed = new Set(['mode', 'files', 'name'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`takt_selftest 不接受参数 ${key}；只能使用 mode/files/name`)
  }
  const mode = value.mode ?? 'all'
  if (mode !== 'all' && mode !== 'files' && mode !== 'name') {
    throw new Error('mode 只能是 all/files/name')
  }
  const files = value.files
  const name = value.name
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('files 必须是非空字符串数组')
    if (files.length > 50) throw new Error('files 最多 50 项')
    for (const file of files) {
      if (typeof file !== 'string') throw new Error('files 只能包含字符串')
      assertSafeFilter(file, 'files')
      if (path.isAbsolute(file)) throw new Error(`files 必须是相对测试文件路径：${file}`)
      const segments = file.split('/')
      if (segments.some((segment) => segment === '..' || segment === '')) {
        throw new Error(`files 不能包含空段或 ..：${file}`)
      }
    }
  }
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('name 必须是非空字符串')
    assertSafeFilter(name, 'name')
  }
  if (mode === 'all') {
    if (files !== undefined || name !== undefined) throw new Error('mode=all 时不能同时传 files 或 name')
    return { mode }
  }
  if (mode === 'files') {
    if (files === undefined) throw new Error('mode=files 时必须传 files')
    if (name !== undefined) throw new Error('mode=files 时不能传 name')
    return { mode, files: [...(files as string[])] }
  }
  if (name === undefined) throw new Error('mode=name 时必须传 name')
  if (files !== undefined) throw new Error('mode=name 时不能传 files')
  return { mode, name: (name as string).trim() }
}

function assertSafeFilter(value: string, label: string): void {
  if (value.trim() === '') throw new Error(`${label} 不能为空`)
  if (value.length > 300) throw new Error(`${label} 过长`)
  if (value !== value.trim() || value.startsWith('-')) throw new Error(`${label} 不能以选项前缀 - 开头：${value}`)
  if (!SAFE_FILTER.test(value)) throw new Error(`${label} 包含不允许的 shell 字符：${value}`)
}

type RunnerKind = 'vitest' | 'jest' | 'node-test' | 'unknown'

/** 从实际命令和冻结的 package scripts 判断 runner；未知 runner 明确拒绝过滤。 */
export function classifyRunner(command: string, scripts: Record<string, string> | undefined): RunnerKind {
  const text = /^(?:npm test|npm run test)$/.test(command.trim()) ? scripts?.test?.trim() ?? '' : command.trim()
  // 不从 pretest 或复合 shell 中猜测主 runner；仅支持可以确定附加参数位置的入口。
  if (/^(?:npx (?:--no-install )?)?vitest(?: run)?(?: --[A-Za-z-]+(?:=[A-Za-z0-9_-]+)?)*$/.test(text)) return 'vitest'
  if (/^(?:npx (?:--no-install )?)?jest(?: --[A-Za-z-]+(?:=[A-Za-z0-9_-]+)?)*$/.test(text)) return 'jest'
  if (/^node --test$/.test(text)) return 'node-test'

  return 'unknown'
}

function shellQuote(value: string): string {
  // 过滤阶段已拒绝单引号；这里仍按 POSIX 规则转义，避免未来放宽时留下注入面。
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 把过滤参数追加到可信命令；npm 入口必须用 -- 把参数传给脚本。 */
export function buildSelftestCommand(
  base: string,
  filter: SelftestFilter,
  runner: RunnerKind,
): string {
  if (filter.mode === 'all') return base
  const npm = RUNNER_ARG_SEPARATOR.test(base)
  const join = (args: string): string => npm ? `${base} -- ${args}` : `${base} ${args}`
  if (filter.mode === 'files') {
    const files = (filter.files ?? []).map(shellQuote).join(' ')
    if (runner === 'vitest' || runner === 'node-test') return join(files)
    if (runner === 'jest') return join(`--runTestsByPath ${files}`)
    throw new Error('当前测试入口无法可靠映射文件过滤；请使用 mode=all，或把测试入口换成 vitest/jest/node --test')
  }
  if (runner === 'vitest' || runner === 'jest') return join(`-t ${shellQuote(filter.name ?? '')}`)
  if (runner === 'node-test') {
    return join(`--test-name-pattern=${shellQuote(filter.name ?? '')}`)
  }
  throw new Error('当前测试入口无法可靠映射名称过滤；请使用 mode=all')
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  let offset = bytes.length - maxBytes
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++
  return bytes.subarray(offset).toString('utf8')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function findNode(definition: WorkflowDefinition | undefined, nodeId: string): NodeDef | undefined {
  if (definition === undefined) return undefined
  const visit = (nodes: NodeDef[], prefix = ''): NodeDef | undefined => {
    for (const node of nodes) {
      const id = prefix && !node.id.startsWith(prefix) ? `${prefix}${node.id}` : node.id
      if (id === nodeId) return node
      const found = node.kind === 'loop' ? visit(node.body, `${id}/`)
        : node.kind === 'subflow' ? visit(node.workflow.nodes, `${id}/`) : undefined
      if (found) return found
    }
    return undefined
  }

  return visit(definition.nodes)
}

/**
 * 受控自测服务：登记不可变上下文、执行可信命令、写证据并负责取消/等待。
 *
 * 命令解析在登记时完成；工具执行只接受 all/files/name 过滤，不能传 command/cwd/
 * env/timeout。进程取消复用 core 的进程组语义，release/drain/dispose 都等待在途执行。
 */
export class InMemorySelftestService implements SelftestService {
  private readonly entries = new Map<string, Entry>()
  private readonly runCommand: typeof runShellCommand
  private readonly readPackage: (cwd: string) => Promise<PackageSnapshot>
  private readonly pendingKeys = new Set<string>()
  private readonly starting = new Set<Promise<unknown>>()
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly options: SelftestServiceOptions) {
    this.runCommand = options.runCommand ?? runShellCommand
    this.readPackage = options.readPackage ?? readPackageSnapshot
  }

  register(input: SelftestContextInput): Promise<SelftestRegistration> {
    if (this.disposed || input.signal.aborted) return Promise.reject(new Error('受控自测服务已卸载或节点已取消'))
    if (this.entries.has(input.childId) || this.pendingKeys.has(input.childId)) return Promise.reject(new Error('子 Agent 已登记受控自测'))
    this.pendingKeys.add(input.childId)
    const task = this.registerFrozen(input)
    this.starting.add(task)
    void task.finally(() => { this.pendingKeys.delete(input.childId); this.starting.delete(task) }).catch(() => {})
    return task
  }

  private async registerFrozen(input: SelftestContextInput): Promise<SelftestRegistration> {
    const run = await input.space.stores.runs.get(input.nodeRef.runId)
    let snapshot: PackageSnapshot
    let packageError: string | undefined
    try { snapshot = await this.readPackage(input.cwd) } catch(error) { snapshot={exists:true,invalid:true}; packageError=errorMessage(error) }
    let baselineState = packageState(snapshot)
    if (packageError === undefined) {
      try {
        baselineState = await this.packageBaseline(input.space, input.nodeRef.runId, input.cwd, snapshot, input.signal)
        if (baselineState !== packageState(snapshot)) packageError = '本运行的 package scripts 基线已变化；重试或角色返工不能重新授权测试命令'
      } catch (error) { packageError = `无法读取或建立本运行的测试基线：${errorMessage(error)}` }
    }
    // 冻结 cwd 与空间根都用 realpath 规范化；只有空间根本身使用流程 QA 的
    // caseCommand，仓库/worktree（含 .takt/worktrees 下的 dev 工作树）只认仓库自身测试入口。
    const [cwdReal, spaceRootReal] = await Promise.all([realpath(input.cwd), realpath(input.space.root)])
    const commandScope: SelftestCommandScope = cwdReal === spaceRootReal ? 'workspace' : 'repo'
    const resolved = await resolveSelftestCommand(input.space, run, input.cwd, async () => snapshot, commandScope)
    // 标准流程空间 QA：只有空间根的 caseCommand 绑定到本次运行的主仓库集成工作树。
    // 仓库/worktree 的 testCommand 与其它 workflow 保持原行为。
    let execution: WorkspaceQaExecution | undefined
    let executionError: string | undefined
    if (run !== undefined && commandScope === 'workspace' && run.workflowId === 'taktflow-standard'
      && resolved.command?.source === 'run-args:caseCommand') {
      const bound = await this.standardQaExecution(input, run, resolved.command, spaceRootReal)
      execution = bound.execution
      executionError = bound.error
    }
    let expanded: { env: Record<string, string>; secrets: string[] } = { env: {}, secrets: [] }
    let environmentError: string | undefined = packageError
    try { expanded = expandEnvironmentReferences((input.space.stores.config as unknown as { environment?: { env?: Record<string,string> } }).environment?.env) }
    catch (error) { environmentError = errorMessage(error) }
    const env = { ...input.env, ...expanded.env }
    const secrets = [...collectSecrets({ env } as HarnessRequest, input.space.stores.config.providers ?? {}), ...expanded.secrets].filter(Boolean)
    const redact = createRedactor(secrets)
    const frozen: FrozenContext = {
      ...input,
      env, secrets, redact, packageState: baselineState,
      nodeRef: { ...input.nodeRef },
      writeScope: [...input.writeScope],
      timeoutMs: resolved.timeoutMs,
      ...(resolved.command === undefined || environmentError !== undefined || executionError !== undefined ? {} : { command: resolved.command }),
      ...(resolved.error === undefined && environmentError === undefined && executionError === undefined ? {} : { commandError: redact(executionError ?? environmentError ?? resolved.error!) }),
      ...(execution === undefined ? {} : { execution }),
      ...(resolved.packageScripts === undefined ? {} : { packageScripts: { ...resolved.packageScripts } }),
      ...(resolved.packageScriptsHash === undefined ? {} : { packageScriptsHash: resolved.packageScriptsHash }),
      ...(resolved.environmentTestCommand === undefined ? {} : { environmentTestCommand: resolved.environmentTestCommand }),
    }
    const entry: Entry = { context: frozen, controller: new AbortController(), active: new Set() }
    if (this.disposed || input.signal.aborted) throw new Error('受控自测登记期间宿主关闭或节点取消')
    this.entries.set(input.childId, entry)
    let released: Promise<void> | undefined
    return {
      childId: input.childId,
      cancel: (reason?: unknown) => this.cancelEntry(entry, reason),
      release: () => released ??= (async () => {
        this.cancelEntry(entry, new Error('子 Agent 已结束，受控自测取消'))
        await Promise.allSettled([...entry.active])
        if (this.entries.get(entry.context.childId) === entry) this.entries.delete(entry.context.childId)
      })(),
    }
  }

  /**
   * 标准流程空间 QA 的执行绑定。
   *
   * 只在「空间根 + taktflow-standard + run-args:caseCommand」时启用：
   * - integration 必须是本次运行已成功的节点，工作树必须位于空间根内且无符号链接；
   * - 执行 cwd 使用主仓库集成工作树，权限登记仍保持空间根；
   * - Node 脚本命令绑定到空间根源脚本绝对路径，保留脚本相对 import；
   * - integration 的 package scripts 基线在此冻结，执行前后复核。
   *
   * 结果缺失/未成功时返回明确错误，绝不回退到空间根执行旧代码。
   */
  private async standardQaExecution(
    input: SelftestContextInput,
    run: RunState,
    command: SelftestCommand,
    spaceRootReal: string,
  ): Promise<{ execution?: WorkspaceQaExecution; error?: string }> {
    const integrationNode = run.nodes.integration
    if (integrationNode === undefined || integrationNode.attempts < 1 || integrationNode.status !== 'succeeded') {
      return { error: `标准流程空间 QA 需要本次运行已成功的 integration 节点（当前 ${integrationNode?.status ?? '缺失'}）；不会退回空间根执行` }
    }
    let raw = integrationNode.result
    if (raw === undefined || raw === null) {
      // 部分持久化/面板快照不保留节点 result；integration 模板同时直写需求产物，可作只读回退。
      try {
        const text = await input.space.stores.workspaces.readArtifact({ workspace: input.requirementId, path: 'tasks/integration.json' })
        if (text === undefined) return { error: 'integration 节点已成功，但没有可读取的结果或 tasks/integration.json' }
        raw = JSON.parse(text.toString('utf8')) as unknown
      } catch (error) {
        return { error: `读取 integration 结果失败：${errorMessage(error)}` }
      }
    }
    const repo = typeof run.args.repo === 'string' && run.args.repo.trim() !== '' ? run.args.repo.trim() : 'app'
    const selected = selectWorkspaceQaIntegration(raw, input.nodeRef.runId, repo, input.space.root)
    if (selected.kind === 'error') return { error: selected.error }
    const integrationPath = selected.integration.path
    let cwd: string
    try {
      // 先做词法包含和符号链接组件校验，再用 realpath 复核空间根包含关系。
      await assertNoSymlinks(input.space.root, integrationPath)
      cwd = await realpath(integrationPath)
      const rel = path.relative(spaceRootReal, cwd)
      if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return { error: `integration 工作树必须位于空间根内的独立目录：${integrationPath}` }
      }
      const info = await stat(cwd)
      if (!info.isDirectory()) return { error: `integration 工作树不是目录：${integrationPath}` }
      const git = await lstat(path.join(cwd, '.git'))
      if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) {
        return { error: `integration 工作树的 .git 不是可信的普通文件/目录：${integrationPath}` }
      }
    } catch (error) {
      return { error: `integration 工作树不可用：${errorMessage(error)}` }
    }

    let snapshot: PackageSnapshot
    try {
      snapshot = await this.readPackage(cwd)
    } catch (error) {
      return { error: `读取 integration package.json 失败：${errorMessage(error)}` }
    }
    let state = packageState(snapshot)
    try {
      state = await this.packageBaseline(input.space, input.nodeRef.runId, cwd, snapshot, input.signal)
      if (state !== packageState(snapshot)) {
        return { error: '本运行的 integration package scripts 基线已变化；重试或角色返工不能重新授权测试命令' }
      }
    } catch (error) {
      return { error: `无法读取或建立 integration 测试基线：${errorMessage(error)}` }
    }

    const testScript = typeof run.args.testScript === 'string' ? run.args.testScript : undefined
    const binding = bindWorkspaceQaCommand(command.text, testScript, spaceRootReal)
    if (binding.kind === 'error') return { error: binding.error }
    return {
      execution: {
        cwd,
        command: binding.kind === 'bound' ? binding.command : command.text,
        commandHash: binding.kind === 'bound' ? sha256(binding.command) : command.hash,
        packageState: state,
        ...(snapshot.scriptsHash === undefined ? {} : { packageScriptsHash: snapshot.scriptsHash }),
        ...(binding.kind === 'bound' ? { scriptPath: binding.sourceScript } : {}),
      },
    }
  }

  /** 同一运行和物理 cwd 首次登记时固定脚本身份；跨 attempt、角色和宿主恢复均不覆盖。 */
  private async packageBaseline(
    space: SpaceHandle,
    runIdInput: string,
    cwdInput: string,
    snapshot: PackageSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    const runId = assertRunId(runIdInput)
    const cwd = await realpath(cwdInput)
    const file = path.join(space.stores.taktDir, 'runs', runId, 'selftest', `${sha256(cwd)}.json`)
    await assertNoSymlinks(space.root, file)
    return withFileLock(file, async () => {
      await assertNoSymlinks(space.root, file)
      const current = await readJsonFile<unknown>(file)
      if (current !== undefined) return readBaselineState(current)
      if (this.disposed || signal.aborted) throw new Error('登记已取消，不能建立测试基线')
      await this.options.ownership?.ensureLease(space)
      if (this.disposed || signal.aborted) throw new Error('登记已取消，不能建立测试基线')
      await assertNoSymlinks(space.root, file)
      const state = packageState(snapshot)
      // 只写身份指纹，不写脚本原文、cwd、环境变量或密钥。
      await writeFileAtomic(file, JSON.stringify({ schemaVersion: 1, ...JSON.parse(state) }) + '\n')
      return state
    })
  }

  cancel(childId: string, reason?: unknown): void {
    const entry = this.entries.get(childId)
    if (entry !== undefined) this.cancelEntry(entry, reason)
  }

  async drain(childId?: string): Promise<void> {
    const entries = childId === undefined
      ? [...this.entries.values()]
      : [this.entries.get(childId)].filter((entry): entry is Entry => entry !== undefined)
    await Promise.allSettled(entries.flatMap((entry) => [...entry.active]))
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      await Promise.allSettled([...this.starting])
      const entries = [...this.entries.values()]
      for (const entry of entries) this.cancelEntry(entry, new Error('宿主正在卸载，受控自测取消'))
      await Promise.allSettled(entries.flatMap((entry) => [...entry.active]))
      this.entries.clear()
    })()
    return this.disposal
  }

  async run(childId: string, args: unknown, exec: ToolRunContext): Promise<SelftestResult> {
    if (this.disposed) throw new Error('受控自测服务已卸载')
    if (!exec.agent || exec.agent.id !== childId || this.options.agents?.get(childId) !== exec.agent
      || this.options.agents.roots().includes(exec.agent)) throw new Error('受控自测只接受可信的活职责子 Agent')
    const entry = this.entries.get(childId)
    if (entry === undefined) {
      throw new Error('当前子 Agent 没有登记受控自测上下文；只有非只读且有写入范围的角色可以执行')
    }
    const context = entry.context
    if (context.role === 'lead') throw new Error('Lead 不能使用职责自测工具')
    const scope = this.options.permissions.lookup(childId)
    if (scope === undefined) throw new Error('受控自测缺少权限登记，拒绝执行')
    this.assertScope(context, scope)
    if (context.readOnly === true || context.writeScope.length === 0) {
      throw new Error('当前角色为只读或没有写入范围，不能执行受控自测')
    }
    if (context.allowBash === true) throw new Error('受控自测只允许可信命令，不允许 bash')
    if (context.command === undefined) {
      throw new Error(`受控自测不可用：${context.commandError ?? '没有可信测试命令'}`)
    }
    if (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted) {
      throw new Error('受控自测已取消，不能启动新进程')
    }
    const filter = parseSelftestFilter(args)
    // 标准流程空间 QA 的实际执行命令可能已绑定到空间根源脚本绝对路径；
    // 过滤仍只追加到实际命令上，不改变配置命令的身份与哈希。
    const base = context.execution?.command ?? context.command.text
    const runner = classifyRunner(base, context.packageScripts)
    const command = buildSelftestCommand(base, filter, runner)
    const task = this.execute(entry, scope, filter, command, exec)
    entry.active.add(task)
    try {
      return await task
    } finally {
      entry.active.delete(task)
    }
  }

  private assertScope(context: FrozenContext, scope: PermissionScope): void {
    if (scope.readOnly || scope.writeScope.length === 0) throw new Error('当前权限登记为只读，不能执行受控自测')
    if (scope.nodeRef.runId !== context.nodeRef.runId
      || scope.nodeRef.nodeId !== context.nodeRef.nodeId
      || scope.nodeRef.attempt !== context.nodeRef.attempt) {
      throw new Error('受控自测上下文与权限登记的节点不一致，拒绝执行')
    }
    if (scope.cwd !== context.cwd) throw new Error('受控自测上下文与权限登记的工作目录不一致，拒绝执行')
    if (scope.artifactRoot !== context.space.stores.workspaces.dir(context.requirementId) || scope.spaceRoot !== context.space.root) {
      throw new Error('自测公共产物或空间根与真实权限不一致')
    }
    if (!sameStrings(scope.writeScope, context.writeScope)) {
      throw new Error('受控自测上下文与权限登记的写入范围不一致，拒绝执行')
    }
  }

  private assertLive(entry: Entry, scope: PermissionScope, exec: ToolRunContext): void {
    const context = entry.context
    if (this.disposed || context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted) throw new Error('受控自测已取消')
    if (this.entries.get(context.childId) !== entry || this.options.permissions.lookup(context.childId) !== scope
      || !this.options.agents || this.options.agents.get(context.childId) !== exec.agent || !exec.agent || this.options.agents.roots().includes(exec.agent)) throw new Error('自测子 Agent 或权限已过期')
    this.assertScope(context, scope)
  }

  private cancelEntry(entry: Entry, reason?: unknown): void {
    if (entry.controller.signal.aborted) return
    entry.controller.abort(reason ?? new Error('受控自测已取消'))
  }

  private async execute(
    entry: Entry,
    scope: PermissionScope,
    filter: SelftestFilter,
    command: string,
    exec: ToolRunContext,
  ): Promise<SelftestResult> {
    const context = entry.context
    const commandInfo = context.command!
    const spaceRoot = await realpath(context.space.root)
    const artifactRoot = await realpath(context.space.stores.workspaces.dir(context.requirementId))
    const startedAt = new Date().toISOString()
    const started = Date.now()

    await this.options.ownership?.ensureLease(context.space)
    this.assertLive(entry, scope, exec)
    const current = await context.space.stores.runs.get(context.nodeRef.runId)
    if (!current || current.status !== 'running' || current.nodes[context.nodeRef.nodeId]?.attempts !== context.nodeRef.attempt
      || current.nodes[context.nodeRef.nodeId]?.status !== 'running') throw new Error('自测节点或尝试已过期')
    const execution = context.execution
    const executionCwd = execution?.cwd ?? context.cwd
    for (const file of filter.files ?? []) await assertNoSymlinks(executionCwd, path.resolve(executionCwd, file))
    // 执行前复核 scripts：dev 合法改依赖不影响，但测试脚本变化后不能继续宣称可信。
    let before: PackageSnapshot
    try {
      before = await this.readPackage(context.cwd)
    } catch (error) {
      throw new Error(`受控自测执行前读取 package.json 失败：${errorMessage(error)}`)
    }
    if (packageState(before) !== context.packageState) {
      throw new Error('package.json scripts 在执行前已变化，拒绝执行受控自测；请重新启动运行')
    }
    if (execution !== undefined) {
      let beforeExecution: PackageSnapshot
      try {
        beforeExecution = await this.readPackage(execution.cwd)
      } catch (error) {
        throw new Error(`受控自测执行前读取 integration package.json 失败：${errorMessage(error)}`)
      }
      if (packageState(beforeExecution) !== execution.packageState) {
        throw new Error('integration package.json scripts 在执行前已变化，拒绝执行受控自测；请重新启动运行')
      }
    }
    // 源脚本由自动化角色在本次运行中生成，登记时可能尚不存在；执行前固定哈希，
    // 执行后复核。脚本不是普通文件或包含符号链接时拒绝执行。
    let scriptHash: string | undefined
    if (execution?.scriptPath !== undefined) {
      try {
        await assertNoSymlinks(spaceRoot, execution.scriptPath)
        const info = await lstat(execution.scriptPath)
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('脚本不是普通文件')
        scriptHash = sha256(await readFile(execution.scriptPath))
      } catch (error) {
        throw new Error(`空间 QA 源脚本不可用：${errorMessage(error)}`)
      }
    }

    // 每次实际调用都有独立执行目录：入口脚本所在目录树的完整资产哈希、调用前
    // 用例证据归档和最终 receipt 都不可变落盘，后续重跑不能覆盖历史失败证据。
    const executionId = execution === undefined ? undefined : newExecutionId(context.nodeRef.attempt)
    const executionDir = executionId === undefined
      ? undefined
      : executionEvidenceDir(context.nodeRef.runId, context.nodeRef.nodeId, executionId)
    const priorArchive = executionDir === undefined
      ? undefined
      : await this.archiveExecution(entry, exec, artifactRoot, executionDir, 'prior')
    let assetsBefore: ExecutionAssetSnapshot | undefined
    if (execution?.scriptPath !== undefined) {
      try {
        // 目录树包含入口脚本的相对 helper/用例脚本；空间根入口只快照自身。
        assetsBefore = await snapshotExecutionAssets(spaceRoot, execution.scriptPath)
      } catch (error) {
        throw new Error(`空间 QA 源资产快照失败：${errorMessage(error)}`)
      }
    }
    const baselineRevision = typeof context.env.TAKT_REGRESSION_BASELINE_REV === 'string'
      && context.env.TAKT_REGRESSION_BASELINE_REV !== ''
      ? context.env.TAKT_REGRESSION_BASELINE_REV
      : undefined
    const gitBefore = execution === undefined
      ? undefined
      : await captureGitSnapshot(executionCwd, baselineRevision)

    const env: Record<string, string> = { ...context.env, TAKT_RUN_ID: context.nodeRef.runId, TAKT_REQ: context.requirementId, TAKT_NODE: context.nodeRef.nodeId, TAKT_WORKSPACE: artifactRoot, TAKT_SELFTEST: '1' }
    const secrets = context.secrets
    const redactor = context.redact
    let redactedTail = ''
    const maxSecretBytes = secretVariants(secrets).reduce((max, value) => Math.max(max, Buffer.byteLength(value)), 0)
    const redactionOverlap = Math.max(0, Math.ceil((SELFTEST_TAIL_BYTES + maxSecretBytes - 4096) / 8))
    let counts: { passed?: number; failed?: number; summaryOk?: boolean } = {}
    const rawCapacity = 4096 + redactionOverlap * 8
    const capture = (text: string): string => {
      const redacted = redactor(protectClippedPrefix(text, secrets, rawCapacity))
      counts = summaryCounts(redacted)
      redactedTail = utf8Tail(redacted, SELFTEST_TAIL_BYTES)
      return redacted
    }

    const timeout = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      timeout.abort(new Error(`受控自测超过 ${context.timeoutMs}ms`))
    }, context.timeoutMs)
    const signal = AbortSignal.any([context.signal, entry.controller.signal, exec.signal, timeout.signal])
    let exitCode = -1
    let spawnError: unknown
    // 可信自测子进程的写入由引擎的同一个 WriteGuard 归因：只有当前需求的
    // evidence/** 进入系统窗口，角色写权限本身不变；窗口在 finally 关闭。
    const evidenceScope = `${path.relative(context.space.stores.projectDir, artifactRoot).split(path.sep).join('/')}/evidence/**`
    const invoke = () => this.runCommand(command, executionCwd, env, signal, {
      redact: capture,
      redactionOverlap,
    })
    try {
      this.assertLive(entry, scope, exec)
      const result = context.withSystemWrites === undefined
        ? await invoke()
        : await context.withSystemWrites([evidenceScope], invoke)
      exitCode = result.code
    } catch (error) {
      spawnError = error
      if (!signal.aborted) exitCode = -1
    } finally {
      clearTimeout(timer)
    }
    let cancelled = !timedOut && (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted)
    if (spawnError !== undefined && redactedTail === '') {
      redactedTail = utf8Tail(redactor(errorMessage(spawnError)), SELFTEST_TAIL_BYTES)
    }

    // 执行后复核 scripts；变化后不宣称可信结果。
    let scriptsChanged = false
    try {
      const after = await this.readPackage(context.cwd)
      scriptsChanged = packageState(after) !== context.packageState
    } catch {
      scriptsChanged = true
    }
    let executionScriptChanged = false
    if (execution !== undefined) {
      try {
        const afterExecution = await this.readPackage(execution.cwd)
        if (packageState(afterExecution) !== execution.packageState) scriptsChanged = true
      } catch {
        scriptsChanged = true
      }
      if (execution.scriptPath !== undefined && scriptHash !== undefined) {
        try {
          if (sha256(await readFile(execution.scriptPath)) !== scriptHash) executionScriptChanged = true
        } catch {
          executionScriptChanged = true
        }
      }
    }
    scriptsChanged = scriptsChanged || executionScriptChanged

    // 入口目录树的完整资产快照在执行后复核；helper/用例脚本变化同样使结果不可信。
    let assetsAfter: ExecutionAssetSnapshot | undefined
    let assetDiff: ExecutionAssetDiff | undefined
    if (assetsBefore !== undefined && execution?.scriptPath !== undefined) {
      try {
        assetsAfter = await snapshotExecutionAssets(spaceRoot, execution.scriptPath)
        assetDiff = diffExecutionAssets(assetsBefore, assetsAfter)
      } catch (error) {
        assetDiff = {
          before: assetsBefore.digest,
          after: '',
          changed: true,
          added: [],
          removed: [],
          modified: [],
          error: context.redact(`执行后源资产快照失败：${errorMessage(error)}`),
        }
      }
    }
    const executionAssetsChanged = assetDiff?.changed === true
    const gitAfter = execution === undefined ? undefined : await captureGitSnapshot(executionCwd, baselineRevision)
    cancelled = !timedOut && (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted)
    const trusted = !scriptsChanged && !executionAssetsChanged
    const succeeded = exitCode === 0 && trusted && !timedOut && !cancelled && counts.summaryOk !== false && !(counts.failed && counts.failed > 0)
    const endedAt = new Date().toISOString()
    const durationMs = Date.now() - started
    const outputTail = redactedTail
    const caseSummary = execution === undefined ? undefined : await readCaseSummary(artifactRoot)
    const currentArchive = executionDir === undefined
      ? undefined
      : await this.archiveExecution(entry, exec, artifactRoot, executionDir, 'current', [
        { name: 'output.log', content: outputTail },
      ])
    const executionMetadata = execution === undefined || executionId === undefined
      ? undefined
      : {
        executionId,
        receipt: executionDir === undefined ? null : `${executionDir}/receipt.json`,
        sourceDigest: assetsBefore?.digest ?? null,
        sourceFiles: assetsBefore?.files.length ?? 0,
        casesDigest: caseSummary === undefined ? null : caseRowsDigest(caseSummary.cases),
        startedAt,
        endedAt,
        exitCode,
        timedOut,
        cancelled,
        trusted,
        executionAssetsChanged,
      }
    let executionReceipt: ExecutionReceiptRef | undefined
    let executionReceiptError: string | undefined
    let summaryUpdated: boolean | undefined
    let summaryUpdateError: string | undefined
    if (executionDir !== undefined && executionId !== undefined && execution !== undefined) {
      const receipt = {
        schemaVersion: 1,
        kind: 'selftest',
        runId: context.nodeRef.runId,
        nodeId: context.nodeRef.nodeId,
        attempt: context.nodeRef.attempt,
        executionId,
        requirementId: context.requirementId,
        role: context.role,
        sessionId: context.sessionId ?? context.childId,
        startedAt,
        endedAt,
        durationMs,
        configuredCommand: redactor(commandInfo.text),
        configuredCommandHash: commandInfo.hash,
        actualCommand: redactor(command),
        commandSource: commandInfo.source,
        cwd: redactor(executionCwd),
        exitCode,
        timedOut,
        cancelled,
        trusted,
        scriptsChanged,
        executionAssetsChanged,
        error: spawnError === undefined ? null : redactor(errorMessage(spawnError)),
        sourceAssets: assetsBefore === undefined ? null : {
          entry: assetsBefore.entry,
          directory: assetsBefore.directory,
          scope: assetsBefore.scope,
          digest: assetsBefore.digest,
          files: assetsBefore.files,
          afterDigest: assetsAfter?.digest ?? null,
          diff: assetDiff ?? null,
        },
        git: {
          before: gitBefore ?? null,
          after: gitAfter ?? null,
          baselineRevision: baselineRevision ?? null,
        },
        caseSummary: caseSummary === undefined ? null : {
          path: caseSummary.path,
          digest: caseSummary.digest ?? null,
          cases: caseSummary.cases,
          casesDigest: caseRowsDigest(caseSummary.cases),
          error: caseSummary.error ?? null,
        },
        archives: { prior: priorArchive ?? null, current: currentArchive ?? null },
        output: {
          path: 'current/output.log',
          sha256: sha256(outputTail),
          bytes: Buffer.byteLength(outputTail),
          streams: 'combined',
        },
        summaryExecution: executionMetadata ?? null,
      }
      const persisted = await this.persistExecutionReceipt(entry, exec, artifactRoot, executionDir, receipt)
      executionReceipt = persisted.ref
      executionReceiptError = persisted.error
      if (executionMetadata !== undefined) {
        const stamped = await this.stampCaseSummary(entry, exec, artifactRoot, executionMetadata)
        summaryUpdated = stamped.updated
        summaryUpdateError = stamped.error
      }
    }
    const evidenceResult = await this.writeEvidence(entry, scope, exec, {
      commandInfo, filter, command, startedAt, endedAt, durationMs,
      exitCode, succeeded, passed: counts.passed, failed: counts.failed, trusted, scriptsChanged, timedOut, cancelled, outputTail,
      spaceRoot, artifactRoot, cwd: executionCwd,
      ...(execution === undefined ? {} : { executionCommand: execution.command, executionCommandHash: execution.commandHash }),
      ...(execution?.packageScriptsHash === undefined ? {} : { executionPackageScriptsHash: execution.packageScriptsHash }),
      ...(scriptHash === undefined ? {} : { executionScriptHash: scriptHash }),
      ...(executionScriptChanged ? { executionScriptChanged } : {}),
      ...(executionId === undefined ? {} : { executionId }),
      ...(executionReceipt === undefined ? {} : { executionReceipt }),
      ...(executionReceiptError === undefined ? {} : { executionReceiptError }),
      ...(assetsBefore === undefined ? {} : {
        executionAssetEntry: assetsBefore.entry,
        executionAssetDirectory: assetsBefore.directory,
        executionAssetScope: assetsBefore.scope,
        executionAssetDigest: assetsBefore.digest,
        executionAssetFiles: assetsBefore.files.length,
        ...(assetsAfter === undefined ? {} : { executionAssetAfterDigest: assetsAfter.digest }),
        ...(assetDiff === undefined ? {} : { executionAssetDiff: assetDiff }),
      }),
      ...(executionAssetsChanged ? { executionAssetsChanged } : {}),
      ...(gitBefore === undefined && gitAfter === undefined ? {} : {
        executionGit: { before: gitBefore ?? null, after: gitAfter ?? null, baselineRevision: baselineRevision ?? null },
      }),
      ...(caseSummary === undefined ? {} : { executionCaseSummary: caseSummary }),
      ...(priorArchive === undefined && currentArchive === undefined ? {} : {
        executionArchives: { prior: priorArchive ?? null, current: currentArchive ?? null },
      }),
      ...(summaryUpdated === undefined ? {} : { executionSummaryUpdated: summaryUpdated }),
      ...(summaryUpdateError === undefined ? {} : { executionSummaryError: summaryUpdateError }),
    })
    const finalCancelled = !timedOut && (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted)
    return {
      exitCode,
      succeeded: succeeded && !finalCancelled,
      ...(counts.passed === undefined ? {} : { passed: counts.passed, failed: counts.failed }),
      durationMs,
      outputTail,
      evidence: evidenceResult.evidence,
      ...(evidenceResult.reason === undefined ? {} : { evidenceReason: evidenceResult.reason }),
      timedOut,
      cancelled: finalCancelled,
      trusted,
      scriptsChanged,
      ...(execution === undefined ? {} : { executionAssetsChanged }),
      command: redactor(command),
      commandSource: commandInfo.source,
      commandHash: commandInfo.hash,
      filter,
      startedAt,
      endedAt,
    }
  }

  private async writeEvidence(
    entry: Entry,
    scope: PermissionScope,
    exec: ToolRunContext,
    result: {
      commandInfo: SelftestCommand
      filter: SelftestFilter
      command: string
      startedAt: string
      endedAt: string
      durationMs: number
      exitCode: number
      succeeded: boolean
      passed?: number
      failed?: number
      trusted: boolean
      scriptsChanged: boolean
      timedOut: boolean
      cancelled: boolean
      outputTail: string
      spaceRoot: string
      artifactRoot: string
      cwd: string
      executionCommand?: string
      executionCommandHash?: string
      executionPackageScriptsHash?: string
      executionScriptHash?: string
      executionScriptChanged?: boolean
      executionId?: string
      executionReceipt?: ExecutionReceiptRef
      executionReceiptError?: string
      executionAssetEntry?: string
      executionAssetDirectory?: string
      executionAssetScope?: 'directory' | 'entry'
      executionAssetDigest?: string
      executionAssetFiles?: number
      executionAssetAfterDigest?: string
      executionAssetDiff?: ExecutionAssetDiff
      executionAssetsChanged?: boolean
      executionGit?: {
        before: ExecutionGitSnapshot | null
        after: ExecutionGitSnapshot | null
        baselineRevision: string | null
      }
      executionCaseSummary?: CaseSummarySnapshot
      executionArchives?: {
        prior: ExecutionArchiveResult | null
        current: ExecutionArchiveResult | null
      }
      executionSummaryUpdated?: boolean
      executionSummaryError?: string
    },
  ): Promise<{ evidence: SelftestEvidence | null; reason?: string }> {
    const context = entry.context
    if (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted) {
      return { evidence: null, reason: '运行已取消，未写证据' }
    }
    try {
      await this.options.ownership?.ensureLease(context.space)
    } catch (error) {
      return { evidence: null, reason: context.redact(`租约不可用，未写证据：${errorMessage(error)}`) }
    }
    const latest = this.options.permissions.lookup(context.childId)
    if (latest === undefined || latest !== scope) return { evidence: null, reason: '权限登记已变化，未写证据' }

    const node = findNode(context.workflow, context.nodeRef.nodeId)
    if (node === undefined) return { evidence: null, reason: '节点输出合同不可确认，本次只返回结果' }
    const strict = node.kind === 'agent' && node.strictOutputs === true
    const outputs = node?.outputs ?? []
    const safeNode = context.nodeRef.nodeId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'node'
    const suffix = `${safeNode}-${context.nodeRef.attempt}-${randomUUID()}`
    const candidates = [`tasks/selftest-${suffix}.json`, `evidence/selftest-${suffix}.json`]
    for (const relativePath of candidates) {
      const guard = createWriteGuard(this.options.permissions)
      if (guard({ ...exec, name: 'write', arguments: { file_path: path.join(result.artifactRoot, relativePath) } }) !== undefined) continue
      if (strict && !outputs.some((output) => matchGlob(output.path, relativePath))) continue
      const absolute = path.join(result.artifactRoot, relativePath)
      try {
        await assertNoSymlinks(result.artifactRoot, absolute)
      } catch {
        continue
      }
      const redactCommand = context.redact
      const payload = {
        schemaVersion: 1,
        runId: context.nodeRef.runId,
        nodeId: context.nodeRef.nodeId,
        attempt: context.nodeRef.attempt,
        sessionId: context.sessionId ?? context.childId,
        requirementId: context.requirementId,
        role: context.role,
        exitCode: result.exitCode,
        succeeded: result.succeeded,
        ...(result.passed === undefined ? {} : { passed: result.passed, failed: result.failed }),
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        source: result.commandInfo.source,
        command: redactCommand(result.command),
        commandHash: result.commandInfo.hash,
        packageScriptsHash: context.packageScriptsHash,
        // 实际执行 cwd/命令与 integration 基线；配置命令身份仍由 source/commandHash 保留。
        cwd: redactCommand(result.cwd),
        ...(result.executionCommand === undefined ? {} : { executionCommand: redactCommand(result.executionCommand) }),
        ...(result.executionCommandHash === undefined ? {} : { executionCommandHash: result.executionCommandHash }),
        ...(result.executionPackageScriptsHash === undefined ? {} : { executionPackageScriptsHash: result.executionPackageScriptsHash }),
        ...(result.executionScriptHash === undefined ? {} : { executionScriptHash: result.executionScriptHash }),
        ...(result.executionScriptChanged === true ? { executionScriptChanged: true } : {}),
        ...(result.executionId === undefined ? {} : { executionId: result.executionId }),
        ...(result.executionReceipt === undefined ? {} : { executionReceipt: result.executionReceipt }),
        ...(result.executionReceiptError === undefined ? {} : { executionReceiptError: result.executionReceiptError }),
        ...(result.executionAssetEntry === undefined ? {} : { executionAssetEntry: result.executionAssetEntry }),
        ...(result.executionAssetDirectory === undefined ? {} : { executionAssetDirectory: result.executionAssetDirectory }),
        ...(result.executionAssetScope === undefined ? {} : { executionAssetScope: result.executionAssetScope }),
        ...(result.executionAssetDigest === undefined ? {} : { executionAssetDigest: result.executionAssetDigest }),
        ...(result.executionAssetFiles === undefined ? {} : { executionAssetFiles: result.executionAssetFiles }),
        ...(result.executionAssetAfterDigest === undefined ? {} : { executionAssetAfterDigest: result.executionAssetAfterDigest }),
        ...(result.executionAssetDiff === undefined ? {} : { executionAssetDiff: result.executionAssetDiff }),
        ...(result.executionAssetsChanged === true ? { executionAssetsChanged: true } : {}),
        ...(result.executionGit === undefined ? {} : { executionGit: result.executionGit }),
        ...(result.executionCaseSummary === undefined ? {} : { executionCaseSummary: result.executionCaseSummary }),
        ...(result.executionArchives === undefined ? {} : { executionArchives: result.executionArchives }),
        ...(result.executionSummaryUpdated === undefined ? {} : { executionSummaryUpdated: result.executionSummaryUpdated }),
        ...(result.executionSummaryError === undefined ? {} : { executionSummaryError: result.executionSummaryError }),
        filter: result.filter,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        trusted: result.trusted,
        scriptsChanged: result.scriptsChanged,
        outputTail: result.outputTail,
      }
      try {
        this.assertLive(entry, scope, exec)
        await this.options.ownership?.ensureLease(context.space)
        this.assertLive(entry, scope, exec)
        const written = await context.space.stores.workspaces.writeArtifact({
          ref: { workspace: context.requirementId, path: relativePath },
          content: JSON.stringify(payload, null, 2),
          kind: 'evidence',
          author: { type: 'agent', role: context.role, harness: 'dsh-host' },
          producedBy: { runId: context.nodeRef.runId, nodeId: context.nodeRef.nodeId },
          title: '受控自测证据',
          tags: ['selftest'],
        })
        return { evidence: { workspace: written.workspace, path: written.path, version: written.version } }
      } catch (error) {
        return { evidence: null, reason: context.redact(`证据写入失败：${errorMessage(error)}`) }
      }
    }
    if (strict) {
      return { evidence: null, reason: '节点启用了 strictOutputs，但没有声明允许的任务/证据路径；本次只返回结果' }
    }
    return { evidence: null, reason: '当前写权限范围不允许写 tasks/ 或 evidence/ 证据；本次只返回结果' }
  }

  /** 归档当前需求在本次调用前后的 summary/逐例证据；只写 evidence/executions 下。 */
  private async archiveExecution(
    entry: Entry,
    exec: ToolRunContext,
    artifactRoot: string,
    executionDir: string | undefined,
    label: 'prior' | 'current',
    extra?: Array<{ name: string; content: string | Buffer }>,
  ): Promise<ExecutionArchiveResult | undefined> {
    if (executionDir === undefined) return undefined
    const context = entry.context
    const guard = createWriteGuard(this.options.permissions)
    const probe = path.join(artifactRoot, executionDir, label, 'evidence/summary.json')
    const denial = guard({ ...exec, name: 'write', arguments: { file_path: probe } })
    if (denial !== undefined) {
      return {
        directory: `${executionDir}/${label}`,
        files: [],
        cases: [],
        missing: [],
        error: context.redact(`执行证据归档被写入守卫拒绝：${denial}`),
      }
    }
    try {
      return await archiveCaseEvidence({
        workspaceDir: artifactRoot,
        archiveDir: executionDir,
        label,
        ...(extra === undefined ? {} : { extra }),
      })
    } catch (error) {
      return {
        directory: `${executionDir}/${label}`,
        files: [],
        cases: [],
        missing: [],
        error: context.redact(`执行证据归档失败：${errorMessage(error)}`),
      }
    }
  }

  /** 不可变 receipt 落盘后登记归属；登记失败不抹掉已落盘的执行证据。 */
  private async persistExecutionReceipt(
    entry: Entry,
    exec: ToolRunContext,
    artifactRoot: string,
    executionDir: string,
    receipt: Record<string, unknown>,
  ): Promise<{ ref?: ExecutionReceiptRef; error?: string }> {
    const context = entry.context
    const guard = createWriteGuard(this.options.permissions)
    const target = path.join(artifactRoot, executionDir, 'receipt.json')
    const denial = guard({ ...exec, name: 'write', arguments: { file_path: target } })
    if (denial !== undefined) return { error: context.redact(`执行 receipt 被写入守卫拒绝：${denial}`) }
    try {
      const ref = await writeExecutionReceipt(artifactRoot, executionDir, receipt)
      try {
        await context.space.stores.workspaces.writeArtifact({
          ref: { workspace: context.requirementId, path: ref.path },
          content: `${JSON.stringify(receipt, null, 2)}\n`,
          kind: 'evidence',
          author: { type: 'agent', role: context.role, harness: 'dsh-host' },
          producedBy: { runId: context.nodeRef.runId, nodeId: context.nodeRef.nodeId },
          title: '受控自测执行 receipt',
          tags: ['selftest', 'execution-receipt'],
        })
      } catch (error) {
        return { ref, error: context.redact(`receipt 归属登记失败：${errorMessage(error)}`) }
      }
      return { ref }
    } catch (error) {
      return { error: context.redact(`执行 receipt 写入失败：${errorMessage(error)}`) }
    }
  }

  /** 只追加执行元数据，保留 runner 产出的 cases/status/assertions 原样。 */
  private async stampCaseSummary(
    entry: Entry,
    exec: ToolRunContext,
    artifactRoot: string,
    execution: Record<string, unknown>,
  ): Promise<{ updated: boolean; error?: string }> {
    const context = entry.context
    const target = path.join(artifactRoot, 'evidence/summary.json')
    const guard = createWriteGuard(this.options.permissions)
    const denial = guard({ ...exec, name: 'write', arguments: { file_path: target } })
    if (denial !== undefined) {
      return { updated: false, error: context.redact(`summary 执行元数据被写入守卫拒绝：${denial}`) }
    }
    try {
      await assertNoSymlinks(artifactRoot, target)
      const text = await readFile(target, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { updated: false, error: 'summary 不是对象，未写入执行元数据' }
      }
      const record = parsed as Record<string, unknown>
      const next = {
        ...record,
        ...(typeof record.generatedAt === 'string' && record.generatedAt !== '' ? {} : { generatedAt: execution.endedAt }),
        execution,
      }
      await writeFileAtomic(target, `${JSON.stringify(next, null, 2)}\n`)
      return { updated: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { updated: false }
      return { updated: false, error: context.redact(`summary 执行元数据写入失败：${errorMessage(error)}`) }
    }
  }
}

function packageState(snapshot: PackageSnapshot): string {
  return JSON.stringify({ exists: snapshot.exists, invalid: snapshot.invalid === true, testPresent: snapshot.test !== undefined, scriptsHash: snapshot.scriptsHash ?? null })
}
function secretVariants(secrets: string[]): string[] {
  return [...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1,-1), ...secret.split(/\r\n|\r|\n/)]).filter(Boolean))]
}
/** core 的原始缓冲先截断；脱敏会缩短后续文本，因此必须先遮盖左边界残留密钥。 */
function protectClippedPrefix(text: string, secrets: string[], capacity: number): string {
  if (Buffer.byteLength(text) < capacity) return text
  let value=text.replace(/^\ufffd+/, '')
  let longest=0
  for (const secret of secretVariants(secrets)) {
    for (let offset=1;offset<secret.length;offset++) {
      const suffix=secret.slice(offset)
      if(suffix.length>longest && value.startsWith(suffix))longest=suffix.length
    }
  }
  if(longest)value='[REDACTED]'+value.slice(longest)
  return value
}
/** 只识别本次输出里的完整汇总；无可信计数时省略，绝不从旧证据补零。 */
function summaryCounts(text: string): { passed?: number; failed?: number; summaryOk?: boolean } {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim()
  const lines = clean.split(/\r?\n/)
  try {
    const value: unknown = JSON.parse(lines.at(-1) ?? '')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string,unknown>
      if (Number.isSafeInteger(row.passed) && Number.isSafeInteger(row.failed)
        && (row.passed as number) >= 0 && (row.failed as number) >= 0
        && (row.cases === undefined || Array.isArray(row.cases) && row.cases.length === (row.passed as number) + (row.failed as number))) {
        return { passed: row.passed as number, failed: row.failed as number, ...(typeof row.ok === 'boolean' ? { summaryOk: row.ok } : {}) }
      }
    }
  } catch { /* 继续识别明确的 runner 汇总行。 */ }
  const summary = lines.filter((line) => /^\s*Tests\s*:?[\s\d]/.test(line)).at(-1)
  if (summary) {
    const passed = Number(/(\d+)\s+passed/.exec(summary)?.[1] ?? 0)
    const failed = Number(/(\d+)\s+failed/.exec(summary)?.[1] ?? 0)
    const total = Number(/(\d+)\s+total|\((\d+)\)/.exec(summary)?.slice(1).find(Boolean))
    if (Number.isSafeInteger(total) && passed + failed === total) return { passed, failed }
  }
  const pass = /^# pass (\d+)$/m.exec(clean), fail = /^# fail (\d+)$/m.exec(clean), total = /^# tests (\d+)$/m.exec(clean)
  if (pass && fail && total && Number(pass[1]) + Number(fail[1]) === Number(total[1])) return { passed: Number(pass[1]), failed: Number(fail[1]) }
  return {}
}

/** 已有基线损坏时拒绝，不能把损坏当作首次登记重新授权。 */
function readBaselineState(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('测试基线格式无效')
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1 || typeof item.exists !== 'boolean' || typeof item.invalid !== 'boolean'
    || typeof item.testPresent !== 'boolean' || (item.scriptsHash !== null && (typeof item.scriptsHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.scriptsHash)))
    || Object.keys(item).some((key) => !['schemaVersion', 'exists', 'invalid', 'testPresent', 'scriptsHash'].includes(key))) throw new Error('测试基线格式无效')
  return JSON.stringify({ exists: item.exists, invalid: item.invalid, testPresent: item.testPresent, scriptsHash: item.scriptsHash })
}
