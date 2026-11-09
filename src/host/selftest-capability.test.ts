import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { canUseSelftest, isArtifactOnlyPattern } from './selftest-capability.js'
import type { SpaceHandle } from './types.js'

const root = path.resolve('space-fixture')

function space(requirements = 'requirements', knowledge = 'knowledge'): SpaceHandle {
  return {
    root,
    stores: {
      paths: {
        requirements: path.join(root, requirements),
        knowledge: path.join(root, knowledge),
      },
    },
  } as unknown as SpaceHandle
}

describe('受控自测能力分配', () => {
  it('只写需求产物/知识库的角色是文档型，不挂自测', () => {
    expect(canUseSelftest(space(), ['.takt/workspaces/**', 'requirements/**'], false)).toBe(false)
    expect(canUseSelftest(space(), ['requirements/*/reports/**'], false)).toBe(false)
    expect(canUseSelftest(space(), ['knowledge/**'], false)).toBe(false)
    expect(canUseSelftest(space(), ['.takt/knowledge/**'], false)).toBe(false)
  })

  it('自定义配置的产物与知识目录按实际 paths 识别', () => {
    const custom = space('artifacts/reqs', 'docs/wiki')
    expect(canUseSelftest(custom, ['artifacts/reqs/**'], false)).toBe(false)
    expect(canUseSelftest(custom, ['docs/wiki/**'], false)).toBe(false)
    // 标准别名继续兼容，避免旧空间因自定义 paths 被误判成代码角色。
    expect(canUseSelftest(custom, ['requirements/**'], false)).toBe(false)
  })

  it.each([
    ['开发', ['src/**', 'package.json', 'requirements/**/tasks/**']],
    ['自动化', ['requirements/**/scripts/**', 'tests/**']],
    ['自定义代码角色', ['services/api/src/**']],
    ['宽范围', ['**']],
    ['自定义目录', ['custom/**']],
    ['相似前缀', ['requirements-code/**']],
    ['旧版相似前缀', ['.takt/workspaces-code/**']],
  ])('%s 保留自测能力', (_name, writeScope) => {
    expect(canUseSelftest(space(), writeScope, false)).toBe(true)
  })

  it('只读或空范围始终不具备能力', () => {
    expect(canUseSelftest(space(), ['src/**'], true)).toBe(false)
    expect(canUseSelftest(space(), [], false)).toBe(false)
  })

  it('缺少 stores.paths 时仍按标准别名判定', () => {
    const partial = { root } as SpaceHandle
    expect(canUseSelftest(partial, ['requirements/**'], false)).toBe(false)
    expect(canUseSelftest(partial, ['src/**'], false)).toBe(true)
  })

  it('单个模式按路径边界判定，不被相似前缀或 .. 绕过', () => {
    const roots = ['requirements', '.takt/workspaces']
    expect(isArtifactOnlyPattern('requirements/**', roots)).toBe(true)
    expect(isArtifactOnlyPattern('requirements', roots)).toBe(true)
    expect(isArtifactOnlyPattern('./requirements/*/reports/**', roots)).toBe(true)
    expect(isArtifactOnlyPattern('requirements-code/**', roots)).toBe(false)
    expect(isArtifactOnlyPattern('requirements/../src/**', roots)).toBe(false)
    expect(isArtifactOnlyPattern('../requirements/**', roots)).toBe(false)
    expect(isArtifactOnlyPattern('/requirements/**', roots)).toBe(false)
    expect(isArtifactOnlyPattern('', roots)).toBe(false)
  })
})
