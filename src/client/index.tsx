import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

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
  label?: string
}

interface ClientContext {
  slots: {
    inject(name: string, body: () => Generator<unknown, void, unknown>): unknown
    register(options: SlotRegistration, component: () => ReactElement): unknown
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

interface PingState {
  status: 'checking' | 'ok' | 'failed'
  version?: string
  detail?: string
}

function TaktflowPanel(): ReactElement {
  const [ping, setPing] = useState<PingState>({ status: 'checking' })

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.taktflow = 'true'
    style.textContent = __taktflowCss
    document.head.append(style)
    const controller = new AbortController()
    fetch('./api/taktflow.ping', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = (await response.json()) as { ok?: boolean; version?: string }
        if (body.ok !== true) throw new Error('宿主返回 ok=false')
        if (!controller.signal.aborted) setPing({ status: 'ok', version: body.version })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setPing({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      controller.abort()
      style.remove()
    }
  }, [])

  return (
    <div className="takt-root">
      <div className="takt-panel">
        <header className="takt-header">
          <TaktflowIcon />
          <h2 className="takt-title">Taktflow</h2>
        </header>
        <p className="takt-hint">宿主状态</p>
        <p className={`takt-status takt-status--${ping.status}`}>
          <span className="takt-dot" aria-hidden="true" />
          {ping.status === 'checking' ? '正在检查宿主…' : null}
          {ping.status === 'ok' ? `宿主可用 · v${ping.version ?? '?'}` : null}
          {ping.status === 'failed' ? `宿主不可用：${ping.detail ?? '未知错误'}` : null}
        </p>
      </div>
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
  ctx.slots.inject('sidebar.panellist', function* () {
    yield ctx.slots.register({ name: 'sidebar.panellist', id: 'taktflow', order: 30, label: 'Taktflow' }, TaktflowIcon)
  })
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: 'taktflow' }, TaktflowPanel)
  })
}
