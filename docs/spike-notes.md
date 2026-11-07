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

## M-K：M3 评测与缺陷归因宿主接入（2026-11-07）

状态：**实现及本地检查通过；真实 dsh + 模型验收执行两批，均为 FAIL，归因闭环未执行**。第二批在原样 `quick-fix` 的 `tier=T0` 实现节点进入 `waiting_human`：角色没有 shell 或测试执行工具，无法满足“自测结果有证据”的完成标准，而模板的实际 `npm test` 位于后续 `delivery-check`。本次保留该阻塞，不改模板、不伪造测试结果，也不在脚本中额外执行测试来替代节点完成标准。以下事实不改变历史 P0 或 M-J 章节的结论。

### 实现与协议取舍

复用 M3 的缺陷、归因、成绩单和回放评测实现，没有增加第七个 Lead 工具。`takt_trace` 增加 `defects`、`why`、`report`、`attribute`、`scorecard`；report 的身份是代表当前绑定人的 Lead agent，原因进入审计。attribute 后台返回，由独立 auditor 生成候选；why 区分候选与人工确认，scorecard 按整个空间的 node/recipe/skill 汇总。

归因确认使用 `takt_ask_human` 原生问题卡片，宿主按当前绑定、候选哈希和租约重新检查后，以 `human`、`via: dsh:user-questions` 调用 M3 确认。原生选择是“确认候选归因 / 修改后确认 / 驳回候选”。core 没有独立驳回状态，因此驳回只记人工审计并保留候选，不写 `confirmed`，也不伪造 `rejected` 状态。归因完成、确认和评测完成接入现有通知器；职责 Agent 追溯关联 M3 `node.recipe`。

技术方案 v2.1 旧章节把配方指纹和归因列为 P2；本次 M-K 简报指定复用已经实现的 M3，以该增量要求接入宿主。保留旧设计记录，未另造归因协议或修改 vendor。`types.ts` 仅增加三个可选字段：`TaktflowService.m3?`、`AgentTrace.recipeKey?`、`AgentTrace.recipeEventSeq?`。旧记录没有 recipe 字段、旧组装没有 m3 服务均保持兼容；服务缺失时执行入口明确不可用，不能表现为成功。

### 本地验证

| 命令或范围 | 本次结果 |
| --- | --- |
| `npm run build && npm run typecheck && npm test` | 通过，37 个测试文件、587 项测试；不是模型或业务 e2e 通过数 |
| 三个 `e2e/defect*.mjs` 的 `node --check` | 通过 |
| 脚本离线检查 | 18 项：fixture 测试程序正反分支、M3 AC 解析和确定性门禁、候选哈希、回答边界、通知配对及脱敏；另有 4 项真实 core 输入解析检查通过 |
| 用量完整度修正 | 6 项离线校验通过，包含第二批原始报告回归、缺 auditor 不完整、缺 usage 不完整和原始报告不变 |

既有客户端 CSS 构建警告仍在，本模块未改相关样式。离线正例使用临时实现检验测试驱动，不能计为真实子 Agent 实现或产品验收通过。

### 两批真实结果

执行命令为 `node e2e/defect.mjs`，使用 dsh `0.2.2-rc.1`、隔离 `DSH_HOME` 与真实模型；模型配置仅从进程环境读取。两批都是 20 项验收检查，不是 20 条业务用例。

| 批次 | 账本与耗时 | 真实进展及限制 |
| --- | --- | --- |
| 第 1 批 | 5 pass / 1 fail / 14 not-run；23.958 秒；`ok=false` | 安装、会话、Lead init/create 和 fixture 准备通过。core 运行 82 ms，implement 为 blocked，没有子 Agent 会话。原始 node.error 未保留，不能把后续离线复现当作本批错误原文 |
| 第 2 批 | 5 pass / 1 fail / 14 not-run；238.521 秒；`ok=false` | 四项版本化输入均已读入，implement 实际尝试 2 次；同一 `completion.unmet` 失败后进入 waiting_human，delivery-check 未执行。完整节点错误、完成标准证据和运行事件已保留 |

首批后检查发现 fixture 漏了原样 quick-fix implement 的必需 `inputs/**`。用真实 core `resolveInputs` 离线复现缺输入时的 `BlockedError`，补入本次用户原始需求 `inputs/request.md` 后，`inputs/request.md`、`spec/spec.md` 和两条 `cases/TC-*.json` 均匹配并冻结版本；第二批也从 runDetail 读回了这四个输入。模板、门禁及 vendor 没有修改。

第二批需求为 `REQ-5AABB9011026`，运行为 `run-20261107-110033-5a20`。`runDetail.run.nodes.implement.checks[0]` 的判据是“改动符合验收标准且自测结果有证据”，结果 `pass=false`。证据明确说明：实现已写入且仅做静态验算，未执行测试；当前角色没有 shell 或测试执行工具，要求后续 script 在实现工作树执行 `npm test`。因此不能把代码存在、静态验算或等待后续门禁当成已自测通过。

两批都没有到达交付后缺陷复现、Lead report/attribute、auditor、归因通知、原生归因卡片、human 确认、确认后 why、M3 面板读取及双事件链验收；这些本次均为 **NOT_RUN**。第二批会话中存在一个待回答的 `takt_ask_human` 调用，来自实现节点升级，不能冒充归因确认卡片。两批都已结束并清理本次隔离资源；第二批结果 `cleanupError=null`。

### 用量和证据记录

| 批次 | 已观测输入 token | 已观测输出 token | 覆盖 |
| --- | --- | --- | --- |
| 第 1 批 | 18,847 | 217 | 仅 Lead；auditor 未执行 |
| 第 2 批 | 30,573 | 3,610 | Lead 为 12,775 / 318；两个子会话为 10,982 / 1,701 和 6,816 / 1,591；合计 34,183，auditor 未执行 |

以上只汇总会话 `assistant/message` 中实际观测到的 usage，不换算费用；节点汇总不再重复相加。第二批原始报告的 `metrics.partial=true`，但 `metrics.token.complete=true` 错把已发生会话的完整观测扩展成整条归因流程完整。脚本已修正：既定流程要求 auditor，未执行或未观测该阶段时 complete 必须为 false，并注明 `completionScope`、`auditorRequired` 和 `expectedAuditorExecuted`。

原始 `e2e/out/defect-result-batch1.json`、`defect-result-batch2.json` 保持不变；`defect-result-batch2-reviewed.json` 只更正覆盖元数据，包含 `reviewedAt`、原始报告摘要及 `runtimeReran:false`，没有改运行结论、检查计数或观测 token。没有第三批真实执行。失败诊断现会在清理前保存完整 runDetail 和事件，避免只剩 failed/blocked 状态。

### 对话样例及未验证部分

本批真实 Lead 可读回答只有创建需求后返回的 `REQ-5AABB9011026` 和启动后返回的 `run-20261107-110033-5a20`。尚无真实归因候选或人工确认后的回答，不能提供虚构的归因对话样例。

实现中的工具返回文案示意为“有 auditor 候选归因（尚未人工确认，不能当结论）”与“归因已由人确认（按候选确认）”；这是静态行为示意，**不是真实模型对话或本批通过证据**。工具数量检查也仅标为静态合同校验，不宣称真实会话的完整工具 schema 已核验。浏览器页面、真实 `eval.run`、多源评测归属及失租窗口均未纳入本轮真实通过项；`src/client/**` 留给前端模块。

### 整合请求和已知边界

1. **quick-fix 自测能力与节点顺序**：当前 implement 的完成标准要求实际自测证据，dsh 职责角色默认无 shell，真实测试却在后续 delivery-check。需要模板与宿主共同约定受控测试执行能力，或调整节点依赖使证据在完成判定前可用；不能把静态验算替代运行证据。本次不改 vendor、不放宽门禁，这一缺口阻塞了真实归因闭环的前置交付。
2. **评测失租收尾写入**：M3 core 的评测报告收尾部分直接使用 `jsonWrite`，没有全部经过宿主包装的 stores。宿主会检查租约、取消并等待收尾，但失租窗口内这些直接文件写入不能由现有 stores 守卫完全拦截。需要 core 提供统一写入守卫或租约感知的收尾协议；不能承诺所有评测收尾写入均已覆盖。
3. **评测归属**：选中评测用例的 `source.runId` 必须唯一归属一个需求，才能使用其在线绑定 Lead。无来源、来源不存在或跨多个需求会明确拒绝，不广播、不按第一个需求猜归属；目前应按来源需求分开运行。支持多源或无源用例需要明确的需求/Lead 归属协议。

### 给 Claude 的前端注意事项

- 沿用 `/api/taktflow` 的 M3 读操作与 `/api/taktflow.op` 的写操作，数据模型继续使用现有 `defects`、`defect`、`defect.report`、`defect.attribute`、`defect.confirm` 和 `eval.*` 协议。缺服务时展示明确不可用，不当空数据成功。
- `/api/taktflow.agents` 中 `recipeKey`、`recipeEventSeq` 可选；历史记录没有值时显示未记录，不推导或补造。同一 node/attempt 可有多条执行记录，继续按 sessionId 区分。
- scorecard 是空间级汇总，可按 node/recipe/skill 及可选 workflowId 筛选，不能标成当前需求专属成绩。空成绩单不能证明无缺陷或已修复；修复验证仍需面板发起回放并查看证据。
- 只有持久化 `attribution.confirmed` 带 human 确认身份时展示“已人工确认”，同时展示确认人、时间及是否修改；auditor 候选、工具调用接受或通知到达均不等于已确认。
- 原生“修改后确认”的自定义 JSON 顶层仅允许 `note`、`introducedAt`、`missedBy`、`suggestions`；必须有非空 note 且至少修改一项归因字段。不要额外包一层 attribution，不允许修改确认者、by、时间或置信度。例如 `{"note":"补充边界","suggestions":[{"target":{"kind":"prompt","ref":"design"},"change":"补充负数输入约束"}]}`。
- 卡片冻结候选哈希；提交前候选变化需重开卡片。驳回只留审计并保留候选；取消、空回答、多选都未确认。归因事件使用独立 `defect-<requirementId>` 事件流，普通 run 审计通过不能替代该流的校验。

## M-K 后续：受控自测与完整归因闭环（第 3–7 批）

状态：**第 7 批真实 dsh + 模型验收 PASS，25/25，退出码 0**。本节承接上节第 1、2 批的历史记录。用户追加受控 `takt_selftest` 后，采用原样 `quick-fix` 的 `tier=T1`，实际执行 spec、implement、review-code、delivery-check；没有删节点、修改模板或放宽门禁。闭环终点是缺陷归因经人工入口确认，示例负数解析缺陷没有修复。

实现和配置见[受控自测说明](controlled-selftest.md)，完整交付与文件清单见[M-K 交付说明](m-k-delivery.md)。最终 `npm run build && npm run typecheck && npm test` 通过，39 个测试文件、665 项测试；随后脚本诊断调整的语法检查也通过。

### 后续批次账本

第 3 批开始的 25 项是在 T1 下增加 PM 产物来源、自测证据、独立评审、正式 gate 和真实工具 schema 检查后的验收分母。上节 T0 的 20 项与本节 25 项不能相加当成业务用例数；每批失败及未执行项均保留。

| 批次 | pass / fail / not-run | 总耗时 | 已观测 token 输入 / 输出 | 结论与修复 |
| --- | --- | --- | --- | --- |
| 3 | 8 / 2 / 15 | 201.771 秒 | 57,497 / 6,139 | 四个业务节点真实 succeeded；脚本把 reviewer 的合法 `structured_output` 当成没有回答，gate 检查又被前项连带误报。修复工具调用与结果的配对、内容核对和独立 gate 判定；不是 gate 产品失败 |
| 4 | 8 / 2 / 15 | 213.528 秒 | 55,561 / 6,546 | 实现自测和评审通过，真实 acceptance 拒绝：spec 要求既有行为回归，但只有新增含税用例。补充原始需求中的四项合法 baseline，由 PM 生成并执行用例；不预置结果、不改 runner、不放宽门禁 |
| 5 | 13 / 1 / 11 | 214.893 秒 | 66,619 / 6,738 | T1 交付及缺陷录入通过；auditor 已启动但未观测到模型 usage，后续最小 smoke 确认默认外部 CLI 档案的 high effort 被错误映射到 App，触发 `UNSUPPORTED_REASONING_EFFORT`。修复默认继承与失败诊断 |
| 6 | 13 / 1 / 11 | 246.593 秒 | 63,579 / 8,012 | auditor 真实完成并返回结构化归因，core 规范化时向深冻结对象补 runId 抛 TypeError。普通节点和 M3 两个适配器先 `structuredClone`，再交 core 处理，新增 3 项回归 |
| 7 | **25 / 0 / 0** | **295.606 秒** | **74,086 / 9,055** | **完整闭环通过**；缺陷为 confirmed，确认人身份和原生卡片来源、双事件链及配方关联均读回核验 |

历史结果分别保留在 `e2e/out/defect-result-batch3.json` 至 `defect-result-batch7.json`，没有改写原始失败账本。第 5 批旧指标把 auditor 记成 null，是按 cwd 猜角色的采集错误：探针已记录该 auditor 的真实角色和父会话，它确实启动、约 40 ms 后失败，只是没有 usage。新采集按真实 probe 的 sessionId、parentSessionId 和角色关联；无 usage 留 null，不称“未执行”，也不补零。

模型映射最小 smoke 的正例用默认外部档案继承 App 设置，13.689 秒完成 attributed，观测输入 6,178 / 输出 462；显式 `dsh-host` high 的负例继续明确失败并保留错误码。这只验证模型选项映射，不替代完整 e2e。错误捕获覆盖原生 `agent/error` 与 `turn/end.reason.error`；子会话尚未产生 assistant 时也保留诊断。

### 第 7 批真实读回

本批从北京时间 2026-11-07 13:03:23.897 至 13:08:19.503，dsh `0.2.2-rc.1`，需求 `REQ-2A2BDEF7033D`，运行 `run-20261107-130349-f14b`。模型、安装及业务执行均发生在隔离 home。

| 环节 | 证据 |
| --- | --- |
| 需求与用例 | PM 实际生成 `spec/quick.md` v1 和 6 条用例，覆盖含税计算两项及既有格式化/解析四项；产物来源与 PM 子会话写入相符 |
| 实现自测 | dev 实际调用 `takt_selftest`，`npm test` 退出 0，`succeeded=true`，6 passed / 0 failed，用时 176 ms；完整 callId 配对，精确 `tasks/selftest-…json@1` 可读，命令及 scripts 指纹相符，自测后没有未测产品修改 |
| 独立评审 | reviewer 单独会话，1 轮 approve；真实 `structured_output` 调用及成功回执与 `reviews/review-code/r1-round-1.json@1` 的 verdict、summary、issues 一致 |
| 正式交付 gate | tests 与 acceptance 均 pass，6 条实际结果和逐例证据齐全；gate 发生在独立评审之后 |
| 缺陷复现和录入 | 交付后的实际 `parsePrice('-¥12.34')` 为 1234，期望 -1234；Lead report 的 actor 为 agent/lead，onBehalfOf 为绑定人，原因审计一致 |
| auditor 候选 | introducedAt.origin 为 unknown；证据支持缺陷在本轮前已存在，不能归咎本轮 implement。missedBy 为 delivery-check 的覆盖盲区与 review-code 的遗留风险跟踪不足 |
| 通知与候选回答 | queued=1、admitted=1，target 为 next-turn；消息 ID 配对后 Lead 自然调用 why，明确“auditor 候选、尚未人工确认”，未靠额外候选查询消息唤醒 |
| 原生确认 | 通过 Remote Event RPC 模拟人在原生卡片选择“确认候选归因”；候选哈希一致，落盘 `confirmed.by.type=human`、`via=dsh:user-questions`、`edited=false`，绑定人一致 |
| 确认后 why | Lead 明确已人工确认、引入来源未知，并引用实际 evidence/summary.json v1 的证据原文；真实回答摘录见交付说明 |
| 面板与审计 | defects 返回 1 条 confirmed；空间级 scorecards 返回 4 项；业务 run 的面板 audit 与独立 defect-REQ 事件流的 core verify 均 ok |
| 实际工具 schema | Lead 仍有六个 takt 工具且没有 selftest；dev 有 selftest，readonly reviewer/auditor 没有。由存活 Agent 的真实 schemas 观察，不以调用子集代替完整工具清单 |
| 清理 | 本次宿主、卡片辅助进程和隔离 home 已清理，`cleanupError=null`；用户个人 profile 未动 |

四条流程职责 trace 与同一运行的 `node.recipe` 逐项对应，核对了节点、角色、recipeKey 和事件序号；auditor 是独立 M3 子会话，不冒充第五个普通流程节点。

| 节点 / 角色 | recipeKey | recipeEventSeq |
| --- | --- | --- |
| spec / pm | `9ec19e996fad0b7a` | 6 |
| implement / dev | `7504878228dfb017` | 23 |
| review-code / reviewer | `9a9e26b199620677` | 37 |
| delivery-check / verifier | `e688a09610e6a72d` | 50 |

最终 metrics 观测到 Lead 输入 19,590 / 输出 1,370；五个子会话（PM、dev、reviewer、verifier、auditor）均有 usage，合计最终输入 74,086 / 输出 9,055。使用结果文件最终 metrics，不把较早检查快照再次相加，也不把节点估算用量重复加到会话用量；不换算费用。token 覆盖完整不等于业务成功：第 6 批可观测到全部已发生会话 usage，业务仍是 FAIL；第 7 批业务成功由独立的 25 项证据判定。

### 本轮形成的验证口径

- 实现自测与正式 gate 分开取证。fixture runner 在 `TAKT_SELFTEST=1` 时真实执行全部动态用例，只向 stdout 输出结果；正式 gate 才写公共 evidence。宿主自测证据保存在允许的 tasks 路径，不能拿 gate 后来的 summary 冒充早先自测。
- T1 只预置原始需求和 runner 输入合同，spec/cases 由真实 PM 生成。四项既有行为 baseline 明确来自初始代码：正/负金额格式化、正金额/零金额解析；不声称负数解析正确。
- 原生结构化回答以 `structured_output` 参数和对应成功结果为准，同时与精确产物内容核对；没有 assistant 纯文本不代表没有模型回答。
- 归因候选与人工确认必须读回持久化状态。示例旧缺陷的引入来源保持 unknown；“六项验收通过”没有扩展成所有解析行为正确，也没有被当成缺陷修复证明。
- 清理前保留所有本批子会话的错误、终态、结构化提交及无 usage 记录。宿主输出只在内存收集，stdout/stderr 各自完整合并、脱敏后再截尾，避免跨 chunk 的凭证泄露；不写 raw 日志文件。

### 仍然保留的边界

受控命令和项目测试代码在 worktree 运行，沿用 script 的信任边界；文件写入由 core `WriteGuard` 执行后检查，没有 OS 级隔离，未开放通用 bash 工具。命令准入、脚本基线、过滤和超时详见[自测配置说明](controlled-selftest.md)。

core 评测收尾的直接 `jsonWrite` 仍不能完全由宿主 stores 失租守卫覆盖；多源或无来源评测用例仍需明确需求/Lead 归属协议。真实 `eval.run`、新版 standard 全链和前端页面不在本次通过范围。缺陷状态 confirmed 表示归因经人工入口确认，示例 parsePrice 负号缺陷仍待另立修复需求及回放验收。
