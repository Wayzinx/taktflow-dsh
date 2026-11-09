import { describe, expect, it } from 'vitest'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { JsonSafeToolError, jsonSafeToolValue } from './json-safe.js'

describe('jsonSafeToolValue', () => {
  it('输出通过 DSH 真实 lossless JSON 校验，并保留可选字段的 JSON 缺省', () => {
    const value = jsonSafeToolValue({
      ok: true,
      nested: { keep: 'x', drop: undefined, zero: -0 },
      list: [1, undefined, 'three'],
    })
    // 宿主用 @deepseek-ai/dsh-util-values 的 isJsonValue 做协议校验；
    // 这里直接对真实校验器断言，避免只测自己的实现。
    expect(isJsonValue(value)).toBe(true)
    expect(value).toEqual({
      ok: true,
      nested: { keep: 'x', zero: 0 },
      list: [1, null, 'three'],
    })
  })

  it('保留 JSON 里真实存在的自有 __proto__ 键，且不污染原型', () => {
    // JSON.parse 会创建自有可枚举 "__proto__" 数据属性，而不是设置原型。
    const input = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>
    const value = jsonSafeToolValue(input) as Record<string, unknown>
    expect(isJsonValue(value)).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true)
    expect(value.__proto__).toEqual({ polluted: true })
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    // 嵌套对象里的自有 __proto__ 键同样保留。
    const nested = jsonSafeToolValue(JSON.parse('{"outer":{"__proto__":{"x":1}}}'))
    expect(Object.prototype.hasOwnProperty.call((nested as { outer: object }).outer, '__proto__')).toBe(true)
    expect(isJsonValue(nested)).toBe(true)
  })

  it('不可序列化值明确失败并带路径，不静默丢弃', () => {
    expect(() => jsonSafeToolValue({ nested: { fn: () => 1 } })).toThrowError(JsonSafeToolError)
    expect(() => jsonSafeToolValue({ nested: { fn: () => 1 } })).toThrowError(/\$\.nested\.fn/)
    expect(() => jsonSafeToolValue({ n: Number.NaN })).toThrowError(/\$\.n/)
    expect(() => jsonSafeToolValue({ n: Number.POSITIVE_INFINITY })).toThrowError(/\$\.n/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => jsonSafeToolValue(cyclic)).toThrowError(/\$\.self/)
    class Box { readonly x = 1 }
    expect(() => jsonSafeToolValue({ box: new Box() })).toThrowError(/\$\.box/)
  })
})
