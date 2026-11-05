import type { SkillRegistration } from '../dsh-types.js'

/**
 * Lead 的 bundled skill。
 *
 * 注册到 ctx.skills；内容保持短小，模型按 whenToUse 判断是否读取。
 */
export const LEAD_SKILL: SkillRegistration = {
  name: 'taktflow',
  description: 'Taktflow 空间目录约定、ID 规范与运行/审批状态含义',
  whenToUse: '当需要创建需求、启动运行、查看产物或处理审批时',
  source: 'bundled',
  content: [
    '# Taktflow 约定',
    '',
    '## 目录',
    '- 空间根：包含 `takt.config.json` 的目录；会话 cwd 必须正好是它。',
    '- `.takt/workflows/`：工作流定义；`.takt/agents/`：角色档案；`.takt/runs/`：运行日志。',
    '- `.takt/workspaces/<需求ID>/`：公共存放区；产物按版本保存，人工修改必须写 reason。',
    '- `.takt/attention.jsonl`：待人事项（只追加）；`.takt/chat/<需求ID>.jsonl`：需求群聊（只追加）。',
    '',
    '## ID',
    '- 需求 ID：大写字母/数字/短横线，例如 `REQ-001`；运行 ID 由宿主生成，不要手写。',
    '- 产物路径相对公共存放区，例如 `spec/design.md`；版本从 1 递增。',
    '',
    '## 状态',
    '- 运行状态有 running / waiting_human / succeeded / failed / cancelled。',
    '- `endReason` 只标记非正常终止：`lead_offline`（Lead 会话结束）与 `host_lost`（宿主丢失）。',
    '- 待办 requestId 首次为 `<runId>:<nodeId>`，同节点后续轮次追加 `#<序号>`；回答前核对 attempt。',
    '',
    '## 错误码',
    '`TAKT_NO_SPACE`、`TAKT_SPACE_ROOT_MISMATCH`、`TAKT_NOT_BOUND`、`TAKT_LEASE_HELD`、',
    '`TAKT_RUN_BUSY`、`TAKT_STALE_VERSION`、`TAKT_FORBIDDEN_FOR_LEAD`、`TAKT_UNSUPPORTED_NODE`。',
    '遇到错误先读 hint，不要自行猜测空间或覆盖租约。',
  ].join('\n'),
}
