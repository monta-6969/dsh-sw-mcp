# 参数化建模 —— 让关系落在 SOLIDWORKS 原生尺寸上

这个文件解决一个问题：怎么让**用户关掉 Agent 之后，在 SOLIDWORKS 里手改尺寸还是对的**。

造型正确只说明这一次画对了。参数化正确要求尺寸和关系落在 SW 自己认识的地方：
草图的原生尺寸、草图关系（对称/重合/距离）、以及方程式里的全局变量。

建模走原生单步工具：一次调用只做一个动作，同类几何可以在一次调用里用数组批量给。
不为一张图写整段程序，也不再靠底层 API 顺序去「拼」一个特征。

## 一、五类关系，各自落在哪

用户改一个尺寸时，模型能不能跟着变，取决于这条关系有没有落到 SW 原生对象上。

| 关系 | 落在哪 | 为什么不能自己记 |
| --- | --- | --- |
| 支承（这块板放在哪个面/基准面上） | 草图的基准面，或面支承草图 | 自己记一个 Z 值，用户改板厚就错位 |
| 定位（孔在板上的位置） | 草图点之间的 `sgSYMMETRIC` + 一条到边界的尺寸 | 只写坐标，改板宽孔会留在原地 |
| 尺寸（宽、高、孔径） | 每个几何元素自己的原生尺寸 | 多个孔标一个 `sgEQUAL`，改直径只动一个 |
| 同轴（凸台孔与中心孔） | 同一条中心线，或同一个草图点 | 两个孔各自写坐标，改凸台位置就分家 |
| 终止（拉伸到哪、切除多深） | 特征的终止条件（盲/贯穿/到面） | 写死深度值，基体改厚就切不透 |

**判断标准**：在 SOLIDWORKS 里双击这个尺寸能改，改完重建模型是对的 —— 这条关系就落地了。
只有 JSON 里有、SW 里没有的，等于没落。

## 二、先规划，再一次一个动作

参数化建模的标准单步序列：

```
model action="plan"   definition={ schemaVersion:3, params:{...}, features:[...] }
model action="build"  definition={...}  designId="<稳定 id>"
inspect action="bodies" / "sketch" / "measure"   # 回读几何与约束
qa action="verify"    expect={...}               # 对照标注逐条核（先 activate capability="qa"）
deliver
```

- `plan` 只做静态检查，不碰 SOLIDWORKS，可以反复跑。`ready:false` 时先修定义，不要 build。
- `assumptions` 里写未标注尺寸；未确认的假设挡住 build，确认后写 `acceptedAssumptions`。
- 参数名与 `designId` 在整条链上保持一致；不要依赖「当前活动文档」。
- 改尺寸用 `model action="edit" parameters={...}`，不重新 build 整件。
- 只有单步动作真的缺能力时，才用 `advanced_api` 或 `catalog` 找入口；先查 `catalog action="detail"` /
  `kinds` 成员清单或工具说明确认签名与实测状态，不猜 API。`advanced_api`、`assembly`、
  `assembly_inspect`、`qa`、`datum` 这些按需组要先
  `catalog action="activate" capability="<组名>"`。

### 参数修改的唯一入口

build 一次声明：params、每条草图尺寸（diameter/distance）、几何关系、终止条件、bind/name。
build 后先 `constraints action="dimensions" dimensionAction="list"`：

- 0 条 = build 没落地尺寸，报缺口，改设计定义后重建；不要 add。
- 有 reference=true = 尺寸不可驱动，报 `DIMENSION_NOT_DRIVING`；不要 remove 后重加。

改参数：`model action="edit" parameters={...}`；回 `mode="dimension"`、`driven[].bound=true` 才算原生驱动。
回 `mode="rebuild"` 且 `bound=false`：说明该参数没有原生尺寸，按缺口报告；允许重建但不得声称参数化。

`dimensions.add/remove` 只用于图纸标注缺失或删错标注，不用于修 build 定义。

## 三、板件与孔组：关系怎么落

板件的对称拉伸：终止条件用双向对称，两个方向各取总厚度的一半。厚度只绑一侧会让
「改板厚」只长一半 —— 两侧都要绑到同一参数（或 `参数/2`）。

孔组用**草图内多个圆 + 一条贯穿切除**，不用阵列：

- 在孔草图内部画两条构造中心线（水平 + 竖直，过原点）；
- 每个圆一条自己的原生直径尺寸（不要用 `sgEQUAL`，相等关系不会传播到每个孔）；
- 左孔↔右孔、上孔↔下孔两对点对点 `sgSYMMETRIC`；
- 一条点到线尺寸把孔心到边界绑成参数表达式（例如 `板宽/2 - 边距`），由 SW 求解。

只写坐标是最常见的错：改板宽之后孔心留在原地，距边变成零。尺寸与关系必须在
草图打开时落下去；原生 `build` 会自己处理草图编辑态，不需要再手写 `EditSketch`。

改板宽/孔径时用 `model action="edit"`，回读 `inspect action="measure"` 与
`qa action="verify"`，不要重建整件。

## 四、方向、基准面与坐标系

SOLIDWORKS 是 **Y 向上**。三张基准面的草图坐标到世界坐标的映射：

| 基准面 | 草图 u | 草图 v | depth 正方向 |
|---|---|---|---|
| plane 0 前视 | +X | +Y | −Z |
| plane 1 上视 | +X | **−Z** | −Y |
| plane 2 右视 | −Z | +Y | −X |

两条推论：

- **水平的底板画在 plane 1**（它的两条轴是 X 和 Z），**竖直的筋板/凸台画在 plane 0**
  （它的两条轴是 X 和 Y）。画反了零件就「躺着」，而且每个尺寸看起来都对。
- 草图 v 轴在上视面上是 **−Z**，所以世界 z 写成草图 v 要变号。设计定义里约定：
  **先换成世界坐标**，再按上表换成草图坐标；写错了用 `inspect action="bodies"` 的 box 立刻看得出来。

拉伸方向写世界轴，不写布尔：

```json
{ "kind": "extrude", "profile": "plate", "depth": "plate.t", "direction": "+Y" }
```

`direction` 只能是这张面法向的两个轴之一，写别的轴会得到 `BAD_DIRECTION` 并说明原因。
`startOffset` 可以让拉伸从离草图面一段距离处开始，用来做台阶/凸台，不必新建偏移基准面
（偏移基准面会以橙色线框出现在每张截图里，还多一个可能失效的引用）。`cut` 同样认
`startOffset`，回归用例是 `test/cut-semantics.mjs`。

## 五、基准（datum）：当前能力与兜底

装配定位如果只认拓扑面，一次重建换掉面序，配好的位置就会悄悄指到别处。命名基准由
`design.json` 持有名字，位姿由 SOLIDWORKS 回读，重开之后按名字还找得到。

**当前能力**（先 `catalog action="activate" capability="datum"`）：

```
datum action="create" designId="<id>" name="<name>" kind="plane|axis|point|coordSys"
                     source={ type:"coords|faceEdge|circleCenter|cylinderAxis|twoPlanes|planeOffset", ... }
datum action="get"    designId="<id>" name="<name>"
datum action="list"   designId="<id>"
datum action="delete" designId="<id>" name="<name>"
```

- 基准名是稳定引用：不要重名；改名先 `delete` 再 `create`，或换一个名字。
- 装配里用 `placement:"datum:<name>"` 引用基准，不写死坐标、不引用容易变的面 id。
- `list` 里标 stale 的基准表示「文件里有、模型里没有」，先重建或删掉再继续。

**兜底**：当前工具面建不了所需基准时，用三张标准基准面、`face` 或 `startOffset` 完成同一件事；
不要为了定位在模型里堆一堆偏移基准面。确实做不到就停下说明，不伪造一个「看起来对」的位置。

## 六、圆角 / 倒角 / 抽壳：当前能力与兜底

| 特征 | 当前能力 | 兜底 | 不要做 |
| --- | --- | --- | --- |
| 圆角 | 设计定义里的圆角特征（竖边/圆周边），随 `model action="build"` 落地；回读体积必须变化 | 选不中目标边时，确认边 id 后重试一次；仍失败就保留尖边并声明 | 用切除/短折线「拼」一个圆角 |
| 倒角 | 当前工具面没有首类倒角动作/设计定义 | `advanced_api` 调 `InsertFeatureChamfer` 前先查 `catalog`/`kinds` 与签名，确认后只试一次 | 不查签名连试多种参数组合 |
| 抽壳 | `catalog` 有抽壳能力与实测证据（`IModelDoc2` 上的成员，不在特征管理器） | `advanced_api` 调 `InsertFeatureShell`（壁厚用米），先确认开口面；失败就保留实心并声明 | 把「返回非 null」当成功 |

共同规则：特征返回非 null **不算成功**，必须回读体积/包围盒确实变了；没变就按失败处理，
在交付里明确写「该特征未落地」。圆角/倒角/抽壳都不是建模主链的必经项，缺了要说明，
不要让整件因为一个装饰特征而变成猜出来的形状。

## 七、语义参数与 SW 全局变量

每个设计参数在 SW 里落成一个全局变量，参数名里的点换成下划线：`plate.w` → `plate_w`。

- 建变量与绑尺寸都通过设计定义的 `params` / `bind` 完成；原生 `build` 负责写进 SW。
- **`EquationMgr.Add2` 返回的是新方程的索引，不是成功码**：0、1、2… 都可能是成功，负数才是失败。
- 派生表达式可以直接写在变量里（例如 `"hole_edge" = "plate_w" * <边距比例>`），由 SW 求解。
- **方程式驱动的尺寸不能直接写 `SystemValue`**：回读可能是新值，几何却一丝不动。
  要走变量，不能绕过它。
- `SaveAs` 改名后方程式里可能仍写着旧文档名：原生 `build`/`edit` 会修（回包 `repairedEquations`），
  用 `advanced_api` 手写保存时要自己修完再回读。

## 八、验收：坐标正确 ≠ 参数化正确

**硬规则：验收不许自证。**

- `qa action="verify"`（先 `catalog action="activate" capability="qa"`）的 `expect`
  **不得**填 build/edit 刚返回的数值（体积、包围盒、任一测量值）。
  那是把「它说的」当「它对的」。
- `expect` 只能来自你自己的解析计算或图纸标注换算，并在同一段汇报里写出算式。
  算不出来就说明还没读懂图，先回去读图，不要拿返回值凑。
- **交付前另取一条独立证据**：对导出的 STEP 跑 `analysis action="step"`；有参考答案时再加
  `analysis action="diff"`（对比 `comparePath`），把 volume / bbox / 面数 / 圆柱数贴进汇报。
- **两者相对误差 > 0.5% 视为验收不通过**，回头查形状，不许直接交付。
- `verify` 的 `unmeasured` 不等于失败：先看 `available` 换查询，别改模型。
- **参数化正确**：`expect` 里带 `parametric: true`，核对绑定数。
- **传播测试**：`model action="edit"` 改一个参数，看体积和孔位是否按解析式变化；
  连续多次精确命中，才能说参数化过了。

## 九、任意轮廓：sketch → extrude / cut / revolve

设计定义里轮廓和特征是分开的两件事，可以分开写，也可以内联：

```json
{ "kind": "sketch", "id": "outline", "plane": 0,
  "primitives": [ { "shape": "rect", "center": [0, 0], "width": "plate.w", "height": "plate.h",
                    "bind": { "width": "plate.w", "height": "plate.h" } } ] }
{ "kind": "extrude", "id": "body", "profile": "outline", "depth": "plate.t",
  "symmetric": true, "bind": { "depth": "plate.t" } }
```

- `plane` 0/1/2 = 前/上/右视基准面；`face: "top" | "bottom"` 表示画在实体的某个面上。
- `extrude` / `cut` 的 `profile` 可以是 sketch 的 id，也可以直接内联一份轮廓对象。
- `revolve` 需要轮廓里有构造中心线：sketch 上加 `"axis": "x"` 或 `"axis": "y"`。

**什么能参数化，什么是死的**

| primitive | 原生尺寸 | 改参数会不会动 |
|---|---|---|
| `rect` | 宽、高两个尺寸（Rectify 加对称关系） | 会 |
| `circle` | 每个圆一个直径尺寸 | 会 |
| `polyline` | 无（坐标建模时求值后烧进草图） | 不会 |
| `polygon` | 无（同上） | 不会 |

`model action="build"` 返回的每个特征都带 `parametric` 字段，polylines/polygons 一律 false。
看到 false 就不要承诺「改个参数就行」—— 要么换 rect/circle 组合，要么明说要重建。

小矩形不要依赖「中心矩形」的自动行为：原生 `rect` 用四条线画，画完看
`segments / openEnds / closed` 三个数；`openEnds > 0` 的草图，拉伸必然失败。

反向的拉伸**照样成功**，只是变成第二个实体。`inspect action="bodies"` 多于一个实体时，
说明方向错了：先记基线，再用 `model action="rebuild"` 按定义重建；不要连续 `undo` 追。

## 十、装配

优先用原生动作，不手写插入组件的 API（先 `catalog action="activate" capability="assembly"`）：

```
assembly action="assemble" designId="<id>" components=[{ path:"<绝对路径>", x:0, y:0, z:0,
                                                          placement:"origin" }]
```

- 零件路径必须是绝对路径；相对路径在底层只报一个看不出原因的码。
- 需要按基准定位时写 `placement:"datum:<name>"`（先按第五节建好基准）。它只对齐基准原点，
  朝向要再用 `assembly action="componentRotate" frame="local"` 补。
- 放完读回：先 `catalog action="activate" capability="assembly_inspect"`，再
  `assembly_inspect action="assembly"` 看组件与包围盒，不要只信返回值。
- 配合：`assembly action="mate"`（面用 `inspect action="faces"` 取 persistentId，两端只接受面 id），
  转动/平移组件用 `assembly action="componentRotate"`（`frame:"global"|"local"`）/
  `componentTranslate`；驱动用 `assembly action="drive"`。
- 装配验收看自由度与配合（`assembly_inspect action="mates"` / `"assemblyFaces"`），
  不放心的界面先补同轴/距离，不要靠叠重合硬压。

**兜底**：原生 `assemble` 拒绝时，先查路径、文件存在、目标文档是否打开；仍失败就停止并报告，
不要退回 `InsertImportedComponent`（这个入口在本机不稳定，重复调用还会把 SOLIDWORKS 带崩）。

## 十一、工程图（任务需要时才做）

出图不是建模主链。先 `catalog action="detail"` 确认当前工具面有没有对应的出图动作；
没有就把已有图纸/PDF 用 `deliver` 导出，不要手写旧 API 去拼视图。

判据只看落盘文件：空图纸导出的 PDF 会明显小于有视图的图纸（与上一次成功件比掉一个数量级
就是坏文件），返回码不算证据。出图前模型文件必须存在于磁盘；0 面的空零件会让视图调色板为空。
