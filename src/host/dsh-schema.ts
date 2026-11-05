/**
 * 启动前检查 dsh 结构化输出的子集；不支持时调用方回退文本 JSON 提取。
 * 来源：@deepseek-ai/dsh-tools/lib/index.js 的 assertObjectJsonSchema。
 * 不导入运行时 SDK，避免插件与宿主各自加载一份工具注册表。
 */
export function supportsDshOutputSchema(value: unknown): value is Record<string, unknown> {
  const active = new Set<object>()
  const record = (item: unknown): item is Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const prototype = Object.getPrototypeOf(item)
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(item).every((key) => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(item, key))
  }
  const dense = (item: unknown): item is unknown[] => Array.isArray(item)
    && Object.getPrototypeOf(item) === Array.prototype && Reflect.ownKeys(item).length === item.length + 1
    && Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).every(Boolean)
  const json = (item: unknown): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0)
    if (typeof item !== 'object' || active.has(item)) return false
    if (!dense(item) && !record(item)) return false
    active.add(item)
    const valid = Object.values(item).every(json)
    active.delete(item)
    return valid
  }
  const scalar = (type: string, item: unknown): boolean => {
    if (type === 'null') return item === null
    if (type === 'number' || type === 'integer') return typeof item === 'number' && Number.isFinite(item)
      && !Object.is(item, -0) && (type !== 'integer' || Number.isInteger(item))
    return (type === 'string' || type === 'boolean') && typeof item === type
  }
  const annotations = ['description', 'title', 'default', 'examples']
  const constraints = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
  const check = (node: unknown): boolean => {
    if (!record(node) || active.has(node)) return false
    active.add(node)
    try {
      if (Object.keys(node).some((key) => !annotations.includes(key) && !constraints.includes(key))) return false
      for (const key of annotations) if (Object.hasOwn(node, key) && !json(node[key])) return false
      for (const key of ['description', 'title']) if (Object.hasOwn(node, key) && typeof node[key] !== 'string') return false
      if (Object.hasOwn(node, 'oneOf')) return !constraints.some((key) => key !== 'oneOf' && Object.hasOwn(node, key))
        && dense(node.oneOf) && node.oneOf.length >= 2 && node.oneOf.every(check)
      if (!Object.hasOwn(node, 'type')) return !constraints.some((key) => Object.hasOwn(node, key))
      const type = node.type
      if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) return false
      const allowed = type === 'object' ? ['properties', 'required', 'additionalProperties'] : type === 'array' ? ['items'] : ['enum', 'const']
      if (constraints.some((key) => key !== 'type' && !allowed.includes(key) && Object.hasOwn(node, key))) return false
      if (type === 'object') {
        if (Object.hasOwn(node, 'properties') && (!record(node.properties) || !Object.values(node.properties).every(check))) return false
        if (Object.hasOwn(node, 'required') && (!dense(node.required)
          || !node.required.every((key) => typeof key === 'string' && record(node.properties) && Object.hasOwn(node.properties, key)))) return false
        return !Object.hasOwn(node, 'additionalProperties') || typeof node.additionalProperties === 'boolean'
      }
      if (type === 'array') return !Object.hasOwn(node, 'items') || check(node.items)
      if (Object.hasOwn(node, 'enum') && (!dense(node.enum) || node.enum.length === 0 || !node.enum.every((item) => scalar(type, item)))) return false
      if (Object.hasOwn(node, 'const') && (!scalar(type, node.const) || (dense(node.enum) && !node.enum.includes(node.const)))) return false
      return true
    } finally { active.delete(node) }
  }
  try { return record(value) && Object.hasOwn(value, 'type') && value.type === 'object' && check(value) } catch { return false }
}
