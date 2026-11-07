import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertNoSymlinks, assertRunId, canonicalJson, createInsights, extractJsonBlock, loadProfiles,
  openProject, parseFrontmatter, readJsonFile, sha256,
  type AgentProfile, type EngineDeps, type EvalVariant, type HarnessAdapter, type HarnessEvent,
  type HarnessRequest, type HarnessResult, type HarnessSelector, type NodeRecipe,
} from '@taktflow/core'
import { collectSecrets, createRedactor } from '@taktflow/harness'
import { observeDshFailure } from './dsh-errors.js'
import { createLocalSandboxProvider } from '@taktflow/sandbox'
import type { Agent, HostContext, SubagentActivation } from './dsh-types.js'
import { supportsDshOutputSchema } from './dsh-schema.js'
import { loadRoleSkills, type RoleSkillSnapshots } from './role-skills.js'
import { loadRunProfilesDetailed } from './run-runtime.js'
import { TaktToolError, type Bindings, type PermissionRegistry, type RolePresets, type SpaceHandle } from './types.js'

/** 宿主组装运行时；身份、退出信号和写入租约均由可信宿主提供。 */
export interface M3RuntimeDeps {
  ctx: HostContext
  bindings: Pick<Bindings, 'bySession' | 'byRequirement'>
  presets: RolePresets
  permissions: PermissionRegistry
  shutdown: AbortSignal
  beforeWrite?(space: SpaceHandle): Promise<void>
}
/** 命令返回 eval id 后绑定其冻结材料；dispose 取消并等待本次操作，失败不会吞掉。 */
export interface M3Engine {
  deps: EngineDeps
  bindEval(id: string): void
  dispose(): Promise<void>
}

/** 原生卡片与 M3 子 Agent 共用的活根校验；每次启动/落账前重新读取绑定。 */
export async function requireM3Lead(deps: Pick<M3RuntimeDeps, 'ctx' | 'bindings'>, space: SpaceHandle, requirementId: string, expected?: Agent): Promise<Agent> {
  const session = await deps.bindings.byRequirement(space, requirementId)
  const agent = session === undefined ? undefined : deps.ctx.agents.get(session)
  if (!agent || (expected !== undefined && agent !== expected) || !deps.ctx.agents.roots().includes(agent)
    || await deps.bindings.bySession(space, agent.id) !== requirementId) {
    throw new TaktToolError('TAKT_NOT_BOUND', '需求没有匹配的在线 Lead 根会话', '打开当前需求的 Lead 会话后重试。')
  }
  const registry = agent.ctx?.get('agentPresets') as { composedPreset?(ctx: unknown): string | undefined } | undefined
  const preset = registry?.composedPreset?.(agent.ctx) ?? agent.session.header.agentPreset
  if (preset !== 'taktflow' || !agent.session.header.cwd || await realpath(agent.session.header.cwd) !== await realpath(space.root)) {
    throw new TaktToolError('TAKT_NOT_BOUND', '归属必须是当前空间根中的 taktflow Lead 会话')
  }
  return agent
}

/** M3 的临时目录执行桥；不会放宽普通流程 dsh-harness 的节点身份约束。 */
export function createM3RuntimeFactory(deps: M3RuntimeDeps): {
  create(space: SpaceHandle, requirementId: string, kind?: 'attribute' | 'eval'): Promise<M3Engine>
  dispose(): Promise<void>
} {
  const engines = new Set<M3Engine>()
  let closed = false
  return {
    async create(space, requirementId, kind = 'attribute') {
      if (closed || deps.shutdown.aborted) throw new Error('M3 宿主已关闭')
      const owner = await requireM3Lead(deps, space, requirementId)
      const loaded = await loadRunProfilesDetailed(space)
      // 外部 CLI 档案切到 App 时沿用 App 选项；显式 dsh-host 选择才保留并核验 model/effort。
      const profiles = Object.fromEntries(Object.entries(loaded.profiles).map(([role, profile]) => [role, {
        ...profile, harness: hostSelector(profile.harness),
      }]))
      const skills = await loadRoleSkills(space, profiles)
      const controller = new AbortController()
      const signal = AbortSignal.any([deps.shutdown, controller.signal])
      const active = new Set<Promise<unknown>>()
      const cleanupFailures: unknown[] = []
      const retryCleanup = new Set<() => Promise<void>>()
      let disposed = false
      let evalId: string | undefined
      let publishEval!: (id: string) => void
      const evalReady = new Promise<string>((resolve) => { publishEval = resolve })
      const replayModels = new Set<string>()
      const variantProfiles = new Map<string, Promise<AgentProfile[]>>()

      const assertOpen = () => {
        signal.throwIfAborted()
        if (disposed) throw new Error('M3 运行时已关闭')
      }
      const beforeWrite = async () => { assertOpen(); await deps.beforeWrite?.(space); assertOpen() }
      // 归因结果与审计在后台模型结束后才写；每次底层写都复核租约和关闭状态。
      const workspaces = Object.create(space.stores.workspaces) as typeof space.stores.workspaces
      workspaces.writeArtifact = async (input) => { await beforeWrite(); return space.stores.workspaces.writeArtifact(input) }
      const events = Object.create(space.stores.events) as typeof space.stores.events
      events.append = (async (runId: string, event: Parameters<typeof space.stores.events.append>[1]) => {
        await beforeWrite(); return space.stores.events.append(runId, event)
      }) as typeof space.stores.events.append
      const stores = { ...space.stores, workspaces, events }

      async function replayProfile(req: HarnessRequest, cwd: string, role: string): Promise<AgentProfile> {
        const baseline = profiles[role]
        if (!baseline) throw new Error(`角色不存在：${role}`)
        if (!req.env?.TAKT_RUN_ID) return baseline
        if (kind !== 'eval') throw new Error('归因运行时不能执行回放节点')
        const id = await abortable(evalReady, signal)
        const local = await openProject(cwd)
        const recipe = (await local.events.read(assertRunId(req.env.TAKT_RUN_ID), { nodeId: req.env.TAKT_NODE }))
          .filter((event) => event.type === 'node.recipe').at(-1)?.data as NodeRecipe | undefined
        if (!recipe?.profileHash) throw new Error('回放缺少冻结的角色配方，不能猜测变体')
        let candidates = variantProfiles.get(role)
        if (!candidates) {
          candidates = (async () => {
            const file = path.join(space.stores.taktDir, 'evals', 'runs', id, 'execution-variants.json')
            await assertNoSymlinks(space.stores.taktDir, file)
            const variants = await readJsonFile<EvalVariant[]>(file)
            if (!variants) throw new Error('回放缺少冻结变体')
            const result = [baseline]
            for (const variant of variants) if (variant.profileFile) {
              await assertNoSymlinks(space.stores.taktDir, variant.profileFile)
              const directory = await mkdtemp(path.join(tmpdir(), 'takt-m3-profile-'))
              try {
                await cp(variant.profileFile, path.join(directory, `${role}.md`))
                const profile = (await loadProfiles({ ...space.stores.paths, agents: directory }))[role]
                if (!profile) continue
                const { data } = parseFrontmatter(await readFile(variant.profileFile, 'utf8'))
                result.push({ ...profile, allowBash: data.allowBash === true })
              } finally { await rm(directory, { recursive: true, force: true }) }
            }
            return result
          })()
          variantProfiles.set(role, candidates)
        }
        const matches = (await candidates).map((profile) => ({ ...profile, writeScope: req.tools?.writeScope ?? profile.writeScope }))
          .filter((profile) => sha256(canonicalJson(profile)) === recipe.profileHash)
        if (!matches.length) throw new Error('回放配方与冻结角色不符，拒绝使用基线冒充变体')
        return matches[0]!
      }

      const adapter: HarnessAdapter = {
        id: 'dsh-host', displayName: 'DeepSeek Harness (M3)',
        capabilities: { structuredOutput: true, usage: false, customProvider: false, sandbox: false },
        async available() { return { ok: !disposed && !closed && !signal.aborted } },
        async run(req, onEvent) {
          assertOpen()
          const task = execute(req, onEvent)
          active.add(task)
          try { return await task } finally { active.delete(task) }
        },
      }

      async function execute(req: HarnessRequest, onEvent: (event: HarnessEvent) => void): Promise<HarnessResult> {
        assertOpen()
        if (req.provider || req.sessionId) throw new Error('M3 dsh-host 不支持外部 provider 或续聊')
        const role = req.env?.TAKT_ROLE
        if (!role) throw new Error('M3 缺少角色身份')
        const cwd = await realpath(req.cwd)
        if (req.sandbox && (req.sandbox.provider !== 'local' || !req.sandbox.spec?.workdir
          || await realpath(req.sandbox.spec.workdir) !== cwd)) throw new Error('M3 只支持与 cwd 一致的本地 sandbox')
        const profile = await replayProfile(req, cwd, role)
        if (req.tools?.allowBash || profile.allowBash) throw new Error('M3 dsh-host 不支持 shell')
        const replay = req.env?.TAKT_RUN_ID !== undefined
        const local = replay ? await openProject(cwd) : undefined
        const isolated: SpaceHandle = {
          root: cwd, stores: local ?? { ...stores, projectDir: cwd, paths: { ...stores.paths, skills: path.join(cwd, '.agents', 'skills') } },
          insights: createInsights(local ?? stores),
        }
        // core 已将本次 execution-variants 的技能副本同步到临时 cwd；按该角色实际声明加载。
        const roleSkills = replay
          ? await loadRoleSkills({ ...isolated, stores: { ...isolated.stores, paths: { ...isolated.stores.paths, skills: path.join(cwd, '.agents', 'skills') } } }, { [role]: profile })
          : { [role]: skills[role] ?? [] }
        const presets = forkPresets(deps.presets, { [role]: profile }, roleSkills)
        const callSignal = AbortSignal.any([signal, ...(req.signal ? [req.signal] : []), ...(req.timeoutMs ? [AbortSignal.timeout(req.timeoutMs)] : [])])
        callSignal.throwIfAborted()
        const childId = randomUUID()
        const readOnly = !req.tools?.writeScope?.length
        const releasePermission = deps.permissions.register({
          childId, nodeRef: { runId: req.env?.TAKT_RUN_ID ?? `m3-${childId}`, nodeId: req.env?.TAKT_NODE ?? role, attempt: 1 },
          cwd, spaceRoot: cwd, artifactRoot: req.env?.TAKT_WORKSPACE ?? cwd,
          writeScope: req.tools?.writeScope ?? [], readScope: profile.readScope ?? ['**'], allowBash: false, readOnly,
        })
        let preset: Awaited<ReturnType<RolePresets['acquire']>> | undefined
        let activation: SubagentActivation | undefined
        let stopping: Promise<void> | undefined
        let stopped = false, permissionReleased = false, presetReleased = false
        const cleanup = async () => {
          if (activation && !stopped) {
            stopping ??= Promise.resolve().then(() => activation!.dispose())
            try { await stopping; stopped = true } catch (error) { stopping = undefined; throw error }
          }
          const errors: unknown[] = []
          if (!permissionReleased) { try { releasePermission(); permissionReleased = true } catch (error) { errors.push(error) } }
          if (preset && !presetReleased) { try { await preset.release(); presetReleased = true } catch (error) { errors.push(error) } }
          if (errors.length) throw new AggregateError(errors, 'M3 权限/preset 清理失败')
          retryCleanup.delete(cleanup)
        }
        retryCleanup.add(cleanup)
        const abort = () => { void cleanup().catch(() => {}) }
        let failure: unknown
        let diagnostics: ReturnType<typeof observeDshFailure> | undefined
        try {
          diagnostics = observeDshFailure(deps.ctx, childId, createRedactor(collectSecrets(req, space.stores.config.providers)))
          preset = await presets.acquire(isolated, role, { readOnly, allowBash: false })
          const outputSchema = supportsDshOutputSchema(req.resultSchema) ? req.resultSchema : undefined
          const prompt = [req.systemAppend, req.prompt,
            req.resultSchema && !outputSchema ? `最后输出 JSON 代码块，满足：${JSON.stringify(req.resultSchema)}` : '',
          ].filter(Boolean).join('\n\n')
          while (!activation) {
            callSignal.throwIfAborted()
            const parent = await requireM3Lead(deps, space, requirementId, owner)
            try {
              activation = await deps.ctx.subagents.startActivation({
                provider: 'spawn', label: `m3/${role}`, childId, signal: callSignal, delivery: 'caller',
                request: { parent, cwd, agentPreset: preset.id, prompt: [{ type: 'text', text: prompt }],
                  ...(outputSchema ? { outputSchema } : {}),
                  ...(req.model !== undefined || req.effort !== undefined ? { agentOptions: {
                    ...(req.model === undefined ? {} : { model: req.model }),
                    ...(req.effort === undefined ? {} : { reasoningEffort: req.effort }),
                  } } : {}),
                },
              })
            } catch (error) {
              if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ACTIVATION_LIMIT_REACHED')) throw error
              await abortable(new Promise((resolve) => setTimeout(resolve, 100)), callSignal)
            }
          }
          callSignal.addEventListener('abort', abort, { once: true })
          callSignal.throwIfAborted()
          if (activation.childId !== childId) throw new Error('M3 子 Agent 身份与预留身份不一致')
          const child = deps.ctx.agents.get(childId)
          const model = child?.options.model
          if (req.model !== undefined && model !== req.model) throw new Error('M3 实际模型与请求模型不一致或无法核对')
          if (req.effort !== undefined && child?.options.reasoningEffort !== req.effort) throw new Error('M3 实际 effort 与请求不一致')
          if (kind === 'eval') {
            if (!model) throw new Error('回放无法核对实际模型，不能证明独立判分')
            if (replay) replayModels.add(model)
            else if (role === 'evaluator' && (!replayModels.size || replayModels.has(model))) throw new Error('判分实际模型必须不同于被测实际模型')
          }
          onEvent({ type: 'started', sessionId: childId, ...(model ? { model } : {}) })
          const result = await abortable(activation.result, callSignal)
          callSignal.throwIfAborted()
          await requireM3Lead(deps, space, requirementId, owner)
          await deps.beforeWrite?.(space)
          const finalText = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
          if (finalText) onEvent({ type: 'message', role: 'assistant', text: finalText })
          const nativeStructured = outputSchema ? result.structured : req.resultSchema ? extractJsonBlock(finalText) : result.structured
          // dsh 原生结果可能深冻结；core 会补齐归因 runId、规范化评审项，只能修改独立副本。
          const structured = nativeStructured === undefined ? undefined : structuredClone(nativeStructured)
          return { ok: result.stopReason === 'completed', finalText, sessionId: childId,
            ...(structured === undefined ? {} : { structured }),
            ...(result.stopReason === 'completed' ? {} : { error: diagnostics.describe(result) }),
          }
        } catch (error) { failure = error; throw error } finally {
          callSignal.removeEventListener('abort', abort)
          try { await cleanup() } catch (error) {
            cleanupFailures.push(error)
            throw new AggregateError(failure === undefined ? [error] : [failure, error], 'M3 执行或清理失败')
          } finally { await diagnostics?.dispose() }
        }
      }

      const engine: M3Engine = {
        deps: { stores, profiles, harnesses: { 'dsh-host': adapter }, knowledge: [], sandbox: createLocalSandboxProvider(), skillsDir: stores.paths.skills },
        bindEval(id) {
          if (!/^eval-[a-zA-Z0-9-]+$/.test(id) || (evalId && evalId !== id)) throw new Error('评测运行身份不合法或已经绑定')
          evalId = id; publishEval(id)
        },
        async dispose() {
          disposed = true; controller.abort()
          await Promise.allSettled([...active])
          const errors: unknown[] = []
          for (const cleanup of [...retryCleanup]) { try { await cleanup() } catch (error) { errors.push(error) } }
          engines.delete(engine)
          if (errors.length || cleanupFailures.length) throw new AggregateError([...cleanupFailures, ...errors], 'M3 清理曾发生失败')
        },
      }
      engines.add(engine)
      return engine
    },
    async dispose() {
      closed = true
      const results = await Promise.allSettled([...engines].map((engine) => engine.dispose()))
      const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map((value) => value.reason)
      if (errors.length) throw new AggregateError(errors, 'M3 运行时关闭失败')
    },
  }
}

function hostSelector(selector: HarnessSelector): HarnessSelector {
  // CLI 的 high/model/provider/fallback 描述的是外部执行器，不能移植为 App 控制项。
  // 用户明确写 dsh-host 时不降级：不支持的 model/effort 仍由真实宿主报错。
  return selector.harness === 'dsh-host' ? structuredClone(selector) : { harness: 'dsh-host' }
}
function forkPresets(presets: RolePresets, profiles: Record<string, AgentProfile>, skills: RoleSkillSnapshots): RolePresets {
  const fork = (presets as RolePresets & { fork?(profiles: Record<string, AgentProfile>, skills: RoleSkillSnapshots): RolePresets }).fork
  if (!fork) throw new Error('M3 需要支持冻结角色与技能的 preset 工厂')
  return fork.call(presets, profiles, skills)
}
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
