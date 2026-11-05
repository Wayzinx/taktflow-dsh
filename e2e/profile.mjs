#!/usr/bin/env node
/**
 * S4 第一步：在隔离 DSH_HOME 里初始化 web profile、安装本包、写入模型路由。
 *
 * 运行：
 *   TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... \
 *     node e2e/profile.mjs
 *
 * 地址和 key 只从进程环境读取；落盘的状态文件不含 baseURL/key。成功时保留
 * 隔离目录给 boot.mjs 使用，失败时清理本次创建的资源。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { packTaktflow } from '../scripts/pack.mjs'
import {
  cleanupOwnedHome,
  isDirectRun,
  outDir,
  packageRoot,
  prepareOwnedHome,
  requireEnv,
  resolveDshBin,
  resolveE2eHome,
  runCommand,
  sanitize,
  writeJson,
} from './lib.mjs'

function renderPatch(env) {
  const quote = (value) => JSON.stringify(value)
  return [
    '# 由 e2e/profile.mjs 生成，仅用于隔离 e2e；不要提交。',
    '# id 定向 patch 会替换整段 config，因此需要保留的字段必须重述。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      takt-e2e:',
    '        api: openai-completions',
    '        baseURL: !!js process.env.TAKT_E2E_BASE_URL',
    '        apiKeyEnv: TAKT_E2E_API_KEY',
    '        models:',
    `          - id: ${quote(env.TAKT_E2E_MODEL)}`,
    '- id: agent-default-model',
    '  config:',
    '    provider: takt-e2e',
    `    model: ${quote(env.TAKT_E2E_MODEL)}`,
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
  ].join('\n')
}

async function main() {
  const env = requireEnv(['TAKT_E2E_BASE_URL', 'TAKT_E2E_MODEL', 'TAKT_E2E_API_KEY'])
  const secrets = [env.TAKT_E2E_BASE_URL, env.TAKT_E2E_API_KEY]
  const dshBin = await resolveDshBin()
  const home = await prepareOwnedHome(resolveE2eHome())
  const childEnv = {
    ...process.env,
    DSH_HOME: home,
    CI: '1',
    NO_COLOR: '1',
    npm_config_cache: path.join(home, '.npm-cache'),
    npm_config_store_dir: path.join(home, '.pnpm-store'),
    PNPM_HOME: path.join(home, '.pnpm'),
  }
  const result = {
    ok: false,
    home,
    profile: 'web',
    provider: 'takt-e2e',
    model: env.TAKT_E2E_MODEL,
    baseUrlEnv: 'TAKT_E2E_BASE_URL',
    apiKeyEnv: 'TAKT_E2E_API_KEY',
    createdAt: new Date().toISOString(),
    steps: [],
  }
  let packed

  try {
    await mkdir(outDir, { recursive: true })

    // 先构建 + 打包，确保安装的是当前工作区产物。
    packed = await packTaktflow({ buildFirst: true })
    result.steps.push({ name: 'build-and-pack', status: 'pass' })

    await runCommand(dshBin, ['plugin', '--profile', 'web', 'add', packed.tgz], {
      env: childEnv,
      cwd: packageRoot,
      timeoutMs: 600_000,
      secrets,
      label: 'dsh plugin --profile web add',
    })
    result.steps.push({ name: 'plugin-add', status: 'pass' })

    const profileDir = path.join(home, 'profiles', 'web')
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles) || !bundles.includes('taktflow') || !bundles.includes('@deepseek-ai/dsh-web-app')) {
      throw new Error('安装读回失败：web profile 必须同时包含 taktflow 和 dsh-web-app bundle')
    }
    result.steps.push({ name: 'installed-bundles-readback', status: 'pass', bundles })

    const before = await runCommand(dshBin, ['--profile', 'web', '--dump-config'], {
      env: childEnv,
      cwd: packageRoot,
      timeoutMs: 120_000,
      secrets,
      label: 'dsh --profile web --dump-config (before)',
      outputLimit: Infinity,
    })
    await writeFile(
      path.join(outDir, 'profile-config-before.yml'),
      `${sanitize(before.stdout, secrets)}\n`,
      'utf8',
    )
    result.steps.push({ name: 'dump-config-before', status: 'pass' })

    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), renderPatch(env), 'utf8')
    result.steps.push({ name: 'write-profile-patch', status: 'pass' })

    const after = await runCommand(dshBin, ['--profile', 'web', '--dump-config'], {
      env: childEnv,
      cwd: packageRoot,
      timeoutMs: 120_000,
      secrets,
      label: 'dsh --profile web --dump-config (after)',
      outputLimit: Infinity,
    })
    await writeFile(
      path.join(outDir, 'profile-config.yml'),
      `${sanitize(after.stdout, secrets)}\n`,
      'utf8',
    )
    result.steps.push({ name: 'dump-config-after', status: 'pass' })

    result.ok = true
    await writeJson(path.join(outDir, 'state.json'), {
      home,
      profile: 'web',
      provider: 'takt-e2e',
      model: env.TAKT_E2E_MODEL,
      dshBin,
      baseUrlEnv: 'TAKT_E2E_BASE_URL',
      apiKeyEnv: 'TAKT_E2E_API_KEY',
      createdAt: result.createdAt,
    }, secrets)
    await writeJson(path.join(outDir, 'profile-result.json'), result, secrets)
    console.log(`S4 profile ready: ${result.steps.length} checks passed (provider=takt-e2e)`)
    console.log(`状态：${path.join(outDir, 'state.json')}`)
  } catch (error) {
    result.error = sanitize(error instanceof Error ? error.message : String(error), secrets)
    await writeJson(path.join(outDir, 'profile-result.json'), result, secrets).catch(() => {})
    try {
      await cleanupOwnedHome(home)
    } catch {
      // 保留原始错误；清理失败不应覆盖 profile 失败原因。
    }
    throw error
  } finally {
    await packed?.cleanup()
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    const secrets = [process.env.TAKT_E2E_BASE_URL, process.env.TAKT_E2E_API_KEY]
    console.error(`[e2e:profile] 失败：${sanitize(error instanceof Error ? error.stack ?? error.message : String(error), secrets)}`)
    process.exit(1)
  })
}
