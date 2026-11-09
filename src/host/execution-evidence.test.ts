import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveCaseEvidence,
  diffExecutionAssets,
  executionEvidenceDir,
  newExecutionId,
  readExecutionReceipts,
  snapshotExecutionAssets,
  writeExecutionReceipt,
} from '@taktflow/core'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-execution-evidence-'))
  roots.push(root)
  return root
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('执行源资产快照', () => {
  it('入口目录树包含相对 helper，digest 稳定且不扫描目录外文件', async () => {
    const root = await temp()
    await write(root, 'tests/run-cases.mjs', "import { marker } from './cases/helper.mjs'\nconsole.log(marker)\n")
    await write(root, 'tests/cases/helper.mjs', "export const marker = 'ok'\n")
    await write(root, 'outside.txt', 'not part of the entry tree\n')

    const first = await snapshotExecutionAssets(root, 'tests/run-cases.mjs')
    const second = await snapshotExecutionAssets(root, 'tests/run-cases.mjs')
    expect(first.scope).toBe('directory')
    expect(first.directory).toBe('tests')
    expect(first.files.map((file) => file.path)).toEqual(['tests/cases/helper.mjs', 'tests/run-cases.mjs'])
    expect(first.files.some((file) => file.path === 'outside.txt')).toBe(false)
    expect(second.digest).toBe(first.digest)
  })

  it('空间根入口只快照入口自身，不把整个空间纳入读取范围', async () => {
    const root = await temp()
    await write(root, 'run-cases.mjs', 'console.log(1)\n')
    await write(root, 'requirements/REQ-OTHER/evidence/summary.json', '{"cases":[]}\n')
    const snapshot = await snapshotExecutionAssets(root, 'run-cases.mjs')
    expect(snapshot.scope).toBe('entry')
    expect(snapshot.directory).toBe('.')
    expect(snapshot.files.map((file) => file.path)).toEqual(['run-cases.mjs'])
  })

  it('helper 修改会体现在 diff 中', async () => {
    const root = await temp()
    await write(root, 'tests/run-cases.mjs', "import './cases/helper.mjs'\n")
    await write(root, 'tests/cases/helper.mjs', "export const marker = 'before'\n")
    const before = await snapshotExecutionAssets(root, 'tests/run-cases.mjs')
    await write(root, 'tests/cases/helper.mjs', "export const marker = 'after'\n")
    const after = await snapshotExecutionAssets(root, 'tests/run-cases.mjs')
    const diff = diffExecutionAssets(before, after)
    expect(diff.changed).toBe(true)
    expect(diff.modified).toEqual(['tests/cases/helper.mjs'])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
  })

  it('入口目录树中的符号链接明确拒绝', async () => {
    const root = await temp()
    await write(root, 'tests/run-cases.mjs', 'console.log(1)\n')
    await write(root, 'outside.mjs', 'export const x = 1\n')
    await symlink(path.join(root, 'outside.mjs'), path.join(root, 'tests/link.mjs'))
    await expect(snapshotExecutionAssets(root, 'tests/run-cases.mjs')).rejects.toThrow('符号链接')
  })

  it('入口越出空间根时拒绝', async () => {
    const root = await temp()
    const outside = await temp()
    await write(outside, 'run-cases.mjs', 'console.log(1)\n')
    await expect(snapshotExecutionAssets(root, path.join(outside, 'run-cases.mjs'))).rejects.toThrow('空间根内')
  })
})

describe('执行证据归档与 receipt', () => {
  it('归档 summary、逐例证据并跳过已有 executions，写入不可变', async () => {
    const root = await temp()
    await write(root, 'evidence/summary.json', JSON.stringify({ cases: [{ id: 'REG-001', status: 'failed', evidence: 'evidence/REG-001/execution.log' }] }))
    await write(root, 'evidence/REG-001/execution.log', 'exit 1\n')
    await write(root, 'evidence/executions/old/run/receipt.json', '{"old":true}\n')
    const directory = executionEvidenceDir('run-1', 'dev-test-loop/run-cases', '1-uuid')

    const first = await archiveCaseEvidence({ workspaceDir: root, archiveDir: directory, label: 'prior' })
    expect(first.error).toBeUndefined()
    expect(first.cases).toEqual([{ id: 'REG-001', status: 'failed', evidence: 'evidence/REG-001/execution.log' }])
    expect(first.files.map((file) => file.path).sort()).toEqual(['evidence/REG-001/execution.log', 'evidence/summary.json'])
    expect(first.files.some((file) => file.path.includes('executions/old'))).toBe(false)
    expect(await readFile(path.join(root, directory, 'prior/evidence/REG-001/execution.log'), 'utf8')).toBe('exit 1\n')

    const again = await archiveCaseEvidence({ workspaceDir: root, archiveDir: directory, label: 'prior' })
    expect(again.files.map((file) => file.archivePath).sort()).toEqual(first.files.map((file) => file.archivePath).sort())

    await write(root, 'evidence/summary.json', JSON.stringify({ cases: [{ id: 'REG-001', status: 'passed' }] }))
    await expect(archiveCaseEvidence({ workspaceDir: root, archiveDir: directory, label: 'prior' })).rejects.toThrow('内容不同')
    expect(await readFile(path.join(root, directory, 'prior/evidence/summary.json'), 'utf8')).toContain('"failed"')
  })

  it('receipt 不可变、可读且带 sha256；按 startedAt 排序', async () => {
    const root = await temp()
    const firstDir = executionEvidenceDir('run-1', 'run-cases', newExecutionId(1))
    const secondDir = executionEvidenceDir('run-1', 'run-cases', newExecutionId(2))
    const first = await writeExecutionReceipt(root, firstDir, { kind: 'runCases', startedAt: '2026-01-01T00:00:01.000Z', exitCode: 1 })
    const second = await writeExecutionReceipt(root, secondDir, { kind: 'runCases', startedAt: '2026-01-01T00:00:02.000Z', exitCode: 0 })
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(second.sha256).toMatch(/^[a-f0-9]{64}$/)
    const read = await readExecutionReceipts(root, 'run-1')
    expect(read.errors).toEqual([])
    expect(read.receipts.map((record) => record.path)).toEqual([first.path, second.path])
    expect(read.receipts[0]?.sha256).toBe(first.sha256)
    await expect(writeExecutionReceipt(root, firstDir, { kind: 'runCases', startedAt: '2026-01-01T00:00:01.000Z', exitCode: 2 })).rejects.toThrow('内容不同')
  })
})
