# 原生单步工作流 — N1–N10

本文件是 L2（DSH）的执行配方。规则与判据以 `流程规范/04-DSH-Native执行规范.md` 为准；数据字段以 `03` 为准。这里只写“当前工具面怎么走”，不重复职责、字段定义和验收分级。

## 0 通用约束

- 默认工具面 8 个：`catalog`、`model`、`drawing`、`workspace`、`inspect`、`constraints`、`capture`、`deliver`。
- 按需组 11 个：`assembly`、`assembly_inspect`、`qa`、`workspace_ops`、`advanced_api`、`analysis`、`calculate`、`select`、`job`、`task`、`datum`。
- 未 `activate` 就调按需工具 = MCP 未知工具；先 `catalog action="activate" capability="<组>"`，读回包的 `unlocks/firstStep/requires/pitfalls/budget/exit`，再调。只开本场景需要的组，结束可 `deactivate`。
- 开工先 `workspace action="preflight"` 一次；不例行轮询 `workspace_ops` 的 `status`/`instances`。
- 一次调用只做一个动作；同类几何可以在一次调用里用数组批量给。
- `designId` 全程不变；不依赖“当前活动文档”。
- 尺寸只来自标注、用户确认或自己写出的算式；未标注值进 `assumptions`。
- 每次改几何或尺寸，重跑关系审计与 `qa action="verify"`；先激活 `qa`。
- 存盘导出只用 `deliver`；不清理、不关闭归属不明的文档。
- 工具描述与实现冲突：停，按 04 §13 报缺口；不猜参数、不试签名。

## 0.5 断线交接：一单元一 commit，长任务前写 `_state.md`

会话会被轮次上限切断：**结束消息发不出来**，工作区里的改动没人知道。两条硬规则：

1. **每完成一个可验收单元立刻 commit。** 一个单元 = 一个动作能自证 + 一条能跑的测试。不要攒到最后一起提交：攒着的改动在切断时等于不存在（2026-11-26 真蜗杆那批，19 个文件 + 2 个新文件全留在工作区，下一个会话只能靠 `git status` 考古）。
2. **长任务开工前先写 `_state.md`**（本次任务的工作目录，不是仓库根）：目标 / 已完成 / 下一步 / 当前阻塞。每完成一步就改它。被切断时它是唯一交接凭据——接手的人只读这一个文件就能继续。

`_state.md` 四项都要写具体的东西（命令、路径、实测读数），不写"继续完善"。四项之外的"已知坑"也记一行，省下重测一次。

## N1 单件新建

**适用**：有完整零件卡，尺寸/接口/基准/朝向齐全，要建新零件。

**前置**：`designId` 已定；零件卡与特征清单在手；同名项目不存在（或明确要新版本）。

**动作序列**

1. `workspace action="preflight"`（一次）。
2. `model action="plan" definition={ schemaVersion:3, params:{...}, features:[...] }`。
3. `ready:false` → 按 `blockers`/`openEnds`/`fitViolations`/`dimensionSources` 补定义；未标注尺寸写 `assumptions`；需要用户裁决的只问一次。
4. `model action="build" definition={...} designId="<id>"`（definition 传对象；被序列化成 JSON 字符串时服务会先 parse）。build 之后直接 `deliver kind="sldprt"`：deliver 按 designId 定位文档，活动文档不是目标也会自己激活/重开/重建，不需要先切前台。
5. `inspect action="bodies"` + `inspect action="sketch"` 回读几何与约束。
6. `catalog action="activate" capability="qa"` → `qa action="verify" expect={...}`；`expect` 来自自己的算式/标注，不抄 build 返回值。
7. 需要圆角/倒角/抽壳时先看能力：
   - `fillet` 仅支持有限边型（竖边/指定高度圆边）；不支持的边不要硬试，保留尖边并在交付写 `tool_gap`。
   - `chamfer` 当前 `missing`；不要声称已倒角。能用切除得到等效几何时才做，并在 `assumptions` 写清。
   - `shell` 当前 `missing`；用“外轮廓拉伸 + 内腔草图切除”替代，量最小壁厚、底厚、孔边距。
8. `capture`（iso/front/top）；需要剖视时 `catalog action="activate" capability="analysis"` → `analysis action="section"`（对 STEP），不要用 `capture view="section"`。
9. `deliver kind="sldprt"`。
10. `catalog action="activate" capability="workspace_ops"` → `workspace_ops action="close"` → `workspace action="open"` → 再 `inspect action="bodies"`/`qa action="verify"` 复测。

**预算**：`plan` ≤2；`build` 1；回读+复核 ≤4；截图 ≤4。超限先报告“为什么超、还差什么”。

**退出判据**：`verify` 全 pass；体积/包围盒有独立解析式核对；单实体；参数化件 `parametric:true`；交付文件落盘、可重开、读数一致；定位点/基准可回读，回退已标。

**失败转哪**：`plan` 不 ready → 补定义，不 build；`build` 失败 → 按错误码转 `sw-troubleshooting`，不连续重建；`verify` fail → 转 N3 做单点修正；`DOC_NOT_OPEN` → 转 N9。

## N2 从图纸建模

**适用**：有工程图/PDF/图片，要按图建零件并还原朝向。

**前置**：图纸路径可读；只读需要的那一节；`designId` 已定。

**动作序列**

1. `workspace action="preflight"`。
2. `inspect action="figure"`：先 `op="fit"` 看全图，再对不清楚的标注 `op="crop"` 放大；不拿像素当长度。
3. 交尺寸表：尺寸/公差/视图/锚点/模型轴或基准面/来源；按 `sw-drawing-read` 的列交齐。
4. 判断投影法与视图方向；写 `cad.orientation`：
   `{ "projection":"first|third", "view_dirs":{"front":"...","top":"...","right":"..."}, "rotation_matrix":[[...],[...],[...]], "locating_datum":"DAT-...", "note":"..." }`
   这是数据字段，不是工具 action；写进零件卡/`design.json`，装配与复核按它还原。
5. 图纸有基准符号 → `catalog action="activate" capability="datum"` → `datum action="create"`；若 `attach:true` 报 `DATUM_UNSUPPORTED`，改用 `placement:"origin"` + 自己换算，交付标 `datum_fallback=true`，不要假装基准已建。
6. `model action="plan" dimensions=[...] definition={...}`。
7. 核对 `blockers`/`openEnds`/`assumptions`/`ready`。
8. `model action="build"`。
9. `inspect action="bodies"` + `inspect action="measure"` 量关键尺寸。
10. `catalog action="activate" capability="qa"` → `qa action="verify"`；`expect` 逐条来自尺寸表（含公差带）。
11. `capture`（iso/front/top）；需要剖视时 `analysis action="section"` 对 STEP。
12. `deliver`；重开复测按 N1 第 10 步。

**预算**：读图（`figure`/`read`）≤6；`plan` ≤3；`build` 1；`verify` ≤2 轮。

**退出判据**：尺寸表每行有对应 `verify` 结果；关键公差满足；朝向可由 `cad.orientation` 还原；未标注值全在 `assumptions`；截图与读数齐全。

**失败转哪**：读图不清 → 回 `crop` 或只就“结构读法”问一次；缺尺寸 → `assumptions`；方向错 → 查投影/轴映射后 `model action="rebuild"`；`verify` fail → N3；基准不可用 → `datum_fallback` + 报告。

## N3 改尺寸/改特征

**适用**：已发布件需改参数/尺寸；或要增加/删除特征。

**前置**：`designId` 存在；先 `workspace action="project"` 看 `params` 与当前版本；记基线（体积/包围盒/实体数/材料属性）。

**入口**：改参数只有 `model action="edit"` 一条路；build 后 `constraints action="dimensions" dimensionAction="list"` 0 条 = build 没落地尺寸，报缺口改定义后重建，不要用 `dimensions.add` 补 —— 判据与 `mode`/`bound` 读法见 `sw-parametric` 的「参数修改的唯一入口」一节。

**动作序列**

1. `workspace action="project" designId="<id>"`（确认参数名与版本）。
2. `inspect action="model"` 记基线。
3. 只改尺寸：`model action="edit" parameters={ <只改要改的键> }`。
4. 仅当回包要求或几何没刷新时 `model action="rebuild" designId="<id>"`；不要整件重 build。
5. 改特征结构：`model action="plan"` 生成新定义 → `model action="build"` 新 rev；旧版保留并在 `change-log` 记 Superseded。不要用 `edit` 硬改不存在的特征。
6. `inspect action="bodies"` + `inspect action="measure"` 回读变化；改特征后重查孔位/壁厚/配合面。
7. `catalog action="activate" capability="qa"` → `qa action="verify"`；`expect` 按解析式算，覆盖变更范围外的不变量。
8. `deliver`（版本递增，路径不变）；重开复测。

**预算**：`edit` ≤2；`rebuild` ≤1；回读+复核 ≤3；改特征结构按 N1 的 build 预算。

**退出判据**：参数回读与请求一致；体积/关键尺寸按解析式变化；变更范围外不变；`parametric` 绑定没丢；新 rev 可重开；材料/密度等属性未被 rebuild 丢掉。

**失败转哪**：`UNKNOWN_PARAM` → 回 `project` 看真名；`EDIT_NOT_APPLIED`/`EQUATION_MANAGER_REJECTED` → 转 `sw-troubleshooting`；回包 ok 但几何没动 → 按失败处理，不交付、不谎报；特征不支持 → 提 ECR/回 L1，不自创结构。

## N4 子装配

**适用**：多个零件组成一个单元，要定位、配合、驱动。

**前置**：每个零件都已落盘并 Released；装配 `designId` 已定；先确定固定件。

**动作序列**

1. `workspace action="preflight"`。
2. `catalog action="activate" capability="assembly"`；需要读配合时再 `capability="assembly_inspect"`。
3. 插入固定基座：`assembly action="assemble" components=[{ path:"<绝对路径>", x:0,y:0,z:0, placement:"origin" }]`；`componentLock` 固定；回读位姿。
4. 逐件插入：优先 `placement:"origin"` + 自己算好的变换；`bbox-center` 只保证包围盒中心，不保证朝向，插入后必须读朝向并纠正。
5. `placement:"datum:<name>"` 当前端到端 blocked（datum 真几何 missing）：会 `DATUM_NOT_FOUND`。不要用 `attach:false` 假装已定位；改用 origin + 换算，交付标 `datum_fallback=true`。
6. `catalog action="activate" capability="assembly_inspect"` → `assembly_inspect action="assembly"` 读组件与包围盒。
7. `inspect action="faces"` 取配合面 `persistentId`；面会变时用命名基准/基准面代替。
8. `assembly action="mate"`：`mateFirst`/`mateSecond`/`mateKind`（`concentric`/`coincident`/`distance`/`angle`/`gear`）；两端只接受面/基准 id，不传边/顶点。
9. 需要刚性同转 → `assembly action="mateLock"`；固定组件 → `componentLock`。每加一条配合读一次 `assembly_inspect action="mates"`。
10. 需要旋转：`componentRotate` 只用 `frame:"global"`；`frame:"local"` 当前 `missing`（回 `frameUnsupported:true`/`incomplete`）。注意 `axis` 经验上按组件局部轴解释，不要假设 `axis:"x"` 就是全局 X；先做 1 次小角度探针，读 transform 与 `center_drift`，确认轴向后再用。需要精确全局姿态时，先转后按目标中心闭环平移；交付标 `frame_fallback`/`axis_probe`。
11. 干涉/自由度：当前无装配干涉回读、无 DOF 数值；用 `assembly_inspect` + `inspect action="measure"` 量关键间距，交付写 `unmeasured` 与人工核对结论。不要写“干涉通过”；AABB 交叠不是实体干涉。
12. `catalog action="activate" capability="qa"` → `qa action="verify"`；装配档若恒 skipped，写 `unmeasured`，不冒充 pass。
13. `capture`（iso/front/top）+ `deliver`；`workspace_ops close` + `workspace open` 后复测。

**预算**：`assemble` ≤2；`mate` ≤5；`verify` ≤2；驱动 ≤2；重开 1 轮。

**退出判据**：组件数/位姿/配合数与设计意图一致；关键间距满足；无非预期静态碰撞；重开后读数可复现；`datum_fallback`/`frame_fallback`/`unmeasured` 已写清。

**失败转哪**：`mate` 不生效 → 回 `faces` 重取面或改用基准面；自由度不对/过定义 → N5；组件没进装配 → 查绝对路径与文件存在，不退回旧 API；datum/local 不可用 → 按回退路径，不猜。

## N5 装配排错

**适用**：装配报错、过定义、组件乱动、配合不生效。

**前置**：装配 `designId`；先激活 `assembly` 与 `assembly_inspect`；先读现状并记下来，不边猜边删。

**动作序列**

1. `workspace action="preflight"`。
2. `assembly_inspect action="assembly"` + `assembly_inspect action="mates"`：列配合、组件、当前位姿。
3. `assembly_inspect action="assemblyFaces"`：查配合面是否还在（`persistentId` 是否失效）。
4. 先固定基准件：`componentLock`（或 `mateLock`）。
5. 删重复/冲突配合：`assembly action="mateDelete" mateName="<名>"`。
6. 补最小约束：`assembly action="mate"`（同轴/距离/角度），一次补一条；每步读 `mates`。
7. 重开复测：`workspace_ops action="close"` → `workspace action="open"` → 再 `assembly_inspect action="mates"`。
8. 仍不过 → 停，报告配合清单、位姿、重开前后差异；不靠叠重合硬压。

**预算**：读 ≤4；改配合 ≤6；重开 1 轮。

**退出判据**：配合数量/类型与设计意图一致；无过定义；重开后位姿/配合不变；差异有解释。

**失败转哪**：面失效 → 改用基准面或重新取面；配合类型不支持 → 换等效约束；过定义 → 删到最小集再补；重开丢失 → 按环境故障汇报，不反复重开。

## N6 整机与运动

**适用**：子装配已 Released，要做总装、驱动、读数与包络检查。

**前置**：子装配各自通过 N4；总装 `designId` 已定；全局坐标系/基准；运动规范（输入、方向、行程、速比、限位）。

**动作序列**

1. `workspace action="preflight"`；确认单位、全局原点、已有文档。
2. `catalog action="activate" capability="assembly"` + `assembly_inspect` + `qa` + `workspace_ops`。
3. 新建/打开总装；写 `global_datum` 与总装坐标说明到 `design.json`；不要把子装配的局部原点当全局原点。
4. 插入固定基座：`placement:"origin"`；`componentLock`；回读位姿。
5. 按装配顺序插入子装配：`placement:"origin"` + 自己算的变换；datum 不可用时标 `datum_fallback`；每插一件读包围盒中心/朝向。
6. 按接口逐条 `mate`；先主基准（重合/同心），再轴向/距离，再角度/齿轮；每步读 `assembly_inspect action="mates"`。
7. 驱动：`assembly action="drive"`，给输入/输出定义；读 `measurements.angles`/位移；回包标 `mode:"scripted"` 时，只证明“按设定位姿动了”，不证明配合求解/真实动力学。
8. 行程/包络：扫关键位姿，`inspect action="measure"` 量极限间距；无干涉回读时写 `unmeasured`，用人工/截图核对，不写“无碰撞”。
9. `capture`（iso/front/top，关键位姿各一组）；需要剖视时 `analysis action="section"` 对 STEP。
10. `deliver`；`workspace_ops close` → `workspace open` → 复测方向/行程/速比读数。
11. 报告：输入/输出角或位移、方向、速比、行程、包络、静态间距、重开结果；`scripted`/`unmeasured` 明写。

**预算**：总装插入 ≤10；配合 ≤12；驱动 ≤2 轮；截图 ≤6；重开 1 轮。超限按 04 §12 拆子装配。

**退出判据**：方向/行程/速比读数符合运动规范；关键位姿无静态碰撞（或有明确 `unmeasured`）；包络满足；重开后读数一致；证据含读数与截图。

**失败转哪**：配合/位姿异常 → N5；驱动不按预期 → 查传动比/配合/驱动定义，不改设计；包络/间距不足 → 回 L1 提 ECR；`scripted` 不能替代真实运动验证。

## N7 独立复核

**适用**：交付前复核，或复核别人交付的件。只读，不改模型。

**前置**：落盘模型与图纸/尺寸表；`designId`；复核者不继承建模者假设。

**动作序列**

1. `workspace action="preflight"`。
2. 重开：`workspace_ops action="close"` → `workspace action="open"`；验证不依赖内存态。
3. `catalog action="activate" capability="qa"` → `qa action="verify"`，按六档逐项：`file`/`geometry`/`dimensions`/`positions`/`topology`/`assembly`。装配档对零件记 skipped；对装配体若 skipped/unmeasured，照实写，不算 pass。
4. `inspect action="measure"`/`constraints action="dimensions"`/`inspect action="sketch"` 抽查 2–3 条关键尺寸。
5. `qa action="snapshot"`/`evidence` + `capture`（iso/front/top）；剖视走 `analysis action="section"`。
6. 有独立审查需求 → `qa action="review"`；有参考答案/原图 → `qa action="compare"` 或 `analysis action="diff"`。
7. 出报告：六档逐档 pass/fail/unmeasured；附数字读数、公差判断、证据路径；结论只基于产物。

**预算**：`verify` 1 轮；抽查 ≤3；截图 ≤4；报告 1 份。

**退出判据**：六档无 fail；`unmeasured` 有解释；报告含读数（截图只是佐证）；证据路径存在；与基线差异写清。

**失败转哪**：几何/尺寸 fail → 交回 N3；装配 fail → N5；证据缺失 → 补 `capture`/`evidence`；重开失败 → N9/环境条目。

## N8 只读预检

**适用**：开工、交接、判断当前环境；不改任何文档。

**动作序列**

1. `workspace action="preflight"`：读 document/designId/instance/units/template/precision/capabilities/lastVerify/lastDelivery/notes/nextActions。
2. `catalog action="active"`：看已激活的按需组；不要为了“看全”把所有组都激活。
3. 需要看模型时 `inspect action="model"`/`bodies`；只读，不 build/edit/save。
4. 输出事实：文档是否打开、绑定是否一致、单位、实例、能力、上次交付/验证、下一步；不写建议性结论。

**预算**：1 次 preflight + ≤3 次只读。

**退出判据**：事实齐全；没有改文档；`SW_NOT_RUNNING` 作为正常回答记录，不启动 SOLIDWORKS。

**失败转哪**：文档未打开 → N9；绑定不一致 → 停，报告；能力缺失 → 04 §13。

## N9 文件恢复

**适用**：`DOC_NOT_OPEN`、存错文档、重开后找不到、实例绑定混乱。

**动作序列**

1. `workspace action="preflight"` 查 document/designId/instance/未保存标记。
2. `catalog action="activate" capability="workspace_ops"` → `workspace_ops action="instances"`/`status` 查实例与绑定。
3. 只操作自己的实例/文档：`workspace action="open"` 重开；必要时 `workspace_ops action="closePath"` 关掉错路径；`reload` 只用于确认磁盘版本。
4. `inspect action="model"`/`bodies` 回读；与保存前基线比体积/包围盒/实体数。
5. 记录：之前/之后的 document、designId、instance、读数、动作；若文档有未保存修改，停，不保存、不覆盖，报告用户。
6. 若确认是重复实例/错误绑定，只关自己的；不动其他会话的实例。

**预算**：诊断 ≤4；重开 1 次；不反复 close/open。

**退出判据**：文档与 designId 一致；读数与保存前一致；没有覆盖/丢失；其他会话文档未被触碰。

**失败转哪**：仍 `DOC_NOT_OPEN` → 报环境故障；绑定冲突 → 停，交 L0；生产文档有未保存修改 → 停，交用户。


## N10 工程图/出图

**适用**：已 Released 的零件/装配要二维视图或 PDF。

**前置**：模型落盘；图号、模板、图幅、投影法、视图清单、输出路径在手。

**动作序列**

1. `workspace action="preflight"`。
2. `drawing`：`model`=模型绝对路径，`views`=[...]，`projection`=`first`/`third`，`template`=模板，`outputPath`=SLDDRW 路径。
3. 读 `dropped`/`missed`/`viewCount`/`projection.after`；`missed` 非空就改视图名/模板，不硬说齐全。
4. 截图或打开图纸看视图方向、比例、遮挡；需要剖视走 `analysis action="section"` 对 STEP，不用 `capture view="section"`。
5. 标注/标题栏：当前工具只保证视图；关键尺寸/公差/标题栏若不能自动生成，列 `tool_gap`，交 L1/工具改造，不手写假标注。
6. `deliver kind="pdf"`；读路径/字节/页数；重开 PDF 检查。
7. 写 `drawing.json`：图号、对象/rev、模板、投影法、视图、`missed`、标注状态、PDF、缺口。

**预算**：`drawing` ≤2；截图 ≤3；`deliver` 1。

**退出判据**：视图齐全或 `missed` 有解释；投影法正确；PDF 可开；标注/标题栏状态写清。

**失败转哪**：视图放不上→换视图名/模板；投影错→改 `projection`；标注不支持→04 §13；PDF 空白→查视图/打印范围。

---

## N11 螺旋面：helix → sweep（蜗杆/螺纹/螺旋槽）

齿轮啮合必须按现实做：蜗杆要真螺旋面（ZA 阿基米德蜗杆：轴向齿廓是直线），不能用
「回转芯 + 偏心圆盘错位拉伸」近似 —— 那种件在装配里穿模（实测 9 mm）。

### 三种建模入口，选一个，不要混着猜

| 入口 | 什么时候用 | 形状 |
|---|---|---|
| `model action="build"` 里写 `{kind:"helix"}` / `{kind:"sweep"}` | 一次声明整件（推荐） | 设计定义 |
| `model action="helix"` / `action="sweep"` | 文档已经在、草图已经建好，只想补一个特征 | 按特征名引用 |
| `advanced_api action="invoke"` | 前两条都不够时 | 直接调 API |

`build` 里的顺序是硬约束：**底圆草图 → helix → 轮廓草图 → sweep**。路径/轮廓/locator
都按 `features[].id` 引用；引用不存在报 `CURVE_NOT_FOUND`（不会静默跳过）。未知
`kind` 现在报 `UNSUPPORTED_FEATURE_KIND` —— 以前是无声跳过，整件照建、回包 `ok`，
少掉的那一步只体现在体积上。

### 配方：Ø14、m1、z1=1 ZA 单头蜗杆（螺纹长 30）

参数（GEARLAB `10-数据/齿轮/20-蜗杆蜗轮-几何与点表.md`）：
`m=1, z1=1, d1=14, γ=4.0856°, p_x=πm=3.141592, α_x=20.0469°, da=16, df=11.6,
分度轴向齿厚 1.5708, 齿顶 0.840, 齿根 2.446`。

```
1) 毛坯：平面0(前视) 圆 Ø16 → extrude 30（direction "+Z"）
2) 螺旋线底圆：平面0 圆 Ø14
3) helix：profile=hxbase, definedBy="heightAndPitch", height=30, pitch=3.141592
4) 轴向齿槽轮廓：平面1(上视，含轴)，四点梯形（x=径向, y=轴向）：
     半宽(r) = p_x/4 − (r−7)·tan(α_x)
     (5.8, +0.3475) → (5.8, −0.3475) → (8.4, −1.2963) → (8.4, +1.2963) → 闭合
     r=5.8 是齿根、r=8.4 越过齿顶，保证切穿
5) sweep：profile=groove, path=hx, cut=true（走 InsertCutSwept5）
```

**验收读数**（`inspect action="measure" measure={kind:"helix"}` 是从几何量的，不是读回输入）：

| 项 | 期望 | 本机实测 |
|---|---|---|
| 体积 | 4400–4800 mm³ | 4594.4709 |
| 面数 | 8（3 个圆柱面 + 螺旋槽） | 8 |
| 齿顶 / 齿根 Ø | 16.000 / 11.600 | 8.0 / 5.8（半径） |
| 导程 | π·m = 3.141593 ±0.005 | 3.141592 |
| 齿顶轴向齿厚 | 0.840 ±0.02 | 0.841 |

### 坑（都实测过）

- **轮廓必须与路径起点相交**：轮廓画在「过轴的轴向平面」里，并且梯形要盖住螺旋线起点
  `(7, 0, 0)`。轮廓整块在路径旁边 → `InsertCutSwept5` 返回 null → `SWEEP_FAILED`。
- **齿槽要错开半个齿距还是对齐**：把齿槽中心正对螺旋线起点（本例 y=0）最省事；螺纹
  相位在装配时再转，单件验收不看相位。
- **旋向**：`clockwise` 与 `reversed` 组合决定手性；建完先看 `measure kind="helix"` 的
  `hand`，要「右旋 + 沿 +Z 推进」就照上表默认值，不要凭直觉翻。
- **`draft` 现在真生效**（`Dchk1/Dchk2` 由 `draft≠0` 打开），但那是拉伸的拔模，不能
  代替倒角；`bevel` 在 gear 上不再被静默忽略。
- **扫掠切除必须验证体积下降**：桥接器自己会算，`SWEEP_NO_MATERIAL_REMOVED` 说明路径
  在体外或轮廓没碰到材料 —— 不要拿「特征树里有 SweepCut」当成功。
- 蜗轮是**喉式、且必须由这只蜗杆自身展成**（等于滚齿），不能用直齿近似；本工具面还没
  有「实体当刀具做多刀位布尔减」的动作，先用 `assembly` + `Combine` 手工路线，交付里
  标 `tool_gap`。

## N12 放样（真齿面/过渡体）

`model action="loft"`：`sections` 给两个以上截面特征名（顺序=放样顺序），
`mode="boss"|"cut"|"surface"` 分别走 `InsertProtrusionBlend2` / `InsertCutBlend` /
`InsertLoftRefSurface2`。少于两段一律 `BAD_ARGUMENT`（一段那是拉伸）。

直齿锥齿轮的正确做法是「背锥展开渐开线 → 大端/小端两截面放样」，**展开时要带 1/cosδ
因子**：漏掉它齿顶齿厚会差 0.5 mm（1.54 vs 2.07），3D 压力角退化成 14.43°。样件必须
与 `12-锥齿-对照基准点.csv` 的 36 点比对，分度圆齿厚必须完全一致。

## 当前能力缺口速查

| 能力 | 状态 | 本文件采用的走法 |
|---|---|---|
| `datum` 真几何 | missing | `placement:"origin"` + 自己换算；标 `datum_fallback` |
| `componentRotate frame="local"` | missing | 只用 global/显式旋转点；标 `frame_fallback` |
| 装配 DOF/干涉读数 | 干涉 **available（已校准）**；DOF 近似 | `inspect action="assembly"` 回 `interference`（布尔交集体积，贴面单列 `coincidentCount`）+ `dof`（按配合类型扣，见 `src/server/dof.mjs`，带 caveats） |
| 最小距离 `measure kind="minDistance"` | **unverified，禁止引用** | `IMeasure.Distance` 对圆柱面回轴线距（间隙 5.000 实测回 25.000）。间隙要判就用「偏置 + 布尔交」：干涉体积那把尺已校准 |
| `helix` / `sweep` / `loft` | **available** | `build` 的定义里或 `model action="helix"|"sweep"|"loft"`；配方见 N11/N12 |
| 锥齿 `bevel`/`coneAngle`/`faceWidth` | missing（明确报错） | `gear` 基元收到这些键 → `UNSUPPORTED_PARAM`；直齿轮不会冒充锥齿。要锥齿先做「背锥展开 + 大小端放样」，见 N12 |
| 螺旋齿 `helixAngle` | missing（明确报错） | 同上；齿面螺旋线作引导线还没接 |
| 螺旋导程读数 | **available** | `inspect action="measure" measure={kind:"helix"}`（沿螺旋边采样回归，不读输入参数） |
| `chamfer` | missing | 保留尖边或切除等效；标 `tool_gap` |
| `shell` | missing | 外轮廓拉伸 + 内腔切除 |
| `fillet` | degraded | 只用支持的边型；不支持就保留尖边 |
| `capture` 真剖视 | missing | `analysis action="section"` 对 STEP |
| `select` 边/顶点/实体/曲面体 | degraded/missing | 用面 persistentId 或基准；不用坐标碰 |
| `deliver` 自动重开 | available | 保存后 close → open → `inspect format=geometry` 读实体数；`verified:false` 不算交付 |
| `orientation` 字段 | 手工 | 写 `cad.orientation`，不是工具 action |
| `drawing` 标注/标题栏 | 仅视图 | 视图可出；标注/标题栏缺口写 `tool_gap`，不冒充完整工程图 |

缺口不是“可以忽略”：交付里必须写 `tool_gap`/`unmeasured`/`fallback`，由 L1/L0 决定是否接受。

## 总规则：请求了就必须完成，否则报错（禁止静默成功）

这条规则统一收口了这一类事故：**参数被吃掉 / 字段写 null，但回包 `ok`**。它比任何单个
bug 都贵，因为下游会按「回包里有没有那个东西」立规则，而工具永远说"有"。

| 情形 | 必须返回 | 典型现场 |
|---|---|---|
| 传了不认识的参数/枚举值 | `UNSUPPORTED_PARAM` | `revolve axis="w"`、`bevel` 在只做直齿的实现上 |
| 传了不支持的 feature kind | `UNSUPPORTED_FEATURE_KIND` | 旧实现把未知 kind 无声跳过，整件照建 |
| 参数合法但无法生效 | `UNSUPPORTED_PARAM`（附带 `detail` 说明为什么） | 薄壁类型拼错、扭转控制拼错 |
| 交付时拿不到回读 | `MISSING_READBACK`，**deliver 失败** | manifest 的 `sw` 块写过 null 却报成功 |
| 动作建了特征但没达到目的 | 失败码 + 读数 | `SWEEP_NO_MATERIAL_REMOVED`、`EXTRUDE_SEPARATE_BODY` |

`deliver` 的 `sw` 块现在必须是**保存后 close→open 回读**出来的：
`bodies / faces / volume_mm3 / mass_g（带 massBasis）/ bbox_mm / saved_at / reopened_at /
volume_after_reopen_mm3 / delta_pct`。拿不到就失败，不写 null。
写 manifest 之外的补充读数（例如自己要的验收表）放 `verify.json`，但那**不能替 deliver 签收**。