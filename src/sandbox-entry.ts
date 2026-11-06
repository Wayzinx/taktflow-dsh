/**
 * 空间工作流运行时加载的 `@taktflow/sandbox` 入口。
 *
 * `taktflow-standard.integration.ts` 从 `@taktflow/sandbox` 取 RepoManager；
 * 同样通过 esbuild splitting 与宿主共享同一份 sandbox/core 模块实例。
 */
export * from '@taktflow/sandbox'
