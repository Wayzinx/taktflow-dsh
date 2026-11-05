import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { checkClientBundle, extractRequires, CLIENT_REQUIRE_ALLOWLIST } from '../../scripts/checks.mjs'
import { buildClient } from '../../scripts/build-client.mjs'

const VALID_WRAPPER = `window.__ModuleLoader__.load({
  id: 'taktflow',
  factory(require) {
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    function apply() {}
    return { inject: ['slots'], apply };
  },
});`

describe('客户端 bundle 静态检查', () => {
  it('接受标准的 ModuleLoader 包装与白名单 require', () => {
    expect(checkClientBundle(VALID_WRAPPER)).toEqual([])
    expect(extractRequires(VALID_WRAPPER).sort()).toEqual(['react', 'react/jsx-runtime'])
  })

  it('拒绝宿主客户端包', () => {
    const code = VALID_WRAPPER.replace(
      "const React = require('react');",
      "const React = require('react'); const ui = require('@deepseek-ai/dsh-client-ui-primitives');",
    )
    expect(checkClientBundle(code).join('\n')).toContain('不在白名单')
    expect(checkClientBundle(code).join('\n')).toContain('宿主包引用')
  })

  it('识别 esbuild __require 和带后缀的 require helper', () => {
    expect(extractRequires("__require('bad-module'); __require2('react')")).toEqual(['bad-module', 'react'])
    expect(checkClientBundle(VALID_WRAPPER + "\n__require('bad-module')").join('\n')).toContain('不在白名单')
  })

  it('拒绝 ESM import/export 与缺失的 id', () => {
    const code = VALID_WRAPPER.replace("id: 'taktflow'", "id: 'other'").replace(
      'const React = require',
      "import x from 'react'; const React = require",
    )
    const problems = checkClientBundle(code).join('\n')
    expect(problems).toContain('id 必须是 taktflow')
    expect(problems).toContain('ESM import/export')
  })

  it('拒绝缺少 inject slots 的 factory', () => {
    const code = VALID_WRAPPER.replace("inject: ['slots']", 'inject: []')
    expect(checkClientBundle(code).join('\n')).toContain('inject 必须包含 slots')
  })
})

type Element = { type: unknown; props: Record<string, unknown> }
type Effect = () => void | (() => void)
type SlotOptions = { name: string; id?: string; key?: string }

// 测的是发布产物：和 build.mjs 用同一个打包函数（不压缩，便于定位）。
let bundle: string
beforeAll(async () => {
  bundle = (await buildClient({ minify: false })).wrapped
}, 60_000)

/**
 * 假 React：面板用到的 hook 单独实现，其余（web 页面模块加载时调用的 createContext、
 * forwardRef、memo 等）统一返回第一个参数，只要求加载阶段不抛错。
 */
function fakeReact(effects: Effect[], updateState: (value: unknown) => void): unknown {
  const hooks: Record<string, unknown> = {
    useEffect: (effect: Effect) => effects.push(effect),
    useState: (initial: unknown) => [initial, updateState],
    useMemo: (factory: () => unknown) => factory(),
  }
  return new Proxy(hooks, {
    get: (target, prop) => (typeof prop === 'string' && prop in target ? target[prop] : (value?: unknown) => value ?? {}),
  })
}

function loadClient() {
  const effects: Effect[] = []
  const updateState = vi.fn()
  const style = { dataset: {}, textContent: '', remove: vi.fn() }
  const document = { createElement: vi.fn(() => style), head: { append: vi.fn() } }
  const fetch = vi.fn((_url: string, _options: RequestInit) => Promise.resolve(Response.json({ ok: true, version: '0.0.0' })))
  let entry: { id: string; factory: (require: (specifier: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value: typeof entry) { entry = value } } },
    document, fetch, AbortController, URLSearchParams, setTimeout, clearTimeout,
  })
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props })
  const require = vi.fn((specifier: string): unknown => {
    if (specifier === 'react') return fakeReact(effects, updateState)
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
    if (specifier === 'react-dom') return { createPortal: (node: unknown) => node }
    throw new Error(`unexpected require: ${specifier}`)
  })
  const plugin = entry!.factory(require)
  const registrations: Array<{ options: SlotOptions; component: () => Element }> = []
  const disposers: Array<() => void> = []
  const slots = {
    inject(_name: string, body: () => Generator<() => void>) { disposers.push(...body()) },
    register(options: SlotOptions, component: () => Element) {
      const item = { options, component }
      registrations.push(item)
      return () => { registrations.splice(registrations.indexOf(item), 1) }
    },
  }
  return { entry, plugin, require, registrations, disposers, slots, effects, document, style, fetch, updateState }
}

/** 渲染主面板一次，返回 [样式 effect, ping effect]。 */
function mountPanel(client: ReturnType<typeof loadClient>): [Effect, Effect] {
  client.plugin.apply({ slots: client.slots })
  client.registrations.find(({ options }) => options.name === 'main')!.component()
  expect(client.effects).toHaveLength(2)
  return [client.effects[0]!, client.effects[1]!]
}

describe('真实客户端构建产物', () => {
  it('执行 ModuleLoader factory，外部模块从传入 require 解析，apply 注册正确插槽', () => {
    const client = loadClient()
    expect(checkClientBundle(bundle)).toEqual([])
    expect(client.entry?.id).toBe('taktflow')
    expect(client.plugin.inject).toEqual(['slots'])
    for (const [name] of client.require.mock.calls) expect(CLIENT_REQUIRE_ALLOWLIST).toContain(name)
    expect(client.document.createElement).not.toHaveBeenCalled()
    client.plugin.apply({ slots: client.slots })
    expect(client.registrations.map(({ options }) => options)).toEqual([
      { name: 'sidebar.panellist', id: 'taktflow', order: 30, label: 'Taktflow' },
      { name: 'main', key: 'taktflow' },
      expect.objectContaining({ name: 'conversation.view', id: 'taktflow', order: 40 }),
    ])
    const view = client.registrations.find(({ options }) => options.name === 'conversation.view')!.options as SlotOptions & { label: () => string; inject: (id: string) => unknown }
    expect(view.label()).toBe('Taktflow')
    expect(view.inject('session-1')).toEqual({ sessionId: 'session-1' })
    expect(client.document.createElement).not.toHaveBeenCalled()
    for (const dispose of client.disposers.reverse()) dispose()
    expect(client.registrations).toHaveLength(0)
  })

  it('面板挂载时注入作用域样式，卸载时移除', () => {
    const client = loadClient()
    const [styleEffect] = mountPanel(client)
    const dispose = styleEffect()
    expect(client.document.head.append).toHaveBeenCalledWith(client.style)
    expect(client.style.textContent).toContain('.takt-root')
    expect(client.style.textContent.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/(^|[\s,}]):root\b/)
    if (typeof dispose === 'function') dispose()
    expect(client.style.remove).toHaveBeenCalledTimes(1)
  })

  it('面板查询 ping；卸载会中止尚未完成的请求', async () => {
    const client = loadClient()
    const [, pingEffect] = mountPanel(client)
    const dispose = pingEffect()
    const [url, options] = client.fetch.mock.calls[0]!
    expect(url).toBe('./api/taktflow.ping')
    expect(options.credentials).toBe('same-origin')
    expect(options.signal?.aborted).toBe(false)
    if (typeof dispose === 'function') dispose()
    expect(options.signal?.aborted).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(client.updateState).not.toHaveBeenCalled()
  })

  it('ping 返回空间根时进入就绪状态，带上第一个空间', async () => {
    const client = loadClient()
    client.fetch.mockResolvedValueOnce(Response.json({ ok: true, version: '0.0.0', spaces: ['/w/space'] }))
    const [, pingEffect] = mountPanel(client)
    const dispose = pingEffect()
    await vi.waitFor(() => expect(client.updateState).toHaveBeenCalledWith({ status: 'ready', version: '0.0.0', space: '/w/space' }))
    if (typeof dispose === 'function') dispose()
  })

  it('ping真实响应内容决定状态，HTTP成功但ok=false也显示失败', async () => {
    const client = loadClient()
    client.fetch.mockResolvedValueOnce(Response.json({ ok: false }))
    const [, pingEffect] = mountPanel(client)
    const dispose = pingEffect()
    await vi.waitFor(() => expect(client.updateState).toHaveBeenCalledWith({ status: 'failed', detail: '宿主返回 ok=false' }))
    if (typeof dispose === 'function') dispose()
  })
})
