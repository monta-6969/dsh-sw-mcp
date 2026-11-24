# 已知未追平的用例（2026-11-24 首次公开推送时的实测）

首推前跑了 43 个**不需要独占 SOLIDWORKS** 的用例：**30 绿 / 13 红**。

13 个红的都不是 2026-11-24 那轮 `deliver` 重构引入的（`deliver-route` 38 项、`definition-arg`
20 项、`plugin-fixes` 66 项、`envelope-shape` 13 项全绿）。原因是 2026-11-23 删掉 `sw-ptc`
整段程序入口、工具面改成原生单步之后，一批早期用例还在调已经不存在的动作，或者需要一块
真实桥接器/实例。

| 用例 | 红的原因 | 归类 |
|---|---|---|
| `test/assemble-designid.mjs` | 还在调 `model action="assemble"`（装配已独立成 `assembly` 工具） | 接口已变 |
| `test/instance-reap.mjs` | `workspace` 工具里旧的 `activate` 动作与参数形状 | 接口已变 |
| `test/relations-edit.mjs` | `dimensionAction` 的四个动作已并入 `constraints` 的 `dimensions` 动作 | 接口已变 |
| `test/review-read.mjs` | `review` 工具已并入 `qa` 的 `review` 动作 | 接口已变 |
| `test/cwd.mjs`、`test/patch.mjs` | 走一遍工具面后调了旧动作（`patch.mjs` 的握手本身是通的，工具清单能列出来） | 接口已变 |
| `test/polite-mode.mjs` | 断言的是重构前 persona 的原文（三条硬规则已改写） | 断言过时 |
| `test/mcp-ops.mjs` | 旧 `job` 调用链（`Tool job not found`） | 接口已变 |
| `test/read-only-guard.mjs`、`test/design-contract.mjs` | 需要真实桥接器回包；没有可用实例时得到 `null` / `status=error` | 需要环境 |
| `test/sketch-plan.mjs` | 撞上 `BUILD_IN_PROGRESS`（同一 designId 正在建） | 环境相关 |
| `test/model-invoke-batch.mjs` | 自建的 broker 管道连不上（`BROKER_UNAVAILABLE`） | 需要环境 |
| `test/images.mjs` | 需要 SOLIDWORKS 在线，本轮 120 秒超时 | 需要环境 |

绿的 30 个里包含 `syntax`(219)、`contracts`(78)、`isolation-pid`(82)、`bili-bypass`(106)、
`plugin-fixes`(66)、`affinity`(51)、`deliver-route`(38)、`design-store`(32)、`snapshot`(27)、
`verify-designid`(22)、`definition-arg`(20)、`drawing-schema`(16)、`envelope-shape`(13) 等。

## 复现

```powershell
cd <repo>
node test/suite.mjs            # 全量：会自己起一个 SOLIDWORKS 并回收，跑完约 40 分钟
node test/plugin-fixes.mjs     # 离线，十秒量级
```

离线单跑时不会再起 SOLIDWORKS；`-live` 结尾的用例需要一块可独占的实例（套件只用自己起的
那个，不杀你先开着的窗口）。
