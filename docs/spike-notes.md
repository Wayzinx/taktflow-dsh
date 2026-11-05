# dsh 插件 spike 记录

## S4：隔离 profile 启动与 Host RPC

状态：**骨架阶段的 S4 自动 E2E 与独立浏览器 UI 验收通过**。2026-11-05 使用 dsh `0.2.1-rc.3` 和当前工作区打出的 `taktflow@0.0.0` 完成真实安装：profile **6/6**、boot **13/13**、浏览器自动化 UI **8/8**。这是最小 ping 面板的验收，完整 P0 工作流与业务面板仍未实现。

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

自动验证证明安装、宿主加载、客户端资源发现、preset 解析与真实模型路由可用；独立浏览器 验证证明最小面板能渲染、遵守主题和路径边界、展示 API 错误并恢复、卸载样式并在 reload 后继续工作。骨架阶段未实现 RunManager 业务、所有权/权限/审批/通知业务、Lead 工具和完整随包流程；`loadP0DeliveryWorkflow()` 当前直接抛 `not implemented`。这些由 M-C / M-D / M-F 后续接线，S1 / S2 / S3 和完整 P0 业务验收不在本次结果中。

### 补充（2026-11-05，独立仓库复跑）

- **代理**：dsh 用 Node `fetch` 统一走环境里的 HTTP(S) 代理，只有回环地址直连；`NO_PROXY` 里的网段写法（如 `10.0.0.0/8`）实测不生效。模型端点在代理之外时，要把**确切的主机名或 IP** 加进 `NO_PROXY`，否则请求会被送进代理、会话里一直没有 assistant 消息（2026-11-05 实测）。

独立仓库（taktflow 以子模块引用）下复跑：profile 6/6、boot 13/13。
