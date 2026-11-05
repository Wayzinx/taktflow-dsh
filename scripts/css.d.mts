export interface TransformCssOptions {
  /** 作用域选择器，默认 `.takt-root`。 */
  scope?: string
  /** keyframes 前缀，默认 `takt-`。 */
  prefix?: string
}

export function transformCss(css: string, options?: TransformCssOptions): string

export function collectKeyframeNames(css: string): string[]

export function splitTopLevel(text: string, separator: string): string[]
