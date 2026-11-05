import type { HarnessAdapter, HarnessEvent, HarnessRequest, HarnessResult } from '@taktflow/core'
import { notImplemented } from './errors.js'

/**
 * dsh 子 Agent 的 HarnessAdapter 占位。
 *
 * id 固定为 `dsh-host`：`dsh` 已被 CLI 适配器占用。执行层用
 * ctx.subagents.startActivation 实现真正的 run；当前 available 返回不可用，
 * run 显式抛 not implemented。
 */
export function createDshHarness(): HarnessAdapter {
  return {
    id: 'dsh-host',
    displayName: 'DeepSeek Harness (dsh-host)',
    capabilities: {
      resume: false,
      structuredOutput: true,
      toolEvents: false,
      usage: false,
      customProvider: false,
      sandbox: false,
      mcp: true,
    },
    async available() {
      return { ok: false, reason: 'dsh-host harness 尚未实现（M-C）' }
    },
    async run(_req: HarnessRequest, _onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
      notImplemented('dsh-host-harness.run')
    },
  }
}
