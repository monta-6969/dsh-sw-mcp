// 渐开线直齿轮轮廓：整只齿轮的采样多边形仅用于解析面积对照，不允许送进草图。
//
// 为什么先在 Node 里算：齿轮的数学（模数、压力角、基圆、渐开线）与 SOLIDWORKS
// 无关，放在这里可以用解析面积单测；真正的建模走 spurGearCurves 的原生圆弧/样条，
// 不被拟合成样条。这是「先能建出正确的齿轮」，原生单齿阵列是下一步。
const TAU = Math.PI * 2

function involuteAngle(radius, base) {
  const ratio = Math.max(-1, Math.min(1, base / radius))
  const alpha = Math.acos(ratio)
  return Math.tan(alpha) - alpha
}

/**
 * @param {{teeth?:number, module?:number, pressureAngle?:number, backlash?:number, samples?:number}} [spec]
 * @returns {{points:number[][], area:number, teeth:number, rootRadius:number, tipRadius:number, pitchRadius:number}}
 */
export function spurGearOutline(spec = {}) {
  const teeth = Math.max(6, Math.floor(spec.teeth ?? 20))
  const module = Number(spec.module ?? 2)
  const pressureAngle = Number(spec.pressureAngle ?? 20) * Math.PI / 180
  const backlash = Number(spec.backlash ?? 0)
  const samples = Math.max(2, Math.min(24, Math.floor(spec.samples ?? 6)))
  const pitchRadius = module * teeth / 2
  const tipRadius = pitchRadius + module
  const rootRadius = Math.max(0.1, pitchRadius - 1.25 * module)
  const baseRadius = pitchRadius * Math.cos(pressureAngle)
  const step = TAU / teeth
  const halfToothAtPitch = Math.PI / (2 * teeth) - backlash / (2 * pitchRadius)

  const invPitch = involuteAngle(pitchRadius, baseRadius)
  const flankStart = Math.max(rootRadius, baseRadius)
  const flankOffset = (radius) => halfToothAtPitch - (involuteAngle(radius, baseRadius) - invPitch)
  const rootOffset = flankOffset(flankStart)
  const tipOffset = flankOffset(tipRadius)
  if (!(tipOffset > 0) || !(step - 2 * rootOffset > 0)) {
    throw new Error(`齿形参数无法闭合：teeth=${teeth}, module=${module}, backlash=${backlash}`)
  }

  const points = []
  // 坐标落到 1e-6 mm 并消掉 -0：桥接器会把坐标转成文本再进表达式求值，
  // 像 1.3E-15 这种科学计数法它不认（实测报 unexpected 'E-15'）。
  const round6 = (value) => {
    const rounded = Math.round(value * 1e6) / 1e6
    return Object.is(rounded, -0) ? 0 : rounded
  }
  const push = (radius, angle) => points.push([round6(radius * Math.cos(angle)), round6(radius * Math.sin(angle))])

  for (let i = 0; i < teeth; i++) {
    const center = i * step
    // 齿根圆弧：从上一个齿的右侧根部转到这个齿的左侧根部。
    const rootFrom = center - step + rootOffset
    const rootTo = center - rootOffset
    for (let s = 0; s <= samples; s++) {
      push(rootRadius, rootFrom + (rootTo - rootFrom) * (s / samples))
    }
    // 左齿面：根部 → 齿顶。基圆以下用基圆处的角度（渐开线从基圆开始）。
    for (let s = 0; s <= samples; s++) {
      const radius = flankStart + (tipRadius - flankStart) * (s / samples)
      push(radius, center - flankOffset(radius))
    }
    // 齿顶圆弧。
    for (let s = 1; s < samples; s++) {
      const angle = center - tipOffset + (2 * tipOffset) * (s / samples)
      push(tipRadius, angle)
    }
    // 右齿面：齿顶 → 根部。
    for (let s = samples; s >= 0; s--) {
      const radius = flankStart + (tipRadius - flankStart) * (s / samples)
      push(radius, center + flankOffset(radius))
    }
  }

  let area2 = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  return {
    points,
    area: Math.abs(area2) / 2,
    teeth,
    rootRadius,
    pitchRadius,
    tipRadius,
  }
}

/** 一个齿槽的闭合轮廓：齿顶圆弧 → 下一齿左齿面 → 齿根圆弧 → 本齿右齿面。
 *  它从齿顶圆挖掉后剩下的就是齿轮，因此可以做成「圆柱 + 齿槽切除 + 圆周阵列」。 */
export function spurGearGap(spec = {}) {
  const teeth = Math.max(6, Math.floor(spec.teeth ?? 20))
  const module = Number(spec.module ?? 2)
  const pressureAngle = Number(spec.pressureAngle ?? 20) * Math.PI / 180
  const backlash = Number(spec.backlash ?? 0)
  const samples = Math.max(2, Math.min(24, Math.floor(spec.samples ?? 6)))
  const pitchRadius = module * teeth / 2
  const tipRadius = pitchRadius + module
  const rootRadius = Math.max(0.1, pitchRadius - 1.25 * module)
  const baseRadius = pitchRadius * Math.cos(pressureAngle)
  const step = TAU / teeth
  const halfToothAtPitch = Math.PI / (2 * teeth) - backlash / (2 * pitchRadius)
  const invPitch = involuteAngle(pitchRadius, baseRadius)
  const flankStart = Math.max(rootRadius, baseRadius)
  const flankOffset = (radius) => halfToothAtPitch - (involuteAngle(radius, baseRadius) - invPitch)
  const rootOffset = flankOffset(flankStart)
  const tipOffset = flankOffset(tipRadius)
  if (!(tipOffset > 0) || !(step - 2 * rootOffset > 0)) {
    throw new Error(`齿形参数无法闭合：teeth=${teeth}, module=${module}, backlash=${backlash}`)
  }

  const points = []
  const round6 = (value) => {
    const rounded = Math.round(value * 1e6) / 1e6
    return Object.is(rounded, -0) ? 0 : rounded
  }
  const push = (radius, angle) => points.push([round6(radius * Math.cos(angle)), round6(radius * Math.sin(angle))])
  const at = (index) => (index < 0 ? 0 : index > samples ? samples : index)

  // 齿顶圆弧：从本齿右齿顶到下一齿左齿顶。
  for (let s = 0; s <= samples; s++) {
    push(tipRadius, tipOffset + (step - 2 * tipOffset) * (s / samples))
  }
  // 下一齿的左齿面：齿顶 → 齿根。
  for (let s = samples; s >= 0; s--) {
    const radius = flankStart + (tipRadius - flankStart) * (at(s) / samples)
    push(radius, step - flankOffset(radius))
  }
  // 齿根圆弧：下一齿左齿根 → 本齿右齿根。
  for (let s = 0; s <= samples; s++) {
    const angle = (step - rootOffset) + (rootOffset - (step - rootOffset)) * (s / samples)
    push(rootRadius, angle)
  }
  // 本齿的右齿面：齿根 → 齿顶，回到起点。
  for (let s = 0; s <= samples; s++) {
    const radius = flankStart + (tipRadius - flankStart) * (s / samples)
    push(radius, flankOffset(radius))
  }

  let area2 = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  return {
    points,
    area: Math.abs(area2) / 2,
    teeth,
    rootRadius,
    tipRadius,
    pitchRadius,
    gearArea: Math.PI * tipRadius * tipRadius - teeth * Math.abs(area2) / 2,
  }
}

/** 原生齿形轮廓的草图段：齿顶圆弧 + 左右渐开线样条 + 齿根圆弧；
 *  基圆以下用一段径向线。没有任何折线拟合，圆弧和样条都是 SW 原生实体。
 *  齿形以“一个齿”为单位，原生圆周阵列负责复制。 */
export function spurGearCurves(spec = {}) {
  const teeth = Math.max(6, Math.floor(spec.teeth ?? 20))
  const module = Number(spec.module ?? 2)
  const pressureAngle = Number(spec.pressureAngle ?? 20) * Math.PI / 180
  const backlash = Number(spec.backlash ?? 0)
  const samples = Math.max(6, Math.min(16, Math.floor(spec.samples ?? 8)))
  const pitchRadius = module * teeth / 2
  const tipRadius = pitchRadius + module
  const rootRadius = Math.max(0.1, pitchRadius - 1.25 * module)
  const baseRadius = pitchRadius * Math.cos(pressureAngle)
  const step = TAU / teeth
  const halfToothAtPitch = Math.PI / (2 * teeth) - backlash / (2 * pitchRadius)
  const invPitch = involuteAngle(pitchRadius, baseRadius)
  const flankStart = Math.max(rootRadius, baseRadius)
  const flankOffset = (radius) => halfToothAtPitch - (involuteAngle(radius, baseRadius) - invPitch)
  const rootOffset = flankOffset(flankStart)
  const tipOffset = flankOffset(tipRadius)
  if (!(tipOffset > 0) || !(step - 2 * rootOffset > 0)) {
    throw new Error(`齿形参数无法闭合：teeth=${teeth}, module=${module}, backlash=${backlash}`)
  }
  const round6 = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r }
  const point = (radius, angle) => [round6(radius * Math.cos(angle)), round6(radius * Math.sin(angle))]
  const flankPoints = (side) => {
    const out = []
    for (let i = 0; i <= samples; i++) {
      const radius = flankStart + (tipRadius - flankStart) * (i / samples)
      const angle = side > 0 ? step - flankOffset(radius) : flankOffset(radius)
      out.push(point(radius, angle))
    }
    return out
  }
  const tipArc = {
    kind: 'arc', id: 'tip-arc',
    center: [0, 0], radius: tipRadius, startAngle: tipOffset, endAngle: step - tipOffset, direction: 1,
    start: point(tipRadius, tipOffset), end: point(tipRadius, step - tipOffset),
  }
  const rootArc = {
    kind: 'arc', id: 'root-arc',
    center: [0, 0], radius: rootRadius, startAngle: step - rootOffset, endAngle: rootOffset, direction: -1,
    start: point(rootRadius, step - rootOffset), end: point(rootRadius, rootOffset),
  }
  const curves = [tipArc]
  curves.push({ kind: 'spline', id: 'left-flank', points: flankPoints(+1).reverse(), degree: 3 })
  if (rootRadius < flankStart - 1e-9) {
    curves.push({ kind: 'line', id: 'left-root-line',
      start: point(flankStart, step - rootOffset), end: point(rootRadius, step - rootOffset) })
  }
  curves.push(rootArc)
  if (rootRadius < flankStart - 1e-9) {
    curves.push({ kind: 'line', id: 'right-root-line',
      start: point(rootRadius, rootOffset), end: point(flankStart, rootOffset) })
  }
  curves.push({ kind: 'spline', id: 'right-flank', points: flankPoints(-1), degree: 3 })
  return { curves, teeth, tipRadius, rootRadius, pitchRadius, baseRadius, step, halfToothAtPitch }
}

/** 原生齿形定义：圆柱 + 一个齿槽切除 + 原生圆周阵列。
 *  定义里保留 kind:"pattern" 特征，server 在 build 后把它提交给 patternCircular。 */
export function nativeGearDefinition(spec = {}) {
  const gap = spurGearGap(spec)
  gap.curves = spurGearCurves(spec).curves
  const depth = Number(spec.depth ?? 10)
  const plane = Number.isInteger(spec.plane) ? spec.plane : 0
  const axisPlanes = Array.isArray(spec.axisPlanes) && spec.axisPlanes.length === 2
    ? spec.axisPlanes.map(Number)
    : [1, 2]
  return {
    features: [
      { id: 'blank', kind: 'sketch', plane, primitives: [{ shape: 'circle', center: [0, 0], diameter: gap.tipRadius * 2 }] },
      { id: 'body', kind: 'extrude', profile: 'blank', depth },
      { id: 'gap', kind: 'sketch', plane, curves: gap.curves },
      { id: 'gapCut', kind: 'cut', profile: 'gap', throughAll: true },
      { id: 'teeth', kind: 'pattern', source: 'gapCut', count: gap.teeth, angleDeg: 360, axisPlanes },
    ],
    gearArea: gap.gearArea,
    tipRadius: gap.tipRadius,
    rootRadius: gap.rootRadius,
    teeth: gap.teeth,
    depth,
  }
}

/** 定义里有没有要求原生齿形（gear 基元 + native:true）。 */
export function hasNativeGear(definition) {
  // 只有显式 native:false 才走旧路径；默认必须原生。折线拟合已经被禁止。
  return gearSpecs(definition).some((spec) => spec.native !== false)
}

/** 把「一个 gear 基元 + 一个拉伸」的简单定义换成原生齿形定义；其它定义不动。
 *  返回 null 表示不需要展开。 */
export function expandNativeGear(definition) {
  if (!hasNativeGear(definition)) return null
  const specs = gearSpecs(definition)
  if (specs.length !== 1) {
    throw new Error(`GEAR_COMBINATION_UNSUPPORTED: 一个定义只能有一个 gear 基元（当前 ${specs.length} 个），多齿轮请分成独立零件`)
  }
  const features = definition.features ?? []
  const gearFeature = features.find((feature) => (feature?.primitives ?? []).some((primitive) => primitive?.shape === 'gear'))
  const extrudes = features.filter((feature) => feature.kind === 'extrude')
  const extras = features.filter((feature) => feature !== gearFeature && feature.kind !== 'extrude')
  if (extrudes.length !== 1 || extras.length > 0) {
    throw new Error('GEAR_COMBINATION_UNSUPPORTED: 齿轮原生路线只支持「一个 gear 草图 + 一个拉伸」，'
      + '混入其它草图/切除/阵列会静默丢特征；请拆成独立零件或先建模再单独加特征')
  }
  const extrude = extrudes[0]
  if (definition.params && Object.keys(definition.params).length > 0) {
    throw new Error('GEAR_COMBINATION_UNSUPPORTED: gear 参数目前不参与方程求值，带 params 的齿轮定义会被拒绝，'
      + '请直接用字面量 teeth/module/pressureAngle')
  }
  if (extrude.direction && !['+Y', 'Y', '+y', 'y'].includes(String(extrude.direction))) {
    throw new Error('GEAR_COMBINATION_UNSUPPORTED: 齿轮原生路线目前只支持沿 +Y 拉伸')
  }
  const gearSpec = specs[0]
  const depth = Number(extrude?.depth ?? gearSpec.depth ?? 10)
  const plane = Number.isInteger(gearSpec.plane) ? gearSpec.plane
    : (Number.isInteger(gearFeature?.plane) ? gearFeature.plane : 0)
  if (plane !== 0) {
    throw new Error('GEAR_COMBINATION_UNSUPPORTED: 齿轮原生路线目前只在基准面 0（上视）上成立；'
      + `草图平面 ${plane} 还没做方向适配，拒绝静默忽略`)
  }
  const built = nativeGearDefinition({ ...gearSpec, depth, plane: 0 })
  return {
    ...definition,
    features: built.features,
    gearNative: {
      teeth: built.teeth,
      tipRadius: built.tipRadius,
      rootRadius: built.rootRadius,
      depth: built.depth,
      gearArea: built.gearArea,
      mode: 'native-pattern',
    },
  }
}

/** 把定义里的 shape:"gear" 展开成闭合 polyline；其它基元原样返回。 */
/** 收集定义里所有 gear 轮廓，用来在结果里说明哪些是采样回退而不是原生齿形。 */
export function gearSpecs(definition) {
  const specs = []
  for (const feature of definition?.features ?? []) {
    for (const primitive of feature?.primitives ?? []) {
      if (primitive?.shape === 'gear') specs.push(primitive)
    }
  }
  return specs
}

export function expandGearPrimitives(definition) {
  if (!definition || !Array.isArray(definition.features)) return definition
  const gear = gearSpecs(definition)
  if (gear.length > 0) {
    throw new Error(
      'GEAR_NATIVE_REQUIRED: 齿轮不允许用折线拟合。请用原生路线（圆柱 + 一个齿槽/齿形切除 + 原生圆周阵列）；' +
      '显式 native:false 的旧定义已停用。'
    )
  }
  return definition
}
