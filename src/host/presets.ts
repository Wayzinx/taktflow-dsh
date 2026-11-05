import { notImplemented } from './errors.js'
import type { RolePresetHandle, RolePresets, SpaceHandle } from './types.js'

/** Lead preset 的固定 id；cordis.patch.yml 与客户端选择器共用。 */
export const LEAD_PRESET_ID = 'taktflow'

/**
 * 角色 preset 占位实现。
 *
 * 执行层按角色 + variant 生成并注册 dsh Agent Preset；在实现前 acquire 抛错，
 * 防止执行器以为拿到了可用的子 Agent 组合。
 */
export class PlaceholderRolePresets implements RolePresets {
  async acquire(
    _space: SpaceHandle,
    _role: string,
    _variant: { readOnly: boolean; allowBash: boolean },
  ): Promise<RolePresetHandle> {
    notImplemented('presets.acquire')
  }
}
