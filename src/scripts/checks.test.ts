import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { checkHostBundle, checkPackageManifest } from '../../scripts/checks.mjs'

describe('构建产物与清单检查', () => {
  it('本包 package.json 满足清单约束', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    expect(checkPackageManifest(manifest)).toEqual([])
  })

  it('宿主产物出现 @taktflow/* 裸导入即失败', () => {
    expect(checkHostBundle("import { x } from '@taktflow/core'")).not.toEqual([])
    expect(checkHostBundle("const core = require('@taktflow/core')")).not.toEqual([])
    expect(checkHostBundle("import '@taktflow/core'")).not.toEqual([])
    expect(checkHostBundle("const core = __require('@taktflow/core')")).not.toEqual([])
    expect(checkHostBundle("await import('@taktflow/server')")).not.toEqual([])
    expect(checkHostBundle('const x = 1')).toEqual([])
  })
})
