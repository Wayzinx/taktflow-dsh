import path from 'node:path'
import type { SpaceHandle } from './types.js'

/**
 * 空间配置所在位置（相对空间根的 glob）：角色、流程（含流程图布局）、技能、知识库、评测和 takt.config.json。
 * 面板和 takt_config 改配置是宿主写入，运行中改动不能算成正在执行节点的越界；
 * 需求产物不在其中，照旧由节点窗口检查。位置取 stores.paths，自定义布局也对。
 */
export function spaceConfigPatterns(space: SpaceHandle): string[] {
  const patterns = ['takt.config.json']
  const paths = space.stores.paths as Partial<Record<'agents' | 'workflows' | 'skills' | 'knowledge' | 'evals', string>> | undefined
  for (const key of ['agents', 'workflows', 'skills', 'knowledge', 'evals'] as const) {
    const dir = paths?.[key]
    if (dir === undefined) continue
    const relative = path.relative(space.root, dir).split(path.sep).join('/')
    if (relative === '' || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue
    patterns.push(`${relative}/**`)
  }
  return patterns
}
