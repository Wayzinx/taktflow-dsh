export interface TransformCssOptions {
  /** 作用域选择器，默认 `.takt-root`。 */
  scope?: string
  /** keyframes 前缀，默认 `takt-`。 */
  prefix?: string
  /** 把只含宽度条件的 `@media` 改写成 `@container <container>`（嵌入时按面板宽度响应）。 */
  container?: string
}

export function transformCss(css: string, options?: TransformCssOptions): string

export function mediaToContainer(condition: string, container: string): string | undefined

export function collectKeyframeNames(css: string): string[]

export function splitTopLevel(text: string, separator: string): string[]
