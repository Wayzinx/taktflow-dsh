import { createHash } from 'node:crypto'
import type { AgentProfile } from '@taktflow/core'
import type { AgentPresetDefinition, AgentPresetDisposer, HostContext } from './dsh-types.js'
import { loadRunProfiles } from './run-runtime.js'
import { TaktToolError, type RolePresetHandle, type RolePresets, type SpaceHandle } from './types.js'

/** Lead preset 的固定 id；cordis.patch.yml 与客户端选择器共用。 */
export const LEAD_PRESET_ID = 'taktflow'

type Variant = { readOnly: boolean; allowBash: boolean }
type Registry = HostContext['agentPresets']
interface Entry { references: number; dispose?: AgentPresetDisposer }
interface SharedState { entries: Map<string, Entry>; tail: Promise<void> }
// Cordis 每次 get(service) 会创建新的 traceable Proxy，不能用服务代理身份作缓存键。
// 来源：@deepseek-ai/cordis/src/utils.ts 的 getTraceable/createTraceable。
const sharedOwners = new WeakMap<HostContext, SharedState>()

/** 对普通 JSON 配置排序后计算摘要；数组顺序属于配置。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 8)
}

function serial<T>(state: SharedState, operation: () => Promise<T>): Promise<T> {
  const result = state.tail.then(operation, operation)
  state.tail = result.then(() => {}, () => {})
  return result
}

/**
 * 节点开始前 acquire，最后一个节点完成后注销动态声明。
 * 服务缺失、角色缺失或组合损坏都明确失败，不退回宽权限 preset。
 * dsh 没有隐藏声明的字段，租用期间此声明会进入模式列表。
 */
export class DshRolePresets implements RolePresets {
  private readonly profiles?: Record<string, AgentProfile>

  constructor(private readonly ctx?: HostContext, options: { profiles?: Record<string, AgentProfile> } = {}) {
    this.profiles = options.profiles === undefined ? undefined : structuredClone(options.profiles)
  }

  /** RunManager 在运行开始时绑定档案快照；后续节点不重新读取角色文件。 */
  fork(profiles: Record<string, AgentProfile>): DshRolePresets {
    return new DshRolePresets(this.ctx, { profiles })
  }

  async acquire(space: SpaceHandle, role: string, variant: Variant): Promise<RolePresetHandle> {
    if (variant.allowBash) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'P0 角色不支持 shell（allowBash）')
    const registry = this.ctx?.get<Registry>('agentPresets')
    if (registry === undefined || typeof registry.list !== 'function') {
      throw new TaktToolError('TAKT_UNSUPPORTED_NODE', 'dsh agentPresets 服务不可用，无法创建角色 Agent', '请加载 agent-preset-registry 后重试')
    }
    const profiles = this.profiles ?? await loadRunProfiles(space)
    const profile = profiles[role]
    if (profile === undefined || profile.role !== role) {
      throw new TaktToolError('TAKT_FORBIDDEN_FOR_LEAD', `空间没有可用的角色档案：${role}`)
    }
    if (profile.allowBash) throw new TaktToolError('TAKT_UNSUPPORTED_NODE', `P0 角色 ${role} 的 allowBash 必须为 false`)
    // persona 会插值 {{变量}}；角色正文在下方不插值的 role 提示段中原样呈现。
    const identity = `${profile.title}（${role}）`.replaceAll('{{', '{ {').replaceAll('}}', '} }')
    const prefix = `你是 Taktflow 的 ${identity} 角色，遵守本次任务的角色说明和权限范围。`
    // 配置键来源：各官方包 README 的 Configuration；组合是完整白名单。
    const plugins: AgentPresetDefinition['plugins'] = [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { write: !variant.readOnly, edit: !variant.readOnly } },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'taktflow-role', name: 'taktflow/role', config: {
        role, spaceRoot: space.root, title: profile.title, description: profile.description,
        instructions: profile.instructions, skills: [...profile.skills], readOnly: variant.readOnly,
      } },
    ]
    const cfgHash = hash({ profile, plugins, variant })
    const id = `takt-${hash(space.root)}-${role}-${cfgHash}`
    let state = sharedOwners.get(this.ctx!)
    if (state === undefined) {
      state = { entries: new Map(), tail: Promise.resolve() }
      sharedOwners.set(this.ctx!, state)
    }
    const shared = state
    await serial(shared, async () => {
      const known = shared.entries.get(id)
      if (known !== undefined) { known.references++; return }
      const existing = (await registry.list!()).find((item) => item.id === id)
      let dispose: AgentPresetDisposer | undefined
      try {
        if (existing === undefined) dispose = await registry.register({ id, name: `${profile.title}（执行中）`, plugins })
        const current = registry.resolve === undefined
          ? (await registry.list!()).find((item) => item.id === id)
          : await registry.resolve(id)
        if (current === undefined || current.broken !== undefined) {
          throw new Error(`角色 preset 不可用：${id}${current?.broken ? `；${current.broken}` : ''}`)
        }
        shared.entries.set(id, { references: 1, dispose })
      } catch (error) {
        if (dispose !== undefined) await dispose()
        throw error
      }
    })
    let released: Promise<void> | undefined
    return {
      id, cfgHash,
      // 冻结接口允许返回 void；实际返回 Promise，执行器等待注销完成。
      release: () => {
        if (released !== undefined) return released
        released = serial(shared, async () => {
          const entry = shared.entries.get(id)
          if (entry === undefined) return
          entry.references--
          if (entry.references !== 0) return
          try { await entry.dispose?.() } finally { shared.entries.delete(id) }
        })
        // void 调用方可能不等待；旁路记录不改变返回 Promise 的失败语义。
        void released.catch(() => { this.ctx?.logger?.warn(`角色 preset 注销失败：${id}`) })
        return released
      },
    }
  }
}

/** 兼容骨架的旧导出；实际行为由 DshRolePresets 提供。 */
export class PlaceholderRolePresets extends DshRolePresets {}
