import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  assertNoSymlinks,
  assertRunId,
  readJsonFile,
  withFileLock,
  writeFileAtomic,
  matchGlob,
  runShellCommand,
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

interface FrozenContext extends SelftestContextInput {
  command?: SelftestCommand
  commandError?: string
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function canonicalScripts(scripts: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right)))
  return JSON.stringify(sorted)
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
 */
export async function resolveSelftestCommand(
  space: SpaceHandle,
  run: RunState | undefined,
  cwd: string,
  readPackage: (cwd: string) => Promise<PackageSnapshot> = readPackageSnapshot,
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
  for (const key of ['caseCommand', 'testCommand'] as const) {
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
        baselineState = await this.packageBaseline(input, snapshot)
        if (baselineState !== packageState(snapshot)) packageError = '本运行的 package scripts 基线已变化；重试或角色返工不能重新授权测试命令'
      } catch (error) { packageError = `无法读取或建立本运行的测试基线：${errorMessage(error)}` }
    }
    const resolved = await resolveSelftestCommand(input.space, run, input.cwd, async () => snapshot)
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
      ...(resolved.command === undefined || environmentError !== undefined ? {} : { command: resolved.command }),
      ...(resolved.error === undefined && environmentError === undefined ? {} : { commandError: redact(environmentError ?? resolved.error!) }),
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

  /** 同一运行和物理 cwd 首次登记时固定脚本身份；跨 attempt、角色和宿主恢复均不覆盖。 */
  private async packageBaseline(input: SelftestContextInput, snapshot: PackageSnapshot): Promise<string> {
    const runId = assertRunId(input.nodeRef.runId)
    const cwd = await realpath(input.cwd)
    const file = path.join(input.space.stores.taktDir, 'runs', runId, 'selftest', `${sha256(cwd)}.json`)
    await assertNoSymlinks(input.space.root, file)
    return withFileLock(file, async () => {
      await assertNoSymlinks(input.space.root, file)
      const current = await readJsonFile<unknown>(file)
      if (current !== undefined) return readBaselineState(current)
      if (this.disposed || input.signal.aborted) throw new Error('登记已取消，不能建立测试基线')
      await this.options.ownership?.ensureLease(input.space)
      if (this.disposed || input.signal.aborted) throw new Error('登记已取消，不能建立测试基线')
      await assertNoSymlinks(input.space.root, file)
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
    const runner = classifyRunner(context.command.text, context.packageScripts)
    const command = buildSelftestCommand(context.command.text, filter, runner)
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
    for (const file of filter.files ?? []) await assertNoSymlinks(context.cwd, path.resolve(context.cwd, file))
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
    try {
      this.assertLive(entry, scope, exec)
      const result = await this.runCommand(command, context.cwd, env, signal, {
        redact: capture,
        redactionOverlap,
      })
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
    cancelled = !timedOut && (context.signal.aborted || entry.controller.signal.aborted || exec.signal.aborted)
    const trusted = !scriptsChanged
    const succeeded = exitCode === 0 && trusted && !timedOut && !cancelled && counts.summaryOk !== false && !(counts.failed && counts.failed > 0)
    const endedAt = new Date().toISOString()
    const durationMs = Date.now() - started
    const outputTail = redactedTail
    const evidenceResult = await this.writeEvidence(entry, scope, exec, {
      commandInfo, filter, command, startedAt, endedAt, durationMs,
      exitCode, succeeded, passed: counts.passed, failed: counts.failed, trusted, scriptsChanged, timedOut, cancelled, outputTail,
      spaceRoot, artifactRoot,
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
