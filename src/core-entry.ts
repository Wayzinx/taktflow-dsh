/**
 * 空间工作流运行时加载的 `@taktflow/core` 入口。
 *
 * 为什么单独打包：空间 `.workflow.ts` 里写 `import ... from '@taktflow/core'`，
 * 运行时由 module hook 解析到 `lib/core.js`。它必须和宿主 `lib/host.js` 共用
 * esbuild splitting 产生的同一份 core chunk，否则 `instanceof`、注册表等模块级
 * 状态会出现两份。构建后由单测验证导出的类/符号与宿主一致。
 */
export * from '@taktflow/core'
