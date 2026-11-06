#!/usr/bin/env node
/**
 * 构建 Taktflow dsh bundle。
 *
 * - host/lead/role/workflows：ESM + splitting，@taktflow/core 从仓库源码打入，
 *   @deepseek-ai/* 与 node:* 保持 external。
 * - client：IIFE 后包一层 window.__ModuleLoader__.load；CSS 作用域化后作为字符串注入。
 * - 构建后做静态检查；任何一项失败都以非零退出。
 */
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { buildClient } from './build-client.mjs'
import { checkClientBundle, checkHostBundle, checkPackageManifest, CLIENT_REQUIRE_ALLOWLIST } from './checks.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
// taktflow 源码来自 git 子模块 vendor/taktflow；可用 TAKTFLOW_DIR 指向本地 checkout 联调。
const taktflowRoot = path.resolve(process.env.TAKTFLOW_DIR ?? path.join(packageRoot, 'vendor/taktflow'))
const libDir = path.join(packageRoot, 'lib')
const templateSource = path.join(packageRoot, 'src/templates/bundled.ts')

const HOST_ENTRIES = {
  host: path.join(packageRoot, 'src/host/index.ts'),
  lead: path.join(packageRoot, 'src/host/lead/index.ts'),
  role: path.join(packageRoot, 'src/host/role/index.ts'),
  // 空间工作流运行时通过 module hook 解析到这些入口；必须与 host 共用 chunk，
  // 才能保证 `@taktflow/core` 在宿主和空间流程里是同一个模块实例。
  core: path.join(packageRoot, 'src/core-entry.ts'),
  sandbox: path.join(packageRoot, 'src/sandbox-entry.ts'),
  harness: path.join(packageRoot, 'src/harness-entry.ts'),
  knowledge: path.join(packageRoot, 'src/knowledge-entry.ts'),
  server: path.join(packageRoot, 'src/server-entry.ts'),
  'workflow-source': path.join(packageRoot, 'src/workflow-source-entry.ts'),
  // workflow 读/写校验由宿主适配模块 spawn 这个 Node24 子进程入口；发布包不带 tsx。
  'workflow-validation-runner': path.join(packageRoot, 'src/workflow-validation-runner.ts'),
  // 模板常量独立输出到 lib/templates/bundled.js；npm files 只发布 lib/**/*.js，
  // 运行时从已发布产物读取，不依赖用户机器上的 taktflow 仓库。
  'templates/bundled': path.join(packageRoot, 'src/templates/bundled.ts'),
}

/**
 * 用宿主适配模块替换 vendor workflow-source 内部的 `./validate.js`。
 *
 * 只在构建时按 importer 精确匹配，不改 vendor 源文件；替换后的 index re-export
 * 也指向同一实现，避免 store 与 routes 走两套校验。
 */
const workflowValidationReplacement = {
  name: 'taktflow-workflow-validation-replacement',
  setup(build) {
    build.onResolve({ filter: /^\.\/validate\.js$/ }, (args) => {
      const importer = args.importer.split(path.sep).join('/')
      if (!importer.includes('/workflow-source/src/')) return undefined
      return { path: path.join(packageRoot, 'src/host/workflow-validation.ts') }
    })
  },
}

/**
 * 把 core 的变量动态导入改写为字面量动态导入。
 *
 * 为什么需要：真实 dsh 的 ResolutionRouter 对 profile 内 core 的裸
 * @taktflow/sandbox 查不到安装项，返回 native-after-interception；它在进入
 * Node resolve hook 前把 parent 替换为 <home>/profiles/package.json，hook 实际
 * 看到的是 profiles/package.json，按 parent 匹配 lib 的插件入口映射不会命中，
 * 失败后 restoreImporter/throwWithImporter 再把错误文案的 parent 还原成原 core
 * chunk。workflow 位于 space、不在 profile interception 范围，所以 @taktflow/core
 * 仍能正常命中。构建期改成字面量后，esbuild 直接产出相对 chunk 动态导入，绕开
 * 这条裸包路由，同时保留异步 lazy 加载和 promise 缓存。
 *
 * 失败语义：vendor 源形状变化（变量声明或 import(name) 不是恰好各一处）时
 * 直接抛错终止构建，绝不静默漏改或做全局宽泛替换。
 */
export function rewriteCoreSandboxImport(source, file = 'execution.ts') {
  const declaration = "const name = '@taktflow/sandbox'"
  const dynamicImport = 'import(name)'
  const occurrences = (text, needle) => text.split(needle).length - 1
  const declarations = occurrences(source, declaration)
  const dynamicImports = occurrences(source, dynamicImport)
  if (declarations !== 1 || dynamicImports !== 1) {
    throw new Error(
      `${file}: core sandbox 动态导入形状变化（声明 ${declarations} 处，import(name) ${dynamicImports} 处）；` +
      '请按新源码更新构建适配，禁止全局替换',
    )
  }
  const rewritten = source.replace(declaration, '').replace(dynamicImport, "import('@taktflow/sandbox')")
  if (occurrences(rewritten, declaration) !== 0 || occurrences(rewritten, dynamicImport) !== 0) {
    throw new Error(`${file}: core sandbox 动态导入改写未完全生效`)
  }
  return rewritten
}

/**
 * 只对 core 的 execution.ts 应用上面的字面量改写；按绝对路径精确匹配，
 * 其它模块（包括同名的其它 execution.ts）原样交给 esbuild。
 */
const coreSandboxLiteralImport = {
  name: 'taktflow-core-sandbox-literal-import',
  setup(build) {
    const target = path.join(taktflowRoot, 'packages/core/src/engine/execution.ts')
    build.onLoad({ filter: /[/\\]execution\.ts$/ }, async (args) => {
      if (path.resolve(args.path) !== path.resolve(target)) return undefined
      const source = await readFile(args.path, 'utf8')
      return { contents: rewriteCoreSandboxImport(source, args.path), loader: 'ts' }
    })
  },
}

async function main() {
  // 模板先生成 TS 常量，再一起进 esbuild；npm 包 files 只发布 lib/**\/*.js，
  // 运行时不能依赖 vendor 目录或 .md/.ts 资源。
  await generateBundledTemplates()
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
    plugins: [workflowValidationReplacement, coreSandboxLiteralImport],
    metafile: true,
    // core 依赖的 yaml 是 CJS；ESM 产物里要用 createRequire 才能执行它的 require('process')。
    // typescript 的 CJS 包还会读取 __filename/__dirname 探测文件系统大小写；ESM 产物
    // 里这两个标识符不存在，必须用 import.meta.url 显式补齐，否则 import 产物即失败。
    banner: {
      js: [
        "import { createRequire as __taktflowCreateRequire } from 'node:module';",
        "import { fileURLToPath as __taktflowFileURLToPath } from 'node:url';",
        "import { dirname as __taktflowDirname } from 'node:path';",
        'const require = __taktflowCreateRequire(import.meta.url);',
        'const __filename = __taktflowFileURLToPath(import.meta.url);',
        'const __dirname = __taktflowDirname(__filename);',
      ].join(' '),
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
    // 模板常量是数据，字符串里天然含 `from '@taktflow/...'`；它们不是真实导入，
    // 不能按宿主代码的裸导入规则误报。真实导入仍由下面的 metafile external 检查。
    const templateData = Object.keys(metadata.inputs ?? {}).some((input) => input.includes('src/templates/bundled.ts'))
    if (!templateData) {
      for (const problem of checkHostBundle(code)) hostProblems.push(`${relative}: ${problem}`)
    }
    // core 的变量动态导入必须在构建期变成字面量；发布产物里残留说明 onLoad 适配
    // 没命中（例如 vendor 源形状变化），必须让构建失败而不是等运行时找不到包。
    if (/const\s+name\s*=\s*["']@taktflow\/sandbox["']/.test(code) || /\bimport\s*\(\s*name\s*\)/.test(code)) {
      hostProblems.push(`${relative}: core sandbox 变量动态导入残留`)
    }
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
    `[build:dsh] host: lib/host.js (${hostBytes} B) + lead.js + role.js + core.js + sandbox.js + templates/bundled.js + ${Object.keys(workflowEntries).length} workflows`,
  )
  console.log(`[build:dsh] client: lib/client.js (${Buffer.byteLength(wrapped)} B, css ${Buffer.byteLength(scopedCss)} B)`)
  console.log('[build:dsh] 静态检查通过')
}

function fail(title, problems) {
  console.error(`[build:dsh] ${title}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

/** 读取模板目录里的文件；缺失目录按空处理，由后续必填校验报错。 */
async function templateFiles(dir, suffix) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => entry.name).sort()
  const files = []
  for (const name of names) files.push({ fileName: name, content: await readFile(path.join(dir, name), 'utf8') })
  return files
}

/**
 * 标准 integration 模板的仓库兼容适配。
 *
 * 模板在空间里重新 `openProject`，直接使用磁盘 `config.repos`；宿主的
 * `applyStandardRepoAlias` 只改运行时内存 config，模板看不到。这里在构建时把
 * 同一规则注入模板：只有唯一 legacy main（path '.'）才追加 app 别名且保留 main；
 * 缺失 defaultBranch 时读取本地仓库真实 HEAD/唯一分支，不假定 main。锚点缺失
 * 直接让构建失败，避免发布一套未适配的模板。
 */
function adaptStandardIntegration(content) {
  const importAnchor = "import { join } from 'node:path'"
  const managerAnchor = "  const manager = createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: stores.config.repos ?? [] })"
  const functionAnchor = 'export async function integrate(ctx: NodeContext): Promise<NodeResult> {'
  for (const anchor of [importAnchor, managerAnchor, functionAnchor]) {
    if (!content.includes(anchor)) throw new Error(`标准 integration 模板缺少锚点：${anchor}`)
  }
  const helper = [
    '/** 运行配置里的仓库；只有唯一 legacy main 时补 app 别名，分支缺省时读真实 HEAD。 */',
    'async function integrationRepos(stores: Awaited<ReturnType<typeof openProject>>) {',
    '  const repos = [...(stores.config.repos ?? [])] as Array<{ id: string; path: string; url?: string; defaultBranch?: string; purpose?: string }>',
    "  if (repos.length === 1 && repos[0]!.id === 'main' && (repos[0]!.path === '.' || repos[0]!.path === './') && !repos.some((repo) => repo.id === 'app')) {",
    "    // 只补 id/purpose；defaultBranch 等已有字段必须原样保留，缺省时由下面的循环解析。",
    "    repos.push({ ...repos[0]!, id: 'app', purpose: repos[0]!.purpose ?? 'app' })",
    '  }',
    '  for (const repo of repos) {',
    "    if (typeof repo.defaultBranch === 'string' && repo.defaultBranch.trim() !== '') continue",
    "    const dir = repo.url === undefined ? resolve(stores.projectDir, repo.path) : join(stores.taktDir, 'repos', repo.id)",
    "    const current = await git(dir, ['symbolic-ref', '--short', 'HEAD']).catch(() => '')",
    "    if (current !== '') { repo.defaultBranch = current; continue }",
    "    const branches = (await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')).split('\\n').filter((name) => name !== '')",
    "    if (branches.length === 1) { repo.defaultBranch = branches[0]; continue }",
    '    throw new Error(`仓库 ${repo.id} 未配置 defaultBranch，且无法从仓库确定唯一默认分支`)',
    '  }',
    '  return repos',
    '}',
  ].join('\n')
  return content
    .replace(importAnchor, "import { join, resolve } from 'node:path'")
    .replace(managerAnchor, '  const repoBindings = await integrationRepos(stores)\n  const manager = createRepoManager({ projectDir: stores.projectDir, taktDir: stores.taktDir, repos: repoBindings })')
    .replace(functionAnchor, `${helper}\n\n${functionAnchor}`)
}

/**
 * 把子模块模板生成成 TS 常量。
 *
 * 为什么生成而不是运行时读文件：package.json 的 files 只发布 lib/**\/*.js，
 * `.md`/`.ts` 模板不会进 npm 包。生成后的常量随宿主 bundle 和 lib/templates/**
 * 一起发布，运行时不再依赖用户机器上是否存在 taktflow 仓库。
 *
 * 失败语义：两个主流程或相对依赖缺失、模板为空时构建直接失败，不产出半套模板。
 */
async function generateBundledTemplates() {
  const templateRoot = path.join(taktflowRoot, 'templates')
  const workflows = await templateFiles(path.join(templateRoot, 'workflows'), '.ts')
  const agents = await templateFiles(path.join(templateRoot, 'agents'), '.md')
  // 标准 integration 模板会重新 openProject 并从磁盘 config 创建 RepoManager，
  // 宿主内存里的 main→app 别名到不了这里；构建时注入同一份兼容逻辑（不改 vendor）。
  for (const file of workflows) {
    if (file.fileName === 'taktflow-standard.integration.ts') file.content = adaptStandardIntegration(file.content)
  }
  if (workflows.length === 0) throw new Error(`没有找到工作流模板：${path.join(templateRoot, 'workflows')}`)
  if (agents.length === 0) throw new Error(`没有找到角色模板：${path.join(templateRoot, 'agents')}`)
  for (const required of ['taktflow-standard.workflow.ts', 'sdlc.workflow.ts']) {
    if (!workflows.some((file) => file.fileName === required)) throw new Error(`缺少默认流程模板：${required}`)
  }
  // 相对依赖必须真实存在；否则发布出去的模板在用户空间里加载时才失败。
  for (const file of workflows) {
    for (const match of file.content.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g)) {
      const target = match[1]
      const name = path.basename(target).replace(/\.js$/, '.ts')
      if (!workflows.some((candidate) => candidate.fileName === name)) {
        throw new Error(`模板 ${file.fileName} 依赖缺失：${target}`)
      }
    }
  }
  const hash = createHash('sha256')
  for (const [group, files] of [['workflows', workflows], ['agents', agents]]) {
    for (const file of files) hash.update(`${group}/${file.fileName}\0${file.content}\0`)
  }
  const digest = hash.digest('hex')
  const source = [
    '/**',
    ' * 随包默认模板；由 scripts/build.mjs 从 vendor/taktflow/templates 生成，勿手改。',
    ' *',
    ' * 调用方：takt_requirement init 复制到空间；loadRunProfiles 以角色模板为默认档案。',
    ' * 失败语义：常量缺失说明构建未运行生成器，init/运行会明确失败，不会退回旧模板。',
    ' */',
    'export interface BundledTemplateFile {',
    '  readonly fileName: string',
    '  readonly content: string',
    '}',
    '',
    `export const BUNDLED_TEMPLATE_HASH = ${JSON.stringify(digest)}`,
    '',
    `export const BUNDLED_WORKFLOW_FILES: readonly BundledTemplateFile[] = ${JSON.stringify(workflows, null, 2)}`,
    '',
    `export const BUNDLED_AGENT_FILES: readonly BundledTemplateFile[] = ${JSON.stringify(agents, null, 2)}`,
    '',
    '/** 默认标准流水线文件名；init 后写进新空间 takt.config.json 的第一项。 */',
    "export const DEFAULT_WORKFLOW_FILE = 'taktflow-standard.workflow.ts'",
    '/** 精简流水线文件名；新空间第二项。 */',
    "export const LITE_WORKFLOW_FILE = 'sdlc.workflow.ts'",
    '',
  ].join('\n')
  await mkdir(path.dirname(templateSource), { recursive: true })
  await writeFile(templateSource, source, 'utf8')
  return { hash: digest, workflows: workflows.length, agents: agents.length }
}

// 被单测 import 时只暴露纯函数，不执行构建；直接 `node scripts/build.mjs` 才跑 main。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[build:dsh] 构建失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
}
