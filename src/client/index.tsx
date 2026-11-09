import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { TaktflowEmbed, type ThemeHost } from '@taktflow/web/embed'
import { createDshSource } from './source.js'

/**
 * 客户端模块。
 *
 * dsh 的 web 壳通过 `window.__ModuleLoader__.load({ id: 'taktflow', factory })`
 * 加载本文件；factory 返回 `{ inject: ['slots'], apply }`。React 由宿主提供，
 * 构建时保持 external，不能打包第二份 React。
 */

/** 构建脚本注入的、已加 `.takt-root` 前缀的 CSS 文本。 */
declare const __taktflowCss: string

interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  /** 会话级 slot：按 sessionId 生成组件 props。 */
  inject?: (sessionId: string) => Record<string, unknown>
}

interface ClientContext {
  /** Cordis 的可选服务读取；uiWorkspace 用于打开子 Agent 会话。 */
  get?(name: string): unknown
  slots: {
    inject(name: string, body: () => Generator<unknown, void, unknown>): unknown
    register(options: SlotRegistration, component: (props: never) => ReactElement): unknown
  }
}

function TaktflowIcon(): ReactElement {
  return (
    <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M16 20h32M32 20v26" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <circle cx="16" cy="46" r="5" fill="currentColor" />
      <circle cx="48" cy="46" r="5" fill="currentColor" />
      <path d="M16 46h32" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

/** 宿主 ping：确认宿主半已加载，并拿到已打开的空间根（可以有多个）。 */
interface PingPayload {
  ok?: boolean
  version?: string
  spaces?: string[]
}

type PanelState =
  | { status: 'checking' }
  | { status: 'ready'; version?: string; spaces: string[] }
  | { status: 'failed'; detail: string }

const SPACE_KEY = 'taktflow.panel.space'
/** 记住上次在全局面板里看的空间；存储不可用（隐私模式等）时退回第一个空间。 */
function rememberedSpace(): string | undefined {
  try { return localStorage.getItem(SPACE_KEY) ?? undefined } catch { return undefined }
}
function rememberSpace(space: string): void {
  try { localStorage.setItem(SPACE_KEY, space) } catch { /* 记不住就下次再选 */ }
}
const spaceLabel = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root

/** dsh 把深色主题投影为 body[data-ds-dark-theme]；只读，不写任何全局属性。 */
const dshTheme: ThemeHost = {
  isDark: () => document.body.hasAttribute('data-ds-dark-theme'),
  subscribe(cb) {
    const observer = new MutationObserver(cb)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  },
}

/** apply 时记下的客户端上下文；只用来按需读取宿主的 uiWorkspace。 */
let clientCtx: ClientContext | undefined

/** 在 dsh 里打开某个会话；宿主没有 uiWorkspace 时返回 undefined（面板不显示“打开会话”）。 */
function hostOpenSession(): ((sessionId: string) => void) | undefined {
  const workspace = clientCtx?.get?.('uiWorkspace') as { openSession?(target: string): void } | undefined
  if (typeof workspace?.openSession !== 'function') return undefined
  return (sessionId) => workspace.openSession!(sessionId)
}

/** 把作用域化后的样式挂到 head，面板卸载时移除。 */
function useScopedStyle(): void {
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.taktflow = 'true'
    style.textContent = __taktflowCss
    document.head.append(style)
    return () => style.remove()
  }, [])
}

function Notice({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <div className="takt-panel">
      <header className="takt-header">
        <TaktflowIcon />
        <h2 className="takt-title">{title}</h2>
      </header>
      {children}
    </div>
  )
}

function TaktflowPanel(): ReactElement {
  useScopedStyle()
  const [state, setState] = useState<PanelState>({ status: 'checking' })
  const [picked, setPicked] = useState<string | undefined>(rememberedSpace)
  const [attempt, setAttempt] = useState(0)

  // 还没有空间时每 5 秒、有空间后每 15 秒再探测一次：Lead 在别的目录新建空间后，切换器里会出现。
  // 失败时也每 5 秒重试，避免一次瞬时网络错误把面板永久留在错误态。
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = (): void => {
      fetch('./api/taktflow.ping', { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = (await response.json()) as PingPayload
          if (body.ok !== true) throw new Error('宿主返回 ok=false')
          if (controller.signal.aborted) return
          const spaces = body.spaces ?? []
          setState({ status: 'ready', version: body.version, spaces })
          timer = setTimeout(probe, spaces.length === 0 ? 5000 : 15000)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setState({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
          timer = setTimeout(probe, 5000)
        })
    }
    probe()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [attempt])

  const retry = (): void => {
    setState({ status: 'checking' })
    setAttempt((n) => n + 1)
  }
  const spaces = state.status === 'ready' ? state.spaces : []
  const space = picked !== undefined && spaces.includes(picked) ? picked : spaces[0]
  const source = useMemo(() => (space ? createDshSource(space, { openSession: hostOpenSession() }) : undefined), [space])

  if (state.status === 'ready' && source && space) {
    // 外层容器保持稳定：空间数从 1 变多时只插入切换条，不把整个 embed 重新挂载。
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {spaces.length > 1 && (
          /* 作用域样式会给 .takt-root 设 100% 高度；切换条只占自身高度 */
          <div className="takt-root" style={{ flex: 'none', height: 'auto', minHeight: 0 }}>
            <label className="takt-spacebar">
              <span className="takt-spacebar-label">空间</span>
              <select className="takt-spacebar-select" value={space} onChange={(event) => { setPicked(event.target.value); rememberSpace(event.target.value) }} aria-label="切换空间">
                {spaces.map((root) => <option key={root} value={root} title={root}>{spaceLabel(root)}</option>)}
              </select>
              <span className="takt-spacebar-path" title={space}>{space}</span>
            </label>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <TaktflowEmbed key={space} source={source} theme={dshTheme} draftScope={space} />
        </div>
      </div>
    )
  }
  return (
    <div className="takt-root">
      {state.status === 'checking' && (
        <Notice title="Taktflow">
          <p className="takt-status takt-status--checking">
            <span className="takt-dot" aria-hidden="true" />
            正在连接宿主…
          </p>
        </Notice>
      )}
      {state.status === 'failed' && (
        <Notice title="Taktflow">
          <p className="takt-status takt-status--failed">
            <span className="takt-dot" aria-hidden="true" />
            宿主不可用：{state.detail}
          </p>
          <p className="takt-hint">5 秒后自动重试；也可以立即重试。确认插件已安装并重启过 App。</p>
          <button type="button" className="takt-retry" onClick={retry}>立即重试</button>
        </Notice>
      )}
      {state.status === 'ready' && (
        <Notice title="还没有打开的空间">
          <p className="takt-hint">
            新建一个会话，模式选 <b>taktflow</b>，工作目录选需求空间的根目录（含 <code>takt.config.json</code>），
            然后让 Lead 创建或绑定需求。空间打开后，这里会显示总览、需求、运行和待办。
          </p>
          <p className="takt-hint">插件版本 v{state.version ?? '?'}</p>
        </Notice>
      )}
    </div>
  )
}

/** `GET ./api/taktflow.session` 的结果：会话属于哪个空间、绑定了哪个需求。 */
interface SessionInfo {
  space?: string
  requirementId?: string
}

type SessionViewState =
  | { status: 'loading' }
  | { status: 'ready'; info: SessionInfo }
  | { status: 'failed'; detail: string }

/**
 * 会话 Tab（conversation.view）：需求群里直接看这个需求的产物、运行和待办。
 *
 * 绑定了需求就打开需求页；会话目录是空间但还没绑定就打开总览；都不是就给出引导。
 * 还没有空间时每 5 秒重查一次，Lead 初始化或绑定后自动切过去。
 */
function TaktflowSessionView({ sessionId }: { sessionId: string }): ReactElement {
  useScopedStyle()
  const [state, setState] = useState<SessionViewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const probe = (): void => {
      fetch(`./api/taktflow.session?${new URLSearchParams({ sessionId })}`, { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => {
          const body = (await response.json()) as { ok?: boolean; data?: SessionInfo; error?: { message?: string } }
          if (!response.ok || body.ok !== true) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
          if (controller.signal.aborted) return
          const info = body.data ?? {}
          setState({ status: 'ready', info })
          if (info.requirementId === undefined) timer = setTimeout(probe, 5000)
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setState({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
          timer = setTimeout(probe, 5000)
        })
    }
    probe()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, attempt])

  const retry = (): void => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }
  const info = state.status === 'ready' ? state.info : undefined
  const source = useMemo(() => (info?.space ? createDshSource(info.space, { openSession: hostOpenSession() }) : undefined), [info?.space])

  if (info && source) {
    // key：需求变化（刚绑定）或空间变化时重新挂载，让内存路由回到需求页且不串空间数据。
    const path = info.requirementId ? `/req/${encodeURIComponent(info.requirementId)}` : '/'
    return <TaktflowEmbed key={`${info.space}:${path}`} source={source} theme={dshTheme} initialPath={path} draftScope={`session:${sessionId}:${info.space}`} />
  }
  return (
    <div className="takt-root">
      {state.status === 'loading' && (
        <Notice title="Taktflow">
          <p className="takt-status takt-status--checking">
            <span className="takt-dot" aria-hidden="true" />
            正在读取会话…
          </p>
        </Notice>
      )}
      {state.status === 'failed' && (
        <Notice title="Taktflow">
          <p className="takt-status takt-status--failed">
            <span className="takt-dot" aria-hidden="true" />
            读取失败：{state.detail}
          </p>
          <p className="takt-hint">5 秒后自动重试；也可以立即重试。</p>
          <button type="button" className="takt-retry" onClick={retry}>立即重试</button>
        </Notice>
      )}
      {state.status === 'ready' && (
        <Notice title="这个会话还不是需求群">
          <p className="takt-hint">
            需求群是 <b>taktflow</b> 模式的会话，工作目录就是需求空间的根目录。新建会话时选 taktflow 模式和项目目录，
            然后对 Lead 说要做什么；它会初始化空间、创建需求，这里随后显示需求的产物、运行和待办。
          </p>
        </Notice>
      )}
    </div>
  )
}

/**
 * 客户端 apply。
 *
 * 调用方：dsh web 壳的 ModuleLoader。
 * 时机：插件客户端模块首次被加载时一次。
 * 失败语义：slots 不存在时 dsh 会让模块加载失败；不要在这里吞异常。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  clientCtx = ctx
  ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({ name: 'sidebar.panellist', id: 'taktflow', order: 30, label: 'Taktflow' }, TaktflowIcon)
  })
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'taktflow' }, TaktflowPanel)
  })
  // 会话 View Tab（和“对话 / 轨迹 / 上下文”同一排）。
  ctx.slots.inject('conversation.view', function* () {
    yield ctx.slots.register(
      { name: 'conversation.view', id: 'taktflow', order: 40, label: () => 'Taktflow', inject: (sessionId) => ({ sessionId }) },
      TaktflowSessionView,
    )
  })
}
