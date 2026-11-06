/**
 * 发布包的 workflow 校验子进程入口（lib/workflow-validation-runner.js）。
 *
 * 调用方：`src/host/workflow-validation.ts` 用 Node 24 原生 spawn 启动本文件，
 * 参数为待校验的 `.workflow.ts` 绝对路径；结果写 FD3 后立即退出。
 *
 * 为什么单独成子进程：workflow 顶层代码可能有副作用/计时器，不能在宿主进程内
 * evaluate。这里复用 `WorkflowFileLoader`，因此同样具备依赖闭包冻结、`.js`→`.ts`
 * 解析和 `@taktflow/*` 随包映射；不需要 tsx。
 *
 * 失败语义：任何加载/校验错误写 `{message, stack}` 到 FD3 并 exit 0，让父进程按
 * 原协议转成 diagnostics；只有写 FD3 本身失败才让进程以非零退出。
 */
import { writeSync } from 'node:fs'
import { defineWorkflow, snapshotWorkflow } from '@taktflow/core'
import { WorkflowFileLoader } from './workflows/loader.js'

try {
  const file = process.argv[2]
  if (file === undefined || file === '') throw new Error('缺少 workflow 文件参数')
  const loaded = await new WorkflowFileLoader().load(file)
  const snapshot = snapshotWorkflow(defineWorkflow(loaded.workflow))
  writeSync(3, JSON.stringify({ snapshot, diagnostics: [] }))
} catch (error) {
  writeSync(3, JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }))
}
// workflow 顶层代码可能注册计时器；快照返回后不让它拖住子进程。
process.exit(0)
