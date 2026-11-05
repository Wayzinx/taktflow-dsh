#!/usr/bin/env node
/**
 * 构建 Taktflow dsh bundle。
 *
 * - host/lead/role/workflows：ESM + splitting，@taktflow/core 从仓库源码打入，
 *   @deepseek-ai/* 与 node:* 保持 external。
 * - client：IIFE 后包一层 window.__ModuleLoader__.load；CSS 作用域化后作为字符串注入。
 * - 构建后做静态检查；任何一项失败都以非零退出。
 */
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { buildClient } from './build-client.mjs'
import { checkClientBundle, checkHostBundle, checkPackageManifest, CLIENT_REQUIRE_ALLOWLIST } from './checks.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
// taktflow 源码来自 git 子模块 vendor/taktflow；可用 TAKTFLOW_DIR 指向本地 checkout 联调。
const taktflowRoot = path.resolve(process.env.TAKTFLOW_DIR ?? path.join(packageRoot, 'vendor/taktflow'))
const libDir = path.join(packageRoot, 'lib')

const HOST_ENTRIES = {
  host: path.join(packageRoot, 'src/host/index.ts'),
  lead: path.join(packageRoot, 'src/host/lead/index.ts'),
  role: path.join(packageRoot, 'src/host/role/index.ts'),
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  const manifestProblems = checkPackageManifest(manifest)
  if (manifestProblems.length > 0) fail('package.json 检查失败', manifestProblems)

  const versionSource = await readFile(path.join(packageRoot, 'src/version.ts'), 'utf8')
  const versionMatch = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(versionSource)
  if (versionMatch === null || versionMatch[1] !== manifest.version) {
    fail('版本不一致', [`src/version.ts 必须与 package.json 的 version 相同（${manifest.version}）`])
  }

  await rm(libDir, { recursive: true, force: true })

  const workflowDir = path.join(packageRoot, 'src/workflows')
  const workflowEntries = Object.fromEntries((await readdir(workflowDir))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .map((name) => [`workflows/${name.slice(0, -3)}`, path.join(workflowDir, name)]))
  const alias = {}
  for (const entry of await readdir(path.join(taktflowRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(taktflowRoot, 'packages', entry.name)
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
      const source = path.join(dir, 'src/index.ts')
      if (!pkg.name?.startsWith('@taktflow/')) continue
      await access(source)
      alias[pkg.name] = source
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const host = await build({
    entryPoints: { ...HOST_ENTRIES, ...workflowEntries },
    outdir: libDir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@deepseek-ai/*', 'node:*'],
    alias,
    metafile: true,
    // core 依赖的 yaml 是 CJS；ESM 产物里要用 createRequire 才能执行它的 require('process')。
    banner: {
      js: "import { createRequire as __taktflowCreateRequire } from 'node:module'; const require = __taktflowCreateRequire(import.meta.url);",
    },
    entryNames: '[dir]/[name]',
    chunkNames: 'chunks/[name]-[hash]',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  })

  const hostProblems = []
  for (const [output, metadata] of Object.entries(host.metafile.outputs)) {
    if (!output.endsWith('.js')) continue
    const relative = path.relative(libDir, path.resolve(output))
    const code = await readFile(output, 'utf8')
    for (const problem of checkHostBundle(code)) hostProblems.push(`${relative}: ${problem}`)
    for (const item of metadata.imports) {
      if (item.external && item.path.startsWith('@taktflow/')) {
        hostProblems.push(`${relative}: 未打包源码依赖 ${item.path}`)
      }
    }
  }
  if (hostProblems.length > 0) fail('宿主产物静态检查失败', hostProblems)

  const { wrapped, css: scopedCss, metafile: clientMeta } = await buildClient({ taktflowRoot, alias })

  const clientProblems = checkClientBundle(wrapped)
  for (const metadata of Object.values(clientMeta.outputs)) {
    for (const item of metadata.imports) {
      if (item.external && !CLIENT_REQUIRE_ALLOWLIST.includes(item.path)) {
        clientProblems.push(`客户端 external 不在白名单：${item.path}`)
      }
    }
  }
  // 嵌入模式不允许回退演示数据：web 的 api/mock*、api/pick 不能进客户端产物。
  for (const input of Object.keys(clientMeta.inputs)) {
    if (/packages\/web\/src\/api\/(mock|pick)/.test(input)) clientProblems.push(`客户端产物含演示数据代码：${input}`)
  }
  if (clientProblems.length > 0) fail('客户端产物静态检查失败', clientProblems)

  await writeFile(path.join(libDir, 'client.js'), wrapped, 'utf8')

  const hostBytes = (await readFile(path.join(libDir, 'host.js'))).byteLength
  console.log(
    `[build:dsh] host: lib/host.js (${hostBytes} B) + lead.js + role.js + ${Object.keys(workflowEntries).length} workflows`,
  )
  console.log(`[build:dsh] client: lib/client.js (${Buffer.byteLength(wrapped)} B, css ${Buffer.byteLength(scopedCss)} B)`)
  console.log('[build:dsh] 静态检查通过')
}

function fail(title, problems) {
  console.error(`[build:dsh] ${title}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

main().catch((error) => {
  console.error(`[build:dsh] 构建失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
