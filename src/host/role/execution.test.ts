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

  it('按冻结快照注册角色技能并挂载局部 skill 工具，卸载后清理', async () => {
    const ctx = new FakeHostContext()
    const snapshot = {
      name: 'coding', description: '编码约定', whenToUse: '写代码前',
      content: '# 编码\n只改授权范围', path: '.takt/skills/coding/SKILL.md',
    }
    apply(ctx as unknown as RoleContext, {
      role: 'dev', title: '开发', skills: ['coding'], skillSnapshot: [snapshot],
    })
    // 只注册角色声明技能；不再额外注册内置 taktflow。
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['coding'])
    expect(ctx.registeredSkills.find((skill) => skill.name === 'coding')).toMatchObject({
      description: '编码约定', whenToUse: '写代码前', content: '# 编码\n只改授权范围', source: 'custom', provider: 'taktflow/role',
    })
    expect(ctx.toolDefinitions.map((tool) => tool.name)).toEqual(['skill'])
    const tool = ctx.toolDefinitions[0]!
    await expect(tool.execute({ name: 'coding' }, {} as never)).resolves.toEqual({ name: 'coding', content: '# 编码\n只改授权范围' })
    await expect(tool.execute({ name: 'taktflow' }, {} as never)).rejects.toThrow('不在当前角色范围内')
    await ctx.dispose()
    expect(ctx.registeredSkills).toHaveLength(0)
    expect(ctx.toolDefinitions).toHaveLength(0)
  })

  it('空 skills 角色仍挂空白名单局部工具，不继承全局 skill 目录', async () => {
    const ctx = new FakeHostContext()
    // 模拟宿主全局 provider 已注册的技能；角色不得把它当成可见技能。
    ctx.skills.register({
      name: 'global-forbidden', description: '全局技能', content: '全局正文', source: 'bundled',
    })
    apply(ctx as unknown as RoleContext, { role: 'analyst', skills: [] })
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['global-forbidden'])
    expect(ctx.toolDefinitions.map((tool) => tool.name)).toEqual(['skill'])
    const tool = ctx.toolDefinitions[0]!
    expect(tool.description).not.toContain('global-forbidden')
    for (const name of ['global-forbidden', 'taktflow', 'coding']) {
      await expect(tool.execute({ name }, {} as never)).rejects.toThrow('不在当前角色范围内')
    }
    await ctx.dispose()
    expect(ctx.toolDefinitions).toHaveLength(0)
  })

  it('用户技能与内置 taktflow 同名时使用用户内容，不换成内部默认', async () => {
    const ctx = new FakeHostContext()
    apply(ctx as unknown as RoleContext, {
      role: 'dev', skills: ['taktflow'],
      skillSnapshot: [{ name: 'taktflow', description: '用户技能', content: '用户正文', path: '.takt/skills/taktflow/SKILL.md' }],
    })
    expect(ctx.registeredSkills.map((skill) => skill.name)).toEqual(['taktflow'])
    expect(ctx.registeredSkills[0]).toMatchObject({ description: '用户技能', content: '用户正文' })
    const tool = ctx.toolDefinitions[0]!
    await expect(tool.execute({ name: 'taktflow' }, {} as never)).resolves.toEqual({ name: 'taktflow', content: '用户正文' })
    await ctx.dispose()
  })
})
