import { describe, expect, it } from 'vitest'
import { splitTopLevel, transformCss } from '../../scripts/css.mjs'

describe('CSS 作用域转换', () => {
  it('把 :root 改成作用域根', () => {
    expect(transformCss(':root { --x: 1px; }')).toBe('.takt-root { --x: 1px; }')
  })

  it('按顶层逗号拆分选择器，保留括号/引号里的逗号', () => {
    const result = transformCss('.a, .b:is(.c, .d), [data-x="e,f"] { color: red; }')
    expect(result).toBe('.takt-root .a, .takt-root .b:is(.c, .d), .takt-root [data-x="e,f"] { color: red; }')
    expect(splitTopLevel('.a, .b:is(.c, .d)', ',')).toEqual(['.a', ' .b:is(.c, .d)'])
  })

  it('递归处理嵌套 @media，并保留 from/to 关键帧选择器', () => {
    const result = transformCss('@media (max-width: 600px) { .a { color: red; } }')
    expect(result).toBe('@media (max-width: 600px) { .takt-root .a { color: red; } }')
  })

  it('重命名 keyframes 并重写 animation/animation-name 引用', () => {
    const css = [
      '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }',
      '.dot { animation: pulse 1.2s ease-in-out infinite; }',
      '.dot-slow { animation-name: pulse; }',
    ].join('\n')
    const result = transformCss(css)
    expect(result).toContain('@keyframes takt-pulse')
    expect(result).toContain('animation: takt-pulse 1.2s ease-in-out infinite')
    expect(result).toContain('animation-name: takt-pulse')
    expect(result).toContain('from { opacity: 0; }')
    expect(result).not.toContain('.takt-root from')
  })

  it('处理 html/body 选择器与嵌套 @supports', () => {
    const result = transformCss('html, body { margin: 0; } @supports (display: grid) { body .x { display: grid; } }')
    expect(result).toContain('.takt-root, .takt-root { margin: 0; }')
    expect(result).toContain('@supports (display: grid) { .takt-root .x { display: grid; } }')
  })

  it('保留注释且不把已作用域化的选择器再加一层前缀', () => {
    const result = transformCss('/* keep */\n.takt-root .a { color: red; }')
    expect(result).toBe('/* keep */\n.takt-root .a { color: red; }')
  })

  it('container 选项：只含宽度条件的 @media 改成按嵌入根宽度的 @container，其它媒体查询不动', () => {
    const css = [
      '@media (max-width: 900px) { .a { color: red; } }',
      '@media (min-width: 600px) and (max-width: 900px) { .b { color: red; } }',
      '@media (hover: hover) and (pointer: fine) { .c { color: red; } }',
      '@media (prefers-reduced-motion: reduce) { .d { color: red; } }',
    ].join('\n')
    const result = transformCss(css, { container: 'takt' })
    expect(result).toContain('@container takt (max-width: 900px) { .takt-root .a { color: red; } }')
    expect(result).toContain('@container takt (min-width: 600px) and (max-width: 900px) { .takt-root .b')
    expect(result).toContain('@media (hover: hover) and (pointer: fine) { .takt-root .c')
    expect(result).toContain('@media (prefers-reduced-motion: reduce) { .takt-root .d')
    expect(transformCss('@media (max-width: 900px) { .a { color: red; } }')).toContain('@media (max-width: 900px)')
  })
})
