/**
 * 空间工作流运行时加载的 `@taktflow/harness` 入口。
 *
 * 空间流程可能直接使用 harness 包（例如自定义子 Agent 适配器）。通过 loader 的
 * module hook 解析到 `lib/harness.js`，与宿主共用同一份 core 模块实例；不要求
 * 用户空间安装 taktflow 依赖。
 */
export * from '@taktflow/harness'
