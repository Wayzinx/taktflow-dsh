import { describe, expect, it } from 'vitest'
import { supportsDshOutputSchema } from './dsh-schema.js'

describe('dsh 输出 schema 子集', () => {
  it('接受对象根、嵌套数组、标量、注释节点与 oneOf', () => {
    expect(supportsDshOutputSchema({
      type: 'object', properties: {
        name: { type: 'string', enum: ['ok', 'fail'], const: 'ok' },
        rows: { type: 'array', items: { oneOf: [{ type: 'integer' }, { type: 'null' }] } },
        extra: { description: '任意 JSON', default: { valid: [true, null] } },
      }, required: ['name'], additionalProperties: false,
    })).toBe(true)
  })

  it.each([
    undefined, {}, { type: 'array' }, { type: ['object', 'null'] },
    { type: 'object', additionalProperties: {} },
    { type: 'object', required: ['missing'] },
    { type: 'object', properties: { x: { type: 'integer', enum: [1.5] } } },
    { type: 'object', properties: { x: { type: 'number', enum: [] } } },
    { type: 'object', properties: { x: { type: 'boolean', const: 'true' } } },
    { type: 'object', properties: { x: { type: 'string', enum: ['yes'], const: 'no' } } },
    { type: 'object', properties: { x: { type: 'array', items: [] } } },
    { type: 'object', properties: { x: { oneOf: [{ type: 'string' }] } } },
    { type: 'object', properties: { x: { type: 'string', oneOf: [{}, {}] } } },
    { type: 'object', properties: { x: { oneOf: [{}, {}], enum: ['a'] } } },
    { type: 'object', properties: { x: { type: 'json' } } },
    { type: 'object', properties: { x: { type: 'string', pattern: '.+' } } },
    { type: 'object', properties: { x: { type: 'number', minimum: 0 } } },
    { type: 'object', $ref: '#/a' }, { type: 'object', $schema: 'schema' },
    { type: 'object', description: 7 }, { type: 'object', default: Number.NaN },
    { type: 'object', default: -0 }, { type: 'object', default: new Date() },
  ])('不支持或无效的 schema 回退：%j', (schema) => {
    expect(supportsDshOutputSchema(schema)).toBe(false)
  })

  it('循环引用和不可见属性都不能传入 dsh', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.properties = { again: cyclic }
    expect(supportsDshOutputSchema(cyclic)).toBe(false)
    expect(supportsDshOutputSchema(Object.defineProperty({ type: 'object' }, 'secret', { value: true }))).toBe(false)
  })
})
