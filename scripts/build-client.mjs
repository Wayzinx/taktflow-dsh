/**
 * 客户端打包：src/client/index.tsx（含 taktflow web 的嵌入入口）→ IIFE → ModuleLoader 包装。
 * build.mjs 和客户端单测共用，保证测的就是发布的产物。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { CLIENT_REQUIRE_ALLOWLIST, wrapClientBundle } from './checks.mjs'
import { transformCss } from './css.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * @param {{ taktflowRoot?: string, alias?: Record<string, string>, minify?: boolean }} [options]
 * @returns {Promise<{ wrapped: string, css: string, metafile: import('esbuild').Metafile }>}
 */
export async function buildClient(options = {}) {
  const taktflowRoot = options.taktflowRoot ?? path.resolve(process.env.TAKTFLOW_DIR ?? path.join(packageRoot, 'vendor/taktflow'))
  const result = await build({
    entryPoints: { client: path.join(packageRoot, 'src/client/index.tsx') },
    outdir: path.join(packageRoot, 'lib'),
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__taktflowClient',
    platform: 'browser',
    target: 'es2022',
    external: CLIENT_REQUIRE_ALLOWLIST,
    // 主面板复用 taktflow web 的嵌入入口；它只用到 @taktflow/core 的类型。
    alias: {
      ...options.alias,
      '@taktflow/core': path.join(taktflowRoot, 'packages/core/src/index.ts'),
      '@taktflow/web/embed': path.join(taktflowRoot, 'packages/web/src/embed.tsx'),
    },
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: options.minify ?? true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  })
  const code = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text
  if (code === undefined) throw new Error('esbuild 没有产出 client.js')
  // web 页面 import 的样式由 esbuild 合并成一份；面板自己的样式排在最后。
  const bundledCss = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? ''
  const panelCss = await readFile(path.join(packageRoot, 'src/client/styles.css'), 'utf8')
  const css = transformCss(`${bundledCss}\n${panelCss}`)
  return { wrapped: wrapClientBundle(code, css), css, metafile: result.metafile }
}
