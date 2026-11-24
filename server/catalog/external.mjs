// Extensions that are not installed but are worth knowing about.
//
// Every entry says what we would take from it and what it would take to wire it
// up. Marking these "absent" rather than hiding them is deliberate: the catalog
// is supposed to answer "what could this machine do", and an honest "not here,
// here is how" is more useful than silence.
//
// Nothing here is fetched at runtime — an entry is a pointer, not a dependency.

export const EXTERNAL = [
  {
    id: 'ext.dsh-sw-cad',
    title: 'dsh-sw-cad',
    summary: 'DSH 接入 SOLIDWORKS 的参考实现：上游启动方式、按需能力发现。',
    url: 'https://github.com/27painter/dsh-sw-cad',
    take: ['DSH 侧插件挂载方式', '按需发现而不是预注册工具', '启动/复用策略'],
    status: 'absent',
  },
  {
    id: 'ext.solidworks-automation-skill',
    title: 'solidworks-automation-skill',
    summary: '连接、齿轮、装配与已有操作模块的现成集合。',
    url: 'https://github.com/wzyn20051216/solidworks-automation-skill',
    take: ['连接封装', '齿轮生成', '装配操作'],
    status: 'absent',
  },
  {
    id: 'ext.czuryk-solidworksmcp',
    title: 'czuryk/SolidworksMCP',
    summary: '参数化程序组织、局部修改、可执行的错误恢复。',
    url: 'https://github.com/czuryk/SolidworksMCP',
    take: ['参数化程序结构', '局部修改策略', '错误恢复的 nextActions 形态'],
    status: 'absent',
  },
  {
    id: 'ext.soheil-solidworks-mcp',
    title: 'soheil-mp/solidworks-mcp',
    summary: '强类型 COM、对象选择、装配、版本发布。',
    url: 'https://github.com/soheil-mp/solidworks-mcp',
    take: ['强类型 COM 封装', '选择对象模型', '版本发布方式'],
    status: 'absent',
  },
  {
    id: 'ext.freecad-gears',
    title: 'freecad.gears',
    summary: '渐开线齿形生成算法与独立几何实现，用来交叉验证齿数/齿距/齿顶齿根。',
    url: 'https://github.com/looooo/freecad.gears',
    take: ['渐开线齿廓算法', '独立几何对照'],
    status: 'absent',
  },
  {
    id: 'ext.kisssoft',
    title: 'KISSsoft（专业齿轮/传动计算）',
    summary: '可把齿轮计算结果与真实齿形直接生成到 SOLIDWORKS。本机未安装。',
    url: 'https://www.kisssoft.com/en/products/interfaces-and-partners/cad-interfaces',
    take: ['齿轮强度与寿命计算作为计算提供者', '真实齿形导入'],
    install: '安装 KISSsoft 及其 SOLIDWORKS 接口；装好后 calculate 的 provider=kisssoft 自动可用',
    status: 'absent',
  },
  {
    id: 'ext.mitcalc',
    title: 'MITCalc（机械计算 + 参数化模型）',
    summary: '机械计算与 CAD 联动，可作计算提供者。本机未安装。',
    url: 'https://www.mitcalc.com/',
    take: ['轴/轴承/弹簧/带链计算', '参数化模型联动'],
    install: '安装 MITCalc 与对应 SOLIDWORKS 插件；calculate 的 provider=mitcalc 自动可用',
    status: 'absent',
  },
  {
    id: 'ext.toolbox-calculators',
    title: 'Toolbox 内置计算器（梁、轴承）',
    summary: 'Toolbox 自带梁计算与轴承计算，可经 LoadAddIn + GetAddInObject 取到对象后调用。',
    url: 'https://help.solidworks.com/2026/english/SolidWorks/toolbox/HIDD_BEARINGCALC.htm',
    take: ['梁计算', '轴承选型', '寿命计算'],
    install: '无需安装；属已装 Toolbox，需探活确认可调用对象',
    status: 'unverified',
  },
]

export const EXTERNAL_SOURCE = {
  id: 'external',
  label: '可获取的扩展',
  description: '未安装但可接入的第三方实现与专业计算软件；每条说明取什么、怎么装。',
}
