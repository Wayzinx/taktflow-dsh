/**
 * 未实现部件的统一失败方式。
 *
 * 这些部件由 执行层和 Lead 层 按冻结接口补全；在补全前必须显式失败，不能返回空结果或
 * 假成功，否则调用方会把“没做”当成“做完了”。
 */
export function notImplemented(part: string): never {
  throw new Error(`not implemented: ${part}（尚未实现，见 docs/02-技术方案.md）`)
}
