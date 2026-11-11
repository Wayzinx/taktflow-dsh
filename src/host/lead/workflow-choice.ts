import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { readJsonFile, toJsonText, withFileLock, writeFileAtomic, type Actor } from '@taktflow/core'
import { workflowStore } from '@taktflow/server'
import type { SpaceHandle } from '../types.js'

/**
 * 选流程：用户点名 > 默认流程（用户在流程列表设的偏好）> Lead 判断默认不合适再换。
 *
 * 往重了换（更完整的流程、更多评审）Lead 自己决定，只要写明原因；比默认流程少评审 / 门禁 / 交付校验的流程
 * 要用户当场同意，同一需求同一流程同意一次后记在 `.takt/dsh/workflow-consents.json`，不再重复问。
 * 真实事故：Lead 三次以“标准流程不合适”为由自建流程，三个都比默认少检查，其中一个的交付校验根本跑不起来。
 */

const GATE_KINDS: ReadonlyArray<readonly [label: string, key: keyof GateCounts, pattern: RegExp]> = [
  ['评审节点', 'reviews', /\breview\(\s*\{/g],
  ['门禁 / 交付校验节点', 'gates', /\bgate\(\s*\{/g],
  ['acceptance 交付校验', 'acceptance', /\bkind:\s*['"]acceptance['"]/g],
]

export interface GateCounts { reviews: number; gates: number; acceptance: number }

/** 流程源码里的质量关口数（按 DSL 调用计数；辅助文件里定义的节点数不到，只会让比较偏保守）。 */
export function gateCounts(source: string): GateCounts {
  const counts: GateCounts = { reviews: 0, gates: 0, acceptance: 0 }
  for (const [, key, pattern] of GATE_KINDS) counts[key] = source.match(pattern)?.length ?? 0
  return counts
}

/** after 比 before 少了哪些质量关口：评审节点、门禁节点、acceptance 交付校验。 */
export function droppedGates(before: string, after: string): string[] {
  const a = gateCounts(before)
  const b = gateCounts(after)
  return GATE_KINDS.filter(([, key]) => b[key] < a[key]).map(([label, key]) => `${a[key] - b[key]} 个${/^[A-Za-z]/.test(label) ? ' ' : ''}${label}`)
}

export interface WorkflowChoice {
  id: string
  title: string
  default: boolean
  /** 流程自己写的适用场景；没写时为 null。 */
  useWhen: string | null
  /** 空间里没有源码文件（内置演示流程）时为 null。 */
  checks: GateCounts | null
  /** 比默认流程少了哪些质量关口；非空时 Lead 选它要先征得用户同意。 */
  lighterThanDefault: string[]
  /** Lead 新建的流程：什么时候、为什么建的（原因里带需求号）。 */
  createdByLead: { at: string; reason: string | null } | null
}

/** 流程文件的绝对路径：WorkflowSummary.file 是相对 workflows 目录上一级的路径（legacy 空间是 .takt）。 */
export function workflowFilePath(space: SpaceHandle, file: string): string {
  return path.resolve(path.dirname(space.stores.paths.workflows), file)
}

/** 读一个流程的源码；不存在或读不到时 undefined（调用方按“比不出来”处理）。 */
export async function workflowSource(space: SpaceHandle, id: string): Promise<string | undefined> {
  const summary = (await workflowStore(space.stores).list({ record: false })).find((item) => item.id === id)
  if (summary === undefined) return undefined
  return await readFile(workflowFilePath(space, summary.file), 'utf8').catch(() => undefined)
}

/**
 * 可运行流程（ids，按空间登记顺序）的选择信息。只读：不登记外部修订、不拿租约。
 * defaultId 是这次省略 workflow 时会用的流程。
 */
export async function workflowChoices(space: SpaceHandle, ids: readonly string[], defaultId: string | undefined): Promise<WorkflowChoice[]> {
  const summaries = new Map((await workflowStore(space.stores).list({ record: false })).map((item) => [item.id, item]))
  const sources = new Map<string, string>()
  for (const id of ids) {
    const summary = summaries.get(id)
    const source = summary === undefined ? undefined : await readFile(workflowFilePath(space, summary.file), 'utf8').catch(() => undefined)
    if (source !== undefined) sources.set(id, source)
  }
  const base = defaultId === undefined ? undefined : sources.get(defaultId)
  return ids.map((id) => {
    const summary = summaries.get(id)
    const source = sources.get(id)
    const author = summary?.createdBy?.author
    return {
      id,
      title: summary?.title ?? id,
      default: id === defaultId,
      useWhen: summary?.useWhen ?? null,
      checks: source === undefined ? null : gateCounts(source),
      lighterThanDefault: id === defaultId || base === undefined || source === undefined ? [] : droppedGates(base, source),
      createdByLead: author?.type === 'agent' && author.role === 'lead'
        ? { at: summary!.createdBy!.at, reason: summary!.createdBy!.reason ?? null }
        : null,
    }
  })
}

// ------------------------------------------------------------------ 同意记录

interface Consent {
  requirementId: string
  workflowId: string
  /** 同意时这个流程比默认少的关口；之后流程或默认变了、少的不一样了，要重新问。 */
  dropped: string[]
  reason: string
  by: Actor
  at: string
}
interface ConsentFile { version: 1; consents: Consent[] }

function consentFile(space: SpaceHandle): string {
  return path.join(space.stores.taktDir, 'dsh', 'workflow-consents.json')
}

async function readConsents(file: string): Promise<ConsentFile> {
  const raw = await readJsonFile<ConsentFile>(file)
  if (raw === undefined) return { version: 1, consents: [] }
  if (raw.version !== 1 || !Array.isArray(raw.consents)) throw new Error(`流程同意记录结构不合法：${file}`)
  return raw
}

const sameDrops = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index])

/** 这个需求是否已经同意过用这个（比默认少同样关口的）流程。 */
export async function hasConsent(space: SpaceHandle, requirementId: string, workflowId: string, dropped: readonly string[]): Promise<boolean> {
  const { consents } = await readConsents(consentFile(space))
  return consents.some((item) => item.requirementId === requirementId && item.workflowId === workflowId && sameDrops(item.dropped, dropped))
}

/** 记下用户这次的同意；调用方已经确认持有空间租约。 */
export async function recordConsent(space: SpaceHandle, entry: Omit<Consent, 'at'>): Promise<void> {
  const file = consentFile(space)
  await withFileLock(file, async () => {
    const state = await readConsents(file)
    state.consents = state.consents.filter((item) => !(item.requirementId === entry.requirementId && item.workflowId === entry.workflowId))
    state.consents.push({ ...entry, dropped: [...entry.dropped], at: new Date().toISOString() })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFileAtomic(file, toJsonText(state))
  })
}
