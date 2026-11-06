# dsh 插件 spike 记录

## S4：隔离 profile 启动与 Host RPC

状态：**骨架阶段的 S4 自动 E2E 与独立浏览器 UI 验收通过**。2026-11-05 使用 dsh `0.2.1-rc.3` 和当前工作区打出的 `taktflow@0.0.0` 完成真实安装：profile **6/6**、boot **13/13**、浏览器自动化 UI **8/8**。这是当时最小 ping 面板的验收；完整 P0 工作流与业务面板后来已端到端通过，见文末 P0 小节。

### 环境与证据

运行环境变量为 `TAKT_E2E_BASE_URL`、`TAKT_E2E_MODEL`、`TAKT_E2E_API_KEY`、`DSH_BIN`；地址和密钥不记录。本次通过父 Python 进程读取认证来源并构造子进程环境，密钥未进入 argv 或仓库文件，然后顺序执行：

```bash
node e2e/profile.mjs
node e2e/boot.mjs
```

使用默认 `<os.tmpdir()>/taktflow-dsh-e2e`，未操作用户 `~/.dsh`。profile 安装后读取 `profiles/web/package.json`，bundles 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`taktflow`；配置前后均执行完整 `--dump-config` 并脱敏存档。当前 profile 的 `baseURL` 是 `!!js process.env.TAKT_E2E_BASE_URL` 表达式，密钥仅由 `apiKeyEnv: TAKT_E2E_API_KEY` 引用。

本次自动 E2E 的证据固定保留在 `e2e/out/api-run/`（不在 npm 包内）；根 `out/` 已用于独立 UI profile，不作为自动 E2E 批次证据：

- `profile-result.json`：2026-11-05T09:08:48.459Z 创建，6 项通过。
- `boot-result.json`：2026-11-05T09:08:51.056Z 至 09:09:00.222Z，13 项通过。
- `profile-config-before.yml`、`profile-config.yml`：完整脱敏配置。
- `state.json`：隔离目录与 profile 元数据，不含密钥或地址；boot 完成后其目录已删除，不能直接再次启动。

### 自动断言结果

| 断言 | 状态 | 真实读回 |
| --- | --- | --- |
| 构建并打 tgz、安装插件、安装后 bundle 读回、前后 dump-config、写路由配置 | PASS，6/6 | web 与 taktflow bundle 同时存在；当前产物真实安装 |
| 启动 URL | PASS | `--profile web --port 0 --no-open` 返回 launch token URL，仅内存处理 |
| 认证交换 | PASS | 303 一次、cookie 数 1、最终页面 200、最终 URL 无 token |
| boot payload | PASS | 71 entries、3 batches |
| taktflow client 条目 | PASS | id `taktflow`，rev `80bcabf3817b`，inject sidebar |
| client bundle | PASS | 按页面提供的完整 URL 请求，响应 6592 字节；包含模块包装与 taktflow id |
| ping | PASS | `{ ok: true, version: '0.0.0' }` |
| preset list | PASS | 5 个 preset，包含 taktflow，无 broken 字段 |
| preset read | PASS | taktflow 内容非空，778 字符，无 broken 字段 |
| session create | PASS | standard preset，独立 sessionId，cwd 为隔离 workspace |
| session prompt | PASS | accepted=true |
| assistant pong | PASS | 从该 session 的真实 `assistant/message` 读到最终文本 `pong`，精确匹配 |
| 停止 dsh 进程组 | PASS | finally 中发信号并轮询确认进程组消失 |
| 清理隔离目录 | PASS | finally 删除自建目录，独立读回确认目录不存在 |

自动结果之外，另做 8 项针对脚本边界的本地验证：用户 `.dsh` 后代及祖先 symlink 拒绝、cleanup 不跟随 home symlink、正常目录清理、跨 origin 重定向未把 cookie 传到另一服务器、HTTP 超时、user 消息不当 assistant、assistant 文本提取。它们是测试工具验证，不计为产品 E2E 通过项。执行后扫描上述 5 个证据文件，密钥/地址值、认证 HTML、未脱敏 launch token 均无命中。

### 接口与踩坑

- 首次 `dsh plugin --profile web add <tgz>` 会初始化 profile；不能只看退出码，必须读回 `dsh.profile.bundles`。用户 patch 是 `$DSH_HOME/profiles/web/cordis.patch.yml` 的顶层 YAML 数组。
- `dsh-llm-pi-ai` 的 `models` 实际是 `[{ id: MODEL }]`；default-model 配置是 `{ provider: 'takt-e2e', model: MODEL }`。这里遵循实际包 README，修正简报中 `models: [MODEL]` 的简写。
- Host RPC 信封为 `{ type: 'client-request', rpcId, method, payload: { args } }`，响应为 `{ type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }`，端点为 `/api/<method>`。
- `agentPresets/list` 的 args 为 `{}`；read 为 `{ agentPreset: 'taktflow' }`。`session/create` 与 `session/prompt` 按真实 metadata 参数名使用 `{ request: { ... } }`，不能把 request 字段直接放在 args 下。
- `session/prompt` 只返回 accepted。隔离 profile 将 `session-persistence-jsonl.compression` 设为 `none`，递归找到 session JSONL，核对 header.id 后只读 `assistant/message` 的 `data.message.content[].text`。去空白、忽略大小写后必须确切为 `pong`；用户 prompt 或 “not pong” 不会通过。
- 客户端 URL 带宿主提供的批加载查询及 revision，必须完整使用 boot entry URL，不能手拼 `/plugins/taktflow/client.js`。摘要只保留无 query 的资源路径。
- 认证 HTML、boot payload、cookie 和 launch URL 不落盘；结果步骤默认不序列化返回对象。HTTP 请求有超时，cookie 绑定 origin，跨 origin 重定向直接拒绝。结果文件再做一遍脱敏。
- prepare 与 cleanup 都解析最近已存在祖先的 realpath，拒绝用户 `.dsh` 的后代、祖先和 symlink 绕过；cleanup 校验目录与普通文件标记。没有保留认证现场的开关。
- `ok=true` 需要全部业务断言、进程停止和目录清理通过；结果写入失败也以非零退出，不能输出 passed。

### 浏览器 UI 验收

调度方 使用 浏览器自动化 和另一轮隔离 profile 完成 **8/8** 项验收，时间为 2026-11-05T09:20:34.557Z。证据为 `e2e/out/ui-result.json` 与 `e2e/out/ui-panel.png`，不与自动模型验证合并统计。

| 断言 | 状态 | 观察结果 |
| --- | --- | --- |
| 打开 taktflow 面板 | PASS | 面板真实请求 ping，显示版本 `0.0.0` |
| 宿主主题 token | PASS | 所需 token 存在并用于实际渲染 |
| 路径与根主题 | PASS | 面板交互未改变宿主路径或根主题 |
| 面板卸载 | PASS | 切到插件页后，面板注入的 style 已移除 |
| API 失败展示 | PASS，浏览器侧模拟 | fetch 桩返回 HTTP 503，面板显示错误且无 mock 回退 |
| API 恢复 | PASS | 移除模拟、恢复真实 API 后 ping 成功 |
| reload 后持久安装读回 | PASS | 页面 reload 后重新打开面板，真实 ping 仍成功 |
| 运行时错误观察 | PASS | 本次交互观察窗口内 `error` / `unhandledrejection` 计数为 0 |

HTTP 503 是浏览器 fetch 桩构造的负例，只验证错误展示与恢复；没有制造服务器故障，也不作为真实模型调用证据。真实模型回复 `pong` 的证据仍来自前面的自动 boot 批次。

UI 清理已完成：浏览器自动化会话已关闭；宿主已收到 SIGTERM，进程组中的活动成员为 0；残留 defunct 条目没有执行能力；隔离目录 `/tmp/taktflow-dsh-skeleton-ui` 已删除。`ui-result.json.cleanup` 已记录宿主停止、目录删除与浏览器空间关闭。

### 独立构建与测试验收

调度方 独立执行 `npm run build` 成功，`npm run typecheck` 无错误，`npm test` 为 **8 个测试文件、51 项测试通过**；`npm pack` 产物清单检查通过。这些是构建和单测结果，分别记录，不计入真实 E2E 或 UI 的通过数。

### 交付边界

自动验证证明安装、宿主加载、客户端资源发现、preset 解析与真实模型路由可用；独立浏览器 验证证明最小面板能渲染、遵守主题和路径边界、展示 API 错误并恢复、卸载样式并在 reload 后继续工作。骨架阶段未实现 RunManager 业务、所有权/权限/审批/通知业务、Lead 工具和完整随包流程；`loadP0DeliveryWorkflow()` 当前直接抛 `not implemented`。这些由 M-C / M-D / M-F 后续接线，S1 / S2 / S3 和完整 P0 业务验收不在本次结果中。（历史记录：后续 P0 端到端已覆盖完整主路径，见文末 P0 小节。）

### 补充（2026-11-05，独立仓库复跑）

- **代理**：dsh 用 Node `fetch` 统一走环境里的 HTTP(S) 代理，只有回环地址直连；`NO_PROXY` 里的网段写法（如 `10.0.0.0/8`）实测不生效。模型端点在代理之外时，要把**确切的主机名或 IP** 加进 `NO_PROXY`，否则请求会被送进代理、会话里一直没有 assistant 消息（2026-11-05 实测）。

独立仓库（taktflow 以子模块引用）下复跑：profile 6/6、boot 13/13。

## S3：审批、HTTP 路由与集成验证

状态：**S3 宿主半实现与定向测试通过**。审批与路由使用真实 core stores / engine，集成测试使用 mock harness；**不是真实 dsh 宿主的端到端验收**，真实问题卡片与运行唤醒仍需在宿主接线后验证。

### 实现范围

- `src/host/approvals.ts`：`createApprovals` 工厂，保留 `PlaceholderApprovals` 兼容尚未接线的 `host/index.ts`。
  - `present` 只接受当前存活的根 Agent，透传 `exec.signal`；没有 `userQuestions` 服务时返回带主面板提示的结构化错误。
  - 卡片显示待办冻结的产物路径与版本，并从运行快照读取直接下游节点，写明批准后实际会执行的步骤；打回文案如实说明 core 当前把节点记为失败、运行结束，不会自动回到上一步。
  - 只接受与本卡片 `id` 匹配的答案；取消、跳过、超时、空答案、未知选项混合都不算批准，运行保持等待。
  - `answer` 必须带 `attempt`，核对冻结 attempt、节点当前状态、同一节点最新待办以及全部冻结 subject 的最新版本（`checkAnswerFreshness`）；只有显式 `approve` 才推进。
  - 同一实例的并发回答在进程内串行；跨工厂/跨进程用空间 `.takt` 下的审批守卫文件锁包住“重读 + freshness + 落账”，`onAnswered` 在锁外执行，避免与引擎写锁嵌套。
  - 全部异步 freshness 读取完成后、`attention.answer` 紧前在锁内再 `ensureLease` 一次：避免读取期间租约被释放、CLI 接管后本宿主仍继续写入。
  - 只有真正写入的那一次调用 `runs.onAnswered`，重复回答幂等返回且不重复唤醒。
- `src/host/routes.ts`：`registerRoutes(ctx, service, config?)`，内部包含 `registerPingRoute`。
  - `GET /api/taktflow?space=&p=` 只读，委托 api-core；`GET` 永远不会分派写操作。
  - `POST /api/taktflow.op` 白名单固定为 `attention.answer`、`run.start`、`run.cancel`、`lease.release`；方法不是 `POST` 时直接 405。
  - 所有写入口（包括直接 dispatch 与 api-core 的 `withWriteLease`）共用同一租约包装器；租约被 CLI 或其它宿主占用时返回 409。
  - `attention.answer` 调用同一个 `approvals.answer`，`by` 固定为配置里的 `user` 与 `via: 'dsh-web'`，忽略客户端伪造的 `by`。
  - `run.start` 的 `ownerSessionId` 只从绑定表 `bindings.byRequirement` 推导；客户端显式传值必须与绑定一致，未绑定或冲突返回 404；`workflowId` 缺省为 `p0-delivery`。
  - `lease.release` 遇到 `running` 或 `waiting_human` 的运行都返回 409：待人运行仍可能被审批唤醒，必须先完成或取消运行再释放租约，避免释放后本宿主继续写、CLI 同时接管。
  - `GET /api/taktflow.stream?space=&run=` 支持 `Last-Event-ID` 与 `after` 重放；请求 abort、`reader.cancel()`、宿主卸载都会清理订阅与心跳；`ready` 阻塞期间发生 abort 或宿主卸载时直接返回 204，不再创建流和心跳。
  - `events.ready` 的真实失败（坏事件日志、历史读取错误）先记录取消状态再 `finish()`，只有确实 abort/卸载才返回 204，否则交给 `errorResponse` 返回安全 500；SSE 测试用 `vi.fn` 包装真实 `stores.events.subscribe`，分别断言 `reader.cancel()`、请求 abort、宿主卸载和 ready 期间 abort 的 `unsubscribe` 恰好一次。
  - 空间只接受已注册根：先 `realpath` 再精确比较；未知动作、缺参数和业务错误都返回稳定 JSON 错误，不泄露堆栈或本地路径。
- `src/host/s3-fixture.ts` 与 `src/host/s3-integration.test.ts`：真实 core stores/engine + mock harness + 真实 approvals/routes + bindings；绑定表统一用 `agent.id`（与 `session.header.id` 相同）作为会话身份，`session.header` 带空间根 `cwd` 与 `agentPreset: 'taktflow'`，S3 通过 A 的真实 `registerLeadTools` 调用 `takt_ask_human.execute`，不是直接调用 `approvals.present`；`TestRunManager` 只负责 `requestKey` 幂等与引擎恢复，用 inflight Promise 按 `space.root + ownerSessionId + requestKey` 去重，不代表真实执行层；CLI 租约通过 core `acquireLease`/`releaseLease` 真实占用。

### 定向测试结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/host/approvals.test.ts` | 29 项通过 |
| `npx vitest run src/host/routes.test.ts` | 29 项通过 |
| `npx vitest run src/host/s3-integration.test.ts` | 13 项通过 |

S3 集成覆盖：重复 `start` 与两个并发路由 `run.start` 都按 `requestKey` 只执行一次真实 core 引擎；没有批准不推进；真实 `takt_ask_human.execute` 卡片批准与面板路由批准都落到同一个 `approvals.answer` 实例（spy 断言工具与路由各调用一次，`via` 分别为 `dsh:user-questions` 与 `dsh-web`）；重复回答不重复 `onAnswered`；打回使节点和运行失败且不执行下游；取消后待办记为 `cancelled` 且不能再推进；冻结 attempt 过期与多 subject 任一版本过期都拒绝；CLI 真实占用租约时工具与路由写入口都拒绝；非根/失效 Agent 不能弹卡片；坏事件日志走 SSE 时返回安全 500 且订阅只清理一次；审批阻塞在 `latestSubjectRefs` 读取时 `lease.release` 返回 409、CLI 无法接管，解除阻塞后批准正常落账并推进。

### 交付边界

- 本节的“通过”是真实 core + mock harness 的集成结果，**不是真实 dsh 端到端**：真实问题卡片的呈现、真实宿主唤醒、真实 CLI/宿主租约交接仍需在 `host/index.ts` 接线后验证。
- `host/index.ts` 目前仍使用 `PlaceholderApprovals` 且只注册 ping；真实接线方式为 `createApprovals({ ctx, ownership, runs, config })` + `registerRoutes(ctx, service, config)`，`service.approvals` 必须是同一个实例。
- S3 只覆盖真实 `takt_ask_human` 这一条 Lead 工具执行路径；其余 Lead 工具、通知桥和随包 P0 流程不在本节范围。
- `TestRunManager` 是测试替身：并发去重与真实 core 执行次数只能证明该替身的契约，**不代表 M-C 执行层已验收**。
- 租约释放限制：只要空间里还有 `running` 或 `waiting_human` 的运行，`lease.release` 就返回 409；需要先完成或取消这些运行，再释放租约。

## S1：真实子 Agent 生命周期与取消

状态：**最终批次 15/15 通过**，包含 12 项业务与 3 项安装/清理断言；FAIL/BLOCKED/NOT_RUN 均为 0。执行时间为 2026-11-05 21:28:22–21:29:40（北京时间），`sourceChanged=false`，执行后再次核对当前源码无差异。安装包 SHA256 为 `eb413f050c9c6ef13530a867849064cd3ec8e42c9ac47b03f6fe58dc20f982df`。

2026-11-05，使用 dsh `0.2.1-rc.3`、当前源码构建的安装包，在自建 `DSH_HOME` 的 web profile 运行 `node e2e/s1-s2.mjs`。模型配置只从环境变量传入；临时探针仅在 `TAKTFLOW_DEBUG_ROUTES=1` 时注册，生成在隔离 profile 中，不进入安装包。测试使用真实宿主服务、core 存储及引擎、真实模型与子 Agent，流程为单个 `dsh-host` 节点。

联合验收账本固定包含 **12 项业务断言与 3 项安装/清理断言**。最终批次的完整结果见 `e2e/out/s12-result.json`；其中保存安装包 SHA256、11 个执行层源文件在构建前/打包后/执行后的 SHA256、真实运行状态、owner 元数据、事件、子 Agent 及文件摘要。只有 `sourceChanged=false` 的批次才能证明本次实际安装对应最终源码。首批缺陷与修复后的复跑证据分别保留在 `s12-first-attempt.json` 和 `s12-second-attempt.json`；它们不替代最终批次。

| 断言 | 结果与证据 |
| --- | --- |
| 正常完成 | 模型自主调用 `write`，`allowed/model.txt` 内容回读为 `S12_MODEL_OK`；run 为 succeeded |
| 预留身份与清理 | 发布通知时权限已登记；预留 childId、真实 `agent.id`、session header.id、`harness.started.sessionId` 相同；结束后 Agent 与权限登记均消失，start/end 各一条 |
| 幂等启动 | 相同 requestKey 返回原 runId，`deduped=true`，没有重复派发 |
| 发布后立即取消 | run 变为 cancelled，本批没有发布 child；覆盖启动准备与实际派发之间的取消窗口 |
| 执行中取消 | 先观察真实模型成功写入，再取消；取消返回后没有活动 child，权限已释放、生命周期事件配对；1.5 秒观察窗内文件内容摘要不变 |
| Lead 离线 | 销毁真实 Lead 的 AgentHandle，确认 `agents.get` 不再返回该 Agent；随后启动得到 cancelled，owner.endReason 为 lead_offline，没有发布 child |
| 常驻 runner 作为 parent | 原 Lead 已销毁后，另建并持有独立 AgentHandle，以它作为 parent 完成真实子节点与写入。只证明当前宿主 API 可行，没有更改产品的 Lead 归属策略 |
| 在途进程退出 | 真实模型写入后向隔离宿主发 SIGTERM；退出后从磁盘读到 cancelled、host_lost，lease 文件不存在；CLI 自然退出码 0，没有 SIGKILL；强杀不算优雅退出通过 |
| 插件 live 卸载 | 重启隔离宿主并启动在途节点，`pluginManager/setPluginEnabled` 返回 `application=applied`；宿主服务真实消失，运行 cancelled(host_lost)，child/权限/租约均清理，文件观察窗内稳定 |
| 环境清理 | finally 停止本次宿主进程组并删除带所有权标记的隔离目录；未操作用户自己的 profile |

首次真实执行发现“取消先落盘、旧引擎随后开始调度”的竞态：事件出现 `run.finished` 后仍继续 `node.started`。执行层增加取消意图，在调度事件与 harness 入口再次检查，修复后真实发布前取消与执行中取消均复跑。这一发现来自真实宿主，不能用原先通过的单元测试替代。

dsh 的顶层 `ctx.effect` 在卸载时并行清理；宿主接线把注册放入同一个外层 effect，先等待运行停止及租约释放，再清理服务、路由与守卫。macOS 对已退出进程组的存在性查询可能返回 EPERM，测试驱动只针对本次持有的 PGID 读回活动成员，不能据此操作其它宿主。

## S2：默认权限下的写入边界

状态：**通过**，纳入 S1/S2 固定 15 项账本，不重复累加分母。

与 S1 同一隔离批次。真实 child 的 `sandboxPolicy.resolve` 回读为 **workspace-write**，没有开启 Full access。scope 内的模型自主写入由 `tools/result` 与文件内容共同证明；负例通过真实 child 身份调用 `ctx.tools.execute`，经过真实工具管线与宿主守卫，**不冒充模型自主负例调用**。

| 断言 | 结果与证据 |
| --- | --- |
| scope 内写入 | 模型自主写入与额外工具管线写入都成功 |
| scope 外、父目录逃逸 | `other/forbidden.txt`、`../outside/forbidden.txt` 均被守卫拒绝，目标文件不存在 |
| symlink 逃逸与组合路径 | 链接指向空间外、`allowed/link/../forbidden.txt` 解析到同空间非授权目录，均被拒绝；目标文件不存在 |
| 工作目录旁路 | 全局继承的 `working_directory` 实际出现在 child 工具列表；带 `cd` 的变更被拒绝，避免真实工具使用动态 cwd 绕过登记范围 |
| 只读角色 | 真实工具列表没有 write/edit；工具管线写入被拒绝，文件不存在，模型会话正常结束 |
| shell 与派发工具 | child 与 Lead 的实际工具列表没有 bash、pwsh 或 subagent/team/workflow 等派发工具；管线额外调用 bash/pwsh 也被守卫拒绝 |
| 动态 preset | 运行中 `agentPresets.list` **能看到**动态 preset；最后一个引用释放后已注销。当前 dsh 无隐藏字段，不能承诺运行时不出现在模式列表 |

官方工具契约为 `write` / `edit` 的 `file_path`，守卫按 `exec.agent.id` 匹配。`dsh-fs-local` 在 POSIX 下保留 symlink 后 `..` 的物理父目录语义：先 `path.resolve` 会把目标算错。同步守卫使用 `realpathSync.native`，不存在文件逐级解析最近已有父目录；穿越不存在父目录、悬空或循环链接、无法解析的路径都拒绝。

写角色实测工具为 `edit/glob/grep/read/read_image/skill/working_directory/write`；只读 Lead 为 `ask_user_question/glob/grep/read/read_image/skill/working_directory`。角色组合没有加载 shell 或派发包，但全局继承的工具仍需真实清单核查，不能仅凭 preset 配置推断。

本次证明最小执行链、权限守卫、取消与清理成立；没有运行完整 `p0-delivery` 流程，没有将审批卡片、客户端完整业务面板或强杀后的自动恢复纳入这组通过数。强杀后的失效租约仍需人工确认接管。

## P0 端到端：真实 dsh + 真实模型

状态：**通过 25/25**。2026-11-05 23:09–23:16（北京时间），使用 dsh `0.2.1-rc.3`、当前源码构建并安装到隔离 web profile，模型由 `TAKT_E2E_*` 环境变量提供。执行脚本 `node e2e/p0.mjs`，完整脱敏结果在 `e2e/out/p0-result.json`，最终批次另存为 `e2e/out/p0-result-20261105-150916-final.json`（本地证据，不进包）。

### 步骤

1. `e2e/profile.mjs` 在带所有权标记的隔离 `DSH_HOME` 里构建、打包并安装插件，写入模型 provider；不使用用户自己的 `~/.dsh`。
2. 在隔离 home 下创建最小 Node 演示项目：`package.json` 的 `test` 为 `node --test`，含 `src/add.js` 与 `src/add.test.js`。
3. `startHost` 启动真实 dsh web，完成启动 token → 页面 cookie 交换；`/connect?interactions=answer` 单独签发审批卡片用的 API cookie。
4. 通过 Host RPC `session/create` 创建 `taktflow` preset 会话，cwd 为演示项目根；用一条中文自然语言消息要求初始化空间、创建需求并启动 P0 交付流程，且设计后必须让人审批。
5. 等运行进入 `waiting_human`；通过 dsh remote-events WebSocket 找到 Lead 的问题卡片，用“批准”回答。卡片不可用时才回退到面板 `attention.answer`，并在结果里记录原因。
6. 等运行结束，逐项断言运行状态、节点、产物版本、真实文件改动、测试、事件链、面板读取、会话通知和 Lead 工具指标；最后停止进程并清理隔离目录。

### 结果

| 断言 | 真实读回 |
| --- | --- |
| 运行 | `succeeded`；clarify、design、approve-design、implement、test、report 六个节点均 succeeded、attempt 1 |
| 人工审批 | 真实问题卡片：标题 `taktflow 审批`，选项 `批准/打回`，冻结 `design/design.md` v1；回答落账 `decision=approve`、actor `human`、`via=dsh:user-questions`，回读校验 requestId/run/需求/attempt 一致 |
| 产物 | `design/design.md`、`reports/test.md`、`reports/summary.md` 均为 v1；测试报告记录退出码 0 |
| 代码改动 | implement 节点 `harness.started` 的 child session `53edf862...` 内有指向 `src/add.js` 与 `src/add.test.js` 的成功 `edit` 工具调用；`sub(5, 3) === 2` |
| 测试 | `test` 节点 succeeded；在演示项目执行 `npm test` 退出 0，`pass=2`、`fail=0`，测试报告记录退出码 0 |
| 事件链 | 面板 `p=audit`（core `events.verify`）返回 ok，无断点；该批次 Lead 的 8 次工具调用里没有 `takt_trace` |
| 面板 | `project`、`requirements`、`runs`、`run`、`attention` 全部 `{ ok: true }`；`client.js` 可取到 |
| 通知 | Lead 会话有 6 条 `agent/inbox/spliced` 插入，且 6 条都与 `user/message.id` 配对（admitted），target 含 `next-step` / `next-turn`；观察到终态 `运行结束：succeeded` |
| Lead 工具 | 8 次调用：7 次业务成功 + 1 次预期 `TAKT_NO_SPACE`；按全部调用为分母的成功率 87.5%；首次调用用对按 action 5/5、按工具 4/4；严格业务首次成功按 action 4/5、按工具 3/4；pending 0 |

本轮 `start-followup.nudged=true`：模型在 create 后结束了回合，e2e 按真实用户方式发送“需求已经建好了，请继续启动 P0 交付流程”后成功启动。Lead prompt/skill 仍要求“用户已要求启动时 create 后同回合 start”，follow-up 只是模型未遵守时的兜底。

### 踩坑

- **审批卡片 cookie 不能复用面板 cookie。** `/connect?interactions=answer` 签发的是单 socket API 操作员 cookie；WebSocket 断开时该 peer 会被回收，之后再用同一 cookie 访问 `/api` 会 401。e2e 因此维护两个 cookie jar：页面 `/` 的浏览器 cookie 只给面板请求，answer cookie 只给 WS。真实浏览器面板本来就用页面 cookie，不受影响。
- **阻塞式问题卡片不是 `userQuestions/answer`。** 本插件的 `takt_ask_human` 走 blocking waterfall，卡片通过 remote-events WS 的 `$events` / `$events/result` 回答；面板 `attention.answer` 是明确的 fallback，必须在结果里记录来源。
- **`tool/result.isError=false` 不代表业务成功。** dsh 只反映工具执行是否抛错；业务结果要解析 render 的第二个 text block JSON 里的 `ok`。验收脚本和指标都按这个口径统计。
- **最终结论必须 fail-closed。** 聚合只看 `result.ok`：任何 check `fail` / `not-run` 或显式异常都非零退出；即使 setup 阶段失败也要写出本次脱敏 JSON，不能保留上一次通过结果或打印伪绿。`check()` 捕获的业务失败会同时进入 failures 和 check 状态。
- **通知只认真实会话证据。** `agent/inbox/spliced` 的 inserted message 只算 queued；必须与 `user/message.id` 配对才标 admitted。`.takt/status` 快照只作诊断，不能兜底 PASS。
- **指标分母不能排除 pending。** 主成功率用全部 `takt_*` 调用作分母，pending/unknown 单列；首次调用取原始第一次，不能用后续成功覆盖；`TAKT_NO_SPACE` 只在 init 成功前算“用对”，严格业务成功率另行统计。
- **dev 改动需要归因链。** 文件内容变化不能证明是 dev 改的；要读 implement 的 `harness.started` child sessionId，再核对该 child 的 `write`/`edit` 成功结果指向演示项目文件。
- **模型可能在建完需求后结束回合。** 已在 Lead prompt / skill 明确“用户要求启动时，create 成功后同一回合继续 start”，e2e 仍保留一条自然语言 follow-up 作为真实用户兜底；最终批次实际使用了 follow-up。
- **Node `--test` 的输出格式因版本而异。** 本机输出 `ℹ pass N` 而不是 `# pass N`；脚本同时识别 `# pass` / `ℹ pass`，识别不到时显式加 `--test-reporter=tap` 再读，不伪填数值。最终批次 `passCount=2`。

---
## M-J 增量：真实 Node 24 边界与标准流程验收

状态：**构建、类型、单测与发布包探针通过；真实 dsh + 模型的新版 standard e2e 已执行 5 批，前 4 批未通过，第 5 批在研发测试 loop 后升级给人、整体 `ok=false`，标准全链成功尚未验证**。环境为 Node `v24.20.0`、dsh `0.2.2-rc.1`；第 5 批 App Node 为 `v24.21`。

| 验证 | 结果 | 证据口径 |
| --- | --- | --- |
| 构建 | PASS | `node scripts/build.mjs` 产出 `lib/host.js`、`lib/lead.js`、`lib/role.js`、`lib/core.js`、`lib/sandbox.js`、`lib/templates/bundled.js`、3 个流程与客户端 bundle，静态检查通过 |
| 类型 | PASS | `npx tsc -p tsconfig.json --noEmit` 退出 0 |
| 单测 | PASS，35 文件 / 548 项 | `npx vitest run`；新增真实 symlink/core 单例 2 项、build literal 形状 2 项 |
| 流程加载器真实 Node 24 | PASS，29/29 | 隔离进程覆盖 AST 静态扫描、冻结解析边、绝对路径与 `file:` URL、全局 hook 作用域、相对 `.js`→`.ts`、同包 core/sandbox 单例、内容哈希版本隔离 |
| 发布包 workflow 读写 | PASS，5/5 | 临时目录只放 `lib/**`，无 `vendor`、无本地 `node_modules`、清 `NODE_PATH`；GET 快照、合法 `source.replace`、非法语法 400、同 baseRev 冲突 409、两种失败均不改已持久化源码 |
| 发布包 `@taktflow/*` | PASS | `harness`/`knowledge`/`server`/`workflow-source` 等共享入口从随包 `lib` 解析，不依赖用户环境安装 |
| 真实 standard e2e 第 1 批 | FAIL，未启动运行 | Lead 动态流程目录遗漏 `taktflow-standard`，`takt_run start` 返回 `TAKT_UNSUPPORTED_NODE`，未生成 runId；33 项账本 1 fail + 14 not-run；已修 |
| 真实 standard e2e 第 2 批 | FAIL，run failed | run 已启动，`clarify` 前 `@taktflow/sandbox` 解析失败；33 项账本 12 fail；已修 |
| 真实 standard e2e 第 3 批 | FAIL，run failed | 真实 dsh coreSingleton 全部 true，仍在 `clarify` 前 `@taktflow/sandbox` 解析失败；34 项账本 12 fail；已修 |
| 真实 standard e2e 第 4 批 | FAIL，升级待办 | 34 项账本 8 fail；跑到研发测试 loop，5 轮评审、9 条生成用例 8 pass / 1 fail、独立 6 项产品断言 PASS；REG-001 缺 `TAKT_REGRESSION_BASELINE_REV` 被 judge 以 `env_issue` 0.99 升级（1 个 requestId）；未到准出；整体未通过 |
| 真实 standard e2e 第 5 批 | FAIL，升级待办 | run `run-20261106-124857-4d67`、requirement `REQ-3AB8FDFD0134`；34 项账本 26 pass / 8 fail，整体 `ok=false`；12 条生成用例首轮 9 pass / 3 fail，独立 6 项产品 AC PASS；7 轮评审均通过；23 条职责 trace、1 个唯一升级 requestId；judge 停 `waiting_human`，未到质量报告/准出/知识回流 |

第 4 批补充事实：18 条职责 trace 全有 usage（输入 295433 / 输出 34337），Lead 24955 / 356，合计 320388 / 34693；pipeline elapsed 863861ms（停在升级），整个 e2e 985673ms；host stop 与 home cleanup 均 PASS。第 2/3 批 sandbox 失败根因是真实 dsh resolver 在 profile 裸包查找失败时先把 parent 改为 `profiles/package.json` 再进 Node hook，`runtimeForParent` 不命中，不是 symlink 直接导致；`scripts/build.mjs` 用 onLoad 把 vendor `execution.ts` 的唯一 `import(name)` 转成字面量 `import('@taktflow/sandbox')`，esbuild 生成相对 chunk lazy import，vendor 未改。

第 5 批补充事实：e2e 从 `2026-11-06T04:48:27.138Z` 到 `05:11:58.089Z`，总 1410951ms（23 分 30.951 秒）；流水线到升级 1284161ms（21 分 24.161 秒），这是升级前用时，不是运行成功耗时。`autonomy=full`，最终 judge 升级待办保持未回答；34 项验收失败项为 `run-finished`、`no-escalation`、`role-exact`（没有 `release-reviewer` trace）、`loop-ran`（judge `waiting_human`）、`evidence-summary`、`quality-report`、`auto-answers`（acceptance 没执行）、`audit-verify`（只有 1 条 `human.answered`，缺准出 AI 代答留痕）；34 项是验收项，不是 34 条业务用例。23 条职责 trace 全有 usage（输入 408668 / 输出 53348），Lead 17282 / 331，合计 425950 / 53679（含 Lead，按观测 usage 字段，不换算费用）。PRD 评审 2 轮、系分 1 轮、测分 1 轮、动态代码评审 1 轮、脚本评审 2 轮，共 7 轮且最后都通过；`run-cases` + `judge` 第 1 轮已执行，但 judge 停 `waiting_human`，不能称 loop 完整通过或收敛。

第 5 批升级与基线：1 个唯一升级 requestId（ledger 两次观察不能计为 2 次）；`TC-DEL-001`、`TC-REG-001` 判 `env_issue`，缺 Agent 变更前完整文件清单及可信 SHA256（`TAKT_CHANGE_ORIGIN_MANIFEST` / `TAKT_CHANGE_ORIGIN_SHA256`）；`TC-REG-002` 判 `script_defect`，正则误把正常 TAP 汇总 `# todo 0` 识别成 TODO 指令，judge 给了 fix-script 路由，但与 `env_issue` 混合后需人工裁决，未继续修复。`TAKT_REGRESSION_BASELINE_REV` 实际已被消费：`git show` 真实初始 SHA `cad08a234ed7e93e56a2f4dc6a910e90667f8e2f` 成功、原测试与 `package.json` 逐字节匹配，第 4 批的基线缺失已解决。core 单例、init 模板、三类交叉评审、read denial、dev/reviewer 技能隔离、生成物、独立 product-acceptance、进程停止、home 清理均 PASS；完整 audit 验收失败，不能把缺准出回答等同链损坏，也不能反推链验收全过。证据归档在 `e2e/out/standard-history/`。

五批 standard 的真实结果均为 `ok=false`：第 1 批 33 项 1 fail + 14 not-run；第 2 批 33 项 12 fail；第 3 批 34 项 12 fail；第 4 批 34 项 8 fail；第 5 批 34 项 8 fail。第 4 批未到质量报告/准出/知识回流，完整 audit 验收未通过（EventStore.verify 单项通过，但缺少准出 AI 代答留痕，需按 JSON 分开看）。第 5 批同样未到质量报告/准出/知识回流，完整 audit 验收失败；第 5 批是最终交付的真实升级记录，无第 6 批、无全链 PASS。这些是脱敏摘要，不含地址、凭据或绝对路径。

本机探针不替代真实 dsh + 模型 e2e；上面的 548 项单测也不包含浏览器 UI、`profile` 外部 CLI 或真实审批卡片链路，`profile` CLI 与浏览器 UI 未做真实 e2e。
