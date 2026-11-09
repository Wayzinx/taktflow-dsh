import type { JsonValue } from '../dsh-types.js'

/**
 * 工具结果无法无损表达为 JSON 时的内部错误。
 *
 * 不用 TaktToolError：TAKT_INTERNAL 属于工具层错误码，不是 core 的稳定码。
 * 带 code 是为了让 tools.ts 的 taktErrorOf 仍能把它映射成结构化 TAKT_INTERNAL。
 */
export class JsonSafeToolError extends Error {
  readonly code = 'TAKT_INTERNAL'
  readonly hint = '这是插件内部错误；请把工具名和时间点交给维护者。'

  constructor(message: string) {
    super(message)
    this.name = 'JsonSafeToolError'
  }
}

/**
 * 把工具结果转换成 dsh 要求的 lossless JSON。
 *
 * dsh-tools 在把 execute 返回值交给 render 之前会用
 * `@deepseek-ai/dsh-util-values` 的 isJsonValue 校验；undefined、函数、Symbol、
 * BigInt、NaN/Infinity、稀疏数组、类实例和循环引用都会被拒绝，表现为
 * “tool returned invalid output: value is not lossless JSON”。
 *
 * 转换规则：
 * - 对象属性 undefined：省略（JSON 对可选字段的自然缺省）；
 * - 数组元素 undefined：写 null（保持长度，与 JSON.stringify 一致）；
 * - -0：写 0（JSON 无法区分正负零）；
 * - 其它不可序列化值：抛 JsonSafeToolError 并带出路径，不静默丢弃。
 */
export function jsonSafeToolValue(value: unknown): JsonValue {
  return normalize(value, '$', new Set())
}

function normalize(value: unknown, path: string, stack: Set<object>): JsonValue {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw unsupported(path, `非有限数字 ${String(value)}`)
      return Object.is(value, -0) ? 0 : value
    case 'undefined':
      // 顶层 undefined 不是合法 JSON；用 null 作为缺省，调用方一般不会走到这里。
      return null
    case 'bigint':
    case 'function':
    case 'symbol':
      throw unsupported(path, typeof value)
  }
  if (stack.has(value)) throw unsupported(path, '循环引用')
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      rejectSymbolKeys(value, path)
      for (const name of Object.getOwnPropertyNames(value)) {
        if (name === 'length' || isArrayIndex(name)) continue
        throw unsupported(`${path}.${name}`, '数组上的非索引属性')
      }
      const out: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        out.push(normalize(value[index], `${path}[${index}]`, stack))
      }
      return out
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupported(path, `类实例 ${String(prototype?.constructor?.name ?? 'unknown')}`)
    }
    rejectSymbolKeys(value, path)
    const enumerable = new Set(Object.keys(value))
    for (const name of Object.getOwnPropertyNames(value)) {
      if (!enumerable.has(name)) throw unsupported(`${path}.${name}`, '不可枚举属性')
    }
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      // JSON 没有 undefined；省略可选字段是宿主能接受、也不会丢失已表达信息的缺省。
      if (item === undefined) continue
      const normalized = normalize(item, `${path}.${key}`, stack)
      // 不能用 out[key] = …：自有键 "__proto__" 会走原型 setter，丢掉这个键
      // 甚至污染原型。defineProperty 保留 JSON 里真实存在的自有键。
      Object.defineProperty(out, key, {
        value: normalized,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return out
  } finally {
    stack.delete(value)
  }
}

function rejectSymbolKeys(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw unsupported(path, 'Symbol 属性')
}

function isArrayIndex(name: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(name)) return false
  const index = Number(name)
  return Number.isSafeInteger(index) && index < 2 ** 32 - 1
}

function unsupported(path: string, kind: string): JsonSafeToolError {
  return new JsonSafeToolError(`工具结果包含不可 JSON 序列化的内容：${path}（${kind}）`)
}
