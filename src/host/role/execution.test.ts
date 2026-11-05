import { describe, expect, it } from 'vitest'
import { apply, type RoleContext } from './index.js'
import { FakeHostContext } from '../testing/fake-ctx.js'

describe('角色行运行配置', () => {
  it('提示词来自本次角色 config，保持 literal 内容并可卸载', async () => {
    const ctx = new FakeHostContext()
    apply(ctx as unknown as RoleContext, {
      role: 'dev', title: '开发', spaceRoot: 'space-fixture', readOnly: true,
      instructions: '保持 {{example}} 原样', skills: ['coding', 'review'],
    })
    expect(ctx.promptSections[0]).toMatchObject({ interpolate: false })
    expect(ctx.promptSections[0]!.text).toContain('开发（dev）')
    expect(ctx.promptSections[0]!.text).toContain('只读')
    expect(ctx.promptSections[0]!.text).toContain('保持 {{example}} 原样')
    expect(ctx.promptSections[0]!.text).toContain('coding、review')
    await ctx.dispose()
    expect(ctx.promptSections).toHaveLength(0)
    expect(ctx.registeredSkills).toHaveLength(0)
  })
})
