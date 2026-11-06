/**
 * 空间工作流运行时加载的 `@taktflow/server` 入口。
 *
 * 通过 loader 的 module hook 解析到 `lib/server.js`；server 内部对
 * `@taktflow/workflow-source` 的依赖也由同一个 hook 映射到插件产物。
 */
export * from '@taktflow/server'
