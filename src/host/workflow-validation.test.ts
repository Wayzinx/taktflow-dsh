import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 测试替身 runner：真实启动 Node 子进程，验证 FD3 协议而不依赖构建产物。 */
const fakeRunner = vi.hoisted(() => ({ path: '' }))

vi.mock('../workflows/loader.js', () => ({
  findBundledEntry: () => fakeRunner.path === '' ? undefined : fakeRunner.path,
}))

const { validateWorkflowSource } = await import('./workflow-validation.js')

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryFile(name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'takt-validation-'))
  roots.push(root)
  const file = join(root, name)
  await writeFile(file, content)
  return file
}

const validSource = "export default { id: 'demo', version: '1', title: '演示', stages: [], nodes: [] }\n"

describe('workflow 源码校验宿主适配', () => {
  it('语法错误由 TypeScript parser 直接报出，不启动子进程', async () => {
    const file = await temporaryFile('bad.workflow.ts', "export default { id: 'broken'\n")
    const result = await validateWorkflowSource(file)
    expect(result.snapshot).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error' }),
    ])
    expect(result.diagnostics[0]!.message).toContain("'}' expected")
  })

  it('缺少随包 runner 时明确报发布包不完整，不静默退回宿主求值', async () => {
    fakeRunner.path = ''
    const file = await temporaryFile('ok.workflow.ts', validSource)
    const result = await validateWorkflowSource(file)
    expect(result.snapshot).toBeUndefined()
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      message: expect.stringContaining('缺少 workflow 校验 runner'),
    })
  })

  it('runner 通过 FD3 返回快照时透传 snapshot，且不产生诊断', async () => {
    fakeRunner.path = await temporaryFile('runner.mjs', [
      "import { writeSync } from 'node:fs'",
      "writeSync(3, JSON.stringify({ snapshot: { id: 'from-runner', version: '1', title: '快照', stages: [], nodes: [] }, diagnostics: [] }))",
    ].join('\n'))
    const file = await temporaryFile('ok.workflow.ts', validSource)
    const result = await validateWorkflowSource(file)
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot).toMatchObject({ id: 'from-runner', version: '1' })
  })

  it('runner 返回失败信息时转成带源码位置的诊断，保留原失败语义', async () => {
    fakeRunner.path = await temporaryFile('runner-fail.mjs', [
      "import { writeSync } from 'node:fs'",
      "writeSync(3, JSON.stringify({ message: '模块加载失败', stack: `${process.argv[2]}:3:7` }))",
    ].join('\n'))
    const file = await temporaryFile('ok.workflow.ts', validSource)
    const result = await validateWorkflowSource(file)
    expect(result.snapshot).toBeUndefined()
    expect(result.diagnostics[0]).toMatchObject({
      severity: 'error',
      message: '模块加载失败',
      line: 3,
      column: 7,
    })
  })
})
