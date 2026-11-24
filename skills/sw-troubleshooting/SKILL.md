# 故障排查 —— 每个条目都是这台机器上实测过的

按错误码查。每条写清：错误码、症状、原因、怎么绕过去。

## 零、顺序：先 preflight，再单点验证

出问题先按这个顺序走，别一上来就重建或改工具：

1. **先 `workspace action="preflight"` 一次**：拿设计状态、实例状态、缺什么、当前版本。
   不要例行轮询 `workspace_ops` 的 `status`/`instances`；只有 preflight 明确报缺实例、
   缺文档绑定或环境故障时，才针对那一个对象去查。
2. **单点验证**：一次只验一个对象/一个动作。先读回（`inspect action="model"` /
   `"bodies"` / `"faces"` / `"measure"`），再决定改不改；不要在一个回包里同时怀疑三件事。
3. **再改模型**：只改被证实错的那一处；改完重新 `qa action="verify"`（先
   `catalog action="activate" capability="qa"`）。
4. **最后才考虑重建**：重建是有损的，只在方向/关系整体错了时做。

**铁律：工具链不是你的模型（改它 = 把机器弄坏）。** 四个真实会话里对机器伤害最大的
一步，不是建模错，而是模型去改工具自己的源码：

- 一个会话把 `server\broker\brokerd.mjs` 的 `BROKER_SOURCE_HASH` 改掉并备份成 `.bak-versionfix`，
  再 `Stop-Process` 杀掉 brokerd；
- 另一个会话做了一模一样的事；
- 结果：之后两个会话里 broker 连接彻底死掉，用户机器上的工具安装被污染，而那两个会话
  的建模任务本身并不需要这个动作。

所以：**绝不修改** `sw-mcp` 目录下的任何文件（含 `server\`、`bridge\`、`brokerd.mjs`、`.bak`）；
**绝不** `Stop-Process` / `taskkill` 杀 brokerd、node.exe、SOLIDWORKS 或桥接进程。

## 一、错误码索引

| 错误码 | 先看哪节 |
|---|---|
| `SOURCE_HASH_MISMATCH` / `BROKER_REQUIRED` / `BRIDGE_EXITED` | 环境与 broker |
| `GATE_UNREACHABLE` | 环境与 broker（门禁不可达） |
| `SW_NOT_RUNNING` / `blocked-by-dialog` | 启动 SOLIDWORKS / 模态框 |
| `DIMENSION_NOT_DRIVING` / `EDIT_NOT_BOUND` | 尺寸没绑到原生尺寸（参考尺寸 / 无绑定） |
| `SELECTION_EMPTY` | 选了 0 个对象 |
| `DOC_NOT_OPEN` / `DESIGN_ID_REQUIRED` | target 解析错文档 |
| `UNKNOWN_MEMBER` | 成员/接口名不对 |
| `UNKNOWN_PARAM` / `BAD_ARGUMENT` | 参数名或路径放错层 |
| `EDIT_NOT_APPLIED` / `EQUATION_MANAGER_REJECTED` / `EDIT_ROLLED_BACK` | 改参数没落地 |
| `RELATIONS_INCOMPLETE` / `RELATIONS_REQUIRED` | 关系审计没过 |
| `BUILD_IN_PROGRESS` / `CAD_DRIFT` | 并发或外部改动 |
| `EMPTY_MODEL` / `EXPORT_DEGENERATE`（导出） | 空件/空图纸 |
| `DATUM_EXISTS` / `DATUM_NOT_FOUND` / `DATUM_CREATE_FAILED` | 命名基准 |
| `COMPONENT_NOT_FOUND` / `COMPONENT_NOT_ON_DISK` | 装配组件 |
| `READ_ONLY_TOOLSET` / `NOT_ACTIVE` | 工具/文档状态 |

## 二、环境与 broker

- broker 报 `SOURCE_HASH_MISMATCH`（远/本哈希不一致）、握手失败、连不上：
  最多 `workspace_ops action="reload"` **一次**；仍失败 → 停止建模动作，直接汇报
  「环境故障：broker 版本不一致（把远近两个哈希原文贴出来）」，并把
  `workspace_ops action="logs"` 的最后几条一起贴上。
- 报错里出现 `GATE_UNREACHABLE`：那是门禁自己不可达，不归你修。按提示换策略，
  或 `force:"manual"` 交付一次并写明原因 —— **不要**去改门禁/桥接源码。
- `BRIDGE_EXITED` / `BRIDGE_WRITE_FAILED`：桥接进程没了或管道断了。先 preflight 一次，
  仍不可用就按环境故障汇报，不自己拉进程。

## 三、启动 SOLIDWORKS：只在它没开的时候，而且交给用户

- **已经开着时**，再执行 `cmd /c start "" "...lnk"` 会**多起一个无窗口的 SLDWORKS.exe**；
  这个孤儿进程不响应任何东西，只能清掉。
- **没开着时**，同一个快捷方式能正常启动。

所以：preflight 报 `SW_NOT_RUNNING` 时，正确做法是**请用户自己打开 SOLIDWORKS**，然后重试。
服务不启动、不关闭 SOLIDWORKS —— 它的生命周期归用户，而且新进程里没有用户正在编辑的文档。

## 四、弹出「SOLIDWORKS Design 意外关闭」的错误报告

现象：用户截图里是 `SOLIDWORKS Design 错误报告`，按钮有「运行 SOLIDWORKS Rx」
「重新启动 SOLIDWORKS Design」「完成」。

**关键事实：这时 COM 还是通的。** 能连上不等于能干活：preflight/status 会带 `windows` 字段，
`blocking: true` + `reason = "blocked-by-dialog"` 就说明有模态框挡着。

处理顺序：

1. 先把用户正在编辑、尚未保存的文档保住 —— 错误报告里的「重新启动」会丢掉它们。
2. 让用户点掉对话框。我们不去点按钮：那等于替用户做「是否发送诊断日志」这类决定。
3. 对话框关上后重新 preflight；仍是 `blocked-by-dialog` 就再看 `windows.dialogs`。
4. 杀掉进程只会让恢复文件更难找。真要重开，用桌面快捷方式。

崩溃本身**不影响已经存盘的文件**。

## 五、建出来了，但体积一丝不变

**最危险的一类。** 调用返回了非 null 的特征对象，模型树里也有，但几何没动。

- **面支承拉伸的方向**：两个方向都试，比较拉伸前后的体积，只有体积变了才算成功 —— 返回非 NULL 不算数。
- **方程式驱动的尺寸**：直接在原生尺寸上写值无效，必须改写全局变量再 `EvaluateAll` + 重建。
- **保存后方程式引用失效**：`SaveAs` 改名后方程式里仍是旧文档名；原生 `build`/`edit` 会修
  （返回 `repairedEquations`）。

## 六、`DIMENSION_NOT_DRIVING` / `EDIT_NOT_BOUND` —— 尺寸没绑到原生尺寸

### `DIMENSION_NOT_DRIVING`

**症状**：`constraints action="dimensions"` 的写动作回成功，`dimensions[]` 里每行
`reference: true` / `driving: false`。在 SOLIDWORKS 里双击改这个值，**模型不动**。

**原因**：草图不在编辑态时，`AddDimension2` 不报错，产出的是一张**参考尺寸**。
真机会话为此调了几十次 dimensions，每次都看到 `reference:true`，还以为成功了。

**现在**：桥接器写尺寸前会自己 `EditSketch`；写进去仍是参考尺寸就以
`DIMENSION_NOT_DRIVING` 拒，回包顶层给 `driving` / `reference` 计数 —— 别把它当参数化落地。

**动作**：先查草图关系与编辑态（`constraints action="relations" relationAction="list"`、
`inspect action="sketch"`），确认这条尺寸该由哪个草图、哪条关系驱动；结论写进缺口报告。

**不要做**：不要 `dimensions.remove` 后重加，不要改 `expect` 期望值去迁就它。

### `EDIT_NOT_BOUND`

**触发**：`model action="edit"` 接受了参数（回 `status=ok`），但没有原生尺寸绑定：
`mode="rebuild"`、`driven[].dimensions=[]`、`driven[].bound=false`。

**动作**：读回包 `changes.dimensionBindings` 与 `driven`，确认这个参数在模型里没有原生尺寸；
build 后 `constraints action="dimensions" dimensionAction="list"` 0 条 = build 没落地尺寸。
按缺口报告，改设计定义（补参数对应的草图尺寸/绑定）后重建一次，回 `mode="dimension"`、
`bound=true` 才算参数化落地。

**不要做**：不要连续 `edit` 同一个参数（第二次还是 rebuild），不要整件重建当修好；
不要把这次编辑写进「参数化通过」。

## 七、一套定位尺寸读回同一个数（先怀疑对象）

**这个信号本身在喊「你量错对象了」。** 实测：整套孔位标注全部读回同一个数，
那正是**中心线长度**，不是孔心。接下来的几轮「删掉重来 → 删不掉 → 全量重建」
都是从这个误判里长出来的。

**判据**：一个尺寸如果整齐地等于某个**其他已知长度**，先怀疑拾取的对象，别先怀疑尺寸 API。
换 `Select4`（而不是 `SelectByID2`）把选集拿对，再量一次。

## 八、`SELECTION_EMPTY` —— `SelectByID2` 返回 true，但一个都没选中

**「调用返回了」不等于「选中了」**。SOLIDWORKS 的 `SelectByID2` / `SelectByRay` 在什么都没选到时
**照样返回 true**。实测撞过三种：

- 坐标按毫米给了，API 要米 → 把毫米值除以 1000 再传，或传 `units:"mm"` 让服务换算；
- `name` 与特征树里的不一致（图纸叫「前视基准面」，树里是别的写法）→ 先
  `inspect action="model" format="tree"` 看真名；
- 面/边已被重建换掉，旧名字选不中 → 用持久引用 id（`inspect action="faces"` → `select mode="byId"`）。

现在这两条路径都不再放过 0 个：`select` 工具报 `SELECTION_EMPTY`，`advanced_api` 里调选择类成员
也报 `SELECTION_EMPTY`。**看见这个码就是没选中**，别接着建特征 —— 特征会建在空选集上，
报错指向完全无关的地方。

例外：`action="clear"` 之后本来就是 0 个，那不算失败。

## 九、`DOC_NOT_OPEN` / `DESIGN_ID_REQUIRED` —— `target:"doc"` 到底动的是哪份文档

`advanced_api` 的 `target:"doc"` **由 designId 决定**：给了 designId 就按它解析，
解析不到直接 `DOC_NOT_OPEN`，**不会**退回 SOLIDWORKS 前台那份。
要操作前台当前文档必须显式写 `target:"activeDoc"`，回包会带 `document.activeDocument/activeDocument:true`。

历史坑：旧实现无条件取 `IActiveDoc2`，于是带着 designId 的调用命中了历史遗留的未保存旧文档
（统计里 `restoredActiveDocument` 反复出现），尺寸全部降级成参考尺寸。看到 `documentFallback`
或 `activeDocument=true` 就说明这次没按设计走，先停下来确认再继续。

## 十、`UNKNOWN_MEMBER` —— 成员名/接口名不对

错误里带三样东西：`candidates`（签名，按参数个数最接近的排前面）、`supplied`
（你实际传了几个参数）、`tryTarget`（这个成员其实挂在哪个 target 上）。典型错位：
`SelectByID2` 在 `extension`（不是 `selectionManager`）、`FeatureExtrusion3` 在 `doc`
（不是 `featureManager`）。先看 `candidates` 再重试，不要换着参数个数试。

不确定某个 target 上有什么成员：`catalog` 的 `detail`/`kinds` 成员清单，每个成员带
`where`（声明它的接口）、`signature`、`paramCount`。调用之前先看一眼，比撞
`UNKNOWN_MEMBER` 再猜快得多。接口名写错是 `UNKNOWN_TYPE`，不是空列表。

## 十一、`BAD_ARGUMENT` / `UNKNOWN_PARAM` —— 参数放错层

`inspect action="figure"` 报 `BAD_ARGUMENT`：路径要放在 `figure.source` 里
（同层还认 `figure.path`、`figure.image`、`figure.file`）；顶层 `source`、`path`、`op`
一概不收，写了就是 `UNKNOWN_PARAM`。错误里会带一段可以直接照抄的调用示例。

## 十二、`EDIT_NOT_APPLIED` / `EQUATION_MANAGER_REJECTED` —— model action=edit 说改好了但体积不变

先看错误码：

- `UNKNOWN_PARAM` —— 参数名不在这个设计定义里（打错字了）。用 `workspace action="project"` 看 `params`。
- `EDIT_NOT_APPLIED` —— 名字对，但一条方程式都没写进去；多半是实例进入坏状态，让 SOLIDWORKS
  退出重开再重建。
- `EQUATION_MANAGER_REJECTED` —— 建的时候就已经写不进去，件从出生就是静态的。
- `EDIT_ROLLED_BACK` / `CAD_DRIFT` —— 外部改过 CAD 文件或回滚了；确认要覆盖时用
  `recompile:true`，否则按项目记录重建。

都不是的话，才怀疑参数没被任何尺寸引用（设计定义里写了但没绑到特征上）。

## 十三、`RELATIONS_INCOMPLETE` —— 尺寸加上了，但草图还是欠约束

`GetConstrainedStatus()` 返回 3 才是完全约束。常见原因：

- `AddToDB=true` 建的轮廓**没有尺寸**，`feature.Parameter("D1")` 返回 null。
  必须显式 `AddDimension2` / `AddDiameterDimension2` 创建。
- `FullyDefineSketch` 对欠约束矩形返回 0 但状态仍是 2 —— **不可靠**，别指望它。
  同轴/对称/距边这些关系要自己建，剩下的再用它补。

`RELATIONS_REQUIRED` 是 `precision="relations"` 下的硬门槛：关系没落全就不许交付；
`incomplete` / `not-run` 都不等于通过。

## 十四、`BUILD_IN_PROGRESS` / 并发

同一 `designId` 同时有两个写操作时返回 `BUILD_IN_PROGRESS`。等前一个动作结束（或用
`job` 托管长作业），不要换一个 id 绕开 —— 那样会写出两份互相覆盖的设计记录。

## 十五、撤销（undo）是特征级的破坏性操作

`model action="undo"` **按特征步进，不是事务回滚**：撤 2 步会把中途加进来的孔、
切除一起撤掉（实测体积直接退回实心板），redo 救不回来。

**纪律**：改几何前先记基线（`inspect action="model"` 的体积/包围盒/实体数）。
撤错了**不要继续 undo**，按基线 `model action="build"` 重建。
回包里会带 `volumeBefore/volumeAfter/volumeDelta/boundingBoxChanged` 与 `baseline`，看数再决定。

## 十六、重建（rebuild）是有损的，交完再查一遍清单

一次全量 rebuild 里，**材料牌号/密度属性可能被悄悄丢掉**（材质变了但几何还像对的），直到很后面的步骤
才发现。

**重建后必查**：体积 / 包围盒 / 单实体 / **材料密度** / 孔数轴线。材料这一项没人提醒，
但它是「重建完看着没问题、交付后用户发现材质没了」的唯一防线。

## 十七、`EMPTY_MODEL` / 空件

`inspect action="faces"` 数一下面数：0 面就是文件本身没用（例如建错了但存下来了）。
空件会让视图调色板返回空、导出得到空文件。先修模型，不要对空件做验收或交付。

## 十八、导出返回成功，文件却是坏的

`SaveAs3`（STEP 导出）**不校验几何**：文档里有面被选中时，它照样返回 `true`，写出来的文件
却可能只有正常件的十分之一，`analysis` 读回来是 0 mm³ / 1 面 8 边；同一文档清空选择后再导出
是正常大小。

- **导出前一律先清空选择**（`select clear`），再 `deliver` / 导出。这一步不是装饰。
- 判据只看**落盘文件大小**：和上一次成功件比，掉一个数量级就是坏文件，返回码不算证据。
- 代码依据：`bridge/src/Operations.cs` 里导出前清选择的实测注释与自检逻辑。

## 十九、`COMPONENT_NOT_FOUND` / `COMPONENT_NOT_ON_DISK` —— 装配与出图

- **组件没进去/返回 2**：`InsertImportedComponent` 在本机不稳定，重复调用会把 SOLIDWORKS
  带崩（`0x800706BE`）。改用原生 `assembly action="assemble"`；路径必须是绝对路径。
- **`AddComponent5` 返回 NULL**：那是旧 API 入口，本机只作兜底。零件文档要先打开。
- **工程图视图调色板是空的**：模型文件有问题（例如 0 面的空零件），或者传了相对路径。
  先 `inspect action="faces"` 数一下模型有多少张面；0 面就是文件本身没用。
- **PDF 导出来了但明显偏小**：那是空白图纸。判据是图纸文件（.SLDDRW）大小与上一次成功件比。
- **SOLIDWORKS 开着一堆文档窗口**：每次建模都会留一个文档。收尾用
  `workspace_ops action="cleanup"`（关本服务建的未保存文档）或 `action="quit"`（关掉全部文档并退出）。

## 二十、截图上的标记和面错位

不要按投影结果自己在 BMP 上画标记：SaveBMP 的取景与投影空间不是同一个坐标系，
标出来的位置必然系统偏移。正确做法是让 SOLIDWORKS 自己画：先用持久引用把对象选中，再 SaveBMP。
工具里就是 `capture { highlight: [id] }`。

## 二十一、加特征时多出一堆空文档

每次建都 `NewDocument` 不关，累积多了 SW 会 GDI 泄漏然后进程直接消失
（事件日志里是 `SLDWORKS.exe GDIObjectLeak`，之后所有 COM 调用返回 `MK_E_UNAVAILABLE`）。
收尾用 `workspace_ops action="cleanup"` 关掉本服务建的、从未保存的文档 —— **只关自己记录的，不碰用户打开的**。

## 二十二、保存返回 `errors: 1` 但模型是好的

多半是**另一个文档占着同一个路径**。先关掉占路径的文档再存；关不掉时用
`workspace_ops(action="close", title=…)` 手动关。

## 二十三、`DATUM_EXISTS` / `DATUM_NOT_FOUND` / `DATUM_CREATE_FAILED` —— 命名基准

- 重名先 `datum action="delete"` 释放名字，或换名；基准名是稳定引用，两个同名等于没有名字。
- `DATUM_NOT_FOUND`：先 `datum action="list"`（含 stale 标记）；stale 的用 `rebuild` 或删除重来。
- `create` 失败先看来源参数：`coords` 要 x/y/z；`faceEdge`/`circleCenter`/`cylinderAxis`
  要面/边 id（`inspect action="faces"` 取）；`twoPlanes` 给两张平面。不要反复用同一个坏 id 试。

## 二十四、找不到基准面

基准面按 `GetTypeName2()=="RefPlane"` 的序号取（0 前视 / 1 上视 / 2 右视），
**名字是中文**。别按英文名 `Front Plane` 去找。命名基准走 `datum`，不要再手写特征树名字。

## 二十五、回包怎么读：`changes` 永远在，`measurements` 两处都能读

以前失败回包**没有 `changes` 这个键**，而调用方普遍写成 `j.changes.applied`、
`j.changes.result`、`j.changes.document` —— 于是拿到的是一条
`Cannot read properties of undefined (reading 'applied')`，**真正的错误码被这条 TypeError 盖住**。
某次会话的 23 次工具失败里有 11 次是这个形状，另外 9 次是去读
`j.changes.measurements.totalVolumeMm3`（那个数当时只在顶层）。

现在两条都稳了：

- 失败回包也有 `changes`（至少 `{}`）；`j.changes.applied` 之类读得到 `undefined`/`[]`，不再抛异常。
- `measurements` 在**顶层和 `changes.measurements` 两处都有**，同一个数。

所以读回包时先看 `status` 与 `extra.error.code`，再看数据；不要用「解构深了会抛错」的方式去猜结构。
仍然要按动作读对应位置：`bodies` 的体积在 `measurements`，面在 `changes.bodies[].faces`。

## 二十六、核对说「尺寸不对」，但那个尺寸明明在图上

先看它是不是**凸台/圆角柱面**：`measure kind="axis"` 默认孔和凸台都量；显式写了 `hole: true`
会把凸的过滤掉。空结果里的 `available.{diameters,holes,bosses}` 直接告诉你这个零件上到底有哪些圆柱面。
报告里 `没量成` 的那几条**不是**尺寸错，别去改模型，先改查询。
