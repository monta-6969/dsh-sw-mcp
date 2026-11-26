// The hand-curated half of the catalog: operations this project can actually
// drive today, with the evidence that proved each one.
//
// Everything here was verified against SOLIDWORKS 2026 SP3.2 (revision 34.3.2)
// on this machine. The `evidence` field is not decoration: it is the difference
// between "the help page says this exists" and "we measured the result". Where
// the measurement was a volume, the analytic value is quoted so a later reader
// can re-check the arithmetic instead of trusting the note.
//
// Anything not listed here is still reachable through `model action=invoke`,
// which reflects over the interop assembly; this file is a shortcut, not a gate.

const VERIFIED_AT = '2026-11-04'
const SW = '34.3.2'

const mm = (d) => ({ type: 'number', unit: 'mm', description: d })
const count = (d) => ({ type: 'integer', minimum: 1, description: d })

export const NATIVE_OPS = [
  // ---------------------------------------------------------------- sketches
  {
    id: 'sketch.line',
    title: '草图直线（构成任意闭合轮廓）',
    summary: '逐段画直线。闭合后可直接拉伸成任意多边形，六边形、键槽轮廓、支架外形都用它。',
    schema: {
      type: 'object',
      properties: {
        points: { type: 'array', description: '闭合折线顶点，mm，按顺序；不重复首点', items: { type: 'array', items: 'number' } },
        plane: { type: 'string', description: '基准面名或序号：前视/上视/右视' },
      },
      required: ['points'],
    },
    examples: [{ points: [[20, 0], [10, 17.32], [-10, 17.32], [-20, 0], [-10, -17.32], [10, -17.32]] }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: {
      probe: 'P9-hex',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: 'vol=10392.30 mm³（外接圆 r=20、拉伸 10）',
      expected: '(3√3/2)·400·10 = 10392.30 mm³',
    },
  },
  {
    id: 'sketch.circle',
    title: '草图圆',
    summary: '画圆。孔、轴段、凸台轮廓的基本形状；与草图阵列组合可做孔组。',
    schema: {
      type: 'object',
      properties: { cx: mm('圆心 x'), cy: mm('圆心 y'), diameter: mm('直径') },
      required: ['cx', 'cy', 'diameter'],
    },
    examples: [{ cx: 0, cy: 0, diameter: 10 }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-cut', swVersion: SW, at: VERIFIED_AT, measured: 'vol=118429.20 mm³（Ø10 通孔切穿 20 厚板）', expected: '120000−π·25·20 = 118429.20' },
  },
  {
    id: 'sketch.arc',
    title: '草图圆弧',
    summary: '按圆心、起点、终点画圆弧。与直线组合可做腰形、扇形、凸轮轮廓。',
    schema: {
      type: 'object',
      properties: {
        cx: mm('圆心 x'), cy: mm('圆心 y'),
        start: { type: 'array', items: 'number', description: '起点 [x,y] mm' },
        end: { type: 'array', items: 'number', description: '终点 [x,y] mm' },
        direction: { type: 'integer', enum: [1, -1], description: '1 逆时针，-1 顺时针' },
      },
      required: ['cx', 'cy', 'start', 'end'],
    },
    examples: [{ cx: 0, cy: 0, start: [30, 0], end: [-30, 0], direction: 1 }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-arc', swVersion: SW, at: VERIFIED_AT, measured: '2 弧 + 2 线闭合，segs=4，拉伸成功', expected: '—' },
  },
  {
    id: 'sketch.spline',
    title: '草图样条（自由轮廓）',
    summary: '给一串点画闭合样条。渐开线齿廓、凸轮曲线这类没有解析表达的形状走这里。',
    schema: {
      type: 'object',
      properties: {
        points: { type: 'array', description: '采样点，mm，闭合时首尾自动连回', items: { type: 'array', items: 'number' } },
        naturalEnds: { type: 'boolean', description: '模拟自然端点' },
      },
      required: ['points'],
    },
    examples: [{ points: [[20, 0], [19.4, 5], [17.3, 10], [14.1, 14.1]] }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-spline', swVersion: SW, at: VERIFIED_AT, measured: 'vol=12565.57 mm³（24 点近圆 r=20、拉伸 10）', expected: 'π·400·10 = 12566.37（差 0.006%）' },
  },
  {
    id: 'sketch.slot',
    title: '草图槽',
    summary: '原生槽对象：两端半圆 + 两条平行边，长度与宽度是可直接修改的参数，不会退化成四条散线。',
    schema: {
      type: 'object',
      properties: {
        width: mm('槽宽（= 两端圆弧直径）'),
        length: mm('槽长（两端圆心距 + 半圆，即总长）'),
        from: { type: 'array', items: 'number', description: '一端圆心 [x,y]' },
        to: { type: 'array', items: 'number', description: '另一端圆心 [x,y]' },
      },
      required: ['width', 'length'],
    },
    examples: [{ width: 10, length: 40, from: [-20, 0], to: [20, 0] }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-slot', swVersion: SW, at: VERIFIED_AT, measured: 'SketchSlot Length=0.0400 Width=0.0100，vol=4785.40 mm³', expected: '(10·40+π·25)·10 = 4785.40' },
  },
  {
    id: 'sketch.rectangle',
    title: '草图中心矩形',
    summary: '以原点为中心、给定半宽半高的矩形。板件、法兰、箱体的外形起点。',
    schema: {
      type: 'object',
      properties: { halfWidth: mm('半宽'), halfHeight: mm('半高') },
      required: ['halfWidth', 'halfHeight'],
    },
    examples: [{ halfWidth: 50, halfHeight: 30 }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-plate', swVersion: SW, at: VERIFIED_AT, measured: 'vol=120000.00 mm³（100×60×20）', expected: '100·60·20 = 120000.00' },
  },
  {
    id: 'sketch.pattern.circular',
    title: '草图圆周阵列',
    summary: '把一个草图实体绕中心复制 N 份，仍在同一个草图里。螺栓孔圈、散热筋、齿圈齿槽都用它。',
    schema: {
      type: 'object',
      properties: {
        center: { type: 'array', items: 'number', description: '阵列中心 [x,y]' },
        angleRad: { type: 'number', description: '总角度，整圈传 2π' },
        instances: count('份数'),
      },
      required: ['instances'],
    },
    examples: [{ center: [0, 0], angleRad: 6.283185307, instances: 6 }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-circpat', swVersion: SW, at: VERIFIED_AT, measured: '6 个 Ø10 圆，vol=4712.39 mm³', expected: '6·π·25·10 = 4712.39' },
  },
  {
    id: 'sketch.pattern.linear',
    title: '草图线性阵列',
    summary: '沿一个方向把草图实体复制 N 份。等距孔排、栅格都用它。',
    schema: {
      type: 'object',
      properties: {
        direction: { type: 'array', items: 'number', description: '方向 [dx,dy]' },
        spacing: mm('间距'),
        instances: count('份数'),
      },
      required: ['spacing', 'instances'],
    },
    examples: [{ direction: [1, 0], spacing: 20, instances: 4 }],
    execute: { tool: 'model', action: 'sketch' },
    evidence: { probe: 'P9-linpat', swVersion: SW, at: VERIFIED_AT, measured: '4 个 Ø10 圆，vol=3141.59 mm³', expected: '4·π·25·10 = 3141.59' },
  },

  // ---------------------------------------------------------------- features
  {
    id: 'feature.extrude',
    title: '拉伸',
    summary: '闭合草图轮廓生成实体。支持单侧、反向、两侧对称与成形到面。',
    schema: {
      type: 'object',
      properties: {
        depth: mm('拉伸深度（两侧对称时是总厚度）'),
        direction: { type: 'string', enum: ['normal', 'reverse', 'both'], description: '方向' },
        draft: { type: 'number', description: '拔模角，度' },
      },
      required: ['depth'],
    },
    examples: [{ depth: 20, direction: 'both' }],
    execute: { tool: 'model', action: 'feature' },
    evidence: { probe: 'P9-plate', swVersion: SW, at: VERIFIED_AT, measured: 'vol=120000.00 mm³', expected: '100·60·20 = 120000.00' },
  },
  {
    id: 'feature.cut',
    title: '拉伸切除',
    summary: '用草图挖掉材料。通孔、沉孔、开口都用它 —— 在本机比孔向导可靠。',
    schema: {
      type: 'object',
      properties: {
        depth: mm('切除深度'),
        through: { type: 'boolean', description: '完全贯穿' },
        flip: { type: 'boolean', description: '反向切除' },
      },
      required: ['depth'],
    },
    examples: [{ depth: 20, through: true }],
    execute: { tool: 'model', action: 'feature' },
    evidence: { probe: 'P9-cut', swVersion: SW, at: VERIFIED_AT, measured: 'vol=118429.20 mm³', expected: '120000−π·25·20' },
  },
  {
    id: 'feature.revolve',
    title: '旋转',
    summary: '轮廓绕中心线旋转成回转体。轴、套、带轮、法兰盘毛坯的常用形状。',
    schema: {
      type: 'object',
      properties: {
        angle: { type: 'number', description: '旋转角度，度；整周传 360' },
        axis: { type: 'string', enum: ['x', 'y', 'z', 'centerline'], description: '旋转轴：centerline=草图里的构造线；x/y/z=全局轴（桥接器按基准面交线建参考轴）' },
      },
      required: ['angle'],
    },
    examples: [{ angle: 360, axis: 'y' }],
    execute: { tool: 'model', action: 'feature' },
    evidence: { probe: 'P9-revolve', swVersion: SW, at: VERIFIED_AT, measured: 'vol=50265.48 mm³（矩形绕中心线 360°）', expected: 'π·400·40 = 50265.48' },
  },
  {
    id: 'feature.helix',
    title: '螺旋线',
    summary: '底圆草图 → 真螺旋线（IModelDoc2.InsertHelix，10 参）。蜗杆/螺纹/螺旋输送的唯一正确起点：'
      + '先有螺旋线，才能用 sweep cut 扫出真螺旋面。',
    schema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '底圆草图特征名（圆的直径就是螺旋线直径）' },
        definedBy: { type: 'string', enum: ['heightAndPitch', 'pitchAndRevolution', 'heightAndRevolution', 'spiral'] },
        height: mm('高度（definedBy 含 height 时生效）'),
        pitch: mm('螺距；单头时等于导程。Ø14 m1 蜗杆 = π·m = 3.141592'),
        revolutions: { type: 'number', description: '圈数（definedBy 含 revolution 时生效）' },
        reversed: { type: 'boolean', description: '沿轴反向推进' },
        clockwise: { type: 'boolean', description: '旋向' },
        tapered: { type: 'boolean' },
        outward: { type: 'boolean' },
        taperAngle: { type: 'number', description: '锥度角，度' },
        startAngle: { type: 'number', description: '起始角，度' },
      },
      required: ['profile', 'height', 'pitch'],
    },
    examples: [{ profile: 'hxbase', definedBy: 'heightAndPitch', height: 30, pitch: 3.141592 }],
    execute: { tool: 'model', action: 'helix' },
    evidence: {
      probe: 'T-SWPLUGIN-01/P1',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: '蜗杆 Ø14 m1：helix 特征类型 Helix，扫掠切除后体积 4594.47 mm³、面数 8、实测导程 3.141592 mm',
      expected: 'π·m = 3.141593',
    },
  },
  {
    id: 'feature.sweep',
    title: '扫掠（凸台/切除）',
    summary: '轮廓沿路径扫掠。切螺纹用 kind="sweptCut"（IFeatureManager.InsertCutSwept5）；'
      + '轮廓必须与路径起点相交（螺纹：轮廓画在过轴的轴向平面里）。',
    schema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '轮廓草图特征名' },
        path: { type: 'string', description: '路径特征名（螺旋线或草图）' },
        guides: { type: 'array', items: { type: 'string' } },
        cut: { type: 'boolean', description: 'true=切除' },
        thin: { type: 'boolean' },
        thickness: mm('薄壁厚度'),
        thickness2: mm('第二方向薄壁厚度'),
        thinType: { type: 'string', enum: ['oneDirection', 'oppDirection', 'midPlane', 'twoDirection'] },
        twistControl: { type: 'string', enum: ['followPath', 'keepNormalConstant', 'followPathFirstGuideCurve', 'followFirstSecondGuideCurves', 'constantTwist', 'normalConstantTwist'] },
        twist: { type: 'number', description: '扭转角，度' },
        startMatch: { type: 'string', enum: ['none', 'coincident', 'tangent'] },
        endMatch: { type: 'string', enum: ['none', 'coincident', 'tangent'] },
        circularProfile: { type: 'boolean', description: '圆截面扫掠（可省轮廓草图）' },
        circularDiameter: mm('圆截面直径'),
      },
      required: ['path'],
    },
    examples: [{ profile: 'groove', path: 'hx', cut: true }],
    execute: { tool: 'model', action: 'sweep' },
    evidence: {
      probe: 'T-SWPLUGIN-01/P1',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: 'SweepCut 沿 Helix 切除：圆柱 6031.86 → 4594.47 mm³',
      expected: '齿面为真螺旋面，导程 3.1416',
    },
  },
  {
    id: 'feature.loft',
    title: '放样',
    summary: '两段以上截面放样（真齿面用：锥齿大端/小端渐开线截面）。mode=boss 走 InsertProtrusionBlend2，'
      + 'cut 走 InsertCutBlend，surface 走 InsertLoftRefSurface2。截面少于 2 段会被拒绝（那是拉伸）。',
    schema: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'string' }, description: '截面草图特征名，按顺序' },
        guides: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['boss', 'cut', 'surface'] },
        closed: { type: 'boolean' },
        keepTangency: { type: 'boolean' },
        thin: { type: 'boolean' },
        thickness: mm('薄壁厚度'),
      },
      required: ['sections'],
    },
    examples: [{ sections: ['sec_big', 'sec_small'], mode: 'boss' }],
    execute: { tool: 'model', action: 'loft' },
    evidence: {
      probe: 'T-SWPLUGIN-01/P1',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: '函数面已接（InsertLoftRefSurface2 6 参 / InsertProtrusionBlend2 18 参），由 P3 锥齿样件给读数',
      expected: '—',
    },
  },
  {
    id: 'feature.shell',
    title: '抽壳（当前工具面未实现）',
    summary: '历史探针 P9-shell 曾在旧入口跑通（IModelDoc2.InsertFeatureShell），但当前工具面没有抽壳 action，model build 的 design definition 也没有 shell 分支。不要用 model action=feature 或 build 假装抽壳。',
    schema: {
      type: 'object',
      properties: {
        thickness: mm('壁厚'),
        outward: { type: 'boolean', description: '向外加厚' },
        removeFaces: { type: 'array', description: '要移除的面（选择 id 或面索引）', items: { type: 'string' } },
      },
      required: ['thickness'],
    },
    examples: [{ thickness: 2, outward: false }],
    execute: null,
    status: 'missing',
    take: 'not_implemented：当前工具面没有抽壳入口；要用只能改桥接器/新增动作，先写能力卡与验收。',
    evidence: { probe: 'P9-shell', swVersion: SW, at: VERIFIED_AT, measured: 'vol=23232.00 mm³（100×60×20 开顶抽 2）', expected: '120000−96·56·18 = 23232.00', caveat: '旧入口已移除，当前工具面不可达' },
  },
  {
    id: 'feature.hole-by-cut',
    title: '孔（草图圆 + 切除）',
    summary: '本机实测可用的打孔方式。孔向导 HoleWizard5 在当前版本返回 NULL，草图圆 + 切除稳定。',
    schema: {
      type: 'object',
      properties: {
        diameter: mm('孔径'),
        positions: { type: 'array', description: '孔位 [x,y]，mm', items: { type: 'array', items: 'number' } },
        through: { type: 'boolean', description: '通孔' },
        depth: mm('盲孔深度（through=false 时用）'),
      },
      required: ['diameter', 'positions'],
    },
    examples: [{ diameter: 10, positions: [[-40, -20], [40, -20], [-40, 20], [40, 20]], through: true }],
    execute: { tool: 'model', action: 'feature' },
    evidence: { probe: 'P9-cut', swVersion: SW, at: VERIFIED_AT, measured: 'vol=118429.20 mm³', expected: '120000−π·25·20' },
  },

  // ---------------------------------------------------------------- assembly
  {
    id: 'assembly.insertComponent',
    title: '装配插入零件',
    summary:
      '把零件作为链接组件放进装配体，可指定位置。这是本机唯一可用的插入入口：AddComponent5 / AddComponent4 / AddComponent 在当前版本全部返回 NULL。',
    schema: {
      type: 'object',
      properties: {
        partPath: { type: 'string', description: '零件绝对路径' },
        x: mm('插入位置 x'),
        y: mm('插入位置 y'),
        z: mm('插入位置 z'),
      },
      required: ['partPath'],
    },
    examples: [{ partPath: 'D:/work/housing.SLDPRT', x: 0, y: 0, z: 0 }],
    execute: { tool: 'model', action: 'assembly' },
    evidence: {
      probe: 'P12-asm3',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: 'children 1→2，组件名 plate12-1/plate12-2，包围盒 100×60×10，存盘 61664 B，重开仍在',
      expected: '—',
    },
  },
  {
    id: 'assembly.mates',
    title: '装配配合',
    summary: '同心、重合、距离、齿轮比等配合。接口存在（AddMate5 等），尚未在本机实跑，属待验证项。',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['coincident', 'concentric', 'distance', 'gear'], description: '配合类型' },
        entities: { type: 'array', items: 'string', description: '配合对象（选择 id）' },
      },
      required: ['type', 'entities'],
    },
    examples: [{ type: 'concentric', entities: ['sel:1', 'sel:2'] }],
    execute: { tool: 'model', action: 'assembly' },
    status: 'unverified',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实跑', expected: '—' },
  },

  // ---------------------------------------------------------------- drawing
  {
    id: 'drawing.viewPalette',
    title: '工程图视图（View Palette）',
    summary:
      '从模型生成标准视图并放到图纸上。Create3rdAngleViews2 / CreateDrawViewFromModelView3 在当前版本不可用，View Palette 才是可用路径。',
    schema: {
      type: 'object',
      properties: {
        modelPath: { type: 'string', description: '模型绝对路径' },
        views: { type: 'array', description: '要放的视图名，如 ["*前视","*上视","*等轴测"]', items: { type: 'string' } },
        sheetTemplate: { type: 'string', description: '图纸模板，默认 gb_a3.drwdot' },
      },
      required: ['modelPath', 'views'],
    },
    examples: [{ modelPath: 'D:/work/housing.SLDPRT', views: ['*前视', '*上视', '*等轴测'] }],
    execute: { tool: 'model', action: 'drawing' },
    evidence: {
      probe: 'P12-draw2',
      swVersion: SW,
      at: VERIFIED_AT,
      measured: 'GenerateViewPaletteViews=True paletteN=10，DropDrawingViewFromPalette2 → 工程图视图1，views 1→2，图纸 85745 B',
      expected: '空白图纸 PDF 41145 B',
    },
  },
  {
    id: 'drawing.section',
    title: '工程图剖视图',
    summary: '剖视、局部放大、辅助视图接口齐备（CreateSectionViewAt5 / CreateDetailViewAt4 / CreateAuxiliaryViewAt2），尚未实跑。',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['section', 'detail', 'auxiliary'], description: '视图类型' },
        at: { type: 'array', items: 'number', description: '剖切线或中心位置' },
      },
      required: ['kind'],
    },
    examples: [{ kind: 'section', at: [0, 0] }],
    execute: { tool: 'model', action: 'drawing' },
    status: 'unverified',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实跑', expected: '—' },
  },

  // ---------------------------------------------------------------- parameters
  {
    id: 'param.dimension',
    title: '尺寸驱动（改原生尺寸值）',
    summary:
      '改特征的 D1/D2 等尺寸并重建。这是最可靠的参数化方式：值落在 SOLIDWORKS 内部，几何由它自己更新。注意 IFeature.Parameter() 只认裸名（"D1"），带 @ 的全名会返回 null。',
    schema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: '特征名，如 "凸台-拉伸1"' },
        dimension: { type: 'string', description: '裸尺寸名，如 "D1"' },
        value: mm('新值'),
      },
      required: ['feature', 'dimension', 'value'],
    },
    examples: [{ feature: '凸台-拉伸1', dimension: 'D1', value: 45 }],
    execute: { tool: 'model', action: 'edit' },
    evidence: { probe: 'P1-dim', swVersion: SW, at: VERIFIED_AT, measured: 'Zmax 0.020→0.045', expected: '—' },
  },
  {
    id: 'param.equation',
    title: '方程式驱动（全局变量 + 尺寸表达式）',
    summary:
      '把语义参数写成全局变量，让尺寸引用它。改一个变量，所有引用它的尺寸一起动。保存改名后方程式引用会失效，必须跑 RepairEquationReferences。',
    schema: {
      type: 'object',
      properties: {
        variables: { type: 'object', description: '变量名 → 数值或表达式' },
        equations: { type: 'object', description: '尺寸全名 → 表达式' },
      },
      required: ['variables'],
    },
    examples: [{ variables: { thickness: 20 }, equations: { 'D1@凸台-拉伸1@housing.Part': '"thickness"' } }],
    execute: { tool: 'model', action: 'edit' },
    evidence: { probe: 'P3-eq', swVersion: SW, at: VERIFIED_AT, measured: '变量与回读一致，且修引用后几何跟随', expected: '—' },
  },
  {
    id: 'param.configuration',
    title: '配置（一模型多规格）',
    summary: '同一模型下多套尺寸组合。M8/M10 螺栓孔、不同长度的轴段可以共用一个零件文件。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配置名' },
        comment: { type: 'string', description: '说明' },
      },
      required: ['name'],
    },
    examples: [{ name: 'M10', comment: '十毫米规格' }],
    execute: { tool: 'model', action: 'edit' },
    evidence: { probe: 'P9-config', swVersion: SW, at: VERIFIED_AT, measured: 'GetConfigurationNames 由 [默认] 变 [M2,默认]', expected: '—' },
  },

  // ---------------------------------------------------------------- observation
  {
    id: 'observe.screenshot',
    title: '模型截图（BMP）',
    summary: '把当前视图存成位图。1280×800 约 97 ms、3 MB，转 PNG 约 90 KB。不抢前台焦点。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出 BMP 绝对路径' },
        width: { type: 'integer', description: '像素宽，默认 1280' },
        height: { type: 'integer', description: '像素高，默认 800' },
        view: { type: 'string', description: '视图名，如 "*等轴测"' },
      },
      required: ['path'],
    },
    examples: [{ path: 'D:/work/obs/v1.bmp', width: 1280, height: 800, view: '*等轴测' }],
    execute: { tool: 'capture', action: 'view' },
    evidence: { probe: 'P1-capture', swVersion: SW, at: VERIFIED_AT, measured: '97 ms / 3 MB BMP → 89.8 KB PNG', expected: '—' },
  },
  {
    id: 'observe.selectByRay',
    title: '按射线选面/边',
    summary: '从一点射一条线，选中第一个命中的对象。15 ms，是"截图上的位置 → 真实对象"的基础。',
    schema: {
      type: 'object',
      properties: {
        origin: { type: 'array', items: 'number', description: '射线起点 [x,y,z]，mm' },
        direction: { type: 'array', items: 'number', description: '射线方向 [dx,dy,dz]' },
        type: { type: 'string', enum: ['face', 'edge', 'vertex'], description: '要选的对象类型' },
      },
      required: ['origin', 'direction'],
    },
    examples: [{ origin: [0, 0, 200], direction: [0, 0, -1], type: 'face' }],
    execute: { tool: 'select', action: 'ray' },
    evidence: { probe: 'P1-ray', swVersion: SW, at: VERIFIED_AT, measured: '15 ms 命中上表面', expected: '—' },
  },
  {
    id: 'observe.persistentRef',
    title: '持久引用（跨会话找回对象）',
    summary: '把一个面/边存成字节串，下次会话凭它还原来那个对象。重建后靠几何信息复核。',
    schema: {
      type: 'object',
      properties: { selectionId: { type: 'string', description: '选择结果 id' } },
      required: ['selectionId'],
    },
    examples: [{ selectionId: 'sel:7f3a' }],
    execute: { tool: 'select', action: 'highlight' },
    status: 'unverified',
    evidence: { probe: 'P12-model', swVersion: SW, at: VERIFIED_AT, measured: 'GetPersistReference3 / GetObjectByPersistReference3 存在，未实跑', expected: '—' },
  },

  // ---------------------------------------------------------------- escape hatch
  {
    id: 'native.invoke',
    title: '任意 interop 成员调用（未包装功能的出口）',
    summary:
      '按接口名 + 成员名反射调用任何 SOLIDWORKS API。返回签名、返回值摘要与 out 参数。包装层没有的功能从这里走，不需要改桥接器，也不需要重启服务。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['app', 'doc', 'partDoc', 'assemblyDoc', 'drawingDoc', 'featureManager', 'sketchManager', 'extension', 'selectionManager', 'modelView', 'mathUtility'], description: '在哪个对象上调' },
        iface: { type: 'string', description: '接口全名，如 IFeatureManager' },
        member: { type: 'string', description: '成员名' },
        args: { type: 'array', description: '按签名顺序的参数；数值会按目标形参类型转换' },
      },
      required: ['target', 'member'],
    },
    examples: [{ target: 'app', iface: 'ISldWorks', member: 'RevisionNumber' }],
    execute: { tool: 'model', action: 'invoke' },
    evidence: { probe: 'P-m1-invoke', swVersion: SW, at: VERIFIED_AT, measured: 'app.RevisionNumber → "34.3.2"；overload 解析命中 Int32 版本', expected: '—' },
  },
  {
    id: 'native.kinds',
    title: '列出一个对象上真有的成员（invoke 前先看）',
    summary:
      '对一个现场对象列出它能调用的方法/属性，每条带 where（声明它的接口）、signature、paramCount，可分页。invoke 打了错的对象或参数个数不对时，先用它对齐，别靠猜。',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['app', 'doc', 'partDoc', 'assemblyDoc', 'drawingDoc', 'featureManager', 'sketchManager', 'extension', 'selectionManager', 'modelView', 'mathUtility'], description: '看哪个对象' },
        iface: { type: 'string', description: '只看某个接口，如 IPartDoc' },
        offset: { type: 'number', description: '分页起点' },
        limit: { type: 'number', description: '每页条数，默认 200' },
      },
      required: ['target'],
    },
    examples: [{ target: 'extension', limit: 20 }],
    execute: { tool: 'model', action: 'kinds' },
    evidence: { probe: 'P-kinds', swVersion: SW, at: VERIFIED_AT, measured: 'extension 350 个成员 / partDoc 922 个（IPartDoc 171 + IModelDoc2 751）/ 不存在的接口回 UNKNOWN_TYPE', expected: '—' },
  },

  // ---------------------------------------------------------------- deliver
  {
    id: 'export.step',
    title: '导出 STEP',
    summary: '把当前零件/装配存成 STEP，供下游 CAD 或仿真使用。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '输出 .step/.stp 绝对路径' } },
      required: ['path'],
    },
    examples: [{ path: 'D:/work/housing.step' }],
    execute: { tool: 'deliver', action: 'export' },
    evidence: { probe: 'P1-export', swVersion: SW, at: VERIFIED_AT, measured: '15755 B STEP 文件', expected: '—' },
  },
  {
    id: 'export.pdf',
    title: '导出 PDF（工程图）',
    summary: '把图纸存成 PDF。图纸里有真视图时约 85 KB，空白图纸只有 41 KB —— 文件大小可以直接当"图纸是否为空"的判据。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '输出 .pdf 绝对路径' } },
      required: ['path'],
    },
    examples: [{ path: 'D:/work/drawing.pdf' }],
    execute: { tool: 'deliver', action: 'export' },
    evidence: { probe: 'P12-draw2', swVersion: SW, at: VERIFIED_AT, measured: '85745 B（含视图）', expected: '空白图纸 41145 B' },
  },

  // ---------------------------------------------------------------- inspect
  {
    id: 'inspect.featureTree',
    title: '读特征树',
    summary: '按顺序列出特征名、类型与 ID，含基准面。基准面在本机是中文名（前视/上视/右视基准面），只可靠 GetTypeName2()=="RefPlane" 取。',
    schema: {
      type: 'object',
      properties: { depth: { type: 'integer', description: '展开层数，默认全部' } },
    },
    examples: [{ depth: 3 }],
    execute: { tool: 'inspect', action: 'tree' },
    evidence: { probe: 'P1-inspect', swVersion: SW, at: VERIFIED_AT, measured: '特征树按 FirstFeature/GetNextFeature 顺序返回', expected: '—' },
  },
  {
    id: 'inspect.measure',
    title: '测量体积与包围盒',
    summary: '用 GetMassProperties 取体积，用 GetBodyBox 取包围盒。这是验收的默认手段：先用解析式算出应有体积，再和实测比。',
    schema: {
      type: 'object',
      properties: { body: { type: 'string', enum: ['solid', 'all'], description: '测量哪些实体' } },
    },
    examples: [{ body: 'solid' }],
    execute: { tool: 'inspect', action: 'measure' },
    evidence: { probe: 'P9-*', swVersion: SW, at: VERIFIED_AT, measured: '七个基元的体积全部与解析式一致（误差 <0.01%）', expected: '—' },
  },
  {
    id: 'inspect.sketch',
    title: '读草图约束状态',
    summary: '返回草图的约束状态与自由度。欠约束的草图仍能拉伸，但改起来会散 —— 这是"坐标对了不等于参数化对了"的判据。',
    schema: {
      type: 'object',
      properties: { sketch: { type: 'string', description: '草图名，省略则读活动草图' } },
    },
    examples: [{}],
    execute: { tool: 'inspect', action: 'sketch' },
    evidence: { probe: 'P1-inspect', swVersion: SW, at: VERIFIED_AT, measured: 'constraintStatus / fullyConstrained 已随 format=both 返回', expected: '—' },
  },

  // ---------------------------------------------------------------- known dead ends
  {
    id: 'feature.holeWizard',
    title: '孔向导（当前版本不可用）',
    summary:
      'HoleWizard5 的 27 参版本在本机无论选面、换孔型还是换终止条件都返回 NULL。用 sketch.circle + feature.cut 代替；要用它请走 native.invoke 换参数继续试。',
    schema: { type: 'object', properties: { standard: { type: 'string' }, size: { type: 'string' }, depth: mm('深度') } },
    examples: [{ standard: 'GB', size: 'M10', depth: 20 }],
    execute: { tool: 'model', action: 'invoke', args: { target: 'featureManager', member: 'HoleWizard5' } },
    status: 'blocked',
    evidence: { probe: 'P10-hole', swVersion: SW, at: VERIFIED_AT, measured: 'swWzdCounterBore 与类型 0 均返回 NULL（选面后）', expected: '—' },
  },
  {
    id: 'feature.linearPattern',
    title: '特征线性阵列（当前版本不可用）',
    summary:
      'FeatureLinearPattern5 返回 NULL；更早的 CreateDefinition 路径直接抛 RPC_E_SERVERFAULT。用 sketch.pattern.linear 在草图里复制再一次拉伸/切除，结果等价且稳定。',
    schema: { type: 'object', properties: { count: count('份数'), spacing: mm('间距') } },
    examples: [{ count: 4, spacing: 20 }],
    execute: { tool: 'model', action: 'invoke', args: { target: 'featureManager', member: 'FeatureLinearPattern5' } },
    status: 'blocked',
    evidence: { probe: 'P10-pattern', swVersion: SW, at: VERIFIED_AT, measured: 'NULL（特征 mark=4 + 方向边 mark=4）', expected: '—' },
  },
  {
    id: 'feature.mirror',
    title: '特征镜像（当前版本不可用）',
    summary: 'InsertMirrorFeature2 返回 NULL，体积 16000.00 → 16000.00 完全不变。用草图镜像或直接画对称轮廓替代。',
    schema: { type: 'object', properties: { plane: { type: 'string', description: '镜像面' } } },
    examples: [{ plane: '右视基准面' }],
    execute: { tool: 'model', action: 'invoke', args: { target: 'featureManager', member: 'InsertMirrorFeature2' } },
    status: 'blocked',
    evidence: { probe: 'P9-mirror', swVersion: SW, at: VERIFIED_AT, measured: 'NULL，体积不变', expected: '—' },
  },
  {
    id: 'drawing.thirdAngle',
    title: '三视图自动生成（当前版本不可用）',
    summary:
      'Create3rdAngleViews2 在模型已打开时返回 True，但 GetViewCount() 只有 0~1，特征树里只有 DrSheet；CreateDrawViewFromModelView3/2 恒 NULL。用 drawing.viewPalette。',
    schema: { type: 'object', properties: { modelPath: { type: 'string' } } },
    examples: [{ modelPath: 'D:/work/housing.SLDPRT' }],
    execute: { tool: 'model', action: 'invoke', args: { target: 'drawingDoc', member: 'Create3rdAngleViews2' } },
    status: 'blocked',
    evidence: { probe: 'P10-drw', swVersion: SW, at: VERIFIED_AT, measured: 'True 但 views=1，无 DrawingView 特征', expected: '—' },
  },

  // ---------------------------------------------------------------- other features
  {
    id: 'feature.fillet',
    title: '圆角（仅设计定义里的竖边/指定高度圆边）',
    summary: '当前入口是 model action="build" 的 design definition（features 里的 fillet/edgeFillet），不是独立 action。桥接器只支持竖边与指定高度的圆周边；选边靠几何条件，不认任意 persistentId。本机未跑通完整参数组合，属未验证。',
    schema: { type: 'object', properties: { radius: mm('半径'), edges: { type: 'array', items: 'string', description: '目标边（当前实现按几何条件选，不接受任意边 id）' } } },
    examples: [{ radius: 3, edges: ['sel:1'] }],
    execute: { tool: 'model', action: 'build', via: 'definition' },
    status: 'unverified',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实跑', expected: '—' },
  },
  {
    id: 'feature.chamfer',
    title: '倒角（当前工具面未实现）',
    summary: '当前工具面没有倒角 action，design definition 也没有 chamfer 分支；桥接器里同样没有实现。不要用 model action=feature 或 build 假装倒角，也不要连续猜 advanced_api 参数。',
    schema: { type: 'object', properties: { distance: mm('倒角距离'), edges: { type: 'array', items: 'string', description: '目标边' } } },
    examples: [{ distance: 1, edges: ['sel:1'] }],
    execute: null,
    status: 'missing',
    take: 'not_implemented：需要新增桥接器 op + 工具动作，先写能力卡与验收。',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实现', expected: '—' },
  },
  {
    id: 'feature.sweep',
    title: '扫描（当前工具面未实现）',
    summary: '接口存在，但当前工具面的 design definition 没有 sweep 分支，桥接器也没有实现；本机未实跑。要用只能改桥接器/新增动作。',
    schema: { type: 'object', properties: { profile: { type: 'string' }, path: { type: 'string' } } },
    examples: [{ profile: '草图1', path: '草图2' }],
    execute: null,
    status: 'missing',
    take: 'not_implemented：当前 build 不支持 sweep；不要拿未验证的 invoke 连续试参。',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实现', expected: '—' },
  },
  {
    id: 'feature.loft',
    title: '放样（当前工具面未实现）',
    summary: '接口存在，但当前工具面的 design definition 没有 loft 分支，桥接器也没有实现；本机未实跑。要用只能改桥接器/新增动作。',
    schema: { type: 'object', properties: { profiles: { type: 'array', items: 'string' } } },
    examples: [{ profiles: ['草图1', '草图2'] }],
    execute: null,
    status: 'missing',
    take: 'not_implemented：当前 build 不支持 loft；不要拿未验证的 invoke 连续试参。',
    evidence: { probe: '—', swVersion: SW, at: VERIFIED_AT, measured: '未实现', expected: '—' },
  },
  {
    id: 'model.undo',
    title: '撤销与重做',
    summary: '按步回退。改坏了不用重建整份模型 —— 这也是"从有效步骤继续"的底座。',
    schema: { type: 'object', properties: { count: { type: 'integer', description: '回退步数，默认 1' } } },
    examples: [{ steps: 1 }],
    execute: { tool: 'model', action: 'undo' },
    evidence: { probe: 'P1-undo', swVersion: SW, at: VERIFIED_AT, measured: 'EditUndo2 / EditRedo2 / ClearUndoList 可用', expected: '—' },
  },
  {
    id: 'model.gear',
    title: '齿轮（原生齿形）',
    summary: '按模数/齿数/压力角生成直齿轮：圆柱 + 一个齿槽切除 + 原生圆周阵列。build 的 primitives 写 {shape:"gear", teeth, module, pressureAngle}；中心孔另用 cut + circle。齿轮不要先跑 model action=plan（plan 会把生成的齿槽草图误判成坐标草稿）。锥齿/螺旋齿参数（bevel/coneAngle/faceWidth/helixAngle）会被明确拒绝（UNSUPPORTED_PARAM），不会生成一只看起来对的直齿轮。',
    schema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: '设计 id' },
        teeth: count('齿数，例如 20'),
        module: { type: 'number', description: '模数，例如 2' },
        pressureAngle: { type: 'number', description: '压力角（度），默认 20' },
        thickness: mm('齿厚 / 拉伸深度'),
        bore: mm('中心孔直径，0 表示不钻孔'),
      },
      required: ['designId', 'teeth', 'module', 'thickness'],
    },
    examples: [{ designId: 'gear-20', teeth: 20, module: 2, pressureAngle: 20, thickness: 10, bore: 12 }],
    execute: { tool: 'model', action: 'build' },
    status: 'unverified',
    evidence: { probe: 'gear-native', swVersion: SW, at: VERIFIED_AT, measured: '未实跑（2026-11-18 起测）', expected: '—' },
  },
  {
    id: 'export.sldprt',
    title: '存盘交付（SLDPRT）',
    summary: '把内存里的零件存成 .sldprt，并写 design.json / manifest。这是唯一合法的存盘路径：直接 SaveAs 会被 GATE_BYPASS_REFUSED 拒；交付门先要求 capture 一张当前模型图。',
    schema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: '要交付的设计 id' },
        path: { type: 'string', description: '目标路径；省略则落到数据目录 out/<designId>.sldprt' },
        kind: { type: 'string', description: 'sldprt（默认）| step | pdf | dxf' },
      },
      required: ['designId'],
    },
    examples: [{ designId: 'gear-20', kind: 'sldprt' }],
    execute: { tool: 'deliver', action: 'sldprt' },
    evidence: { probe: 'deliver-smoke', swVersion: SW, at: VERIFIED_AT, measured: '2026-11-18 真机：capture→deliver 产出 asm_a.sldprt 71672 B，fileCheck pass', expected: '—' },
  },
  {
    id: 'assembly.drive',
    title: '装配驱动与转角读回',
    summary: '按组件名转一个角度（componentRotate），再读回各组件实际姿态；配合的 LockRotation 可让同轴件跟随。',
    schema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: '装配体 designId' },
        component: { type: 'string', description: '组件名，如 sun1-1' },
        angle: { type: 'number', description: '角度（度）' },
        axis: { type: 'string', description: '旋转轴，默认组件自身轴线' },
      },
      required: ['designId', 'component', 'angle'],
    },
    examples: [{ designId: 'gear_asm', component: 'sun1-1', angle: 12 }],
    execute: { tool: 'model', action: 'componentRotate' },
    status: 'unverified',
    evidence: { probe: 'drive-smoke', swVersion: SW, at: VERIFIED_AT, measured: '未实跑（2026-11-18 起测）', expected: '—' },
  },
  {
    id: 'inspect.assembly',
    title: '装配体体检（组件 / 配合）',
    summary: '列组件、包围盒、配合与锁转状态。装配完先查这里，确认插进去的件落在预期位置。',
    schema: {
      type: 'object',
      properties: {
        designId: { type: 'string', description: '装配体 designId' },
      },
      required: ['designId'],
    },
    examples: [{ designId: 'gear_asm' }],
    execute: { tool: 'inspect', action: 'assembly' },
    evidence: { probe: 'asm-smoke', swVersion: SW, at: VERIFIED_AT, measured: '2026-11-18 真机：2 组件装配 count=2，与 assemble 回包一致', expected: '—' },
  },
]

export const NATIVE_SOURCE = {
  id: 'solidworks-native',
  label: 'SOLIDWORKS 原生功能',
  description: '经本机实测可用的原生 API 封装，以及通向其余全部 API 的反射出口。',
}
