import path from 'node:path'
import { openProject } from '@taktflow/core'
import { TaktToolError, type SpaceHandle, type SpaceRegistry, type WorkflowCatalog } from '../host/types.js'
import { loadP0DeliveryWorkflow, P0_DELIVERY_ID, validateWorkflowForP0 } from './p0-delivery.js'
import { WorkflowFileLoader, type LoadedWorkflowFile } from './loader.js'

export { loadP0DeliveryWorkflow, P0_DELIVERY_ID, validateWorkflowForP0 } from './p0-delivery.js'
export { WorkflowFileLoader } from './loader.js'
export type { LoadedWorkflowFile, WorkflowLoaderOptions } from './loader.js'

/** 随包演示流程；id 固定，任何空间都能启动。 */
const P0_WORKFLOWS: Record<string, () => ReturnType<typeof loadP0DeliveryWorkflow>> = {
  [P0_DELIVERY_ID]: loadP0DeliveryWorkflow,
}

/** 空间流程目录的增量接口；旧调用方只依赖 ids/load。 */
export interface SpaceWorkflowCatalog extends WorkflowCatalog {
  /** 异步列出空间配置里的全部流程；takt_status 用它展示完整目录。 */
  list(space?: SpaceHandle): Promise<string[]>
  /** 空间配置里的第一个流程；没有空间或配置为空时回退 p0-delivery。 */
  defaultId(space?: SpaceHandle): Promise<string>
  /** 诊断/测试用：按文件加载并返回依赖闭包哈希。 */
  loadFile(file: string): Promise<LoadedWorkflowFile>
}

export interface WorkflowCatalogOptions {
  /** 测试注入；生产按宿主 bundle 位置自动找 lib/core.js。 */
  loader?: WorkflowFileLoader
  coreEntry?: string
  sandboxEntry?: string
}

/**
 * 空间流程目录。
 *
 * 调用方：宿主行创建服务门面；RunManager 在 start / resume 时按 id 加载；
 * Lead 的 takt_status 用 list() 展示“空间流程 + 演示流程”。
 * 时机：每次 list/defaultId/load 都重新 openProject 读取 `takt.config.json` 的
 * workflows 并交给 loader；loader 只按依赖闭包内容哈希缓存，因此配置顺序、
 * 文件内容或相对依赖变化都会生效，不会用进程启动时的旧目录。
 * 运行开始时 RunManager 复制流程定义，运行中的热替换不会影响已启动运行。
 * 失败语义：未知 id、重复 id、非 `.workflow.ts` 入口、与演示流程 id 冲突都抛
 * TAKT_UNSUPPORTED_NODE；流程模块自身语法/校验错误原样上抛（不静默降级）。
 */
export function createWorkflowCatalog(
  spaces?: SpaceRegistry,
  options: WorkflowCatalogOptions = {},
): SpaceWorkflowCatalog {
  const loader = options.loader ?? new WorkflowFileLoader({
    ...(options.coreEntry === undefined ? {} : { coreEntry: options.coreEntry }),
    ...(options.sandboxEntry === undefined ? {} : { sandboxEntry: options.sandboxEntry }),
  })
  let knownIds: string[] = [P0_DELIVERY_ID]

  const catalog: SpaceWorkflowCatalog = {
    ids: () => [...knownIds],
    async list(space?: SpaceHandle) {
      if (spaces === undefined) return [P0_DELIVERY_ID]
      const roots = space === undefined ? await spaces.roots() : [space.root]
      const ids = [P0_DELIVERY_ID]
      for (const root of roots) {
        const files = await ensureLoaded(root)
        for (const item of files) if (!ids.includes(item.workflow.id)) ids.push(item.workflow.id)
      }
      knownIds = ids
      return [...ids]
    },
    async load(workflowId: string, space?: SpaceHandle): Promise<ReturnType<typeof loadP0DeliveryWorkflow>> {
      // 只认自有键：constructor / __proto__ 等原型链名字也按未知流程处理。
      const bundled = Object.hasOwn(P0_WORKFLOWS, workflowId) ? P0_WORKFLOWS[workflowId] : undefined
      if (bundled !== undefined) {
        const workflow = bundled()
        validateWorkflowForP0(workflow)
        return workflow
      }
      if (spaces === undefined) throw unknownWorkflow(workflowId, [P0_DELIVERY_ID])
      const roots = space === undefined ? await spaces.roots() : [space.root]
      const matches: LoadedWorkflowFile[] = []
      for (const root of roots) {
        const files = await ensureLoaded(root)
        for (const item of files) if (item.workflow.id === workflowId) matches.push(item)
      }
      if (matches.length === 0) throw unknownWorkflow(workflowId, await catalog.list(space))
      if (matches.length > 1) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `流程 id 在多个空间重复：${workflowId}`,
          `涉及的模板：${matches.map((item) => item.file).join('、')}；请只保留一份或改名。`,
        )
      }
      return matches[0]!.workflow
    },
    async defaultId(space?: SpaceHandle) {
      if (spaces === undefined) return P0_DELIVERY_ID
      const roots = space === undefined ? await spaces.roots() : [space.root]
      for (const root of roots) {
        // 配置损坏或流程导入失败必须上抛：静默回退演示流程会让用户以为跑了空间流程。
        const files = await ensureLoaded(root)
        // 设置页 / Lead 设的默认流程优先（route.defaultWorkflow），否则取登记的第一个。
        const preferred = (await openProject(root)).config.route?.defaultWorkflow
        if (preferred !== undefined && files.some((item) => item.workflow.id === preferred)) return preferred
        if (files.length > 0) return files[0]!.workflow.id
      }
      return P0_DELIVERY_ID
    },
    loadFile: (file) => loader.load(file),
  }

  /**
   * 每次调用都重新读磁盘配置；loader 自己按闭包哈希复用，不在这里缓存目录。
   * 这样 start/resume/status 看到的是当前 `takt.config.json`，而不是第一次打开时
   * 的顺序。
   */
  async function ensureLoaded(root: string): Promise<LoadedWorkflowFile[]> {
    const stores = await openProject(root)
    const entries = stores.config.workflows
    if (!Array.isArray(entries)) throw new Error(`空间配置 workflows 必须是数组：${root}`)
    const files: LoadedWorkflowFile[] = []
    const seen = new Map<string, string>()
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`空间配置 workflows 含空路径：${root}`)
      const file = path.resolve(root, entry)
      if (!file.endsWith('.workflow.ts')) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `空间流程入口必须是 .workflow.ts：${entry}`,
          '把 takt.config.json 的 workflows 改成模板文件路径，或删掉该项。',
        )
      }
      const result = await loader.load(file)
      // 空间流程声明演示流程 id 会让 load(id) 永远返回随包版本；必须在目录阶段拒绝。
      if (result.workflow.id === P0_DELIVERY_ID) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `空间流程不能使用演示流程 id：${P0_DELIVERY_ID}`,
          `请修改 ${result.file} 的 id，避免与随包演示流程混淆。`,
        )
      }
      const previous = seen.get(result.workflow.id)
      if (previous !== undefined) {
        throw new TaktToolError(
          'TAKT_UNSUPPORTED_NODE',
          `空间流程 id 重复：${result.workflow.id}`,
          `涉及的文件：${previous}、${result.file}；请改名或只保留一份。`,
        )
      }
      seen.set(result.workflow.id, result.file)
      files.push(result)
    }
    return files
  }

  return catalog
}

function unknownWorkflow(id: string, available: readonly string[]): TaktToolError {
  return new TaktToolError(
    'TAKT_UNSUPPORTED_NODE',
    `未知流程：${id}`,
    `可用流程：${available.join(', ')}`,
  )
}
