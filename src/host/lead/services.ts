import type { HostContext } from '../dsh-types.js'
import { createApprovals } from '../approvals.js'
import { createBindings, rememberBindingsUser } from '../bindings.js'
import { createNotifier } from '../notify.js'
import type { Approvals, Bindings, Notifier, Ownership, RunManager, SpaceRegistry } from '../types.js'

/**
 * Lead 层对外提供的三个服务。
 *
 * 调用方：宿主行 src/host/index.ts 在组装 TaktflowService 时调用一次。
 * 为什么不直接用占位实现：真实审批/通知/绑定都依赖冻结接口之外的能力
 * （agents、userQuestions、运行状态），集中在这里接线，宿主行不需要了解细节。
 */
export interface LeadServicesDeps {
  spaces: SpaceRegistry
  ownership: Ownership
  runs: RunManager
  ctx: Pick<HostContext, 'agents'> & Partial<Pick<HostContext, 'userQuestions'>>
  /** 审计里代表的人；缺省由各实现回退到 os.userInfo().username。 */
  config?: { user?: string }
}

export interface LeadServices {
  bindings: Bindings
  approvals: Approvals
  notifier: Notifier
}

/**
 * 创建 Lead 层服务。
 *
 * 关键接线：
 * - bindings 与 approvals 共用同一份 config.user：绑定记录里的 by、审批回答
 *   里的 answeredBy、Lead 工具 actor.onBehalfOf 必须是同一个人；
 * - user 通过 Symbol.for 非枚举属性记在 bindings 对象上，registerLeadTools 只从
 *   service.bindings 读取，模型参数无法覆盖；宿主入口与 Lead 入口即使各有一份
 *   模块闭包也能共享；
 * - notifier 只依赖 agents 与 bindings，不需要 user。
 */
export function createLeadServices(deps: LeadServicesDeps): LeadServices {
  const bindings = createBindings({ ownership: deps.ownership })
  const user = deps.config?.user?.trim()
  if (user !== undefined && user !== '') rememberBindingsUser(bindings, user)

  const approvals = createApprovals({
    ctx: deps.ctx,
    ownership: deps.ownership,
    runs: deps.runs,
    ...(deps.config !== undefined ? { config: deps.config } : {}),
  })
  const notifier = createNotifier({ ctx: deps.ctx, bindings })
  return { bindings, approvals, notifier }
}
