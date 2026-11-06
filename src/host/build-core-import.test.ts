import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface BuildModule {
  rewriteCoreSandboxImport(source: string, file?: string): string
}

// 构建脚本没有旁的 .d.mts 声明；测试用类型化动态 import 读取纯函数，局部声明签名。
const { rewriteCoreSandboxImport } = await import(
  /* @vite-ignore */ new URL('../../scripts/build.mjs', import.meta.url).href
) as BuildModule

const execution = fileURLToPath(new URL('../../vendor/taktflow/packages/core/src/engine/execution.ts', import.meta.url))

describe('core sandbox 构建期字面量动态导入适配', () => {
  it('真实 vendor execution.ts 改写成字面量 import，且保留 lazy promise 缓存', () => {
    const source = readFileSync(execution, 'utf8')
    const rewritten = rewriteCoreSandboxImport(source, 'execution.ts')
    expect(rewritten).toContain("import('@taktflow/sandbox')")
    expect(rewritten).not.toContain("const name = '@taktflow/sandbox'")
    expect(rewritten).not.toContain('import(name)')
    expect(rewritten).toContain('return adapters ??=')
  })

  it('vendor 源形状变化时显式失败，不静默漏改或全局替换', () => {
    const source = readFileSync(execution, 'utf8')
    const renamed = source.replace("const name = '@taktflow/sandbox'", "const pkg = '@taktflow/sandbox'")
    expect(() => rewriteCoreSandboxImport(renamed, 'execution.ts')).toThrow(/形状变化/)
    const duplicated = source.replace(
      'return adapters ??=',
      "const name = '@taktflow/sandbox'\n  return adapters ??=",
    )
    expect(() => rewriteCoreSandboxImport(duplicated, 'execution.ts')).toThrow(/形状变化/)
  })
})
