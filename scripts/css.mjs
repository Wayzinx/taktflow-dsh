/**
 * CSS 作用域转换：把插件的全局样式限制在 `.takt-root` 下。
 *
 * M-F 会复用这个函数；要求覆盖：
 * - `:root` → 作用域根
 * - `html` / `body` → 作用域根
 * - 选择器列表按顶层逗号拆分（括号/引号里的逗号不拆）
 * - 嵌套 `@media` / `@supports` / `@layer` / `@container` / `@scope`
 * - `@keyframes` 名字加前缀，并重写 `animation` / `animation-name` 引用
 * - 可选 `container`：只含宽度条件的 `@media` 改写成 `@container <name>`。嵌入 dsh 时面板比窗口窄
 *   （左侧还有 App 的侧栏），按视口算的断点永远不触发；改成按嵌入根（size 容器）的宽度算。
 */

const NESTED_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
  'document',
  'starting-style',
])

export function transformCss(css, options = {}) {
  const scope = options.scope ?? '.takt-root'
  const prefix = options.prefix ?? 'takt-'
  const container = options.container
  const renamed = new Map()
  for (const name of collectKeyframeNames(css)) renamed.set(name, prefix + name)
  return processRules(css, { scope, prefix, renamed, container })
}

const WIDTH_FEATURE = String.raw`\(\s*(?:max|min)-width\s*:\s*[\d.]+(?:px|rem|em)\s*\)`
const WIDTH_ONLY_MEDIA = new RegExp(`^${WIDTH_FEATURE}(?:\\s+and\\s+${WIDTH_FEATURE})*$`, 'i')

/** `@media (max-width: 900px)` → `@container takt (max-width: 900px)`；带其它条件（hover、prefers-*、媒体类型）的保持原样。 */
export function mediaToContainer(condition, container) {
  const value = condition.trim()
  return WIDTH_ONLY_MEDIA.test(value) ? `@container ${container} ${value}` : undefined
}

export function collectKeyframeNames(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const names = new Set()
  const pattern = /@(?:-webkit-)?keyframes\s+([A-Za-z_][\w-]*)/g
  let match
  while ((match = pattern.exec(withoutComments)) !== null) names.add(match[1])
  return [...names]
}

function processRules(input, state) {
  let output = ''
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2)
      const stop = end === -1 ? input.length : end + 2
      output += input.slice(index, stop)
      index = stop
      continue
    }
    if (/\s/.test(char)) {
      output += char
      index += 1
      continue
    }
    if (char === '@') {
      const at = readPrelude(input, index)
      if (at.terminator === ';') {
        output += input.slice(index, at.end + 1)
        index = at.end + 1
        continue
      }
      const bodyEnd = findBlockEnd(input, at.end)
      const prelude = input.slice(index, at.end)
      const body = input.slice(at.end + 1, bodyEnd)
      output += transformAtRule(prelude, body, state)
      index = bodyEnd + 1
      continue
    }

    const rule = readPrelude(input, index)
    if (rule.terminator !== '{') {
      // 非法 CSS：原样保留，避免构建脚本吞掉内容。
      output += input.slice(index, rule.end + 1)
      index = rule.end + 1
      continue
    }
    const bodyEnd = findBlockEnd(input, rule.end)
    const selector = input.slice(index, rule.end)
    const body = input.slice(rule.end + 1, bodyEnd)
    output += `${transformSelectorList(selector, state.scope)} {${rewriteAnimations(body, state.renamed)}}`
    index = bodyEnd + 1
  }
  return output
}

function transformAtRule(prelude, body, state) {
  const match = /^@(-webkit-)?([\w-]+)\s*(.*)$/s.exec(prelude)
  if (match === null) return `${prelude}{${body}}`
  const webkit = match[1] === undefined ? '' : '-webkit-'
  const name = match[2]
  const rest = match[3]

  if (name === 'keyframes') {
    const original = rest.trim()
    const renamed = state.renamed.get(original) ?? `${state.prefix}${original}`
    return `@${webkit}keyframes ${renamed}{${rewriteAnimations(body, state.renamed)}}`
  }

  if (NESTED_AT_RULES.has(name)) {
    const rewritten = name === 'media' && state.container !== undefined ? mediaToContainer(rest, state.container) : undefined
    const head = rewritten === undefined ? prelude : rewritten + /\s*$/.exec(prelude)[0]
    return `${head}{${processRules(body, state)}}`
  }

  // @font-face / @page / @property 等：内部是声明或不可作用域化的内容，原样保留。
  return `${prelude}{${body}}`
}

function transformSelectorList(selectorText, scope) {
  return splitTopLevel(selectorText, ',')
    .map((selector) => transformSelector(selector, scope))
    .join(', ')
}

function transformSelector(selector, scope) {
  let value = selector.trim()
  if (value === '') return value

  value = value.replace(/:root(?![\w-])/g, scope)
  value = value.replace(/^(html|body)(?=[\s.#:[>+~]|$)/, scope)

  if (value === scope || value.startsWith(`${scope} `) || value.startsWith(`${scope}.`) || value.startsWith(`${scope}:`) || value.startsWith(`${scope}[`) || value.startsWith(`${scope}>`) || value.startsWith(`${scope}+`) || value.startsWith(`${scope}~`)) {
    return value
  }
  return `${scope} ${value}`
}

/** 按顶层分隔符拆分，括号/方括号/引号内的分隔符不拆。 */
export function splitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let quote = ''
  let paren = 0
  let bracket = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') paren += 1
    else if (char === ')') paren = Math.max(0, paren - 1)
    else if (char === '[') bracket += 1
    else if (char === ']') bracket = Math.max(0, bracket - 1)
    else if (char === separator && paren === 0 && bracket === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function rewriteAnimations(block, renamed) {
  if (renamed.size === 0) return block
  return block.replace(
    /(-{0,2}(?:webkit-)?animation(?:-name)?\s*:\s*)([^;{}]+)/g,
    (_full, property, value) => `${property}${rewriteAnimationValue(value, renamed)}`,
  )
}

function rewriteAnimationValue(value, renamed) {
  let result = value
  for (const [original, replacement] of renamed) {
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(original)}(?![\\w-])`, 'g')
    result = result.replace(pattern, replacement)
  }
  return result
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从 start 读取到顶层 `{` 或 `;`，返回终止符位置。 */
function readPrelude(input, start) {
  let quote = ''
  let paren = 0
  let bracket = 0
  for (let index = start; index < input.length; index += 1) {
    const char = input[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2)
      index = end === -1 ? input.length : end + 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') paren += 1
    else if (char === ')') paren = Math.max(0, paren - 1)
    else if (char === '[') bracket += 1
    else if (char === ']') bracket = Math.max(0, bracket - 1)
    else if ((char === '{' || char === ';') && paren === 0 && bracket === 0) {
      return { end: index, terminator: char }
    }
  }
  return { end: input.length - 1, terminator: '' }
}

/** openIndex 指向 `{`，返回匹配的 `}` 位置。 */
function findBlockEnd(input, openIndex) {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index]
    if (quote !== '') {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2)
      index = end === -1 ? input.length : end + 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return input.length - 1
}
