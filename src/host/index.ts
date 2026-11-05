import type { HostContext } from './dsh-types.js'
import { PlaceholderApprovals } from './approvals.js'
import { PlaceholderNotifier } from './notify.js'
import { PlaceholderOwnership, PlaceholderBindings } from './ownership.js'
import { PlaceholderPermissionRegistry } from './permissions.js'
import { PlaceholderRolePresets } from './presets.js'
import { PlaceholderRunManager } from './runs.js'
import { registerPingRoute } from './routes.js'
import { FsSpaceRegistry } from './space.js'
import { createWorkflowCatalog } from '../workflows/index.js'
import type { TaktflowService } from './types.js'

/** 宿主行的包名/行名；cordis.patch.yml 必须用这个精确包名。 */
export const name = 'taktflow'

/**
 * 只依赖这四个服务。agentPresets、userQuestions、storageDomain 用 ctx.get 读取：
 * 它们是可选能力，缺失时宿主仍应能加载并提供 ping。
 */
export const inject = ['connection', 'subagents', 'agents', 'tools']

/** 宿主行配置；spaces 为空时 forSession 只接受“cwd 本身就是空间根”。 */
export interface Config {
  /** 允许的空间根列表；P0 最多一个（同一个根的不同路径/symlink 会去重）。 */
  spaces?: string[]
  /** 审计里代表的人；默认 os.userInfo().username。不参与 hostOwner。 */
  user?: string
}

/** 组装服务门面；不访问磁盘、不注册任何东西。 */
export function createService(config: Config = {}): TaktflowService {
  return {
    spaces: new FsSpaceRegistry({ spaces: config.spaces }),
    ownership: new PlaceholderOwnership(),
    runs: new PlaceholderRunManager(),
    permissions: new PlaceholderPermissionRegistry(),
    presets: new PlaceholderRolePresets(),
    bindings: new PlaceholderBindings(),
    approvals: new PlaceholderApprovals(),
    notifier: new PlaceholderNotifier(),
    workflows: createWorkflowCatalog(),
  }
}

/**
 * 宿主行入口。
 *
 * 所有注册都交给 ctx.effect；卸载时先取消在途运行（runs.disposeAll），再注销
 * 服务和路由。配置错误（重复加载同名服务、路由冲突）会让插件加载失败。
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  const service = createService(config)
  ctx.effect(() => ctx.provide('taktflow', service), 'taktflow service')
  registerPingRoute(ctx)
  ctx.effect(() => () => service.runs.disposeAll(), 'taktflow runs')
}
