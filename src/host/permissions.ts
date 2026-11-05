import { notImplemented } from './errors.js'
import type { PermissionRegistry, PermissionScope } from './types.js'

/**
 * 子 Agent 权限登记占位实现。
 *
 * 执行层在执行器里实现真实的 Map；守卫只校验登记过的 Agent，lookup 返回
 * undefined 表示普通会话，直接放行。当前 register/lookup 抛错，保证未接入前
 * 不会静默越权。
 */
export class PlaceholderPermissionRegistry implements PermissionRegistry {
  register(_scope: PermissionScope): () => void {
    notImplemented('permissions.register')
  }

  lookup(_agentId: string): PermissionScope | undefined {
    notImplemented('permissions.lookup')
  }
}
