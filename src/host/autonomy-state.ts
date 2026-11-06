/**
 * AI 自主代答的进程内活动登记（M-J 增量）。
 *
 * 为什么需要：通知器看到 `human.requested` 会立刻唤醒 Lead，但 full/checkpoints
 * 模式下普通 human 待办正在由 AI 处理，此时唤醒只会让人重复处理。通知器与
 * RunManager 可能被 esbuild 拆进不同 chunk，模块级 Map 不共享；这里用
 * `Symbol.for` 挂到 globalThis，保证同进程两份 bundle 也能看到同一份登记。
 *
 * 生命周期：RunManager 在调用 AI 前 begin，回答/升级/失败后 release；释放函数
 * 幂等。取消/卸载时由 RunManager 直接 abort 子会话，不依赖这里清理。
 */
const STATE_KEY = Symbol.for('taktflow.host.autonomy.driving')

interface DrivingState {
  /** key = `${spaceRoot}\0${requestId}`，value = 嵌套计数（重复 begin 不会提前清）。 */
  entries: Map<string, number>
}

function state(): DrivingState {
  const holder = globalThis as unknown as Record<symbol, DrivingState | undefined>
  let current = holder[STATE_KEY]
  if (current === undefined) {
    current = { entries: new Map() }
    Object.defineProperty(globalThis, STATE_KEY, { value: current, enumerable: false, configurable: true })
  }
  return current
}

function key(spaceRoot: string, requestId: string): string {
  return `${spaceRoot}\0${requestId}`
}

/** 标记某个待办正在被 AI 处理；返回的 release 可重复调用。 */
export function beginAutonomyAnswer(spaceRoot: string, requestId: string): () => void {
  const entries = state().entries
  const itemKey = key(spaceRoot, requestId)
  entries.set(itemKey, (entries.get(itemKey) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (entries.get(itemKey) ?? 1) - 1
    if (count <= 0) entries.delete(itemKey)
    else entries.set(itemKey, count)
  }
}

/** 通知器在收到 human.requested 时查询：true 表示先不要唤醒 Lead。 */
export function isAutonomyAnswering(spaceRoot: string, requestId: string): boolean {
  return (state().entries.get(key(spaceRoot, requestId)) ?? 0) > 0
}

/** 该空间是否有任何 AI 代答在途；用于初始状态通知的抑制。 */
export function hasAutonomyActivity(spaceRoot: string): boolean {
  const prefix = `${spaceRoot}\0`
  for (const itemKey of state().entries.keys()) if (itemKey.startsWith(prefix)) return true
  return false
}
