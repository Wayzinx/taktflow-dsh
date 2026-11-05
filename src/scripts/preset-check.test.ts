import { describe, expect, it } from 'vitest'
import { checkPreset } from '../../scripts/preset-check.mjs'

describe('Lead preset 白名单', () => {
  it('cordis.patch.yml 的插件组合符合技术方案 5.7', async () => {
    const { problems } = await checkPreset()
    expect(problems).toEqual([])
  })
})
