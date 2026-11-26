/**
 * 工具面分层：核心常驻 + 领域按需。
 *
 * 背景（实测数据）：DSH 把作用域里**所有**工具渲染成 `tools:sdk` 提示段，只要
 * 工具注册着就付这份上下文成本，模型用不用都一样。11 个工具 → 33.8k 字符 SDK，
 * 其中 inspect 一个占 17.5k（description 1.6k + inputSchema 15.8k）。
 *
 * 拆分原则：**同一个 handler，换注册名**。action 名、参数、错误码、安全门禁一律
 * 保留，不复制实现：每个原工具的 handler 只写一份，按上面的分组表登记成多个工具，
 * 每个工具只带自己那组的参数（PARAM_OWNERS 决定谁带谁），action 枚举只留本组，
 * 跨组调用由 schema 校验拦下；按需组名见 catalog 的 capability 列表。
 *
 * 本文件只放纯数据 + 纯函数，不 import 任何运行时（避免与 server.mjs 循环依赖）。
 */

/** 工具 description（逐字，与重构方案一致）。整工具和分组工具共用这一处。
 *
 *  每条按同一个骨架写，模型不用猜：何时用｜前置｜参数与坐标｜返回什么｜下一步｜坑。
 *  只写与工具行为有关的事实，不写项目专用尺寸或偏好；场景配方在 skills 里。 */
export const DESCRIPTIONS = {
  catalog: '能力目录与任务模式。何时用：不知道某个能力/签名、或要按任务一次配好工具面时。'
    + 'focus 按 part|modify|assembly|motion 配工具+技能+规则；activate 单独打开按需组（assembly / assembly_inspect / qa / workspace_ops / advanced_api / analysis / calculate / select / job / task / datum）；'
    + 'search/detail 查能力与参数；sources/probe 看桥接器版本与分派。前置：无。'
    + '返回：命中的能力/工具名、激活结果、已激活清单、activate 回包里的 unlocks/firstStep/pitfalls/budget。'
    + '下一步：用 activate 打开的那组工具。'
    + '坑：没 activate 就调按需工具 = MCP 未知工具；跨组 action 会被 schema 直接拒绝（不会自动转过去），别换着工具名猜。',
  model: '按 designId 规划、创建、构建、编辑或管理 SW 零件（装配/底层 API 属按需组，先 catalog action="activate"）。'
    + '何时用：新建/改尺寸/重建。前置：plan 通过（blockers 为空、assumptions 已确认）才 build。'
    + '参数：definition 是唯一真源；坐标系为零件坐标，长度 mm。'
    + '返回：build 回 volume/boundingBox/bodies/holes/features/bindings，plan 回 blockers/assumptions/dimensions。'
    + '下一步：build 之后回读 inspect model，再 verify，最后 deliver。'
    + '坑：build 一次声明完整几何/尺寸/约束/语义参数；build 后 constraints dimensions 为 0 条 = 定义漏了尺寸，'
    + '先报缺口，不要用 dimensions.add 补；改参数只用 model action="edit"（不整件重建）；'
    + 'build 会新开文档并清掉本 id 的旧中间文档；不传 designId 的操作会因 DESIGN_ID_REQUIRED 失败。',
  inspect: '按 designId 读取 SW 模型、草图、工程图、几何、约束和验收证据。'
    + '何时用：build/edit 之后回读；交付前验收。前置：文档必须与 designId 绑定（否则 WRONG_DOCUMENT/DOC_NOT_OPEN）。'
    + '返回：model=document/featureTree/尺寸；faces=每张面的 persistentId 与法向；bodies=体积/包围盒；verify=逐条 expected/actual。'
    + '尺寸与会话级约束在 constraints 工具（action="relations"|"dimensions"）；inspect 只读几何与文档。'
    + '语义测量用 action="measure"（孔径/孔心高/槽圆心距/筋厚，验收数字的来源）；读草图用 action="sketch"。'
    + '改过几何或尺寸之后必须重跑一次，旧读数不能当这一版的证据。'
    + '下一步：verify 不通过先改设计再重跑，不要靠重跑换运气。'
    + '坑：verify 的档位验收没记录的项记 unmeasured（不算通过）；装配档含组件数与干涉，零件会标 skipped。'
    + '干涉读数依赖桥接器回 interference；当前桥接器没有实现它，这一行会记 unmeasured，不等于 0 干涉。',
  constraints: '读取草图几何关系与尺寸约束；只做回读与补缺，不是改参数的入口。'
    + '何时用：回读草图关系与尺寸，或补图纸标注缺失的尺寸；改已有尺寸一律走 model action="edit"；'
    + 'build 后 dimensions 为 0 条先报缺口，不要用 add 反复补。'
    + '前置：目标草图存在且可编辑（否则 SKETCH_NOT_EDITABLE）；只读实例只放行 list/infer。'
    + '返回：relations/dimensions 清单与改动结果。下一步：build 或 verify 复核。'
    + '坑：参考尺寸读得出来、改不动；出现 reference=true 时报告 DIMENSION_NOT_DRIVING，不要继续 add/remove；'
    + '写动作失败会回滚（atomic 默认 true）。',
  qa: '验收与证据：verify / evidence / review / snapshot / compare。何时用：要判定「按图纸建对了没有」而不只是「体积像不像」。'
    + '前置：designId 已绑定文档；档位验收需要先 deliver 过一次（design.json 里才有期望值）。'
    + '返回：verify 六档 file/geometry/dimensions/positions/topology/assembly 的 expected/actual/status；evidence=图纸证据校验；'
    + 'snapshot=带指纹的版本快照。下一步：有 failed 项先改设计；全 ok 再 deliver。'
    + '坑：截图不是读数；unmeasured ≠ 通过；assembly 档含干涉，零件记 skipped；桥接器未回 interference 时那行是 unmeasured。',
  assembly: '装配体操作：插入组件、配合（含齿轮 gear）、锁定、组件旋转/平移、驱动。前置：装配文档已建（assemble 或 workspace open），'
    + '零件已存盘（build 只在内存里）。参数：长度 mm；componentRotate 的 frame="global"（默认，装配坐标轴）或 "local"（零件自身坐标轴），'
    + 'x/y/z 是装配坐标旋转点（不传则绕组件包围盒中心；当前桥接器只在显式传 x/y/z 时才按显式点转）；componentTranslate 的 dx/dy/dz 恒为装配坐标。'
    + '返回：componentRotate 回 rotation(3×3 行主序)/pose{origin(mm),axes}/pivot/centerDriftMm/method；assemble 回 inserted/saved/placementWarnings/placementNotes。'
    + '下一步：mate → inspect mates → drive/verify。坑：mate 两端目前只接受面 id；固定件挪不动（先 unfix）；'
    + 'placement:"datum:<name>" 只对齐基准原点，朝向要再 componentRotate frame="local"；'
    + '但当前桥接器尚未实现 frame="local"（回包 frameUnsupported:true、status:"incomplete"，实际按装配坐标转），别把那一转当零件坐标系的朝向校正。',
  assembly_inspect: '读取装配体组件、包围盒与配合清单。何时用：装配排错、核对位姿。前置：设计已登记为装配体。'
    + '返回：components（名/origin/box/transform）、mates（名/类型/两端/自由度线索）、assemblyFaces。下一步：删重复配合或补约束后重测。'
    + '坑：组件名带 -1 后缀；面 id 只在当前文档/版本内有效。',
  drawing: '由模型生成工程图（视图，不是剖视）。何时用：要二维视图/出图。前置：model 指向磁盘上的 SLDPRT/SLDASM。'
    + '返回：落下的视图名与投影法（first/third）。下一步：需要剖视走 analysis action="section" 或手工剖视图。'
    + '坑：没有视图 = 空白页；section 不是真剖视。',
  advanced_api: '底层 API 出口：invoke / object / kinds / batch；仅在封装动作不足时使用。前置：知道接口名与成员名（kinds 查）。'
    + '返回：调用结果或句柄。下一步：object 用句柄继续读。坑：签名靠猜会失败；长度单位默认 m（传 units:"mm" 才换算）；'
    + 'target 写错对象类型时回包会给 tryTarget 指路（列出该对象上真实可用的目标名），照它改，别换着 target 猜。',
  workspace: '项目、环境与开工体检：preflight 一次拿全（活动文档/绑定/实例/能力/上次验证与交付）+ nextActions；'
    + 'brief 看目录/最近设计；projects/project/history/resume 续接；read/open/search 读文件与开文档；lesson 记经验。'
    + '前置：无（preflight 只读）。返回：结构化事实 + nextActions。下一步：按 nextActions 走，不要例行 status/instances。'
    + '坑：preflight 不启动 SOLIDWORKS；实例运维在 workspace_ops（按需）。',
  workspace_ops: '实例与文档运维：status / instances / reap / ui / reload / cleanup / reclaim / closePath / close / quit / logs。'
    + '何时用：只在确实要收实例/关文档/查日志时。返回：实例清单、回收结果、日志。下一步：回到 preflight 看状态。'
    + '坑：quit/reap 可能关文档甚至退实例；默认只动本服务启动的实例（force 才动用户的）。',
  capture: '把指定 designId 的 SW 视图渲染成 PNG。何时用：交付证据与对照。前置：文档与 designId 绑定；默认只出图、不改视图（mutateView:true 才改）。'
    + '返回：png 路径、视图、像素尺寸、bytes、document（拍的是哪份）。下一步：deliver 前把 iso/front/top 三张都取到。'
    + '坑：截图不是读数；bytes>0 只证明写了文件，**没有空白图检测**；views 里写 section/剖视会回 SECTION_UNSUPPORTED，'
    + '要剖切用 analysis action="section"（对导出 STEP 做几何剖切）。',
  deliver: '交付门禁：保存或导出指定 designId 的文件，并回读实际落盘结果。何时用：验证通过之后。'
    + '前置：inspect action="verify" 通过（门禁会拦）；文档按 designId 绑定（deliver 自己定位，不依赖当前活动文档）。'
    + '返回：delivery{saved/verified/bytes/designId/source(active|reopened|rebuilt)/elapsedMs}、path/mtime/volume/bodies 与自检结果；'
    + 'sldprt 还会落 design.json+manifest.json，并在保存后关掉重开读实体数。'
    + '下一步：verify tiers 复测一次。坑：saved=true 但 verified=false 说明文件写了而重开回读没过，不算交付；'
    + '导出 step/pdf 不改变文档存盘状态；bytes=0 或自检失败 = 没交付。',
  job: '提交并管理异步 SW bridge 作业：状态、结果、取消、回收、实例/文档生命周期。何时用：长任务或要 ensure 实例。'
    + '返回：job id 与阶段结果。下一步：job status/result。坑：作业有自己的实例绑定，别混设计。',
  task: '按依赖 DAG 执行一组 bridge 操作；validate 只检查依赖，run 才执行。何时用：多步必须同文档同顺序。'
    + '返回：每步结果。坑：某步失败后续步骤的依赖会缺；不是事务回滚。',
  select: '按持久引用、名称或屏幕射线选择 SW 对象，并回读实际选择结果。前置：对象在当前文档里（persistentId 由 inspect faces/edges 取得）。'
    + '返回：selection.count 与逐项命中；byId/byRay/byName 三种入口。'
    + '坑：返回 true 不等于选中 —— 必须读 selection.count，count=0 就是没选中。',
  analysis: '离线分析 STEP 与图像：几何、网格、消隐投影、剖切、差异。何时用：不碰 SW 的几何核对、真剖视、图上量尺寸。'
    + '返回：几何读数（体积/面积/包围盒）、section 轮廓、hlr 线框、diff 差异。下一步：把读数写进验收。'
    + '坑：只吃磁盘文件；section 的剖面是 STEP 几何剖切，不是 SW 工程图剖视图。',
  calculate: '运行机械设计计算器，返回公式、代入过程、约束检查与适用假设。何时用：齿轮/轴/轴承等选型核算。'
    + '前置：calculate 是按需组，先 catalog action="activate" capability="calculate"（或 catalog action="focus"）再调。'
    + '返回：结果 + 中间量与假设；checks 有未通过项时 status="failed"。'
    + '坑：假设不满足时结果是参考值，不是合格判据；不激活就调 = MCP 未知工具。',
  datum: '命名基准几何：创建/读取/删除基准点、基准轴、基准面、坐标系，名字与全局位姿写进 design.json；'
    + '装配用 placement:"datum:<name>" 引用它，不依赖容易变的拓扑面。前置：designId 已有项目记录（build 或 deliver 过一次）；'
    + '名字 1–64 字符、不含空格/冒号。返回：persistentId + frame{origin(mm),axes(3×3)}。下一步：assemble 用 datum 定位。'
    + '坑：重名一律 DATUM_EXISTS；delete 之后再 create 同一名字是允许的；文件里有、模型里没有的记 stale（rebuild 按来源重建）。'
    + '**当前桥接器还没有 datumCreate/datumList/datumDelete**：attach:true（默认）会失败，'
    + 'attach:false 只写 design.json、没有 frame.origin，装配引用它必报 DATUM_NOT_FOUND；要真几何先补桥接器。',
}


/**
 * 按需组激活时一起给出的「场景链」：解锁什么、第一步、前置、坑、预算、退出。
 * 这不是新工具，也不进 tools/list 的 schema；只挂在 catalog.activate 的回包里，
 * 让模型在激活前就能判断「这一组值不值得开、开了之后怎么走」。
 */
export const CAPABILITY_BRIEFS = {
  assembly: {
    unlocks: ['assembly'],
    requires: ['零件已 deliver 成 SLDPRT（build 只在内存）', '装配 designId 已定', '需要基准时先激活 datum（但当前桥接器未实现真基准）'],
    firstStep: 'assembly action="assemble" components=[{path,x,y,z,placement:"origin"|"bbox-center"|"datum:<name>"}]',
    next: ['assembly_inspect action="assembly" 回读组件', 'inspect action="faces" 取面 id', 'assembly action="mate"（两端只接受面 id）'],
    pitfalls: ['mate 两端只接受面 id，顶点/边/轴会 MATE_UNSUPPORTED', 'placement:"datum:<name>" 只对齐原点，朝向要另校；frame="local" 当前未实现', '固定件挪不动，先 unfix'],
    budget: 'assemble 1–2 次；mate ≤5 条；drive ≤2 轮',
    exit: '组件数/位姿与设计一致，配合清单无过定义，重开后位姿可复现',
  },
  assembly_inspect: {
    unlocks: ['assembly_inspect'],
    requires: ['设计已登记为装配体，且有打开/存盘的 SLDASM'],
    firstStep: 'assembly_inspect action="assembly" designId="<id>"',
    next: ['assembly_inspect action="mates" 看配合与自由度线索', 'assembly_inspect action="assemblyFaces" 查面是否失效'],
    pitfalls: ['组件名带 -1 后缀', '面 id 只在当前文档/版本内有效'],
    budget: '读 ≤4 次；排错时每改一条配合重读一次',
    exit: '组件、配合、自由度都能对上，且与重开后的读数一致',
  },
  qa: {
    unlocks: ['qa'],
    requires: ['designId 已绑定文档', '档位验收要先 deliver 过一次（design.json 里才有期望值）'],
    firstStep: 'qa action="verify" tiers=["file","geometry","dimensions","positions","topology"]（装配再加 "assembly"）',
    next: ['有 failed 先改设计再重跑', '全 ok 再 deliver', '需要证据/快照时 evidence/snapshot'],
    pitfalls: ['截图不是读数', 'unmeasured ≠ 通过', '装配档的干涉依赖桥接器 interference；未实现时记 unmeasured',
      'build 后 constraints dimensionAction="list" 为 0 条 = 定义漏了尺寸，先报缺口；改参数只用 model action="edit"'],
    budget: 'verify 1–2 轮；抽查 ≤3 条；截图 ≤4 张',
    exit: '六档没有 fail；unmeasured 有解释；证据路径真实存在',
  },
  datum: {
    unlocks: ['datum'],
    requires: ['designId 已有项目记录（build 或 deliver 过一次）'],
    firstStep: 'datum action="create" designId="<id>" name="<name>" kind="point|axis|plane|coordSys"（先想好稳定名字）',
    next: ['datum action="list" 确认 live/stale', 'assemble 用 placement:"datum:<name>"'],
    pitfalls: ['重名 DATUM_EXISTS', '当前桥接器无 datumCreate/List/Delete：attach:true 会失败；attach:false 只登记、不能定位'],
    budget: 'create ≤3 个；list 1 次；装配前确认 live=true',
    exit: '名字、frame.origin 与模型回读一致；重开后仍 live',
  },
  workspace_ops: {
    unlocks: ['workspace_ops'],
    requires: ['无；但 quit/reap/close 会影响实例与文档'],
    firstStep: 'workspace_ops action="status"（只在确实要运维时；例行开工用 workspace preflight）',
    next: ['instances 看清单', 'reap/cleanup 收本服务实例', 'logs 查故障'],
    pitfalls: ['quit/reap 可能关文档甚至退实例', '默认只动本服务启动的实例（force 才动用户的）'],
    budget: '运维动作 ≤2 次；不要用轮询 status 代替 preflight',
    exit: '实例/文档状态与 preflight 一致',
  },
  advanced_api: {
    unlocks: ['advanced_api'],
    requires: ['知道接口名与成员名（先 kinds 查）', '确认封装动作真的不够用'],
    firstStep: 'advanced_api action="kinds" target="<obj>"（先看真实成员签名）',
    next: ['advanced_api action="invoke" target/iface/member/args', '失败后把缺口记进 lesson，不要连续猜参数'],
    pitfalls: ['签名靠猜会失败', '长度单位默认 m，传 units:"mm" 才换算', 'target 写错时回包给 tryTarget，照它改'],
    budget: 'kinds ≤2 次；invoke 同一成员失败 2 次即停',
    exit: '调用返回可判读结果且体积/几何有变化；否则转配方缺口',
  },
  analysis: {
    unlocks: ['analysis'],
    requires: ['磁盘上的 STEP/图片文件（不碰 SW）'],
    firstStep: 'analysis action="step" path="<abs.step>"',
    next: ['section 取剖面环/面积', 'diff 与基准比', 'image 看暗像素/覆盖率'],
    pitfalls: ['只吃磁盘文件', 'section 是 STEP 几何剖切，不是 SW 工程图剖视图'],
    budget: '同一文件 ≤3 次；剖面 ≤2 个平面',
    exit: '读数进验收表，来源路径可复查',
  },
  calculate: {
    unlocks: ['calculate'],
    requires: ['已知计算器 id 与输入（先 list/formula）'],
    firstStep: 'calculate action="list"',
    next: ['formula 看公式与假设', 'run 看 result 与 checks'],
    pitfalls: ['假设不满足时结果是参考值，不是合格判据', 'checks 有 fail 时 status 应为 failed'],
    budget: '1–2 次；不拿计算结果当几何证据',
    exit: '输入、公式、约束检查都能复算',
  },
  select: {
    unlocks: ['select'],
    requires: ['对象在当前文档里；持久引用 id 由 inspect faces/edges 取得'],
    firstStep: 'select action="select" mode="byId" persistentId="<id>"',
    next: ['读 selection.count', '把 id 传给 capture highlight'],
    pitfalls: ['返回 true 不等于选中，必须读 selection.count', 'count=0 → SELECTION_EMPTY'],
    budget: '≤3 次；每次重读 count',
    exit: 'selection.count 与预期对象数一致',
  },
  job: {
    unlocks: ['job'],
    requires: ['长任务或需要 ensure 实例；普通单步不需要 job'],
    firstStep: 'job action="submit" ...（或 ensure 拉起实例）',
    next: ['job status/result', '失败看 error 与 lastCompletedStep'],
    pitfalls: ['作业有自己的实例绑定，别混设计', '普通单步用 job 只会增加轮询和状态分叉'],
    budget: '单任务 1 个 job；轮询 ≤10 次',
    exit: 'job state 终态且结果可回读',
  },
  task: {
    unlocks: ['task'],
    requires: ['多步必须同文档同顺序；普通单步不需要 task'],
    firstStep: 'task action="validate" 先查依赖',
    next: ['task action="run" 才执行'],
    pitfalls: ['某步失败后续依赖会缺', '不是事务回滚'],
    budget: '一条 DAG 一次 run；失败不整段重放',
    exit: '每步结果与依赖顺序都能对上',
  },
}
/**
 * 原工具 → 新工具分组。
 *
 * - core: true  = 启动即注册（默认工具面）
 * - core: false = catalog.activate 之后才注册
 * - actions     = 这组拥有的 action（名字与参数完全不变）
 * - default     = action 省略时的默认值；**只有默认值仍在组内才保留**，
 *                 默认值迁走了就不设默认，改由 ACTION_REQUIRED 明确拒绝
 *                 （静默换一个动作最坏：调用方以为在做 A，实际做了 B）。
 */
export const TOOL_SPLITS = {
  model: [
    {
      name: 'model',
      core: true,
      title: '操作模型',
      description: DESCRIPTIONS.model,
      actions: ['create', 'build', 'edit', 'plan', 'rebuild', 'undo', 'pattern', 'diff', 'helix', 'sweep', 'loft'],
    },
    {
      name: 'assembly',
      core: false,
      title: '装配体操作',
      description: DESCRIPTIONS.assembly,
      actions: ['assemble', 'mate', 'mateDelete', 'mateLock', 'componentLock', 'componentRotate', 'componentTranslate', 'drive'],
      default: 'assemble',
    },
    {
      name: 'drawing',
      core: true,
      title: '出工程图',
      description: DESCRIPTIONS.drawing,
      actions: ['drawing'],
      default: 'drawing',
    },
    {
      name: 'advanced_api',
      core: false,
      title: '底层 API 出口',
      description: DESCRIPTIONS.advanced_api,
      actions: ['invoke', 'object', 'kinds', 'batch'],
      default: 'invoke',
    },
  ],
  inspect: [
    {
      name: 'inspect',
      core: true,
      title: '看模型',
      description: DESCRIPTIONS.inspect,
      actions: ['model', 'faces', 'bodies', 'sketch', 'figure', 'measure'],
      default: 'model',
    },
    {
      name: 'constraints',
      core: true,
      title: '草图约束',
      description: DESCRIPTIONS.constraints,
      actions: ['relations', 'dimensions'],
      default: 'relations',
    },
    {
      name: 'assembly_inspect',
      core: false,
      title: '看装配体',
      description: DESCRIPTIONS.assembly_inspect,
      actions: ['assembly', 'assemblyFaces', 'mates'],
      default: 'assembly',
    },
    {
      name: 'qa',
      core: false,
      title: '验收与证据',
      description: DESCRIPTIONS.qa,
      actions: ['verify', 'evidence', 'review', 'snapshot', 'compare'],
      default: 'verify',
    },
  ],
  workspace: [
    {
      name: 'workspace',
      core: true,
      title: '环境、能力与项目',
      description: DESCRIPTIONS.workspace,
      actions: ['preflight', 'brief', 'projects', 'project', 'resume', 'history', 'read', 'open', 'search', 'lesson'],
    },
    {
      name: 'workspace_ops',
      core: false,
      title: '实例与文档运维',
      description: DESCRIPTIONS.workspace_ops,
      actions: ['status', 'instances', 'reap', 'ui', 'reload', 'cleanup', 'reclaim', 'closePath', 'close',
        'quit', 'logs'],
      default: 'status',
    },
  ],
}

/** 整工具按需（不做 action 拆分，原样整体搬）。datum 放这里是为了不让默认工具面
 *  多背一份 schema：它只在装配/复核时用，catalog action="activate" capability="datum" 打开。 */
export const ON_DEMAND_WHOLE = ['analysis', 'calculate', 'select', 'job', 'task', 'datum']

/** 参数归属：键 = 参数名，值 = 拥有它的分组名。没列出的参数留在该原工具的**所有**分组里
 * （designId / force / reason / width / height / path / sketch / outputPath / angleDeg 这类
 *  跨组共用或安全门禁要读的参数，宁可多带也不能漏 —— 漏一个就是静默丢参数）。 */
export const PARAM_OWNERS = {
  model: {
    definition: 'model',
    output: 'model',
    precision: 'model',
    assumptions: 'model',
    acceptedAssumptions: 'model',
    dimensions: 'model',
    allowOpen: 'model',
    requireDimensions: 'model',
    parameters: 'model',
    changes: 'model',
    recompile: 'model',
    revert: 'model',
    template: 'model',
    feature: 'model',
    featureIndex: 'model',
    count: 'model',
    axisPlanes: 'model',
    flip: 'model',
    comparePath: 'model',
    volumeToleranceMm3: 'model',
    lengthToleranceMm: 'model',
    steps: 'model',
    target: 'advanced_api',
    iface: 'advanced_api',
    member: 'advanced_api',
    handle: 'advanced_api',
    param: 'advanced_api',
    objectAction: 'advanced_api',
    value: 'advanced_api',
    index: 'advanced_api',
    ops: 'advanced_api',
    stopOnError: 'advanced_api',
    args: 'advanced_api',
    units: 'advanced_api',
    offset: 'advanced_api',
    limit: 'advanced_api',
    mateFirst: 'assembly',
    mateSecond: 'assembly',
    mateKind: 'assembly',
    mateRatio: 'assembly',
    mateReverse: 'assembly',
    solve: 'assembly',
    drivePrimary: 'assembly',
    driveRatios: 'assembly',
    driveAngleDeg: 'assembly',
    mateDistance: 'assembly',
    mateAngleDeg: 'assembly',
    mateLockRotation: 'assembly',
    mateName: 'assembly',
    component: 'assembly',
    dx: 'assembly',
    dy: 'assembly',
    dz: 'assembly',
    unfix: 'assembly',
    refix: 'assembly',
    frame: 'assembly',
    axis: 'assembly',
    x: 'assembly',
    y: 'assembly',
    z: 'assembly',
    components: 'assembly',
    model: 'drawing',
    views: 'drawing',
    projection: 'drawing',
  },
  inspect: {
    format: 'inspect',
    includeImage: 'inspect',
    imagePath: 'inspect',
    limit: 'inspect',
    measure: 'inspect',
    figure: 'inspect',
    compare: 'qa',
    apply: 'constraints',
    tolerance: 'constraints',
    relationAction: 'constraints',
    relations: 'constraints',
    relationIds: 'constraints',
    confirm: 'constraints',
    atomic: 'constraints',
    dimensionAction: 'constraints',
    dimensions: 'constraints',
    drawingPath: 'qa',
    documentPath: 'qa',
    expect: 'qa',
    tiers: 'qa',
    measures: 'qa',
    artifactPath: 'qa',
  },
  workspace: {
    lesson: 'workspace',
    q: 'workspace',
    query: 'workspace',
    log: 'workspace_ops',
    logLimit: 'workspace_ops',
    logOffset: 'workspace_ops',
    pathPrefix: 'workspace_ops',
    untitled: 'workspace_ops',
    title: 'workspace_ops',
    keepMs: 'workspace_ops',
    tag: 'workspace_ops',
    dryRun: 'workspace_ops',
    includeDocs: 'workspace_ops',
    graceMs: 'workspace_ops',
    uiAction: 'workspace_ops',
    offNewsFeeds: 'workspace_ops',
    pid: 'workspace_ops',
    offset: 'workspace',
    limit: 'workspace',
    force: 'workspace_ops',
    reason: 'workspace_ops',
  },
}

/** 原工具的全部 action（分组枚举取这个全集：调到别组的 action 才能回 ACTION_MOVED）。 */
export function sourceActions(sourceName) {
  return (TOOL_SPLITS[sourceName] ?? []).flatMap((group) => group.actions)
}

/** 所有拆分工具的 action 并集（按需工具用它做枚举：调错组也能回一条 ACTION_MOVED）。 */
export const ALL_ACTIONS = [...new Set(Object.keys(TOOL_SPLITS).flatMap((name) => sourceActions(name)))]

/** 某个 action 在拆分后归哪个工具；只在本原工具里找。找不到返回 null。 */
export function actionOwner(sourceName, action) {
  for (const group of TOOL_SPLITS[sourceName] ?? []) {
    if (group.actions.includes(action)) return group.name
  }
  return null
}

/** 跨原工具找 action 的归属（按需工具用）。找不到返回 null。 */
export function actionOwnerAnywhere(action) {
  for (const sourceName of Object.keys(TOOL_SPLITS)) {
    const owner = actionOwner(sourceName, action)
    if (owner !== null) return owner
  }
  return null
}

/** 某个原工具的所有分组名（含核心组）。 */
export function groupNames(sourceName) {
  return (TOOL_SPLITS[sourceName] ?? []).map((group) => group.name)
}

/** 按需工具名（catalog.activate 的 capability）全集。 */
export function onDemandCapabilities() {
  const names = []
  for (const groups of Object.values(TOOL_SPLITS)) {
    for (const group of groups) {
      if (!group.core) names.push(group.name)
    }
  }
  return [...names, ...ON_DEMAND_WHOLE]
}

/** 启动即注册的工具名全集。 */
export function coreToolNames() {
  const names = []
  for (const groups of Object.values(TOOL_SPLITS)) {
    for (const group of groups) {
      if (group.core) names.push(group.name)
    }
  }
  return names
}

/** 一个工具名属于哪个 capability；核心工具返回自身（无需激活）。 */
export function capabilityOf(toolName) {
  for (const groups of Object.values(TOOL_SPLITS)) {
    for (const group of groups) {
      if (group.name === toolName) return group.core ? null : group.name
    }
  }
  if (ON_DEMAND_WHOLE.includes(toolName)) return toolName
  return null
}

/**
 * 按分组裁剪 zod schema。
 *
 * @param z            zod 实例（server.mjs 已引入，避免这里再依赖一份）
 * @param baseSchema   原工具的 z.object({...})
 * @param sourceName   原工具名
 * @param group        TOOL_SPLITS 里的一项
 * @returns 只带本组参数的 z.object
 */
export function buildGroupSchema(z, baseSchema, sourceName, group) {
  const shape = baseSchema?.shape ?? null
  if (shape === null) return baseSchema
  const owners = PARAM_OWNERS[sourceName] ?? {}
  const pruned = {}
  for (const [key, value] of Object.entries(shape)) {
    if (key === 'action') continue
    const owner = owners[key]
    if (owner !== undefined && owner !== group.name) continue
    pruned[key] = value
  }
  // 枚举只列本组 action。曾用全集是为让跨组调用回 ACTION_MOVED，代价是每个工具都在
  // schema 里宣称自己会做别人的事（实测 model 20 / inspect 16 / constraints 16 /
  // workspace 19，共 71 个枚举值），模型于是以为 model 就能 assemble，永不 activate。
  // 跨组的正确反馈是枚举校验失败；有哪些按需组看 catalog 的 capability 列表。
  const all = group.actions
  const actionEnum = z.enum(all.length > 0 ? all : group.actions)
  const action = group.default !== undefined
    ? actionEnum.default(group.default)
    : actionEnum.optional()
  pruned.action = action.describe(`要做什么：${group.actions.join(' / ')}`)
  return z.object(pruned)
}
