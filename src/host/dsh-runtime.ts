import type { DefineTool } from './dsh-types.js'

/**
 * 唯一读取 `@deepseek-ai/*` 运行时值的地方。
 *
 * 用动态 import 而不是 createRequire：严格 ESM，且只有 Lead 层真正注册工具时才
 * 加载。单测通过参数注入 fake defineTool，不需要安装 @deepseek-ai/*。
 *
 * 失败语义：包缺失或导出形状不对时抛带上下文的 Error，调用方应转成可操作提示。
 */
export async function loadDefineTool(): Promise<DefineTool> {
  const specifier = '@deepseek-ai/dsh-tools'
  const mod = (await import(/* @vite-ignore */ specifier)) as { defineTool?: unknown }
  if (typeof mod.defineTool !== 'function') {
    throw new Error(`${specifier} 未导出 defineTool：dsh 版本可能不兼容（需要 0.2.1-rc.3）`)
  }
  return mod.defineTool as DefineTool
}
