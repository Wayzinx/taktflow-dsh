#!/usr/bin/env node
/**
 * 打 tgz：先构建，再用 `npm pack --json` 打到临时目录。
 *
 * 绝不把 tgz 留在仓库里；调用方可以用返回的 cleanup() 删除临时目录。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

export async function packTaktflow(options = {}) {
  const { buildFirst = true } = options
  if (buildFirst) {
    await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts/build.mjs')], {
      cwd: packageRoot,
      stdio: 'inherit',
    })
  }

  const destination = await mkdtemp(path.join(tmpdir(), 'taktflow-pack-'))
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', destination],
      { cwd: packageRoot },
    )
    const parsed = JSON.parse(stdout)
    const filename = parsed?.[0]?.filename
    if (typeof filename !== 'string' || filename === '') {
      throw new Error(`npm pack 没有返回文件名：${stdout}`)
    }
    const tgz = path.join(destination, filename)
    await assertTarballContents(tgz)

    return {
      tgz,
      destination,
      cleanup: async () => {
        await rm(destination, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function assertTarballContents(tgz) {
  const { stdout } = await execFileAsync('tar', ['-tzf', tgz])
  const entries = stdout.split('\n').filter(Boolean)
  const required = [
    'package/package.json',
    'package/cordis.patch.yml',
    'package/lib/host.js',
    'package/lib/client.js',
    'package/lib/lead.js',
    'package/lib/role.js',
    'package/locale/en.json',
    'package/locale/zh.json',
    'package/icon.svg',
    'package/README.md',
  ]
  const missing = required.filter((entry) => !entries.includes(entry))
  if (missing.length > 0) {
    throw new Error(`tgz 缺少文件：${missing.join(', ')}`)
  }
  const leaked = entries.filter((entry) => entry.startsWith('package/src/') || entry.includes('.test.'))
  if (leaked.length > 0) {
    throw new Error(`tgz 不应包含源码/测试：${leaked.join(', ')}`)
  }
  // 读一次 package.json，确认 npm 没有因为 files 写错而丢掉 exports。
  const { stdout: manifestText } = await execFileAsync('tar', ['-xzOf', tgz, 'package/package.json'])
  const manifest = JSON.parse(manifestText)
  if (manifest.name !== 'taktflow' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('tgz 内的 package.json 与预期不符')
  }
}

async function main() {
  const packed = await packTaktflow()
  console.log(packed.tgz)
  // CLI 模式保留临时目录，方便调用方立刻安装；目录在系统临时区，不会进仓库。
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[pack:dsh] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
