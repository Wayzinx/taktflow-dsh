import { describe, expect, it } from 'vitest'
import { FakeHostContext } from '../testing/fake-ctx.js'
import type { TaktflowService } from '../types.js'
import { apply as applyLead, inject as leadInject, name as leadName, type LeadContext } from './index.js'
import { LEAD_TOOL_NAMES } from './tools.js'
import { apply as applyRole, inject as roleInject, name as roleName, type RoleContext } from '../role/index.js'

function contextWithService(): FakeHostContext & { taktflow: TaktflowService } {
  const ctx = new FakeHostContext()
  return Object.assign(ctx, { taktflow: {} as TaktflowService })
}

describe('taktflow/lead 行', () => {
  it('inject 只包含宿主门面、工具、提示词与技能', () => {
    expect(leadName).toBe('taktflow/lead')
    expect(leadInject).toEqual(['taktflow', 'tools', 'systemPrompt', 'skills'])
  })

  it('apply 注册一段提示词和一个 skill，dispose 后移除', async () => {
    const ctx = contextWithService()
    applyLead(ctx as unknown as LeadContext)

    expect(ctx.promptSections.map((section) => section.name)).toEqual(['taktflow:lead'])
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['taktflow'])
    expect(ctx.registeredSkills[0]?.source).toBe('bundled')

    await ctx.dispose()
    expect(ctx.promptSections).toHaveLength(0)
    expect(ctx.registeredSkills).toHaveLength(0)
  })

  it('Lead 工具清单是准确的 6 个，且不暴露审批回答', () => {
    expect(LEAD_TOOL_NAMES).toEqual([
      'takt_status',
      'takt_requirement',
      'takt_artifact',
      'takt_run',
      'takt_trace',
      'takt_ask_human',
    ])
    expect(LEAD_TOOL_NAMES).not.toContain('taktflow_approval_answer')
  })
})

describe('taktflow/role 行', () => {
  it('inject 不包含 tools，避免角色行自己注册工具', () => {
    expect(roleName).toBe('taktflow/role')
    expect(roleInject).toEqual(['taktflow', 'systemPrompt', 'skills'])
  })

  it('apply 注册角色提示词与同名 taktflow 技能', async () => {
    const ctx = contextWithService()
    applyRole(ctx as unknown as RoleContext)

    expect(ctx.promptSections.map((section) => section.name)).toEqual(['taktflow:role'])
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['taktflow'])
    expect(ctx.registeredSkills[0]?.source).toBe('bundled')
    expect(String(ctx.promptSections[0]?.text)).toContain('script 节点')
  })
})
