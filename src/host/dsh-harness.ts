import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extractJsonBlock, type AgentProfile, type HarnessAdapter, type HarnessEvent, type HarnessRequest, type HarnessResult } from '@taktflow/core'
import { collectSecrets } from '@taktflow/harness'
import type { AgentTraceHandle, AgentTraceHub, AgentTraceOutcome } from './agent-trace.js'
import type { HostContext, SessionEvent, SubagentActivation } from './dsh-types.js'
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
  /** 运行开始时冻结的角色来源；有 traces 时必填，禁止从角色名猜测。 */
  profileSources?: Record<string, 'space' | 'bundled'>
  /** 追溯中心；缺失时保持原执行语义，不写追溯文件。 */
  traces?: AgentTraceHub
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

/** preset 组合里的插件包名；旧替身没有扩展字段时留空，不编造。 */
function presetPlugins(handle: RolePresetHandle): string[] {
  const value = (handle as RolePresetHandle & { plugins?: unknown }).plugins
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
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
      let trace: AgentTraceHandle | undefined
      let unsubscribeSession: (() => void | Promise<void>) | undefined
      let outcome: AgentTraceOutcome | undefined
      let runError: unknown
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
        const label = `${req.env?.TAKT_REQ ?? run?.requirementId ?? runId}/${nodeId}#${nodeRef.attempt}`
        if (deps.traces !== undefined) {
          // 来源在 loadRunProfiles 时冻结；缺失时明确失败，不能按角色名猜 bundled/space。
          if (profile === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `追溯缺少角色档案：${role}`)
          const source = deps.profileSources?.[role]
          if (source === undefined) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `追溯缺少冻结的角色来源：${role}`)
          trace = await deps.traces.begin(space, {
            runId, nodeId, attempt: nodeRef.attempt, label, role, sessionId: childId,
            preset: { id: preset.id, cfgHash: preset.cfgHash, plugins: presetPlugins(preset) },
            profile: {
              title: profile.title, description: profile.description, skills: [...profile.skills],
              writeScope: [...profile.writeScope], readOnly, source,
            },
            prompt,
            ...(req.systemAppend === undefined ? {} : { systemAppend: req.systemAppend }),
            ...(outputSchema === undefined ? {} : { outputSchema }),
            // 本次请求的密钥集合（含 req.env 与冻结 providers）只用于内存脱敏。
            secrets: collectSecrets(req, space.stores.config?.providers ?? {}),
          })
          // 官方 dsh-subagent 在 result resolve 前就 dispose 子 Agent，必须在启动前订阅。
          const listener = ((session: { id?: string; header?: { id?: string } }, event: SessionEvent) => {
            const id = session.id ?? session.header?.id
            if (id === childId) trace?.sessionEvent(event)
          }) as (...args: never[]) => void
          unsubscribeSession = ctx.on('session/event', listener)
        }
        while (activation === undefined) {
          signal.throwIfAborted()
          const parent = await requireParent()
          try {
            activation = await ctx.subagents.startActivation({
              provider: 'spawn', label, childId, signal, delivery: 'caller',
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
        // child 在 result 前就可能被销毁；这里只取发布瞬间的真实 options。
        const child = ctx.agents.get(childId)
        trace?.running(child?.options.model, child?.options.reasoningEffort)
        onEvent({ type: 'started', sessionId: childId, ...(req.model === undefined ? {} : { model: req.model }) })
        const result = await activation.result
        const finalText = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (finalText !== '') onEvent({ type: 'message', role: 'assistant', text: finalText })
        const structured = outputSchema === undefined ? req.resultSchema === undefined ? undefined : extractJsonBlock(finalText) : result.structured
        const status = result.stopReason === 'completed' ? 'completed'
          : result.stopReason === 'aborted' || result.stopReason === 'cancelled' ? 'cancelled' : 'failed'
        outcome = {
          status,
          stopReason: result.stopReason,
          ...(finalText === '' ? {} : { finalText }),
          ...(status === 'completed' ? {} : { error: result.diagnostic ?? `子 Agent 停止：${result.stopReason}` }),
        }
        // 结果已经返回时仍要保留 stopReason/finalText；取消只覆盖状态，不丢已有信息。
        if (signal.aborted) {
          outcome = {
            status: 'cancelled',
            ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
            ...(outcome.finalText === undefined ? {} : { finalText: outcome.finalText }),
            error: errorMessage(signal.reason ?? '运行已取消'),
          }
          signal.throwIfAborted()
        }
        return {
          ok: result.stopReason === 'completed', finalText, sessionId: childId,
          ...(structured === undefined ? {} : { structured }),
          ...(result.stopReason === 'completed' ? {} : { error: result.diagnostic ?? `子 Agent 停止：${result.stopReason}` }),
        }
      } catch (error) {
        runError = error
        throw error
      } finally {
        signal.removeEventListener('abort', abort)
        // 无法确认子 Agent 已停止时保留守卫和 preset，避免清理失败后无权限保护。
        let cleanupError: unknown
        try {
          if (activation !== undefined) await dispose()
          releasePermission()
          if (preset !== undefined) await Promise.resolve(preset.release())
        } catch (error) {
          cleanupFailures.push(error)
          cleanupError = error
        }
        if (trace !== undefined) {
          let finalOutcome: AgentTraceOutcome
          if (outcome !== undefined) finalOutcome = outcome
          else if (signal.aborted) {
            finalOutcome = { status: 'cancelled', ...(runError === undefined ? {} : { error: errorMessage(signal.reason ?? runError) }) }
          } else {
            finalOutcome = { status: 'failed', error: errorMessage(runError ?? '节点未产生结果') }
          }
          if (cleanupError !== undefined) {
            const cleanupText = errorMessage(cleanupError)
            const merged = finalOutcome.error === undefined ? `清理失败：${cleanupText}` : `${finalOutcome.error}；清理失败：${cleanupText}`
            finalOutcome = finalOutcome.status === 'cancelled'
              ? { ...finalOutcome, error: merged }
              : {
                  status: 'failed',
                  ...(finalOutcome.stopReason === undefined ? {} : { stopReason: finalOutcome.stopReason }),
                  ...(finalOutcome.finalText === undefined ? {} : { finalText: finalOutcome.finalText }),
                  error: merged,
                }
          }
          // 最终刷新必须先于 trace.dispose；失败作为清理错误传播，不能假成功。
          try { await trace.finish(finalOutcome) } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
            // 写盘失败后用 failed 终态重试一次：磁盘恢复时也不能留下 completed 假成功。
            try {
              await trace.finish({
                status: 'failed',
                ...(finalOutcome.stopReason === undefined ? {} : { stopReason: finalOutcome.stopReason }),
                ...(finalOutcome.finalText === undefined ? {} : { finalText: finalOutcome.finalText }),
                error: `追溯记录写入失败：${errorMessage(error)}`,
              })
            } catch (retryError) {
              cleanupFailures.push(retryError)
            }
          }
          try { await trace.dispose() } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        // 会话事件订阅保留到最终刷新和 dispose 完成，避免漏掉最后一条 usage/tool 结果。
        if (unsubscribeSession !== undefined) {
          try { await unsubscribeSession() } catch (error) {
            cleanupFailures.push(error)
            cleanupError ??= error
          }
        }
        if (cleanupError !== undefined) throw cleanupError
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
