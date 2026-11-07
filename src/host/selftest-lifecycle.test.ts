import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessRequest } from '@taktflow/core'
import { createDshHarness } from './dsh-harness.js'
import type { Agent } from './dsh-types.js'
import type { SelftestService } from './selftest.js'
import { FakeHostContext } from './testing/fake-ctx.js'
import type { PermissionScope, SpaceHandle } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'takt-selftest-lifecycle-')))
  roots.push(root)
  const artifactRoot = path.join(root, 'requirements', 'REQ-1')
  await mkdir(artifactRoot, { recursive: true })
  const calls: string[] = []
  const ctx = new FakeHostContext()
  const parent: Agent = {
    id: 'lead', options: {}, session: { header: { id: 'lead', cwd: root } }, followup() {}, inject() {},
  }
  ctx.agents.get = (id) => id === parent.id ? parent : undefined
  const permissions = new Map<string, PermissionScope>()
  const releaseGate = deferred()
  const releaseEntered = deferred()
  const cancel = vi.fn(() => { calls.push('selftest-cancel') })
  const release = vi.fn(async () => {
    calls.push('selftest-release-start')
    releaseEntered.resolve()
    await releaseGate.promise
    calls.push('selftest-release-done')
  })
  const selftests: SelftestService = {
    register: vi.fn(async (input) => {
      calls.push('selftest-register')
      return { childId: input.childId, cancel, release }
    }),
    cancel: vi.fn(), drain: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    run: vi.fn(async () => { throw new Error('此测试只验证生命周期') }),
  }
  const dispose = vi.fn(async () => { calls.push('activation-dispose') })
  ctx.subagents.startActivation = async (spec) => {
    calls.push('activation-start')
    expect(permissions.has(spec.childId!)).toBe(true)
    return { childId: spec.childId!, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }
  }
  const space = {
    root,
    stores: {
      runs: { get: async () => ({ requirementId: 'REQ-1', nodes: { work: { attempts: 1 } } }) },
      workspaces: { dir: () => artifactRoot },
    },
  } as unknown as SpaceHandle
  const releasePreset = vi.fn(async () => { calls.push('preset-release') })
  const harness = createDshHarness({
    ctx, space, ownerSessionId: parent.id, selftests,
    presets: { acquire: async () => ({ id: 'role', cfgHash: 'hash', release: releasePreset }) },
    permissions: {
      register: (scope) => {
        permissions.set(scope.childId, scope)
        return () => { calls.push('permission-release'); permissions.delete(scope.childId) }
      },
      lookup: (id) => permissions.get(id),
    },
    onLeadOffline: async () => {},
  })
  const req: HarnessRequest = {
    prompt: '受控自测生命周期', cwd: root,
    env: { TAKT_ROLE: 'dev', TAKT_RUN_ID: 'run-1', TAKT_NODE: 'work', TAKT_REQ: 'REQ-1' },
    tools: { writeScope: ['src/**'] },
  }
  return { calls, harness, req, permissions, cancel, release, dispose, releaseGate, releaseEntered, releasePreset }
}

describe('受控自测与节点清理顺序', () => {
  it('自然结束先取消自测，收掉 activation，等待进程结束后才释放权限', async () => {
    const f = await fixture()
    const running = f.harness.run(f.req, () => {})
    await f.releaseEntered.promise
    expect(f.calls.indexOf('selftest-cancel')).toBeLessThan(f.calls.indexOf('activation-dispose'))
    expect(f.permissions.size).toBe(1)
    expect(f.releasePreset).not.toHaveBeenCalled()
    f.releaseGate.resolve()
    expect((await running).ok).toBe(true)
    expect(f.calls.slice(-3)).toEqual(['selftest-release-done', 'permission-release', 'preset-release'])
    expect(f.permissions.size).toBe(0)
  })

  it('harness drain 等待自测进程清理，不提前报告节点收尾完成', async () => {
    const f = await fixture()
    const running = f.harness.run(f.req, () => {})
    await f.releaseEntered.promise
    let drained = false
    const draining = f.harness.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.permissions.size).toBe(1)
    f.releaseGate.resolve()
    await running
    await draining
    expect(drained).toBe(true)
    expect(f.permissions.size).toBe(0)
  })

  it('activation 清理失败仍等待自测结束，并保留存活 child 的权限守卫', async () => {
    const f = await fixture()
    f.dispose.mockImplementationOnce(async () => { throw new Error('activation 无法停止') })
    const running = f.harness.run(f.req, () => {})
    const rejected = expect(running).rejects.toThrow('activation 无法停止')
    await f.releaseEntered.promise
    expect(f.cancel).toHaveBeenCalled()
    expect(f.permissions.size).toBe(1)
    f.releaseGate.resolve()
    await rejected
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.permissions.size).toBe(1)
    expect(f.releasePreset).not.toHaveBeenCalled()
  })
})
