/**
 * M-J 标准流水线 e2e 的真实子 Agent 探针（普通 ESM 插件，不依赖 esbuild）。
 *
 * 只做五件事，且全部发生在真实子 Agent 上：
 * 1. 记录每个 `subagent/start` 的 childId、run/node/attempt、preset、精确角色、真实工具清单；
 * 2. 对 dev / reviewer 执行 `skill` 工具：自己的 Skill 必须真实读到内容，另一个角色 Skill
 *    与宿主注册的 global-forbidden 必须因白名单被明确拒绝；
 * 3. 检查 skill 工具描述/参数里的可见目录：不能出现未声明的 Skill；
 * 4. 用 `ctx.skills.list` 记录该子 Agent scope 的可见 Skill 目录，区分角色目录与宿主 global 层；
 * 5. 对 test-designer 执行 `read` 读取产品代码，验证读守卫真的拒绝（trace.denials 另行断言）。
 *
 * 工具执行使用 dsh 0.2.2 的 batch calls 协议；只有明确收到 “Tool batch execution failed”
 * 才回退 0.2.1 单次协议。真实工具错误不会被当成协议不支持而重试。
 *
 * 探针不会伪造 trace，也不会替任何人工待办作答；失败只记录原始结果，由主脚本判定。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'taktflow-mj-standard-probe'
export const inject = ['connection', 'agents', 'subagents', 'tools', 'skills']

/** 长角色名在前，避免 release-reviewer 被 reviewer 抢先匹配。 */
const ROLES = ['release-reviewer', 'test-designer', 'automation', 'architect', 'reviewer', 'judge', 'dev', 'pm', 'lead']
const ROLE_SAMPLES = [
  'taktflow-release-reviewer',
  'release-reviewer',
  'taktflow-reviewer',
  'taktflow-dev',
  'taktflow-test-designer',
  'taktflow-automation',
  'taktflow-judge',
  'taktflow-pm',
  'taktflow-architect',
  'taktflow-lead',
]
const GLOBAL_FORBIDDEN = {
  name: 'global-forbidden',
  description: 'e2e 全局 Skill 泄漏探针：不属于任何角色白名单',
  whenToUse: '仅用于验证全局注册的 Skill 不会绕过角色白名单',
  source: 'bundled',
  invocation: { modelInvocable: true, userInvocable: false },
  content: '# global-forbidden\n\nGLOBAL_FORBIDDEN_MARKER\n\n这是宿主级注册的探针 Skill，任何角色都不应看到或读到它。\n',
}
/** 全局 tool-skill 与角色局部 skill 工具的真实拒绝语义；其它工具错误不算白名单拒绝。 */
const SKILL_DENIAL_RE = /skill\s+"[^"]+"\s+is\s+(?:unknown or no longer available|not available for model invocation|not allowed|forbidden|denied|not permitted)|技能\s*"[^"]+"\s*(?:不在当前角色范围内|被拒绝|未授权|不允许)/i
/** 读守卫拒绝的产品代码读取；用于区分“守卫拒绝”与工具缺失/协议错误。 */
const READ_DENIAL_RE = /拒绝|denied|forbidden|not allowed|outside|越界|只读/i

function tokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * 角色身份优先取宿主真实权限 scope；没有 scope 时按 preset 的 token 序列精确匹配。
 * 不做子串匹配，`taktflow-release-reviewer` 必须得到 release-reviewer 而不是 reviewer。
 */
function roleOf(preset, scope) {
  // scope.role 是宿主真实权限身份；但它也可能是 preset id（如 taktflow-release-reviewer），
  // 所以仍要按 token 序列做最长优先匹配，不能直接当角色名或做子串包含。
  for (const candidate of [scope?.role, preset]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const text = candidate.toLowerCase()
    if (ROLES.includes(text)) return text
    const presetTokens = tokens(text)
    for (const role of ROLES) {
      const roleTokens = tokens(role)
      for (let index = 0; index + roleTokens.length <= presetTokens.length; index++) {
        if (roleTokens.every((token, offset) => presetTokens[index + offset] === token)) return role
      }
    }
  }
  return undefined
}

function textOf(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .slice(0, 2_000)
}

/**
 * 工具结果与异常分开记录：
 * - `completed=true` 表示 batch/single 工具调用真的返回了结果，isError 是工具自身结果；
 * - `protocolError=true` 表示执行器抛错（child 已结束、API 异常等），不能算白名单拒绝；
 * - `toolMissing=true` 表示子会话根本没有挂载该工具，同样不能算隔离通过。
 */
function outcome(result, denialRe) {
  const text = textOf(result)
  const message = result?.error?.message
  const isError = result?.isError === true
  const haystack = `${typeof message === 'string' ? message : ''}\n${text}`
  return {
    completed: true,
    isError,
    code: result?.error?.info?.code ?? result?.error?.code,
    message,
    text,
    denial: isError && denialRe !== undefined && denialRe.test(haystack),
  }
}

export function apply(ctx) {
  const root = process.env.TAKTFLOW_E2E_STANDARD_SPACE
  const productPath = process.env.TAKTFLOW_E2E_STANDARD_PRODUCT || 'app/src/add.js'
  if (!root || !process.env.DSH_HOME || !root.startsWith(process.env.DSH_HOME + path.sep)) return
  // 用空间根下的绝对产品路径，避免 read 工具按子会话 cwd 解析到别的文件。
  const readPath = path.isAbsolute(productPath) ? productPath : path.join(root, productPath)

  const children = []
  const startedAt = new Date().toISOString()
  const globalSkill = { name: GLOBAL_FORBIDDEN.name, registered: false, error: undefined }
  const roleSamples = Object.fromEntries(ROLE_SAMPLES.map((sample) => [sample, roleOf(sample, undefined)]))

  const service = () => ctx.get('taktflow')
  const toolsOf = (child) => ctx.tools.schemas(child).map((tool) => tool.name).sort()

  /**
   * 真实 dsh core 单例验收（不调用模型、不写 attention/run）。
   *
   * 用插件自己的 workflow loader 加载一个本次私有的临时 workflow；该 workflow
   * 从 `@taktflow/core` 导入 FsAttentionStore 并把它作为 run 的返回值。随后与
   * 宿主空间 `stores.attention` 比 instanceof 和 constructor：只有 workflow 的
   * @taktflow/core 与宿主 core 是同一模块实例时才成立。临时文件在 finally 删除。
   */
  let coreSingletonPromise
  const coreSingleton = { checked: false, ok: false }
  async function checkCoreSingleton() {
    if (coreSingletonPromise !== undefined) return coreSingletonPromise
    coreSingletonPromise = (async () => {
      coreSingleton.checked = true
      const dir = path.join(root, '.takt', 'dsh')
      const file = path.join(dir, `core-singleton-${process.pid}-${randomUUID()}.workflow.ts`)
      try {
        await mkdir(dir, { recursive: true })
        const source = [
          "import { FsAttentionStore, defineWorkflow, script } from '@taktflow/core'",
          '',
          'export default defineWorkflow({',
          "  id: 'e2e-core-singleton',",
          "  title: 'e2e core singleton',",
          "  version: '1',",
          '  stages: [],',
          '  nodes: [',
          "    script({ id: 'class', title: 'class', run: async () => FsAttentionStore }),",
          '  ],',
          '})',
          '',
        ].join('\n')
        await writeFile(file, source, 'utf8')
        const taktflow = service()
        if (taktflow === undefined) throw new Error('taktflow 服务不可用')
        if (typeof taktflow.workflows?.loadFile !== 'function') throw new Error('workflows.loadFile 不可用')
        const loaded = await taktflow.workflows.loadFile(file)
        const node = Array.isArray(loaded?.workflow?.nodes) ? loaded.workflow.nodes[0] : undefined
        if (typeof node?.run !== 'function') throw new Error('临时 workflow 没有可执行的类节点')
        const cls = await node.run({})
        if (typeof cls !== 'function') throw new Error('临时 workflow 没有返回 FsAttentionStore 构造器')
        const space = await taktflow.spaces.open(root)
        const attention = space?.stores?.attention
        const instanceofMatch = attention instanceof cls
        const constructorMatch = attention?.constructor === cls
        Object.assign(coreSingleton, {
          ok: instanceofMatch && constructorMatch,
          instanceofMatch,
          constructorMatch,
          workflowFile: path.relative(root, file),
          loadedVia: 'workflows.loadFile',
        })
        if (!coreSingleton.ok) throw new Error('空间 attention store 与 workflow 导入的 FsAttentionStore 不是同一构造器')
      } catch (error) {
        coreSingleton.ok = false
        coreSingleton.error = error instanceof Error ? error.message : String(error)
      } finally {
        await rm(file, { force: true }).catch(() => undefined)
      }
      return coreSingleton
    })()
    return coreSingletonPromise
  }

  try {
    ctx.effect(() => ctx.skills.register(GLOBAL_FORBIDDEN), 'taktflow e2e global forbidden skill')
    globalSkill.registered = true
  } catch (error) {
    globalSkill.error = error instanceof Error ? error.message : String(error)
  }

  async function waitForTool(child, name, record) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const schemas = ctx.tools.schemas(child)
      if (schemas.some((tool) => tool.name === name)) {
        // 成功时 child 仍可见；立即固化真实工具快照，避免销毁后的空 schemas 覆盖。
        record.tools = schemas.map((tool) => tool.name).sort()
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }

  /** dsh 0.2.2 batch 协议；只有明确的 batch 不支持错误才回退 0.2.1 单次协议。 */
  async function execute(child, name, args, denialRe) {
    const callId = `mj-standard-${randomUUID()}`
    try {
      const batch = await ctx.tools.execute({
        calls: [{ id: callId, name, arguments: JSON.stringify(args) }],
        agent: child,
        signal: AbortSignal.timeout(20_000),
      })
      if (!Array.isArray(batch?.results) || batch.results.length === 0) {
        // 有结果结构但缺 result 不是“协议不支持”，不能触发单次回退重试。
        return { protocol: 'batch', completed: false, protocolError: true, isError: true, error: 'batch 返回缺少 results', text: '', denial: false }
      }
      if (batch.results[0]?.result === undefined) {
        return { protocol: 'batch', completed: false, protocolError: true, isError: true, error: 'batch 返回缺少 result', text: '', denial: false }
      }
      return { protocol: 'batch', ...outcome(batch.results[0].result, denialRe) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== 'Tool batch execution failed') {
        return { protocol: 'batch', completed: false, protocolError: true, isError: true, error: message, text: '', denial: false }
      }
      try {
        const single = await ctx.tools.execute({
          callId,
          name,
          // 0.2.1 单次协议传原始参数对象；batch 协议才用 JSON 字符串。
          arguments: args,
          agent: child,
          signal: AbortSignal.timeout(20_000),
        })
        return { protocol: 'single-fallback', ...outcome(single, denialRe) }
      } catch (fallbackError) {
        return {
          protocol: 'single-fallback',
          completed: false,
          protocolError: true,
          isError: true,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          text: '',
          denial: false,
        }
      }
    }
  }

  /** 可见目录：skill 工具描述与参数里出现的技能名，不能包含未声明的 Skill。 */
  function visibilityOf(child, own, other) {
    const schema = ctx.tools.schemas(child).find((tool) => tool.name === 'skill')
    const text = schema === undefined
      ? ''
      : `${String(schema.description ?? '')}\n${JSON.stringify(schema.parameters ?? schema.inputSchema ?? {})}`
    return {
      found: schema !== undefined,
      ownVisible: text.includes(own),
      otherVisible: text.includes(other),
      globalVisible: text.includes(GLOBAL_FORBIDDEN.name),
      toolDescription: text.slice(0, 2_000),
    }
  }

  /**
   * 该子 Agent scope 的 Skill 目录。
   *
   * `ctx.skills.list` 是 dsh-skill 的真实目录接口：会合并 global 层与 scope 链。
   * 角色局部 skill 工具另有白名单，二者不能混为一谈；主脚本会分别断言
   * “工具描述不泄漏”与“实际调用被拒绝”，并记录 global 层在 registry 中的真实状态。
   */
  async function catalogOf(child, cwd) {
    if (typeof ctx.skills?.list !== 'function') {
      return { available: false, completed: false, error: 'ctx.skills.list 不可用' }
    }
    const options = { cwd, scope: child, signal: AbortSignal.timeout(20_000) }
    try {
      const listed = await ctx.skills.list(options)
      const snapshot = typeof ctx.skills.snapshot === 'function' ? await ctx.skills.snapshot(options) : undefined
      const summaries = Array.isArray(listed)
        ? listed
        : (Array.isArray(snapshot?.skills) ? snapshot.skills : [])
      return {
        available: true,
        completed: true,
        complete: snapshot?.complete ?? null,
        names: summaries.map((item) => item?.name).filter((item) => typeof item === 'string'),
        summaries: summaries.map((item) => ({
          name: item?.name,
          source: item?.source,
          provider: item?.provider,
          description: typeof item?.description === 'string' ? item.description.slice(0, 300) : undefined,
        })),
      }
    } catch (error) {
      return {
        available: true,
        completed: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  ctx.on('subagent/start', (info) => {
    const child = ctx.agents.get(info.id)
    const scope = service()?.permissions.lookup(info.id)
    if (!child) {
      children.push({ childId: info.id, stage: 'no-child', pending: false })
      return
    }
    const preset = child.session?.header?.agentPreset
    const record = {
      childId: info.id,
      sessionId: child.session?.header?.id ?? child.session?.id,
      runId: scope?.nodeRef?.runId,
      nodeId: scope?.nodeRef?.nodeId,
      attempt: scope?.nodeRef?.attempt,
      preset,
      role: roleOf(preset, scope),
      roleSource: typeof scope?.role === 'string' && scope.role.trim() !== '' ? 'scope' : 'preset',
      scope: scope === undefined ? undefined : {
        cwd: scope.cwd,
        writeScope: scope.writeScope,
        readScope: scope.readScope,
        allowBash: scope.allowBash,
        readOnly: scope.readOnly,
        role: scope.role,
      },
      tools: toolsOf(child),
      skill: undefined,
      skillOther: undefined,
      globalSkill: undefined,
      visibility: undefined,
      catalog: undefined,
      read: undefined,
      pending: true,
    }
    children.push(record)

    void (async () => {
      if (record.role === 'dev' || record.role === 'reviewer') {
        const own = record.role === 'dev' ? 'skill-alpha' : 'skill-beta'
        const other = record.role === 'dev' ? 'skill-beta' : 'skill-alpha'
        if (!(await waitForTool(child, 'skill', record))) {
          record.skill = { name: own, completed: false, toolMissing: true }
          record.skillOther = { name: other, completed: false, toolMissing: true }
          record.globalSkill = { name: GLOBAL_FORBIDDEN.name, completed: false, toolMissing: true }
          return
        }
        record.skill = { name: own, ...(await execute(child, 'skill', { name: own }, SKILL_DENIAL_RE)) }
        record.skillOther = { name: other, ...(await execute(child, 'skill', { name: other }, SKILL_DENIAL_RE)) }
        record.globalSkill = {
          name: GLOBAL_FORBIDDEN.name,
          ...(await execute(child, 'skill', { name: GLOBAL_FORBIDDEN.name }, SKILL_DENIAL_RE)),
        }
        record.visibility = visibilityOf(child, own, other)
        record.catalog = await catalogOf(child, record.scope?.cwd ?? root)
      } else if (record.role === 'test-designer') {
        if (!(await waitForTool(child, 'read', record))) {
          record.read = { path: readPath, completed: false, toolMissing: true }
          return
        }
        record.read = { path: readPath, ...(await execute(child, 'read', { file_path: readPath }, READ_DENIAL_RE)) }
      }
    })()
      .catch((error) => { record.error = error instanceof Error ? error.message : String(error) })
      .finally(() => {
        try {
          const latest = toolsOf(child)
          // child 销毁后 schemas 可能返回空数组；只有仍能看到工具时才刷新，
          // 不能用空快照覆盖 waitForTool 成功时保存的真实可见清单。
          if (latest.length > 0) record.tools = latest
        } catch {
          // child 已销毁时工具清单不可读；保留注册/waitForTool 时的真实快照。
        }
        record.pending = false
      })
  })

  // 快照是只读查询；用 GET，避免把查询伪装成写操作。core 单例验收会写一个私有
  // 临时 workflow，只在主脚本明确传 `?core=1`（Lead init 之后）时执行，避免早期
  // 轮询把失败结果缓存下来。
  ctx.connection.fetch.register({
    path: '/api/taktflow.e2e-standard',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const singleton = url.searchParams.get('core') === '1'
        ? await checkCoreSingleton()
        : { checked: false, ok: false }
      return Response.json({
        ok: true,
        value: { children, spaceRoot: root, productPath, startedAt, globalSkill, roleSamples, coreSingleton: singleton },
      })
    },
  })
}
