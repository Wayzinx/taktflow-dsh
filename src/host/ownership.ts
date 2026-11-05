import { hostname } from 'node:os'
import path from 'node:path'
import {
  acquireLease, assertRunId, createEngine, readLease, releaseLease, renewLease,
  type Actor, type Lease, type RunId,
  withFileLock, assertNoSymlinks, readJsonFile, toJsonText, writeFileAtomic,
} from '@taktflow/core'
import type { HostContext, Disposer } from './dsh-types.js'
import { TaktToolError } from './types.js'
import type { EndReason, Ownership, RunOwnerMeta, SpaceHandle } from './types.js'

interface LeaseHeartbeat {
  active: boolean
  generation: number
  timer: ReturnType<typeof setInterval>
  pending?: Promise<void>
  dispose?: Disposer
}

/** 宿主创建；租约失败由写入口接收，后台续约失败只记录并通知运行管理器。 */
export interface OwnershipOptions {
  ctx?: HostContext
  hostId?: string
  onLeaseLost?: (space: SpaceHandle) => void | Promise<void>
}

/** 宿主的单写者租约及运行归属；卸载方先取消运行，再调用 releaseAll。 */
export class FsOwnership implements Ownership {
  readonly hostOwner: string
  private readonly spaces = new Map<string, SpaceHandle>()
  private readonly heartbeats = new Map<string, LeaseHeartbeat>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, number>()

  constructor(private readonly options: OwnershipOptions = {}) {
    this.hostOwner = `dsh:${options.hostId ?? `${hostname()}:${process.pid}`}`
  }

  /** 写入口调用；过期的外部租约仍需人明确接管，不自动抢占。 */
  async ensureLease(space: SpaceHandle): Promise<void> {
    await this.serial(space, async () => {
      await this.checkLeasePath(space)
      const lease = await readLease(space.stores.taktDir)
      if (lease?.owner === this.hostOwner && lease.host === hostname()) {
        await renewLease(space.stores.taktDir, this.hostOwner)
      } else {
        const acquired = await acquireLease(space.stores.taktDir, this.hostOwner)
        if (!acquired.ok) throw heldError(acquired.held, acquired.stale)
      }
      this.spaces.set(space.root, space)
      this.startHeartbeat(space)
      // 已人工接管、已记 host_lost 的旧运行可能在取消落盘时失败；续约后补偿。
      await this.repairAbandonedRuns(space)
    })
  }

  /** 卸载或人工释放调用；先停续约，再只释放当前确属自己的租约。 */
  async release(space: SpaceHandle): Promise<void> {
    this.generations.set(space.root, (this.generations.get(space.root) ?? 0) + 1)
    const stopped = new Set<LeaseHeartbeat>()
    const stop = () => {
      const heartbeat = this.stopHeartbeat(space.root)
      if (heartbeat) stopped.add(heartbeat)
    }
    stop()
    try {
      await this.serial(space, async () => {
        // ensureLease 可能先于 release 进入队列，在这里再停一次。
        stop()
        await this.checkLeasePath(space)
        const lease = await readLease(space.stores.taktDir)
        if (lease?.owner === this.hostOwner && lease.host === hostname()) {
          await releaseLease(space.stores.taktDir, this.hostOwner)
        }
        this.spaces.delete(space.root)
      })
    } finally {
      // effect 清理可能等待排队续约，必须放在串行队列之外，避免自锁。
      await Promise.all([...stopped].map(async (heartbeat) => { await heartbeat.dispose?.() }))
    }
  }

  /** 宿主卸载调用；独立空间清理全部尝试，失败仍向调用方汇总。 */
  async releaseAll(): Promise<void> {
    const results = await Promise.allSettled([...this.spaces.values()].map((space) => this.release(space)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, '释放宿主租约失败')
  }

  /** 人确认接管后调用；只接管失效的其他宿主，并完整关闭其遗留 running 运行。 */
  async takeover(space: SpaceHandle, _by: Actor): Promise<void> {
    await this.serial(space, async () => {
      await this.checkLeasePath(space)
      const previous = await readLease(space.stores.taktDir)
      if (previous?.owner === this.hostOwner && previous.host === hostname()) {
        await renewLease(space.stores.taktDir, this.hostOwner)
        this.spaces.set(space.root, space)
        this.startHeartbeat(space)
        if (await this.repairAbandonedRuns(space)) return
        throw new TaktToolError('TAKT_LEASE_HELD', '当前租约已由本宿主持有，没有待补偿的接管运行', '已持有时无需接管。')
      }
      if (!previous) {
        throw new TaktToolError('TAKT_LEASE_HELD', '当前没有可接管的失效外部租约', '空闲空间请直接启动；已持有时无需接管。')
      }
      if (!staleSnapshot(previous)) throw heldError(previous, false)
      const result = await acquireLease(space.stores.taktDir, this.hostOwner, { takeover: true })
      if (!result.ok) throw heldError(result.held, result.stale)
      this.spaces.set(space.root, space)
      this.startHeartbeat(space)
      // 先完整登记接管意图，再开始取消；第一条取消失败时其余条目也可安全重试。
      for (const run of await space.stores.runs.list()) {
        if (run.status !== 'running') continue
        const meta = await this.readRun(space, run.runId)
        if (!meta || meta.owner === this.hostOwner) continue
        await this.setEndReason(space, run.runId, { reason: 'host_lost', at: new Date().toISOString() })
      }
      await this.repairAbandonedRuns(space)
    })
  }

  /** 只补偿已经人工标记的外部 running；不据此接管新租约或改动 waiting_human。 */
  private async repairAbandonedRuns(space: SpaceHandle): Promise<number> {
    const engine = createEngine({ stores: space.stores, profiles: {}, harnesses: {}, knowledge: [] })
    let repaired = 0
    for (const run of await space.stores.runs.list()) {
      if (run.status !== 'running') continue
      const meta = await this.readRun(space, run.runId)
      if (!meta || meta.owner === this.hostOwner || meta.endReason?.reason !== 'host_lost') continue
      // core 同时关闭待办、更新需求和追加结束事件，不能仅改 state.json。
      await engine.cancel(run.runId)
      repaired++
    }
    return repaired
  }

  /** 调度前及 preset 审计更新时调用；归属不可覆盖，终止原因不可清除。 */
  async recordRun(space: SpaceHandle, runId: RunId, meta: RunOwnerMeta): Promise<void> {
    const file = await this.ownerPath(space, runId)
    assertOwner(meta)
    await withFileLock(file, async () => {
      const previous = await this.readRun(space, runId)
      if (previous && (previous.ownerSessionId !== meta.ownerSessionId ||
        previous.createdAt !== meta.createdAt || previous.requestKey !== meta.requestKey)) {
        throw new TaktToolError('TAKT_RUN_BUSY', `运行 ${runId} 已有不同归属，不能覆盖`)
      }
      if (previous && previous.owner !== meta.owner) {
        const lease = await readLease(space.stores.taktDir)
        const state = await space.stores.runs.get(runId)
        if (meta.owner !== this.hostOwner || previous.endReason || meta.endReason || state?.status !== 'waiting_human' ||
          lease?.owner !== this.hostOwner || lease.host !== hostname()) {
          throw new TaktToolError('TAKT_RUN_BUSY', `运行 ${runId} 不允许转移归属`)
        }
      }
      if (previous?.endReason && meta.endReason && previous.endReason.reason !== meta.endReason.reason) {
        throw new TaktToolError('TAKT_RUN_BUSY', `运行 ${runId} 已有不同终止原因`)
      }
      const next = { ...previous, ...meta,
        ...(previous?.presets || meta.presets ? { presets: { ...previous?.presets, ...meta.presets } } : {}),
        ...(previous?.endReason ? { endReason: previous.endReason } : {}),
      }
      await assertNoSymlinks(space.root, file)
      await writeFileAtomic(file, toJsonText(next))
    })
  }

  /** 查询与恢复调用；不存在返回 undefined，损坏的审计记录直接失败。 */
  async readRun(space: SpaceHandle, runId: RunId): Promise<RunOwnerMeta | undefined> {
    const file = await this.ownerPath(space, runId)
    const meta = await readJsonFile<unknown>(file)
    if (meta === undefined) return undefined
    assertOwner(meta)
    return meta
  }

  /** 取消方调用；相同原因保留首次时间，不同原因拒绝，避免覆盖事实。 */
  async setEndReason(space: SpaceHandle, runId: RunId, endReason: EndReason): Promise<void> {
    const file = await this.ownerPath(space, runId)
    assertEndReason(endReason)
    await withFileLock(file, async () => {
      const meta = await this.readRun(space, runId)
      if (!meta) throw new TaktToolError('TAKT_RUN_BUSY', `运行 ${runId} 没有归属记录`)
      if (meta.endReason) {
        if (meta.endReason.reason === endReason.reason) return
        throw new TaktToolError('TAKT_RUN_BUSY', `运行 ${runId} 已因 ${meta.endReason.reason} 终止`)
      }
      await assertNoSymlinks(space.root, file)
      await writeFileAtomic(file, toJsonText({ ...meta, endReason }))
    })
  }

  private async ownerPath(space: SpaceHandle, runId: RunId): Promise<string> {
    assertRunId(runId)
    const file = path.join(space.root, '.takt', 'runs', runId, 'owner.json')
    await assertNoSymlinks(space.root, file)
    await assertNoSymlinks(space.root, path.join(space.root, '.takt', 'runs', '.locks'))
    return file
  }

  private async checkLeasePath(space: SpaceHandle): Promise<void> {
    if (space.stores.taktDir !== path.join(space.root, '.takt')) throw new Error('空间租约路径与空间根不一致')
    await assertNoSymlinks(space.root, path.join(space.stores.taktDir, 'lease.json'))
    await assertNoSymlinks(space.root, path.join(space.stores.taktDir, 'runs', '.locks'))
  }

  private serial<T>(space: SpaceHandle, fn: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(space.root) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.queues.set(space.root, task)
    void task.finally(() => { if (this.queues.get(space.root) === task) this.queues.delete(space.root) }).catch(() => {})
    return task
  }

  private stopHeartbeat(root: string): LeaseHeartbeat | undefined {
    const heartbeat = this.heartbeats.get(root)
    if (!heartbeat) return undefined
    heartbeat.active = false
    clearInterval(heartbeat.timer)
    this.heartbeats.delete(root)
    return heartbeat
  }

  private startHeartbeat(space: SpaceHandle): void {
    if (this.heartbeats.has(space.root)) return
    const generation = (this.generations.get(space.root) ?? 0) + 1
    this.generations.set(space.root, generation)
    const heartbeat: LeaseHeartbeat = {
      active: true,
      generation,
      timer: setInterval(() => {
        if (!heartbeat.active || heartbeat.pending) return
        const task = this.serial(space, async () => {
          if (!heartbeat.active) return
          await this.checkLeasePath(space)
          await renewLease(space.stores.taktDir, this.hostOwner)
        })
        heartbeat.pending = task
        void task.catch(async (error: unknown) => {
          // 不让旧回调停止新一代租约，也不在队列内回调运行管理器以免释放死锁。
          if (!heartbeat.active || this.heartbeats.get(space.root) !== heartbeat) return
          this.stopHeartbeat(space.root)
          logFailure(error)
          await heartbeat.dispose?.()
          if (this.generations.get(space.root) === heartbeat.generation) await this.options.onLeaseLost?.(space)
        }).catch(logFailure).finally(() => { heartbeat.pending = undefined })
      }, 10_000),
    }
    heartbeat.timer.unref()
    this.heartbeats.set(space.root, heartbeat)
    if (this.options.ctx) {
      heartbeat.dispose = this.options.ctx.effect(() => async () => {
        heartbeat.active = false
        clearInterval(heartbeat.timer)
        if (this.heartbeats.get(space.root) === heartbeat) this.heartbeats.delete(space.root)
        await heartbeat.pending?.catch(() => {})
      }, 'taktflow:lease-heartbeat')
    }
  }
}

/** 旧骨架的兼容入口；新接线直接使用 FsOwnership。 */
export class PlaceholderOwnership extends FsOwnership {
  constructor(hostId?: string) { super({ hostId }) }
}

// 和 core 一样：同机仅 ESRCH 证明旧进程消失；最终竞争仍由 core 锁内检查裁定。
function staleSnapshot(lease: Lease): boolean {
  if (Date.now() - Date.parse(lease.heartbeatAt) <= lease.ttlMs) return false
  if (lease.host !== hostname()) return true
  try { process.kill(lease.pid, 0); return false } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function heldError(lease: Lease, stale: boolean): TaktToolError {
  return new TaktToolError('TAKT_LEASE_HELD', `空间租约由 ${lease.owner} 自 ${lease.acquiredAt} 起持有`,
    stale ? '旧宿主已失效，需要人工确认接管。' : '在对方处操作，或在主面板释放。')
}

function assertEndReason(value: unknown): asserts value is EndReason {
  if (!value || typeof value !== 'object' || !('reason' in value) || !('at' in value) ||
      !['lead_offline', 'host_lost'].includes(String(value.reason)) || typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at))) throw new Error('运行终止原因损坏')
}

function assertOwner(value: unknown): asserts value is RunOwnerMeta {
  if (!value || typeof value !== 'object') throw new Error('运行归属记录损坏')
  const meta = value as RunOwnerMeta
  if (typeof meta.owner !== 'string' || !meta.owner || typeof meta.ownerSessionId !== 'string' || !meta.ownerSessionId ||
      typeof meta.createdAt !== 'string' || !Number.isFinite(Date.parse(meta.createdAt)) ||
      (meta.requestKey !== undefined && typeof meta.requestKey !== 'string')) throw new Error('运行归属记录损坏')
  if (meta.endReason !== undefined) assertEndReason(meta.endReason)
}

function logFailure(error: unknown): void {
  console.error('[taktflow] 租约续约或清理失败', error instanceof Error ? error.message : '未知错误')
}


