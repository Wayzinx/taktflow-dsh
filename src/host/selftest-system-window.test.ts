import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agent,
  createEngine,
  initProject,
  WriteGuard,
  type AgentProfile,
  type HarnessAdapter,
  type HarnessRequest,
  type RunState,
  type WorkflowDefinition,
} from '@taktflow/core'
import type { Agent, HostContext, ToolRunContext } from './dsh-types.js'
import { InMemoryPermissionRegistry } from './permissions.js'
import { InMemorySelftestService, type SelftestContextInput, type SelftestServiceOptions } from './selftest.js'
import { FsSpaceRegistry } from './space.js'

const roots: string[] = []
const services: InMemorySelftestService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const childId = 'selftest-child'

function fakeAgent(id: string, cwd: string): Agent {
  return { id, options: {}, session: { header: { id, cwd } }, followup() {}, inject() {} }
}

function fakeExec(signal: AbortSignal, child: Agent): ToolRunContext {
  return {
    callId: 'call-1', rootCallId: 'call-1', name: 'takt_selftest', arguments: {},
    agent: child, signal, token: Symbol('token'), deferContext() {}, concludeTurn() {},
  } as unknown as ToolRunContext
}

function workflowFor(nodeId: string): WorkflowDefinition {
  return {
    id: 'test', title: '测试', version: '1', stages: [],
    nodes: [agent({ id: nodeId, title: '实现', role: 'dev', harness: { harness: 'dsh-host' }, prompt: '完成' })],
  }
}

interface ServiceFixtureOptions {
  packageJson?: unknown
  writeScope?: string[]
  readOnly?: boolean
  withSystemWrites?: <T>(paths: string[], fn: () => Promise<T>) => Promise<T>
  runCommand?: SelftestServiceOptions['runCommand']
}

/** 直接驱动真实受控自测服务；只替换子进程执行，保留权限/命令/脚本校验。 */
async function serviceFixture(options: ServiceFixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-selftest-window-'))
  roots.push(root)
  if (options.packageJson !== undefined) await writeFile(path.join(root, 'package.json'), JSON.stringify(options.packageJson))
  const stores = await initProject(root)
  const spaces = new FsSpaceRegistry()
  const space = await spaces.open(root)
  const requirementId = (await space.stores.workspaces.createRequirement({ title: '自测窗口' })).id
  const workflow = workflowFor('work')
  const nodeRef = { runId: 'run-1', nodeId: 'work', attempt: 1 }
  const run: RunState = {
    runId: nodeRef.runId, workflowId: workflow.id, workflowVersion: workflow.version,
    requirementId, status: 'running', startedAt: new Date().toISOString(),
    args: {}, nodes: { [nodeRef.nodeId]: { id: nodeRef.nodeId, status: 'running', attempts: nodeRef.attempt, outputs: [] } }, expansions: [],
  }
  await space.stores.runs.save(run)
  const cwd = await realpath(root)
  const artifactRoot = await realpath(space.stores.workspaces.dir(requirementId))
  const writeScope = options.writeScope ?? ['requirements/**/tasks/**', 'requirements/**/evidence/**']
  const permissions = new InMemoryPermissionRegistry()
  permissions.register({ childId, nodeRef, cwd, spaceRoot: cwd, artifactRoot, writeScope, allowBash: false, readOnly: options.readOnly ?? false })
  const controller = new AbortController()
  const child = fakeAgent(childId, cwd)
  const live = new Map([[childId, child]])
  const agents: HostContext['agents'] = { get: (id) => live.get(id), roots: () => [] }
  const service = new InMemorySelftestService({
    permissions, agents,
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  })
  services.push(service)
  const input: SelftestContextInput = {
    childId, space, nodeRef, role: 'dev', requirementId, cwd, env: {}, writeScope,
    signal: controller.signal, sessionId: childId, workflow, readOnly: options.readOnly ?? false,
    ...(options.withSystemWrites === undefined ? {} : { withSystemWrites: options.withSystemWrites }),
  }
  await service.register(input)
  return {
    root, space, requirementId, artifactRoot, service,
    exec: fakeExec(controller.signal, child),
  }
}

interface EngineCaseOptions {
  withSystemWrites?: boolean
  extraWrites?: string[]
  /** 不经受控自测服务，由 harness 直接写文件，用于验证 dev 原有权限没有被放宽。 */
  directWrite?: string
}

/** 真实 core engine + 注入同一个 WriteGuard；harness 内运行真实受控自测服务。 */
async function engineCase(options: EngineCaseOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-selftest-engine-'))
  roots.push(root)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const stores = await initProject(root)
  const spaces = new FsSpaceRegistry()
  const space = await spaces.open(root)
  const requirementId = (await space.stores.workspaces.createRequirement({ title: '自测窗口引擎' })).id
  const artifactRoot = await realpath(space.stores.workspaces.dir(requirementId))
  const workflow = workflowFor('implement')
  const projectDir = space.stores.projectDir
  const guard = new WriteGuard(
    projectDir,
    relative(projectDir, space.stores.paths.requirements),
    relative(projectDir, space.stores.paths.evals ?? `${space.stores.taktDir}/evals`),
  )
  const writeScope = ['src/**', 'requirements/**/tasks/**']
  const permissions = new InMemoryPermissionRegistry()
  const child = fakeAgent(childId, root)
  const agents: HostContext['agents'] = { get: (id) => id === childId ? child : undefined, roots: () => [] }
  const windowCalls: string[][] = []
  const runCommand = async (_run: string, _cwd: string, env: Record<string, string>) => {
    const workspace = env.TAKT_WORKSPACE!
    for (const file of ['evidence/summary.json', 'evidence/result.json', ...(options.extraWrites ?? [])]) {
      const target = path.join(workspace, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, '{}')
    }
    return { code: 0, output: 'passed: 4, failed: 0' }
  }
  const service = new InMemorySelftestService({ permissions, agents, runCommand })
  services.push(service)
  const withSystemWrites = options.withSystemWrites === true
    ? <T>(paths: string[], fn: () => Promise<T>): Promise<T> => {
        windowCalls.push(paths)
        return guard.system(paths, fn)
      }
    : undefined
  const harness: HarnessAdapter = {
    id: 'dsh-host',
    displayName: '测试 harness',
    available: async () => ({ ok: true }),
    run: async (request: HarnessRequest) => {
      if (options.directWrite !== undefined) {
        const target = path.join(artifactRoot, options.directWrite)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, '{}')
        return { ok: true, finalText: '完成' }
      }
      const runId = request.env!.TAKT_RUN_ID!
      const nodeId = request.env!.TAKT_NODE!
      const state = await space.stores.runs.get(runId)
      const nodeRef = { runId, nodeId, attempt: state!.nodes[nodeId]!.attempts }
      const signal = request.signal ?? AbortSignal.abort(new Error('harness 缺少取消信号'))
      permissions.register({ childId, nodeRef, cwd: request.cwd, spaceRoot: space.root, artifactRoot, writeScope, allowBash: false, readOnly: false })
      const registration = await service.register({
        childId, space, nodeRef, role: 'dev', requirementId, cwd: request.cwd,
        env: request.env ?? {}, writeScope, signal, sessionId: childId, workflow,
        ...(withSystemWrites === undefined ? {} : { withSystemWrites }),
      })
      try {
        await service.run(childId, {}, fakeExec(signal, child))
      } finally {
        await registration.release()
      }
      return { ok: true, finalText: '完成' }
    },
  }
  const profile: AgentProfile = {
    role: 'dev', title: '开发', description: '', instructions: '完成实现',
    harness: { harness: 'dsh-host' }, skills: [], writeScope,
  }
  const engine = createEngine(
    { stores: space.stores, profiles: { dev: profile }, harnesses: { 'dsh-host': harness }, knowledge: [] },
    { guard },
  )
  return { root, space, requirementId, artifactRoot, engine, workflow, windowCalls }
}

describe('受控自测系统写入窗口', () => {
  it('只把当前需求 evidence/** 交给系统窗口，并在回调内执行真实命令', async () => {
    const calls: string[][] = []
    let inside = false
    const f = await serviceFixture({
      packageJson: { scripts: { test: 'node --test' } },
      runCommand: async (_run, _cwd, env) => {
        expect(inside).toBe(true)
        const workspace = env.TAKT_WORKSPACE!
        await mkdir(path.join(workspace, 'evidence'), { recursive: true })
        await writeFile(path.join(workspace, 'evidence/summary.json'), '{"passed":1,"failed":0}')
        return { code: 0, output: 'passed: 1, failed: 0' }
      },
      withSystemWrites: async <T>(paths: string[], fn: () => Promise<T>): Promise<T> => {
        calls.push(paths)
        inside = true
        try { return await fn() } finally { inside = false }
      },
    })
    const result = await f.service.run(childId, {}, f.exec)
    expect(result).toMatchObject({ succeeded: true, exitCode: 0 })
    expect(calls).toEqual([[`requirements/${f.requirementId}/evidence/**`]])
  })

  it('只读角色在到达系统窗口前拒绝', async () => {
    let called = 0
    const f = await serviceFixture({
      packageJson: { scripts: { test: 'node --test' } },
      writeScope: [], readOnly: true,
      withSystemWrites: async <T>(_paths: string[], fn: () => Promise<T>): Promise<T> => {
        called++
        return fn()
      },
    })
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow()
    expect(called).toBe(0)
  })

  it('没有可信命令时在到达系统窗口前拒绝', async () => {
    let called = 0
    const f = await serviceFixture({
      withSystemWrites: async <T>(_paths: string[], fn: () => Promise<T>): Promise<T> => {
        called++
        return fn()
      },
    })
    await expect(f.service.run(childId, {}, f.exec)).rejects.toThrow('受控自测不可用')
    expect(called).toBe(0)
  })

  it('共享 guard 之前，可信自测写 evidence 被算作 dev 越界', async () => {
    const f = await engineCase()
    const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
    expect(state.status).toBe('failed')
    expect(state.nodes['implement']?.status).toBe('blocked')
    expect(state.nodes['implement']?.error).toContain('写权限越界')
    expect(state.nodes['implement']?.error).toContain(`requirements/${f.requirementId}/evidence/summary.json`)
    expect(f.windowCalls).toEqual([])
  })

  it('共享 guard 之后，同一可信自测写 evidence 不再算 dev 越界', async () => {
    const f = await engineCase({ withSystemWrites: true })
    const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
    expect(state.status).toBe('succeeded')
    expect(state.nodes['implement']?.status).toBe('succeeded')
    expect(f.windowCalls).toEqual([[`requirements/${f.requirementId}/evidence/**`]])
    expect(await readFile(path.join(f.artifactRoot, 'evidence/summary.json'), 'utf8')).toBe('{}')
    expect(await readFile(path.join(f.artifactRoot, 'evidence/result.json'), 'utf8')).toBe('{}')
  })

  it('dev 直接写 evidence 仍然越界，系统窗口不改变角色权限', async () => {
    const f = await engineCase({ withSystemWrites: true, directWrite: 'evidence/direct.json' })
    const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
    expect(state.status).toBe('failed')
    expect(state.nodes['implement']?.status).toBe('blocked')
    expect(state.nodes['implement']?.error).toContain(`requirements/${f.requirementId}/evidence/direct.json`)
    expect(f.windowCalls).toEqual([])
  })

  it('系统窗口不豁免当前需求 evidence 之外的写入', async () => {
    const f = await engineCase({
      withSystemWrites: true,
      extraWrites: ['cases/run.json', `../REQ-OTHER/evidence/other.json`],
    })
    const state = await f.engine.start({ requirementId: f.requirementId, workflow: f.workflow })
    expect(state.status).toBe('failed')
    expect(state.nodes['implement']?.status).toBe('blocked')
    const error = state.nodes['implement']?.error ?? ''
    expect(error).toContain(`requirements/${f.requirementId}/cases/run.json`)
    expect(error).toContain('requirements/REQ-OTHER/evidence/other.json')
    expect(error).not.toContain(`requirements/${f.requirementId}/evidence/summary.json`)
  })
})
