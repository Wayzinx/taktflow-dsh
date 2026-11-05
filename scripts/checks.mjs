/**
 * 构建产物的静态检查。
 *
 * 这些检查在 build.mjs 里失败即退出非零，也由单测直接调用，保证规则本身可测。
 */

/** 客户端只能从宿主模块表拿这四个模块。 */
export const CLIENT_REQUIRE_ALLOWLIST = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
]

/** 宿主客户端包：客户端 bundle 出现即失败（会导致重复 React/宿主内部 API 耦合）。 */
export const FORBIDDEN_CLIENT_PREFIX = '@deepseek-ai/'

export function extractRequires(code) {
  const found = new Set()
  const pattern = /\b(?:require|__require\d*)\s*\(\s*(['"])([^'"]+)\1\s*\)/g
  let match
  while ((match = pattern.exec(code)) !== null) found.add(match[2])
  return [...found]
}

export function checkClientBundle(code) {
  const problems = []
  if (!/window\.__ModuleLoader__\.load\(\s*\{/.test(code)) {
    problems.push('缺少 window.__ModuleLoader__.load({...}) 包装')
  }
  if (!/id\s*:\s*['"]taktflow['"]/.test(code)) {
    problems.push('ModuleLoader id 必须是 taktflow')
  }
  if (!/factory\s*\(\s*require\s*\)/.test(code)) {
    problems.push('factory 必须接收 require 参数')
  }
  if (!/inject\s*:\s*\[[^\]]*['"]slots['"]/.test(code)) {
    problems.push('factory 返回的 inject 必须包含 slots')
  }
  if (!/\bapply\b/.test(code)) {
    problems.push('factory 必须返回 apply')
  }

  for (const specifier of extractRequires(code)) {
    if (!CLIENT_REQUIRE_ALLOWLIST.includes(specifier)) {
      problems.push(`客户端 require 不在白名单：${specifier}`)
    }
  }
  if (code.includes(FORBIDDEN_CLIENT_PREFIX)) {
    problems.push(`客户端 bundle 含宿主包引用：${FORBIDDEN_CLIENT_PREFIX}*`)
  }
  if (/^\s*(?:import|export)\s/m.test(code)) {
    problems.push('客户端 bundle 不应含 ESM import/export（应为 ModuleLoader 包装）')
  }
  return problems
}

/** 宿主产物不能留下对 @taktflow/* 的裸导入（应已打进 bundle）。 */
export function checkHostBundle(code) {
  const problems = []
  const bare = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\b(?:require|__require\d*)\s*\(\s*)['"]@taktflow\//g
  let match
  while ((match = bare.exec(code)) !== null) {
    problems.push(`宿主产物含 @taktflow/* 裸导入：${match[0]}`)
  }
  return problems
}

/** IIFE 在 factory 的词法作用域中解析宿主 require 和作用域 CSS。 */
export function wrapClientBundle(clientCode, css) {
  return [
    'window.__ModuleLoader__.load({',
    "  id: 'taktflow',",
    '  factory(require) {',
    `    const __taktflowCss = ${JSON.stringify(css)};`,
    clientCode,
    "    return { inject: ['slots'], apply: __taktflowClient.apply };",
    '  },',
    '});',
    '',
  ].join('\n')
}

export function checkPackageManifest(manifest) {
  const problems = []
  if (manifest.name !== 'taktflow') problems.push('package.name 必须是 taktflow')
  if (manifest.type !== 'module') problems.push('package.type 必须是 module')
  if (manifest.private !== false) problems.push('package.private 必须是 false')
  if (manifest.license !== 'MIT') problems.push('package.license 必须是 MIT')
  if (manifest.icon !== './icon.svg') problems.push('package.icon 必须指向 ./icon.svg')
  const exports = manifest.exports ?? {}
  const expected = {
    '.': './lib/host.js',
    './lead': './lib/lead.js',
    './role': './lib/role.js',
    './client': './lib/client.js',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (exports[key] !== value) problems.push(`exports[${key}] 应为 ${value}`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push('dsh.bundle.patch 必须指向 ./cordis.patch.yml')
  }
  if (manifest.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform 必须是 web')
  const inject = manifest.dsh?.client?.inject ?? []
  if (!inject.includes('@deepseek-ai/dsh-client-ui-sidebar')) {
    problems.push('dsh.client.inject 必须包含 @deepseek-ai/dsh-client-ui-sidebar')
  }
  if (manifest.engines?.dsh !== '>=0.2.1-rc.3 <0.3.0') {
    problems.push('engines.dsh 必须是 >=0.2.1-rc.3 <0.3.0')
  }
  if (manifest.dependencies === undefined || Object.keys(manifest.dependencies).length !== 0) {
    problems.push('dependencies 必须为空（core 由构建打入）')
  }
  return problems
}
