import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { checkClientBundle, extractRequires, wrapClientBundle, CLIENT_REQUIRE_ALLOWLIST } from '../../scripts/checks.mjs'
import { transformCss } from '../../scripts/css.mjs'

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

let bundle: string
beforeAll(async () => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL('./index.tsx', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: '__taktflowClient',
    jsx: 'automatic',
    external: [...CLIENT_REQUIRE_ALLOWLIST],
  })
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  bundle = wrapClientBundle(built.outputFiles[0]!.text, transformCss(css))
})

function loadClient() {
  const effects: Effect[] = []
  const updateState = vi.fn()
  const style = { dataset: {}, textContent: '', remove: vi.fn() }
  const document = { createElement: vi.fn(() => style), head: { append: vi.fn() } }
  const fetch = vi.fn((_url: string, _options: RequestInit) => Promise.resolve(Response.json({ ok: true, version: '0.0.0' })))
  let entry: { id: string; factory: (require: (specifier: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value: typeof entry) { entry = value } } },
    document, fetch, AbortController,
  })
  const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props })
  const require = vi.fn((specifier: string): unknown => {
    if (specifier === 'react') return { useEffect: (effect: Effect) => effects.push(effect), useState: (initial: unknown) => [initial, updateState] }
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
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

describe('真实客户端构建产物', () => {
  it('执行 ModuleLoader factory，外部模块从传入 require 解析，apply 注册正确插槽', () => {
    const client = loadClient()
    expect(checkClientBundle(bundle)).toEqual([])
    expect(client.entry?.id).toBe('taktflow')
    expect(client.plugin.inject).toEqual(['slots'])
    expect(client.require.mock.calls.map(([name]) => name).sort()).toEqual(['react', 'react/jsx-runtime'])
    expect(client.document.createElement).not.toHaveBeenCalled()
    client.plugin.apply({ slots: client.slots })
    expect(client.registrations.map(({ options }) => options)).toEqual([
      { name: 'sidebar.panellist', id: 'taktflow', order: 30, label: 'Taktflow' },
      { name: 'main', key: 'taktflow' },
    ])
    expect(client.document.createElement).not.toHaveBeenCalled()
    for (const dispose of client.disposers.reverse()) dispose()
    expect(client.registrations).toHaveLength(0)
  })

  it('面板挂载后查询ping；卸载会移除CSS并中止尚未完成的请求', async () => {
    const client = loadClient()
    client.plugin.apply({ slots: client.slots })
    client.registrations.find(({ options }) => options.name === 'main')!.component()
    const dispose = client.effects[0]!()
    expect(client.document.head.append).toHaveBeenCalledWith(client.style)
    expect(client.style.textContent).toContain('.takt-root')
    const [url, options] = client.fetch.mock.calls[0]!
    expect(url).toBe('./api/taktflow.ping')
    expect(options.credentials).toBe('same-origin')
    expect(options.signal?.aborted).toBe(false)
    expect(typeof dispose).toBe('function')
    if (typeof dispose === 'function') dispose()
    expect(options.signal?.aborted).toBe(true)
    expect(client.style.remove).toHaveBeenCalledTimes(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(client.updateState).not.toHaveBeenCalled()
  })

  it('ping真实响应内容决定状态，HTTP成功但ok=false也显示失败', async () => {
    const client = loadClient()
    client.fetch.mockResolvedValueOnce(Response.json({ ok: false }))
    client.plugin.apply({ slots: client.slots })
    client.registrations.find(({ options }) => options.name === 'main')!.component()
    const dispose = client.effects[0]!()
    await vi.waitFor(() => expect(client.updateState).toHaveBeenCalledWith({ status: 'failed', detail: '宿主返回 ok=false' }))
    if (typeof dispose === 'function') dispose()
  })
})
