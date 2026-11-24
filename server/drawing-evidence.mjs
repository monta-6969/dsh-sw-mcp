// 图纸解释包（drawing evidence）的读取与校验。
//
// 为什么要有这个东西：读图这一步以前只活在对话框里 —— 模型看了一眼图，说「这里是 225」，
// 然后按自己说的 225 建模，再用 225 去核对 225。整条链唯一的见证者就是它自己。
// 把读图结果落到一份有结构、有指向、能被机器检查的文件里，才有资格谈「独立核对」：
// 每个数字都得说清它属于哪个视图、锚在什么上；每张视图都得说清是从哪个方向看的；
// 每个特征都得说清它由哪几个数字决定。
//
// v3 补的正是「空间」这一层：以前只有「视图 id + 锚点」，但「前视图」三个字并不能
// 唯一确定三维操作 —— 观察方向、画面右侧是哪个轴、画面向上是哪个轴，缺一条就可能
// 把镜像当成正确答案。剖切同样需要平面、保留侧、观察方向三件套。
//
// 校验只做「能不能被追溯」这一件事，不判断尺寸对不对 —— 那要靠实测几何与独立审查。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const EVIDENCE_SCHEMA_VERSION = 3

const BLOCKING = new Set([
  'PROJECTION_UNKNOWN',
  'VIEW_UNMAPPED',
  'VIEW_NO_DIRECTION',
  'FRAME_UNKNOWN',
  'FRAME_NO_MODEL_MAP',
  'CUT_UNDEFINED',
  'DIM_NO_ANCHOR',
  'DIM_NO_VALUE',
  'CHAIN_BROKEN',
  'FEATURE_NO_SOURCE',
  'CHECK_NO_SOURCE',
])

const AXES = new Set(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])

function push(list, code, message, where) {
  list.push({ code, message, where, blocking: BLOCKING.has(code) })
}

function isAxis(value) {
  return typeof value === 'string' && AXES.has(value.trim().toUpperCase())
}

/** 校验一份图纸解释包。返回 errors（能追溯到就通过）与 notes（提示，不挡）。 */
export function validateDrawing(doc) {
  const errors = []
  const notes = []

  if (!doc || typeof doc !== 'object') {
    push(errors, 'DRAWING_INVALID', '不是一份图纸解释包', '$')
    return { errors, notes, ok: false }
  }

  // ── 坐标系：零件坐标与模型坐标的对应关系。没有它，「+Y」到底指深度还是高度全靠猜。
  // 允许两种写法：零件轴写在 coordinateSystem 顶层，或写在 coordinateSystem.part 里。
  const frame = doc.coordinateSystem
  const partAxes = frame?.part ?? frame
  if (!partAxes || !isAxis(partAxes.xAxis) || !isAxis(partAxes.yAxis) || !isAxis(partAxes.zAxis)) {
    push(errors, 'FRAME_UNKNOWN',
      '没有定零件坐标系（coordinateSystem.xAxis/yAxis/zAxis）。零件用右手系 X 向右、Y 向后、Z 向上，'
      + 'SolidWorks 用 X 向右、Y 向上、Z 向前；不说清哪根轴对哪根，读出来的方向就是自说自话',
      'coordinateSystem')
  } else {
    // T_model_from_part：零件轴到 SolidWorks 世界轴的映射。没有它，读图得到的
    // 「+Y 是向后」在建模时会被当成「+Y 是向上」—— 这正是镜像与翻面错误的来源。
    const map = frame.partToModel ?? frame.modelFromPart
    if (!map || !isAxis(map.xAxis) || !isAxis(map.yAxis) || !isAxis(map.zAxis)) {
      push(errors, 'FRAME_NO_MODEL_MAP',
        '没有写零件轴到模型轴（coordinateSystem.partToModel: xAxis/yAxis/zAxis）。'
        + '零件 Y 向后、模型 Y 向上，没有这层映射，同一个「+Y」在两处指相反的方向',
        'coordinateSystem.partToModel')
    } else {
      const targets = [map.xAxis, map.yAxis, map.zAxis].map((a) => a.trim().toUpperCase())
      if (new Set(targets.map((a) => a.slice(1))).size !== 3) {
        push(errors, 'FRAME_NO_MODEL_MAP',
          'partToModel 映射到了重复的模型轴：' + targets.join(', '), 'coordinateSystem.partToModel')
      }
    }
    const axes = [partAxes.xAxis, partAxes.yAxis, partAxes.zAxis].map((a) => a.trim().toUpperCase())
    if (new Set(axes.map((a) => a.slice(1))).size !== 3) {
      push(errors, 'FRAME_UNKNOWN', `零件坐标轴不是三个不同方向：${axes.join(', ')}`, 'coordinateSystem')
    }
    if (!(frame.origin ?? partAxes.origin)) {
      notes.push({
        code: 'FRAME_NO_ORIGIN',
        message: '坐标系没写原点（origin）。原点不定时，「底面」这类说法只能靠相对关系推',
        where: 'coordinateSystem.origin',
        blocking: false,
      })
    }
  }

  const rawViews = doc.views ?? []
  const views = new Map()
  for (const view of rawViews) {
    const id = view?.id ?? view?.name
    if (!id) continue
    views.set(id, view)
  }
  if (views.size === 0) push(errors, 'VIEW_UNMAPPED', '一个视图都没有登记，尺寸无从归属', 'views')

  // ── 每张视图：观察方向 + 画面右/上两个轴。缺了这三条，镜像与背面视图无法区分。
  for (const [id, view] of views) {
    // 轴测图/斜二测是立体示意，不是正交投影：它没有唯一的观察方向，
    // 拿它推尺寸或推方位本身就错了，所以只要求它能指回原图区域。
    const pictorial = /iso|axonometric|pictorial|轴测|斜二测|立体/.test(
      (view.kind ?? '') + ' ' + (view.id ?? '') + ' ' + (view.label ?? ''))
    if (pictorial) continue
    const dir = view.viewDirection ?? view.ray
    const right = view.imageRight ?? view.right
    const up = view.imageUp ?? view.up
    if (!isAxis(dir) || !isAxis(right) || !isAxis(up)) {
      push(errors, 'VIEW_NO_DIRECTION',
        `视图 ${id} 没说全观察方向与画面轴向（viewDirection / imageRight / imageUp 都要是 ±X/±Y/±Z）。`
        + `现在是 dir=${dir ?? '空'} right=${right ?? '空'} up=${up ?? '空'}`,
        `views[${id}]`)
    } else {
      const d = dir.trim().toUpperCase()
      const r = right.trim().toUpperCase()
      const u = up.trim().toUpperCase()
      if (r.slice(1) === u.slice(1) || r.slice(1) === d.slice(1) || u.slice(1) === d.slice(1)) {
        push(errors, 'VIEW_NO_DIRECTION',
          `视图 ${id} 的三个方向有重复：dir=${d} right=${r} up=${u}。画面右、画面上、观察方向必须互相垂直`,
          `views[${id}]`)
      }
    }
    if (view.region === undefined) {
      notes.push({
        code: 'VIEW_REGION_MISSING',
        message: `视图 ${id} 没给纸面区域（region，0—1 归一化）。没有区域就没法把「这里不一样」定位回原图`,
        where: `views[${id}].region`,
        blocking: false,
      })
    } else if (!Array.isArray(view.region) || view.region.length !== 4
      || view.region.some((n) => typeof n !== 'number' || n < -0.001 || n > 1.001)) {
      notes.push({
        code: 'VIEW_REGION_INVALID',
        message: `视图 ${id} 的 region 不是 [x0,y0,x1,y1] 且落在 0—1 内`,
        where: `views[${id}].region`,
        blocking: false,
      })
    }
  }

  // ── 剖视：平面、保留侧、观察方向。只写「右边切一刀」不构成三维操作。
  const cuts = new Map()
  for (const cut of doc.cuts ?? []) {
    const id = cut?.id
    if (!id) {
      push(errors, 'CUT_UNDEFINED', '有一条剖切没有 id，剖面视图引不到它', 'cuts[]')
      continue
    }
    cuts.set(id, cut)
    const missing = []
    if (!cut.plane && !cut.planeAt) missing.push('plane/planeAt')
    if (!cut.keep && !cut.keepSide) missing.push('keep/keepSide')
    if (!isAxis(cut.viewDirection ?? cut.ray)) missing.push('viewDirection')
    if (missing.length > 0) {
      push(errors, 'CUT_UNDEFINED',
        `剖切 ${id} 缺 ${missing.join('、')}。剖切要唯一确定「用哪个平面、留哪一侧、朝哪看」`,
        `cuts[${id}]`)
    }
  }
  for (const [id, view] of views) {
    const kind = String(view.kind ?? '').toLowerCase()
    const looksSection = kind.includes('section') || kind.includes('剖')
    if (looksSection) {
      const cutRef = view.cut ?? view.cutId
      if (!cutRef) {
        push(errors, 'CUT_UNDEFINED', `视图 ${id} 标成剖视，但没写它用的是哪条剖切（cut）`, `views[${id}].cut`)
      } else if (!cuts.has(cutRef)) {
        push(errors, 'CUT_UNDEFINED', `视图 ${id} 指向的剖切 "${cutRef}" 没有登记`, `views[${id}].cut`)
      }
    }
  }

  const projection = doc.projection?.kind
  if (projection !== 'first-angle' && projection !== 'third-angle') {
    push(errors, 'PROJECTION_UNKNOWN',
      `投影法没定：${projection ?? '(空)'}。第一角与第三角决定俯视图画在主视图上面还是下面、左视图在右还是左，`
      + '定错了整张图的方位就反了', 'projection.kind')
  } else if (!doc.projection?.why) {
    notes.push({
      code: 'PROJECTION_NO_REASON',
      message: '投影法没写依据。下一轮换一张图时无法复用这条判断',
      where: 'projection.why',
      blocking: false,
    })
  }

  const dims = new Map()
  for (const dim of doc.dimensions ?? []) {
    const id = dim?.id
    if (!id) {
      push(errors, 'DIM_NO_ID', '有一条标注没有 id，后面的引用就没法指向它', 'dimensions[]')
      continue
    }
    dims.set(id, dim)
    if (typeof dim.value !== 'number' || !Number.isFinite(dim.value)) {
      push(errors, 'DIM_NO_VALUE', `标注 ${id} 没有数值`, `dimensions[${id}].value`)
    }
    if (!dim.anchor || String(dim.anchor).trim() === '') {
      push(errors, 'DIM_NO_ANCHOR',
        `标注 ${id} 没说它锚在哪里。数字没有锚点就只能靠记忆解释，换个人看就是另一个意思`,
        `dimensions[${id}].anchor`)
    }
    if (dim.view && !views.has(dim.view)) {
      push(errors, 'VIEW_UNMAPPED', `标注 ${id} 指向视图 "${dim.view}"，但那个视图没有登记`, `dimensions[${id}].view`)
    }
  }

  for (const chain of doc.chains ?? []) {
    const id = chain?.id ?? '(no id)'
    const terms = chain?.terms ?? []
    const missing = terms.filter((t) => typeof t === 'string' && !dims.has(t))
    if (missing.length > 0) {
      push(errors, 'CHAIN_BROKEN', `尺寸链 ${id} 引用了不存在的标注：${missing.join(', ')}`, `chains[${id}].terms`)
      continue
    }
    // 尺寸链不只做加法：`44 = 40 + 4` 是加，`4 = 44 - 40` 是减，两者都是真的。
    // 一律按加法算会把后者判成 84，等于把一条正确的推导当成错误数据。
    const values = terms.map((t) => (typeof t === 'number' ? t : dims.get(t)?.value))
    const op = chain?.op === 'diff' ? 'diff' : 'add'
    const sum = values.length === 0 || values.some((v) => typeof v !== 'number')
      ? NaN
      : op === 'diff'
        ? values.slice(1).reduce((a, b) => a - b, values[0])
        : values.reduce((a, b) => a + b, 0)
    const declared = typeof chain?.sum === 'number' ? chain.sum : undefined
    if (declared !== undefined && Number.isFinite(sum) && Math.abs(sum - declared) > 0.02) {
      push(errors, 'CHAIN_BROKEN',
        `尺寸链 ${id} 按 ${op === 'diff' ? '减法' : '加法'}算得 ${Number(sum.toFixed(4))}，但写的总和是 ${declared}`,
        `chains[${id}].sum`)
    }
  }

  for (const feature of doc.features ?? []) {
    const id = feature?.id ?? '(no id)'
    const from = feature?.from
    if (!Array.isArray(from) || from.length === 0) {
      push(errors, 'FEATURE_NO_SOURCE',
        `特征 ${id} 没说它由哪几条标注决定。只要说不出，它就是一个凭印象画出来的形状`,
        `features[${id}].from`)
      continue
    }
    const unknown = from.filter((d) => typeof d === 'string' && !dims.has(d))
    if (unknown.length > 0) {
      push(errors, 'FEATURE_NO_SOURCE',
        `特征 ${id} 引用了不存在的标注：${unknown.join(', ')}`, `features[${id}].from`)
    }
  }

  for (const check of doc.checks ?? []) {
    const from = check?.from ?? check?.fromDims
    if (Array.isArray(check?.from) && check.from.length === 0) {
      push(errors, 'CHECK_NO_SOURCE', `核对 ${check?.name ?? '(no name)'} 的 from 是空数组`, 'checks[].from')
    } else if (Array.isArray(from)) {
      const unknown = from.filter((d) => typeof d === 'string' && !dims.has(d))
      if (unknown.length > 0) {
        push(errors, 'CHECK_NO_SOURCE',
          `核对 ${check?.name ?? '(no name)'} 指向了不存在的标注：${unknown.join(', ')}`, 'checks[].from')
      }
    }
  }

  // ── 覆盖度：有多少标注真的被某个特征用上了。尺寸读了却没用，是最常见的「看起来做了功课」。
  const usedDims = new Set()
  for (const feature of doc.features ?? []) {
    for (const d of feature?.from ?? []) if (typeof d === 'string') usedDims.add(d)
  }
  const unused = [...dims.keys()].filter((d) => !usedDims.has(d))
  if (dims.size > 0 && unused.length > 0) {
    notes.push({
      code: 'DIM_UNUSED',
      message: `${unused.length} 条标注没有被任何特征引用：${unused.slice(0, 6).join(', ')}。`
        + '读出来的尺寸如果没进模型，它就没有校验作用',
      where: 'features[].from',
      blocking: false,
      unused,
    })
  }

  // 扫描件不是等比图 —— 这条不是错误，是给读的人看的提醒：不能拿像素当毫米。
  const scales = (doc.scaleProof ?? []).map((p) => p?.pxPerMm).filter((v) => typeof v === 'number' && v > 0)
  if (scales.length < 2) {
    notes.push({
      code: 'SCALE_PROOF_MISSING',
      message: '这张图没有逐视图像素标定。不是错误（尺寸本来就该来自标注），但说明这份记录没有验证过「像素能不能当长度」',
      where: 'scaleProof',
      blocking: false,
    })
  }
  if (scales.length >= 2) {
    const min = Math.min(...scales)
    const max = Math.max(...scales)
    if (max / min >= 1.3) {
      notes.push({
        code: 'SCALE_NOT_UNIFORM',
        message: `同一张图里 px/mm 从 ${min.toFixed(2)} 到 ${max.toFixed(2)}（${(max / min).toFixed(2)} 倍），`
          + '像素长度不能当毫米用；尺寸只能来自标注与尺寸链',
        where: 'scaleProof',
        blocking: false,
      })
    }
  }

  const questions = (doc.openQuestions ?? []).filter((q) => typeof q === 'string' && q.trim() !== '')
  const unresolved = (doc.unresolved ?? []).filter((u) => u && (u.need || u.region))
  if (unresolved.length > 0) {
    notes.push({
      code: 'UNRESOLVED_ITEMS',
      message: `${unresolved.length} 处还没辨识（${unresolved.slice(0, 3).map((u) => u.item ?? u.region).join('；')}）。`
        + '这些不是错误，但交付前要给结论：补了哪张视图、或者为什么暂时定不下来',
      where: 'unresolved',
      blocking: false,
      items: unresolved,
    })
  }

  return {
    errors,
    notes,
    ok: errors.length === 0,
    stats: {
      views: views.size,
      dimensions: dims.size,
      chains: (doc.chains ?? []).length,
      features: (doc.features ?? []).length,
      checks: (doc.checks ?? []).length,
      cuts: cuts.size,
      openQuestions: questions.length,
      unresolved: unresolved.length,
      dimensionsUsed: usedDims.size,
      projection: projection ?? null,
    },
    openQuestions: questions,
    unresolved,
    coordinateSystem: frame ?? null,
  }
}

/** 按设计 id 找读图记录：`drawings/<id>/drawing.json`，或调用方给的绝对路径。 */
export function loadDrawing({ repoRoot, designId, path }) {
  const candidates = []
  if (path) candidates.push(resolve(path))
  if (designId) {
    candidates.push(join(repoRoot, 'drawings', designId, 'drawing.json'))
    candidates.push(join(repoRoot, 'drawings', designId, `${designId}.drawing.json`))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, doc: JSON.parse(readFileSync(candidate, 'utf8')) }
    }
  }
  return { path: candidates[0] ?? null, doc: null, tried: candidates }
}

/** 给工具摘要用的一行话。 */
export function describeEvidence(result) {
  if (!result.ok) {
    return `读图记录有 ${result.errors.length} 处不能追溯：${result.errors.slice(0, 3).map((e) => e.code).join(', ')}`
  }
  const s = result.stats
  const q = s.openQuestions > 0 ? `，${s.openQuestions} 处待澄清` : ''
  const u = s.unresolved > 0 ? `，${s.unresolved} 处待辨识` : ''
  return `${s.views} 个视图 / ${s.dimensions} 条标注（引用 ${s.dimensionsUsed}） / ${s.chains} 条尺寸链 / `
    + `${s.features} 个特征 / ${s.cuts} 条剖切${q}${u}`
}
