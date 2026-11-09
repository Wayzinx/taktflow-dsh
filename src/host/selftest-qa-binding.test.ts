import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agent,
  bindWorkspaceQaCommand,
  initProject,
  readExecutionReceipts,
  selectWorkspaceQaIntegration,
  type NodeContext,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { qualityReport, runCases } from '../../vendor/taktflow/templates/workflows/taktflow-standard.hooks.js'
import { InMemoryPermissionRegistry } from './permissions.js'
import { InMemorySelftestService, type SelftestContextInput } from './selftest.js'
import { FsSpaceRegistry } from './space.js'
import type { Agent, HostContext, ToolRunContext } from './dsh-types.js'
import type { PermissionScope } from './types.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const services: InMemorySelftestService[] = []
const RUN_ID = 'run-qa-1'
const CASE_COMMAND = 'node tests/run-cases.mjs'
const TEST_SCRIPT = 'tests/run-cases.mjs'
const BRANCH = `takt/${RUN_ID}/integration`
/** 真实 Git worktree 与真实子进程需要比默认 5s 更长的窗口。 */
const REAL_PROCESS_TIMEOUT = 30_000

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

function runnerProgram(options: { tamper?: boolean; helperTamper?: boolean; markerMode?: boolean; secret?: boolean; caseId?: string } = {}): string {
  const caseId = options.caseId ?? 'TC-1'
  const lines = [
    "import { createRequire } from 'node:module'",
    "import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'",
    "import { fileURLToPath } from 'node:url'",
    "import path from 'node:path'",
    "import { spawnSync } from 'node:child_process'",
    "import { marker } from './cases/helper.mjs'",
    'const require = createRequire(import.meta.url)',
    'const scriptPath = fileURLToPath(import.meta.url)',
    "const product = require(path.resolve(process.cwd(), 'src/add.js'))",
    'const revision = process.env.TAKT_REGRESSION_BASELINE_REV',
    "const git = spawnSync('git', ['rev-parse', '--verify', revision + '^{commit}'], { cwd: process.cwd(), encoding: 'utf8' })",
    'if (git.status !== 0) { console.error(git.stderr); process.exit(1) }',
    ...(options.markerMode === true
      ? ["const mode = (await readFile(path.join(process.env.TAKT_WORKSPACE, 'mode'), 'utf8').catch(() => 'pass')).trim()"]
      : ["const mode = 'pass'"]),
    "const ok = product.sub(5, 3) === 2 && marker === 'helper-ok' && mode === 'pass'",
    'const evidence = { scriptPath, cwd: process.cwd(), modulePath: path.resolve(process.cwd(), \'src/add.js\'), baseline: git.stdout.trim(), helper: marker, ok }',
    "await mkdir(path.join(process.env.TAKT_WORKSPACE, 'evidence'), { recursive: true })",
    "await writeFile(path.join(process.env.TAKT_WORKSPACE, 'evidence/binding.json'), JSON.stringify(evidence, null, 2) + '\\n')",
    `await writeFile(path.join(process.env.TAKT_WORKSPACE, 'evidence/summary.json'), JSON.stringify({ cases: [{ id: '${caseId}', status: ok ? 'passed' : 'failed', evidence: 'evidence/binding.json' }] }, null, 2) + '\\n')`,
    ...(options.helperTamper === true ? ["await appendFile(path.join(path.dirname(scriptPath), 'cases/helper.mjs'), '\\n// helper tampered during run\\n')"] : []),
    ...(options.tamper === true ? ["await appendFile(scriptPath, '\\n// tampered during run\\n')"] : []),
    ...(options.secret === true ? ["console.log('secret=' + String(process.env.TAKT_TEST_SECRET ?? ''))"] : []),
    'console.log(JSON.stringify({ passed: ok ? 1 : 0, failed: ok ? 0 : 1, ok }))',
    'process.exit(ok ? 0 : 1)',
    '',
  ]
  return lines.join('\n')
}

async function writeRunner(
  root: string,
  options: { tamper?: boolean; helperTamper?: boolean; markerMode?: boolean; secret?: boolean; caseId?: string } = {},
): Promise<string> {
  await mkdir(path.join(root, 'tests/cases'), { recursive: true })
  await writeFile(path.join(root, 'tests/cases/helper.mjs'), "export const marker = 'helper-ok'\n")
  const program = runnerProgram(options)
  await writeFile(path.join(root, TEST_SCRIPT), program)
  return program
}

function scriptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function scriptsHash(scripts: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right)))
  return scriptHash(JSON.stringify(sorted))
}

interface RepoFixture {
  root: string
  app: string
  integration: string
  baseline: string
  rootRevision: string
  integrationHead: string
  requirementId: string
  workspaceDir: string
  space: Awaited<ReturnType<FsSpaceRegistry['open']>>
}

async function repoFixture(): Promise<RepoFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-qa-binding-')))
  roots.push(root)
  // 空间根本身也是一个真实 Git 仓库：Git 快照若错误地落在空间根，会得到这里的 revision。
  await writeFile(path.join(root, 'space-root.txt'), 'space root\n')
  await git(root, ['init', '-b', 'main'])
  await git(root, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'add', '.'])
  await git(root, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'commit', '-m', 'space root'])
  const rootRevision = await git(root, ['rev-parse', 'HEAD'])
  const app = path.join(root, 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "console.log(1)"' } }))
  await writeFile(path.join(app, 'src/add.js'), 'module.exports = { add: (a, b) => a + b }\n')
  await git(app, ['init', '-b', 'main'])
  await git(app, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'add', '.'])
  await git(app, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'commit', '-m', 'baseline'])
  const baseline = await git(app, ['rev-parse', 'HEAD'])
  const integration = path.join(root, '.takt', 'worktrees', RUN_ID, 'integration')
  await git(app, ['worktree', 'add', '-b', BRANCH, integration, baseline])
  await writeFile(path.join(integration, 'src/add.js'), 'module.exports = { add: (a, b) => a + b, sub: (a, b) => a - b }\n')
  await git(integration, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'add', '.'])
  await git(integration, ['-c', 'user.name=Takt', '-c', 'user.email=takt@localhost', 'commit', '-m', 'integration'])
  const integrationHead = await git(integration, ['rev-parse', 'HEAD'])
  const stores = await initProject(root)
  const space = await new FsSpaceRegistry().open(root)
  const requirementId = (await space.stores.workspaces.createRequirement({ title: 'QA binding' })).id
  const workspaceDir = await realpath(space.stores.workspaces.dir(requirementId))
  return { root, app, integration, baseline, rootRevision, integrationHead, requirementId, workspaceDir, space }
}

/** 构造正式 runCases 的 NodeContext：真实 integration 结果 + 空间根/需求公共存放区。 */
function runCasesContext(f: RepoFixture, options: { iteration?: number } = {}): NodeContext {
  const integration = {
    repo: 'app', path: f.integration, branch: BRANCH, merged: [], conflicts: [],
    repositories: { app: { path: f.integration, branch: BRANCH, merged: [], conflicts: [] } },
  }
  return {
    projectDir: f.root, workspaceDir: f.workspaceDir, runId: RUN_ID, requirementId: f.requirementId,
    nodeId: 'dev-test-loop/run-cases', iteration: options.iteration ?? 1,
    args: { caseCommand: CASE_COMMAND, testScript: TEST_SCRIPT, repo: 'app' },
    signal: new AbortController().signal,
    log: () => {},
    resultOf: (id: string) => (id === 'integration' ? integration : undefined),
    readArtifact: async (relative: string) => {
      try {
        return await readFile(path.join(f.workspaceDir, relative), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  } as unknown as NodeContext
}

/** 写入空间根源 runner、冻结用例与评审产物副本。 */
async function seedRunCases(f: RepoFixture, runner: Parameters<typeof writeRunner>[1] = {}): Promise<string> {
  const program = await writeRunner(f.root, runner)
  await mkdir(path.join(f.workspaceDir, 'scripts'), { recursive: true })
  await mkdir(path.join(f.workspaceDir, 'cases'), { recursive: true })
  await writeFile(path.join(f.workspaceDir, 'scripts/run-cases.mjs'), program)
  await writeFile(path.join(f.workspaceDir, 'cases/TC-1.json'), JSON.stringify({ id: 'TC-1', covers: ['AC-1'] }))
  return program
}

/** 宿主进程环境注入回归基线（真实 e2e 的注入路径），测试后恢复。 */
async function withBaseline<T>(baseline: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TAKT_REGRESSION_BASELINE_REV
  process.env.TAKT_REGRESSION_BASELINE_REV = baseline
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.TAKT_REGRESSION_BASELINE_REV
    else process.env.TAKT_REGRESSION_BASELINE_REV = previous
  }
}

interface QaFixtureOptions {
  integrationStatus?: 'succeeded' | 'running'
  omitIntegrationNode?: boolean
  integrationPath?: (integration: string) => Promise<string> | string
  integrationBranch?: string
  integrationRepo?: string
  caseCommand?: string
  allowedCommands?: string[]
  sourceBeforeRegister?: boolean
  tamper?: boolean
  helperTamper?: boolean
  markerMode?: boolean
  env?: Record<string, string>
}

async function qaFixture(options: QaFixtureOptions = {}) {
  const base = await repoFixture()
  const resultPath = await (options.integrationPath?.(base.integration) ?? base.integration)
  const branch = options.integrationBranch ?? BRANCH
  const repo = options.integrationRepo ?? 'app'
  const tree = { path: resultPath, branch, merged: [], conflicts: [] }
  const result = { repo, path: resultPath, branch, merged: [], conflicts: [], repositories: { [repo]: tree } }
  const caseCommand = options.caseCommand ?? CASE_COMMAND
  const config = base.space.stores.config as unknown as Record<string, unknown>
  config.selftest = { allowedCommands: options.allowedCommands ?? [CASE_COMMAND] }
  const run: RunState = {
    runId: RUN_ID,
    workflowId: 'taktflow-standard',
    workflowVersion: '1',
    requirementId: base.requirementId,
    status: 'running',
    startedAt: new Date().toISOString(),
    args: { caseCommand, testScript: TEST_SCRIPT, repo: 'app' },
    nodes: {
      work: { id: 'work', status: 'running', attempts: 1, outputs: [] },
      ...(options.omitIntegrationNode === true ? {} : {
        integration: {
          id: 'integration',
          status: options.integrationStatus ?? 'succeeded',
          attempts: 1,
          outputs: [],
          ...(options.integrationStatus === 'running' ? {} : { result }),
        },
      }),
    },
    expansions: [],
  }
  await base.space.stores.runs.save(run)
  const cwd = base.root
  const artifactRoot = base.workspaceDir
  const writeScope = ['requirements/**/tasks/**', 'requirements/**/evidence/**']
  const permissions = new InMemoryPermissionRegistry()
  const childId = 'qa-child'
  const nodeRef = { runId: RUN_ID, nodeId: 'work', attempt: 1 }
  const scope: PermissionScope = {
    childId, nodeRef, cwd, spaceRoot: cwd, artifactRoot, writeScope, allowBash: false, readOnly: false,
  }
  permissions.register(scope)
  const controller = new AbortController()
  const child: Agent = {
    id: childId, options: {}, session: { header: { id: childId, cwd } }, followup() {}, inject() {},
  }
  const live = new Map([[childId, child]])
  const agents: HostContext['agents'] = { get: (id) => live.get(id), roots: () => [] }
  const service = new InMemorySelftestService({ permissions, agents })
  services.push(service)
  const workflow: WorkflowDefinition = {
    id: 'taktflow-standard', title: 'QA', version: '1', stages: [],
    nodes: [agent({ id: 'work', title: 'QA', role: 'automation', harness: { harness: 'dsh-host' }, prompt: 'qa', outputs: [{ path: 'evidence/**', kind: 'evidence' }] })],
  }
  if (options.sourceBeforeRegister === true) {
    await writeRunner(base.root, { tamper: options.tamper, helperTamper: options.helperTamper, markerMode: options.markerMode })
  }
  const registrationInput: SelftestContextInput = {
    childId, space: base.space, nodeRef, role: 'automation', requirementId: base.requirementId,
    cwd, env: { TAKT_REGRESSION_BASELINE_REV: base.baseline, ...(options.env ?? {}) }, writeScope,
    signal: controller.signal, sessionId: 'session-qa', workflow,
  }
  await service.register(registrationInput)
  const exec = {
    callId: 'call-1', rootCallId: 'call-1', name: 'takt_selftest', arguments: {},
    agent: child, signal: controller.signal, token: Symbol('token'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
  return { ...base, run, service, permissions, child, live, agents, scope, exec, controller, registrationInput, workflow, writeScope }
}

describe('标准流程空间 QA 执行绑定', () => {
  it('真实进程：integration cwd + 空间根源脚本 + 源相对 helper + Git 基线', async () => {
    const f = await qaFixture()
    const program = await writeRunner(f.root)
    const result = await f.service.run('qa-child', {}, f.exec)
    expect(result.exitCode).toBe(0)
    expect(result.succeeded).toBe(true)
    expect(result.commandSource).toBe('run-args:caseCommand')
    expect(result.commandHash).toBe(scriptHash(CASE_COMMAND))
    expect(result.command).toContain(path.join(f.root, TEST_SCRIPT))
    expect(result.evidence).not.toBeNull()

    const payload = JSON.parse((await f.space.stores.workspaces.readArtifact(result.evidence!))!.toString('utf8')) as Record<string, unknown>
    expect(payload).toMatchObject({
      cwd: f.integration,
      executionCommand: `'node' '${path.join(f.root, TEST_SCRIPT)}'`,
      executionScriptHash: scriptHash(program),
      executionPackageScriptsHash: scriptsHash(JSON.parse(await readFile(path.join(f.integration, 'package.json'), 'utf8')).scripts),
      trusted: true,
      scriptsChanged: false,
    })
    expect(payload.command).toContain(path.join(f.root, TEST_SCRIPT))

    const binding = JSON.parse(await readFile(path.join(f.workspaceDir, 'evidence/binding.json'), 'utf8')) as Record<string, unknown>
    expect(binding).toMatchObject({
      cwd: f.integration,
      scriptPath: path.join(f.root, TEST_SCRIPT),
      modulePath: path.join(f.integration, 'src/add.js'),
      baseline: f.baseline,
      helper: 'helper-ok',
      ok: true,
    })
  }, REAL_PROCESS_TIMEOUT)

  it('同一 runner 在空间根执行时复现 R6：产品模块与 Git 基线不可用', async () => {
    const f = await qaFixture()
    await writeRunner(f.root)
    const failure = await execFileAsync(process.execPath, [path.join(f.root, TEST_SCRIPT)], {
      cwd: f.root,
      env: { ...process.env, TAKT_WORKSPACE: f.workspaceDir, TAKT_REGRESSION_BASELINE_REV: f.baseline },
    }).then(() => undefined, (error: unknown) => error as { code?: number; stderr?: string })
    expect(failure?.code).toBe(1)
    expect(String(failure?.stderr)).toContain('Cannot find module')
  }, REAL_PROCESS_TIMEOUT)

  it('integration 未成功/缺失时明确拒绝，不退回空间根', async () => {
    for (const options of [{ integrationStatus: 'running' as const }, { omitIntegrationNode: true }]) {
      const f = await qaFixture(options)
      await writeRunner(f.root)
      await expect(f.service.run('qa-child', {}, f.exec)).rejects.toThrow('标准流程空间 QA 需要本次运行已成功的 integration 节点')
    }
  }, REAL_PROCESS_TIMEOUT)

  it('拒绝空间外、符号链接、其它运行分支和仓库不匹配的 integration', async () => {
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-qa-outside-')))
    roots.push(outside)
    const cases: Array<{ options: QaFixtureOptions; message: string }> = [
      { options: { integrationPath: () => outside }, message: '必须位于空间根内' },
      {
        options: {
          integrationPath: async (integration) => {
            const link = path.join(path.dirname(integration), 'integration-link')
            await symlink(integration, link, 'dir')
            return link
          },
        },
        message: '符号链接',
      },
      { options: { integrationBranch: `takt/other-run/integration` }, message: '不是本次运行的分支' },
      { options: { integrationRepo: 'web' }, message: '不一致' },
    ]
    for (const item of cases) {
      const f = await qaFixture(item.options)
      await writeRunner(f.root)
      await expect(f.service.run('qa-child', {}, f.exec)).rejects.toThrow(item.message)
    }
  }, REAL_PROCESS_TIMEOUT)

  it('integration package scripts 在执行前变化时拒绝', async () => {
    const f = await qaFixture()
    await writeRunner(f.root)
    await writeFile(path.join(f.integration, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "console.log(2)"' } }))
    await expect(f.service.run('qa-child', {}, f.exec)).rejects.toThrow('integration package.json scripts 在执行前已变化')
  }, REAL_PROCESS_TIMEOUT)

  it('执行期间源脚本变化时结果不可信', async () => {
    const f = await qaFixture({ sourceBeforeRegister: true, tamper: true })
    const result = await f.service.run('qa-child', {}, f.exec)
    expect(result.exitCode).toBe(0)
    expect(result.trusted).toBe(false)
    expect(result.scriptsChanged).toBe(true)
    expect(result.succeeded).toBe(false)
    const payload = JSON.parse((await f.space.stores.workspaces.readArtifact(result.evidence!))!.toString('utf8')) as Record<string, unknown>
    expect(payload.executionScriptChanged).toBe(true)
  }, REAL_PROCESS_TIMEOUT)

  it('执行期间源相对 helper 变化时 QA 自测结果不可信，receipt 记录变更清单', async () => {
    const f = await qaFixture({ sourceBeforeRegister: true, helperTamper: true })
    const result = await f.service.run('qa-child', {}, f.exec)
    expect(result.exitCode).toBe(0)
    expect(result.trusted).toBe(false)
    expect(result.executionAssetsChanged).toBe(true)
    expect(result.succeeded).toBe(false)
    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    const receipt = receipts.receipts[0]!.receipt
    expect(receipt.trusted).toBe(false)
    expect(receipt.executionAssetsChanged).toBe(true)
    expect(((receipt.sourceAssets as Record<string, unknown>).diff as Record<string, unknown>).modified)
      .toEqual(['tests/cases/helper.mjs'])
  }, REAL_PROCESS_TIMEOUT)

  it('QA 自测失败轮的证据在后续通过后仍然可审计', async () => {
    const f = await qaFixture({ sourceBeforeRegister: true, markerMode: true })
    await writeFile(path.join(f.workspaceDir, 'mode'), 'fail\n')
    const first = await f.service.run('qa-child', {}, f.exec)
    expect(first.exitCode).toBe(1)
    expect(first.succeeded).toBe(false)
    expect(first.trusted).toBe(true)
    await writeFile(path.join(f.workspaceDir, 'mode'), 'pass\n')
    const second = await f.service.run('qa-child', {}, f.exec)
    expect(second.exitCode).toBe(0)
    expect(second.succeeded).toBe(true)

    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    expect(receipts.receipts).toHaveLength(2)
    const firstReceipt = receipts.receipts[0]!
    const secondReceipt = receipts.receipts[1]!
    expect(firstReceipt.receipt.kind).toBe('selftest')
    expect(firstReceipt.receipt.exitCode).toBe(1)
    // 第一轮失败证据仍按原内容落盘，后续通过只归档为第二轮 prior。
    const firstDir = path.dirname(firstReceipt.path)
    const archived = JSON.parse(await readFile(path.join(f.workspaceDir, firstDir, 'current/evidence/binding.json'), 'utf8')) as Record<string, unknown>
    expect(archived.ok).toBe(false)
    const prior = (secondReceipt.receipt.archives as Record<string, unknown>).prior as Record<string, unknown>
    expect(prior.cases).toMatchObject([{ id: 'TC-1', status: 'failed' }])
  }, REAL_PROCESS_TIMEOUT)

  it('未受信 caseCommand 仍然拒绝', async () => {
    const f = await qaFixture({ caseCommand: 'node evil.mjs' })
    await expect(f.service.run('qa-child', {}, f.exec)).rejects.toThrow('未受信')
  }, REAL_PROCESS_TIMEOUT)

  it('仓库/worktree 自测不消费空间 QA caseCommand', async () => {
    const f = await qaFixture()
    const repoChildId = 'repo-child'
    const repoChild: Agent = {
      id: repoChildId, options: {}, session: { header: { id: repoChildId, cwd: f.app } }, followup() {}, inject() {},
    }
    f.live.set(repoChildId, repoChild)
    f.permissions.register({ ...f.scope, childId: repoChildId, cwd: f.app })
    await f.service.register({ ...f.registrationInput, childId: repoChildId, sessionId: repoChildId, cwd: f.app })
    const repoExec = { ...f.exec, agent: repoChild } as ToolRunContext
    const result = await f.service.run(repoChildId, {}, repoExec)
    expect(result.commandSource).toBe('package-script')
    expect(result.command).toBe('npm test')
    expect(result.succeeded).toBe(true)
  }, REAL_PROCESS_TIMEOUT)
})

describe('标准流程 runCases 执行入口绑定', () => {
  it('默认钩子使用空间根源脚本和 integration cwd，保留审计副本', async () => {
    const f = await repoFixture()
    const program = await seedRunCases(f)
    const result = await withBaseline(f.baseline, () => runCases(runCasesContext(f)))
    expect(result).toEqual({
      data: { total: 1, failures: [], executionId: expect.any(String), receipt: expect.any(String), trusted: true },
    })
    expect(await readFile(path.join(f.integration, TEST_SCRIPT), 'utf8')).toBe(program)
    const binding = JSON.parse(await readFile(path.join(f.workspaceDir, 'evidence/binding.json'), 'utf8')) as Record<string, unknown>
    expect(binding).toMatchObject({
      cwd: f.integration,
      scriptPath: path.join(f.root, TEST_SCRIPT),
      baseline: f.baseline,
      helper: 'helper-ok',
      ok: true,
    })

    // 真实两个 Git 根：receipt 的 Git 身份必须来自 integration 工作树，而不是空间根。
    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    expect(receipts.receipts).toHaveLength(1)
    const receipt = receipts.receipts[0]!.receipt
    const git = receipt.git as Record<string, unknown>
    const before = git.before as Record<string, unknown>
    expect(git.cwd).toBe(f.integration)
    expect(before.revision).toBe(f.integrationHead)
    expect(before.revision).not.toBe(f.rootRevision)
    expect(before.branch).toBe(BRANCH)
    expect(git.baselineRevision).toBe(f.baseline)
    expect(git.baselineSource).toBe('host-process')
    expect(receipt.exitCode).toBe(0)
    expect(receipt.status).toBe('executed')
    expect(String(receipt.actualCommand)).toContain(path.join(f.root, TEST_SCRIPT))
    expect((receipt.archives as Record<string, unknown>).current).not.toBeNull()
  }, REAL_PROCESS_TIMEOUT)

  it('基线只取用例命令实际的 config.env，并优先于无关宿主环境变量', async () => {
    const f = await repoFixture()
    await seedRunCases(f)
    const config = JSON.parse(await readFile(path.join(f.root, 'takt.config.json'), 'utf8')) as Record<string, unknown>
    config.environment = { deploy: 'true', env: { TAKT_REGRESSION_BASELINE_REV: f.baseline } }
    await writeFile(path.join(f.root, 'takt.config.json'), `${JSON.stringify(config, null, 2)}\n`)
    // 宿主环境同名变量是无关值：命令实际拿到的是 config.env 里的值。
    const result = await withBaseline('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', () => runCases(runCasesContext(f)))
    expect(result).toMatchObject({ data: { total: 1, failures: [] } })
    const binding = JSON.parse(await readFile(path.join(f.workspaceDir, 'evidence/binding.json'), 'utf8')) as Record<string, unknown>
    expect(binding.baseline).toBe(f.baseline)
    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    const git = receipts.receipts[0]!.receipt.git as Record<string, unknown>
    expect(git.baselineRevision).toBe(f.baseline)
    expect(git.baselineSource).toBe('environment.env')
  }, REAL_PROCESS_TIMEOUT)

  it('命令在产出结果前失败时，receipt 记录实际尝试执行的绑定命令与空 exitCode', async () => {
    const f = await repoFixture()
    await seedRunCases(f)
    const config = JSON.parse(await readFile(path.join(f.root, 'takt.config.json'), 'utf8')) as Record<string, unknown>
    config.environment = { deploy: 'true', env: { TAKT_REGRESSION_BASELINE_REV: '${TAKT_ENV_VAR_UNSET_FOR_TEST}' } }
    await writeFile(path.join(f.root, 'takt.config.json'), `${JSON.stringify(config, null, 2)}\n`)
    const previous = process.env.TAKT_ENV_VAR_UNSET_FOR_TEST
    delete process.env.TAKT_ENV_VAR_UNSET_FOR_TEST
    try {
      await expect(runCases(runCasesContext(f))).rejects.toThrow('TAKT_ENV_VAR_UNSET_FOR_TEST')
    } finally {
      if (previous !== undefined) process.env.TAKT_ENV_VAR_UNSET_FOR_TEST = previous
    }
    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    const receipt = receipts.receipts[0]!.receipt
    expect(receipt.status).toBe('blocked')
    expect(receipt.exitCode).toBeNull()
    expect(receipt.actualCommand).toBe(`'node' '${path.join(f.root, TEST_SCRIPT)}'`)
    expect(receipt.actualCommand).not.toBe(receipt.configuredCommand)
    expect(String(receipt.error)).toContain('TAKT_ENV_VAR_UNSET_FOR_TEST')
  }, REAL_PROCESS_TIMEOUT)

  it('执行期间 helper 变化时显式 blocked，receipt 记录不可信与变更清单', async () => {
    const f = await repoFixture()
    await seedRunCases(f, { helperTamper: true })
    const result = await withBaseline(f.baseline, () => runCases(runCasesContext(f)))
    expect(result).toEqual({ status: 'blocked', message: '空间 QA 源资产在执行期间发生变化，本轮执行不可信' })
    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    const receipt = receipts.receipts[0]!.receipt
    expect(receipt.trusted).toBe(false)
    const sourceAssets = receipt.sourceAssets as Record<string, unknown>
    const diff = sourceAssets.diff as Record<string, unknown>
    expect(diff.changed).toBe(true)
    expect(diff.modified).toEqual(['tests/cases/helper.mjs'])
  }, REAL_PROCESS_TIMEOUT)

  it('失败轮次的用例证据不被后续通过覆盖，质量报告给出失败/恢复关联', async () => {
    const f = await repoFixture()
    await seedRunCases(f, { markerMode: true })
    await writeFile(path.join(f.workspaceDir, 'mode'), 'fail\n')
    const first = await withBaseline(f.baseline, () => runCases(runCasesContext(f, { iteration: 1 })))
    expect(first).toMatchObject({ data: { total: 1, failures: [{ subject: 'TC-1', status: 'failed' }] } })
    await writeFile(path.join(f.workspaceDir, 'mode'), 'pass\n')
    const second = await withBaseline(f.baseline, () => runCases(runCasesContext(f, { iteration: 2 })))
    expect(second).toMatchObject({ data: { total: 1, failures: [] } })

    const receipts = await readExecutionReceipts(f.workspaceDir, RUN_ID)
    expect(receipts.errors).toEqual([])
    expect(receipts.receipts).toHaveLength(2)
    const firstReceipt = receipts.receipts[0]!
    const secondReceipt = receipts.receipts[1]!
    expect(firstReceipt.receipt.exitCode).toBe(1)
    expect((firstReceipt.receipt.caseSummary as Record<string, unknown>).cases)
      .toEqual([{ id: 'TC-1', status: 'failed', evidence: 'evidence/binding.json' }])

    // 第一轮的失败证据归档必须原样保留（后续通过不能覆盖历史）。
    const firstDir = path.dirname(firstReceipt.path)
    const archivedBinding = JSON.parse(await readFile(path.join(f.workspaceDir, firstDir, 'current/evidence/binding.json'), 'utf8')) as Record<string, unknown>
    expect(archivedBinding.ok).toBe(false)
    expect(JSON.parse(await readFile(path.join(f.workspaceDir, firstReceipt.path), 'utf8'))).toMatchObject({ exitCode: 1, status: 'executed' })

    // 第二轮通过时把上一轮的失败归档为 prior，仍可读。
    const secondPrior = (secondReceipt.receipt.archives as Record<string, unknown>).prior as Record<string, unknown>
    expect(secondPrior.directory).toBe(path.posix.join(path.dirname(secondReceipt.path), 'prior'))
    expect(JSON.parse(await readFile(path.join(f.workspaceDir, `${secondPrior.directory}/evidence/summary.json`), 'utf8')))
      .toMatchObject({ cases: [{ id: 'TC-1', status: 'failed' }] })

    await qualityReport(runCasesContext(f, { iteration: 2 }))
    const quality = await readFile(path.join(f.workspaceDir, 'reports/quality.md'), 'utf8')
    expect(quality).toContain(`TC-1：首次 failed`)
    expect(quality).toContain('后续通过')
    expect(quality).toContain(firstReceipt.path)
  }, REAL_PROCESS_TIMEOUT)
})
describe('标准流程 DAG 与共享 helper', () => {
  it('automate 在 integration 之后，评审与 Loop 顺序不变且无环', async () => {
    const source = await readFile(path.resolve('vendor/taktflow/templates/workflows/taktflow-standard.workflow.ts'), 'utf8')
    const file = ts.createSourceFile('taktflow-standard.workflow.ts', source, ts.ScriptTarget.Latest, true)
    const nodes = new Map<string, string[]>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['agent', 'script', 'gate', 'human', 'judge', 'loop', 'planner', 'review', 'subflow'].includes(node.expression.text)) {
        const object = node.arguments[0]
        if (object !== undefined && ts.isObjectLiteralExpression(object)) {
          const id = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name?.getText(file) === 'id')
          const needs = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && item.name?.getText(file) === 'needs')
          if (id !== undefined && ts.isStringLiteral(id.initializer)) {
            const values = needs !== undefined && ts.isArrayLiteralExpression(needs.initializer)
              ? needs.initializer.elements.filter(ts.isStringLiteral).map((item) => item.text)
              : []
            nodes.set(id.initializer.text, values)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(nodes.get('automate')).toEqual(['freeze', 'integration'])
    expect(nodes.get('integration')).toEqual(['implement'])
    expect(nodes.get('review-scripts')).toEqual(['automate'])
    expect(nodes.get('dev-test-loop')).toEqual(['integration', 'review-scripts', 'env-setup'])
    const visiting = new Set<string>()
    const done = new Set<string>()
    const check = (id: string): void => {
      if (done.has(id)) return
      if (visiting.has(id)) throw new Error(`DAG 存在环：${id}`)
      visiting.add(id)
      for (const need of nodes.get(id) ?? []) if (nodes.has(need)) check(need)
      visiting.delete(id)
      done.add(id)
    }
    for (const id of nodes.keys()) check(id)

    const hooks = await readFile(path.resolve('vendor/taktflow/templates/workflows/taktflow-standard.hooks.ts'), 'utf8')
    expect(hooks).toContain('bindWorkspaceQaCommand')
    expect(hooks).toContain('selectWorkspaceQaIntegration')
    expect(hooks).toContain('binding.sourceScript')
  })

  it('共享 helper 只绑定 node + 单个空间根相对脚本', () => {
    const root = path.resolve('/tmp/qa-space')
    const source = path.join(root, 'tests/run-cases.mjs')
    expect(bindWorkspaceQaCommand('node tests/run-cases.mjs', 'tests/run-cases.mjs', root))
      .toEqual({ kind: 'bound', command: `'node' '${source}'`, testScript: 'tests/run-cases.mjs', sourceScript: source })
    expect(bindWorkspaceQaCommand('npm test', undefined, root)).toEqual({ kind: 'unbound' })
    expect(bindWorkspaceQaCommand('node --test tests/run-cases.mjs', undefined, root)).toMatchObject({ kind: 'error' })
    expect(bindWorkspaceQaCommand('node ../run-cases.mjs', undefined, root)).toMatchObject({ kind: 'error' })
    expect(bindWorkspaceQaCommand('node tests/run-cases.mjs', 'tests/other.mjs', root)).toMatchObject({ kind: 'error' })
  })

  it('共享选择器接受 data 包装和主仓库工作树，拒绝其它运行与空间外路径', () => {
    const root = path.resolve('/tmp/qa-space')
    const tree = { path: path.join(root, '.takt/worktrees/run-1/integration'), branch: 'takt/run-1/integration' }
    const result = { data: { repo: 'app', ...tree, merged: [], conflicts: [], repositories: { app: tree } } }
    expect(selectWorkspaceQaIntegration(result, 'run-1', 'app', root)).toEqual({
      kind: 'selected', integration: { repo: 'app', path: tree.path, branch: tree.branch },
    })
    expect(selectWorkspaceQaIntegration({ ...result, data: { ...result.data, branch: 'takt/run-2/integration', repositories: { app: { ...tree, branch: 'takt/run-2/integration' } } } }, 'run-1', 'app', root))
      .toMatchObject({ kind: 'error' })
    expect(selectWorkspaceQaIntegration({ ...result, data: { ...result.data, repo: 'web' } }, 'run-1', 'app', root))
      .toMatchObject({ kind: 'error' })
    expect(selectWorkspaceQaIntegration({ ...result, data: { ...result.data, path: path.resolve('/tmp/outside'), repositories: { app: { ...tree, path: path.resolve('/tmp/outside') } } } }, 'run-1', 'app', root))
      .toMatchObject({ kind: 'error' })
  })
})
