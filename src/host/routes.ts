import { VERSION } from '../version.js'
import type { HostContext } from './dsh-types.js'

/** ping 的响应体；S4 与客户端面板都用它确认宿主半已加载。 */
export interface PingPayload {
  ok: true
  version: string
}

/**
 * 注册只读 ping 路由。
 *
 * 调用方：宿主行 apply。
 * 时机：宿主加载时注册；ctx.effect 负责在卸载时注销（disposer 是异步的）。
 * 失败语义：dsh 的 connection.fetch.register 在路径不以 /api/ 开头或路径冲突时
 * 同步抛错，由宿主加载失败暴露，不吞掉。
 */
export function registerPingRoute(ctx: HostContext): void {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/taktflow.ping',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(): Promise<Response> {
          const payload: PingPayload = { ok: true, version: VERSION }
          return Response.json(payload)
        },
      }),
    'taktflow ping route',
  )
}
