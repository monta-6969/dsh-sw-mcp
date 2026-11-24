# 紧凑工具面（实验）

> **DEPRECATED（2026-11-23）**：绘图入口已改为原生单步工具调用；紧凑面（`run` 阶段作业）不再是绘图入口，保留作历史与离线验证记录。PTC 预设（`sw-ptc`）及其 `run_code` 执行器已于同日从预设清单移除，当前只有 native 预设 `sw-native`（「SW 建模（原生单步）」）。

`SW_MCP_SURFACE=compact` 时，服务只注册四个工具：`run`、`read`、`help`、`deliver`。
默认不设置这个变量，仍是原来的 11 个工具，现有预设与技能文档不受影响。

## 什么时候用

- 想用一次请求推进一个完整阶段（plan → build → relations → verify），而不是十几次小调用。
- 想让模型只看到窄而具体的参数 schema，避免 `unknown` 类型与超长工具描述。

## 语义

- `run` 必填 `designId`、`runId`、`operationId`、`steps`。`(runId, operationId)` 相同且参数相同 → 返回原作业；参数变了 → `OPERATION_ID_CONFLICT`。
- 步骤默认按顺序、前一步成功才继续；`deps` 可显式声明依赖。`plan` 返回 `changes.ready=false` 时后续步骤跳过，作业以 `PLAN_NOT_READY` 失败。
- 作业落盘在 `SW_MCP_DATA/stage-jobs/`。断线后用 `read kind=job jobId=…` 取回执；执行进程消失时作业标记 `STAGE_INTERRUPTED`，effect 视步骤而定（`none/applied/partial/unknown`）。
- `wait:false` 表示后台执行，立即返回 `jobId`。
- `read kind=detail detailRef=…` 查最近一次结果，`field` 用 JSON Pointer 分页；持久作业用 `read kind=job`。
- `deliver` 仍走原交付路径与审查门，工具名保持 `deliver`。

## 已知边界

- 交付审查门（`review-gate.js`）目前只识别旧的 `model` / `inspect` / `capture` 调用。用紧凑面跑建模后，审查门看不到 `run` 内部的 verify 与截图，交付会被 `VERIFY_NOT_RUN` 拒绝。**在审查门完成映射前，不要用紧凑面做需要交付的正式任务。**
- 因此建模预设暂时不设置 `SW_MCP_SURFACE`；该开关用于离线验证与后续迁移。

## 验证

```powershell
node test/stage-runtime.mjs
node test/compact-surface.mjs
```