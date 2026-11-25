# 测试套

```
cd src
node test/suite.mjs          # 全量：自己起一个 SOLIDWORKS、跑完回收
node test/presets.mjs        # 清单自检（两个预设、插件路径、人设口径），秒级
node test/patch.mjs          # 用 cordis.patch.yml 里那条命令起 server，握手 + 列工具
node test/syntax.mjs         # 全仓语法 + 行尾
```

`suite.mjs` 的 `plan` 里排在前面的都不需要 SOLIDWORKS；真机用例在 `needsSolidworks`
名单里，suite 会等 SOLIDWORKS 就绪（最多 5 分钟）再跑。

## 现状（2026-11-25，整理目录之后实测）

**绿的**（这轮逐个跑过）：`syntax` `contracts` `dispatch` `affinity` `jobs` `broker`
`broker-run` `tasks` `patch` `isolation` `actions` `bridge-errors` `prompt` `plugins`
`bili-bypass` `presets` `delivery-check` `deliver-route` `definition-arg` `design-store`
`snapshot` `params` `invoke-units` `lesson` `stage-runtime` `compact-surface` `envelope-shape`
`evidence-schema` `drawing-schema` `plugin-digest` `plugin-fixes` `broker-launch`
`equation-reject` `export-degenerate` `attach-hardening` `bridge2` `lane-routing`
`param-pitch` `prompt-surface` `doc-sweep` `acceptance-mcp`。

**红的**。原因都写在各自文件头，属于**旧接口没跟上**，不是这次改目录改坏的：

| 用例 | 红在哪 |
|---|---|
| `smoke.mjs` `workspace.mjs` | 还按老工具面断言（默认要有 `select`/`calculate`/`analysis`/`job`/`task`，并调 `workspace action="status"`）；这些现在按需激活，`status` 已划进 `workspace_ops` |
| `catalog.mjs` | 7 条断言按老 catalog 动作名与分页结构写 |
| `mcp-ops.mjs` `read-only-guard.mjs` | 按旧 `SW_MCP_TOOLS=inspect` 只读实例与旧 ops 动作写 |
| `design-contract.mjs` `cwd.mjs` `model-invoke-batch.mjs` | 旧设计契约 / 工作目录 / 批量调用语义 |
| `polite-mode.mjs` `sketch-plan.mjs` | 旧的礼貌模式与草图规划口径 |
| `verify-hints.mjs` | 断言 `holes`/`cylinders` 提示文案，与现在的 hint 组装路径对不上 |
| `native-preflight.mjs` | 62/63；唯一红的一条要求 `deliver` 描述里出现「回读字节/时间戳」的原话 |
| `gate-bypass.mjs` `gate-revision.mjs` `review-state.mjs` `review-read.mjs` `deliver-gate.mjs` | 交付门 revision 口径 / 审查状态盘，按旧语义断言（门现在只做程序化检查，不再拉审查子代理） |
| `tool-face-smoke.mjs` `images.mjs` | 90 秒内没结束（都要真起 MCP 会话或等图） |

真机用例（`needsSolidworks`）这轮没跑：跑它们要占用本机 SOLIDWORKS，会打断正在做的建模。
`assemble-designid` `instance-reap` `relations-edit` 上次实测是红的，这轮同样没跑。
