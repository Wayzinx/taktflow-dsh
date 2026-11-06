import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface ProbeResult {
  mode: 'preserve' | 'normal'
  moduleUrl: string
  engineStatus: string
  sandboxImported: boolean
  attentionInstanceof: boolean
  attentionConstructor: boolean
  workflowCoreSame: boolean
}

const helper = fileURLToPath(new URL('../../e2e/helpers/runtime-symlink.mjs', import.meta.url))

/** 用当前已构建 lib 在真实临时 symlink store 跑 core agent（mock harness），不碰用户仓库。 */
function probe(mode: 'preserve' | 'normal'): ProbeResult {
  const args = mode === 'normal' ? [helper, '--normal'] : [helper]
  const output = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  const line = output.split('\n').find((entry) => entry.startsWith('PROBE_RESULT '))
  if (line === undefined) throw new Error(`helper 未返回结果：${output}`)
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult
}

function expectSingleton(result: ProbeResult): void {
  expect(result.engineStatus).toBe('succeeded')
  expect(result.sandboxImported).toBe(true)
  expect(result.attentionInstanceof).toBe(true)
  expect(result.attentionConstructor).toBe(true)
  expect(result.workflowCoreSame).toBe(true)
}

describe('运行时入口 symlink 下的 sandbox 映射与 core 单例', () => {
  it('symlink + --preserve-symlinks 保持 logical 入口，sandbox 可解析且 core 只有一个实例', () => {
    const result = probe('preserve')
    expectSingleton(result)
    expect(result.moduleUrl).toContain('/home/profiles/web/node_modules/taktflow/lib/url-probe.js')
    expect(result.moduleUrl).not.toContain('/store/taktflow/lib/url-probe.js')
  }, 120_000)

  it('symlink + Node 默认 realpath 解析到 physical 入口，sandbox 可解析且 core 只有一个实例', () => {
    const result = probe('normal')
    expectSingleton(result)
    expect(result.moduleUrl).toContain('/store/taktflow/lib/url-probe.js')
    expect(result.moduleUrl).not.toContain('/home/profiles/web/node_modules/taktflow/lib/url-probe.js')
  }, 120_000)
})
