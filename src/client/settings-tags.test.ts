import { describe, expect, it } from 'vitest'
// @ts-ignore 根 tsconfig 用 NodeNext，不允许 .ts 后缀；vitest 需要显式 .ts 才能跨包解析。
import { splitTagDraft } from '../../vendor/taktflow/packages/web/src/pages/settings/settings-tags.ts'

describe('TagInput 切分规则', () => {
  it('命令字段只按回车，整条保留空格和逗号', () => {
    expect(splitTagDraft('npm run test:unit', 'enter')).toEqual(['npm run test:unit'])
    expect(splitTagDraft('node --test a,b.test.js', 'enter')).toEqual(['node --test a,b.test.js'])
  })

  it('普通标签仍按逗号切分，但不按空白切分', () => {
    expect(splitTagDraft('src/**, docs/**', 'comma')).toEqual(['src/**', ' docs/**'])
    expect(splitTagDraft('src/**', 'comma')).toEqual(['src/**'])
  })
})
