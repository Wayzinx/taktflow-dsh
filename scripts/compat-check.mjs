#!/usr/bin/env node
/**
 * dsh 版本兼容检查：engines.dsh = >=0.2.1-rc.3 <0.3.0。
 *
 * DSH_BIN 可覆盖可执行文件路径；默认使用本机 App 的 CLI。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

export function parseDshVersion(output) {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/.exec(output)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

export function isCompatible(version) {
  if (version === undefined) return false
  if (version.major !== 0 || version.minor !== 2) return false
  if (version.patch > 1) return true
  if (version.patch < 1) return false
  if (version.prerelease === undefined) return true
  const rc = /^rc\.(\d+)$/.exec(version.prerelease)
  return rc !== null && Number(rc[1]) >= 3
}

async function main() {
  const binary = process.env.DSH_BIN ?? DEFAULT_DSH
  let output
  try {
    const result = await execFileAsync(binary, ['--version'])
    output = `${result.stdout}\n${result.stderr}`.trim()
  } catch (error) {
    console.error(`[compat-check] 无法运行 dsh（${binary}）：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const version = parseDshVersion(output)
  if (!isCompatible(version)) {
    console.error(`[compat-check] dsh 版本不兼容：${output}（需要 >=0.2.1-rc.3 <0.3.0）`)
    process.exit(1)
  }
  console.log(`[compat-check] 通过：${output.split('\n')[0]}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[compat-check] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
