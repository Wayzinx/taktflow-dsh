import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import { FsSpaceRegistry } from './space.js'
import { TaktToolError } from './types.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'takt-dsh-space-'))
  tempDirs.push(dir)
  return dir
}

async function makeSpace(): Promise<string> {
  const dir = await tempDir()
  await initProject(dir, { name: 'demo' })
  return realpath(dir)
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(TaktToolError)
    return (error as TaktToolError).code
  }
  throw new Error('预期抛错但没有抛')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FsSpaceRegistry', () => {
  it('打开正好是空间根的目录，并复用缓存', async () => {
    const root = await makeSpace()
    const registry = new FsSpaceRegistry()
    const first = await registry.open(root)
    const second = await registry.open(root)

    expect(first.root).toBe(root)
    expect(first.stores.projectDir).toBe(root)
    expect(first.insights).toBeDefined()
    expect(second).toBe(first)
  })

  it('拒绝没有 takt.config.json 的目录，且不隐式创建 .takt', async () => {
    const dir = await tempDir()
    const registry = new FsSpaceRegistry()

    expect(await errorCode(registry.open(dir))).toBe('TAKT_NO_SPACE')
    await expect(access(path.join(dir, '.takt'))).rejects.toThrow()
  })

  it('拒绝把子目录当成空间根（不能依赖 core 的向上查找）', async () => {
    const root = await makeSpace()
    const subdir = path.join(root, 'nested')
    await mkdir(subdir)
    const registry = new FsSpaceRegistry()

    expect(await errorCode(registry.open(subdir))).toBe('TAKT_NO_SPACE')
  })

  it('forSession 接受正好是空间根的 cwd', async () => {
    const root = await makeSpace()
    const registry = new FsSpaceRegistry({ spaces: [root] })
    const handle = await registry.forSession(root)

    expect(handle.root).toBe(root)
  })

  it('forSession 对空间子目录报 ROOT_MISMATCH', async () => {
    const root = await makeSpace()
    const subdir = path.join(root, 'nested')
    await mkdir(subdir)
    const registry = new FsSpaceRegistry({ spaces: [root] })

    expect(await errorCode(registry.forSession(subdir))).toBe('TAKT_SPACE_ROOT_MISMATCH')
  })

  it('forSession 对未配置目录/缺省 cwd 报 NO_SPACE', async () => {
    const root = await makeSpace()
    const outside = await tempDir()
    const registry = new FsSpaceRegistry({ spaces: [root] })

    expect(await errorCode(registry.forSession(outside))).toBe('TAKT_NO_SPACE')
    expect(await errorCode(registry.forSession(undefined))).toBe('TAKT_NO_SPACE')
  })

  it('没有配置 spaces 时只接受 cwd 本身就是空间根，并锁定这一个根', async () => {
    const root = await makeSpace()
    const empty = await tempDir()
    const registry = new FsSpaceRegistry()

    expect((await registry.forSession(root)).root).toBe(root)
    expect(await registry.roots()).toEqual([root])
    expect(await errorCode(registry.forSession(empty))).toBe('TAKT_NO_SPACE')
  })

  it('配置里同一个根的 symlink 去重，roots 返回 realpath', async () => {
    const root = await makeSpace()
    const linkParent = await tempDir()
    const link = path.join(linkParent, 'space-link')
    await symlink(root, link, 'dir')

    const registry = new FsSpaceRegistry({ spaces: [root, link] })
    expect(await registry.roots()).toEqual([root])
    const viaLink = await registry.open(link)
    const viaRoot = await registry.open(root)
    expect(viaLink).toBe(viaRoot)
  })

  it('配置多个不同根时拒绝', async () => {
    const first = await makeSpace()
    const second = await makeSpace()
    const registry = new FsSpaceRegistry({ spaces: [first, second] })

    expect(await errorCode(registry.roots())).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(await errorCode(registry.open(first))).toBe('TAKT_SPACE_ROOT_MISMATCH')
  })

  it('未配置 spaces 时也不能先后打开两个不同根', async () => {
    const first = await makeSpace()
    const second = await makeSpace()
    const registry = new FsSpaceRegistry()

    expect((await registry.open(first)).root).toBe(first)
    expect(await errorCode(registry.open(second))).toBe('TAKT_SPACE_ROOT_MISMATCH')
    expect(await registry.roots()).toEqual([first])
  })

  it('配置了根时 open 拒绝配置外的根', async () => {
    const configured = await makeSpace()
    const other = await makeSpace()
    const registry = new FsSpaceRegistry({ spaces: [configured] })

    expect(await errorCode(registry.open(other))).toBe('TAKT_SPACE_ROOT_MISMATCH')
  })

  it('同根并发 open 返回同一个 handle', async () => {
    const root = await makeSpace()
    const registry = new FsSpaceRegistry()

    const [first, second] = await Promise.all([registry.open(root), registry.open(root)])
    expect(first).toBe(second)
    expect(await registry.roots()).toEqual([root])
  })

  it('未配置时异根并发只有一个成功，失败不占用根', async () => {
    const first = await makeSpace()
    const second = await makeSpace()
    const registry = new FsSpaceRegistry()

    const results = await Promise.allSettled([registry.open(first), registry.open(second)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(TaktToolError)
    expect(await registry.roots()).toHaveLength(1)
  })

  it('打开失败后可以重试另一个根', async () => {
    const empty = await tempDir()
    const root = await makeSpace()
    const registry = new FsSpaceRegistry()

    expect(await errorCode(registry.open(empty))).toBe('TAKT_NO_SPACE')
    expect((await registry.open(root)).root).toBe(root)
  })

  it('forSession 把 ..cache 这样的子目录识别为空间内部', async () => {
    const root = await makeSpace()
    const subdir = path.join(root, '..cache')
    await mkdir(subdir)
    const registry = new FsSpaceRegistry({ spaces: [root] })

    expect(await errorCode(registry.forSession(subdir))).toBe('TAKT_SPACE_ROOT_MISMATCH')
  })

  it('roots 返回副本，外部不能改变配置根', async () => {
    const root = await makeSpace()
    const registry = new FsSpaceRegistry({ spaces: [root] })
    const roots = await registry.roots()
    roots[0] = '/changed'
    expect(await registry.roots()).toEqual([root])
    expect((await registry.open(root)).root).toBe(root)
  })

  it('配置根暂时不存在时不缓存失败，创建后可重试', async () => {
    const parent = await tempDir()
    const root = path.join(parent, 'later')
    const registry = new FsSpaceRegistry({ spaces: [root] })
    expect(await errorCode(registry.roots())).toBe('TAKT_NO_SPACE')
    await initProject(root, { name: 'later' })
    expect((await registry.open(root)).root).toBe(await realpath(root))
  })
})
