import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { assertNoSymlinks, parseFrontmatter, type AgentProfile } from '@taktflow/core'
import type { ContentBlock, JsonValue, SkillRegistration, ToolDefinition } from './dsh-types.js'
import type { SpaceHandle } from './types.js'

/** dsh 的 skill 名规则；角色声明与 SKILL.md frontmatter 都必须满足。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 角色 skill 的冻结快照。
 *
 * 只保留渲染所需字段；`path` 相对空间根，供审计与错误信息使用，不写绝对路径。
 */
export interface RoleSkillSnapshot {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly path: string
}

/** 角色名 → 本次运行冻结的技能快照。 */
export type RoleSkillSnapshots = Record<string, readonly RoleSkillSnapshot[]>

function skillFailure(message: string, cause?: unknown): Error {
  return new Error(`角色 skill 加载失败：${message}`, cause === undefined ? undefined : { cause })
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 从空间技能目录加载本次运行选中的角色技能。
 *
 * 只接受 `stores.paths.skills/<name>/SKILL.md`；目录名、frontmatter name 与声明
 * 必须一致，任何符号链接、越界或缺失都明确失败，不能静默跳过。
 * 返回的对象与数组已冻结，作为 preset 配置和 cfgHash 的稳定输入。
 */
export async function loadRoleSkills(
  space: SpaceHandle,
  profiles: Record<string, AgentProfile>,
): Promise<RoleSkillSnapshots> {
  const selected = new Set<string>()
  for (const profile of Object.values(profiles)) for (const name of profile.skills) selected.add(name)
  // 角色名也是外部输入（如 `__proto__`）；用无原型字典避免改原型或丢失自身键。
  const result: RoleSkillSnapshots = Object.create(null) as RoleSkillSnapshots
  if (selected.size === 0) {
    for (const role of Object.keys(profiles)) result[role] = Object.freeze([])
    return Object.freeze(result)
  }
  const declaredRoot = space.stores.paths.skills
  let root: string
  try {
    root = await realpath(declaredRoot)
  } catch (error) {
    throw skillFailure(`技能目录不可用：${declaredRoot}`, error)
  }
  if (!within(space.root, root)) throw skillFailure(`技能目录不在空间根内：${declaredRoot}`)
  const cache = new Map<string, RoleSkillSnapshot>()
  for (const [role, profile] of Object.entries(profiles)) {
    const names = [...new Set(profile.skills)]
    const skills: RoleSkillSnapshot[] = []
    for (const name of names) {
      if (!SKILL_NAME.test(name)) throw skillFailure(`角色 ${role} 声明了非法技能名：${name}`)
      let snapshot = cache.get(name)
      if (snapshot === undefined) {
        snapshot = await loadOneSkill(root, space.root, name, role)
        cache.set(name, snapshot)
      }
      skills.push(snapshot)
    }
    result[role] = Object.freeze(skills)
  }
  return Object.freeze(result)
}

async function loadOneSkill(
  skillsRoot: string,
  spaceRoot: string,
  name: string,
  role: string,
): Promise<RoleSkillSnapshot> {
  const directory = path.join(skillsRoot, name)
  const file = path.join(directory, 'SKILL.md')
  try {
    await assertNoSymlinks(skillsRoot, file)
  } catch (error) {
    throw skillFailure(`技能 ${name}（角色 ${role}）的路径包含符号链接或越界：${path.relative(spaceRoot, file)}`, error)
  }
  let resolved: string
  try {
    resolved = await realpath(file)
  } catch (error) {
    throw skillFailure(`角色 ${role} 需要的技能 ${name} 不存在：${path.relative(spaceRoot, file)}`, error)
  }
  if (!within(skillsRoot, resolved)) throw skillFailure(`技能 ${name} 的实际路径不在技能目录内：${path.relative(spaceRoot, resolved)}`)
  const info = await stat(resolved)
  if (!info.isFile()) throw skillFailure(`技能 ${name} 的 SKILL.md 不是普通文件：${path.relative(spaceRoot, resolved)}`)
  let parsed: { data: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter(await readFile(resolved, 'utf8'))
  } catch (error) {
    throw skillFailure(`技能 ${name} 的 frontmatter 无效：${path.relative(spaceRoot, resolved)}`, error)
  }
  const declaredName = textField(parsed.data, 'name')
  if (declaredName !== name) {
    throw skillFailure(`技能 ${name} 的 frontmatter name 必须等于目录名（实际：${declaredName ?? '(缺失)'}）`)
  }
  const description = textField(parsed.data, 'description')
  if (description === undefined) throw skillFailure(`技能 ${name} 缺少非空 description`)
  const whenToUse = textField(parsed.data, 'whenToUse')
  if (parsed.data.whenToUse !== undefined && whenToUse === undefined) {
    throw skillFailure(`技能 ${name} 的 whenToUse 必须是非空字符串`)
  }
  const content = parsed.body.trim()
  if (content === '') throw skillFailure(`技能 ${name} 的正文为空`)
  const relative = path.relative(spaceRoot, resolved).split(path.sep).join('/')
  if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw skillFailure(`技能 ${name} 的路径不在空间根内：${resolved}`)
  }
  return Object.freeze({
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    content,
    path: relative,
  })
}

/** 角色局部 `skill` 工具：只服务冻结快照，绝不查全局 registry。 */
export function createRoleSkillTool(snapshots: readonly RoleSkillSnapshot[]): ToolDefinition {
  const names = snapshots.map((skill) => skill.name)
  return {
    name: 'skill',
    description: names.length === 0
      ? '当前角色没有可选技能。'
      : `读取当前角色已冻结的技能说明。只提供本角色选中的技能：${names.join('、')}。`,
    // 原生 ctx.tools.register 直接收 raw JSON Schema；DSL 的逐属性 required 不适用。
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '当前角色技能列表中的精确技能名。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      // output.schema 是原生 JSON Schema：required 是对象级字符串数组，
      // 不是 parameters 里的逐属性 `required: true`（0.2.2-rc.1 原生校验）。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['name', 'content'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args) {
      const requested = args !== null && typeof args === 'object' && 'name' in args
        ? (args as { name?: unknown }).name : undefined
      if (typeof requested !== 'string' || requested.trim() === '') throw new Error('name 必须是非空技能名')
      const skill = snapshots.find((item) => item.name === requested.trim())
      if (skill === undefined) {
        throw new Error(`技能 "${requested}" 不在当前角色范围内；可用：${names.join('、') || '(无)'}`)
      }
      return { name: skill.name, content: skill.content }
    },
  }
}

function renderSkillContent(value: JsonValue): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const content = (value as Record<string, JsonValue>).content
    if (typeof content === 'string') return content
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** 把快照转成 dsh skill 注册项；source 明确标记为角色运行期技能。 */
export function roleSkillRegistration(snapshot: RoleSkillSnapshot): SkillRegistration {
  return {
    name: snapshot.name,
    description: snapshot.description,
    ...(snapshot.whenToUse === undefined ? {} : { whenToUse: snapshot.whenToUse }),
    content: snapshot.content,
    source: 'custom',
    provider: 'taktflow/role',
  }
}

/** 供测试/执行层复用的文本块类型别名，避免直接依赖 dsh 内部渲染实现。 */
export type RoleSkillContentBlock = ContentBlock
