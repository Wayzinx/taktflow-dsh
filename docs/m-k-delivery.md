# M-K 交付说明：受控自测、评测接入与缺陷归因

**本模块已完成实现，第 7 批真实 dsh + 模型验收 25/25 通过。** 构建、类型检查和全量单测通过，39 个测试文件、665 项测试。真实闭环完成到缺陷归因经原生人工入口确认；示例 `parsePrice` 负号缺陷没有修复，也没有据此宣称回放评测或新版 standard 全链通过。

## 做了什么

复用 M3 的缺陷、auditor 归因、成绩单、回放评测及命令协议，接入 dsh 宿主与 Lead。六个 Lead 工具保持不变；`takt_trace` 支持 defects、why、report、attribute、scorecard，报告时引用证据并区分候选与人工确认。缺陷录入使用 Lead agent 身份，onBehalfOf 为需求绑定的人，录入原因进入审计。

归因确认使用 `takt_ask_human` 原生卡片。宿主核对在线绑定、候选哈希、权限与租约后，以 human actor 调用 M3 确认；Lead 不能代确认。支持确认候选、修改后确认、驳回候选。core 没有驳回状态，因此驳回只追加人工审计、保留候选，不写 confirmed。归因完成、缺陷确认和评测完成接入合并通知，唤醒绑定 Lead。

新增仅挂在可写职责角色上的 `takt_selftest`。宿主冻结命令、cwd、环境与超时，工具仅接受全量或安全过滤参数；保存真实退出码、成功状态、可解析的测试数量、脱敏输出和精确证据版本。脚本身份基线跨同一运行的重试、角色返工和宿主恢复复用。取消、超时和卸载等待进程组收尾后再释放权限。没有开放通用 bash 工具。

流程职责 AgentTrace 关联 `node.recipe` 的键和事件序号。补充原生 `agent/error`、会话终态和结构化结果诊断；M3 默认外部 CLI 档案继承 App 模型设置，显式 dsh 设置保留。两个适配器复制原生深冻结的结构化返回值后再交 core 处理，避免 core 归因规范化补字段失败。

真实验收采用原样 quick-fix T1：PM 生成需求说明和用例 → dev 受控自测 → 独立 reviewer → 正式交付 gate → 实测并录入缺陷 → auditor → 通知自然唤醒 Lead → 原生卡片确认 → why。脚本不生成最终归因、不替代评审或门禁，也不把工具返回正常当成测试通过。

## 文件清单

以下为本任务在当前工作区的完整新增/修改文件；本地 out 账本和临时目录不列为源码。

| 范围 | 文件 |
| --- | --- |
| M3、生命周期与通知 | `src/host/m3.ts`、`src/host/m3-runtime.ts`、`src/host/dsh-errors.ts`、`src/host/index.ts`、`src/host/routes.ts`、`src/host/notify.ts`、`src/host/runs.ts` |
| 受控自测与角色挂载 | `src/host/selftest.ts`、`src/host/role/selftest.ts`、`src/host/role/index.ts`、`src/host/presets.ts` |
| Lead 工具与提示 | `src/host/lead/tools.ts`、`src/host/lead/prompt.ts`、`src/host/lead/skill.ts` |
| 执行与追溯 | `src/host/dsh-harness.ts`、`src/host/agent-trace.ts` |
| 兼容接口与 SDK 类型 | `src/host/types.ts`、`src/host/dsh-types.ts` |
| 自动测试 | `src/host/m3.test.ts`、`src/host/notify-m3.test.ts`、`src/host/selftest.test.ts`、`src/host/selftest-lifecycle.test.ts`、`src/host/agent-trace.test.ts`、`src/host/dsh-harness.test.ts`、`src/host/lead/index.test.ts`、`src/host/lead/tools.test.ts`、`src/host/routes.test.ts` |
| 真实验收驱动 | `e2e/defect.mjs`、`e2e/defect-lib.mjs`、`e2e/defect-delivery.mjs`、`e2e/defect-card.mjs`、`e2e/defect-probe.mjs` |
| 文档 | `README.md`、`docs/spike-notes.md`、`docs/controlled-selftest.md`、`docs/m-k-delivery.md` |

## types.ts 变更

全部为向后兼容的可选增量：

| 位置 | 增量及兼容语义 |
| --- | --- |
| `TaktflowService.m3?` | M3 宿主服务；旧组装可以省略，缺失时执行入口明确不可用，不假成功 |
| `TaktflowService.selftests?` | 受控自测服务；旧组装可以省略，工具调用明确拒绝，不退化为任意命令 |
| `AgentTrace.recipeKey?` | 本次职责执行的配方键，旧记录允许缺失 |
| `AgentTrace.recipeEventSeq?` | 对应 node.recipe 的事件序号，旧记录允许缺失 |
| `RolePresets.acquire(..., variant.writeScope?)` | 当前节点实际生效的写范围，用于决定是否挂 selftest；省略时保留按角色档案处理的兼容行为 |

`src/host/dsh-types.ts` 另补了官方 SDK 同形的 `AgentErrorEvent` 本地 shim，包含 agent、turn、step、error。这是 dsh 类型接入，不是 core 协议变更。vendor 与现有 M3 API 模型没有修改。

## 测试结果

| 验证 | 结果及范围 |
| --- | --- |
| `npm run build && npm run typecheck && npm test` | 通过，39 文件 / 665 项。覆盖 M3 身份、原生卡片、租约/生命周期、受控命令、过滤、脚本基线、取消、脱敏和结构化结果等；单测不冒充模型 e2e |
| 五个 `e2e/defect*.mjs` 的 `node --check` | 通过；后续脚本诊断改动也完成语法检查 |
| 脚本离线回归 | 通过：真实 fixture runner 正反分支、M3 输入/AC 解析、动态用例与 baseline 覆盖、自测证据链、结构化评审、通知、角色身份、错误采集、分块输出脱敏。仅验证驱动与判定，不计入真实业务通过数 |
| `node e2e/defect.mjs`，第 7 批 | **PASS 25/25，退出码 0**；真实 dsh、真实模型、隔离 profile 与完整 T1 归因确认链 |

当前构建仍有原有客户端 CSS 警告，本模块未改相关样式。最终生产代码的全套检查与真实第 7 批均已独立复核。

## Spike 结果与历史

最终批次：北京时间 2026-11-07 13:03:23.897–13:08:19.503，总耗时 **295.606 秒**；dsh `0.2.2-rc.1`；需求 `REQ-2A2BDEF7033D`，运行 `run-20261107-130349-f14b`。脱敏账本为本地 `e2e/out/defect-result-batch7.json`，这些运行产物不进入源码包。

| 阶段 | 最终真实证据 |
| --- | --- |
| 原样 T1 | spec、implement、review-code、delivery-check 四节点均 succeeded；PM 实际生成 spec/quick.md v1 与 6 条用例，没有脚本预置 spec/cases |
| 自测 | dev 调用 takt_selftest，exitCode=0、succeeded=true、6 passed / 0 failed，176 ms；精确 tasks/selftest 版本读回，命令/身份/时序一致，自测后无未测产品变更 |
| 评审和门禁 | 独立 reviewer 1 轮 approve；structured_output 调用及成功结果与精确评审产物一致；正式 tests、acceptance 均 pass，6 条逐例证据齐全 |
| 真实缺陷 | 交付后执行 parsePrice('-¥12.34') 得 1234，期望 -1234；这不是正确行为，也未在本任务修复 |
| 录入与归因 | report 为 agent/lead，onBehalfOf 与绑定人一致，原因审计通过；auditor 引入来源为 unknown，证据说明这是旧问题，不能归咎本轮 implement；missedBy 指向 delivery-check/review-code 的覆盖及风险跟踪缺口 |
| 通知 | queued=1、admitted=1，消息 ID 配对，Lead 在 next-turn 自然调用 why 并声明候选未确认 |
| 人工确认 | 脚本通过原生 Remote Event RPC 模拟选择“确认候选归因”；候选哈希一致，持久化 actor 为 human、via 为 dsh:user-questions、edited=false；没有通过面板 fallback 冒充原生卡片 |
| 确认后汇报 | why 明确归因已由人确认，继续说明引入未知，并引用实际测试汇总的证据原文 |
| 查询与审计 | defects 返回 1 条 confirmed；空间级 scorecards 返回 4 项；业务运行与 defect-REQ 独立事件链 verify 均 ok |
| 角色与配方 | 真实 schema：Lead 无 selftest 且仍六个 takt 工具，dev 有，readonly reviewer/auditor 无；四条流程 trace 的 recipeKey、recipeEventSeq、nodeId、role 与 node.recipe 逐项一致 |
| 清理 | 最终 cleanupError=null，各批隔离宿主和 home 均已清理；个人 profile 未动 |

最终 metrics 记录 **输入 74,086 / 输出 9,055 tokens**。Lead 为 19,590 / 1,370，PM 6,189 / 1,883，dev 12,786 / 2,080，reviewer 9,157 / 846，verifier 14,106 / 1,429，auditor 12,258 / 1,447；全部五个子会话 usage 均被观测。这里按最终会话观测汇总，不重复加节点估算，不换算费用；token 覆盖完整与业务通过是不同结论。

历史账本保留如下，未用新通过结果覆盖旧失败：

| 批次 | pass / fail / not-run | 耗时 | 已观测输入 / 输出 token | 当时结论 |
| --- | --- | --- | --- | --- |
| 1，T0 | 5 / 1 / 14 | 23.958 秒 | 18,847 / 217 | implement blocked；原始错误未留存，后续离线确认缺 inputs 并补齐 |
| 2，T0 | 5 / 1 / 14 | 238.521 秒 | 30,573 / 3,610 | 实现角色无测试执行能力，不能满足自测完成标准；随后追加受控工具 |
| 3，T1 | 8 / 2 / 15 | 201.771 秒 | 57,497 / 6,139 | 真实业务四节点全绿；脚本误判结构化评审，并连带误报 gate；已修脚本 |
| 4，T1 | 8 / 2 / 15 | 213.528 秒 | 55,561 / 6,546 | 真实 gate 拒绝缺少既有行为回归证据；补原始需求 baseline，由 PM 生成真实用例 |
| 5，T1 | 13 / 1 / 11 | 214.893 秒 | 66,619 / 6,738 | auditor 已启动但无 usage；默认外部 CLI effort 错误映射 App，最小 smoke 确认后修复 |
| 6，T1 | 13 / 1 / 11 | 246.593 秒 | 63,579 / 8,012 | auditor 有真实返回，core 补 runId 遇深冻结对象失败；两个适配器复制结果后处理 |
| 7，T1 | **25 / 0 / 0** | **295.606 秒** | **74,086 / 9,055** | **完整归因确认闭环通过** |

20 → 25 是验收项分母变化，不能合并成业务用例数。第 7 批实际业务用例为 6 条；第 3 批的两项脚本失败也不能称为两个产品缺陷。完整过程见[spike 后续记录](spike-notes.md)。模型映射的最小 smoke 正例为 13.689 秒、6,178 / 462 tokens，显式 dsh-host high 负例仍按原意失败；该 smoke 不等同完整 e2e。

## 真实 Lead 对话摘录

来源是第 7 批 `candidate-not-confirmed` 与 `why-after-confirm` 的 assistant 字段。以下保留原话片段和格式符；`<user>` 是原记录的脱敏标记，没有改写成预设回答。

候选阶段：

```text
已调用 `takt_trace why`。**D-1 的结果是 auditor 候选归因，尚未人工确认，不能作为最终结论。**
```

确认后回答的开头：

```text
D-1 归因由 **<user> 通过原生卡片人工确认**；引入环节**未知，不能归咎于本轮 implement**
```

同一条确认后回答实际引用的证据原文：

```text
evidence/summary.json v1 显示固定 runner 实际执行 6 项用例，6 项通过、0 项失败；其中解析用例只有 TC-PARSE-POSITIVE 与 TC-PARSE-ZERO，没有负金额解析断言。
```

## 安全边界与新配置

完整用法见[受控自测配置](controlled-selftest.md)。`selftest.timeoutMs` 默认 300000 ms，允许 1000..3600000 的整数；`selftest.allowedCommands` 用于校验启动参数中的测试命令，不会自动选择列表第一项。`environment.testCommand` 是宿主扩展，整个 environment 仍需满足 core 的配置约束，包括 deploy。

命令来源依次为通过授权核对的 caseCommand/testCommand、配置的 environment.testCommand、quick-fix 固定 npm test，以及有效 package scripts.test。启动参数由模型提供，不能天然视为受信；npm 入口要求冻结时存在有效 scripts.test。同一 run/cwd 的 package scripts 基线跨尝试和恢复保持，修改 test/pretest/posttest 或其它 scripts 会拒绝执行或使结果不可信。

工具只接受 all/files/name；command、cwd、env、timeout 不由模型传入。过滤条件要通过 runner 识别、字符/路径检查和逐参数引用；不支持可靠过滤的入口只支持全量，不能悄悄把过滤改成全量。环境引用由宿主展开并冻结，配置不能覆盖 TAKT 身份。

证据只写当前需求中真实 writeScope 允许的 tasks/evidence 路径；strictOutputs 也必须允许该产物。不可写时返回 evidence=null 和原因，不扩大权限。测试数量无法可靠解析就省略，不能补零；exitCode、succeeded、真实输出及精确证据共同决定验收。

**受控配置命令与项目测试代码仍在 worktree 中运行，具有 script 节点的信任边界。进程文件写入不经过 dsh 工具守卫，由 core WriteGuard 在执行后检查；没有 OS 级隔离，不承诺阻止任意文件写入。** 通用 bash 工具仍未开放。超时、节点/工具取消、卸载使用 core 进程组取消并等待收尾；输出先脱敏再截尾，不写原始输出临时文件。

## 没做什么

- 未修改 `src/client/**`、`vendor/taktflow`、package 或依赖；未向插件仓库提交或推送 Git；未操作用户自己的 `~/.dsh`。
- 未修复示例负数解析 bug。confirmed 是归因确认，不是缺陷已修复；后续应另立修复需求、增加负金额解析断言并真实回放验收。
- 未执行真实 eval.run，也未验收多/无来源评测的业务链；4 项 scorecards 可读不能扩展为回放通过。
- 未完成或验收前端页面、浏览器渲染及新版 standard 全链。M-J 五批的历史未全链通过结论保留。

## 已知问题与协议变更请求

1. M3 core 的部分评测报告收尾直接调用 jsonWrite，没有全部经过宿主包装的 stores。宿主会检查租约、取消并等待，但失租窗口内这些直接文件写入仍无法由现有 stores 守卫完全拦截；需要 core 提供统一写入守卫或租约感知的评测收尾协议。
2. eval.run 需要选中用例的 source.runId 唯一指向一个需求及其在线绑定 Lead。无来源、来源不存在或跨多个需求会明确拒绝，不广播、不猜第一个需求。跨需求或无来源用例需要明确的需求/Lead 归属协议。
3. core 没有独立“驳回归因”状态。当前只追加人工驳回审计并保留候选；界面不能把它显示为已确认或已关闭。
4. 现有客户端 CSS 构建警告保持原状；本次没有处理不属于该模块的样式问题。

## 简报与现状的取舍

技术方案 v2.1 把配方指纹/归因列为 P2，但 M-K 简报指定接入已经落地的 M3；按现行 M3 协议实现，保留旧设计与历史记录。后续用户明确要求受控角色自测及独立评审，因此增加 role 工具而保持 Lead 六工具不变，并将真实流程从会跳过评审的 T0 改为原样 T1。runner 的自测模式只改变证据输出位置，仍实际执行同一批断言；正式 gate 继续独立运行。

默认外部 CLI 档案映射到 dsh-host 时继承 App 选项，显式 dsh-host 选项按用户配置保留；没有伪造模型能力。结构化结果复制是宿主适配，不改 core 的归因规范化行为。上述选择保持现有测试、最小改动和已有协议，不修改 vendor。

## 给另一个模块和 Claude 的注意事项

- 服务的 m3/selftests 均为可选增量；旧组装缺服务时展示明确不可用，不能把失败当空数据成功。Lead 工具清单仍为六个，selftest 仅在满足写权限条件的角色中可见。
- 继续使用现有 `/api/taktflow`、`/api/taktflow.op` 的 M3 操作及数据类型。scorecard 是空间级 node/recipe/skill 汇总，可选 workflowId，不是当前需求独有成绩；空成绩单或查询成功都不能证明修复。
- `/api/taktflow.agents` 的 recipeKey/recipeEventSeq 可缺失，历史记录显示未记录，不补造。一个 node/attempt 可以有多个角色执行，继续按 sessionId 区分；本批四条普通流程 trace 已与 node.recipe 核对。
- 根据持久化 attribution.confirmed 和 human 身份展示“已人工确认”，同时展示确认人、时间、edited；候选、通知到达和工具接受均不能替代确认读回。保持 introducedAt.origin=unknown 的诚实表达，不能把旧 bug 归咎于本轮实现。
- 原生修改后确认的自定义 JSON 顶层仅允许 note、introducedAt、missedBy、suggestions；非空 note 和至少一项实际修改必填，不再包 attribution。不能编辑 by、确认者、时间或置信度；候选哈希变化时重开卡片。
- 驳回只留审计并保留候选；取消、多选、空回答不算确认。缺陷审计流为 defect-<requirementId>，普通 run 的 verify 不代替该流。
- dsh 的合法结构化回答可能只有 structured_output 工具调用与成功回执，没有 assistant 纯文本；展示与验证要保留结构化结果。无 usage 的 auditor 也可能已启动，角色身份按真实会话/probe 关联，不能从 cwd 猜测。
- 原生卡片本批由 RPC 模拟选择完成；前端页面与浏览器体验仍需对应模块独立验收。评测归属和失租收尾的两项 core 边界不能由客户端猜测补齐。
