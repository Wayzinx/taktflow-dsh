import type { AttentionItem } from '@taktflow/core'
import type { ToolExecutionContext } from './dsh-types.js'
import { notImplemented } from './errors.js'
import type { AnswerInput, Approvals, SpaceHandle } from './types.js'

/**
 * 审批/待人事项占位实现。
 *
 * 由 Lead 层把 core AttentionStore 与 dsh userQuestions 串起来；在实现前 present
 * 与 answer 都抛错，避免运行进入“等人”后无人能答。
 */
export class PlaceholderApprovals implements Approvals {
  async present(
    _exec: ToolExecutionContext,
    _space: SpaceHandle,
    _requestId: string,
  ): Promise<void> {
    notImplemented('approvals.present')
  }

  async answer(_space: SpaceHandle, _input: AnswerInput): Promise<AttentionItem> {
    notImplemented('approvals.answer')
  }
}
