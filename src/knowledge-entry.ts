/**
 * 空间工作流运行时加载的 `@taktflow/knowledge` 入口。
 *
 * 通过 loader 的 module hook 解析到 `lib/knowledge.js`；只提供 Node 运行时能力，
 * 不打包 web/cli 程序入口。
 */
export * from '@taktflow/knowledge'
