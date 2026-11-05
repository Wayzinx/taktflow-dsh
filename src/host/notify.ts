import { notImplemented } from './errors.js'
import type { Notifier, SpaceHandle } from './types.js'

/**
 * 通知桥占位实现。
 *
 * 由 Lead 层将运行事件通知给已绑定的 Lead 会话；当前 attach/detach 抛错，防止宿主以为通知
 * 已经送达。
 */
export class PlaceholderNotifier implements Notifier {
  async attach(_space: SpaceHandle): Promise<void> {
    notImplemented('notifier.attach')
  }

  async detach(_space: SpaceHandle): Promise<void> {
    notImplemented('notifier.detach')
  }
}
