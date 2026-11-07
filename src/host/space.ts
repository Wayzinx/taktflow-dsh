import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createInsights, openProject } from '@taktflow/core'
import { withSpaceMutationLock } from './space-lock.js'
import { TaktToolError, type SpaceHandle, type SpaceRegistry } from './types.js'

const CONFIG_FILE = 'takt.config.json'

/**
 * 真实的空间注册表。
 *
 * 多空间：每个会话目录（就是空间根）各自打开，租约、通知、运行都按空间隔离。宿主配置了
 * spaces 时只允许这些根；同一个根的 symlink 在 realpath 后去重。core 的 openProject 会
 * 向上查找 takt.config.json，所以这里先确认“配置就在给定目录里”，再打开并核对 projectDir；
 * 已打开空间的子目录不能再当成空间（嵌套空间会让两份配置争同一批文件）。
 *
 * open 串行化：并发打开同一个根返回同一个 handle。锁与 `takt_requirement init` 共用
 * （space-lock），保证 init 的写盘与 open 不会交错。失败不会占住空间，可以重试。
 */
export class FsSpaceRegistry implements SpaceRegistry {
  private readonly configured: string[]
  private readonly cache = new Map<string, SpaceHandle>()
  private configuredResolved: Promise<string[]> | undefined

  constructor(config: { spaces?: string[] } = {}) {
    this.configured = (config.spaces ?? []).map((space) => path.resolve(space))
  }

  /** 配置的根在前（按配置顺序），然后是运行中打开过的根（按打开顺序）。 */
  async roots(): Promise<string[]> {
    const configured = await this.resolveConfigured()
    return [...new Set([...configured, ...this.cache.keys()])]
  }

  async open(root: string): Promise<SpaceHandle> {
    const resolved = await this.realpath(root, '空间根不存在或不可访问')
    return withSpaceMutationLock(async () => {
      await this.assertConfiguredRoot(resolved)
      const cached = this.cache.get(resolved)
      if (cached !== undefined) return cached
      this.assertNotNested(resolved)

      if (!(await exists(path.join(resolved, CONFIG_FILE)))) {
        throw new TaktToolError(
          'TAKT_NO_SPACE',
          `不是 Taktflow 空间根：${resolved} 下没有 ${CONFIG_FILE}`,
          '请在空间根初始化项目，或把宿主配置的 spaces 指向包含 takt.config.json 的目录。',
        )
      }

      const stores = await openProject(resolved)
      const projectDir = await this.realpath(stores.projectDir, '项目根不可访问')
      if (projectDir !== resolved) {
        // openProject 只可能向上找到别的根；这属于配置错误，不是可恢复状态。
        throw new TaktToolError(
          'TAKT_SPACE_ROOT_MISMATCH',
          `空间根解析不一致：请求 ${resolved}，实际打开 ${projectDir}`,
          '检查 takt.config.json 是否位于空间根，且没有嵌套的 Taktflow 项目。',
        )
      }

      const handle: SpaceHandle = { root: resolved, stores, insights: createInsights(stores) }
      this.cache.set(resolved, handle)
      return handle
    })
  }

  async forSession(cwd: string | undefined): Promise<SpaceHandle> {
    if (cwd === undefined || cwd === '') {
      throw new TaktToolError(
        'TAKT_NO_SPACE',
        '当前会话没有工作目录，无法解析 Taktflow 空间',
        '请在空间根目录下打开会话，或在宿主配置里设置 spaces。',
      )
    }
    const resolved = await this.realpath(cwd, '会话工作目录不存在或不可访问')
    const configured = await this.resolveConfigured()
    const known = [...new Set([...configured, ...this.cache.keys()])]
    if (known.includes(resolved)) return this.open(resolved)
    const parent = known.find((root) => isInside(resolved, root))
    if (parent !== undefined) {
      throw new TaktToolError(
        'TAKT_SPACE_ROOT_MISMATCH',
        `会话目录必须是空间根，不能是子目录：${resolved}`,
        `请把会话工作目录切到 ${parent}。`,
      )
    }
    if (configured.length > 0) {
      throw new TaktToolError(
        'TAKT_NO_SPACE',
        `当前目录不在已配置的 Taktflow 空间内：${resolved}`,
        '检查宿主配置的 spaces。',
      )
    }
    if (await exists(path.join(resolved, CONFIG_FILE))) return this.open(resolved)
    throw new TaktToolError(
      'TAKT_NO_SPACE',
      `当前目录不是 Taktflow 空间根：${resolved}`,
      '在空间根初始化项目，或在宿主配置里设置 spaces。',
    )
  }

  async assertOpenable(root: string): Promise<void> {
    const resolved = await this.realpath(root, '空间根不存在或不可访问')
    await this.assertConfiguredRoot(resolved)
    if (!this.cache.has(resolved)) this.assertNotNested(resolved)
  }

  /** 解析配置里的根并去重（同一个根的不同路径 / symlink 合并）。 */
  private async resolveConfigured(): Promise<string[]> {
    if (this.configured.length === 0) return []
    this.configuredResolved ??= (async () => {
      const roots = new Set<string>()
      for (const configured of this.configured) {
        roots.add(await this.realpath(configured, '配置的空间根不存在或不可访问'))
      }
      return [...roots]
    })().catch((error) => {
      this.configuredResolved = undefined
      throw error
    })
    return this.configuredResolved
  }

  private async assertConfiguredRoot(resolved: string): Promise<void> {
    const configured = await this.resolveConfigured()
    if (configured.length > 0 && !configured.includes(resolved)) {
      throw new TaktToolError(
        'TAKT_SPACE_ROOT_MISMATCH',
        `空间根不在宿主配置的 spaces 里：${resolved}`,
        `当前配置的根：${configured.join('、')}。`,
      )
    }
  }

  /** 已打开空间的子目录不能再当成空间，反过来也一样。 */
  private assertNotNested(resolved: string): void {
    for (const root of this.cache.keys()) {
      if (isInside(resolved, root) || isInside(root, resolved)) {
        throw new TaktToolError(
          'TAKT_SPACE_ROOT_MISMATCH',
          `空间不能嵌套：${resolved} 与已打开的空间 ${root} 互相包含`,
          '换一个不在任何空间内、也不包含其它空间的目录。',
        )
      }
    }
  }

  private async realpath(target: string, reason: string): Promise<string> {
    try {
      return await realpath(path.resolve(target))
    } catch {
      throw new TaktToolError('TAKT_NO_SPACE', `${reason}：${target}`, '确认路径存在且可访问。')
    }
  }
}

/** 空间 handle 的配置签名：config 与解析后的 paths 都变化才算变。 */
function spaceSignature(stores: Awaited<ReturnType<typeof openProject>>): string {
  return JSON.stringify([stores.projectDir, stores.config, stores.paths])
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** child 是否在 parent 内部（不包含相等）；`..cache` 这种名字是内部目录。 */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
