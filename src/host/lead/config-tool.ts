import { createApiCore, ApiError, type ApiCore, type WriteOp } from '@taktflow/server'
import type { Actor, ProjectStores, SpaceSettings, SpaceUpgradePlan, WorkflowDocument } from '@taktflow/core'
import { BUNDLED_AGENT_FILES, BUNDLED_WORKFLOW_FILES } from '../../templates/bundled.js'
import type { DefineToolOptions, ToolExecutionContext } from '../dsh-types.js'
import { TaktToolError, type SpaceHandle } from '../types.js'
import {
  OUTPUT_SCHEMA, asRecord, failure, optionalString, renderResult, requireRootAgent, requiredString, success, toFailure,
  type LeadToolResult, type ToolDeps,
} from './tools.js'

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
  'upgrade', 'history', 'rollback',
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
      '何时不用：用户没要求就不要改；需求产物用 takt_artifact。删除 / 升级 / 回滚先 takt_ask_human 确认，再带 confirmed=true。',
      '每次修改都要 reason（引用用户原话）；结果里会给出怎么撤回。流程节点属性（评审轮次、角色、提示词等）用 workflow_read 读源码后 workflow_edit 整文件替换。',
      '自测配置（selftest）只有 timeoutMs（1000..3600000 毫秒）和 allowedCommands（命令白名单）两个字段，没有 selftest.commands；不配置命令时默认用 environment.testCommand，quick-fix 固定 npm test，其它流程回退 package.json 的 test 脚本，不需要先配置命令才能自测。',
      '示例：{"action":"show"}',
      '示例：{"action":"set_config","patch":{"autonomy":"checkpoints"},"reason":"用户：评审签字我自己来"}',
      '示例：{"action":"save_role","role":"security","create":true,"copyFrom":"reviewer","profile":{"title":"安全评审"},"reason":"用户：加一个安全评审"}',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: [...ACTIONS], required: true, description: '要做的事。' },
      reason: { type: 'string', description: '写操作必填：为什么改（引用用户原话）。' },
      confirmed: { type: 'boolean', description: '删除 / 回滚 / 执行升级时必填 true：表示已经用 takt_ask_human 得到用户确认。' },
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
      from: { type: 'string', description: 'workflow_create：复制现有流程的 id。' },
      default: { type: 'boolean', description: 'workflow_meta：设为默认流程。' },
      source: { type: 'string', description: 'workflow_edit：完整的新源码。' },
      baseRev: { type: 'string', description: 'workflow_edit：workflow_read 返回的 rev。' },
      kind: { type: 'string', enum: ['agent', 'skill', 'config'], description: 'history / rollback：哪类文件。' },
      rev: { type: 'string', description: 'rollback：要恢复到的修订（history 返回）。' },
      dryRun: { type: 'boolean', description: 'upgrade：只看要做什么，默认 true。' },
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
        return await run(apiCore(deps), space, actor, action, args)
      } catch (error) {
        if (error instanceof ApiError) return failure(error.status === 409 ? 'TAKT_RUN_BUSY' : 'TAKT_INVALID_INPUT', error.message, '按提示调整后重试；先 show 看现状。')
        return toFailure(error)
      }
    },
  }
}

async function run(api: ApiCore, space: SpaceHandle, actor: Actor, action: Action, args: Record<string, unknown>): Promise<LeadToolResult> {
  const read = (op: Parameters<ApiCore['read']>[1], params: Record<string, string | undefined> = {}) => api.read(space.stores, op, params, actor)
  const write = (op: WriteOp, params: Record<string, string>, body: Record<string, unknown>) => api.write(space.stores, op, params, body, actor)
  const reason = () => requiredString(args, 'reason')
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
      return success('当前空间配置', {
        config: s.config,
        workflows: s.workflows.map((w) => ({ id: w.id, title: w.title, default: w.default })),
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
      await write('workflow.create', {}, { id, ...(args.title === undefined ? {} : { title: args.title }), from: template ? { template } : { workflow: from }, reason: reason() })
      return success(`已新建流程 ${id}`, { id }, [`takt_config action="workflow_read" id="${id}"`, '撤回：takt_config action="workflow_delete"（先征得同意）'])
    }
    case 'workflow_meta': {
      const id = requiredString(args, 'id')
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
      const result = await write('workflow.source.replace', { id }, { baseRev: requiredString(args, 'baseRev'), source: requiredString(args, 'source'), reason: reason() }) as WorkflowDocument | { error: string; diagnostics?: Array<{ severity: string; message: string; line?: number }> }
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
    case 'rollback': {
      const kind = requiredString(args, 'kind')
      const name = optionalString(args, kind === 'skill' ? 'name' : 'role')
      await write('space.file.rollback', { kind, ...(name === undefined ? {} : { name }) }, { rev: requiredString(args, 'rev'), reason: reason() })
      return success('已恢复到指定版本', {}, ['恢复本身也记了一条修改记录'])
    }
  }
}

function done(summary: string, kind: 'config' | 'agent' | 'skill', name?: string): LeadToolResult {
  const target = kind === 'config' ? 'kind="config"' : `kind="${kind}" ${kind === 'skill' ? 'name' : 'role'}="${name}"`
  return success(summary, {}, ['只影响之后启动的运行', `撤回：takt_config action="history" ${target}，再 rollback 到上一版（先征得同意）`])
}
