# 本机经验库现状（notes.jsonl）

这份文件写的是**记忆文件本身**的事实（在哪、有几条、哪条错过），不是建模方法。
条目数会变，以 `workspace action="preflight"` 返回的 `changes.lessons` 为准。

## 一、在哪、怎么被读到

| 项 | 值 |
| --- | --- |
| 经验文件 | `C:\Users\mota\AppData\Local\sw-mcp\knowledge\notes.jsonl`（每行一条 JSON） |
| 配方文件 | `C:\Users\mota\AppData\Local\sw-mcp\knowledge\recipes.json` |
| 条数 | 8 条（2026-11-14 22:05 整理，整理前 6 条） |
| 会话开头注入 | 本机 DSH 插件的 `📌 本机经验`，每个会话第一次工具调用后追加一次 |
| 每次 preflight 注入 | `workspace action="preflight"` → `changes.lessons`，最多 8 条 |
| 注入范围 | 只注入 `status` 为 `curated` / `verified`（或 `curated:true`）且没有 `supersededBy` 的条目 |
| 其他读法 | `workspace action="lesson" lesson={action:"search"}` 显式检索；`workspace action="lesson" lesson={action:"recipes"}` 读配方（现为空壳） |

配方已迁出：`skills\sw-parametric` 的「开顶抽壳」一节。`recipes.json` 只剩 `{"schemaVersion":1,"note":"…","recipes":[]}`，
读代码对非数组返回空列表，不会崩。

## 二、8 条各是什么

| # | id | status | 主题 |
| --- | --- | --- | --- |
| 1 | `n-cur-0` | working（curated） | 一张草图里别放两个重叠/相切的闭合轮廓 |
| 2 | `n-cur-1` | working（curated） | 轮廓边压在公共面上时，切除往有料一侧偏 0.2–0.5 mm |
| 3 | `n-cur-2` | working（curated） | `FeatureCut4` 第一个参数是「单方向」，不是「切除」 |
| 4 | `n-cur-3` | working（curated） | 验收三态：pass / fail / unmeasured，unmeasured 不是尺寸错 |
| 5 | `n-mw7x9qff-9rlg` | verified | `cut` 的 `startOffset` 生效；判断切在哪看几何位置（**本条曾记反，见第三节**） |
| 6 | `n-mw7x9qfl-l5kv` | working | 圆柱面与平面只相切不重叠时，拉伸不会并入原实体 |
| 7 | `n-mwghaoyw-a2dr` | curated | 导出前必须清空选择，否则 `SaveAs3` 返回 true 但文件只有 10,642 B |
| 8 | `n-mwghaoyw-27v7` | curated | 本机 `FeatureLinearPattern5` / `FeatureCircularPattern5` 不支持，别再试组合 |

## 三、一条经验是怎么过时的（真实案例）

`n-mw7x9qff-9rlg` 记于 2026-11-08 22:23，内容是「cut 不认 startOffset，切除总是从草图平面往一侧拉；
更稳的做法是干脆不要切除」。

- 记录时这句话是**对的**：那版 `Builder.CutSketch` 确实把 `startOffset` 丢了，探针实测切在 X 0…50，
  而不是 −32.5…17.5。
- 2026-11-09 代码修了：`bridge/src/Builder.cs:568-609` 明确写「The start offset never reached FeatureCut4 …
  **Now** the requested side is authoritative」，并新增回归 `test/cut-semantics.mjs`（`startOffset=10` 时孔在 10…15）。
- **记录没跟上**。从 11-09 到 11-14，这条旧结论一直随 `status` 注入，等于每天给模型一条与当前代码相反的指令；
  同一时间 `skills\sw-parametric` 的 `startOffset` 小节又说拉伸可以用偏移 —— 两处一起读会得到相反结论。
- 2026-11-14 处理：不删行，改正文 + `status:"verified"` + `supersededNote`（写清被哪次代码修改推翻），
  `at` 保留原记录时间、新增 `updatedAt`；skills 里补一句「以本文件与 `test/cut-semantics.mjs` 为准」。

教训一句话：**记忆里的结论有保质期，代码一改就可能变成反向指令。**

## 四、给未来的写经验规则

1. **写结论时同时写依据**：一句话正文 + `evidenceRefs`（文件:行号，例如 `bridge/src/Operations.cs:972-986`）。
   没有依据、只是一次观察的，`status` 只填 `working` —— 它不会被自动注入，也就不会误导人。
2. **代码改了就回写**：旧条目要么 `workspace action="lesson" lesson={action:"supersede"}` 换掉（新条 `supersedes` + 旧条 `supersededBy`），
   要么 `status` 降级为 `deprecated`。不要留着「半对」的条目继续被注入。
3. **一句话讲完**：做了什么 → 看到什么 → 结论。测试编号、探针体积小数、设计定义都不进记忆
   （`lessonGate` 的 240 字上限就是给这条兜底的）。
4. **`curated` 是特权不是装饰**：只有「换一个零件仍然成立、且能被代码或测量复核」的结论才配 `curated`；
   填错一次，它就以「本机实测」的口吻进入之后每个会话。
5. 配方不写在这里：可参数化的流程进 `skills\sw-parametric`，`recipes.json` 只留空壳。
