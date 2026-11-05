import { hostname } from 'node:os'
import type { Actor, RequirementId, RunId } from '@taktflow/core'
import { notImplemented } from './errors.js'
import type {
  Bindings,
  EndReason,
  Ownership,
  RunOwnerMeta,
  SpaceHandle,
} from './types.js'

/**
 * 运行所有权占位实现。
 *
 * hostOwner 是宿主进程身份，与审计用的人（Config.user）无关；租约读写、接管与
 * 终态写入由 执行层接入 core 的 lease 存储，在接入前显式抛 not implemented。
 */
export class PlaceholderOwnership implements Ownership {
  readonly hostOwner: string

  constructor(hostId = `${hostname()}:${process.pid}`) {
    this.hostOwner = `dsh:${hostId}`
  }

  async ensureLease(_space: SpaceHandle): Promise<void> {
    notImplemented('ownership.ensureLease')
  }

  async release(_space: SpaceHandle): Promise<void> {
    notImplemented('ownership.release')
  }

  async takeover(_space: SpaceHandle, _by: Actor): Promise<void> {
    notImplemented('ownership.takeover')
  }

  async recordRun(_space: SpaceHandle, _runId: RunId, _meta: RunOwnerMeta): Promise<void> {
    notImplemented('ownership.recordRun')
  }

  async readRun(_space: SpaceHandle, _runId: RunId): Promise<RunOwnerMeta | undefined> {
    notImplemented('ownership.readRun')
  }

  async setEndReason(_space: SpaceHandle, _runId: RunId, _endReason: EndReason): Promise<void> {
    notImplemented('ownership.setEndReason')
  }
}

/** 需求 ↔ 会话绑定占位实现；由 Lead 层按 .takt/dsh/bindings.json 实现。 */
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
