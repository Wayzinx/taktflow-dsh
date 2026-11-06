import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentProfile } from '@taktflow/core'
import { createRoleSkillTool, loadRoleSkills, roleSkillRegistration } from './role-skills.js'
import type { SpaceHandle } from './types.js'

let root: string
let outside: string
let skillsDir: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-role-skills-')))
  outside = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-role-skills-outside-')))
  skillsDir = path.join(root, '.takt', 'skills')
  await mkdir(skillsDir, { recursive: true })
})
afterEach(async () => {
  await Promise.all([root, outside].map((dir) => rm(dir, { recursive: true, force: true })))
})

function spaceFor(dir = skillsDir): SpaceHandle {
  return { root, stores: { paths: { skills: dir } } } as unknown as SpaceHandle
}

function profile(skills: string[], role = 'dev'): AgentProfile {
  return {
    role, title: role, description: role, instructions: role,
    harness: { harness: 'dsh-host' }, skills, writeScope: [],
  }
}

async function writeSkill(name: string, frontmatter = `name: ${name}\ndescription: ${name} 的说明`, body = `# ${name}\n正文`) {
  const dir = path.join(skillsDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

describe('角色 skill 加载与冻结', () => {
  it('只加载声明技能，按声明顺序去重，内容冻结且路径相对空间根', async () => {
    await writeSkill('coding')
    await writeSkill('review', 'name: review\ndescription: 评审说明\nwhenToUse: 需要评审时')
    const snapshots = await loadRoleSkills(spaceFor(), { dev: profile(['review', 'coding', 'review']) })
    const dev = snapshots.dev!
    expect(dev.map((skill) => skill.name)).toEqual(['review', 'coding'])
    expect(dev[0]).toMatchObject({
      name: 'review', description: '评审说明', whenToUse: '需要评审时', path: '.takt/skills/review/SKILL.md',
    })
    expect(dev[0]!.content).toContain('# review')
    expect(Object.isFrozen(snapshots)).toBe(true)
    expect(Object.isFrozen(dev)).toBe(true)
    expect(Object.isFrozen(dev[0])).toBe(true)
    expect(() => { (dev as unknown as Array<{ name: string }>).push({ name: 'extra' }) }).toThrow()
  })

  it('不同角色声明同一技能时复用同一个冻结快照', async () => {
    await writeSkill('coding')
    const snapshots = await loadRoleSkills(spaceFor(), {
      dev: profile(['coding'], 'dev'), reviewer: profile(['coding'], 'reviewer'),
    })
    expect(snapshots.dev![0]).toBe(snapshots.reviewer![0])
  })

  it('没有声明技能时不访问技能目录，空数组仍冻结', async () => {
    const snapshots = await loadRoleSkills(spaceFor(path.join(root, 'missing')), { dev: profile([]) })
    expect(snapshots.dev).toEqual([])
    expect(Object.isFrozen(snapshots.dev)).toBe(true)
    expect(snapshots.dev).toBeDefined()
  })

  it('角色名使用无原型字典，__proto__ 等自定义角色名不改变结果对象', async () => {
    await writeSkill('coding')
    const profiles = Object.create(null) as Record<string, AgentProfile>
    profiles['__proto__'] = profile(['coding'], '__proto__')
    profiles['constructor'] = profile(['coding'], 'constructor')
    const snapshots = await loadRoleSkills(spaceFor(), profiles)
    expect(Object.getPrototypeOf(snapshots)).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(snapshots, '__proto__')).toBe(true)
    expect(snapshots['__proto__']![0]!.name).toBe('coding')
    expect(snapshots['constructor']![0]!.name).toBe('coding')
    expect(Object.isFrozen(snapshots)).toBe(true)
  })

  it.each([
    ['缺失技能', async () => {}, ['coding'], '不存在'],
    ['非法技能名', async () => {}, ['Bad_Name'], '非法技能名'],
    ['frontmatter 名字不一致', async () => { await writeSkill('coding', 'name: other\ndescription: 说明') }, ['coding'], '必须等于目录名'],
    ['缺少 description', async () => { await writeSkill('coding', 'name: coding') }, ['coding'], '缺少非空 description'],
    ['空正文', async () => { await writeSkill('coding', 'name: coding\ndescription: 说明', '   ') }, ['coding'], '正文为空'],
  ])('%s 明确失败，不静默跳过', async (_label, prepare, skills, message) => {
    await prepare()
    await expect(loadRoleSkills(spaceFor(), { dev: profile(skills) })).rejects.toThrow(message)
  })

  it('声明 taktflow 但没有对应空间文件时明确失败，不回退内置内容', async () => {
    await expect(loadRoleSkills(spaceFor(), { dev: profile(['taktflow']) })).rejects.toThrow('不存在')
  })

  it('技能目录或 SKILL.md 含符号链接时拒绝', async () => {
    await mkdir(path.join(outside, 'external'), { recursive: true })
    await writeFile(path.join(outside, 'external', 'SKILL.md'), '---\nname: external\ndescription: 外部\n---\n正文')
    await symlink(path.join(outside, 'external'), path.join(skillsDir, 'external'))
    await expect(loadRoleSkills(spaceFor(), { dev: profile(['external']) })).rejects.toThrow('符号链接')

    await mkdir(path.join(skillsDir, 'linked'), { recursive: true })
    await writeFile(path.join(outside, 'linked.md'), '---\nname: linked\ndescription: 链接\n---\n正文')
    await symlink(path.join(outside, 'linked.md'), path.join(skillsDir, 'linked', 'SKILL.md'))
    await expect(loadRoleSkills(spaceFor(), { dev: profile(['linked']) })).rejects.toThrow('符号链接')
  })

  it('技能目录不在空间根内时明确失败', async () => {
    await expect(loadRoleSkills(spaceFor(path.join(outside, 'skills')), { dev: profile(['coding']) }))
      .rejects.toThrow('技能目录不可用')
  })
})

describe('角色局部 skill 工具', () => {
  const snapshots = [{
    name: 'coding', description: '编码约定', whenToUse: '写代码前', content: '# 编码\n只改授权范围', path: '.takt/skills/coding/SKILL.md',
  }] as const

  it('只服务快照内的技能，未知/全局技能名一律拒绝', async () => {
    const tool = createRoleSkillTool(snapshots)
    expect(tool.name).toBe('skill')
    // 原生 register 直接收 raw JSON Schema，而不是 defineTool 的逐属性 DSL。
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { name: { type: 'string', description: '当前角色技能列表中的精确技能名。' } },
      required: ['name'],
      additionalProperties: false,
    })
    // 原生 output.schema 的 required 是对象级字符串数组，不能沿用 parameters 的逐属性写法。
    expect(tool.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    })
    await expect(tool.execute({ name: 'coding' }, {} as never)).resolves.toEqual({ name: 'coding', content: '# 编码\n只改授权范围' })
    await expect(tool.execute({ name: 'global-other-role' }, {} as never)).rejects.toThrow('不在当前角色范围内')
    await expect(tool.execute({ name: '' }, {} as never)).rejects.toThrow('name 必须是非空技能名')
  })

  it('渲染为文本内容，注册项标记角色来源', () => {
    const tool = createRoleSkillTool(snapshots)
    expect(tool.output.render({}, { name: 'coding', content: '# 编码' })).toEqual([{ type: 'text', text: '# 编码' }])
    expect(roleSkillRegistration(snapshots[0])).toMatchObject({
      name: 'coding', description: '编码约定', whenToUse: '写代码前', source: 'custom', provider: 'taktflow/role',
    })
  })
})

type RoleSkillSnapshotMutable = { name: string }
