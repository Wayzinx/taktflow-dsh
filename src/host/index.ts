import type { HostContext } from './dsh-types.js'
import { PlaceholderApprovals } from './approvals.js'
import { createLeadServices, type LeadServices } from './lead/services.js'
import { PlaceholderNotifier } from './notify.js'
import { FsOwnership } from './ownership.js'
import { PlaceholderBindings } from './bindings.js'
import { InMemoryPermissionRegistry, createWriteGuard } from './permissions.js'
import { DshRolePresets } from './presets.js'
import { DshRunManager, type RunManagerDeps } from './runs.js'
import { registerRoutes } from './routes.js'
import { FsSpaceRegistry } from './space.js'
import { createWorkflowCatalog } from '../workflows/index.js'
import type { Notifier, SpaceHandle, SpaceRegistry, TaktflowService, WorkflowCatalog } from './types.js'

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

/** 仅供程序化组装和隔离测试；生产仍使用随包流程目录。 */
export interface ServiceDeps {
  workflows?: WorkflowCatalog
  harnessFactory?: RunManagerDeps['harnessFactory']
  log?: RunManagerDeps['log']
}

/**
 * 宿主加载时组装服务，不访问磁盘；可选服务缺失不阻断加载，执行时明确失败。
 *
 * 没有 ctx（纯程序化组装/测试）时，Lead 层的绑定、审批、通知保持占位实现。
 */
export function createService(config: Config = {}, ctx?: HostContext, deps: ServiceDeps = {}): TaktflowService {
  const registry = new FsSpaceRegistry({ spaces: config.spaces })
  let runs: DshRunManager
  const ownership = new FsOwnership({ ctx, onLeaseLost: (space) => runs.cancelOwnedSpace(space) })
  const permissions = new InMemoryPermissionRegistry()
  const presets = new DshRolePresets(ctx)
  const workflows = deps.workflows ?? createWorkflowCatalog()
  runs = new DshRunManager({ ...deps, ctx, spaces: registry, ownership, permissions, presets, workflows })
  const lead: LeadServices = ctx
    ? createLeadServices({
        spaces: registry,
        ownership,
        runs,
        ctx: { agents: ctx.agents, userQuestions: ctx.get<HostContext['userQuestions']>('userQuestions') },
        config,
      })
    : { bindings: new PlaceholderBindings(), approvals: new PlaceholderApprovals(), notifier: new PlaceholderNotifier() }
  const spaces = ctx ? attachOnOpen(registry, lead.notifier) : registry
  return { spaces, ownership, runs, permissions, presets, workflows, ...lead }
}

/** 空间第一次被工具或路由打开时挂上通知器（attach 幂等）；通知失败不影响打开。 */
function attachOnOpen(registry: SpaceRegistry, notifier: Notifier): SpaceRegistry {
  const attach = async (space: SpaceHandle): Promise<SpaceHandle> => {
    await notifier.attach(space).catch(() => undefined)
    return space
  }
  return {
    roots: () => registry.roots(),
    open: (root) => registry.open(root).then(attach),
    forSession: (cwd) => registry.forSession(cwd).then(attach),
  }
}

/**
 * 宿主行入口。
 *
 * 所有注册都交给 ctx.effect；卸载时先取消在途运行（runs.disposeAll），再注销
 * 服务和路由。配置错误（重复加载同名服务、路由冲突）会让插件加载失败。
 */
export function apply(ctx: HostContext, config: Config = {}): void {
  // Cordis 并发卸载顶层 effect；同一外层 effect 内的清理才按逆序等待。
  ctx.effect(() => {
    const service = createService(config, ctx)
    ctx.provide('taktflow', service)
    registerRoutes(ctx, service, config)
    ctx.tools.guard(createWriteGuard(service.permissions))
    return async () => {
      await service.runs.disposeAll()
      for (const root of await service.spaces.roots()) {
        await service.notifier.detach(await service.spaces.open(root)).catch(() => undefined)
      }
      await (service.ownership as FsOwnership).releaseAll()
    }
  }, 'taktflow host lifecycle')
}
