#!/usr/bin/env node
/**
 * 校验 cordis.patch.yml 的 Lead preset 白名单。
 *
 * 若设置了 TAKT_DSH_MODULES（指向已安装包的 node_modules 根目录），同时校验每个
 * 包目录真实存在；否则只做静态白名单校验并提示。
 */
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

const ALLOWED_PLUGINS = new Set([
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-ask-user',
  'taktflow/lead',
])

export async function checkPreset(options = {}) {
  const problems = []
  const warnings = []
  const patchFile = path.join(packageRoot, 'cordis.patch.yml')
  const document = parse(await readFile(patchFile, 'utf8'))
  if (!Array.isArray(document)) return { problems: ['cordis.patch.yml 顶层必须是数组'], warnings }

  const rows = document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
  const hostRow = rows.find((row) => row?.id === 'taktflow')
  if (hostRow === undefined) problems.push('缺少宿主行 id: taktflow')
  else if (hostRow.name !== 'taktflow') problems.push('宿主行 name 必须是精确包名 taktflow')

  const presetRow = rows.find((row) => row?.id === 'preset-taktflow')
  if (presetRow === undefined) {
    problems.push('缺少 preset 行 id: preset-taktflow')
  } else {
    if (presetRow.name !== '@deepseek-ai/dsh-agent-preset') {
      problems.push('preset 行必须使用 @deepseek-ai/dsh-agent-preset')
    }
    const config = presetRow.config ?? {}
    if (config.id !== 'taktflow') problems.push('preset.config.id 必须是 taktflow')
    if (config.name !== 'taktflow') problems.push('preset.config.name 必须是 taktflow')
    if (config.order !== 30) problems.push('preset.config.order 必须是 30')
    if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
      problems.push('preset.config.plugins 不能为空')
    } else {
      for (const plugin of config.plugins) {
        if (!ALLOWED_PLUGINS.has(plugin?.name)) problems.push(`preset 含白名单外的插件：${plugin?.name}`)
      }
      const byName = new Map(config.plugins.map((plugin) => [plugin?.name, plugin]))
      if (!byName.has('taktflow/lead')) problems.push('preset 缺少 taktflow/lead 行')
      const fs = byName.get('@deepseek-ai/dsh-tool-fs')
      if (fs?.config?.write !== false || fs?.config?.edit !== false) {
        problems.push('dsh-tool-fs 必须关闭 write 与 edit')
      }
      const search = byName.get('@deepseek-ai/dsh-tool-fs-search')
      if (typeof search?.config?.sampleOverCapGlobResults !== 'boolean') {
        problems.push('dsh-tool-fs-search 必须显式设置 sampleOverCapGlobResults')
      }
      const persona = byName.get('@deepseek-ai/dsh-persona')
      if (typeof persona?.config?.prefix !== 'string' || persona.config.prefix.trim() === '') {
        problems.push('dsh-persona 必须提供非空 prefix')
      }
      const instructions = byName.get('@deepseek-ai/dsh-agent-instructions')
      if (!(typeof instructions?.config?.maxBytes === 'number' && instructions.config.maxBytes > 0)) {
        problems.push('dsh-agent-instructions 必须提供正数 maxBytes')
      }
      for (const forbidden of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh']) {
        if (byName.has(forbidden)) problems.push(`Lead 不能挂载 shell 工具：${forbidden}`)
      }
    }
  }

  const modules = options.modules ?? process.env.TAKT_DSH_MODULES
  if (modules !== undefined && modules !== '') {
    for (const name of ALLOWED_PLUGINS) {
      if (!name.startsWith('@deepseek-ai/')) continue
      const dir = path.join(modules, name)
      try {
        await access(path.join(dir, 'package.json'))
      } catch {
        problems.push(`TAKT_DSH_MODULES 下缺少包：${name}`)
      }
    }
  } else {
    warnings.push('未设置 TAKT_DSH_MODULES，跳过已安装包目录校验（仅做白名单检查）')
  }

  return { problems, warnings }
}

async function main() {
  const { problems, warnings } = await checkPreset()
  for (const warning of warnings) console.warn(`[preset-check] ${warning}`)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[preset-check] ${problem}`)
    process.exit(1)
  }
  console.log('[preset-check] 通过')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[preset-check] 失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
