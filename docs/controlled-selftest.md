# 受控自测 `takt_selftest`

职责 Agent 用 `takt_selftest` 执行项目已配置的测试，并把实际结果写入完成说明。工具挂在 `taktflow/role`：本次节点的 `writeScope` 非空、非只读且宿主已启用时才注册。Lead 和只读角色没有它，Lead 的六个工具不变；缺少可信节点上下文、身份已过期或租约不可用时拒绝执行。

可写角色完成前应调用自测。PM 等角色的工作目录可能没有测试入口，此时记录“未执行”和原因，按本节点的完成标准判断。没有入口不会阻断节点启动，也不能用来放行明确要求自测证据的实现节点；失败、超时或取消均不得写成通过。

## 命令来自哪里

命令、环境变量、工作目录和超时由宿主冻结，模型只能选择全量或过滤条件。命令按以下顺序选择：

1. 流程启动参数 `caseCommand`，其次 `testCommand`。参数来自 Lead，并非天然受信；去除首尾空白后，必须精确匹配 `selftest.allowedCommands`、`environment.testCommand`，或当前 package 的测试入口允许形式。指定了非法或未授权参数就拒绝，不回退执行另一个命令。
2. 空间配置的 `environment.testCommand`。
3. `quick-fix` 的固定入口 `npm test`。
4. 当前节点工作目录中 `package.json` 的非空 `scripts.test`，通过 `npm test` 执行。

package 的允许形式包括 `npm test`、`npm run test` 和冻结的 `scripts.test` 原文。两个 npm 入口都要求登记时存在有效的 `scripts.test`，不会因为目录里没有 package 就无条件执行 npm。

以下片段合并到已有的 `takt.config.json`：

```json
{
  "selftest": {
    "allowedCommands": ["npm test", "npm run test:unit"],
    "timeoutMs": 300000
  }
}
```

`allowedCommands` 用于核对流程参数，不会自动选择数组第一项。`timeoutMs` 默认 `300000`（5 分钟），接受 `1000..3600000` 的整数；模型不能通过工具参数修改超时。

`environment.testCommand` 是本插件的宿主扩展，不是 core 原有字段。使用它时，整个 `environment` 仍须满足 core 配置要求，包括非空 `deploy`；`deploy`、`setup`、`teardown`、`healthcheck` 不会被当成测试命令。例如，已有测试环境可配置：

```json
{
  "environment": {
    "deploy": "npm run start:test-env",
    "testCommand": "npm test"
  }
}
```

这些命令须由项目实际提供。`environment.env` 的 `${ENV_NAME}` 只引用宿主环境，登记时展开并冻结；变量缺失时自测明确不可用。运行、需求、节点和工作区的 `TAKT_*` 身份由宿主固定，配置不能覆盖。

## 脚本基线与恢复

同一个运行与同一个物理工作目录共用最初的 package 身份基线。基线保存在 `.takt/runs/<runId>/selftest/<cwd-hash>.json`，通过租约、文件锁和符号链接检查建立，只保存存在性、有效性、测试入口是否存在及整个 `scripts` 映射的哈希；不保存脚本原文、工作目录原文或环境秘密。

执行前后都会核对 `scripts`。修改 `test`、新增 `pretest/posttest` 或其它脚本，都会使本运行的自测不可用或结果不可信；节点重试、换角色返工以及宿主恢复不会重新授权已修改的脚本。最初没有 package，之后新建测试脚本，也不能在同一运行中解锁。只改依赖等非 `scripts` 字段不会触发这项限制。

不同运行、不同物理工作目录分别建立基线。新的运行仍按项目测试代码与流程脚本的既有信任边界使用当前项目。

## 调用与过滤

```json
{"mode":"all"}
```

```json
{"mode":"files","files":["tests/add.test.js"]}
```

```json
{"mode":"name","name":"empty input"}
```

省略 `mode` 等同于 `all`。工具不接受 `command`、`cwd`、`env` 或超时字段。过滤值使用字符白名单并逐参数引用，禁止 shell 元字符、控制字符、首尾空白和前导选项；文件必须为相对路径，不得包含 `..` 或符号链接。

当前支持可明确识别的简单 Vitest、Jest、`node --test` 入口，以及通过 `npm test`／`npm run test` 调用这些入口。npm 过滤参数经 `--` 传给脚本；Jest 文件过滤使用 `--runTestsByPath`，名称过滤按对应 runner 的参数传递。不从 `pretest` 或命令中的字符串猜 runner。复杂 shell 组合、已有固定文件参数等无法可靠映射的入口只支持 `all`，不会忽略过滤条件后悄悄跑全量。

## 结果与证据

工具返回结构化 JSON，界面同时展示摘要与完整 JSON。主要字段如下：

| 字段 | 含义 |
|---|---|
| `exitCode`、`succeeded` | 实际退出码与本次自测是否成功；未取得正常退出码时为 `-1`。超时、取消、脚本变化或明确的失败汇总不能算成功 |
| `passed?`、`failed?` | 本次输出中可靠汇总的测试数量；无法解析时省略，不补零，不读旧证据 |
| `durationMs`、`startedAt`、`endedAt` | 本次执行时间 |
| `outputTail` | 脱敏后、最多 8192 字节的 UTF-8 安全尾部 |
| `timedOut`、`cancelled` | 是否超时或取消 |
| `trusted`、`scriptsChanged` | 本次脚本身份是否保持不变 |
| `command`、`commandSource`、`commandHash`、`filter` | 脱敏命令、来源、原始配置命令指纹及本次过滤条件 |
| `evidence`、`evidenceReason?` | 精确 `{workspace,path,version}` 引用；无法写入时为 `null` 并说明原因 |

宿主优先在当前需求的 `tasks/`，其次在 `evidence/` 写入唯一的自测 JSON。路径必须通过本次真实 `writeScope`、公共产物归属和符号链接检查。启用 `strictOutputs` 的节点还必须声明对应输出；无法确认输出合同、权限不允许或运行已取消时只返回结果，不扩大权限、不返回将被隔离的文件引用。

证据包含运行、节点、尝试次数、子会话身份、命令来源与指纹、package scripts 哈希、时间和实际结果。工具调用通过原生会话事件进入 `AgentTrace.tools`；判断测试是否通过应读取自测结果，不能仅凭“工具调用完成”判断。

## 项目 runner 的约定与信任边界

命令在节点自己的 cwd／worktree 中执行，宿主设置 `TAKT_SELFTEST=1`，并保留当前需求的 `TAKT_WORKSPACE`。项目 runner 可以据此只向 stdout 输出自测结果，把正式交付证据留给后续 gate，避免向本节点无权写入的目录落文件。这个标志不会自动改变 runner 行为，也不意味着可以跳过测试或断言。例如本次测试的末行可输出：

```json
{"ok":true,"passed":2,"failed":0,"cases":[{"id":"CASE-1","status":"passed"},{"id":"CASE-2","status":"passed"}]}
```

**受信配置命令和项目测试代码会在 worktree 中运行。测试进程的文件写入不经过 dsh 工具守卫，由 core `WriteGuard` 在执行后检查变更，与 `script` 节点具有相同信任边界。这里没有 OS 级隔离，也不保证阻止任意文件写入；任意 `bash` 工具仍未开放。**

超时、工具／节点取消和宿主卸载复用 core `runShellCommand` 的进程组取消机制，等待自测收尾后释放节点权限。core 的普通返回值固定为 4KB；宿主通过扩大内存保留窗口、在脱敏回调捕获尾部，兼容提供最多 8KB，并处理截断边界的密钥残片。不写原始输出临时文件。
