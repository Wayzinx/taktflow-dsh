# taktflow for DeepSeek Harness

> 🚧 P0 可用：真实 dsh + 真实模型的完整交付主路径已端到端通过（最终批次 25/25）。P1（从节点重跑、产物回退、配方指纹、归因视图）仍在计划中。

把 [taktflow](https://github.com/Wayzinx/taktflow) 做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：**装一个插件，dsh 就多了一条"需求交付线"**。

- **一个需求一个空间。** PRD、设计、用例、证据、报告都放在需求目录里，带版本和来源。
- **需求群就是 Lead 的会话。** 你和 Lead Agent 对话；Lead 按流程派发职责 Agent（dsh 原生子会话），自己不写代码。
- **人只把关。** 审批卡片用 dsh 原生的提问卡片，答案只能由人给出；主面板看进度、产物和运行。
- **可追溯、可审计、可回滚。** 产物版本和声明依赖、运行事件哈希链（带链尾锚点）、从某一步重跑、产物回退。

## 文档

- [产品方案](docs/01-产品方案.md)：定位、用户旅程、界面、范围与里程碑
- [技术方案](docs/02-技术方案.md)：架构、dsh 接口用法、权限与生命周期、审计口径、实施计划
- [spike 记录](docs/spike-notes.md)：在真实 dsh 上的验证结果和踩坑
- [开发说明](docs/development.md)：内部接口、构建、隔离 e2e

## 状态

| 里程碑 | 内容 | 状态 |
|---|---|---|
| P0 骨架 | 打包、安装、宿主加载、Lead preset、最小面板；隔离 profile 下的真实安装验证（S4） | ✅ |
| P0 业务 | dsh 原生职责 Agent、权限守卫、单写者租约、审批链路、Lead 工具、主面板；真实 dsh + 真实模型端到端最终批次 25/25 | ✅ |
| P1 / P2 | 从节点重跑、产物回退、配方指纹、归因视图 | 计划中 |

## 在 dsh 里怎么用

1. 安装插件（构建和打包见“开发”）：

   ```bash
   npm run build && npm run pack:takt
   dsh plugin --profile web add /absolute/path/to/taktflow-0.0.0.tgz
   ```

2. 打开 dsh Web，在侧边栏新建一个 **taktflow** preset 会话，工作目录指向你的项目根。
3. 直接对 Lead 说人话，例如：“这个目录还不是 taktflow 空间，帮我初始化，然后建一个需求：给 `src/add.js` 增加 `sub(a, b)` 函数并补测试，建好后直接启动 P0 交付流程；设计写好后先让我审批。”
4. Lead 会依次初始化空间、创建并绑定需求、启动运行；运行到设计审批时，dsh 会弹出原生问题卡片，只有人点“批准”才会继续。
5. 在主面板看需求、运行、待办和产物版本；运行结束后 Lead 会收到 `[taktflow]` 通知并汇报结果。所有角色都没有 shell，代码改动由 dsh 子 Agent 完成，测试由流程的脚本节点执行。

## 开发

```bash
git clone --recursive https://github.com/Wayzinx/taktflow-dsh.git
cd taktflow-dsh
npm install
npm run build && npm run typecheck && npm test
```

`vendor/taktflow` 是 taktflow 的 git 子模块，构建时直接打包它的源码，所以插件没有运行时依赖。联调本地的 taktflow checkout 可以设 `TAKTFLOW_DIR=/path/to/taktflow`。

在隔离的 dsh profile 里做端到端验证（不会动你自己的 `~/.dsh`），需要一个兼容 OpenAI chat completions 的模型端点：

```bash
TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... npm run e2e       # profile + boot
TAKT_E2E_BASE_URL=... TAKT_E2E_MODEL=... TAKT_E2E_API_KEY=... node e2e/p0.mjs  # 完整 P0
```

P0 脚本会跑初始化、建需求、启动、人工审批、产物/测试/审计/面板/通知，脱敏结果写到 `e2e/out/p0-result.json`。

如果环境里设了 HTTP 代理，记得把模型端点的确切主机名加进 `NO_PROXY`（dsh 不认网段写法），见 [开发说明](docs/development.md)。

## 许可

MIT
