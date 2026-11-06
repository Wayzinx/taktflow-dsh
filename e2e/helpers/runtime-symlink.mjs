#!/usr/bin/env node
/**
 * 运行时入口 symlink 探针（仅供测试/诊断，不碰用户仓库）。
 *
 * 复现 dsh 安装形态：node_modules/taktflow 是指向物理 store 的 symlink。
 * 注意：dsh 实际启动脚本没有显式传 --preserve-symlinks；app.asar 内的 boot
 * 包装会拦截 resolveSync 并保留 logical 路径。本探针用 Node 原生 flag 制造
 * 同一类 logical/physical 混用，不声称 dsh 启用了该 flag。
 * 子进程用 --preserve-symlinks 加载 logical lib，先构造插件 workflow catalog
 * （生产里宿主服务创建时就会安装 module hook），再跑真实 core engine 的 agent
 * 节点（mock harness），触发 core chunk 动态 import('@taktflow/sandbox')；随后
 * 用 loader 加载一个返回 FsAttentionStore 的临时 workflow，比较宿主空间
 * stores.attention 的 instanceof/constructor 身份。
 *
 * 输出一行 `PROBE_RESULT <json>`；失败以非零退出。
 *
 * 用法：
 *   node e2e/helpers/runtime-symlink.mjs            # symlink + --preserve-symlinks
 *   node e2e/helpers/runtime-symlink.mjs --normal   # symlink，不保留（Node 默认 realpath）
 */
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const mode = process.argv.includes('--normal') ? 'normal' : 'preserve'

const CHILD = String.raw`
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [libDir, spaceDir] = process.argv.slice(2)
const core = await import(pathToFileURL(path.join(libDir, 'core.js')).href)
const catalogModule = await import(pathToFileURL(path.join(libDir, 'workflows', 'index.js')).href)
const urlProbe = await import(pathToFileURL(path.join(libDir, 'url-probe.js')).href)

// 生产里 catalog/loader 在宿主服务创建时就构造并安装 hook；必须早于任何 core
// 动态 import('@taktflow/sandbox')，否则这里测的就不是 hook 映射而是裸 Node 解析。
const catalog = catalogModule.createWorkflowCatalog()
const stores = await core.initProject(spaceDir)
const requirement = await stores.workspaces.createRequirement({ title: 'runtime symlink probe' })
const profile = {
  role: 'dev', title: 'dev', description: '', instructions: '', skills: [], writeScope: [],
  harness: { harness: 'mock' },
}
const harness = {
  id: 'mock', displayName: 'mock', capabilities: {},
  available: async () => ({ ok: true }),
  run: async () => ({ ok: true, finalText: '' }),
}
const workflow = {
  id: 'runtime-symlink-probe', title: 'runtime symlink probe', version: '1',
  stages: [{ id: 'delivery', title: '交付' }],
  nodes: [core.agent({ id: 'work', title: 'work', stage: 'delivery', role: 'dev', harness: { harness: 'mock' }, prompt: '完成任务', writeScope: [] })],
}
// 真实 core agent 路径：sandboxCall 会动态 import('@taktflow/sandbox')。
const state = await core.createEngine({
  stores, profiles: { dev: profile }, knowledge: [], harnesses: { mock: harness },
}).start({ requirementId: requirement.id, workflow })
let failure
if (state.status !== 'succeeded') {
  const run = await stores.runs.get(state.runId)
  const events = await stores.events.read(state.runId)
  failure = {
    status: run?.status,
    nodeErrors: Object.fromEntries(Object.entries(run?.nodes ?? {}).filter(([, node]) => node?.error).map(([id, node]) => [id, node.error])),
    eventErrors: events.filter((event) => event.type === 'node.failed' || event.type === 'log').map((event) => event.data).slice(-5),
  }
}

// workflow 侧 core 与宿主 core 必须同一实例，否则 FsAttentionStore 构造器不同。
const dir = path.join(stores.taktDir, 'dsh')
await mkdir(dir, { recursive: true })
const file = path.join(dir, 'runtime-symlink-core.workflow.ts')
await writeFile(file, [
  "import { FsAttentionStore, defineWorkflow, script } from '@taktflow/core'",
  '',
  'export default defineWorkflow({',
  "  id: 'runtime-symlink-core',",
  "  title: 'runtime symlink core',",
  "  version: '1',",
  '  stages: [],',
  "  nodes: [script({ id: 'class', title: 'class', run: async () => FsAttentionStore })],",
  '})',
  '',
].join('\n'), 'utf8')
const loaded = await catalog.loadFile(file)
const cls = await loaded.workflow.nodes[0].run({})
const attention = stores.attention

const result = {
  moduleUrl: urlProbe.url,
  engineStatus: state.status,
  sandboxImported: state.status === 'succeeded',
  attentionInstanceof: attention instanceof cls,
  attentionConstructor: attention.constructor === cls,
  workflowCoreSame: attention instanceof cls && attention.constructor === cls,
  failure,
}
console.log('PROBE_RESULT ' + JSON.stringify(result))
if (result.engineStatus !== 'succeeded' || !result.workflowCoreSame) process.exitCode = 1
`

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-runtime-symlink-'))
  try {
    const physical = path.join(root, 'store', 'taktflow')
    await mkdir(path.dirname(physical), { recursive: true })
    await cp(path.join(repoRoot, 'lib'), path.join(physical, 'lib'), { recursive: true })
    await writeFile(path.join(physical, 'package.json'), JSON.stringify({ name: 'taktflow', type: 'module' }))
    // 标记模块真实加载到的 URL 形态：preserve 下应保持 logical，normal 下应是 physical。
    await writeFile(path.join(physical, 'lib', 'url-probe.js'), 'export const url = import.meta.url\n')

    const logical = path.join(root, 'home', 'profiles', 'web', 'node_modules', 'taktflow')
    await mkdir(path.dirname(logical), { recursive: true })
    await symlink(physical, logical, 'dir')
    const space = path.join(root, 'space')
    const child = path.join(root, 'child.mjs')
    await writeFile(child, CHILD, 'utf8')

    const args = mode === 'preserve'
      ? ['--preserve-symlinks', child, path.join(logical, 'lib'), space]
      : [child, path.join(logical, 'lib'), space]
    let stdout
    try {
      ;({ stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8', timeout: 90_000 }))
    } catch (error) {
      const stderr = String(error?.stderr ?? '').trim()
      const partial = String(error?.stdout ?? '').trim()
      throw new Error(`child 失败（mode=${mode}）：${stderr || partial || String(error?.message ?? error)}`)
    }
    const line = stdout.split('\n').find((entry) => entry.startsWith('PROBE_RESULT '))
    if (line === undefined) throw new Error(`child 未返回 PROBE_RESULT：${stdout.slice(-2_000)}`)
    const result = JSON.parse(line.slice('PROBE_RESULT '.length))
    console.log(`PROBE_RESULT ${JSON.stringify({ mode, ...result })}`)
    if (result.engineStatus !== 'succeeded' || result.workflowCoreSame !== true) process.exitCode = 1
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error).replaceAll(repoRoot, '<repo>'))
  process.exitCode = 1
})
