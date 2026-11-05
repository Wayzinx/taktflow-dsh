/**
 * 包版本。构建脚本会校验它等于 package.json 的 version；ping 路由与客户端
 * 都从这里取，避免运行时读 package.json 时因打包路径不同而失败。
 */
export const VERSION = '0.0.0'
