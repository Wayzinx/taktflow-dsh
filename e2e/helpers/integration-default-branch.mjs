#!/usr/bin/env node
/**
 * e2e 专用 helper：用真实临时 Git 仓库验证随包标准 integration 模板的分支选择。
 *
 * 场景：本地仓库 release 为基线，dev 比 release 多一个提交，HEAD 停在 dev。
 * - 显式 defaultBranch=release：app 别名必须保留 release，worktree 不得包含 dev 提交；
 * - 省略 defaultBranch：必须从真实 HEAD 解析为 dev。
 *
 * 只使用当前已构建的 lib（templates/bundled.js + core.js + workflows/loader.js），
 * 在 mkdtemp 临时目录操作；不碰用户仓库、不安装依赖、不向用户仓库提交。
 *
 * CLI：node e2e/helpers/integration-default-branch.mjs [--default-branch=<branch>]
 * 输出：最后一行 `PROBE_RESULT <json>`；失败时打印 `PROBE_ERROR ...` 并以 1 退出。
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..', '..')
const bundledUrl = pathToFileURL(join(pluginRoot, 'lib/templates/bundled.js')).href
const coreUrl = pathToFileURL(join(pluginRoot, 'lib/core.js')).href
const loaderUrl = pathToFileURL(join(pluginRoot, 'lib/workflows/loader.js')).href

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function parseDefaultBranch(argv) {
  const arg = argv.find((item) => item.startsWith('--default-branch='))
  return arg === undefined ? undefined : arg.slice('--default-branch='.length)
}

async function run(defaultBranch) {
  const root = await mkdtemp(join(tmpdir(), 'taktflow-integration-branch-'))
  try {
    // 真实临时仓库：release 基线，dev 多一个提交，HEAD=dev。
    git(root, ['init', '-b', 'release'])
    git(root, ['config', 'user.email', 'probe@example.com'])
    git(root, ['config', 'user.name', 'probe'])
    await writeFile(join(root, 'base.txt'), 'release\n')
    git(root, ['add', 'base.txt'])
    git(root, ['commit', '-m', 'release base'])
    const releaseSha = git(root, ['rev-parse', 'HEAD'])
    git(root, ['checkout', '-b', 'dev'])
    await writeFile(join(root, 'dev-only.txt'), 'dev only\n')
    git(root, ['add', 'dev-only.txt'])
    git(root, ['commit', '-m', 'dev only'])
    const devSha = git(root, ['rev-parse', 'HEAD'])

    // 空间配置：显式分支只在传参时写入；省略时由 integration 模板解析 HEAD。
    const { initProject, openProject, createEngine } = await import(coreUrl)
    await initProject(root, { name: 'probe' })
    const configFile = join(root, 'takt.config.json')
    const config = JSON.parse(await readFile(configFile, 'utf8'))
    config.repos = [{ id: 'main', path: '.', ...(defaultBranch === undefined ? {} : { defaultBranch }) }]
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`)

    // 随包 integration 模板 + 单节点 wrapper，交给真实 loader/core engine。
    const { BUNDLED_WORKFLOW_FILES } = await import(bundledUrl)
    const template = BUNDLED_WORKFLOW_FILES.find((file) => file.fileName === 'taktflow-standard.integration.ts')
    if (template === undefined) throw new Error('随包模板缺少 taktflow-standard.integration.ts')
    await writeFile(join(root, 'probe-integration.ts'), template.content)
    await writeFile(join(root, 'probe.workflow.ts'), [
      "import { defineWorkflow, script } from '@taktflow/core'",
      "import { integrate } from './probe-integration.js'",
      '',
      'export default defineWorkflow({',
      "  id: 'probe-integration-flow', title: 'probe integration', version: '1',",
      "  stages: [{ id: 'develop', title: 'develop' }],",
      "  nodes: [script({ id: 'integration', title: '集成任务分支', stage: 'develop', run: integrate })],",
      '})',
      '',
    ].join('\n'))

    const { WorkflowFileLoader } = await import(loaderUrl)
    const loader = new WorkflowFileLoader({
      coreEntry: join(pluginRoot, 'lib/core.js'),
      sandboxEntry: join(pluginRoot, 'lib/sandbox.js'),
    })
    const loaded = await loader.load(join(root, 'probe.workflow.ts'))

    const stores = await openProject(root)
    const requirement = await stores.workspaces.createRequirement({ title: 'defaultBranch probe' })
    const state = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
      .start({ requirementId: requirement.id, workflow: loaded.workflow })
    const node = state.nodes.integration
    if (node?.status !== 'succeeded') throw new Error(`integration 节点失败：${node?.status}`)

    const worktree = node.result?.repositories?.app?.path
    if (typeof worktree !== 'string' || worktree === '') throw new Error('integration 结果缺少 app worktree')
    const head = git(worktree, ['rev-parse', 'HEAD'])
    const files = git(worktree, ['ls-files']).split('\n')
    const hasDevOnlyFile = files.includes('dev-only.txt')
    let containsDevCommit = true
    try {
      git(worktree, ['merge-base', '--is-ancestor', devSha, 'HEAD'])
    } catch {
      containsDevCommit = false
    }

    // 行为断言：显式分支取 release；省略分支取真实 HEAD（dev）。
    if (defaultBranch === undefined) {
      if (head !== devSha) throw new Error(`省略 defaultBranch 应取 HEAD=dev，实际 ${head}`)
      if (!hasDevOnlyFile) throw new Error('省略 defaultBranch 的 worktree 应包含 dev-only.txt')
    } else {
      if (head !== releaseSha) throw new Error(`显式 defaultBranch=${defaultBranch} 应取 release，实际 ${head}`)
      if (hasDevOnlyFile) throw new Error('显式 defaultBranch 的 worktree 不应包含 dev-only.txt')
      if (containsDevCommit) throw new Error('显式 defaultBranch 的 worktree 不应包含 dev 提交')
    }

    return {
      defaultBranch: defaultBranch ?? null,
      releaseSha,
      devSha,
      head,
      hasDevOnlyFile,
      containsDevCommit,
      branch: node.result.branch,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

try {
  const result = await run(parseDefaultBranch(process.argv.slice(2)))
  console.log(`PROBE_RESULT ${JSON.stringify(result)}`)
} catch (error) {
  console.error(`PROBE_ERROR ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
