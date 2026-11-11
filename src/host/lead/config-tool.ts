import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { createApiCore, ApiError, type ApiCore, type WriteOp } from '@taktflow/server'
import type { Actor, ProjectStores, SpaceDetail, SpaceSettings, SpaceUpgradePlan, WorkflowDocument } from '@taktflow/core'
import { BUNDLED_AGENT_FILES, BUNDLED_WORKFLOW_FILES } from '../../templates/bundled.js'
import type { DefineToolOptions, ToolExecutionContext } from '../dsh-types.js'
import { spaceConfigPatterns } from '../config-paths.js'
import { droppedGates, workflowChoices, workflowFilePath, workflowSource } from './workflow-choice.js'
import { TaktToolError, type SpaceHandle } from '../types.js'
import {
  OUTPUT_SCHEMA, asRecord, failure, optionalString, renderResult, requireRootAgent, requiredString, success, toFailure,
  type LeadToolResult, type ToolDeps,
} from './tools.js'

export { droppedGates } from './workflow-choice.js'

/**
 * takt_config：用自然语言改空间配置（docs/design/21）。
 *
 * 和设置页走同一套 api-core 操作：同样的校验、租约、审计与修订记录，可在设置页“修改记录”或用
 * rollback 撤回。actor 是 Lead（agent），onBehalfOf 是会话对应的人；权限按那个人算，不会更大。
 * 只在用户明确要求改配置时使用；删除、升级、回滚要先用 takt_ask_human 确认再传 confirmed=true。
 */
const ACTIONS = [
  'show', 'set_config', 'save_role', 'delete_role', 'save_skill', 'delete_skill',
  'workflow_create', 'workflow_meta', 'workflow_delete', 'workflow_read', 'workflow_edit',
  'upgrade', 'history', 'rollback', 'repo_add', 'repo_sync',
] as const
type Action = (typeof ACTIONS)[number]
const DESTRUCTIVE = new Set<Action>(['delete_role', 'delete_skill', 'workflow_delete', 'rollback'])

const cores = new WeakMap<ToolDeps, ApiCore>()
function apiCore(deps: ToolDeps): ApiCore {
  const cached = cores.get(deps)
  if (cached !== undefined) return cached
  const core = createApiCore({
    // 所有写先确认本宿主持有空间租约（与面板写入口一致）。
    withWriteLease: async (stores: ProjectStores, fn) => {
      const space = await deps.service.spaces.open(stores.projectDir)
      await deps.service.ownership.ensureLease(space)
      return fn()
    },
    templates: () => ({
      workflows: BUNDLED_WORKFLOW_FILES.map((file) => ({ name: file.fileName, content: file.content })),
      agents: BUNDLED_AGENT_FILES.map((file) => ({ name: file.fileName, content: file.content })),
    }),
  })
  cores.set(deps, core)
  return core
}

export function taktConfigTool(deps: ToolDeps): DefineToolOptions {
  return {
    name: 'takt_config',
    description: [
      '查看和修改空间配置：运行策略（自主程度、默认流程、环境部署、自测、预算、知识源）、角色、技能、流程。',
      '何时用：用户明确要求改配置时（例如“把 PRD 评审最多改成 2 轮”“新建一个安全评审角色”）；先 show 看现状。',
      '何时不用：用户没要求就不要改；需求产物用 takt_artifact。删除 / 升级 / 回滚、以及去掉评审或交付校验的 workflow_edit，先 takt_ask_human 确认，再带 confirmed=true。不要为了让运行通过而裁掉评审、测分或交付校验。',
      '现有流程都不适合这个需求时可以自己新建：workflow_create from=默认流程复制，再 workflow_edit 只加不减（加节点、改提示词、换角色都不用问），把 useWhen 改成它适合的需求；先看 show 里有没有能复用的 Lead 自建流程。从比默认更轻的流程复制、或把默认流程换成更轻的，要先征得同意。默认流程是用户的偏好，不要把自建流程设为默认。',
      '每次修改都要 reason（引用用户原话）；结果里会给出怎么撤回。流程节点属性（评审轮次、角色、提示词等）用 workflow_read 读源码后 workflow_edit 整文件替换。',
      '自测配置（selftest）只有 timeoutMs（1000..3600000 毫秒）和 allowedCommands（命令白名单）两个字段，没有 selftest.commands；不配置命令时默认用 environment.testCommand，quick-fix 固定 npm test，其它流程回退 package.json 的 test 脚本，不需要先配置命令才能自测。',
      '代码仓库：用户要在某个 git 仓库上开发时，用 repo_add 绑定（id 默认 app，流程里的开发节点用 repo=app），宿主会拉取并在独立工作区里改代码；不要满盘搜文件找项目，问用户要地址。',
      '示例：{"action":"show"}',
      '示例：{"action":"set_config","patch":{"autonomy":"checkpoints"},"reason":"用户：评审签字我自己来"}',
      '示例：{"action":"save_role","role":"security","create":true,"copyFrom":"reviewer","profile":{"title":"安全评审"},"reason":"用户：加一个安全评审"}',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: [...ACTIONS], required: true, description: '要做的事。' },
      reason: { type: 'string', description: '写操作必填：为什么改（引用用户原话）。' },
      confirmed: { type: 'boolean', description: '删除 / 回滚 / 执行升级、去掉评审或交付校验的 workflow_edit、从比默认更轻的流程新建、把默认流程换成更轻的流程时必填 true：表示已经在这次 takt_ask_human 里得到用户确认（不能引用以前的同意）。' },
      patch: { type: 'json', description: 'set_config：要改的字段，可含 autonomy(full|checkpoints|manual)、defaultWorkflow、environment、selftest({timeoutMs, allowedCommands})、budget、knowledge；null 表示恢复默认。selftest 没有 commands 字段。' },
      role: { type: 'string', description: 'save_role / delete_role / history / rollback(kind=agent)：角色 id。' },
      profile: { type: 'json', description: 'save_role：要改的字段 title / description / skills / writeScope / readScope(null 取消限制) / model(null 跟随 App)。' },
      instructions: { type: 'string', description: 'save_role：职责说明正文（整段替换）。' },
      create: { type: 'boolean', description: 'save_role / save_skill：新建。' },
      copyFrom: { type: 'string', description: 'save_role 新建时从哪个角色复制。' },
      name: { type: 'string', description: 'save_skill / delete_skill / history / rollback(kind=skill)：技能名。' },
      description: { type: 'string', description: 'save_skill：什么时候用这个技能。' },
      body: { type: 'string', description: 'save_skill：技能正文。' },
      id: { type: 'string', description: 'workflow_*：流程 id。' },
      title: { type: 'string', description: 'workflow_create / workflow_meta：流程名称。' },
      template: { type: 'string', description: 'workflow_create：从模板新建（taktflow-standard / quick-fix / sdlc）。' },
      from: { type: 'string', description: 'workflow_create：复制现有流程的 id；自建流程默认从默认流程复制。' },
      default: { type: 'boolean', description: 'workflow_meta：设为默认流程。' },
      source: { type: 'string', description: 'workflow_edit：完整的新源码。' },
      baseRev: { type: 'string', description: 'workflow_edit：workflow_read 返回的 rev。' },
      kind: { type: 'string', enum: ['agent', 'skill', 'config'], description: 'history / rollback：哪类文件。' },
      rev: { type: 'string', description: 'rollback：要恢复到的修订（history 返回）。' },
      dryRun: { type: 'boolean', description: 'upgrade：只看要做什么，默认 true。' },
      url: { type: 'string', description: 'repo_add：远端 git 地址（宿主负责拉取，你不需要也不能执行 git 命令）。' },
      path: { type: 'string', description: 'repo_add：本机已有 git 仓库的路径（和 url 二选一）。' },
      defaultBranch: { type: 'string', description: 'repo_add：默认分支，缺省 main；开发节点从它开分支。' },
      repoId: { type: 'string', description: 'repo_add / repo_sync：仓库 id，缺省 app（流程模板里的产品仓库）。' },
      purpose: { type: 'string', description: 'repo_add：仓库用途说明（可选）。' },
      bootstrap: { type: 'string', description: 'repo_add：开发工作区准备命令，例如 npm ci（可选）。' },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(raw: unknown, exec: ToolExecutionContext): Promise<LeadToolResult> {
      try {
        const args = asRecord(raw)
        const action = requiredString(args, 'action') as Action
        if (!(ACTIONS as readonly string[]).includes(action)) return failure('TAKT_INVALID_INPUT', `未知动作：${action}`, `可用：${ACTIONS.join(' / ')}`)
        const agent = requireRootAgent(exec, deps)
        const space = await deps.service.spaces.forSession(agent.session.header.cwd)
        const actor: Actor = { type: 'agent', role: 'lead', harness: 'dsh', onBehalfOf: deps.human }
        // 新建流程的修订原因里记下为哪个需求建的；读不到绑定不影响改配置
        const requirementId = await deps.service.bindings.bySession(space, agent.id).catch(() => undefined)
        return await run(apiCore(deps), space, actor, action, args, deps.service.runs?.withHostWrites?.bind(deps.service.runs), requirementId)
      } catch (error) {
        if (error instanceof ApiError) return failure(error.status === 409 ? 'TAKT_RUN_BUSY' : 'TAKT_INVALID_INPUT', error.message, '按提示调整后重试；先 show 看现状。')
        return toFailure(error)
      }
    },
  }
}

type HostWrites = <T>(space: SpaceHandle, paths: string[], fn: () => Promise<T>) => Promise<T>

async function run(api: ApiCore, space: SpaceHandle, actor: Actor, action: Action, args: Record<string, unknown>, hostWrites?: HostWrites, requirementId?: string): Promise<LeadToolResult> {
  const read = (op: Parameters<ApiCore['read']>[1], params: Record<string, string | undefined> = {}) => api.read(space.stores, op, params, actor)
  // 配置写入是宿主写入：运行中改配置不能算成正在执行节点的越界（同面板写入）。
  const write = (op: WriteOp, params: Record<string, string>, body: Record<string, unknown>) => {
    const fn = () => api.write(space.stores, op, params, body, actor)
    return hostWrites?.(space, spaceConfigPatterns(space), fn) ?? fn()
  }
  const reason = () => requiredString(args, 'reason')
  const currentDefault = async () => (await read('space.settings') as SpaceSettings).workflows.find((w) => w.default)?.id
  // 默认流程是用户的偏好：换成比现在更轻的默认（少评审 / 交付校验）要用户当场同意，否则等于绕过选流程时的确认
  const assertDefaultNotLighter = async (next: string) => {
    if (args.confirmed === true) return
    const now = await currentDefault()
    if (now === undefined || now === next) return
    const [before, after] = await Promise.all([workflowSource(space, now), workflowSource(space, next)])
    const dropped = before === undefined || after === undefined ? [] : droppedGates(before, after)
    if (dropped.length > 0) {
      throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `把默认流程从 ${now} 换成 ${next} 会少了${dropped.join('、')}，需要用户确认`,
        '默认流程是用户的偏好。先用 takt_ask_human 说明换成哪个、少了哪些检查，用户在这次提问里同意后再带 confirmed=true；只是这一个需求要用别的流程，直接 takt_run start workflow=… 即可，不用改默认。')
    }
  }
  if (DESTRUCTIVE.has(action) || (action === 'upgrade' && args.dryRun === false)) {
    if (args.confirmed !== true) {
      throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `${action} 会删除或覆盖配置，需要用户确认`, '先用 takt_ask_human 说明要改什么、影响什么，用户同意后带 confirmed=true 再调用。')
    }
  }
  switch (action) {
    case 'show': {
      const s = await read('space.settings') as SpaceSettings
      // show 的嵌套可选字段必须显式给出 JSON 缺省：undefined 会被 dsh 的
      // lossless JSON 校验拒绝（“value is not lossless JSON”）。
      const detail = await read('space') as SpaceDetail
      const choices = new Map((await workflowChoices(space, s.workflows.filter((w) => w.registered).map((w) => w.id), s.workflows.find((w) => w.default)?.id)).map((c) => [c.id, c]))
      return success('当前空间配置', {
        config: s.config,
        repos: detail.repos.map((r) => ({ id: r.id, url: r.url ?? null, path: r.path, defaultBranch: r.defaultBranch, status: r.status, message: r.message ?? null })),
        workflows: s.workflows.map((w) => {
          const c = choices.get(w.id)
          return { id: w.id, title: w.title, default: w.default, useWhen: c?.useWhen ?? null, checks: c?.checks ?? null, lighterThanDefault: c?.lighterThanDefault ?? [], createdByLead: c?.createdByLead ?? null }
        }),
        roles: s.roles.map((r) => ({
          role: r.role,
          title: r.title ?? null,
          skills: r.skills ?? [],
          writeScope: r.writeScope ?? [],
          readScope: r.readScope ?? null,
          model: r.harness.model ?? null,
          usedBy: r.usedBy.length,
        })),
        skills: s.skills.map((k) => ({ name: k.name, description: k.description, usedBy: k.usedBy })),
        templates: s.templates.map((t) => t.id),
        legacy: s.layout.legacy ? s.layout.issues : null,
      }, s.layout.legacy ? ['takt_config action="upgrade"（先预览，再征得同意后执行）'] : ['按用户要求调用对应的写动作'])
    }
    case 'set_config': {
      const patch = args.patch
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'patch 必须是对象，例如 {"autonomy":"checkpoints"}')
      const next = (patch as Record<string, unknown>).defaultWorkflow
      if (typeof next === 'string') await assertDefaultNotLighter(next)
      await write('space.config.update', {}, { patch, reason: reason() })
      return done(`已修改运行策略：${Object.keys(patch).join('、')}`, 'config')
    }
    case 'save_role': {
      const role = requiredString(args, 'role')
      const body: Record<string, unknown> = { profile: args.profile ?? {}, reason: reason() }
      for (const key of ['instructions', 'create', 'copyFrom'] as const) if (args[key] !== undefined) body[key] = args[key]
      await write('space.agent.save', { role }, body)
      return done(`${args.create === true ? '已新建' : '已修改'}角色 ${role}`, 'agent', role)
    }
    case 'delete_role': {
      const role = requiredString(args, 'role')
      await write('space.agent.delete', { role }, { reason: reason() })
      return done(`已删除角色 ${role}`, 'agent', role)
    }
    case 'save_skill': {
      const name = requiredString(args, 'name')
      await write('space.skill.save', { name }, { description: requiredString(args, 'description'), ...(args.body === undefined ? {} : { body: args.body }), ...(args.create === true ? { create: true } : {}), reason: reason() })
      return done(`${args.create === true ? '已新建' : '已修改'}技能 ${name}`, 'skill', name)
    }
    case 'delete_skill': {
      const name = requiredString(args, 'name')
      await write('space.skill.delete', { name }, { reason: reason() })
      return done(`已删除技能 ${name}`, 'skill', name)
    }
    case 'workflow_create': {
      const id = requiredString(args, 'id')
      const template = optionalString(args, 'template')
      const from = optionalString(args, 'from')
      if ((template === undefined) === (from === undefined)) throw new ApiError(400, 'template 和 from 二选一：从模板新建传 template，复制现有流程传 from')
      const why = reason()
      const base = template ?? from!
      const defaultId = await currentDefault()
      if (args.confirmed !== true && defaultId !== undefined && base !== defaultId) {
        // 自建流程从默认流程复制再加：从更轻的流程起步等于换个名字裁剪
        const baseSource = template !== undefined
          ? BUNDLED_WORKFLOW_FILES.find((file) => file.fileName === `${template}.workflow.ts`)?.content
          : await workflowSource(space, from!)
        const defaultSource = await workflowSource(space, defaultId)
        const dropped = baseSource === undefined || defaultSource === undefined ? [] : droppedGates(defaultSource, baseSource)
        if (dropped.length > 0) {
          throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `从 ${base} 新建会比默认流程 ${defaultId} 少了${dropped.join('、')}，需要用户确认`,
            `自建流程请 from="${defaultId}" 复制默认流程再改（加节点、改提示词、换角色都不用问）；确实要更轻的流程，先用 takt_ask_human 说明少了哪些检查、为什么，用户在这次提问里同意后再带 confirmed=true。`)
        }
      }
      const stamped = `${why}（Lead${requirementId === undefined ? '' : ` 为需求 ${requirementId}`} 新建，基于 ${base}）`
      await write('workflow.create', {}, { id, ...(args.title === undefined ? {} : { title: args.title }), from: template ? { template } : { workflow: from }, reason: stamped })
      return success(`已新建流程 ${id}`, { id, base }, [
        `takt_config action="workflow_read" id="${id}"，按需求改（只加不减），并把 useWhen 改成这个流程适合的需求：之后选流程靠它`,
        `启动：takt_run action="start" workflow="${id}" reason="<默认流程哪里不适合>"`,
        '不要把它设为默认：默认流程是用户的偏好',
        '撤回：takt_config action="workflow_delete"（先征得同意）',
      ])
    }
    case 'workflow_meta': {
      const id = requiredString(args, 'id')
      if (args.default === true) await assertDefaultNotLighter(id)
      await write('workflow.meta', { id }, { ...(args.title === undefined ? {} : { title: args.title }), ...(args.default === true ? { default: true } : {}), reason: reason() })
      return success(`已修改流程 ${id}`, { id }, ['撤回：设置页 Workflow 的修订历史，或再次 workflow_meta 改回'])
    }
    case 'workflow_delete': {
      const id = requiredString(args, 'id')
      await write('workflow.delete', { id }, { reason: reason() })
      return success(`已删除流程 ${id}`, { id }, ['修订历史保留，可从历史源码重新新建'])
    }
    case 'workflow_read': {
      const id = requiredString(args, 'id')
      const doc = await read('workflow.source', { id }) as WorkflowDocument
      return success(`流程 ${id} 的源码（rev ${doc.rev.slice(0, 8)}）`, { id, file: doc.file, rev: doc.rev, source: doc.source }, [`takt_config action="workflow_edit" id="${id}" baseRev="${doc.rev}" source="<完整新源码>" reason="…"`])
    }
    case 'workflow_edit': {
      const id = requiredString(args, 'id')
      const source = requiredString(args, 'source')
      if (args.confirmed !== true) {
        // 评审和交付校验是质量关口：去掉它们必须当场问用户（真实事故：Lead 为了让运行通过，
        // 先后删掉 PRD 评审、系分评审、测分，最后另建只有人工准出的流程，并引用几小时前另一件事的同意）。
        const file = (await read('space.settings') as SpaceSettings).workflows.find((w) => w.id === id)?.file
        const current = file === undefined ? '' : await readFile(workflowFilePath(space, file), 'utf8').catch(() => '')
        const dropped = droppedGates(current, source)
        if (dropped.length > 0) {
          throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `这次修改会去掉${dropped.join('、')}，需要用户确认`,
            '先用 takt_ask_human 说明要去掉哪些评审 / 交付校验、为什么、去掉后少了什么保障，用户在这次提问里同意后再带 confirmed=true；reason 引用这次的回答，不能引用以前的同意。')
        }
      }
      const result = await write('workflow.source.replace', { id }, { baseRev: requiredString(args, 'baseRev'), source, reason: reason() }) as WorkflowDocument | { error: string; diagnostics?: Array<{ severity: string; message: string; line?: number }> }
      if ('error' in result) {
        const diagnostics = (result.diagnostics ?? []).filter((d) => d.severity === 'error').slice(0, 5)
        return failure('TAKT_STALE_VERSION', result.error === 'conflict' ? '流程在你读取后被改过' : `源码校验没通过：${diagnostics.map((d) => `${d.line ? `第 ${d.line} 行 ` : ''}${d.message}`).join('；')}`,
          result.error === 'conflict' ? '重新 workflow_read 拿最新源码再改。' : '按诊断修正源码后重试；不确定时只改字面量属性。')
      }
      return success(`已修改流程 ${id}（新 rev ${result.rev.slice(0, 8)}）`, { id, rev: result.rev }, ['只影响之后启动的运行', '撤回：设置页 Workflow → 修订历史 → 回滚'])
    }
    case 'upgrade': {
      const plan = await write('space.upgrade', {}, { dryRun: args.dryRun !== false, reason: requiredString(args, 'reason') }) as SpaceUpgradePlan
      return success(plan.applied ? `已升级空间：${plan.changes.length} 项变更` : `升级预览：${plan.changes.length} 项变更`, { plan }, plan.applied ? ['撤回：takt_config action="history" kind="config" 后 rollback'] : ['用 takt_ask_human 把清单给用户确认，同意后 upgrade dryRun=false confirmed=true'])
    }
    case 'history': {
      const kind = requiredString(args, 'kind')
      const list = await read('space.file.revisions', { kind, name: optionalString(args, kind === 'skill' ? 'name' : 'role') }) as Array<{ rev: string; summary: string; reason: string; at: string }>
      return success(`${list.length} 条修改记录`, { revisions: list.slice(0, 20) }, ['takt_config action="rollback" kind=… rev=… confirmed=true（先征得同意）'])
    }
    case 'repo_add': {
      const id = optionalString(args, 'repoId') ?? 'app'
      const url = optionalString(args, 'url')
      const local = optionalString(args, 'path')
      if ((url === undefined) === (local === undefined)) throw new ApiError(400, 'url（远端 git 地址）和 path（本机仓库路径）二选一')
      const why = reason()
      const body: Record<string, unknown> = { id, path: url !== undefined ? `.takt/repos/${id}` : local, defaultBranch: optionalString(args, 'defaultBranch') ?? 'main', reason: why }
      if (url !== undefined) body.url = url
      for (const key of ['purpose', 'bootstrap'] as const) {
        const value = optionalString(args, key)
        if (value !== undefined) body[key] = value
      }
      await write('space.repo.add', {}, body)
      // 绑定后立即同步一次：拉取失败（权限、地址错）当场告诉用户，不留到运行时才发现。
      try {
        const synced = await write('space.repo.sync', { repoId: id }, { reason: `绑定后首次同步：${why}` }) as { head: string }
        const settings = await read('space.settings') as SpaceSettings
        const scope = await checkRoleScopes(path.resolve(space.root, String(body.path)), String(body.defaultBranch), settings.roles)
        const next = ['之后的运行里，开发节点在这个仓库的独立工作区里改代码，不动你的主分支', '解绑或改地址：面板「空间设置 → 代码仓库」']
        if (scope.warnings.length > 0) {
          next.unshift(`先修写范围：${scope.warnings.map((w) => `${w.role} 的 ${w.patterns.join('、')}`).join('；')} 在这个仓库里匹配不到任何文件（仓库顶层：${scope.topLevel.join('、')}）。按仓库实际的代码目录用 save_role 改 profile.writeScope，否则开发节点写代码会被拒绝`)
        }
        return success(`已绑定并同步仓库 ${id}（HEAD ${synced.head.slice(0, 8)}）`, { id, head: synced.head, synced: true, scopeWarnings: scope.warnings, topLevel: scope.topLevel }, next)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return success(`已绑定仓库 ${id}，但同步失败：${message}`, { id, synced: false, syncError: message }, ['确认地址和本机 git 权限后 takt_config action="repo_sync"', '地址填错：面板「空间设置 → 代码仓库」修改'])
      }
    }
    case 'repo_sync': {
      const id = optionalString(args, 'repoId') ?? 'app'
      const synced = await write('space.repo.sync', { repoId: id }, { reason: reason() }) as { head: string }
      return success(`仓库 ${id} 已同步（HEAD ${synced.head.slice(0, 8)}）`, { id, head: synced.head }, [])
    }
    case 'rollback': {
      const kind = requiredString(args, 'kind')
      const name = optionalString(args, kind === 'skill' ? 'name' : 'role')
      await write('space.file.rollback', { kind, ...(name === undefined ? {} : { name }) }, { rev: requiredString(args, 'rev'), reason: reason() })
      return success('已恢复到指定版本', {}, ['恢复本身也记了一条修改记录'])
    }
  }
}

/** 公共产物 / 知识库等空间内路径：不属于代码仓库，不按仓库目录检查。 */
const SPACE_PREFIXES = ['requirements/', '.takt/', 'knowledge/', 'agents/', 'skills/', 'workflows/']

/**
 * 绑定仓库后检查各角色的代码写范围：模板默认是 src/** + package.json，换到 Python 等其它布局的仓库会
 * 一条都匹配不上，要等到实现节点写代码被拒才暴露。按默认分支的顶层目录 / 文件对照模式首段
 * （远端仓库的本地副本是 bare 仓库，只能读 git 树）；首段带通配符的模式不判断，读不到树时不报。
 */
export async function checkRoleScopes(checkout: string, branch: string, roles: ReadonlyArray<{ role: string; writeScope: readonly string[]; readOnly?: boolean }>): Promise<{
  warnings: Array<{ role: string; patterns: string[] }>
  topLevel: string[]
}> {
  const entries = await topLevelEntries(checkout, branch)
  if (entries.length === 0) return { warnings: [], topLevel: [] }
  const dirs = new Set(entries.filter((e) => e.dir).map((e) => e.name))
  const files = new Set(entries.filter((e) => !e.dir).map((e) => e.name))
  const warnings: Array<{ role: string; patterns: string[] }> = []
  for (const role of roles) {
    if (role.readOnly === true) continue
    const code = role.writeScope.filter((p) => !SPACE_PREFIXES.some((prefix) => p.startsWith(prefix)))
    const unmatched = code.filter((pattern) => {
      const [head, ...rest] = pattern.split('/')
      if (head === undefined || head === '' || /[*?[{]/.test(head)) return false
      return rest.length === 0 ? !files.has(head) && !dirs.has(head) : !dirs.has(head)
    })
    // 有一条代码模式能匹配就不报：package.json 缺失但 src/** 存在是正常的
    if (code.length > 0 && unmatched.length === code.length) warnings.push({ role: role.role, patterns: unmatched })
  }
  const topLevel = [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 20).map((e) => (e.dir ? `${e.name}/` : e.name))
  return { warnings, topLevel }
}

async function topLevelEntries(checkout: string, branch: string): Promise<Array<{ name: string; dir: boolean }>> {
  for (const ref of [branch, 'HEAD']) {
    try {
      const { stdout } = await promisify(execFile)('git', ['-C', checkout, 'ls-tree', '-z', ref], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
      // 每项：<mode> <type> <sha>\t<name>
      return stdout.split('\0').filter(Boolean).map((line) => {
        const tab = line.indexOf('\t')
        return { name: line.slice(tab + 1), dir: line.slice(0, tab).split(' ')[1] === 'tree' }
      })
    } catch {
      // 分支名不存在时退到 HEAD；都读不到就不检查
    }
  }
  return []
}

function done(summary: string, kind: 'config' | 'agent' | 'skill', name?: string): LeadToolResult {
  const target = kind === 'config' ? 'kind="config"' : `kind="${kind}" ${kind === 'skill' ? 'name' : 'role'}="${name}"`
  return success(summary, {}, ['只影响之后启动的运行', `撤回：takt_config action="history" ${target}，再 rollback 到上一版（先征得同意）`])
}
