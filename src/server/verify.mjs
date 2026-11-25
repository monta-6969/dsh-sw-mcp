// 语义核对：把「图纸上的一个标注」变成「模型里的一个数」再比。
//
// 这里刻意不用体积和包围盒当验收依据。体积对得上只说明画的是一个实心件，
// 说明不了孔在正确的高度、槽的圆心距是对的、筋是 3 厚不是 4 厚。那些只能
// 逐条量。每一条核对都记下它取了哪个数（pick）、实测多少，方便回看是不是
// 量错了对象而不是建错了。
//
// ---------------------------------------------------------------------------
// 前提（本文件及所有 measure 调用点共用）：桥接器对文档归属的两种解析
// ---------------------------------------------------------------------------
//   · RequireDesignDocument  —— capture / inspect / save / export / edit / sketchGeometry
//                              不带 designId 直接 **DESIGN_ID_REQUIRED**，不会猜。
//   · OptionalDesignDocument —— measure 的六个 kind（holes/cylinders/planes/axis/
//                              spacing/distance）与 faces/edges/bodies/select：
//                              **给了 designId 就按登记找文档，没给就 ActiveDocOrThrow()
//                              即「前台那份」**（Operations.cs:348-359）。
//
// 第二类是这一整类 bug 的根源：调 measure 而不传 designId **不会报错，只会静默量错
// 文档**。多开一个零件，量到的就是别人，而回包里的数字看起来完全合理 —— 实测后板
// verify 拿到 actual=8 / 392，正是旁边那份底板的 Y 厚与 Z 长，报告却只写「尺寸不符」。
// 所以：凡是要 measure 的地方，designId 必须是硬参数，不允许省略后退回前台文档。

/** 从对象里按 "a.b[0].c" 取一个值。取不到返回 undefined，不抛。 */
export function pickPath(object, path) {
  if (!path) return object
  let current = object
  for (const rawPart of String(path).split('.')) {
    if (current === null || current === undefined) return undefined
    const part = rawPart.trim()
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part)
    if (!match) return undefined
    const [, name, brackets] = match
    if (name) current = current[name]
    if (brackets) {
      for (const indexText of brackets.match(/\[\d+\]/g) ?? []) {
        const index = Number(indexText.slice(1, -1))
        if (!Array.isArray(current)) return undefined
        current = current[index]
      }
    }
  }
  return current
}

/** 每种测量「最常被问的那个数」是什么。写死在这里，是为了让省略 pick 时
 *  的默认值和真正常用的问法一致，而不是随手取第一个字段。 */
const DEFAULT_PICK = {
  axis: 'matches[0].diameter',
  spacing: 'pairs[0].distance',
  distance: 'distance',
  holes: 'count',
  cylinders: 'count',
  planes: 'count',
}

export function defaultPick(kind) {
  return DEFAULT_PICK[kind]
}

export function describeMeasure(result) {
  const kind = result?.kind
  if (kind === 'holes') return `找到 ${result.count} 个孔（圆柱面 ${result.cylinderFaces} 个）`
  if (kind === 'cylinders') return `找到 ${result.count} 个圆柱面`
  if (kind === 'planes') return `找到 ${result.count} 张平面`
  if (kind === 'axis') {
    const first = result.matches?.[0]
    return first
      ? `Ø${result.diameter} 的圆柱面 ${result.count} 个；第一个轴线高 `
        + `${result.heightAboveMinY?.[0]?.heightAboveMinY ?? '?'} mm（相对最低点）`
      : `没有 Ø${result.diameter} 的圆柱面`
  }
  if (kind === 'spacing') {
    const pairs = result.pairs ?? []
    return `${result.count} 个圆柱面，${pairs.length} 对轴线距离`
      + (pairs.length ? `，第一对 ${pairs[0].distance} mm` : '')
  }
  if (kind === 'distance') return `距离 ${result.distance} mm（沿 ${result.along}）`
  if (kind === 'faces') return `${result.count} 张面`
  return '测量完成'
}

export function measureHints(result) {
  const kind = result?.kind
  if (kind === 'axis' && (result.count ?? 0) === 0) {
    return [
      `没有直径 ${result.diameter} 的圆柱面：先 inspect action=measure kind="cylinders" 看实际有哪些直径`,
      '如果这个孔是用矩形切除做的，它不是圆柱面，得改成圆形草图才能量到',
    ]
  }
  if (kind === 'spacing' && (result.count ?? 0) < 2) {
    return ['要量两个孔的间距，至少得有两个同径圆柱面；先用 kind="holes" 看清单']
  }
  if (kind === 'holes' && (result.count ?? 0) === 0) {
    return ['没有识别到孔。检查孔的草图是不是圆、切除是不是真的切出了圆柱面']
  }
  return []
}

/** 这次回包里到底有哪些直径可选 —— 「量不到」时唯一能救场的指路。
 *
 * 三种 measure 把直径放在三个不同的地方，只读其中一个必然有一半场景是空提示：
 *   · kind="axis"      → available.diameters（轴/凸台按直径筛过之后的全量清单）
 *   · kind="holes"     → breakdown.diameters（孔按通孔/盲孔分组时顺手记下的直径字符串）
 *   · kind="cylinders" → 既没有 available 也没有 breakdown，只有 cylinders[].diameter
 * 所以这里把三处合并、按数值去重排序。都拿不到就返回空数组，让调用方自己说
 * 「没有可用候选」，而不是给一句前后都空的「该零件上的圆柱面直径有 。」
 */
export function candidateDiameters(result) {
  const found = []
  const take = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      const value = typeof item === 'number' ? item : Number(item)
      if (Number.isFinite(value)) found.push(value)
    }
  }
  take(result?.available?.diameters)
  take(result?.breakdown?.diameters)
  for (const key of ['holes', 'cylinders', 'matches']) {
    for (const row of Array.isArray(result?.[key]) ? result[key] : []) take([row?.diameter])
  }
  return [...new Set(found)].sort((a, b) => a - b)
}

/** 取一条核对的实测值。
 *
 * 孔数量默认只数**通孔**。实测：一个锁盖有 2×Ø5 通孔 + 2×Ø18 沉头 + Ø14 + Ø30，
 * 直接数圆柱面得 6，而调用方要的「2 个螺栓孔」永远对不上 —— 那次验收因此判了
 * 「不符 1 条」，其实双方说的是两件事。要数全部圆柱面就写 args.all=true，
 * 只想数盲孔写 args.through=false。
 *
 * 其余情况照旧按 pick 路径取值。
 */
export function measureValue(result, spec, path) {
  if (spec?.measure === 'holes' && /(^|\.)count$/.test(path)) {
    const breakdown = result?.breakdown
    if (breakdown !== null && typeof breakdown === 'object') {
      if (spec?.args?.all === true) return result?.count
      if (spec?.args?.through === false) return breakdown.blind
      return breakdown.through
    }
  }
  return pickPath(result, path)
}

/** 这条核对要量哪一份文档。
 *
 * 为什么必须有：桥接器的 measure 把 designId 当**可选**参数（Operations.cs
 * OptionalDesignDocument）—— 不带就量「前台那份」。verify 在 4121/4142 逐条跑
 * expect.checks[] 时以前没往下传，于是同一份回包里出现两种数字：
 *   boundingBox（走 4021，带 designId）   → [386,130,8] 对的
 *   高130 / 厚8（走 runCheck，不带）      → actual=8 / 392  量到的是**另一份文档**
 * 实测那两个数正是底板的 Y 厚与 Z 长。多零件工作流里从第二件开始就静默量错，
 * 而且回的是看起来合理的假数字 —— 所以 designId 从这里开始是硬参数。
 *
 * 单个 spec 写 designId 可以显式覆盖（确有「这条要量别的文档」的场景）。
 * spec.args.designId 也算覆盖：以前它会被 `...args` 原样带进 measure 请求，
 * 所以已经有调用方靠它指定文档 —— 这条老路必须继续生效，只是现在要经过同一道校验。
 * 优先级：spec.designId > spec.args.designId > runCheck 的 designId 参数。
 */
export function resolveCheckDesignId(spec, designId) {
  const sources = [
    ['spec.designId', spec?.designId],
    ['spec.args.designId', spec?.args?.designId],
  ]
  for (const [source, value] of sources) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (value !== undefined && value !== null) {
      throw Object.assign(
        new Error(`expect.checks[] 的 ${source} 必须是字符串，收到 ${JSON.stringify(value)}`),
        { code: 'BAD_ARGUMENT' },
      )
    }
  }
  const given = typeof designId === 'string' ? designId.trim() : ''
  if (given.length === 0) {
    // 不静默退回「量前台那份」：那正是这个 bug。要量前台就显式写 designId。
    throw Object.assign(
      new Error('runCheck 缺少 designId：核对的测量必须指定是哪一份文档，不会退回「前台那份」'
        + '（多开一个零件就会量到别人身上）。调用方传 designId，或在 spec 里写 designId。'),
      { code: 'DESIGN_ID_REQUIRED' },
    )
  }
  return given
}

/**
 * 跑一条核对。
 * @param {object} spec  {name, measure, args, pick, expect, tol, any, candidates, designId}
 * @param {(op:string, req:object)=>Promise<object>} callBridge
 * @param {string} designId 量哪一份文档。spec.designId 可覆盖它。
 */
export async function runCheck(spec, callBridge, designId) {
  const kind = spec?.measure ?? 'axis'
  // designId 必须在 try 之外解析：它缺失是**调用方的编程错误**，不是「测量没跑起来」，
  // 不能和桥接器故障混成同一条 unmeasured 记录。
  const targetDesignId = resolveCheckDesignId(spec, designId)
  // designId 放最后：解析出来的那一个永远说了算，args 里那个不会偷偷盖掉它。
  const request = { kind, ...(spec?.args ?? {}), designId: targetDesignId }
  let result
  try {
    result = await callBridge('measure', request)
  } catch (error) {
    return {
      name: spec?.name ?? kind,
      status: 'unmeasured',
      pass: false,
      measure: kind,
      args: spec?.args ?? {},
      designId: targetDesignId,
      reason: 'MEASURE_FAILED',
      error: { code: error?.code ?? 'MEASURE_FAILED', message: error?.message ?? String(error) },
      note: '测量本身没跑起来 —— 这条既不算通过，也不算尺寸不对',
    }
  }

  const tol = typeof spec?.tol === 'number' ? spec.tol : 0.02
  // designId 进记录：报告里能看出这一条量的是哪份文档，量错了不用再从对话里倒推。
  const record = { name: spec?.name ?? kind, measure: kind, args: spec?.args ?? {}, designId: targetDesignId, tolerance: tol }

  if (spec?.any) {
    const list = pickPath(result, spec.candidates ?? 'pairs') ?? []
    const values = (Array.isArray(list) ? list : [])
      .map((item) => (typeof item === 'number' ? item : pickPath(item, spec.pick ?? 'distance')))
      .filter((v) => typeof v === 'number')
    const hit = values.find((v) => Math.abs(v - spec.expect) <= tol)
    return {
      ...record,
      status: hit !== undefined ? 'pass' : (values.length === 0 ? 'unmeasured' : 'fail'),
      pass: hit !== undefined,
      expected: spec.expect,
      actual: hit ?? values,
      candidates: values,
      note: hit === undefined
        ? (values.length === 0
          ? '候选集合是空的 —— 没量成，不是尺寸不对'
          : `候选值里没有落在 ${spec.expect}±${tol} 的；实测 ${values.join(', ')}`)
        : undefined,
    }
  }

  // 「取第一个」在有多条候选时是个猜测。同直径的两个孔、四条边两两配对的距离，
  // 都有多个候选；取 [0] 会把「孔径对了」变成「这条也对了」，而那只是巧合。
  // 想用第一条就写 allowFirst:true，或者用 index 指定第几条。
  const basePath = spec?.pick ?? defaultPick(kind)
  const path = typeof spec?.index === 'number'
    ? basePath.replace(/\[0\]/, `[${spec.index}]`)
    : basePath
  const listName = /matches\[/.test(basePath) ? 'matches' : /pairs\[/.test(basePath) ? 'pairs' : null
  const list = listName === null ? [] : (Array.isArray(result?.[listName]) ? result[listName] : [])
  if (list.length > 1 && typeof spec?.index !== 'number' && spec?.allowFirst !== true) {
    return {
      ...record,
      status: 'unmeasured',
      pass: false,
      expected: spec?.expect,
      actual: undefined,
      pick: basePath,
      reason: 'AMBIGUOUS_MATCH',
      candidates: list.slice(0, 12),
      note: `${listName} 有 ${list.length} 条候选，取第一条不足以说明就是这条。`
        + ' 用 args 把直径/轴线高/所属区域限定到一条，或用 index 指定第几条，或写 allowFirst:true 表示接受第一条。',
    }
  }
  const actual = measureValue(result, spec, path)
  if (typeof actual !== 'number') {
    // 「量不到」不是「不对」。把两者混成一个 pass:false，会让模型去改一个本来
    // 正确的特征 —— 实测代价：4 条假失败（Ø11,1 凸台、R3,4 圆角柱面）全部源于
    // measure 默认只匹配孔，matches 为空，pick 取到 undefined。
    const diameters = candidateDiameters(result)
    return {
      ...record,
      status: 'unmeasured',
      pass: false,
      expected: spec?.expect,
      actual: undefined,
      pick: path,
      available: result?.available ?? null,
      reason: 'NO_MEASUREMENT',
      note: `按 ${path} 没取到数 —— 这不是尺寸不对，是这次没量成。`
        + (diameters.length
          ? ` 该零件上的圆柱面直径有 ${diameters.join(', ')}。`
          : ' 这次回包没有可用候选直径（没有可用候选）—— 先确认这个零件上到底有没有可识别的圆柱面，再看 measure 的 kind 写对没有。')
        + ' 先确认直径写对，再看 hole/boss 过滤。',
    }
  }
  const pass = typeof spec?.expect !== 'number'
    ? (typeof spec?.min === 'number' ? actual >= spec.min : undefined)
    : Math.abs(actual - spec.expect) <= tol
  return {
    ...record,
    status: pass === true ? 'pass' : (pass === false ? 'fail' : 'unmeasured'),
    pass: pass === true,
    expected: typeof spec?.expect === 'number' ? spec.expect : (typeof spec?.min === 'number' ? `≥${spec.min}` : undefined),
    actual,
    delta: typeof spec?.expect === 'number' ? Number((actual - spec.expect).toFixed(4)) : undefined,
    pick: path,
  }
}

/** 把核对结果分成三类：通过、量到了但不对、没量成。
 *
 * 以前只有 pass/fail 两种，于是「测量没跑起来」「pick 指错字段」都被算成「尺寸不对」，
 * 汇总行把它们和真失败混在一起，读报告的人无法分辨该改模型还是该改查询。
 */
/** 几何回包 → 可判定读数（验收看这些数字，不是看 ok）。
 *  缺失项一律 null：0 是量到的值，null 才是没量成 —— 两者混了就分不清「没有孔」
 *  和「孔数没读到」。tiers 是逐档检查行，原样带 expected/actual。 */
export function geometryReadouts(geometry, tiers = []) {
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)
  return {
    volumeMm3: finite(geometry?.massProperties?.volume),
    bodies: finite(geometry?.bodies),
    boundingBoxMm: Array.isArray(geometry?.boundingBox?.size) ? geometry.boundingBox.size.map(finite) : null,
    faceCount: finite(geometry?.faces),
    holes: Array.isArray(geometry?.holes) ? geometry.holes.length : null,
    holeDiameters: Array.isArray(geometry?.holes) ? geometry.holes.map((hole) => finite(hole?.diameter)) : null,
    components: finite(geometry?.components ?? geometry?.componentCount),
    interference: geometry?.interference ?? null,
    tiers: (Array.isArray(tiers) ? tiers : []).map((row) => ({
      name: row?.name ?? null, status: row?.status ?? null, expected: row?.expected ?? null, actual: row?.actual ?? null,
    })),
    units: { volume: 'mm3', length: 'mm' },
  }
}

export function tallyChecks(checks) {  const counts = { pass: 0, fail: 0, unmeasured: 0 }
  for (const c of checks ?? []) {
    const status = c?.status ?? (c?.pass ? 'pass' : 'fail')
    if (status === 'pass') counts.pass++
    else if (status === 'unmeasured') counts.unmeasured++
    else counts.fail++
  }
  return counts
}
