import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { assertRequirementId, canonicalJson, sha256, type Actor } from '@taktflow/core'
import { withFileLock } from '../../../vendor/taktflow/packages/core/src/store/file-lock.js'
import { readJsonFile, toJsonText, writeFileAtomic } from '../../../vendor/taktflow/packages/core/src/store/fs-utils.js'
import type { SpaceHandle } from '../types.js'

/**
 * 需求创建请求账本。
 *
 * `takt_requirement create` 的 requestKey 必须持久化：模型或宿主重试时用同一个
 * 键只创建一个需求。账本放在 `.takt/runs/.dsh/requests.json`：
 * - `.takt/runs/` 是 core 写守卫的元数据区，宿主写账本不会被角色守卫误判；
 * - 目录名以 `.` 开头，RunStore.list 会跳过它，不会被当成一次运行。
 *
 * 记录分两步落盘：
 * 1. pending：先写 requestKey → 预留需求 ID，再创建需求；
 * 2. completed：创建并绑定成功后标记完成。
 *
 * 这样“创建需求后、记账前”崩溃也能用同一个 requestKey 恢复：pending 里的
 * 预留 ID 是确定性的，重试会核对需求标题/链接后复用，不会静默创建第二个需求。
 */
export interface CreateRequestRecord {
  requestKey: string
  requirementId: string
  /** 发起创建请求的 Lead 会话；防止另一个会话复用同名 requestKey 接管需求。 */
  sessionId: string
  /** 创建输入的规范化指纹；用于发现“同一个键换了请求内容”。 */
  fingerprint: string
  status: 'pending' | 'completed'
  createdAt: string
  completedAt?: string
  by: Actor
}

export interface CreateLedger {
  /** 读取记录；必须用自有属性判断，避免 requestKey=constructor 取到原型。 */
  get(requestKey: string): CreateRequestRecord | undefined
  /** 原子落盘（新增或覆盖同一 requestKey）；调用方负责在锁内调用。 */
  put(record: CreateRequestRecord): Promise<void>
  /** 删除记录；用于“预留 ID 已被其它需求占用”等无法继续的冲突。 */
  delete(requestKey: string): Promise<void>
}

interface LedgerFile {
  version: 1
  creates: Record<string, CreateRequestRecord>
}

const FILE_VERSION = 1

/** 账本路径；测试与诊断用。 */
export function createRequestsFile(space: SpaceHandle): string {
  return path.join(space.stores.taktDir, 'runs', '.dsh', 'requests.json')
}

/**
 * 在账本文件锁内执行 fn。
 *
 * 锁覆盖“读账本 + 创建需求 + 记账 + 绑定”，保证并发重试不会创建两个需求，
 * 也保证同一会话并发使用不同 requestKey 时只有第一个能创建。
 */
export async function withCreateLedger<T>(
  space: SpaceHandle,
  fn: (ledger: CreateLedger) => Promise<T>,
): Promise<T> {
  const file = createRequestsFile(space)
  return withFileLock(file, async () => {
    const state = await readLedgerFile(file)
    const flush = async (): Promise<void> => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, toJsonText(state))
    }
    return fn({
      get: (requestKey) => {
        assertRequestKey(requestKey)
        return Object.hasOwn(state.creates, requestKey) ? state.creates[requestKey] : undefined
      },
      put: async (record) => {
        assertRequestKey(record.requestKey)
        state.creates[record.requestKey] = record
        await flush()
      },
      delete: async (requestKey) => {
        assertRequestKey(requestKey)
        delete state.creates[requestKey]
        await flush()
      },
    })
  })
}

/** 创建输入的规范化指纹：字段顺序不同不影响判定，内容变化会改变指纹。 */
export function fingerprintCreateInput(input: {
  title: string
  id?: string
  links?: readonly unknown[]
}): string {
  return sha256(canonicalJson({
    title: input.title,
    id: input.id ?? null,
    links: input.links ?? [],
  }))
}

/**
 * 由 requestKey 派生确定性的需求 ID。
 *
 * 崩溃恢复时即使账本丢失（极端情况），同一个 requestKey 仍会落到同一个 ID，
 * core 的“需求已存在”会阻止静默创建第二个需求。
 */
export function requirementIdForRequest(requestKey: string): string {
  const digest = sha256(`taktflow:requirement:${requestKey}`).slice(0, 12).toUpperCase()
  return assertRequirementId(`REQ-${digest}`)
}

/** requestKey 只作为 JSON 键使用；限制字符集，避免日志和错误信息里出现控制字符。 */
export function assertRequestKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`非法 requestKey：${value}（只允许字母、数字、点、下划线、冒号和短横线，最长 128）`)
  }
  return value
}

async function readLedgerFile(file: string): Promise<LedgerFile> {
  const raw = await readJsonFile<unknown>(file)
  const creates: Record<string, CreateRequestRecord> = Object.create(null) as Record<string, CreateRequestRecord>
  if (raw === undefined) return { version: FILE_VERSION, creates }
  if (!isRecord(raw) || raw.version !== FILE_VERSION || !isRecord(raw.creates)) {
    throw new Error(`创建请求账本结构不合法：${file}`)
  }
  for (const [key, value] of Object.entries(raw.creates)) {
    if (!isRecord(value)
      || value.requestKey !== key
      || typeof value.requirementId !== 'string'
      || typeof value.sessionId !== 'string'
      || value.sessionId.trim() === ''
      || typeof value.fingerprint !== 'string'
      || (value.status !== 'pending' && value.status !== 'completed')
      || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))
      || !isHumanActor(value.by)) {
      throw new Error(`创建请求账本记录不合法：${file}`)
    }
    assertRequestKey(key)
    assertRequirementId(value.requirementId)
    const record: CreateRequestRecord = {
      requestKey: key,
      requirementId: value.requirementId,
      sessionId: value.sessionId,
      fingerprint: value.fingerprint,
      status: value.status,
      createdAt: value.createdAt,
      by: { ...value.by },
    }
    if (value.completedAt !== undefined) {
      if (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) {
        throw new Error(`创建请求账本完成时间不合法：${file}`)
      }
      record.completedAt = value.completedAt
    }
    creates[key] = record
  }
  return { version: FILE_VERSION, creates }
}

function isHumanActor(value: unknown): value is Extract<Actor, { type: 'human' }> {
  return isRecord(value)
    && value.type === 'human'
    && typeof value.id === 'string'
    && value.id.trim() !== ''
    && (value.via === undefined || typeof value.via === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
