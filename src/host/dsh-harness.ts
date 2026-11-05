import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extractJsonBlock, type AgentProfile, type HarnessAdapter, type HarnessEvent, type HarnessRequest, type HarnessResult } from '@taktflow/core'
import type { HostContext, SubagentActivation } from './dsh-types.js'
import { supportsDshOutputSchema } from './dsh-schema.js'
import { TaktToolError, type Ownership, type PermissionRegistry, type RolePresetHandle, type RolePresets, type SpaceHandle } from './types.js'

export interface DshHarnessDeps {
  ctx: HostContext
  space: SpaceHandle
  ownership?: Ownership
  presets: RolePresets
  permissions: PermissionRegistry
  ownerSessionId: string
  profiles?: Record<string, AgentProfile>
  /** RunManager 取消整条运行；回调不可等待当前 harness 所属任务。 */
  onLeadOffline(nodeRef: { runId: string; nodeId: string; attempt: number }): Promise<void>
  /** 启动子 Agent 前把选用的 preset 写进 owner 审计。 */
  onPreset?(role: string, handle: { id: string; cfgHash: string }, nodeRef: { runId: string; nodeId: string; attempt: number }): Promise<void>
  /** 只用于调整满额排队轮询间隔；不限制重试次数。 */
  queueIntervalMs?: number
}

/** RunManager 取消后等待清理；引擎把节点异常转为 failed 也不能丢失清理错误。 */
export interface DshHarness extends HarnessAdapter {
  drain(): Promise<void>
}

/** 取消信号拥有定时器；满额时无限期排队，取消立即移除等待。 */
function waitForCapacity(signal: AbortSignal, milliseconds: number): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/**
 * RunManager 为每次运行创建的 dsh 子 Agent 适配器。
 * 固定 parent 与空间；开始前登记权限，等待真实结果和 teardown 后才释放授权。
 * 启动、审计、取消和清理错误全部向引擎传播，不能当作节点成功。
 */
export function createDshHarness(deps?: DshHarnessDeps): DshHarness {
  const active = new Set<Promise<HarnessResult>>()
  const cleanupFailures: unknown[] = []
  const adapter: HarnessAdapter = {
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
      return deps === undefined ? { ok: false, reason: 'dsh-host 缺少宿主运行上下文' } : { ok: true }
    },
    async run(req: HarnessRequest, onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
      if (deps === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 缺少宿主运行上下文')
      const { ctx, space } = deps
      const baseSignal = req.signal ?? new AbortController().signal
      const signal = req.timeoutMs === undefined ? baseSignal : AbortSignal.any([baseSignal, AbortSignal.timeout(req.timeoutMs)])
      signal.throwIfAborted()
      const role = req.env?.TAKT_ROLE
      const runId = req.env?.TAKT_RUN_ID
      const nodeId = req.env?.TAKT_NODE
      if (!role || !runId || !nodeId) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 请求缺少角色、运行或节点身份')
      if (await realpath(req.cwd) !== space.root) throw new TaktToolError('TAKT_SPACE_ROOT_MISMATCH', 'P0 节点 cwd 必须是空间根')
      const run = await space.stores.runs.get(runId)
      const node = run?.nodes[nodeId]
      if (node === undefined || node.attempts < 1) throw new TaktToolError('TAKT_RUN_BUSY', `运行中的节点身份不可用：${runId}/${nodeId}`)
      const nodeRef = { runId, nodeId, attempt: node.attempts }
      const profile = deps.profiles?.[role]
      const allowBash = req.tools?.allowBash === true || profile?.allowBash === true
      if (allowBash) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'P0 dsh-host 不支持 shell')
      if (req.provider !== undefined || req.sandbox !== undefined || req.sessionId !== undefined) {
        throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh-host 不支持独立 provider、外部 sandbox 或会话续聊')
      }
      const writeScope = [...(req.tools?.writeScope ?? profile?.writeScope ?? [])]
      const readOnly = writeScope.length === 0
      const requireParent = async () => {
        const parent = ctx.agents.get(deps.ownerSessionId)
        if (parent !== undefined) return parent
        await deps.onLeadOffline(nodeRef)
        throw new TaktToolError('TAKT_RUN_BUSY', 'Lead Agent 已离线，本次运行已取消', '重新打开 Lead 会话后发起新运行')
      }
      await requireParent()
      const childId = randomUUID()
      const releasePermission = deps.permissions.register({ childId, nodeRef, cwd: space.root, writeScope, allowBash: false, readOnly })
      let preset: RolePresetHandle | undefined
      let activation: SubagentActivation | undefined
      let disposal: Promise<void> | undefined
      const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(() => activation?.dispose())
      const abort = () => { void dispose().catch(() => {}) }
      try {
        preset = await deps.presets.acquire(space, role, { readOnly, allowBash: false })
        signal.throwIfAborted()
        await deps.onPreset?.(role, { id: preset.id, cfgHash: preset.cfgHash }, nodeRef)
        const outputSchema = supportsDshOutputSchema(req.resultSchema) ? req.resultSchema : undefined
        const prompt = [req.systemAppend, req.prompt,
          req.resultSchema !== undefined && outputSchema === undefined
            ? '最后输出一个 JSON 代码块，并遵守任务中声明的结果结构。' : '',
        ].filter(Boolean).join('\n\n')
        while (activation === undefined) {
          signal.throwIfAborted()
          const parent = await requireParent()
          try {
            activation = await ctx.subagents.startActivation({
              provider: 'spawn', label: `${req.env?.TAKT_REQ ?? run?.requirementId ?? runId}/${nodeId}#${nodeRef.attempt}`,
              childId, signal, delivery: 'caller',
              request: {
                prompt: [{ type: 'text', text: prompt }], agentPreset: preset.id,
                ...(outputSchema === undefined ? {} : { outputSchema }), parent, cwd: space.root,
                ...(req.model === undefined && req.effort === undefined ? {} : { agentOptions: {
                  ...(req.model === undefined ? {} : { model: req.model }),
                  ...(req.effort === undefined ? {} : { reasoningEffort: req.effort }),
                } }),
              },
            })
          } catch (error) {
            if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ACTIVATION_LIMIT_REACHED')) throw error
            await waitForCapacity(signal, deps.queueIntervalMs ?? 100)
          }
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        if (activation.childId !== childId) throw new Error('dsh 返回的子 Agent 身份与预留 childId 不一致')
        onEvent({ type: 'started', sessionId: childId, ...(req.model === undefined ? {} : { model: req.model }) })
        const result = await activation.result
        signal.throwIfAborted()
        const finalText = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (finalText !== '') onEvent({ type: 'message', role: 'assistant', text: finalText })
        const structured = outputSchema === undefined ? req.resultSchema === undefined ? undefined : extractJsonBlock(finalText) : result.structured
        return {
          ok: result.stopReason === 'completed', finalText, sessionId: childId,
          ...(structured === undefined ? {} : { structured }),
          ...(result.stopReason === 'completed' ? {} : { error: result.diagnostic ?? `子 Agent 停止：${result.stopReason}` }),
        }
      } finally {
        signal.removeEventListener('abort', abort)
        // 无法确认子 Agent 已停止时保留守卫和 preset，避免清理失败后无权限保护。
        try {
          if (activation !== undefined) await dispose()
          releasePermission()
          if (preset !== undefined) await Promise.resolve(preset.release())
        } catch (error) {
          cleanupFailures.push(error)
          throw error
        }
      }
    },
  }
  return {
    ...adapter,
    run(req, onEvent) {
      const task = adapter.run(req, onEvent)
      active.add(task)
      void task.then(() => { active.delete(task) }, () => { active.delete(task) })
      return task
    },
    async drain() {
      while (active.size > 0) await Promise.allSettled([...active])
      if (cleanupFailures.length > 0) throw new AggregateError([...cleanupFailures], 'dsh 子 Agent 资源清理失败')
    },
  }
}
