import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { assertRequirementId, type Actor, type RequirementId } from '@taktflow/core'
import { withFileLock } from '../../vendor/taktflow/packages/core/src/store/file-lock.js'
import { readJsonFile, toJsonText, writeFileAtomic } from '../../vendor/taktflow/packages/core/src/store/fs-utils.js'
import { notImplemented } from './errors.js'
import { TaktToolError } from './types.js'
import type { Bindings, Ownership, SpaceHandle } from './types.js'

/**
 * 需求 ↔ Lead 会话绑定表。
 *
 * 落盘位置 `.takt/dsh/bindings.json`；一个会话只能绑定一个需求，一个需求同一
 * 时刻只能绑定一个 Lead 会话。P0 不支持重新绑定：需求已被其它会话占用、或当前
 * 会话已绑定其它需求时直接抛 TAKT_NOT_BOUND，由人决定后续处理。
 *
 * 谁调用：Lead 工具的 create/bind，以及后续可能需要反查会话的模块。
 * 何时调用：需求群聊建立时；读取绑定不受租约限制，写入必须先拿到空间租约。
 * 失败语义：文件损坏按错误暴露，不能当成“没有绑定”；冲突不覆盖已有记录。
 */
export class FsBindings implements Bindings {
  private readonly ownership: Ownership

  constructor(ownership: Ownership) {
    this.ownership = ownership
  }

  async bind(
    space: SpaceHandle,
    requirementId: string,
    sessionId: string,
    by: Actor,
  ): Promise<void> {
    const rid = assertRequirementId(requirementId)
    const sid = assertSessionId(sessionId)
    assertHuman(by)

    const file = bindingsFile(space)
    await withFileLock(file, async () => {
      // 租约校验放在文件锁内、紧邻写入：避免校验通过后、真正写盘前被其它宿主抢走。
      await this.ownership.ensureLease(space)
      const state = await readBindingsFile(file)
      const byRequirement = state.bindings.find((entry) => entry.requirementId === rid)
      const bySession = state.bindings.find((entry) => entry.sessionId === sid)

      if (byRequirement !== undefined && byRequirement.sessionId !== sid) {
        throw new TaktToolError(
          'TAKT_NOT_BOUND',
          `需求 ${rid} 已绑定到另一个 Lead 会话`,
          'P0 不支持重新绑定；请新开一个 Lead 会话并新建需求，或等待人工整合处理。',
        )
      }
      if (bySession !== undefined && bySession.requirementId !== rid) {
        throw new TaktToolError(
          'TAKT_NOT_BOUND',
          `当前会话已绑定需求 ${bySession.requirementId}，不能再绑定 ${rid}`,
          '一个 Lead 会话只能绑定一个需求；请结束当前需求，或在新会话里绑定。',
        )
      }
      // 同一对（需求、会话）重复 bind 是幂等操作，不重复写记录。
      if (byRequirement !== undefined && bySession !== undefined) return

      state.bindings.push({
        requirementId: rid,
        sessionId: sid,
        by: cloneActor(by),
        boundAt: new Date().toISOString(),
      })
      await mkdir(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, toJsonText(state))
    })
  }

  async byRequirement(space: SpaceHandle, requirementId: string): Promise<string | undefined> {
    const rid = assertRequirementId(requirementId)
    const state = await readBindingsFile(bindingsFile(space))
    return state.bindings.find((entry) => entry.requirementId === rid)?.sessionId
  }

  async bySession(space: SpaceHandle, sessionId: string): Promise<string | undefined> {
    const sid = assertSessionId(sessionId)
    const state = await readBindingsFile(bindingsFile(space))
    return state.bindings.find((entry) => entry.sessionId === sid)?.requirementId
  }
}

/** 创建绑定表；ownership 用于在 bind 前确保空间租约由本宿主持有。 */
export function createBindings(deps: { ownership: Ownership }): Bindings {
  return new FsBindings(deps.ownership)
}

/**
 * 绑定对象 → 配置里代表的人。
 *
 * createLeadServices 创建绑定表时登记 config.user；Lead 工具按绑定对象取人，
 * 保证工具审计的 onBehalfOf 与绑定记录里的 by 是同一个人，且模型无法覆盖。
 *
 * 用 Symbol.for 记在对象上而不是模块级 WeakMap：宿主入口与 Lead 入口可能各自
 * 打包出一份模块闭包，模块级状态不共享；Symbol.for 是全局注册表，跨 bundle
 * 也能读到同一个键，且属性不可枚举、不会写进绑定文件。
 */
const BINDINGS_USER = Symbol.for('taktflow.host.bindings.user')

/** 登记绑定表对应的可信人；只由 createLeadServices 调用。 */
export function rememberBindingsUser(bindings: Bindings, user: string): void {
  Object.defineProperty(bindings, BINDINGS_USER, {
    value: user,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

/** 读取绑定表对应的可信人；未登记时返回 undefined，由调用方回退到系统用户。 */
export function bindingsUser(bindings: Bindings | undefined): string | undefined {
  // 测试或未接线的宿主可能没有绑定表；缺省回退到系统用户，不在这里抛错。
  if (typeof bindings !== 'object' || bindings === null) return undefined
  const value = (bindings as unknown as Record<symbol, unknown>)[BINDINGS_USER]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 绑定表路径；测试与诊断用，业务代码不要绕过 Bindings 直接读写。 */
export function bindingsFile(space: SpaceHandle): string {
  return path.join(space.stores.taktDir, 'dsh', 'bindings.json')
}

interface BindingEntry {
  requirementId: string
  sessionId: string
  by: Actor
  boundAt: string
}

interface BindingsFile {
  version: 1
  bindings: BindingEntry[]
}

const FILE_VERSION = 1

async function readBindingsFile(file: string): Promise<BindingsFile> {
  const raw = await readJsonFile<unknown>(file)
  if (raw === undefined) return { version: FILE_VERSION, bindings: [] }
  if (!isRecord(raw) || raw.version !== FILE_VERSION || !Array.isArray(raw.bindings)) {
    throw new Error(`绑定表结构不合法：${file}`)
  }
  const bindings: BindingEntry[] = []
  for (const entry of raw.bindings) {
    if (!isRecord(entry)
      || typeof entry.requirementId !== 'string'
      || typeof entry.sessionId !== 'string'
      || typeof entry.boundAt !== 'string'
      || !Number.isFinite(Date.parse(entry.boundAt))
      || !isHumanActor(entry.by)) {
      throw new Error(`绑定表记录不合法：${file}`)
    }
    // 读取时也校验 ID 形状，避免损坏文件把非法路径带进后续逻辑。
    assertRequirementId(entry.requirementId)
    assertSessionId(entry.sessionId)
    bindings.push({
      requirementId: entry.requirementId,
      sessionId: entry.sessionId,
      by: cloneActor(entry.by),
      boundAt: entry.boundAt,
    })
  }
  // 绑定表必须是双射；出现重复说明文件被并发写坏，不能 find 到首条就当正常。
  const requirements = new Set<string>()
  const sessions = new Set<string>()
  for (const entry of bindings) {
    if (requirements.has(entry.requirementId)) {
      throw new Error(`绑定表存在重复需求记录：${entry.requirementId}（${file}）`)
    }
    if (sessions.has(entry.sessionId)) {
      throw new Error(`绑定表存在重复会话记录：${entry.sessionId}（${file}）`)
    }
    requirements.add(entry.requirementId)
    sessions.add(entry.sessionId)
  }
  return { version: FILE_VERSION, bindings }
}

function assertSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '' || /\s/.test(sessionId)) {
    throw new Error(`非法会话 ID：${String(sessionId)}`)
  }
  return sessionId
}

function assertHuman(by: Actor): void {
  if (!isHumanActor(by)) {
    throw new Error('绑定必须由人确认：by 必须是 human actor')
  }
}

function isHumanActor(value: unknown): value is Extract<Actor, { type: 'human' }> {
  return isRecord(value)
    && value.type === 'human'
    && typeof value.id === 'string'
    && value.id.trim() !== ''
    && (value.via === undefined || typeof value.via === 'string')
}

function cloneActor(actor: Actor): Actor {
  return { ...actor }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 需求 ↔ 会话绑定占位实现；只在没有宿主 ctx 的程序化组装里使用。 */
export class PlaceholderBindings implements Bindings {
  async bind(
    _space: SpaceHandle,
    _requirementId: RequirementId,
    _sessionId: string,
    _by: Actor,
  ): Promise<void> {
    notImplemented('bindings.bind')
  }

  async byRequirement(_space: SpaceHandle, _requirementId: RequirementId): Promise<string | undefined> {
    notImplemented('bindings.byRequirement')
  }

  async bySession(_space: SpaceHandle, _sessionId: string): Promise<RequirementId | undefined> {
    notImplemented('bindings.bySession')
  }
}
