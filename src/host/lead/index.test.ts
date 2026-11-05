import { describe, expect, it, vi } from 'vitest'
import type { DefineTool, ToolDefinition } from '../dsh-types.js'
import { FakeHostContext } from '../testing/fake-ctx.js'
import type { TaktflowService } from '../types.js'
import {
  apply as applyLead,
  createLeadServices,
  inject as leadInject,
  name as leadName,
  type LeadContext,
} from './index.js'
import { LEAD_TOOL_NAMES } from './tools.js'
import { LEAD_PROMPT_SECTION } from './prompt.js'
import { LEAD_SKILL } from './skill.js'
import { apply as applyRole, inject as roleInject, name as roleName, type RoleContext } from '../role/index.js'

const { loadDefineToolMock } = vi.hoisted(() => ({ loadDefineToolMock: vi.fn() }))
vi.mock('../dsh-runtime.js', () => ({ loadDefineTool: loadDefineToolMock }))

/** 只回传 options 的 defineTool 替身；真实校验由 dsh 的 defineTool 负责。 */
const defineToolStub: DefineTool = (options) => options as unknown as ToolDefinition

function toolsEffect(ctx: FakeHostContext) {
  const effect = ctx.effects.find((entry) => entry.label === 'taktflow lead tools')
  if (effect === undefined) throw new Error('没有注册 taktflow lead tools effect')
  return effect
}

function contextWithService(): FakeHostContext & { taktflow: TaktflowService } {
  const ctx = new FakeHostContext()
  return Object.assign(ctx, { taktflow: {} as TaktflowService })
}

describe('taktflow/lead 行', () => {
  it('inject 只包含宿主门面、工具、提示词、技能与 agents', () => {
    expect(leadName).toBe('taktflow/lead')
    expect(leadInject).toEqual(['taktflow', 'tools', 'systemPrompt', 'skills', 'agents'])
  })

  it('用户已要求启动时，提示词与 skill 要求 create 后同回合继续 start', () => {
    expect(LEAD_PROMPT_SECTION.text).toContain('同一回合继续 start')
    expect(LEAD_SKILL.content).toContain('同一回合继续 `takt_run start`')
  })

  it('apply 注册一段提示词、一个 skill 和六个工具，dispose 后移除', async () => {
    const ctx = contextWithService()
    applyLead(ctx as unknown as LeadContext, { defineTool: defineToolStub })

    expect(ctx.promptSections.map((section) => section.name)).toEqual(['taktflow:lead'])
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['taktflow'])
    expect(ctx.registeredSkills[0]?.source).toBe('bundled')
    expect(ctx.toolDefinitions.map((tool) => tool.name)).toEqual([...LEAD_TOOL_NAMES])

    await ctx.dispose()
    expect(ctx.promptSections).toHaveLength(0)
    expect(ctx.registeredSkills).toHaveLength(0)
    expect(ctx.toolDefinitions).toHaveLength(0)
  })

  it('正式路径等 dsh-tools 加载完成后再注册，卸载时等待异步 disposer', async () => {
    loadDefineToolMock.mockResolvedValue(defineToolStub)
    const ctx = contextWithService()
    let disposed = false
    ctx.tools.register = (definition) => {
      ctx.toolDefinitions.push(definition)
      return async () => {
        await Promise.resolve()
        disposed = true
        ctx.toolDefinitions.splice(ctx.toolDefinitions.indexOf(definition), 1)
      }
    }
    applyLead(ctx as unknown as LeadContext)
    await toolsEffect(ctx).ready

    expect(ctx.toolDefinitions.map((tool) => tool.name)).toEqual([...LEAD_TOOL_NAMES])
    await ctx.dispose()
    expect(disposed).toBe(true)
    expect(ctx.toolDefinitions).toHaveLength(0)
  })

  it('dsh-tools 加载失败时显式拒绝，而不是宣称 Lead 已加载却缺工具', async () => {
    loadDefineToolMock.mockRejectedValue(new Error('缺少 @deepseek-ai/dsh-tools'))
    const ctx = contextWithService()
    applyLead(ctx as unknown as LeadContext)

    await expect(toolsEffect(ctx).ready).rejects.toThrow('缺少 @deepseek-ai/dsh-tools')
    expect(ctx.toolDefinitions).toHaveLength(0)
    // 提示词与技能仍保留，失败边界只影响工具注册。
    expect(ctx.promptSections).toHaveLength(1)
    expect(ctx.registeredSkills).toHaveLength(1)
    // 假 ctx 会把 effect 的失败汇总到 dispose；正式宿主在加载阶段就会看到同一个错误。
    await expect(ctx.dispose()).rejects.toThrow('缺少 @deepseek-ai/dsh-tools')
  })

  it('注册到一半失败时卸载已注册工具，并暴露原始错误', async () => {
    const ctx = contextWithService()
    let calls = 0
    const disposed: string[] = []
    ctx.tools.register = (definition) => {
      calls += 1
      if (calls === 3) throw new Error('第 3 个工具注册失败')
      ctx.toolDefinitions.push(definition)
      return () => {
        disposed.push(definition.name)
        ctx.toolDefinitions.splice(ctx.toolDefinitions.indexOf(definition), 1)
      }
    }
    applyLead(ctx as unknown as LeadContext, { defineTool: defineToolStub })

    await expect(toolsEffect(ctx).ready).rejects.toThrow('第 3 个工具注册失败')
    // 前两个已注册工具必须实际执行 disposer，而不是只清空数组。
    expect(disposed).toEqual([LEAD_TOOL_NAMES[1], LEAD_TOOL_NAMES[0]])
    expect(ctx.toolDefinitions).toHaveLength(0)
    await expect(ctx.dispose()).rejects.toThrow('第 3 个工具注册失败')
  })

  it('异步清理失败会汇总抛给宿主，不静默吞掉', async () => {
    const ctx = contextWithService()
    let calls = 0
    ctx.tools.register = (definition) => {
      calls += 1
      const index = calls
      ctx.toolDefinitions.push(definition)
      return async () => {
        await Promise.resolve()
        if (index === 2) throw new Error('第二个工具卸载失败')
      }
    }
    applyLead(ctx as unknown as LeadContext, { defineTool: defineToolStub })
    await expect(ctx.dispose()).rejects.toThrow('第二个工具卸载失败')
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

  it('re-export 服务工厂，方便宿主接线', () => {
    expect(typeof createLeadServices).toBe('function')
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
