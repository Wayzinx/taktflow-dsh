/**
 * e2e/checks.mjs 的类型声明，供 src/** 下的离线回归测试 import。
 * 只覆盖测试用到的公共形状；运行时行为以 checks.mjs 为准。
 */
export type CheckStatus = 'pass' | 'fail' | 'not-run'

export interface CheckItem {
  name: string
  status: CheckStatus
  detail?: unknown
}

export interface CheckList {
  checks: Map<string, CheckItem>
  failures: unknown[]
  mark: (name: string, status: CheckStatus, detail?: unknown) => void
  step: <T>(name: string, fn: () => Promise<T>, detailOf?: (value: T) => unknown) => Promise<T>
  check: <T>(name: string, fn: () => Promise<T>, detailOf?: (value: T) => unknown) => Promise<T | undefined>
}

export interface Verdict {
  ok: boolean
  failed: Array<{ name: string; status: CheckStatus; detail?: unknown }>
}

export interface Ratio {
  passed: number
  total: number
  ratio: number | null
}

export interface MetricRow {
  callId: string
  name: string
  action: string | undefined
  ok: boolean
  pending: boolean
  unknown: boolean
  isError: boolean
  code: string | undefined
  expectedNoSpace: boolean
  summary: string | undefined
}

export interface Metrics {
  totalCalls: number
  resolvedCalls: number
  succeededCalls: number
  pendingCalls: number
  unknownCalls: number
  errorCalls: number
  successRate: number | null
  resolvedSuccessRate: number | null
  firstCallCorrectByAction: Ratio
  firstCallCorrectByTool: Ratio
  firstCallBusinessOkByAction: Ratio
  firstCallBusinessOkByTool: Ratio
  calls: MetricRow[]
}

export interface NotificationRecord {
  id: string
  target: string | null
  text: string
}

export interface NotificationEvidence {
  queued: NotificationRecord[]
  admitted: NotificationRecord[]
  terminal: boolean
  texts: string[]
  samples: string[]
}

export function createCheckList(names: string[]): CheckList

export function verdictOf(input: {
  failure?: unknown
  failures: unknown[]
  checks: Map<string, CheckItem>
}): Verdict

export function computeMetrics(digest: {
  calls: Array<{ callId: string; name: string; args: Record<string, unknown> }>
  results: Map<string, { isError?: boolean; business?: Record<string, unknown>; text?: string }>
}): Metrics

export function notificationEvidence(
  records: unknown[],
  options: { requirementId: string; runId: string; terminalText?: string },
): NotificationEvidence
