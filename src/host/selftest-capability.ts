import path from 'node:path'
import type { SpaceHandle } from './types.js'

/**
 * 需求产物区与知识库的标准/旧版别名（相对空间根）。
 * 这些目录里的写入是文档产物，不代表角色能改项目代码或测试。
 */
const ARTIFACT_ALIASES = ['requirements', '.takt/workspaces', 'knowledge', '.takt/knowledge'] as const

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/** 把空间内绝对路径转成相对空间根的 POSIX 路径；根外、根自身或空值返回 undefined。 */
function relativeRoot(spaceRoot: string, absolute: unknown): string | undefined {
  if (typeof absolute !== 'string' || absolute === '') return undefined
  const relative = path.relative(spaceRoot, absolute)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined
  }
  return toPosix(relative)
}

/**
 * 当前空间允许“只写文档产物”的根：实际配置的 requirements/knowledge 目录
 * 加标准/旧版别名。自定义布局（如 artifacts/reqs）按 stores.paths 识别。
 */
function artifactRoots(space: SpaceHandle): string[] {
  const roots = new Set<string>(ARTIFACT_ALIASES)
  const paths = space.stores?.paths
  const requirements = relativeRoot(space.root, paths?.requirements)
  const knowledge = relativeRoot(space.root, paths?.knowledge)
  if (requirements !== undefined) roots.add(requirements)
  if (knowledge !== undefined) roots.add(knowledge)
  return [...roots]
}

/**
 * 单个写入模式是否被需求产物区/知识库完全覆盖。
 *
 * 只认字面前缀边界（等于根，或以 `根/` 开头），因此 `requirements-code/**`
 * 不会被当成 `requirements/**`。先按 POSIX 规范化 `..`，避免
 * `requirements/../src/**` 伪装成产物范围；绝对路径和空模式不当作产物范围。
 */
export function isArtifactOnlyPattern(pattern: string, roots: readonly string[]): boolean {
  if (typeof pattern !== 'string') return false
  const normalized = path.posix.normalize(pattern.trim().split('\\').join('/'))
  if (normalized === '' || normalized === '.' || normalized === '..'
    || normalized.startsWith('/') || normalized.startsWith('../')) {
    return false
  }
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))
}

/**
 * 非只读角色是否应获得受控自测能力。
 *
 * 只看本次实际冻结的 writeScope：全部落在当前需求产物区或知识库（含标准/旧版
 * 别名和空间自定义 paths）的角色是文档型角色，不挂自测工具，也不冻结 QA 命令；
 * 只要有一个模式可能写到项目代码/测试（src/**、tests/**、package.json、**、
 * 自定义代码目录等）就保留能力。只读或空范围一律不挂。不按角色名或提示词判断，
 * 自定义代码写入角色同样适用。
 */
export function canUseSelftest(space: SpaceHandle, writeScope: readonly string[], readOnly: boolean): boolean {
  if (readOnly || writeScope.length === 0) return false
  const roots = artifactRoots(space)
  return !writeScope.every((pattern) => isArtifactOnlyPattern(pattern, roots))
}
