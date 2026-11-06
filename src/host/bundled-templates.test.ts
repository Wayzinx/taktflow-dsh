import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface ProbeResult {
  defaultBranch: string | null
  releaseSha: string
  devSha: string
  head: string
  hasDevOnlyFile: boolean
  containsDevCommit: boolean
  branch: string
}

const helper = fileURLToPath(new URL('../../e2e/helpers/integration-default-branch.mjs', import.meta.url))

/** 用当前已构建 lib 在真实临时 Git 仓库执行随包 integration 节点；helper 不碰用户仓库。 */
function probe(args: string[] = []): ProbeResult {
  const output = execFileSync(process.execPath, [helper, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = output.split('\n').find((entry) => entry.startsWith('PROBE_RESULT '))
  if (line === undefined) throw new Error(`helper 未返回结果：${output}`)
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult
}

describe('随包 integration 模板真实 Git 分支选择', () => {
  it('显式 defaultBranch=release 而 HEAD=dev 时，app worktree 基于 release 且不含 dev 提交', () => {
    const result = probe(['--default-branch=release'])
    expect(result.defaultBranch).toBe('release')
    expect(result.head).toBe(result.releaseSha)
    expect(result.hasDevOnlyFile).toBe(false)
    expect(result.containsDevCommit).toBe(false)
  }, 30_000)

  it('省略 defaultBranch 时，从真实 HEAD 解析为 dev', () => {
    const result = probe()
    expect(result.defaultBranch).toBeNull()
    expect(result.head).toBe(result.devSha)
    expect(result.hasDevOnlyFile).toBe(true)
    expect(result.containsDevCommit).toBe(true)
  }, 30_000)
})
