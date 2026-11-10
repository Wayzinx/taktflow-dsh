import { createHarnesses } from '@taktflow/harness'
import type { HarnessInfo, ModelInfo, TaktConfig } from '@taktflow/core'
import { BUNDLED_ROLE_NAMES } from '../roles/defaults.js'
import type { Agent, HostContext } from './dsh-types.js'
import { PlaceholderApprovals } from './approvals.js'
import { createLeadServices, type LeadServices } from './lead/services.js'
import { createM3Service } from './m3.js'
import { loadDefineTool } from './dsh-runtime.js'
import { createHandoffTool, markHandoffRegistered } from './handoff.js'
import { PlaceholderNotifier } from './notify.js'
import { FsOwnership } from './ownership.js'
import { PlaceholderBindings } from './bindings.js'
import { InMemoryPermissionRegistry, createWriteGuard } from './permissions.js'
import { DshRolePresets } from './presets.js'
import { DshRunManager, type RunManagerDeps } from './runs.js'
import { registerRoutes, type RoutesCatalog } from './routes.js'
import { InMemorySelftestService } from './selftest.js'
import { FsSpaceRegistry } from './space.js'
import { createWorkflowCatalog } from '../workflows/index.js'
import type { Autonomy, Notifier, RoleHarness, SpaceHandle, SpaceRegistry, TaktflowService, WorkflowCatalog } from './types.js'

/** 宿主行的包名/行名；cordis.patch.yml 必须用这个精确包名。 */
export const name = 'taktflow'

/**
 * 只依赖这四个服务。agentPresets、userQuestions、storageDomain 用 ctx.get 读取：
 * 它们是可选能力，缺失时宿主仍应能加载并提供 ping。
 */
export const inject = ['connection', 'subagents', 'agents', 'tools']

/** 宿主行配置；spaces 为空时 forSession 只接受“cwd 本身就是空间根”。 */
export interface Config {
  /** 允许的空间根列表（可多个；同一个根的不同路径/symlink 会去重）。不配时任何目录都可以 init 成空间。 */
  spaces?: string[]
  /** 审计里代表的人；默认 os.userInfo().username。不参与 hostOwner。 */
  user?: string
  /** 自主程度默认值；空间 takt.config.json 的 autonomy 优先。缺省 full。 */
  autonomy?: Autonomy
  /** 角色子 Agent 执行方式；缺省 dsh-host（App 模型 + 编队可见）。 */
  roleHarness?: RoleHarness
  /** 普通会话里的“交给 Taktflow”工具（taktflow_handoff）；缺省开启，false 关闭。 */
  handoff?: boolean
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
export function createService(config: Config = {}, ctx?: HostContext, deps: ServiceDeps = {}): TaktflowService & { catalog: RoutesCatalog } {
  const registry = new FsSpaceRegistry({ spaces: config.spaces })
  let runs: DshRunManager
  let m3: ReturnType<typeof createM3Service> | undefined
  const ownership = new FsOwnership({ ctx, onLeaseLost: async (space) => { await Promise.all([runs.cancelOwnedSpace(space), m3?.cancelSpace(space)]) } })
  const permissions = new InMemoryPermissionRegistry()
  const presets = new DshRolePresets(ctx)
  const selftests = new InMemorySelftestService({ permissions, ownership, agents: ctx?.agents })
  const workflows = deps.workflows ?? createWorkflowCatalog(registry)
  runs = new DshRunManager({ ...deps, config, ctx, spaces: registry, ownership, permissions, presets, workflows, selftests })
  const lead: LeadServices = ctx
    ? createLeadServices({
        spaces: registry,
        ownership,
        runs,
        ctx: { agents: ctx.agents, userQuestions: ctx.get<HostContext['userQuestions']>('userQuestions') },
        config,
      })
    : { bindings: new PlaceholderBindings(), approvals: new PlaceholderApprovals(), notifier: new PlaceholderNotifier() }
  // M-K：评测/归因运行时与命令注册表；没有 ctx 时保持缺失，面板明确 501。
  m3 = ctx
    ? createM3Service({
        ctx,
        spaces: registry,
        ownership,
        presets,
        permissions,
        bindings: lead.bindings,
      })
    : undefined
  // 自主代答与升级通知在 Lead 层创建后才能用；运行启动前接线，后续 drive 读最新实例。
  runs.setCollaborators({ approvals: lead.approvals, notifier: lead.notifier })
  const spaces = ctx ? attachOnOpen(registry, lead.notifier) : registry
  const catalog = createRuntimeCatalog(ctx)
  return {
    spaces,
    ownership,
    runs,
    permissions,
    presets,
    workflows,
    selftests,
    ...lead,
    ...(m3 === undefined ? {} : { m3 }),
    catalog,
  }
}

/**
 * 面板 harnesses/models 的生产目录。
 *
 * 每次读操作按本次 stores 的配置重新构造：空间配置在运行间变化后，面板看到的
 * 是当前实际可用的 harness 与模型，而不是插件加载时的快照。dsh-host 由宿主
 * 上下文提供，只有宿主存在时才标记可用。
 */
function createRuntimeCatalog(ctx: HostContext | undefined): RoutesCatalog {
  return {
    async getHarnesses(stores) {
      const config = stores.config
      const entries: HarnessInfo[] = []
      if (ctx !== undefined) {
        entries.push({
          id: 'dsh-host',
          displayName: 'DeepSeek Harness (dsh-host)',
          source: 'plugin',
          available: true,
          capabilities: { resume: false, structuredOutput: true, toolEvents: false, usage: false, customProvider: false, sandbox: true, mcp: true },
          roles: rolesForHarness(config, 'dsh-host'),
        })
      }
      const harnesses = createHarnesses({ config, projectDir: stores.projectDir })
      for (const [id, adapter] of Object.entries(harnesses)) {
        let available = false
        let reason: string | undefined
        try {
          const probe = await adapter.available()
          available = probe.ok
          reason = probe.reason
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
        entries.push({
          id,
          displayName: adapter.displayName,
          source: (config.harnesses ?? []).some((item) => item.id === id) ? 'cli' : 'builtin',
          available,
          ...(reason === undefined ? {} : { reason }),
          capabilities: adapter.capabilities ?? {},
          roles: rolesForHarness(config, id),
        })
      }
      return entries
    },
    async getModels(stores) {
      const config = stores.config
      const providers = config.providers ?? {}
      return Object.entries(config.models ?? {}).map(([alias, model]): ModelInfo => {
        const provider = providers[model.provider]
        const keyEnv = provider?.apiKeyEnv
        const keyPresent = keyEnv !== undefined && keyEnv !== '' && (process.env[keyEnv] ?? '') !== ''
        return {
          alias,
          provider: model.provider,
          protocol: provider?.protocol ?? 'openai-chat',
          id: model.id,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.price === undefined ? {} : { price: { input: model.price.input, output: model.price.output } }),
          keyPresent,
        }
      })
    },
  }
}

/** 角色 → 默认 harness；随包角色默认 dsh-host，空间配置覆盖后按配置归属。 */
function rolesForHarness(config: TaktConfig, harness: string): string[] {
  const roles = new Set<string>()
  for (const [role, selector] of Object.entries(config.roles ?? {})) {
    if (selector.harness === harness) roles.add(role)
  }
  if (harness === 'dsh-host') {
    for (const role of BUNDLED_ROLE_NAMES) {
      const configured = config.roles?.[role]?.harness
      if (configured === undefined || configured === 'dsh-host') roles.add(role)
    }
  }
  return [...roles].sort()
}

/** 空间第一次被工具或路由打开时挂上通知器（attach 幂等）；通知失败不影响打开。 */
function attachOnOpen(registry: SpaceRegistry, notifier: Notifier): SpaceRegistry {
  const attach = async (space: SpaceHandle): Promise<SpaceHandle> => {
    await notifier.attach(space).catch(() => undefined)
    return space
  }
  return {
    roots: () => registry.roots(),
    ...(registry.assertOpenable === undefined ? {} : { assertOpenable: (root: string) => registry.assertOpenable!(root) }),
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
/**
 * 全局注册“交给 Taktflow”工具：所有会话可见，Lead / 职责角色的会话各自 restrict 掉。
 * dsh-tools 加载失败只记警告：这是入口增强，不能拖垮宿主加载。
 */
function registerHandoff(ctx: HostContext, config: Config): void {
  if (config.handoff === false) return
  ctx.effect(() => {
    // 同步返回清理函数；dsh-tools 异步加载完成前宿主已卸载时不再注册。
    let disposed = false
    let unregister: (() => unknown) | undefined
    loadDefineTool().then((defineTool) => {
      if (disposed) return
      unregister = ctx.tools.register(defineTool(createHandoffTool({ ctx })))
      markHandoffRegistered(true)
    }).catch((error: unknown) => {
      ctx.logger?.warn(`taktflow_handoff 未注册：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      disposed = true
      markHandoffRegistered(false)
      return unregister?.() as void | Promise<void>
    }
  }, 'taktflow handoff tool')
}

export function apply(ctx: HostContext, config: Config = {}): void {
  // Cordis 并发卸载顶层 effect；同一外层 effect 内的清理才按逆序等待。
  ctx.effect(() => {
    const service = createService(config, ctx)
    ctx.provide('taktflow', service)
    registerRoutes(ctx, service, config)
    ctx.tools.guard(createWriteGuard(service.permissions))
    registerHandoff(ctx, config)
    // Lead 会话上线（App 重启后打开会话、会话重新加载）时，继续它名下被打断的运行。
    // agent/created 串行派发且监听器抛错会让会话创建失败：这里只排队、不等待、不抛错。
    const offCreated = ctx.on('agent/created', ((event: { agent?: Agent } | undefined) => {
      const agent = event?.agent
      const header = agent?.session.header as { cwd?: string; parentSession?: string } | undefined
      if (agent === undefined || header?.parentSession !== undefined || service.runs.resumeForSession === undefined) return
      setTimeout(() => {
        service.runs.resumeForSession!(agent.id, header?.cwd).catch((error: unknown) => {
          ctx.logger?.warn(`继续被打断的运行失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }, 0)
    }) as (...args: never[]) => void)
    return async () => {
      offCreated()
      // 同时停止入场和进程，再等待引擎收尾；不能先等可能正等待工具的 Agent。
      const stopped = await Promise.allSettled([service.selftests?.dispose(), service.runs.disposeAll(), service.m3?.dispose()])
      const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), '宿主执行清理失败，保留租约')
      for (const root of await service.spaces.roots()) {
        await service.notifier.detach(await service.spaces.open(root)).catch(() => undefined)
      }
      await (service.ownership as FsOwnership).releaseAll()
    }
  }, 'taktflow host lifecycle')
}
