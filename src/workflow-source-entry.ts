/**
 * 空间工作流运行时加载的 `@taktflow/workflow-source` 入口。
 *
 * 通过 loader 的 module hook 解析到 `lib/workflow-source.js`；构建时其中的
 * `./validate.js` 会被替换成宿主适配模块，因此发布包不依赖 tsx 或 vendor 目录。
 */
export * from '@taktflow/workflow-source'
