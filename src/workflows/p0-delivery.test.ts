import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agent,
  createEngine,
  initProject,
  loop,
  type AgentNodeDef,
  type AgentProfile,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessRequest,
  type HarnessResult,
  type NodeContext,
  type NodeDef,
  type NodeResult,
  type ScriptNodeDef,
  type WorkflowDefinition,
} from '@taktflow/core'
import { TaktToolError } from '../host/types.js'
import { createWorkflowCatalog, P0_DELIVERY_ID, validateWorkflowForP0 } from './index.js'
import { loadP0DeliveryWorkflow } from './p0-delivery.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class MockDshHarness implements HarnessAdapter {
  readonly id = 'dsh-host'
  readonly displayName = '测试用 dsh-host'
  readonly calls: HarnessRequest[] = []

  async available(): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  async run(req: HarnessRequest, onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
    this.calls.push(req)
    onEvent({ type: 'started', sessionId: `mock-${this.calls.length}` })
    const workspace = req.env?.TAKT_WORKSPACE
    const node = req.env?.TAKT_NODE
    if (!workspace) throw new Error('缺少 TAKT_WORKSPACE')
    switch (node) {
      case 'clarify':
        return { ok: true, finalText: '无待确认问题' }
      case 'design':
        await mkdir(join(workspace, 'design'), { recursive: true })
        await writeFile(join(workspace, 'design/design.md'), '# 系分\n\n实现 src/impl.ts。\n')
        return { ok: true, finalText: '系分完成' }
      case 'implement':
        await mkdir(join(req.cwd, 'src'), { recursive: true })
        await writeFile(join(req.cwd, 'src/impl.ts'), 'export const value = 1\n')
        return { ok: true, finalText: '实现完成' }
      case 'report':
        await mkdir(join(workspace, 'reports'), { recursive: true })
        await writeFile(join(workspace, 'reports/summary.md'), '# 交付报告\n')
        return { ok: true, finalText: '报告完成' }
      default:
        throw new Error(`未知节点：${node ?? '（空）'}`)
    }
  }
}

function profilesFor(roles: string[]): Record<string, AgentProfile> {
  return Object.fromEntries(roles.map((role) => [role, {
    role,
    title: role,
    description: '',
    instructions: `完成 ${role} 的任务`,
    harness: { harness: 'dsh-host' },
    skills: [],
    writeScope: ['**'],
  }]))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-p0-delivery-'))
  roots.push(root)
  const stores = await initProject(root)
  const requirement = await stores.workspaces.createRequirement({ title: 'P0 流程验收' })
  const harness = new MockDshHarness()
  const deps = {
    stores,
    profiles: profilesFor(['analyst', 'architect', 'dev', 'reporter']),
    harnesses: { 'dsh-host': harness },
    knowledge: [],
  }
  return { root, stores, requirementId: requirement.id, harness, deps }
}

function expectUnsupported(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(TaktToolError)
    expect((error as TaktToolError).code).toBe('TAKT_UNSUPPORTED_NODE')
    expect((error as TaktToolError).hint).toBeTruthy()
    return
  }
  throw new Error('预期抛出 TAKT_UNSUPPORTED_NODE')
}

function workflowWith(nodes: NodeDef[]): WorkflowDefinition {
  return { id: 'probe', title: '校验用', version: '1', stages: [], nodes }
}

const probeAgent = agent({
  id: 'probe-agent',
  title: '探针',
  role: 'dev',
  prompt: 'noop',
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error('等待条件超时')
}

function scriptNode(id: string): ScriptNodeDef {
  const node = loadP0DeliveryWorkflow().nodes.find(
    (item): item is ScriptNodeDef => item.kind === 'script' && item.id === id,
  )
  if (!node) throw new Error(`缺少 script 节点：${id}`)
  return node
}

function scriptContext(options: {
  root: string
  workspaceDir: string
  requirementId: string
  args: Record<string, unknown>
  signal?: AbortSignal
}): NodeContext {
  return {
    runId: 'run-script-test',
    requirementId: options.requirementId,
    nodeId: 'test',
    workspaceDir: options.workspaceDir,
    projectDir: options.root,
    args: options.args,
    resultOf: () => undefined,
    readArtifact: async () => undefined,
    log: () => undefined,
    signal: options.signal,
  }
}

describe('p0-delivery 流程与目录', () => {
  it('目录只暴露 p0-delivery，load 返回通过 core 定义校验的真实流程', async () => {
    const catalog = createWorkflowCatalog()
    expect(catalog.ids()).toEqual([P0_DELIVERY_ID])

    const workflow = await catalog.load(P0_DELIVERY_ID)
    expect(workflow.id).toBe(P0_DELIVERY_ID)
    expect(workflow.nodes.map((node) => node.id)).toEqual([
      'clarify', 'design', 'approve-design', 'implement', 'test', 'report',
    ])
    expect(workflow.nodes.map((node) => node.kind)).toEqual([
      'agent', 'agent', 'human', 'agent', 'script', 'agent',
    ])
    expect(workflow.nodes.some((node) => node.kind === 'review')).toBe(false)

    const agents = workflow.nodes.filter((node): node is AgentNodeDef => node.kind === 'agent')
    expect(agents).toHaveLength(4)
    for (const node of agents) {
      expect(node.harness?.harness).toBe('dsh-host')
      expect(Object.hasOwn(node, 'allowBash')).toBe(false)
    }
    const clarify = workflow.nodes.find((node) => node.id === 'clarify') as AgentNodeDef
    expect(clarify.writeScope).toEqual([])
    const implement = workflow.nodes.find((node) => node.id === 'implement') as AgentNodeDef
    expect(implement.writeScope).toEqual(['src/**'])
    const design = workflow.nodes.find((node) => node.id === 'design') as AgentNodeDef
    expect(design.outputs?.map((output) => output.path)).toEqual(['design/design.md'])
    // 物理写范围落在需求目录下，逻辑产物路径仍是 design/**。
    expect(design.writeScope).toEqual(['.takt/workspaces/*/design/**'])
    const report = workflow.nodes.find((node) => node.id === 'report') as AgentNodeDef
    expect(report.outputs?.map((output) => output.path)).toEqual(['reports/summary.md'])
    expect(report.writeScope).toEqual(['.takt/workspaces/*/reports/**'])
  })

  it('clarify/design 纳入 clarifications/**，clarify prompt 要求读取 requirement.json 元数据', async () => {
    const { root, stores, requirementId } = await fixture()
    const workflow = loadP0DeliveryWorkflow()
    const clarify = workflow.nodes.find((node) => node.id === 'clarify') as AgentNodeDef
    const design = workflow.nodes.find((node) => node.id === 'design') as AgentNodeDef

    expect(clarify.inputs?.map((input) => input.path)).toContain('clarifications/**')
    const clarifyPrompt = clarify.prompt
    if (typeof clarifyPrompt !== 'string') throw new Error('clarify prompt 应为静态文本')
    // 需求正文元数据不能作为 InputSpec（core 会拒绝），只能提示 Agent 自行读取。
    expect(clarifyPrompt).toContain('requirement.json')
    expect(clarifyPrompt).toContain('title')
    expect(clarifyPrompt).toContain('links')

    expect(design.inputs?.map((input) => input.path)).toContain('clarifications/**')
    const designPrompt = design.prompt as (ctx: NodeContext) => string
    const text = designPrompt(scriptContext({
      root,
      workspaceDir: stores.workspaces.dir(requirementId),
      requirementId,
      args: {},
    }))
    expect(text).toContain('clarifications/')
  })

  it('未知流程 id（含原型链名字）抛 TAKT_UNSUPPORTED_NODE 并给出可用流程', async () => {
    for (const id of ['not-bundled', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      await expect(createWorkflowCatalog().load(id)).rejects.toMatchObject({
        code: 'TAKT_UNSUPPORTED_NODE',
        hint: expect.stringContaining(P0_DELIVERY_ID),
      })
    }
  })

  it('P0 约束：未知类型、review、allowBash（含 false）和嵌套节点都拒绝', () => {
    expect(() => validateWorkflowForP0(loadP0DeliveryWorkflow())).not.toThrow()

    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      { id: 'mystery', kind: 'mystery', title: '未知' } as unknown as NodeDef,
    ])))
    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      { id: 'review', kind: 'review', title: '评审' } as unknown as NodeDef,
    ])))
    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      { ...probeAgent, allowBash: true } as NodeDef,
    ])))
    // 声明 false 也算越权：P0 不接受任何 shell 声明。
    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      { ...probeAgent, allowBash: false } as NodeDef,
    ])))
    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      loop({
        id: 'outer',
        title: '循环',
        maxIterations: 1,
        until: () => true,
        body: [{ ...probeAgent, allowBash: false } as NodeDef],
      }),
    ])))
    expectUnsupported(() => validateWorkflowForP0(workflowWith([
      loop({
        id: 'outer',
        title: '循环',
        maxIterations: 1,
        until: () => true,
        body: [{ id: 'nested-review', kind: 'review', title: '嵌套评审' } as unknown as NodeDef],
      }),
    ])))
  })

  it('真实 core engine + mock harness：human 待人，未批准不推进，approve 后跑完', async () => {
    const { stores, requirementId, harness, deps } = await fixture()
    const workspaceDir = stores.workspaces.dir(requirementId)
    // 人工澄清记录由 Lead 写入公共存放区，clarify/design 必须把它解析为输入。
    await mkdir(join(workspaceDir, 'clarifications'), { recursive: true })
    await writeFile(join(workspaceDir, 'clarifications/human-note.md'), '# 人工澄清\n\n补充验收条件。\n')
    const workflow = await createWorkflowCatalog().load(P0_DELIVERY_ID)
    const engine = createEngine(deps)

    const waiting = await engine.start({
      workflow,
      requirementId,
      args: { testCommand: 'printf takt-test-ok' },
    })
    expect(waiting.status).toBe('waiting_human')
    expect(waiting.nodes['approve-design']?.status).toBe('waiting_human')
    expect(waiting.nodes['clarify']?.inputs?.map((input) => input.path)).toContain('clarifications/human-note.md')
    // 审批前只跑过澄清和系分，实现与报告绝不能提前执行。
    expect(harness.calls.map((call) => call.env?.TAKT_NODE)).toEqual(['clarify', 'design'])

    const [item] = await stores.attention.list({ pending: true })
    expect(item).toMatchObject({
      form: 'approve',
      nodeId: 'approve-design',
      attempt: 1,
      subjects: [{ workspace: requirementId, path: 'design/design.md', version: 1 }],
    })

    await stores.attention.answer(item!.requestId, {
      decision: 'approve',
      answer: '同意进入实现',
      by: { type: 'human', id: 'tester' },
    })

    const finished = await engine.resume(waiting.runId, workflow)
    expect(finished.status).toBe('succeeded')
    expect(Object.values(finished.nodes).map((node) => node.status)).toEqual([
      'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded',
    ])
    expect(harness.calls.map((call) => call.env?.TAKT_NODE)).toEqual([
      'clarify', 'design', 'implement', 'report',
    ])
    const testReport = await readFile(join(stores.workspaces.dir(requirementId), 'reports/test.md'), 'utf8')
    expect(testReport).toContain('takt-test-ok')
    expect(testReport).toContain('退出码：0')
    expect(await readFile(join(stores.projectDir, 'src/impl.ts'), 'utf8')).toContain('export const value')
    const summary = await stores.workspaces.readArtifact({ workspace: requirementId, path: 'reports/summary.md' })
    expect(summary?.toString('utf8')).toContain('交付报告')
  })

  it('打回不会进入实现，运行以 failed 结束', async () => {
    const { stores, requirementId, harness, deps } = await fixture()
    const workflow = await createWorkflowCatalog().load(P0_DELIVERY_ID)
    const engine = createEngine(deps)
    const waiting = await engine.start({
      workflow,
      requirementId,
      args: { testCommand: 'printf never-run' },
    })
    const [item] = await stores.attention.list({ pending: true })
    await stores.attention.answer(item!.requestId, {
      decision: 'reject',
      answer: '方案需要重做',
      by: { type: 'human', id: 'tester' },
    })
    const finished = await engine.resume(waiting.runId, workflow)
    expect(finished.status).toBe('failed')
    expect(finished.nodes['approve-design']?.status).toBe('failed')
    expect(harness.calls.map((call) => call.env?.TAKT_NODE)).toEqual(['clarify', 'design'])
    expect(finished.nodes['implement']?.status).toBe('pending')
  })

  it('测试命令与输出先脱敏再写入报告', async () => {
    const { root, stores, requirementId } = await fixture()
    const workspaceDir = stores.workspaces.dir(requirementId)
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    const node = scriptNode('test')

    const result = await (node.run as (ctx: NodeContext) => Promise<NodeResult | void>)(scriptContext({
      root,
      workspaceDir,
      requirementId,
      args: { testCommand: `printf 'token ${secret} done'` },
    }))

    expect(result).toMatchObject({ data: { exitCode: 0 } })
    expect(JSON.stringify(result)).not.toContain(secret)
    const report = await readFile(join(workspaceDir, 'reports/test.md'), 'utf8')
    expect(report).not.toContain(secret)
    expect(report).toContain('[REDACTED]')
    expect(report).toContain('退出码：0')
  })

  it('取消测试节点会结束整个进程组，后台延迟写入不会落地', async () => {
    const { root, stores, requirementId } = await fixture()
    const workspaceDir = stores.workspaces.dir(requirementId)
    const marker = join(root, 'leaked-after-cancel.txt')
    const pidFile = join(root, 'test-child.pid')
    const controller = new AbortController()
    const node = scriptNode('test')

    const pending = (node.run as (ctx: NodeContext) => Promise<NodeResult | void>)(scriptContext({
      root,
      workspaceDir,
      requirementId,
      args: { testCommand: `echo $$ > '${pidFile}'; (sleep 1; echo leaked > '${marker}') & wait` },
      signal: controller.signal,
    }))

    await waitFor(async () => {
      try {
        await access(pidFile)
        return true
      } catch {
        return false
      }
    })
    controller.abort(new Error('测试取消'))
    await expect(pending).rejects.toBeTruthy()

    // 取消后给后台任务留出足够时间；如果进程组没被杀掉，marker 会在 1 秒后出现。
    await sleep(1_500)
    await expect(access(marker)).rejects.toBeTruthy()
    await expect(access(join(workspaceDir, 'reports/test.md'))).rejects.toBeTruthy()

    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(Number.isInteger(pid)).toBe(true)
    await waitFor(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  })
})
