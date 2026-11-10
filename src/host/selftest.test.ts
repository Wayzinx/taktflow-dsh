import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import {
  agent,
  initProject,
  type AgentProfile,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import { LEAD_TOOL_NAMES } from './lead/tools.js'
import { DshRolePresets } from './presets.js'
import { supportsDshOutputSchema } from './dsh-schema.js'
import { apply, type RoleContext } from './role/index.js'
import { createSelftestTool, SELFTEST_TOOL_NAME } from './role/selftest.js'
import { InMemoryPermissionRegistry } from './permissions.js'
import {
  buildSelftestCommand, classifyRunner, InMemorySelftestService, readPackageSnapshot,
  type SelftestContextInput, type SelftestServiceOptions,
} from './selftest.js'
import { FsSpaceRegistry } from './space.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { Agent, HostContext, JsonValue, ToolRunContext } from './dsh-types.js'
import type { Ownership, PermissionScope, SpaceHandle, TaktflowService } from './types.js'

const roots: string[] = []
const services: InMemorySelftestService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const nodeRef = { runId: 'run-1', nodeId: 'work', attempt: 1 }
const childId = 'child-1'

function fakeAgent(id = childId, cwd = path.resolve('space-fixture')): Agent {
  return { id, options: {}, session: { header: { id, cwd } }, followup() {}, inject() {} }
}

function fakeExec(signal: AbortSignal, child: Agent = fakeAgent()): ToolRunContext {
  return {
    callId: 'call-1', rootCallId: 'call-1', name: SELFTEST_TOOL_NAME,
    arguments: {}, agent: child, signal, token: Symbol('token'),
    deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

interface FixtureOptions {
  selftest?: unknown
  environment?: Record<string, unknown>
  args?: Record<string, unknown>
  workflowId?: string
  writeScope?: string[]
  packageJson?: unknown
  packageText?: string
  workflow?: WorkflowDefinition
  nodeId?: string
  env?: Record<string, string>
  serviceOptions?: Partial<Omit<SelftestServiceOptions, 'permissions'>>
}

function workflowWithOutputs(outputs: Array<{ path: string; kind: 'task' | 'spec' }> = [], strictOutputs = false): WorkflowDefinition {
  return {
    id: 'test', title: '测试', version: '1', stages: [],
    nodes: [agent({ id: 'work', title: '实现', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '完成', outputs, strictOutputs })],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function own(ensureLease: Ownership['ensureLease']): Ownership {
  return { ensureLease } as Ownership
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-selftest-'))
  roots.push(root)
  if (options.packageJson !== undefined) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify(options.packageJson))
  }
  if (options.packageText !== undefined) await writeFile(path.join(root, 'package.json'), options.packageText)
  const stores = await initProject(root)
  const spaces = new FsSpaceRegistry()
  const space = await spaces.open(root)
  const config = space.stores.config as unknown as Record<string, unknown>
  if (options.selftest !== undefined) config.selftest = options.selftest
  if (options.environment !== undefined) config.environment = options.environment
  const requirementId = (await space.stores.workspaces.createRequirement({ title: '受控自测' })).id
  const run: RunState = {
    runId: 'run-1', workflowId: options.workflowId ?? 'test', workflowVersion: '1',
    requirementId, status: 'running', startedAt: new Date().toISOString(),
    args: options.args ?? {},
    nodes: { [options.nodeId ?? nodeRef.nodeId]: { id: options.nodeId ?? nodeRef.nodeId, status: 'running', attempts: 1, outputs: [] } }, expansions: [],
  }
  await space.stores.runs.save(run)
  const cwd = await realpath(root)
  const artifactRoot = await realpath(space.stores.workspaces.dir(requirementId))
  const writeScope = options.writeScope ?? ['requirements/**/tasks/**', 'requirements/**/evidence/**']
  const permissions = new InMemoryPermissionRegistry()
  const scope: PermissionScope = {
    childId, nodeRef: { ...nodeRef, ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }) },
    cwd, spaceRoot: cwd, artifactRoot, writeScope, allowBash: false, readOnly: false,
  }
  permissions.register(scope)
  const controller = new AbortController()
  const child = fakeAgent(childId, cwd)
  const live = new Map([[childId, child]])
  const rootAgents: Agent[] = []
  const agents: HostContext['agents'] = { get: (id) => live.get(id), roots: () => [...rootAgents] }
  const service = new InMemorySelftestService({ permissions, agents, ...options.serviceOptions })
  services.push(service)
  const registrationInput: SelftestContextInput = {
    childId, space, nodeRef: scope.nodeRef, role: 'dev', requirementId,
    cwd, env: options.env ?? {}, writeScope, signal: controller.signal, sessionId: 'session-1',
    workflow: options.workflow ?? workflowWithOutputs(),
  }
  const registration = await service.register(registrationInput)
  return {
    root, stores, space, requirementId, permissions, service, registration,
    controller, exec: fakeExec(controller.signal, child), scope, registrationInput,
    agents, child, live, rootAgents,
  }
}

const envCommand = (text: string) => ({ deploy: 'true', testCommand: text })

/**
 * 在空间根下注册一个仓库/worktree 子 Agent，cwd 不等于 space.root。
 * 生产里 dev 的 .takt/worktrees 工作树就是这种形态；这里只用于验证命令作用域隔离。
 */
async function registerRepo(
  f: Awaited<ReturnType<typeof fixture>>,
  packageJson: unknown = { scripts: { test: 'node -e "console.log(\'repo-package\')"' } },
) {
  const repo = path.join(f.root, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(path.join(repo, 'package.json'), JSON.stringify(packageJson))
  const child = fakeAgent('repo-child', repo)
  f.live.set(child.id, child)
  f.permissions.register({ ...f.scope, childId: child.id, cwd: repo })
  await f.service.register({ ...f.registrationInput, childId: child.id, sessionId: child.id, cwd: repo })
  const exec = fakeExec(f.controller.signal, child)
  return { repo, child, exec, run: (args: unknown = {}) => f.service.run(child.id, args, exec) }
}

describe('受控自测命令与过滤', () => {
  it('拒绝 command/cwd/env 和注入字符，且不产生副作用', async () => {
    const marker = 'selftest-pwned'
    const f = await fixture({
      environment: envCommand(`node -e "require('fs').writeFileSync('${marker}','x')"`),
    })
    const attacks = [
      { mode: 'files', files: [`a.test.ts;touch ${marker}`] },
      { mode: 'files', files: [`$(touch ${marker})`] },
      { mode: 'files', files: ['`touch ' + marker + '`'] },
      { mode: 'files', files: [`a.test.ts\ntouch ${marker}`] },
      { mode: 'files', files: ['--runInBand'] },
      { mode: 'name', name: `; touch ${marker}` },
      { command: 'rm -rf /' },
      { cwd: '.' }, { env: { DANGEROUS: '1' } }, { timeout: 0 }, { timeoutMs: 0 },
    ]
    for (const args of attacks) {
      await expect(f.service.run(childId, args, f.exec)).rejects.toThrow()
    }
    await expect(readFile(path.join(f.root, marker))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('可信 run.args 优先；未授权 args 明确拒绝，不回退其它命令', async () => {
    const caseCommand = `node -e "console.log('case')"`
    const testCommand = `node -e "console.log('test')"`
    const f = await fixture({
      packageJson: { scripts: { test: `node -e "console.log('package')"` } },
      selftest: { allowedCommands: [caseCommand] },
      args: { caseCommand, testCommand },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.commandSource).toBe('run-args:caseCommand')
    expect(result.command).toBe(caseCommand)
    expect(result.outputTail).toContain('case')

    const denied = await fixture({
      packageJson: { scripts: { test: `node -e "console.log('package')"` } },
      args: { caseCommand: `node -e "console.log('nope')"` },
    })
    await expect(denied.service.run(childId, {}, denied.exec)).rejects.toThrow('未受信')
  })

  it('environment.testCommand 优先于 package test；没有可用配置时明确失败', async () => {
    const f = await fixture({
      packageJson: { scripts: { test: `node -e "console.log('package')"` } },
      environment: envCommand(`node -e "console.log('env')"`),
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.commandSource).toBe('environment.testCommand')
    expect(result.outputTail).toContain('env')

    const missing = await fixture()
    await expect(missing.service.run(childId, {}, missing.exec)).rejects.toThrow('没有 package.json test 脚本')
  })
})

describe('仓库与空间自测命令隔离', () => {
  it('仓库 worktree 忽略仅用于空间 QA 的 caseCommand，执行仓库 package test', async () => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>().mockResolvedValue({ code: 0, output: '' })
    const f = await fixture({
      packageJson: { scripts: { test: 'node --test' } },
      selftest: { allowedCommands: ['node tests/run-cases.mjs'] },
      args: { caseCommand: 'node tests/run-cases.mjs' },
      serviceOptions: { runCommand },
    })
    const before = JSON.stringify((await f.space.stores.runs.get(nodeRef.runId))!.args)
    const repo = await registerRepo(f, { scripts: { test: 'node --test' } })
    const result = await repo.run()
    expect(result).toMatchObject({ commandSource: 'package-script', command: 'npm test', succeeded: true })
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual(['npm test'])
    // 解析和登记不能改写原始 run.args。
    expect(JSON.stringify((await f.space.stores.runs.get(nodeRef.runId))!.args)).toBe(before)
  })

  it('仓库 worktree 的显式 testCommand 未受信时拒绝，即使 caseCommand 已受信也不回退', async () => {
    const caseCommand = 'node tests/run-cases.mjs'
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({
      selftest: { allowedCommands: [caseCommand] },
      args: { caseCommand, testCommand: `node -e "console.log('untrusted')"` },
      serviceOptions: { runCommand },
    })
    const repo = await registerRepo(f)
    await expect(repo.run()).rejects.toThrow('启动参数 testCommand 未受信')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('空间根只执行精确白名单的 QA caseCommand，近似命令拒绝且不回退 package test', async () => {
    const qa = 'node tests/run-cases.mjs'
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>().mockResolvedValue({ code: 0, output: '' })
    const f = await fixture({
      packageJson: { scripts: { test: 'node --test' } },
      selftest: { allowedCommands: [qa] },
      args: { caseCommand: qa },
      serviceOptions: { runCommand },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result).toMatchObject({ commandSource: 'run-args:caseCommand', command: qa, succeeded: true })
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual([qa])

    const deniedRun = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const denied = await fixture({
      packageJson: { scripts: { test: 'node --test' } },
      selftest: { allowedCommands: [qa] },
      args: { caseCommand: `${qa} --watch` },
      serviceOptions: { runCommand: deniedRun },
    })
    await expect(denied.service.run(childId, {}, denied.exec)).rejects.toThrow('启动参数 caseCommand 未受信')
    expect(deniedRun).not.toHaveBeenCalled()
  })

  it('仓库自测仍执行冻结 package scripts 校验', async () => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({
      selftest: { allowedCommands: ['node tests/run-cases.mjs'] },
      args: { caseCommand: 'node tests/run-cases.mjs' },
      serviceOptions: { runCommand },
    })
    const repo = await registerRepo(f, { scripts: { test: 'node --test' } })
    await writeFile(path.join(repo.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test --watch' } }))
    await expect(repo.run()).rejects.toThrow('执行前已变化')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('真实执行后的 SelftestResult 通过 DSH lossless JSON 校验', async () => {
    const f = await fixture({
      selftest: { allowedCommands: ['node tests/run-cases.mjs'] },
      args: { caseCommand: 'node tests/run-cases.mjs' },
    })
    const repo = await registerRepo(f, {
      scripts: { test: `node -e "console.log(JSON.stringify({passed:1,failed:0}))"` },
    })
    const result = await repo.run()
    expect(result).toMatchObject({ succeeded: true, passed: 1, failed: 0 })
    expect(isJsonValue(result)).toBe(true)
  })
})

describe('受控自测执行与证据', () => {
  it('package scripts 执行前变化时拒绝执行', async () => {
    const f = await fixture({ packageJson: { scripts: { test: 'node -e "console.log(1)"' } } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(2)"' } }))
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('执行前已变化')
  })

  it('package scripts 执行中变化时不宣称可信或通过', async () => {
    const f = await fixture({
      packageJson: { scripts: { test: 'node -e "console.log(1)"' } },
      environment: envCommand(`node -e "require('fs').writeFileSync('package.json','changed')"`),
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.exitCode).toBe(0)
    expect(result.scriptsChanged).toBe(true)
    expect(result.trusted).toBe(false)
    expect(result.succeeded).toBe(false)
  })

  it('超时由进程组终止，延迟写入不会发生', async () => {
    const f = await fixture({
      selftest: { timeoutMs: 1000 },
      environment: envCommand(`node -e "setTimeout(()=>require('fs').writeFileSync('late-marker','x'),1500)"`),
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.timedOut).toBe(true)
    expect(result.succeeded).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 800))
    await expect(readFile(path.join(f.root, 'late-marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('取消结束并等待子进程，延迟写入不会发生', async () => {
    const f = await fixture({
      environment: envCommand(`node -e "setTimeout(()=>require('fs').writeFileSync('late-cancel','x'),1200)"`),
    })
    const running = f.service.run(childId, {}, f.exec)
    setTimeout(() => f.registration.cancel(new Error('测试取消')), 100)
    const result = await running
    expect(result.cancelled).toBe(true)
    expect(result.succeeded).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1400))
    await expect(readFile(path.join(f.root, 'late-cancel'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('尾部固定 8KB、UTF-8 安全且脱敏跨边界密钥', async () => {
    const secret = 'SUPER-SECRET-12345'
    process.env.TAKT_TEST_SECRET = secret
    try {
      const f = await fixture({
        environment: {
          deploy: 'true',
          env: { LEAK: '${TAKT_TEST_SECRET}' },
          testCommand: `node -e "process.stdout.write('中'.repeat(5000));console.log(process.env.LEAK)"`,
        },
      })
      const result = await f.service.run(childId, {}, f.exec)
      expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(8192)
      expect(Buffer.byteLength(result.outputTail)).toBeGreaterThan(4096)
      expect(result.outputTail).toContain('中')
      expect(result.outputTail).not.toContain(secret)
      expect(result.outputTail).toContain('[REDACTED]')
      expect(result.outputTail).not.toContain('\uFFFD')
    } finally {
      delete process.env.TAKT_TEST_SECRET
    }
  })

  it('证据写入精确版本并带顶层归属字段；无 scope 时只返回结果', async () => {
    const f = await fixture({ environment: envCommand(`node -e "console.log('ok')"`) })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.evidence).not.toBeNull()
    expect(result.evidence!.version).toBe(1)
    const content = await f.space.stores.workspaces.readArtifact({
      workspace: result.evidence!.workspace, path: result.evidence!.path, version: result.evidence!.version,
    })
    const payload = JSON.parse(content!.toString('utf8')) as Record<string, unknown>
    expect(payload).toMatchObject({
      runId: 'run-1', nodeId: 'work', attempt: 1, sessionId: 'session-1',
      exitCode: 0, succeeded: true, source: 'environment.testCommand',
    })
    expect(typeof payload.startedAt).toBe('string')
    expect(typeof payload.endedAt).toBe('string')
    expect(typeof payload.commandHash).toBe('string')

    const noScope = await fixture({
      environment: envCommand(`node -e "console.log('ok')"`),
      writeScope: ['src/**'],
    })
    const noEvidence = await noScope.service.run(childId, {}, noScope.exec)
    expect(noEvidence.evidence).toBeNull()
    expect(noEvidence.evidenceReason).toContain('不允许')
  })

  it('strictOutputs 节点只写声明覆盖的证据路径', async () => {
    const workflow = (outputs: Array<{ path: string; kind: 'task' | 'spec' }>): WorkflowDefinition => ({
      id: 'test', title: '测试', version: '1', stages: [],
      nodes: [agent({
        id: 'work', title: '实现', role: 'dev', harness: { harness: 'dsh-host' },
        prompt: '完成', outputs, strictOutputs: true,
      })],
    })
    const allowed = await fixture({
      environment: envCommand(`node -e "console.log('ok')"`),
      workflow: workflow([{ path: 'tasks/**', kind: 'task' }]),
    })
    expect((await allowed.service.run(childId, {}, allowed.exec)).evidence).not.toBeNull()

    const blocked = await fixture({
      environment: envCommand(`node -e "console.log('ok')"`),
      workflow: workflow([{ path: 'spec/**', kind: 'spec' }]),
    })
    const result = await blocked.service.run(childId, {}, blocked.exec)
    expect(result.evidence).toBeNull()
    expect(result.evidenceReason).toContain('strictOutputs')
  })
})

describe('角色与 preset 挂载隔离', () => {
  it('只有 selftest=true 的角色注册 takt_selftest；service 缺失时明确拒绝', async () => {
    const enabled = new FakeHostContext()
    Object.assign(enabled, { taktflow: { selftests: undefined } as unknown as TaktflowService })
    apply(enabled as unknown as RoleContext, { role: 'dev', selftest: true, readOnly: false, writeScope: ['src/**'] })
    expect(enabled.toolDefinitions.map((tool) => tool.name)).toEqual(['skill', SELFTEST_TOOL_NAME])
    const tool = enabled.toolDefinitions.find((item) => item.name === SELFTEST_TOOL_NAME)!
    await expect(tool.execute({}, fakeExec(new AbortController().signal))).rejects.toThrow('没有受控自测服务')

    const disabled = new FakeHostContext()
    disabled.setService('taktflow', { selftests: undefined } as unknown as TaktflowService)
    apply(disabled as unknown as RoleContext, { role: 'dev', selftest: false })
    expect(disabled.toolDefinitions.map((tool) => tool.name)).toEqual(['skill'])
    expect(LEAD_TOOL_NAMES).not.toContain(SELFTEST_TOOL_NAME)
  })

  it('preset 按实际写入范围与只读状态决定是否挂自测', async () => {
    const ctx = new FakeHostContext()
    ctx.setService('agentPresets', ctx.agentPresets)
    const profile: AgentProfile = {
      role: 'dev', title: '开发', description: '', instructions: '',
      harness: { harness: 'dsh-host' }, skills: [], writeScope: ['src/**'], allowBash: false,
    }
    const presets = new DshRolePresets(ctx, { profiles: { dev: profile } })
    const space = { root: path.resolve('space-fixture') } as SpaceHandle
    const configOf = () => {
      const rows = ctx.presets.at(-1)!.plugins as Array<{ id: string; config?: Record<string, unknown> }>
      return rows.find((row) => row.id === 'taktflow-role')!.config!
    }

    const writable = await presets.acquire(space, 'dev', { readOnly: false, allowBash: false, writeScope: ['src/**'] })
    expect(configOf().selftest).toBe(true)
    await writable.release()

    const readOnly = await presets.acquire(space, 'dev', { readOnly: true, allowBash: false, writeScope: ['src/**'] })
    expect(configOf().selftest).toBe(false)
    await readOnly.release()

    const empty = await presets.acquire(space, 'dev', { readOnly: false, allowBash: false, writeScope: [] })
    expect(configOf().selftest).toBe(false)
    await empty.release()
  })

  it.each([
    { readOnly: true, writeScope: ['src/**'] },
    { readOnly: false, writeScope: [] },
    { readOnly: false },
  ])('即使显式 selftest=true，也不对只读或无写入范围角色挂载：%j', (scope) => {
    const ctx = new FakeHostContext()
    Object.assign(ctx, { taktflow: { selftests: undefined } as unknown as TaktflowService })
    apply(ctx as unknown as RoleContext, { role: 'dev', selftest: true, ...scope })
    expect(ctx.toolDefinitions.map((tool) => tool.name)).toEqual(['skill'])
  })
})

describe('命令冻结与可靠过滤', () => {
  it.each([
    ['缺失后新建', undefined],
    ['非法 JSON 后修复', '{broken'],
  ] as const)('登记时 package.json %s 不能解锁 npm 命令', async (_name, packageText) => {
    const f = await fixture({
      ...(packageText === undefined ? {} : { packageText }),
      selftest: { allowedCommands: ['npm test'] }, args: { caseCommand: 'npm test' },
    })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({
      scripts: { test: `node -e "require('fs').writeFileSync('untrusted-test','x')"` },
    }))
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow()
    await expect(readFile(path.join(f.root, 'untrusted-test'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('无 package.json 的 run.args npm test 不天然获得授权', async () => {
    const f = await fixture({ args: { caseCommand: 'npm test' } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow()
  })

  it.each(['pretest', 'posttest', 'other'])('冻结整个 scripts，新增 %s 也拒绝执行', async (key) => {
    const scripts = { test: 'node -e "console.log(1)"' }
    const f = await fixture({ packageJson: { scripts } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { ...scripts, [key]: 'echo changed' } }))
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('执行前已变化')
  })

  it.each([
    ['npm test', { test: 'vitest run' }, 'vitest'],
    ['npm run test', { test: 'jest --runInBand' }, 'jest'],
    ['node --test', undefined, 'node-test'],
    ['npm test', { test: 'node custom-runner.js', pretest: 'vitest run' }, 'unknown'],
    ['npm test', { test: 'node -e "console.log(\'vitest\')"' }, 'unknown'],
    ['npm test', { test: 'vitest run && node post.js' }, 'unknown'],
    ['node -e "console.log(\'jest\')"', undefined, 'unknown'],
  ] as const)('仅从实际测试主入口识别 runner：%s / %j', (command, scripts, expected) => {
    expect(classifyRunner(command, scripts)).toBe(expected)
  })

  // 真实空间的命令形状：环境变量前缀 + venv 解释器 + unittest discover
  const UNITTEST = 'CASE_ROOT=/srv/case-source /srv/case-source/.venv/bin/python -m unittest discover -s case_portal/tests -t .'
  it.each([
    [UNITTEST, 'unittest'],
    ['python3 -m unittest', 'unittest'],
    ['python -m unittest discover -v', 'unittest'],
    ['.venv/bin/python -m pytest -q case_portal/tests', 'pytest'],
    ['pytest --maxfail=1 -x tests', 'pytest'],
    ['pytest -k smoke tests', 'unknown'],
    ['pytest --rootdir tests', 'unknown'],
    ['python -m unittest discover -s tests && echo done', 'unknown'],
    ["python -m unittest discover -s 'my tests'", 'unknown'],
  ] as const)('识别 Python 测试入口：%s', (command, expected) => {
    expect(classifyRunner(command, undefined)).toBe(expected)
  })

  it.each([
    [UNITTEST, { mode: 'files', files: ['case_portal/tests/test_a.py', 'case_portal/tests/test_b.py'] },
      "CASE_ROOT=/srv/case-source /srv/case-source/.venv/bin/python -m unittest 'case_portal/tests/test_a.py' 'case_portal/tests/test_b.py'"],
    [UNITTEST, { mode: 'name', name: 'StudioTrial' }, `${UNITTEST} -k 'StudioTrial'`],
    ['.venv/bin/python -m pytest -q case_portal/tests', { mode: 'files', files: ['case_portal/tests/test_a.py'] }, ".venv/bin/python -m pytest -q 'case_portal/tests/test_a.py'"],
    ['pytest tests', { mode: 'name', name: 'trial' }, "pytest tests -k 'trial'"],
  ] as const)('Python 入口的文件 / 名称过滤：%s %j', (base, filter, expected) => {
    const runner = classifyRunner(base, undefined)
    expect(buildSelftestCommand(base, filter as never, runner)).toBe(expected)
  })

  it('全量超时的结果提示改用文件过滤；按文件跑的超时不重复提示', () => {
    const render = createSelftestTool(undefined).output!.render!
    const text = (value: Record<string, unknown>) => (render({}, value as never) as Array<{ text: string }>)[0]!.text
    const base = { exitCode: -1, succeeded: false, outputTail: '受控自测超过 600000ms', evidence: null, timedOut: true }
    expect(text({ ...base, filter: { mode: 'all' } })).toContain('改用 mode=files')
    expect(text({ ...base, filter: { mode: 'files', files: ['a.py'] } })).not.toContain('改用 mode=files')
    expect(text({ ...base, timedOut: false, filter: { mode: 'all' } })).not.toContain('超时：')
  })

  it('配置的 unittest 命令按文件过滤实际传给执行器（全量超时时可以只跑相关测试）', async () => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>().mockResolvedValue({ code: 0, output: 'Ran 3 tests in 0.1s\n\nOK\n' })
    const f = await fixture({ environment: envCommand('python3 -m unittest discover -s tests -t .'), serviceOptions: { runCommand } })
    await f.service.run(childId, { mode: 'files', files: ['tests/test_trial.py'] }, f.exec)
    expect(runCommand.mock.calls[0]![0]).toBe("python3 -m unittest 'tests/test_trial.py'")
  })

  it('不能从 pretest 或命令字符串猜测 runner 后附加过滤参数', async () => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({
      packageJson: { scripts: { test: 'node custom-runner.js', pretest: 'vitest run' } },
      serviceOptions: { runCommand },
    })
    await expect(f.service.run(childId, { mode: 'name', name: 'basic case' }, f.exec)).rejects.toThrow('无法可靠')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    ['vitest run', { mode: 'files', files: ['tests/a.test.ts'] }, "npm test -- 'tests/a.test.ts'"],
    ['jest', { mode: 'files', files: ['tests/a.test.ts'] }, "npm test -- --runTestsByPath 'tests/a.test.ts'"],
    ['jest', { mode: 'name', name: 'basic case' }, "npm test -- -t 'basic case'"],
  ])('可识别 runner 的过滤实际传给测试入口：%s', async (script, filter, expected) => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>().mockResolvedValue({ code: 0, output: '' })
    const f = await fixture({ packageJson: { scripts: { test: script } }, serviceOptions: { runCommand } })
    await f.service.run(childId, filter, f.exec)
    expect(runCommand.mock.calls[0]![0]).toBe(expected)
  })

  it('冻结 environment 值、宿主变量与登记输入，不在调用时重新展开', async () => {
    const previous = process.env.TAKT_SELFTEST_FROZEN
    process.env.TAKT_SELFTEST_FROZEN = 'initial-value'
    try {
      const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>().mockResolvedValue({ code: 0, output: '' })
      const f = await fixture({
        environment: { ...envCommand('node -e "process.exit(0)"'), env: { FROZEN: '${TAKT_SELFTEST_FROZEN}' } },
        env: { INPUT: 'original-input' }, serviceOptions: { runCommand },
      })
      process.env.TAKT_SELFTEST_FROZEN = 'changed-value'
      const environment = (f.space.stores.config as unknown as { environment: { env: Record<string, string> } }).environment
      environment.env.FROZEN = 'changed-config'
      f.registrationInput.env.INPUT = 'changed-input'
      await f.service.run(childId, {}, f.exec)
      expect(runCommand).toHaveBeenCalledTimes(1)
      expect(runCommand.mock.calls[0]![2]).toMatchObject({ FROZEN: 'initial-value', INPUT: 'original-input' })
    } finally {
      if (previous === undefined) delete process.env.TAKT_SELFTEST_FROZEN
      else process.env.TAKT_SELFTEST_FROZEN = previous
    }
  })

  it('登记时缺失的环境变量不能静默置空，也不能在登记后补值解锁', async () => {
    const previous = process.env.TAKT_SELFTEST_MISSING
    delete process.env.TAKT_SELFTEST_MISSING
    try {
      const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
      const f = await fixture({
        environment: { ...envCommand('node -e "process.exit(0)"'), env: { REQUIRED: '${TAKT_SELFTEST_MISSING}' } },
        serviceOptions: { runCommand },
      })
      process.env.TAKT_SELFTEST_MISSING = 'late-value'
      await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('TAKT_SELFTEST_MISSING')
      expect(runCommand).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.TAKT_SELFTEST_MISSING
      else process.env.TAKT_SELFTEST_MISSING = previous
    }
  })
})

describe('调用身份、租约与生命周期', () => {
  it.each(['伪造同 id 对象', '离线 child', '根会话', '其它 id'] as const)('%s 无法执行已登记命令', async (kind) => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"'), serviceOptions: { runCommand } })
    let exec = f.exec
    if (kind === '伪造同 id 对象') exec = fakeExec(f.controller.signal, fakeAgent(childId, f.scope.cwd))
    if (kind === '离线 child') f.live.delete(childId)
    if (kind === '根会话') f.rootAgents.push(f.child)
    if (kind === '其它 id') exec = fakeExec(f.controller.signal, fakeAgent('other-child', f.scope.cwd))
    await expect(f.service.run(childId, {}, exec)).rejects.toThrow()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('没有 agents 注册表时拒绝执行', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const service = new InMemorySelftestService({ permissions: f.permissions, runCommand })
    services.push(service)
    await service.register(f.registrationInput)
    await expect(service.run(childId, {}, f.exec)).rejects.toThrow()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('失租在执行命令前拒绝，既不启动进程也不写证据', async () => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const ensureLease = vi.fn<Ownership['ensureLease']>().mockRejectedValue(new Error('TAKT_LEASE_HELD'))
    const f = await fixture({
      environment: envCommand('node -e "process.exit(0)"'), serviceOptions: { runCommand, ownership: own(ensureLease) },
    })
    const writeArtifact = vi.spyOn(f.space.stores.workspaces, 'writeArtifact')
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('TAKT_LEASE_HELD')
    expect(ensureLease).toHaveBeenCalledWith(f.space)
    expect(runCommand).not.toHaveBeenCalled()
    expect(writeArtifact).not.toHaveBeenCalled()
  })

  it('等待租约期间 child 离线时不得启动命令', async () => {
    let blockLease = false
    const lease = deferred<void>()
    const entered = deferred<void>()
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({
      environment: envCommand('node -e "process.exit(0)"'),
      serviceOptions: { runCommand, ownership: own(async () => { if (blockLease) { entered.resolve(); await lease.promise } }) },
    })
    blockLease = true
    const running = f.service.run(childId, {}, f.exec)
    const rejected = expect(running).rejects.toThrow()
    await entered.promise
    f.live.delete(childId)
    lease.resolve()
    await rejected
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each(['节点已结束', '尝试已更新', '运行已结束'] as const)('%s 的旧登记不能再执行', async (change) => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"'), serviceOptions: { runCommand } })
    const run = (await f.space.stores.runs.get(nodeRef.runId))!
    if (change === '节点已结束') run.nodes.work!.status = 'succeeded'
    if (change === '尝试已更新') run.nodes.work!.attempts = 2
    if (change === '运行已结束') run.status = 'succeeded'
    await f.space.stores.runs.save(run)
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('并发登记同一个 child 只接受一次', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const entered = deferred<void>()
    const gate = deferred<void>()
    const service = new InMemorySelftestService({
      permissions: f.permissions, agents: f.agents,
      readPackage: async (cwd) => { entered.resolve(); await gate.promise; return readPackageSnapshot(cwd) },
    })
    services.push(service)
    const first = service.register(f.registrationInput)
    await entered.promise
    const second = service.register(f.registrationInput)
    const rejected = expect(second).rejects.toThrow('已登记')
    gate.resolve()
    await rejected
    await (await first).release()
  })

  it('卸载等待未完成的登记，并拒绝它在卸载后重新进入', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const entered = deferred<void>()
    const gate = deferred<void>()
    const service = new InMemorySelftestService({
      permissions: f.permissions, agents: f.agents,
      readPackage: async (cwd) => { entered.resolve(); await gate.promise; return readPackageSnapshot(cwd) },
    })
    services.push(service)
    const registering = service.register(f.registrationInput)
    const rejected = expect(registering).rejects.toThrow(/卸载|关闭/)
    await entered.promise
    let disposed = false
    const disposal = service.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    await rejected
    await disposal
    await expect(service.run(childId, {}, f.exec)).rejects.toThrow()
    await expect(service.register(f.registrationInput)).rejects.toThrow('卸载')
  })

  it('release 等待执行器收尾，之后不能再调用', async () => {
    const entered = deferred<void>()
    const finished = deferred<void>()
    const runCommand: NonNullable<SelftestServiceOptions['runCommand']> = async (_command, _cwd, _env, signal) => {
      entered.resolve()
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
      await finished.promise
      throw signal!.reason
    }
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"'), serviceOptions: { runCommand } })
    const running = f.service.run(childId, {}, f.exec)
    await entered.promise
    let released = false
    const release = f.registration.release().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    finished.resolve()
    expect((await running).cancelled).toBe(true)
    await release
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow()
  })
})

describe('结构化结果、脱敏与证据边界', () => {
  it('输出没有可靠计数时省略 passed/failed，成功仅由 succeeded 表示', async () => {
    const f = await fixture({ environment: envCommand('node -e "console.log(\'success\')"') })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.succeeded).toBe(true)
    expect(result).not.toHaveProperty('passed')
    expect(result).not.toHaveProperty('failed')
  })

  it('真实命令的最后 JSON 汇总写入工具结果和证据', async () => {
    const f = await fixture({
      environment: envCommand('node -e "console.log(JSON.stringify({passed:1,failed:2}));console.log(JSON.stringify({passed:7,failed:0}))"'),
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result).toMatchObject({ exitCode: 0, succeeded: true, passed: 7, failed: 0 })
    const content = await f.space.stores.workspaces.readArtifact(result.evidence!)
    expect(JSON.parse(content!.toString())).toMatchObject({ succeeded: true, passed: 7, failed: 0 })
  })

  it.each([
    ['Tests  2 failed | 9 passed (11)\nTests  12 passed (12)', 0, 12, 0],
    ['Tests: 1 failed, 3 passed, 4 total', 1, 3, 1],
    ['# tests 6\n# pass 4\n# fail 2', 1, 4, 2],
    ['{"passed":5,"failed":0}', 0, 5, 0],
  ])('只解析本次最后的可靠测试汇总：%s', async (stdout, code, passed, failed) => {
    const text = String(stdout)
    const runCommand: NonNullable<SelftestServiceOptions['runCommand']> = async (_command, _cwd, _env, _signal, options) => {
      options?.redact?.(text)
      return { code: Number(code), output: text }
    }
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"'), serviceOptions: { runCommand } })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result).toMatchObject({ passed, failed, succeeded: code === 0 })
    const evidence = await f.space.stores.workspaces.readArtifact(result.evidence!)
    expect(JSON.parse(evidence!.toString())).toMatchObject({ passed, failed, succeeded: code === 0 })
  })

  it('17 字节密钥重复压缩跨原始缓冲区时不残留前后片段', async () => {
    const secret = 'SECRET-1234567890'
    expect(Buffer.byteLength(secret)).toBe(17)
    const f = await fixture({
      environment: {
        ...envCommand('node -e "process.stdout.write(process.env.LEAK.repeat(5000))"'),
        env: { LEAK: secret },
      },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.succeeded).toBe(true)
    expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(8192)
    expect(result.outputTail).toMatch(/^(?:\[REDACTED\])+$/)
  })

  it('命令、输出和落盘证据使用同一套环境密钥脱敏', async () => {
    const secret = 'credential-value-selftest'
    const f = await fixture({
      environment: { ...envCommand(`node -e "console.log('${secret}')"`), env: { LEAK: secret } },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.command).toContain('[REDACTED]')
    expect(JSON.stringify(result)).not.toContain(secret)
    const content = await f.space.stores.workspaces.readArtifact(result.evidence!)
    expect(content!.toString()).not.toContain(secret)
  })

  it('执行器异常 fallback 也限制为 8KB 且脱敏', async () => {
    const secret = 'fallback-secret-17'
    const f = await fixture({
      environment: { ...envCommand('node -e "process.exit(0)"'), env: { LEAK: secret } },
      serviceOptions: { runCommand: async () => { throw new Error('中'.repeat(7000) + secret) } },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.succeeded).toBe(false)
    expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(8192)
    expect(result.outputTail).not.toContain(secret)
    expect(result.outputTail).not.toContain('\uFFFD')
  })

  it('工具在证据租约等待期间取消后，不会晚到写盘', async () => {
    const entered = deferred<void>()
    const gate = deferred<void>()
    let leaseCalls = 0
    const f = await fixture({
      environment: envCommand('node -e "process.exit(0)"'),
      serviceOptions: { ownership: own(async () => {
        if (++leaseCalls === 2) { entered.resolve(); await gate.promise }
      }) },
    })
    const writeArtifact = vi.spyOn(f.space.stores.workspaces, 'writeArtifact')
    leaseCalls = 0 // 首次登记另有一次基线落盘租约；这里只控制执行后的证据阶段。
    const toolController = new AbortController()
    const running = f.service.run(childId, {}, fakeExec(toolController.signal, f.child))
    await entered.promise
    toolController.abort(new Error('工具调用取消'))
    gate.resolve()
    const result = await running
    expect(result.evidence).toBeNull()
    expect(writeArtifact).not.toHaveBeenCalled()
  })

  it('symlink 指向空间外的 tasks/evidence 不能落盘', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const outside = await mkdtemp(path.join(tmpdir(), 'takt-selftest-outside-'))
    roots.push(outside)
    for (const name of ['tasks', 'evidence']) {
      const directory = path.join(f.scope.artifactRoot!, name)
      await rm(directory, { recursive: true, force: true })
      await symlink(outside, directory)
    }
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.evidence).toBeNull()
    expect(await readdir(outside)).toEqual([])
  })

  it('未知或动态节点无法确认输出合同，只返回结果', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"'), nodeId: 'dynamic/work' })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result.succeeded).toBe(true)
    expect(result.evidence).toBeNull()
    expect(result.evidenceReason).toBeTruthy()
  })

  it('重复调用使用不同的精确证据引用，不覆盖已有版本', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const first = await f.service.run(childId, {}, f.exec)
    const second = await f.service.run(childId, {}, f.exec)
    expect(first.evidence).not.toBeNull()
    expect(second.evidence).not.toBeNull()
    expect(first.evidence!.path).not.toBe(second.evidence!.path)
    expect(first.evidence!.version).toBe(1)
    expect(second.evidence!.version).toBe(1)
    expect(await f.space.stores.workspaces.readArtifact(first.evidence!)).toBeDefined()
  })

  it('工具参数及结果 schema 均满足 dsh 子集，render 保留完整 JSON 字段', async () => {
    const f = await fixture({ environment: envCommand('node -e "process.exit(0)"') })
    const tool = createSelftestTool(f.service)
    expect(supportsDshOutputSchema(tool.parameters)).toBe(true)
    expect(supportsDshOutputSchema(tool.output!.schema)).toBe(true)
    const result = await tool.execute({}, f.exec)
    const rendered = tool.output!.render!({}, result as JsonValue)
    const json = rendered.flatMap((block) => {
      if (block.type !== 'text') return []
      try { return [JSON.parse(block.text)] } catch { return [] }
    })
    expect(json).toEqual([result])
  })
})

describe('同一运行的 package 测试基线', () => {
  const originalScript = 'node -e "console.log(\'baseline-script\')"'
  const changedScript = 'node -e "console.log(\'changed-script\')"'
  async function next(f: Awaited<ReturnType<typeof fixture>>, options: {
    id: string; runId?: string; attempt?: number; cwd?: string; role?: string; service?: InMemorySelftestService;
  }) {
    const run = (await f.space.stores.runs.get(nodeRef.runId))!
    const runId = options.runId ?? run.runId, attempt = options.attempt ?? 2
    await f.space.stores.runs.save({ ...run, runId, nodes: { work: { ...run.nodes.work!, attempts: attempt } } })
    const cwd = await realpath(options.cwd ?? f.scope.cwd)
    const scope = { ...f.scope, childId: options.id, cwd, nodeRef: { ...nodeRef, runId, attempt } }
    f.permissions.register(scope)
    const child = fakeAgent(options.id, cwd); f.live.set(child.id, child)
    const input = { ...f.registrationInput, childId: child.id, sessionId: child.id, nodeRef: scope.nodeRef, cwd, role: options.role ?? 'dev' }
    const service = options.service ?? f.service
    await service.register(input)
    return { run: () => service.run(child.id, {}, fakeExec(f.controller.signal, child)), input, child }
  }

  it.each(['attempt', 'review-role', 'cold-service'] as const)('%s 不能把本运行中改写的 scripts 重新授权', async (kind) => {
    const runCommand = vi.fn<NonNullable<SelftestServiceOptions['runCommand']>>()
    const f = await fixture({ packageJson: { scripts: { test: originalScript } }, serviceOptions: { runCommand } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: changedScript } }))
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('scripts')
    const service = kind === 'cold-service' ? new InMemorySelftestService({ permissions: f.permissions, agents: f.agents, runCommand }) : f.service
    if (service !== f.service) { await f.service.dispose(); services.push(service) }
    const second = await next(f, { id: 'retry-child', role: kind === 'review-role' ? 'review-author' : 'dev', service })
    await expect(second.run()).rejects.toThrow('基线')
    expect(runCommand).not.toHaveBeenCalled()
    const files = await readdir(path.join(f.space.stores.taktDir, 'runs', nodeRef.runId, 'selftest'))
    expect(files).toHaveLength(1)
    const text = await readFile(path.join(f.space.stores.taktDir, 'runs', nodeRef.runId, 'selftest', files[0]!), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, exists: true, invalid: false, testPresent: true, scriptsHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(text).not.toContain('baseline-script'); expect(text).not.toContain('changed-script'); expect(text).not.toContain(f.root)
  })

  it('合法依赖修改不改变 scripts 基线，第二尝试与冷恢复均可执行', async () => {
    const f = await fixture({ packageJson: { scripts: { test: originalScript }, dependencies: { old: '1' } } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: originalScript }, dependencies: { newer: '2' } }))
    const second = await next(f, { id: 'same-script' })
    expect((await second.run()).succeeded).toBe(true)
    await f.service.dispose()
    const service = new InMemorySelftestService({ permissions: f.permissions, agents: f.agents }); services.push(service)
    const resumed = await next(f, { id: 'resumed', attempt: 3, service })
    expect((await resumed.run()).succeeded).toBe(true)
  })

  it('不同 run 与不同物理 cwd 独立建立基线，不互相误拒绝', async () => {
    const f = await fixture({ packageJson: { scripts: { test: originalScript } } })
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: changedScript } }))
    const newer = await next(f, { id: 'new-run', runId: 'run-2', attempt: 1 })
    expect((await newer.run()).outputTail).toContain('changed-script')
    const cwd = path.join(f.root, 'another-worktree'); await mkdir(cwd)
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: changedScript } }))
    const another = await next(f, { id: 'new-cwd', cwd, attempt: 1 })
    expect((await another.run()).outputTail).toContain('changed-script')
    expect(await readdir(path.join(f.space.stores.taktDir, 'runs', 'run-1', 'selftest'))).toHaveLength(2)
  })

  it('并发首次登记由文件锁固定唯一原始指纹，后到者不能覆盖', async () => {
    const f = await fixture({ packageJson: { scripts: { test: originalScript } } })
    const cwd = path.join(f.root, 'concurrent'); await mkdir(cwd)
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: originalScript } }))
    const expected = await readPackageSnapshot(cwd), entered = deferred<void>(), release = deferred<void>()
    const firstService = new InMemorySelftestService({ permissions: f.permissions, agents: f.agents,
      ownership: own(async () => { entered.resolve(); await release.promise }),
    })
    const secondService = new InMemorySelftestService({ permissions: f.permissions, agents: f.agents })
    services.push(firstService, secondService)
    const first = next(f, { id: 'first-writer', cwd, attempt: 1, service: firstService })
    await entered.promise
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: changedScript } }))
    const second = next(f, { id: 'second-writer', cwd, attempt: 1, service: secondService })
    release.resolve(); await first
    await expect((await second).run()).rejects.toThrow('基线')
    const files = await readdir(path.join(f.space.stores.taktDir, 'runs', 'run-1', 'selftest'))
    const baselines = await Promise.all(files.map(file => readFile(path.join(f.space.stores.taktDir, 'runs', 'run-1', 'selftest', file), 'utf8').then(JSON.parse)))
    expect(baselines.every(value => value.scriptsHash === expected.scriptsHash)).toBe(true)
  })

  it('无入口的 PM 创建 package 后，同一运行也不能通过下一角色解锁', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: changedScript } }))
    const second = await next(f, { id: 'after-pm' })
    await expect(second.run()).rejects.toThrow('基线')
  })

  it('environment.env 不能覆盖真实运行、节点与需求身份', async () => {
    const f = await fixture({ environment: {
      ...envCommand('node -e "console.log(JSON.stringify([process.env.TAKT_RUN_ID,process.env.TAKT_REQ,process.env.TAKT_NODE,process.env.TAKT_WORKSPACE,process.env.TAKT_SELFTEST]))"'),
      env: { TAKT_RUN_ID: 'forged-run', TAKT_REQ: 'forged-req', TAKT_NODE: 'forged-node', TAKT_WORKSPACE: 'forged-workspace', TAKT_SELFTEST: 'forged-mode' },
    } })
    const result = await f.service.run(childId, {}, f.exec)
    expect(JSON.parse(result.outputTail)).toEqual([nodeRef.runId, f.requirementId, nodeRef.nodeId, f.scope.artifactRoot, '1'])
  })
})
