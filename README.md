# dsh-sw-mcp — DeepSeek Harness 的 SOLIDWORKS 建模预设

给 DeepSeek Harness（dsh）加一个 SOLIDWORKS 2026 建模模式。装好后模式列表里多出
**「SW 建模（原生单步）」**（preset id `sw-native`）：所有 SOLIDWORKS 操作都走原生单步工具，
**一次工具调用只做一个动作**，同类几何可以在一次调用里用数组批量给；不为一张图写整段程序。

工具面是 MCP 服务（`server/server.mjs`，Node）→ 桥接器（`bridge/src/*.cs`，C# .NET Framework
编译成 `SwBridge.exe`）→ SOLIDWORKS COM 三段结构。桥接器是本机编译产物，不走网络，不调外部服务。

> 包名保持 `@local/dsh-sw-preset`：它按「本机 file: 依赖」安装，不发布到 npm。

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows（COM + 命名管道 + UIA，只有 Windows 能用） |
| SOLIDWORKS | 本机已安装 SOLIDWORKS 2026，路径 `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS` |
| Node.js | ≥ 20 |
| 编译器 | .NET Framework 4 自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（不需要 .NET SDK） |
| 宿主 | DeepSeek Harness（dsh） |

## 安装

1. **解压**到固定目录，路径建议无空格（例如 `D:\tools\sw-mcp`）。
2. **编译桥接器**：`powershell -NoProfile -ExecutionPolicy Bypass -File bridge\build.ps1`
   - 它会先从 `contracts/enums.json` 生成契约常量、从分派表生成能力清单，再从 SOLIDWORKS
     安装目录拷 interop 程序集到 `bridge/bin/`，最后编译并发布 `bridge/bin/SwBridge.exe`。
   - 仓库里**不含** `bridge/bin/`（interop 程序集是 Dassault 的，且与本机 SOLIDWORKS 版本绑定），
     所以这一步不能跳。
3. **装依赖并登记路径**：`powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`
   - 把 `cordis.patch.yml` 里每个 MCP 服务条目的 `command` / `server.mjs` 参数改成本机真实路径，
     然后 `npm install --omit=dev`（只装 `zod` 与 MCP SDK）。
   - 它**不动**你的 dsh profile，最后把该粘的那段打印出来。
4. **登记到 profile 并重启**（预设不做热重载）：在 `C:\Users\<你>\.dsh\profiles\<profile>\package.json` 的
   `dependencies` 里加 `"@local/dsh-sw-preset": "file:D:/tools/sw-mcp"`，在 `dsh.profile.bundles`
   里加 `@local/dsh-sw-preset`，然后重启 DeepSeek Harness。

详细说明与排错见 [`INSTALL.md`](./INSTALL.md)、[`skills/sw-setup`](./skills/sw-setup/SKILL.md)、
[`skills/sw-troubleshooting`](./skills/sw-troubleshooting/SKILL.md)。

## 工具面

工具分两层：默认只挂 **8 个核心工具**，其余按需用 `catalog` 激活 —— 免得一份会话一上来
就背 20 多个工具的 schema。（`SW_MCP_SURFACE=compact` 时只挂 `run` / `read` / `help` / `deliver`；
`SW_MCP_TOOLS=inspect` 是只读实例，只挂指定的那几个。）

**核心工具（8，默认就有）**

| 工具 | 动作 | 做什么 |
|---|---|---|
| `catalog` | `list` / `activate` | 能力目录；按需激活下面那些 capability |
| `model` | `plan` `build` `edit` `rebuild` `create` `undo` `pattern` `diff` | 零件建模主入口 |
| `drawing` | `drawing` | 出工程图 |
| `workspace` | `preflight` `brief` `projects` `project` `resume` `history` `read` `open` `search` `lesson` | 环境、项目与经验 |
| `inspect` | `model` `faces` `bodies` `sketch` `figure` `measure` | 回读几何/质量属性/包围盒 |
| `constraints` | `relations` `dimensions` | 草图约束与驱动尺寸 |
| `capture` | — | 出图（iso/front/top/剖视），截图不是读数 |
| `deliver` | — | 交付：按 `designId` 定位文档，活动文档不是目标也会自己激活/重开/重建 |

**按需激活（`catalog action="activate" capability="<名字>"`）**

| capability | 打开后得到 |
|---|---|
| `assembly` | 装配动作：`assemble` `mate` `mateDelete` `mateLock` `componentLock` `componentRotate` `componentTranslate` `drive` |
| `assembly_inspect` | `assembly` / `assemblyFaces` / `mates` |
| `advanced_api` | 底层出口：`invoke` / `object` / `kinds` / `batch` |
| `qa` | 验收与证据：`verify` / `evidence` / `review` / `snapshot` / `compare` |
| `workspace_ops` | 实例与文档运维：`status` `instances` `reap` `ui` `reload` `cleanup` `reclaim` `closePath` `close` `quit` `logs` |
| `datum` / `select` / `analysis` / `calculate` / `job` / `task` | 整工具按需打开（基准、选择、分析、计算、作业、长任务） |


## 交付与验收

- 交付证据 = `iso` / `front` / `top` + 关键剖视 + **数字读数**；截图不算读数。
- `inspect action="verify"` 的四态判定：`pass` / `fail` / `unmeasured` / `blocked`，
  `unmeasured` 不能当通过。
- 回包形状固定：`summary` / `designId` / `status` / `changes` / `measurements` / `artifacts` /
  `nextActions` / `capabilities` / `timings`；**失败时 `changes` 也在**，读数在
  `changes.measurements` 与 `measurements` 两处都能读。

## 数据目录

运行时数据落在 `%LOCALAPPDATA%\sw-mcp\`：`instances.json`（实例台账）、`logs\`（`mcp-*.jsonl`
调用日志、`review.jsonl` 审查日志）、`projects\`（design.json 设计存档）、`locks\`、`images\`、`out\`。

默认走共享 broker（`SW_MCP_BROKER=1`）：重操作提交给常驻实例 worker，首调用可自动拉起
SOLIDWORKS；`SW_MCP_INSTANCE_POLICY=isolated` 时每个会话自己持有实例，`--no-attach` 只枚举
运行对象表，不碰别人的实例。

## 测试

```powershell
node test/suite.mjs                 # 全量（会自己起一个 SOLIDWORKS，跑完回收）
node test/plugin-fixes.mjs          # 离线：只读源码与假桥接器，十秒量级
node test/envelope-shape.mjs        # 离线：回包形状
node test/deliver-route.mjs         # 离线：deliver 路由决策
node test/definition-arg.mjs        # 离线：definition 传成 JSON 字符串时的容错
```

全量套件里带 `-live` 的用例需要一块**可独占**的 SOLIDWORKS：套件只用自己起的实例，
不会杀掉你先开着的窗口。

### 已知未追平的用例（2026-11-24 首次公开推送时的实测）

首次推送前跑了 43 个**不需要独占 SOLIDWORKS**的用例，**30 绿 / 13 红**。红的都不是这一轮
`deliver` 重构引入的（`deliver-route` / `definition-arg` / `plugin-fixes` / `envelope-shape`
全绿），原因是 2026-11-23 删掉 `sw-ptc` 整段程序入口、工具面改成原生单步之后，一批早期用例
还在调已经不存在的动作，或者需要一块真实桥接器/实例：

| 用例 | 红的原因 | 归类 |
|---|---|---|
| `test/assemble-designid.mjs` | 还在调 `model action="assemble"`（装配已独立成 `assembly` 工具） | 接口已变 |
| `test/instance-reap.mjs` | `workspace` 工具里旧的 `activate` 动作与参数形状 | 接口已变 |
| `test/relations-edit.mjs` | `dimensionAction` 的四个动作已并入 `constraints` | 接口已变 |
| `test/review-read.mjs` | `review` 工具已并入 `inspect` / `qa` | 接口已变 |
| `test/cwd.mjs`、`test/patch.mjs` | 走一遍工具面后调了旧动作（`patch.mjs` 的握手本身是通的，工具清单能列出来） | 接口已变 |
| `test/polite-mode.mjs` | 断言的是重构前 persona 的原文（三条硬规则已改写） | 断言过时 |
| `test/mcp-ops.mjs` | 旧 `job` 调用链（`Tool job not found`） | 接口已变 |
| `test/read-only-guard.mjs`、`test/design-contract.mjs` | 需要真实桥接器回包；没有可用实例时得到 `null` / `status=error` | 需要环境 |
| `test/sketch-plan.mjs` | 撞上 `BUILD_IN_PROGRESS`（同一 designId 正在建），并发相关 | 环境相关 |
| `test/model-invoke-batch.mjs` | 自建的 broker 管道连不上（`BROKER_UNAVAILABLE`） | 需要环境 |
| `test/images.mjs` | 需要 SOLIDWORKS 在线，本轮 120 秒超时 | 需要环境 |

绿的 30 个里包含 `syntax`(219) / `contracts`(78) / `isolation-pid`(82) / `bili-bypass`(106) /
`plugin-fixes`(66) / `affinity`(51) / `design-store`(32) / `snapshot`(27) / `drawing-schema`(16) /
`deliver-route`(38) / `definition-arg`(20) / `envelope-shape`(13) 等。



## 已知限制

- 只支持 Windows + SOLIDWORKS 2026；interop 程序集来自本机安装。
- 多会话共用一份 SOLIDWORKS 时靠 broker 的实例/通道隔离；实例不足时排队而不是抢占。
- `review-gate`（交付前独立读图审查）用的是另一个只读读图代理，额度按设计计；
  它拦的是「没看图就说交付」，不是几何正确性本身。
- 本仓库的 `bridge/bin/` 与 `node_modules/` 不入库。

## English

A DeepSeek Harness preset that turns the harness into a SOLIDWORKS 2026 CAD operator.
All SOLIDWORKS work goes through native single-step MCP tools — one action per call, batches
expressed as arrays. Eight tools are registered by default (`catalog`, `model`, `drawing`,
`workspace`, `inspect`, `constraints`, `capture`, `deliver`); assembly, advanced API, QA,
instance ops, datum, select, analysis, calculate, job and task are opened on demand through
`catalog action="activate" capability="<name>"`.
Architecture: Node MCP server → C# `.NET Framework` bridge (`SwBridge.exe`) → SOLIDWORKS COM.
Windows only; SOLIDWORKS 2026 must be installed locally; the bridge is compiled on the
target machine (`bridge/build.ps1`), so no binaries are committed. Install:
build the bridge, run `install.ps1`, register `@local/dsh-sw-preset` in your dsh profile,
restart the harness.

## License

MIT — see [`LICENSE`](./LICENSE).
