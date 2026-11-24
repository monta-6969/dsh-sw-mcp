# dsh-sw-mcp

DeepSeek Harness（dsh）的 SOLIDWORKS 2026 建模预设：装好后模式列表里多出
**「SW 建模（原生单步）」**（preset id `sw-native`）。

## 一、功能与目标

让 dsh 里的模型直接操作本机运行的 SOLIDWORKS：读参考图、规划几何、建模、装配、出工程图、
回读验收、存盘交付。目标就一条：**交付可验证** —— 每次改动之后要有可回读的读数，
拿不到就报 `unmeasured`，不当通过。

## 二、它会做什么、提供什么

**做**：单次调用只做一个动作，同类几何在一次调用里用数组批量给。

| 阶段 | 动作 |
|---|---|
| 开工 | `workspace preflight` 拿环境与项目，`brief` 拿当前进度 |
| 读图/规划 | `workspace read` 看参考，`model plan` 落设计定义（几何/尺寸/约束/语义参数） |
| 建模 | `model build` 一次声明完整几何；改参数用 `model edit`，不整件重建 |
| 装配 | `catalog` 激活 `assembly` 后：`assemble` / `mate` / 组件位移与驱动 |
| 出图 | `drawing` 出工程图；`capture` 出 iso/front/top/剖视 |
| 验收 | `inspect`（几何/面/实体/草图/读数）、`constraints`（关系与驱动尺寸）、`qa verify` 四态判定 |
| 交付 | `deliver` 存盘/导出，按 `designId` 定位那一份文档 |

**提供**：

- **19 个工具**：默认只挂 8 个（`catalog` `model` `drawing` `workspace` `inspect` `constraints`
  `capture` `deliver`），其余 11 个用 `catalog action="activate"` 按需打开：`assembly`
  `assembly_inspect` `advanced_api`（底层 `invoke`/`object`/`kinds`/`batch`）`qa`
  `workspace_ops`（实例与文档运维）以及 `datum` `select` `analysis` `calculate` `job` `task`。
- **固定回包形状**：`summary` / `designId` / `status` / `changes` / `measurements` /
  `artifacts` / `nextActions` / `capabilities` / `timings`。失败时 `changes` 也在，读数在
  `changes.measurements` 与 `measurements` 两处都能读。
- **具名失败语义**：`DESIGN_ID_REQUIRED`、`DOC_NOT_OPEN`、`DIMENSION_NOT_DRIVING`（加的是
  reference 尺寸）、`SKETCH_NOT_EDITABLE`（没进编辑模式）、`SELECTION_EMPTY`（选完了 ≠
  选中了），每条都带 `nextActions`。
- **6 份现场知识**（`skills/`）：原生配方、绘图基础、读图、参数化、装环境、排错。
- 契约与分派表（`contracts/`）、示例设计（`designs/` `drawings/` `samples/`）、测试套（`test/`）。

## 三、架构与创新点

```
dsh 会话
  └─ MCP 服务  server/server.mjs（Node ≥20，stdio）
       ├─ 工具面      tool-face.mjs      分层：核心 8 个 + 按需激活
       ├─ 纯函数层    deliver-route.mjs / definition-arg.mjs / geometry-plan.mjs …（离线可测）
       ├─ broker      broker/brokerd.mjs  实例池、通道、跨进程写锁
       └─ 桥接器      bridge/src/*.cs ──csc──> SwBridge.exe ──COM──> SOLIDWORKS 2026
```

设计上值得一说的地方（不是形容词，是可核对的取舍）：

- **交付不信任"保存成功"**：按 `designId` 认领文档 → 认不到就重开 → 再不成就按定义重建；
  存完关掉重开，按实体数/组件数判是否真的读到了几何。同名但身份证明不了的文件不认。
- **单步而不是整段程序**：只留一个原生单步入口，避免模型把十几次调用塞回一段程序里；
  批量靠数组。工具面分两层，默认 8 个，其余 `catalog` 激活。
- **契约单向生成**：`contracts/enums.json` 一处定义，生成 C# 常量与能力分派表，编译前强制
  校验，两端词表不会漂。
- **一个 SOLIDWORKS 服务多个会话**：broker 管实例池、通道（每个 `designId` 固定落一条）与
  跨进程写锁；桥接器发布靠"改名让路再拷新的"，不杀 worker，在途调用还能跑完。

## 四、环境与依赖

| 项 | 要求 |
|---|---|
| 系统 | Windows（COM、命名管道、UIA） |
| SOLIDWORKS | 本机已装 SOLIDWORKS 2026，路径 `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS` |
| Node.js | ≥ 20 |
| 编译器 | .NET Framework 4 自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（不需要 .NET SDK） |
| 运行时依赖 | `@modelcontextprotocol/server`、`zod`（`npm install --omit=dev`） |
| 宿主 | DeepSeek Harness |

装四步（细节与排错见 [`INSTALL.md`](./INSTALL.md)、[`skills/sw-setup`](./skills/sw-setup/SKILL.md)）：

```powershell
# 1. 编桥接器（仓库不含 bridge/bin，interop 程序集来自你的 SOLIDWORKS 安装）
powershell -NoProfile -ExecutionPolicy Bypass -File bridge\build.ps1
# 2. 落本机路径 + 装依赖（把 cordis.patch.yml 里的 <node.exe>/<repo> 占位符换成真实路径）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 3. 在 profile 的 package.json 里加依赖与 bundle（install.ps1 会把该粘的那段打印出来）
#    "dependencies": { "@local/dsh-sw-preset": "file:D:/tools/sw-mcp" }
#    "dsh": { "profile": { "bundles": ["@local/dsh-sw-preset"] } }
# 4. 重启 DeepSeek Harness（预设不做热重载）
```

运行时数据在 `%LOCALAPPDATA%\sw-mcp\`：`instances.json`（实例台账）、`logs\mcp-*.jsonl`
（调用日志）、`logs\review.jsonl`（审查日志）、`projects\`（设计存档）、`locks\`、`images\`、`out\`。

测试：`node test/suite.mjs` 跑全量（会自己起一个 SOLIDWORKS 并回收）；离线单跑
`test/plugin-fixes.mjs`、`test/envelope-shape.mjs`、`test/deliver-route.mjs`、
`test/definition-arg.mjs` 十秒量级。43 个离线用例目前 30 绿 / 13 红，逐条原因见
[`docs/known-stale-tests.md`](./docs/known-stale-tests.md)。

## License

MIT —— 见 [`LICENSE`](./LICENSE)。
