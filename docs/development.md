# 开发说明

Taktflow 的 DeepSeek Harness 插件包。当前骨架提供**可加载的宿主骨架 + 冻结的内部接口 + S4 验证脚本**，不是可运行的 P0 流水线：空间注册表、插件注册与清理、ping 面板可用；运行/审批/通知等业务方法仍显式抛 `not implemented`。

## 包入口

| export | 文件 | 作用 |
| --- | --- | --- |
| `.` | `lib/host.js` | 宿主行：注册 `taktflow` 服务与 `GET /api/taktflow.ping` |
| `./lead` | `lib/lead.js` | Lead 行：提示词段与 bundled skill；Lead 层（M-D）注册工具 |
| `./role` | `lib/role.js` | 角色行：节点 Agent 的提示词段与 bundled skill |
| `./client` | `lib/client.js` | Web 客户端模块：侧边栏入口 + 主面板占位 |
| `./workflows/*` | `lib/workflows/*.js` | 工作流入口占位；调用 `loadP0DeliveryWorkflow()` 即抛错 |
| `./locale/*.json`、`./icon` | `locale/`、`icon.svg` | 文案与图标 |

`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中包含宿主行和 `taktflow` preset 行。安装方式：

```bash
npm run build
npm run pack:takt
dsh plugin --profile web add /absolute/path/to/taktflow-0.0.0.tgz
```

## 已实现

- **`SpaceRegistry`（真实实现）**：P0 只支持一个空间根。
  - `open(root)`：`root` 必须直接包含 `takt.config.json`；配置了 `spaces` 时只接受该根；同根 symlink 经 realpath 去重；第二个不同根抛 `TAKT_SPACE_ROOT_MISMATCH`；并发 `open` 串行化，失败不绑定根、可重试。
  - `forSession(cwd)`：`cwd` 必须正好是空间根；子目录抛 `TAKT_SPACE_ROOT_MISMATCH`，空间外抛 `TAKT_NO_SPACE`；不接受 `core.openProject` 的向上查找结果，也不隐式创建空间。
  - `roots()`：已解析的 realpath 根列表，P0 最多一个；未配置且尚未打开时为 `[]`。
- **宿主行生命周期**：`apply` 通过 `ctx.effect` 注册 `taktflow` 服务、ping 路由和 `runs.disposeAll` 清理；重复 dispose 幂等。
- **`taktflow.ping`**：`GET /api/taktflow.ping` 返回 `{ ok: true, version }`，只用于 S4 验证宿主是否加载。
- **Lead / Role 行**：注册固定提示词段和 `source: 'bundled'` 的 skill。Lead 只声明 6 个工具名，**不注册**工具；`approval_answer` 是人的动作，绝不暴露给 Lead。
- **客户端模块**：factory 返回 `{ inject: ['slots'], apply }`；面板样式在挂载时插入、卸载时移除，只使用宿主真实的 `--dsw-alias-*` token；ping 请求带 `AbortController`，卸载时取消。
- **构建**：`scripts/build.mjs` 产出 `lib/host.js`、`lib/lead.js`、`lib/role.js`、`lib/client.js`、`lib/workflows/*.js`，并做静态检查（宿主 bundle 不得裸导入 `@taktflow/*`、客户端只允许白名单外部依赖、CSS 前缀转换）。

## 尚未实现的业务

以下列的是冻结契约的目标行为，当前业务方法均抛 `not implemented`，不能当作已交付能力。`Ownership.hostOwner` 和 `RunManager.disposeAll()` 是例外：前者可读取宿主标识，后者已实现幂等清理。

- `Ownership`：租约、`hostOwner`（默认 `dsh:<hostId>`，与审计用户 `Config.user` 无关）、运行元数据、`endReason`。
- `RunManager`：`start` / `cancel` / `resume` / `get` / `onAnswered`；`requestKey` 去重，终态不可再改。
- `PermissionRegistry`：子 Agent 的 `writeScope` / `allowBash` / `readOnly`；未登记的 Agent 不受本插件守卫影响。
- `RolePresets`：按角色与 variant 租用 preset；越权抛 `TAKT_FORBIDDEN_FOR_LEAD`。
- `Bindings`：需求 ↔ 会话绑定，未绑定返回 `undefined`。
- `Approvals`：`present` 用 `ToolExecutionContext.agent` + `signal` 调 `ctx.userQuestions.ask`；`answer` 对已回答请求**幂等返回已有结果**，不抛错。
- `Notifier`：需求群聊/运行事件通知桥；`attach` / `detach` 幂等。
- `dsh-host` harness：`id: 'dsh-host'`（`dsh` 已被 CLI 适配器占用），`available()` 返回不可用，`run()` 抛 `not implemented`。

## `endReason` 语义

`EndReason.reason` 只有两个值：`lead_offline`、`host_lost`，表示离线或宿主丢失导致的非正常终止。成功、失败、人工取消是**运行状态本身**，不写进 `endReason`。`setEndReason` 对同一原因重复写入幂等；写入不同原因抛 `TAKT_RUN_BUSY`。终态运行不能再 `cancel` / `resume`。

## 冻结的内部接口

准确类型以 `src/host/types.ts` 为准；以下方法的参数和返回值是 执行层（M-C）、Lead 层（M-D）、客户端（M-F）的接线契约。`Space` 表示 `SpaceHandle`，`RunId` / `RequirementId` / `Actor` / `AttentionItem` / `RunState` 来自 core。

| 类型 | 字段或方法 |
| --- | --- |
| `SpaceHandle` | 只读 `root: string`、`stores: ProjectStores`、`insights: Insights` |
| `SpaceRegistry` | `open(root: string): Promise<Space>`；`forSession(cwd: string \| undefined): Promise<Space>`；`roots(): Promise<string[]>` |
| `EndReason` | `reason: 'lead_offline' \| 'host_lost'`；`at: string` |
| `RunOwnerMeta` | `owner: string`；`ownerSessionId: string`；`requestKey?: string`；`createdAt: string`；`presets?: Record<string, { id: string; cfgHash: string }>`；`endReason?: EndReason` |
| `Ownership` | 只读 `hostOwner: string`；`ensureLease(space): Promise<void>`；`release(space): Promise<void>`；`takeover(space, by: Actor): Promise<void>`；`recordRun(space, runId, meta: RunOwnerMeta): Promise<void>`；`readRun(space, runId): Promise<RunOwnerMeta \| undefined>`；`setEndReason(space, runId, endReason): Promise<void>` |
| `StartRunInput` | `space`、`requirementId`、`workflowId: string`、`args?: Record<string, unknown>`、`ownerSessionId: string`、`requestKey: string` |
| `RunManager` | `start(input: StartRunInput): Promise<{ runId: RunId; deduped: boolean }>`；`cancel(space, runId, by): Promise<void>`；`resume(space, runId, by): Promise<void>`；`get(space, runId): Promise<RunState \| undefined>`；`onAnswered(space, item: AttentionItem): Promise<void>`；`disposeAll(): Promise<void>` |
| `PermissionScope` | `childId: string`；`nodeRef: { runId: RunId; nodeId: string; attempt: number }`；`cwd: string`；`writeScope: string[]`；`allowBash: boolean`；`readOnly: boolean` |
| `PermissionRegistry` | `register(scope: PermissionScope): () => void`；`lookup(agentId: string): PermissionScope \| undefined` |
| `RolePresetHandle` | `id: string`；`cfgHash: string`；`release(): void` |
| `RolePresets` | `acquire(space, role: string, variant: { readOnly: boolean; allowBash: boolean }): Promise<RolePresetHandle>` |
| `Bindings` | `bind(space, requirementId, sessionId: string, by: Actor): Promise<void>`；`byRequirement(space, requirementId): Promise<string \| undefined>`；`bySession(space, sessionId: string): Promise<RequirementId \| undefined>` |
| `AnswerInput` | `requestId: string`；`attempt: number`；`artifactVersion?: number`；`decision?: string`；`answer?: string`；`by: Actor` |
| `Approvals` | `present(exec: ToolExecutionContext, space, requestId: string): Promise<void>`；`answer(space, input: AnswerInput): Promise<AttentionItem>` |
| `Notifier` | `attach(space): Promise<void>`；`detach(space): Promise<void>` |
| `TaktflowService` | `spaces`、`ownership`、`runs`、`permissions`、`presets`、`bindings`、`approvals`、`notifier`，分别使用上列接口 |
| `TaktToolError` | `extends Error`；`code: TaktErrorCode`；`hint?: string`；构造参数 `(code, message, hint?)` |

`TaktErrorCode` 为 `TAKT_NO_SPACE`、`TAKT_SPACE_ROOT_MISMATCH`、`TAKT_NOT_BOUND`、`TAKT_LEASE_HELD`、`TAKT_RUN_BUSY`、`TAKT_STALE_VERSION`、`TAKT_FORBIDDEN_FOR_LEAD`、`TAKT_UNSUPPORTED_NODE`。接口说明中的业务错误属于后续实现契约；当前占位统一报 `not implemented`。

与最早简报的命名差异：以 `EndReason` / `RunOwnerMeta.endReason` / `Ownership.setEndReason` 取代 `PauseInfo` / `pause` / `setPause`，因为 P0 离线和宿主丢失会终止运行，不能恢复；增加 `SpaceRegistry.roots()`、`StartRunInput` 和 `RolePresetHandle` 的显式类型。

## 后续接线

- **M-C**：实现 `dsh-host` harness、角色 preset 租用、权限守卫、所有权与运行生命周期；复用 core 租约，先登记 childId 权限再 `startActivation`，在全部终止路径释放资源。P0 不允许角色执行 shell。
- **M-D**：实现 Lead 六个工具、Bindings、Approvals、Notifier、业务 HTTP 路由和完整随包流程。`loadP0DeliveryWorkflow()` 当前直接抛 `not implemented`；计划流程为澄清 → 系分 → 人工审批 → 实现 → 测试 → 报告，尚未实现，不包含 review 节点。审批已回答时幂等返回，过期 attempt/产物版本拒绝。
- **M-F**：在当前 `sidebar.panellist` / `main` 槽位接入需求、运行与待办面板；使用内存路由和 `.takt-root` 作用域，不改宿主主题；API 失败显示错误，不回退 mock。样式、请求与槽位注册必须随卸载清理。

## 构建与单测

```bash
# 本仓库根目录（先 git submodule update --init）
npm run build
npm run typecheck
npm test

# 只打包（要求先 build；tarball 内含 README）
npm run pack:takt
```

## S4 隔离 profile e2e

脚本：`e2e/profile.mjs`、`e2e/boot.mjs`，共享工具在 `e2e/lib.mjs`。

```bash
export TAKT_E2E_BASE_URL=...   # 模型服务的 chat-completions base URL
export TAKT_E2E_MODEL=...      # 模型 id
export TAKT_E2E_API_KEY=...    # 仅通过进程环境传入
node e2e/profile.mjs
node e2e/boot.mjs
```

可选变量：

- `DSH_BIN`：dsh 可执行文件路径；缺省使用本机安装路径，再退回 PATH 里的 `dsh`。
- `TAKT_E2E_HOME`：隔离的 `DSH_HOME`；缺省为 `os.tmpdir()/taktflow-dsh-e2e`。

安全与清理约定：

- 地址通过 `baseURL: !!js process.env.TAKT_E2E_BASE_URL` 读取，key 仅用 `apiKeyEnv` 引用。token URL、cookie、认证 HTML 只在内存中处理；结果只保存断言摘要，完整 `--dump-config` 输出脱敏后存档。不要把密钥放进命令参数或仓库文件。
- `profile.mjs` 只在带所有权标记的目录里工作；先解析已存在祖先的 realpath，拒绝 `~/.dsh` 及其后代/祖先、符号链接绕过和非空且无标记的目录；清理时重复检查路径与标记。失败时清理本次创建的目录。
- `boot.mjs` 在 `finally` 中停止 dsh 进程组并清理隔离目录；全部断言、进程停止、目录清理与结果写入成功后才报告通过。HTTP 请求有超时，cookie 不跨 origin。
- 为读取 assistant 回复，e2e 在隔离 profile 里把 `session-persistence-jsonl` 设为 `compression: none`。这是**测试专用可观测性配置**，不影响正常 profile。

`profile.mjs` 内部构建并打包，安装后读回 `dsh.profile.bundles`，确认同时有 web bundle 与 `taktflow`。模型路由格式为 `models: [{ id: MODEL }]`，默认模型为 `{ provider: 'takt-e2e', model: MODEL }`。

`boot.mjs` 使用真实 Host RPC 信封 `{ type: 'client-request', rpcId, method, payload: { args } }`；`agentPresets/list` 的 args 为 `{}`，`read` 为 `{ agentPreset: 'taktflow' }`；`session/create` 和 `session/prompt` 的 args 必须包在 `{ request: ... }`。prompt 返回 accepted 后继续等会话 JSONL 中的 `assistant/message`，最终文本去空白、忽略大小写后必须确切等于 `pong`。用户消息或包含 pong 的其他句子都不能通过。

生成的 `e2e/out/profile-result.json`、`boot-result.json` 和脱敏配置是本地证据，不在 npm 包中。`boot.mjs` 另导出 `startHost({ home, dshBin, env })` 供独立 UI 检查使用，返回 `{ url, child, workspace, stop, unref }`；URL 只能在当前进程传给浏览器，调用方必须 finally `stop()` 和 `cleanupOwnedHome(home)`。自动 E2E 不证明浏览器面板渲染或主题隔离；这些需单独用浏览器检查。

2026-11-05 的 骨架验收已完成：dsh `0.2.1-rc.3` 下 profile **6/6**、boot **13/13**，真实 assistant 最终回复为 `pong`；独立浏览器 UI **8/8**，覆盖面板真实 ping `0.0.0`、主题 token、路径与根主题不变、卸载 style 清理、错误展示、恢复与 reload。UI 的 HTTP 503 来自浏览器 fetch 桩，只验证负例展示与恢复，不是服务器故障或真实模型验证；交互观察窗口内 `error` / `unhandledrejection` 为 0。

自动证据保留在 `e2e/out/api-run/`；UI 证据为 `e2e/out/ui-result.json` 和 `e2e/out/ui-panel.png`。两轮隔离目录已清理；UI 宿主无活动进程组成员，浏览器自动化会话已关闭。独立构建成功、类型检查无错误、8 个测试文件共 51 项测试通过，npm pack 清单检查通过。各层验证分别统计，不代表尚未实现的完整 P0 业务已通过。

逐项断言与证据说明见 `docs/dsh-plugin/spike-notes.md` 的 S4 小节。

- **代理**：dsh 用 Node `fetch` 统一走环境里的 HTTP(S) 代理，只有回环地址直连；`NO_PROXY` 里的网段写法（如 `10.0.0.0/8`）实测不生效。模型端点在代理之外时，要把**确切的主机名或 IP** 加进 `NO_PROXY`，否则请求会被送进代理、会话里一直没有 assistant 消息（2026-11-05 实测）。

## 已知限制

- 除 `SpaceRegistry` 外的服务都是占位；工作流不可执行，Lead 工具未注册。
- `dsh-host` harness 尚未实现，不能启动子 Agent。
- 客户端只有侧边栏入口和 ping 状态面板；需求群聊、运行详情、审批交互属于客户端（M-F）。
- 真实 e2e 需要可用的 chat-completions 端点和模型；缺少环境变量时脚本会直接报错，不会跳过。
