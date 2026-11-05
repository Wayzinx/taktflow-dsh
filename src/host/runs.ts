import type { Actor, AttentionItem, RunId, RunState } from '@taktflow/core'
import { notImplemented } from './errors.js'
import type { RunManager, SpaceHandle, StartRunInput } from './types.js'

/**
 * 运行生命周期占位实现。
 *
 * 执行层用 core engine 实现；在实现前 start/cancel/resume/get/onAnswered 全部抛错，
 * 避免 Lead 工具把“没跑”当成“已启动”。disposeAll 是可运行的幂等清理。
 */
export class PlaceholderRunManager implements RunManager {
  private disposed = false

  async start(_input: StartRunInput): Promise<{ runId: RunId; deduped: boolean }> {
    notImplemented('runs.start')
  }

  async cancel(_space: SpaceHandle, _runId: RunId, _by: Actor): Promise<void> {
    notImplemented('runs.cancel')
  }

  async resume(_space: SpaceHandle, _runId: RunId, _by: Actor): Promise<void> {
    notImplemented('runs.resume')
  }

  async get(_space: SpaceHandle, _runId: RunId): Promise<RunState | undefined> {
    notImplemented('runs.get')
  }

  async onAnswered(_space: SpaceHandle, _item: AttentionItem): Promise<void> {
    notImplemented('runs.onAnswered')
  }

  /** 宿主卸载时调用；执行层在这里取消在途运行。重复调用是 no-op。 */
  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
  }

  /** 仅供测试/诊断：是否已执行过 disposeAll。 */
  isDisposed(): boolean {
    return this.disposed
  }
}
