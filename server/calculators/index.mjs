// 机械配算：把工程公式做成可复算的步骤，而不是一个黑箱数字。
//
// 每个计算器都返回三样东西：result（结论）、steps（代入了哪些数、按什么公式）、
// checks / warnings（哪些约束没满足）。第三样最重要——机械设计里"算得出一个数"
// 从来不等于"这个设计成立"，减速器能不能装、齿轮会不会根切、行星轮会不会干涉，
// 都得单独判。
//
// 单位约定：长度 mm，力 N，扭矩 N·m，转速 rpm，模数 mm，角度 deg。所有输入都按这套来，
// 输出里也标着单位，不做隐式换算。

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const num = (value, name) => {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new CodeError('BAD_ARGUMENT', `${name} 需要一个数字，收到 ${JSON.stringify(value)}`)
  }
  return n
}

export class CodeError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.code = code
    this.detail = detail ?? {}
  }
}

// --------------------------------------------------------------- 行星减速器

/**
 * 太阳轮输入、内齿圈固定、行星架输出 —— 这是最常见的行星减速器配置，
 * 传动比 i = 1 + z_ring / z_sun。三个"能不能装"的条件必须同时满足，
 * 只看传动比会做出装不进去的东西。
 */
const planetary = {
  id: 'planetary',
  title: '行星齿轮减速器',
  summary: '太阳轮输入、内齿圈固定、行星架输出；逐级算传动比、总传动比、输出转速、'
    + '齿轮能否装配（同心条件 / 装配条件 / 邻接条件），并标出根切风险。',
  inputs: {
    stages: '每一级：{ sun, ring, planets }，齿数',
    inputSpeed: '输入转速 rpm（可选，默认 1500）',
    inputTorque: '输入扭矩 N·m（可选，用于算输出扭矩）',
    efficiencyPerStage: '每级效率（可选，默认 0.97，行星轮系含轴承损失）',
  },
  formulas: [
    '单级传动比（内齿圈固定）：i = 1 + z_ring / z_sun',
    '总传动比：i_total = Π i_k',
    '行星轮齿数（同心条件）：z_planet = (z_ring - z_sun) / 2，必须是整数',
    '装配条件（均布）：(z_sun + z_ring) / n_planets 必须是整数',
    '邻接条件：z_planet + 2 < (z_sun + z_planet) · sin(π / n_planets)',
    '输出转速：n_out = n_in / i_total；输出扭矩：T_out = T_in · i_total · η_total',
  ],
  assumptions: [
    '内齿圈固定、太阳轮输入、行星架输出。其它配置（太阳轮固定、行星架输入等）不适用。',
    '按齿数算的是理论传动比；实际输出转速会有滑差以外的制造误差。',
    '效率是经验值，包含行星轮轴承与搅油损失，不是按齿面摩擦算出来的。',
    '没有做齿面接触强度 / 齿根弯曲强度校核 —— 那需要材料、热处理、载荷谱。',
  ],
  compute(inputs) {
    const stages = Array.isArray(inputs.stages) ? inputs.stages : []
    if (stages.length === 0) throw new CodeError('BAD_ARGUMENT', 'stages 至少要有 1 级')
    const inputSpeed = inputs.inputSpeed === undefined ? 1500 : num(inputs.inputSpeed, 'inputSpeed')
    const eta = inputs.efficiencyPerStage === undefined ? 0.97 : num(inputs.efficiencyPerStage, 'efficiencyPerStage')
    const inputTorque = inputs.inputTorque === undefined ? null : num(inputs.inputTorque, 'inputTorque')

    const steps = []
    const checks = []
    let total = 1
    let totalEta = 1
    const detail = []

    stages.forEach((raw, index) => {
      const stage = raw ?? {}
      const zs = num(stage.sun, `stages[${index}].sun`)
      const zr = num(stage.ring, `stages[${index}].ring`)
      const np = stage.planets === undefined ? 3 : num(stage.planets, `stages[${index}].planets`)

      const ratio = 1 + zr / zs
      total *= ratio
      totalEta *= eta
      steps.push({
        stage: index + 1,
        formula: 'i = 1 + z_ring / z_sun',
        substitution: `1 + ${zr} / ${zs}`,
        ratio: round(ratio, 4),
      })

      // 同心条件：两个行星轮之间夹着的齿数必须是整数
      const planetTeeth = (zr - zs) / 2
      const concentric = Number.isInteger(planetTeeth) && planetTeeth >= 1
      checks.push({
        stage: index + 1,
        name: '同心条件',
        formula: 'z_planet = (z_ring - z_sun) / 2',
        value: planetTeeth,
        passed: concentric,
        note: concentric
          ? `行星轮 ${planetTeeth} 齿`
          : `(z_ring - z_sun)/2 = ${planetTeeth}，不是正整数 —— 这三个齿轮啮合不上`,
      })

      // 装配条件：行星轮要能均布
      const assembly = (zs + zr) / np
      const assemblyOk = Number.isInteger(assembly)
      checks.push({
        stage: index + 1,
        name: '装配条件',
        formula: '(z_sun + z_ring) / n_planets',
        value: assembly,
        passed: assemblyOk,
        note: assemblyOk
          ? `${np} 个行星轮可以均布`
          : `${zs + zr} 不能被 ${np} 整除 —— 均布装不进去；能整除的行星轮数有 `
            + `${divisors.slice(0, 6).join('/') || '无'}`,
      })

      // 邻接条件：相邻行星轮不能互相咬到
      const neighbourLimit = (zs + planetTeeth) * Math.sin(Math.PI / np)
      const neighbourOk = planetTeeth + 2 < neighbourLimit
      // 反解「最多能放几个行星轮」：z_p+2 < (z_s+z_p)·sin(π/n)
      const sineNeeded = (planetTeeth + 2) / (zs + planetTeeth)
      const maxPlanets = sineNeeded >= 1
        ? 1
        : Math.max(1, Math.floor(Math.PI / Math.asin(sineNeeded)))
      checks.push({
        stage: index + 1,
        name: '邻接条件',
        formula: 'z_planet + 2 < (z_sun + z_planet) · sin(π/n)',
        value: round(neighbourLimit, 4),
        passed: neighbourOk,
        note: neighbourOk
          ? '行星轮之间有间隙'
          : `行星轮 ${planetTeeth} 齿，上限 ${round(neighbourLimit, 2)} —— 相邻行星轮会干涉；`
            + `这一组齿数最多只能放 ${maxPlanets} 个行星轮`,
      })
      // 装配条件没通过时，直接给出能装下的行星轮数
      const divisors = []
      for (let k = 2; k <= Math.min(12, zs + zr); k += 1) {
        if ((zs + zr) % k === 0) divisors.push(k)
      }

      // 根切：20° 标准齿，少于 17 齿必须有变位
      const undercut = zs < 17 || planetTeeth < 17
      if (undercut) {
        checks.push({
          stage: index + 1,
          name: '根切',
          formula: 'z_min ≈ 17（20° 标准齿，ha*=1）',
          value: Math.min(zs, planetTeeth),
          passed: false,
          note: `${Math.min(zs, planetTeeth)} 齿低于 17 —— 必须做正变位或改齿数，否则齿根被切掉`,
        })
      }

      detail.push({
        stage: index + 1,
        sun: zs,
        ring: zr,
        planet: planetTeeth,
        planets: np,
        ratio: round(ratio, 4),
      })
    })

    steps.push({
      formula: 'i_total = Π i_k',
      substitution: detail.map((d) => d.ratio).join(' × '),
      total: round(total, 4),
    })

    const result = {
      stages: detail,
      totalRatio: round(total, 4),
      totalEfficiency: round(totalEta, 4),
      inputSpeed,
      outputSpeed: round(inputSpeed / total, 4),
    }
    if (inputTorque !== null) {
      result.inputTorque = inputTorque
      result.outputTorque = round(inputTorque * total * totalEta, 4)
    }

    const warnings = checks.filter((c) => !c.passed).map((c) => `第 ${c.stage} 级 ${c.name}：${c.note}`)
    return { result, steps, checks, warnings }
  },
}

// ------------------------------------------------------------------ 直齿轮

const spur = {
  id: 'spur',
  title: '直齿圆柱齿轮副',
  summary: '按模数与齿数算分度圆、中心距、齿顶/齿根圆、端面重合度，检查根切与小齿轮齿数。',
  inputs: { module: '模数 mm', z1: '小齿轮齿数', z2: '大齿轮齿数', pressureAngle: '压力角 deg（默认 20）', faceWidth: '齿宽 mm（可选）' },
  formulas: [
    '分度圆直径：d = m · z',
    '中心距：a = m(z1 + z2) / 2',
    '齿顶圆：d_a = d + 2m；齿根圆：d_f = d - 2.5m',
    '基圆：d_b = d · cos α',
    '端面重合度：ε = [√(d_a1² - d_b1²) + √(d_a2² - d_b2²) - 2a·sin α] / (2πm·cos α)',
  ],
  assumptions: [
    '标准直齿圆柱齿轮，齿顶高系数 ha*=1、顶隙系数 c*=0.25，不变位。',
    '重合度按端面计算，不含斜齿的纵向重合度。',
    '没有做接触强度与弯曲强度校核。',
  ],
  compute(inputs) {
    const m = num(inputs.module, 'module')
    const z1 = num(inputs.z1, 'z1')
    const z2 = num(inputs.z2, 'z2')
    const alpha = ((inputs.pressureAngle === undefined ? 20 : num(inputs.pressureAngle, 'pressureAngle')) * Math.PI) / 180

    const d1 = m * z1
    const d2 = m * z2
    const a = d1 / 2 + d2 / 2
    const da1 = d1 + 2 * m
    const da2 = d2 + 2 * m
    const db1 = d1 * Math.cos(alpha)
    const db2 = d2 * Math.cos(alpha)
    const epsilon = (Math.sqrt(da1 ** 2 - db1 ** 2) + Math.sqrt(da2 ** 2 - db2 ** 2) - 2 * a * Math.sin(alpha))
      / (2 * Math.PI * m * Math.cos(alpha))

    const steps = [
      { formula: 'd1 = m·z1', substitution: `${m}×${z1}`, value: round(d1, 4) },
      { formula: 'd2 = m·z2', substitution: `${m}×${z2}`, value: round(d2, 4) },
      { formula: 'a = (d1+d2)/2', substitution: `(${round(d1, 2)}+${round(d2, 2)})/2`, value: round(a, 4) },
      { formula: 'ε_α', substitution: '(√(da1²-db1²)+√(da2²-db2²)-2a·sinα)/(2πm·cosα)', value: round(epsilon, 4) },
    ]

    const checks = []
    const minTeeth = Math.round(2 / Math.sin(alpha) ** 2)
    if (z1 < minTeeth) {
      checks.push({
        name: '根切',
        formula: `z_min = 2/sin²α ≈ ${minTeeth}（α=${round((alpha * 180) / Math.PI, 1)}°）`,
        value: z1,
        passed: false,
        note: `小齿轮 ${z1} 齿低于 ${minTeeth}，标准齿会根切，需要正变位`,
      })
    } else {
      checks.push({ name: '根切', formula: `z_min ≈ ${minTeeth}`, value: z1, passed: true, note: '不根切' })
    }
    if (epsilon < 1.2) {
      checks.push({
        name: '重合度',
        formula: 'ε ≥ 1.2（常用下限）',
        value: round(epsilon, 4),
        passed: epsilon >= 1.2,
        note: epsilon < 1 ? '重合度小于 1：传动会断续，不能这样用' : '重合度偏低，冲击与噪声会变大',
      })
    }

    const result = {
      ratio: round(z2 / z1, 4),
      d1: round(d1, 4),
      d2: round(d2, 4),
      centerDistance: round(a, 4),
      da1: round(da1, 4),
      da2: round(da2, 4),
      df1: round(d1 - 2.5 * m, 4),
      df2: round(d2 - 2.5 * m, 4),
      db1: round(db1, 4),
      db2: round(db2, 4),
      contactRatio: round(epsilon, 4),
      circularPitch: round(Math.PI * m, 4),
    }
    if (inputs.faceWidth !== undefined) result.faceWidth = num(inputs.faceWidth, 'faceWidth')
    const warnings = checks.filter((c) => !c.passed).map((c) => `${c.name}：${c.note}`)
    return { result, steps, checks, warnings }
  },
}

// ---------------------------------------------------------------- 同步带

const belt = {
  id: 'belt',
  title: '同步带传动',
  summary: '按节距、齿数、中心距算节圆直径、传动比、带长与带齿数，并标出中心距可调范围。',
  inputs: { pitch: '节距 mm（例如 3M 是 3）', z1: '小带轮齿数', z2: '大带轮齿数', centerDistance: '中心距 mm', beltTeeth: '带的齿数（可选，用于反算实际中心距）' },
  formulas: [
    '节圆直径：d = p · z / π',
    '传动比：i = z2 / z1',
    '带长：L = 2C + π(d1 + d2)/2 + (d2 - d1)²/(4C)',
    '带齿数：z_belt = L / p',
    '带速：v = π · d1 · n1 / 60000（m/s，n1 单位 rpm）',
  ],
  assumptions: [
    '标准同步带，节线在带背与齿根之间，不考虑张紧伸长。',
    '中心距按给定值算带长；实际安装需要留张紧余量（通常中心距可调 1~2%）。',
  ],
  compute(inputs) {
    const p = num(inputs.pitch, 'pitch')
    const z1 = num(inputs.z1, 'z1')
    const z2 = num(inputs.z2, 'z2')
    const C = num(inputs.centerDistance, 'centerDistance')
    const d1 = (p * z1) / Math.PI
    const d2 = (p * z2) / Math.PI
    const L = 2 * C + (Math.PI * (d1 + d2)) / 2 + (d2 - d1) ** 2 / (4 * C)
    const beltTeethExact = L / p
    const steps = [
      { formula: 'd = p·z/π', substitution: `${p}×${z1}/π`, value: round(d1, 4) },
      { formula: 'd = p·z/π', substitution: `${p}×${z2}/π`, value: round(d2, 4) },
      { formula: 'L = 2C + π(d1+d2)/2 + (d2-d1)²/(4C)', substitution: `2×${C} + π(${round(d1, 2)}+${round(d2, 2)})/2 + …`, value: round(L, 4) },
      { formula: 'z_belt = L/p', substitution: `${round(L, 2)}/${p}`, value: round(beltTeethExact, 4) },
    ]
    const warnings = []
    const result = {
      d1: round(d1, 4),
      d2: round(d2, 4),
      ratio: round(z2 / z1, 4),
      pitchLength: round(L, 4),
      beltTeethExact: round(beltTeethExact, 4),
      beltTeeth: Math.round(beltTeethExact),
      centerDistance: round(C, 4),
    }
    if (inputs.beltTeeth !== undefined) {
      const zb = num(inputs.beltTeeth, 'beltTeeth')
      // 用标准带齿数反算中心距：解 4C² - (2L - π(d1+d2))C - (d2-d1)² = 0
      const Lb = p * zb
      const B = 2 * Lb - Math.PI * (d1 + d2)
      const disc = B ** 2 + 16 * (d2 - d1) ** 2
      const Cactual = (B + Math.sqrt(disc)) / 8
      result.actualBeltTeeth = zb
      result.actualCenterDistance = round(Cactual, 4)
      result.centerDistanceDelta = round(Cactual - C, 4)
      steps.push({
        formula: '4C² - (2L-π(d1+d2))C - (d2-d1)² = 0',
        substitution: `L = ${p}×${zb} = ${round(Lb, 2)}`,
        value: round(Cactual, 4),
      })
      if (Math.abs(Cactual - C) > 0.02 * C) {
        warnings.push(`按标准带齿数 ${zb} 反算的中心距是 ${round(Cactual, 2)} mm，与给定中心距 ${C} mm 差 `
          + `${round(Cactual - C, 2)} mm —— 要么改中心距，要么换带齿数`)
      }
    }
    steps.push({
      formula: 'v = π·d1·n1/60000',
      substitution: '需要 n1（rpm）',
      value: '未给转速，未计算带速',
    })
    return { result, steps, checks: [], warnings }
  },
}

// ------------------------------------------------------------------- 轴承

const bearing = {
  id: 'bearing',
  title: '滚动轴承寿命（ISO 281 基本额定寿命）',
  summary: 'L10 = (C/P)^p × 10⁶ 转，换成小时数；标出是否低于常用下限。',
  inputs: { C: '基本额定动载荷 N', P: '当量动载荷 N', speed: '转速 rpm', exponent: '寿命指数（球 3，滚子 10/3，默认 3）' },
  formulas: [
    'L10 = (C / P)^p × 10⁶ 转',
    'L10h = L10 / (60 · n) 小时',
    'P 需要按 Fa/Fr 算当量动载荷，这里直接收 P',
  ],
  assumptions: [
    '只算基本额定寿命，不含可靠度修正 a1、材料修正 aISO、润滑与污染修正。',
    'P 必须由用户按当量动载荷公式给出（深沟球 P = XFr + YFa，X/Y 查表）。',
    '没有算静载荷 C0 / 极限转速 / 启动冲击。',
  ],
  compute(inputs) {
    const C = num(inputs.C, 'C')
    const P = num(inputs.P, 'P')
    const speed = num(inputs.speed, 'speed')
    const p = inputs.exponent === undefined ? 3 : num(inputs.exponent, 'exponent')
    if (P <= 0) throw new CodeError('BAD_ARGUMENT', 'P 必须大于 0')
    const ratio = C / P
    const revolutions = ratio ** p * 1e6
    const hours = revolutions / (60 * speed)
    const steps = [
      { formula: 'C/P', substitution: `${C}/${P}`, value: round(ratio, 4) },
      { formula: 'L10 = (C/P)^p × 10⁶', substitution: `${round(ratio, 3)}^${p} × 10⁶`, value: round(revolutions, 4) },
      { formula: 'L10h = L10/(60n)', substitution: `${round(revolutions, 0)}/(60×${speed})`, value: round(hours, 4) },
    ]
    const warnings = []
    if (hours < 1000) warnings.push(`L10h = ${round(hours, 1)} h 低于 1000 h —— 这个载荷对这只轴承太重`)
    if (ratio < 1) warnings.push('P 大于 C：当量动载荷超过额定值，寿命公式已经不可信')
    return {
      result: { dynamicLoadRating: C, equivalentLoad: P, revolutions: round(revolutions, 0), hours: round(hours, 2), exponent: p },
      steps,
      checks: [],
      warnings,
    }
  },
}

// ------------------------------------------------------------------- 弹簧

const spring = {
  id: 'spring',
  title: '圆柱压缩弹簧',
  summary: '按线径、中径、有效圈数算刚度、旋绕比、Wahl 修正后的切应力与压并高度。',
  inputs: { wire: '线径 d mm', meanDiameter: '中径 D mm', activeCoils: '有效圈数 n', freeLength: '自由长度 mm（可选）', load: '工作载荷 N（可选）', shearModulus: '切变模量 MPa（默认 79000，钢）' },
  formulas: [
    '旋绕比：C = D / d',
    '刚度：k = G·d⁴ / (8·D³·n)',
    'Wahl 修正：K_w = (4C - 1)/(4C - 4) + 0.615/C',
    '切应力：τ = K_w · 8FD / (π d³)',
    '压并高度：H_s = (n + 2) · d（两端各一圈并紧）',
  ],
  assumptions: [
    '两端并紧磨平，总圈数 = 有效圈数 + 2。',
    '只算静态刚度与切应力，不含疲劳寿命、失稳（细长比）、共振频率。',
    'G 默认取钢 79000 MPa；不锈钢约 71000，磷青铜约 41000。',
  ],
  compute(inputs) {
    const d = num(inputs.wire, 'wire')
    const D = num(inputs.meanDiameter, 'meanDiameter')
    const n = num(inputs.activeCoils, 'activeCoils')
    const G = inputs.shearModulus === undefined ? 79000 : num(inputs.shearModulus, 'shearModulus')
    const C = D / d
    const k = (G * d ** 4) / (8 * D ** 3 * n)
    const kw = (4 * C - 1) / (4 * C - 4) + 0.615 / C
    const solidHeight = (n + 2) * d

    const steps = [
      { formula: 'C = D/d', substitution: `${D}/${d}`, value: round(C, 4) },
      { formula: 'k = G·d⁴/(8·D³·n)', substitution: `${G}×${d}⁴/(8×${D}³×${n})`, value: round(k, 4) },
      { formula: 'K_w', substitution: `(4×${round(C, 2)}-1)/(4×${round(C, 2)}-4)+0.615/${round(C, 2)}`, value: round(kw, 4) },
      { formula: 'H_s = (n+2)·d', substitution: `(${n}+2)×${d}`, value: round(solidHeight, 4) },
    ]

    const result = { index: round(C, 3), rate: round(k, 4), wahlFactor: round(kw, 4), solidHeight: round(solidHeight, 4) }
    if (inputs.load !== undefined) {
      const F = num(inputs.load, 'load')
      const tau = (kw * 8 * F * D) / (Math.PI * d ** 3)
      const deflection = F / k
      result.load = F
      result.shearStress = round(tau, 3)
      result.deflection = round(deflection, 4)
      if (inputs.freeLength !== undefined) {
        const L0 = num(inputs.freeLength, 'freeLength')
        result.workingLength = round(L0 - deflection, 4)
        result.clearanceToSolid = round(L0 - deflection - solidHeight, 4)
        steps.push({ formula: 'δ = F/k', substitution: `${F}/${round(k, 3)}`, value: round(deflection, 4) })
        steps.push({ formula: 'τ = K_w·8FD/(πd³)', substitution: `…`, value: round(tau, 3) })
      }
    }

    const warnings = []
    if (C < 4) warnings.push(`旋绕比 C = ${round(C, 2)} 小于 4：卷制困难，应力集中严重`)
    if (C > 16) warnings.push(`旋绕比 C = ${round(C, 2)} 大于 16：弹簧过软，容易失稳`)
    return { result, steps, checks: [], warnings }
  },
}

// ------------------------------------------------------------------- 螺纹

const thread = {
  id: 'thread',
  title: '公制螺纹（ISO 68-1 / ISO 724）',
  summary: '按公称直径与螺距算中径、小径、应力截面积与推荐拧紧扭矩。',
  inputs: { diameter: '公称直径 mm（例如 M8 填 8）', pitch: '螺距 mm（粗牙 M8 是 1.25）', propertyClass: '性能等级 8.8 / 10.9 / 12.9（可选）', friction: '摩擦系数（默认 0.14）' },
  formulas: [
    '中径：d2 = d - 0.6495·P',
    '小径：d3 = d - 1.2269·P',
    '应力截面积：As = π/4 · (d - 0.9382·P)²',
    '拧紧扭矩：T = F · (0.16·P + 0.58·d2·μ)（F 为预紧力）',
    '预紧力（0.7 倍屈服）：F = 0.7 · σ_y · As',
  ],
  assumptions: [
    '按 ISO 724 的基本尺寸，不含公差带（6g/6H 的上下偏差要查表）。',
    '拧紧扭矩按 0.7 倍屈服的预紧力估算，实际装配要按摩擦系数与润滑状态修正。',
    '没有做螺纹强度校核（剪切、挤压、疲劳）。',
  ],
  compute(inputs) {
    const d = num(inputs.diameter, 'diameter')
    const P = num(inputs.pitch, 'pitch')
    const d2 = d - 0.6495 * P
    const d3 = d - 1.2269 * P
    const As = (Math.PI / 4) * (d - 0.9382 * P) ** 2
    const steps = [
      { formula: 'd2 = d - 0.6495P', substitution: `${d} - 0.6495×${P}`, value: round(d2, 4) },
      { formula: 'd3 = d - 1.2269P', substitution: `${d} - 1.2269×${P}`, value: round(d3, 4) },
      { formula: 'As = π/4·(d-0.9382P)²', substitution: `π/4×(${d}-0.9382×${P})²`, value: round(As, 4) },
    ]

    const result = { nominal: d, pitch: P, pitchDiameter: round(d2, 4), minorDiameter: round(d3, 4), stressArea: round(As, 4) }
    const warnings = []

    const grades = { '8.8': 640, '10.9': 940, '12.9': 1100, '4.8': 340, '5.8': 420 }
    if (inputs.propertyClass !== undefined) {
      const grade = String(inputs.propertyClass)
      const yieldStrength = grades[grade]
      if (!yieldStrength) {
        warnings.push(`性能等级 ${grade} 不在内置表里（支持 ${Object.keys(grades).join('/')}），没有算预紧力`)
      } else {
        const mu = inputs.friction === undefined ? 0.14 : num(inputs.friction, 'friction')
        const F = 0.7 * yieldStrength * As
        const T = (F * (0.16 * P + 0.58 * d2 * mu)) / 1000
        result.propertyClass = grade
        result.yieldStrength = yieldStrength
        result.preload = round(F, 1)
        result.tighteningTorque = round(T, 3)
        steps.push({ formula: 'F = 0.7·σy·As', substitution: `0.7×${yieldStrength}×${round(As, 2)}`, value: round(F, 1) })
        steps.push({ formula: 'T = F(0.16P + 0.58·d2·μ)', substitution: `μ=${mu}`, value: round(T, 3) })
      }
    }
    return { result, steps, checks: [], warnings }
  },
}

// ------------------------------------------------------------------- 轴

const shaft = {
  id: 'shaft',
  title: '轴的扭转与弯曲',
  summary: '按扭矩/弯矩算实心轴的名义切应力、弯曲应力与安全系数，或反算所需直径。',
  inputs: {
    torque: '扭矩 N·m（可选）',
    bendingMoment: '弯矩 N·m（可选）',
    diameter: '轴径 mm（给了就校核，不给就按许用应力反算）',
    allowableShear: '许用切应力 MPa（默认 40，45 钢调质约这个量级）',
    allowableBending: '许用弯曲应力 MPa（可选）',
  },
  formulas: [
    '扭转切应力：τ = 16T/(πd³)',
    '弯曲正应力：σ = 32M/(πd³)',
    '按第四强度理论合成：σ_eq = √(σ² + 3τ²)',
    '反算轴径：d = ∛(16T/(π·τ_allow))',
  ],
  assumptions: [
    '实心圆轴，不考虑键槽（键槽会削弱截面，通常按 1.05~1.1 倍直径补偿）、台阶圆角与表面质量。',
    '许用应力是经验值；疲劳工况要按应力集中系数与疲劳极限另算。',
  ],
  compute(inputs) {
    const T = inputs.torque === undefined ? 0 : num(inputs.torque, 'torque')
    const M = inputs.bendingMoment === undefined ? 0 : num(inputs.bendingMoment, 'bendingMoment')
    const tauAllow = inputs.allowableShear === undefined ? 40 : num(inputs.allowableShear, 'allowableShear')
    if (T === 0 && M === 0) throw new CodeError('BAD_ARGUMENT', 'torque 与 bendingMoment 至少要给一个')

    const steps = []
    const result = {}
    if (inputs.diameter !== undefined) {
      const d = num(inputs.diameter, 'diameter')
      const tau = T === 0 ? 0 : (16 * T * 1000) / (Math.PI * d ** 3)
      const sigma = M === 0 ? 0 : (32 * M * 1000) / (Math.PI * d ** 3)
      const equivalent = Math.sqrt(sigma ** 2 + 3 * tau ** 2)
      result.diameter = d
      result.shearStress = round(tau, 3)
      result.bendingStress = round(sigma, 3)
      result.equivalentStress = round(equivalent, 3)
      // 用同一个许用值当分母，只是给一个量级；真正的判据是下面那条 warning。
      result.safetyFactor = round(tauAllow / Math.max(equivalent, 1e-9), 3)
      steps.push({ formula: 'τ = 16T/(πd³)', substitution: `16×${T * 1000}/(π×${d}³)`, value: round(tau, 3) })
      if (M > 0) steps.push({ formula: 'σ = 32M/(πd³)', substitution: `32×${M * 1000}/(π×${d}³)`, value: round(sigma, 3) })
      steps.push({ formula: 'σ_eq = √(σ²+3τ²)', substitution: '', value: round(equivalent, 3) })
    } else {
      const dRequired = T > 0 ? Math.cbrt((16 * T * 1000) / (Math.PI * tauAllow)) : 0
      result.requiredDiameter = round(dRequired, 3)
      steps.push({ formula: 'd = ∛(16T/(π·τ_allow))', substitution: `∛(16×${T * 1000}/(π×${tauAllow}))`, value: round(dRequired, 3) })
    }

    const warnings = []
    if (result.shearStress !== undefined && result.shearStress > tauAllow) {
      warnings.push(`切应力 ${result.shearStress} MPa 超过许用 ${tauAllow} MPa`)
    }
    return { result, steps, checks: [], warnings }
  },
}

// ------------------------------------------------------------------- 花键

const spline = {
  id: 'spline',
  title: '矩形花键（GB/T 1144 轻/中系列）',
  summary: '按齿数、小径、大径算承载面积与平均切应力。',
  inputs: { teeth: '齿数 z', minorDiameter: '小径 d mm', majorDiameter: '大径 D mm', length: '配合长度 L mm', torque: '扭矩 N·m' },
  formulas: [
    '平均半径：r_m = (d + D) / 4',
    '承载齿高：h = (D - d) / 2',
    '切应力：τ = T / (0.25 · z · h · L · r_m)（按 1/4 齿面参与承载的保守假设）',
  ],
  assumptions: [
    '按 1/4 的齿面均载（花键实际载荷分布不均，常用 0.25 的系数）。',
    '只算挤压/剪切的名义值，不含磨损与疲劳。',
  ],
  compute(inputs) {
    const z = num(inputs.teeth, 'teeth')
    const d = num(inputs.minorDiameter, 'minorDiameter')
    const D = num(inputs.majorDiameter, 'majorDiameter')
    const L = num(inputs.length, 'length')
    const T = num(inputs.torque, 'torque')
    const rm = (d + D) / 4
    const h = (D - d) / 2
    const tau = (T * 1000) / (0.25 * z * h * L * rm)
    return {
      result: { teeth: z, meanRadius: round(rm, 3), toothHeight: round(h, 3), shearStress: round(tau, 3), torque: T },
      steps: [
        { formula: 'r_m = (d+D)/4', substitution: `(${d}+${D})/4`, value: round(rm, 3) },
        { formula: 'h = (D-d)/2', substitution: `(${D}-${d})/2`, value: round(h, 3) },
        { formula: 'τ = T/(0.25·z·h·L·r_m)', substitution: `${T * 1000}/(0.25×${z}×${round(h, 2)}×${L}×${round(rm, 2)})`, value: round(tau, 3) },
      ],
      checks: [],
      warnings: [],
    }
  },
}

export const CALCULATORS = [planetary, spur, belt, bearing, spring, thread, shaft, spline]

export function listCalculators() {
  return CALCULATORS.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    inputs: c.inputs,
    formulas: c.formulas,
    assumptions: c.assumptions,
  }))
}

export function runCalculator(id, inputs) {
  const calculator = CALCULATORS.find((c) => c.id === id)
  if (!calculator) {
    throw new CodeError('UNKNOWN_CALCULATOR', `没有叫 ${id} 的计算器`, {
      available: CALCULATORS.map((c) => c.id),
    })
  }
  const payload = inputs && typeof inputs === 'object' ? inputs : {}
  return calculator.compute(payload)
}
