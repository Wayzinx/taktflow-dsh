# 开发说明

Taktflow 的 DeepSeek Harness 插件包。P0 已接通宿主、Lead 工具、随包角色、真实子 Agent、审批、通知、业务面板和随包 `p0-delivery` 流程；隔离 web profile 下的真实 dsh + 真实模型端到端已通过（见文末 P0 e2e）。P1（从节点重跑、产物回退、配方指纹、归因视图）仍未实现。

## 包入口

| export | 文件 | 作用 |
| --- | --- | --- |
| `.` | `lib/host.js` | 宿主行：注册 `taktflow` 服务与 `GET /api/taktflow.ping` |
| `./lead` | `lib/lead.js` | Lead 行：提示词段、bundled skill 与 `takt_*` 工具 |
| `./role` | `lib/role.js` | 角色行：节点 Agent 的提示词段与 bundled skill |
| `./client` | `lib/client.js` | Web 客户端模块：侧边栏入口、需求/运行/审批面板 |
| `./workflows/*` | `lib/workflows/*.js` | 随包流程：`p0-delivery` 澄清 → 系分 → 人工审批 → 实现 → 测试 → 报告 |
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
- **Lead / Role 行**：注册固定提示词段和 `source: 'bundled'` 的 skill；Lead 行同时注册 `takt_*` 工具。`approval_answer` 是人的动作，绝不暴露给 Lead。
- **随包角色**：`src/roles/defaults.ts` 内嵌 analyst / architect / dev / reporter 的 frontmatter 文本，由 esbuild 打入 `lib/*.js` 构建产物（共享 chunk，不保证固定文件名）。四个角色都是 `harness: dsh-host`、`allowBash: false`；dev 的 writeScope 与 `p0-delivery` 的 `src/**` 一致。空间 `.takt/agents/<role>.md` 存在时覆盖随包默认；角色目录/文件 symlink、文件名与 role 不一致、重复角色都拒绝，不静默回退。
- **`takt_requirement init`**：在可信会话 cwd 初始化空间，复制缺失的默认角色（不覆盖用户档案）；已有空间幂等，子目录、祖先空间、与已绑定根冲突、symlink/特殊路径都在写盘前拒绝。与 `SpaceRegistry.open` 共用可重入的写锁，避免 init→open 自死锁和并发初始化竞争。
- **Lead 工具**：`takt_status`、`takt_requirement`（init/create/bind）、`takt_artifact`（list/read/log/write）、`takt_run`（start/cancel/get）、`takt_trace`（audit）、`takt_ask_human`。身份只取 dsh 可信上下文；结果统一 `{ ok, summary, next_actions, error? }`，render 同时给一行摘要和完整 JSON。
- **执行层**：`DshRunManager` 固定开始时的工作流/角色/知识源，`requestKey` 去重；子 Agent 先登记权限再启动；取消、Lead 离线、宿主丢失、等待审批、恢复身份校验都有测试。`dsh-host` harness 使用真实 dsh 子会话。
- **审批与通知**：`takt_ask_human` 用 blocking waterfall 呈现原生问题卡片；`Approvals.answer` 校验 attempt、节点状态、冻结产物版本，已回答幂等；`Notifier` 通过 `agent.followup` / `agent.inject` 推送 `[taktflow]` 消息和状态快照。
- **客户端模块**：factory 返回 `{ inject: ['slots'], apply }`；面板样式在挂载时插入、卸载时移除，只使用宿主真实的 `--dsw-alias-*` token；请求带 `AbortController`，卸载时取消。
- **构建**：`scripts/build.mjs` 产出 `lib/host.js`、`lib/lead.js`、`lib/role.js`、`lib/client.js`、`lib/workflows/*.js`，并做静态检查（宿主 bundle 不得裸导入 `@taktflow/*`、客户端只允许白名单外部依赖、CSS 前缀转换）。

## 未覆盖 / P1

- `update` / `import_link`、`diff` / `revert` / `comment`、`rerun_from` / `dispatch` / `ask`、`coverage` / `why` / `compare` 等 action 返回明确的 P1 提示。
- 多空间、跨需求批量操作不在 P0 范围；P0 只支持一个空间根和一个会话绑定一个需求。
- P0 所有角色都没有 shell；测试由流程里的 `script` 节点执行。强杀后的失效租约仍需人工确认接管。
- 流程没有 review 节点；`p0-delivery` 固定为澄清 → 系分 → 人工审批 → 实现 → 测试 → 报告。
- 面板覆盖项目、需求、运行、待办和产物；P1 的归因/回退视图尚未实现。

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

`TaktErrorCode` 为 `TAKT_NO_SPACE`、`TAKT_SPACE_ROOT_MISMATCH`、`TAKT_NOT_BOUND`、`TAKT_LEASE_HELD`、`TAKT_RUN_BUSY`、`TAKT_STALE_VERSION`、`TAKT_FORBIDDEN_FOR_LEAD`、`TAKT_UNSUPPORTED_NODE`。工具层在冻结码之外增加 `TAKT_INVALID_INPUT`、`TAKT_UNSUPPORTED_ACTION`、`TAKT_INTERNAL`，统一转成结构化错误返回给模型。

与最早简报的命名差异：以 `EndReason` / `RunOwnerMeta.endReason` / `Ownership.setEndReason` 取代 `PauseInfo` / `pause` / `setPause`，因为 P0 离线和宿主丢失会终止运行，不能恢复；增加 `SpaceRegistry.roots()`、`StartRunInput` 和 `RolePresetHandle` 的显式类型。

## 接线结果

- **M-C（执行层）**：`dsh-host` harness、角色 preset 租用、权限守卫、所有权与运行生命周期已接通；复用 core 租约，先登记 childId 权限再 `startActivation`，在全部终止路径释放资源。P0 不允许角色执行 shell。
- **M-D（Lead 层）**：六个 `takt_*` 工具、Bindings、Approvals、Notifier、业务 HTTP 路由和随包 `p0-delivery` 流程已接通；流程为澄清 → 系分 → 人工审批 → 实现 → 测试 → 报告，不包含 review 节点。审批已回答时幂等返回，过期 attempt/产物版本拒绝。
- **M-F（客户端）**：在 `sidebar.panellist` / `main` 槽位接入项目、需求、运行、待办与产物面板；使用内存路由和 `.takt-root` 作用域，不改宿主主题；API 失败显示错误，不回退 mock。样式、请求与槽位注册随卸载清理。

## 构建与单测

```bash
# 本仓库根目录（先 git submodule update --init）
npm run build
npm run typecheck
npm test

# 只打包（要求先 build；tarball 内含 README）
npm run pack:takt
```

## 隔离 profile e2e

脚本：`e2e/profile.mjs`、`e2e/boot.mjs`、`e2e/p0.mjs`，审批卡片 helper 为 `e2e/answer-ws.mjs`，共享工具在 `e2e/lib.mjs`。

```bash
export TAKT_E2E_BASE_URL=...   # 模型服务的 chat-completions base URL
export TAKT_E2E_MODEL=...      # 模型 id
export TAKT_E2E_API_KEY=...    # 仅通过进程环境传入
node e2e/profile.mjs
node e2e/boot.mjs
node e2e/p0.mjs                # 完整 P0：初始化 → 建需求 → 启动 → 审批 → 产物/测试/审计/面板/通知
```

可选变量：

- `DSH_BIN`：dsh 可执行文件路径；缺省使用本机安装路径，再退回 PATH 里的 `dsh`。
- `TAKT_E2E_HOME`：隔离的 `DSH_HOME`；缺省为 `os.tmpdir()/taktflow-dsh-e2e`。
- `TAKT_E2E_REUSE_PROFILE=1`：复用上次成功安装的隔离 profile；目录失效或所有权标记不匹配时自动重新安装。
- `TAKT_E2E_P0_TIMEOUT_MS`：P0 e2e 总超时，默认 20 分钟。
- `TAKT_E2E_WS_TIMEOUT_MS`：等待审批卡片的 WebSocket 超时，默认 120 秒。

安全与清理约定：

- 地址通过 `baseURL: !!js process.env.TAKT_E2E_BASE_URL` 读取，key 仅用 `apiKeyEnv` 引用。token URL、cookie、认证 HTML 只在内存中处理；结果只保存断言摘要，完整 `--dump-config` 输出脱敏后存档。不要把密钥放进命令参数或仓库文件。
- `profile.mjs` 只在带所有权标记的目录里工作；先解析已存在祖先的 realpath，拒绝 `~/.dsh` 及其后代/祖先、符号链接绕过和非空且无标记的目录；清理时重复检查路径与标记。失败时清理本次创建的目录。
- `boot.mjs` 在 `finally` 中停止 dsh 进程组并清理隔离目录；全部断言、进程停止、目录清理与结果写入成功后才报告通过。HTTP 请求有超时，cookie 不跨 origin。
- 为读取 assistant 回复，e2e 在隔离 profile 里把 `session-persistence-jsonl` 设为 `compression: none`。这是**测试专用可观测性配置**，不影响正常 profile。

`profile.mjs` 内部构建并打包，安装后读回 `dsh.profile.bundles`，确认同时有 web bundle 与 `taktflow`。模型路由格式为 `models: [{ id: MODEL }]`，默认模型为 `{ provider: 'takt-e2e', model: MODEL }`。

`boot.mjs` 使用真实 Host RPC 信封 `{ type: 'client-request', rpcId, method, payload: { args } }`；`agentPresets/list` 的 args 为 `{}`，`read` 为 `{ agentPreset: 'taktflow' }`；`session/create` 和 `session/prompt` 的 args 必须包在 `{ request: ... }`。prompt 返回 accepted 后继续等会话 JSONL 中的 `assistant/message`，最终文本去空白、忽略大小写后必须确切等于 `pong`。用户消息或包含 pong 的其他句子都不能通过。

生成的 `e2e/out/profile-result.json`、`boot-result.json` 和脱敏配置是本地证据，不在 npm 包中。`boot.mjs` 另导出 `startHost({ home, dshBin, env })` 供独立 UI 检查使用，返回 `{ url, child, workspace, stop, unref }`；URL 只能在当前进程传给浏览器，调用方必须 finally `stop()` 和 `cleanupOwnedHome(home)`。自动 E2E 不证明浏览器面板渲染或主题隔离；这些需单独用浏览器检查。

2026-11-05 的验收分三层统计：骨架 profile **6/6**、boot **13/13**（真实 assistant 最终回复 `pong`）；独立浏览器 UI **8/8**（面板真实 ping、主题 token、路径边界、卸载清理、错误展示与恢复）；P0 业务端到端 **25/25**（最终批次 23:09–23:16 北京时间，真实 dsh + 真实模型，隔离 web profile）。P0 批次覆盖空间初始化、需求创建、运行启动、原生审批卡片、六个节点、产物版本、真实代码改动、`npm test`、事件链审计、面板读取、会话通知和 Lead 工具指标，详见 `docs/spike-notes.md` 的 P0 端到端小节。最终批次 8 次 Lead 工具调用中 7 次业务成功、1 次预期 `TAKT_NO_SPACE`；6 条通知均完成 `agent/inbox/spliced` 插入与 `user/message.id` 配对，并观察到 `运行结束：succeeded`。

P0 判定是 fail-closed：任何 check `fail` / `not-run` 或显式异常都让进程非零退出；通知必须有真实会话投递证据，状态快照只作诊断；Lead 指标以全部 `takt_*` 调用为分母，pending/unknown 单列。P0 证据为 `e2e/out/p0-result.json`（最终批次另存 `e2e/out/p0-result-20261105-150916-final.json`）；自动安装证据保留在 `e2e/out/api-run/`，UI 证据为 `e2e/out/ui-result.json` 和 `e2e/out/ui-panel.png`。隔离目录在批次结束后清理；结果只保存脱敏摘要。各层验证分别统计；P0 e2e 通过代表主路径可用，不代表 P1 能力已实现。

逐项断言与证据说明见 `docs/spike-notes.md` 的 S1/S2 与 P0 端到端小节。

- **代理**：dsh 用 Node `fetch` 统一走环境里的 HTTP(S) 代理，只有回环地址直连；`NO_PROXY` 里的网段写法（如 `10.0.0.0/8`）实测不生效。模型端点在代理之外时，要把**确切的主机名或 IP** 加进 `NO_PROXY`，否则请求会被送进代理、会话里一直没有 assistant 消息（2026-11-05 实测）。

## 已知限制

- P0 只支持一个空间根和一个会话绑定一个需求；多空间、跨需求批量操作属于 P1。
- P0 所有角色都没有 shell；代码改动由 `dsh-host` 子 Agent 完成，测试由流程的 `script` 节点执行。
- `update` / `import_link` / `diff` / `revert` / `comment` / `rerun_from` / `dispatch` / `ask` / `coverage` / `why` / `compare` 等 action 尚未实现，会返回 P1 提示。
- 流程没有 review 节点；强杀后的失效租约仍需人工确认接管。
- 真实 e2e 需要可用的 chat-completions 端点和模型；缺少环境变量时脚本会直接报错，不会跳过。模型偶尔会在 create 后结束回合，Lead prompt 已要求同一回合继续 start，e2e 另保留自然语言 follow-up 兜底。
