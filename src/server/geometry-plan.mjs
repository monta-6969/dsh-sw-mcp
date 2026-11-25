// 纯 Node 的草图计划与关系审计。
//
// 这个模块不碰 SOLIDWORKS，也不碰网络：它只看设计定义与标注尺寸，回答一个问题 ——
// 「这份草图现在能不能建、缺什么」。三处共用同一份判定，避免三份实现慢慢漂移：
//   · server.mjs      model action="plan / build output=sketch"
//   · review-gate.js  交付前的确定性关系门禁（不通过就不进入视觉软审查）
//   · test/sketch-plan.mjs
//
// 判定的事实来源只有两类：设计定义（曲线/关系/尺寸）与调用方明确给出的标注尺寸与
// 假设。像素不是尺寸：任何以像素表达的量都进 blockers，绝不做像素→毫米换算。

/** 关系类型白名单。与 contracts/enums.json 的 constraintTypes 保持一致（测试会核对）。 */
export const RELATION_TYPES = [
  'horizontal', 'vertical', 'coincident', 'tangent', 'equal', 'concentric',
  'symmetric', 'parallel', 'perpendicular', 'fix', 'midpoint', 'intersection', 'pierce',
]

/** 这些关系把一个点约束到一条曲线/另一点上，可用来确认「圆心落在弧上」。 */
const POINT_RELATIONS = new Set(['coincident', 'concentric', 'midpoint', 'pierce', 'intersection'])

const DEFAULT_TOL_MM = 0.02

function codeBlock(code, message, detail) {
  return { code, message, ...(detail !== undefined ? { detail } : {}) }
}

function pointOf(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0])
    const y = Number(value[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x)
    const y = Number(value.y)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  return null
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function rad(deg) {
  return (Number(deg) * Math.PI) / 180
}

/** 角度参数可能是度，也可能是弧度；用「是否超出 2π」来判断，别猜错方向。 */
function angleOf(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function arcEndpoints(params) {
  const center = pointOf(params?.center)
  const radius = Number(params?.radius)
  const start = angleOf(params?.startAngle)
  const end = angleOf(params?.endAngle)
  if (!center || !Number.isFinite(radius) || start === null || end === null) return null
  const toRad = (v) => (Math.abs(v) > Math.PI * 2 + 1e-6 ? rad(v) : v)
  return [
    [center[0] + radius * Math.cos(toRad(start)), center[1] + radius * Math.sin(toRad(start))],
    [center[0] + radius * Math.cos(toRad(end)), center[1] + radius * Math.sin(toRad(end))],
  ]
}

function polylinePoints(params) {
  const points = Array.isArray(params?.points) ? params.points.map(pointOf) : []
  return points.some((p) => p === null) ? [] : points
}

/** 一条曲线实体的端点；闭合实体没有端点。返回 [start, end] 或 null。 */
function endpointsOf(entity) {
  const { kind, params } = entity
  if (kind === 'line') {
    const a = pointOf(params?.start)
    const b = pointOf(params?.end)
    return a && b ? [a, b] : null
  }
  if (kind === 'arc') return arcEndpoints(params)
  if (kind === 'polyline' || kind === 'spline') {
    const points = polylinePoints(params)
    if (points.length < 2) return null
    return [points[0], points[points.length - 1]]
  }
  if (kind === 'equationCurve') return null
  return null
}

function isClosedEntity(entity) {
  const { kind, params } = entity
  if (kind === 'circle' || kind === 'ellipse') return true
  if (kind === 'polyline') return params?.closed === true
  if (kind === 'spline') return params?.closed === true
  if (kind === 'equationCurve') {
    const from = Number(params?.variable?.from)
    const to = Number(params?.variable?.to)
    return Number.isFinite(from) && Number.isFinite(to) && Math.abs(from - to) < 1e-9
  }
  return false
}

function centerOf(entity) {
  if (!entity) return null
  if (entity.kind === 'arc' || entity.kind === 'circle' || entity.kind === 'ellipse' || entity.kind === 'ellipticArc') {
    return pointOf(entity.params?.center)
  }
  return null
}

function circleRadius(entity) {
  if (entity.kind === 'circle' || entity.kind === 'arc') {
    const r = Number(entity.params?.radius)
    return Number.isFinite(r) && r > 0 ? r : null
  }
  return null
}

/**
 * 从设计定义里收集所有草图实体与关系。
 *
 * 支持两种写法：
 *   · curves[]     —— line/circle/arc/...，关系写在 feature.relations 或 curve.constraints；
 *   · primitives[] —— legacy rect/circle/polyline/polygon/path/slot/...，视为自洽的坐标式轮廓。
 *
 * primitives 不要求逐条几何关系（它们是原生一次成形的轮廓），但 path 里的弧仍然必须有
 * 圆心 —— 没有圆心的弧到桥接器里只能靠采样，那就退化成折线拟合了。
 */
export function collectSketchEntities(definition) {
  const features = Array.isArray(definition?.features) ? definition.features : []
  const entities = []
  const relations = []
  const blockers = []
  for (const feature of features) {
    if (!feature || feature.kind !== 'sketch') continue
    const featureId = typeof feature.id === 'string' && feature.id.length > 0 ? feature.id : `sketch${entities.length}`
    if (Array.isArray(feature.curves)) {
      feature.curves.forEach((curve, index) => {
        if (!curve || typeof curve !== 'object') return
        const id = typeof curve.id === 'string' && curve.id.length > 0 ? curve.id : `${featureId}#${index}`
        entities.push({
          id,
          kind: String(curve.kind ?? 'unknown'),
          construction: curve.construction === true,
          params: curve.params ?? {},
          dimensions: Array.isArray(curve.dimensions) ? curve.dimensions : [],
          constraints: Array.isArray(curve.constraints) ? curve.constraints : [],
          source: curve.source ?? 'spec',
          featureId,
          primitive: false,
        })
        for (const constraint of curve.constraints ?? []) {
          if (!constraint || typeof constraint.type !== 'string') continue
          relations.push({
            type: String(constraint.type).toLowerCase(),
            refs: Array.isArray(constraint.refs) && constraint.refs.length > 0 ? constraint.refs.map(String) : [id],
            featureId,
            origin: 'constraint',
          })
        }
      })
      for (const relation of Array.isArray(feature.relations) ? feature.relations : []) {
        if (!relation || typeof relation.type !== 'string') continue
        relations.push({
          type: relation.type.toLowerCase(),
          refs: Array.isArray(relation.refs) ? relation.refs.map(String) : [],
          featureId,
          origin: 'relation',
        })
      }
    } else if (Array.isArray(feature.primitives)) {
      feature.primitives.forEach((primitive, index) => {
        if (!primitive || typeof primitive !== 'object') return
        const id = typeof primitive.id === 'string' && primitive.id.length > 0 ? primitive.id : `${featureId}:p${index}`
        entities.push({
          id,
          kind: String(primitive.shape ?? 'primitive'),
          construction: primitive.construction === true,
          params: primitive,
          dimensions: Array.isArray(primitive.dimensions) ? primitive.dimensions : [],
          constraints: [],
          source: 'primitive',
          featureId,
          primitive: true,
        })
      })
    }
  }
  return { features, entities, relations, blockers }
}

function resolveEntityId(ref, entities) {
  if (typeof ref !== 'string' || ref.length === 0) return null
  const direct = entities.find((entity) => entity.id === ref)
  if (direct) return direct.id
  const head = ref.split(':')[0]
  const byHead = entities.find((entity) => entity.id === head)
  return byHead ? byHead.id : null
}

function normalizeRef(ref) {
  return String(ref)
}

function endLabel(ref) {
  return /:(start|end|center)$/.test(ref) ? ref : ref
}

function collectDimensions(entities, extraDimensions) {
  const dimensions = []
  for (const entity of entities) {
    for (const dimension of entity.dimensions ?? []) {
      if (!dimension || typeof dimension !== 'object') continue
      const unit = String(dimension.unit ?? dimension.units ?? '').toLowerCase()
      dimensions.push({
        name: String(dimension.name ?? `${entity.id}.dim`),
        type: String(dimension.type ?? dimension.kind ?? 'distance'),
        value: dimension.value,
        refs: Array.isArray(dimension.refs) ? dimension.refs.map(String) : [entity.id],
        unit,
        source: String(dimension.source ?? 'definition'),
      })
    }
  }
  for (const dimension of Array.isArray(extraDimensions) ? extraDimensions : []) {
    if (!dimension || typeof dimension !== 'object') continue
    dimensions.push({
      name: String(dimension.name ?? dimension.id ?? `dim${dimensions.length}`),
      type: String(dimension.type ?? dimension.kind ?? 'distance'),
      value: dimension.value ?? dimension.valueMm,
      refs: Array.isArray(dimension.refs) ? dimension.refs.map(String) : [],
      unit: String(dimension.unit ?? dimension.units ?? '').toLowerCase(),
      source: String(dimension.source ?? 'annotation'),
    })
  }
  return dimensions
}

function isPixelDimension(dimension) {
  const unit = String(dimension.unit ?? '').toLowerCase()
  if (unit === 'px' || unit === 'pixel' || unit === 'pixels') return true
  if (/(^|[^a-z])px([^a-z]|$)/i.test(String(dimension.value ?? ''))) return true
  return dimension.source === 'pixel' || dimension.source === 'image'
}

function normalizeAssumption(item) {
  if (typeof item === 'string') return { name: item, value: null, reason: null }
  if (!item || typeof item !== 'object') return null
  const name = item.name ?? item.id ?? item.key ?? item.text
  if (typeof name !== 'string' || name.length === 0) return null
  return { name, value: item.value ?? item.valueMm ?? null, reason: item.reason ?? item.why ?? null }
}

function assumptionConfirmed(assumption, accepted) {
  return accepted.some((entry) => {
    const acceptedName = typeof entry === 'string' ? entry : (entry?.name ?? entry?.id ?? entry?.key)
    return typeof acceptedName === 'string' && acceptedName === assumption.name
  })
}

/** 找出连续短直线拟合同一圆的痕迹。这是「像素拟合」最典型的样子。 */
function detectShortLineArcs(entities, tolMm) {
  const violations = []
  const lines = entities.filter((entity) => !entity.construction && entity.kind === 'line')
  const used = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    if (used.has(i)) continue
    const run = [i]
    used.add(i)
    let changed = true
    while (changed) {
      changed = false
      const last = lines[run[run.length - 1]]
      const lastEnd = endpointsOf(last)?.[1]
      if (!lastEnd) break
      for (let j = 0; j < lines.length; j += 1) {
        if (used.has(j)) continue
        const candidateStart = endpointsOf(lines[j])?.[0]
        if (candidateStart && dist(lastEnd, candidateStart) <= tolMm) {
          run.push(j)
          used.add(j)
          changed = true
          break
        }
      }
    }
    if (run.length < 3) continue
    const chain = run.map((index) => lines[index])
    const lengths = chain.map((entity) => {
      const ends = endpointsOf(entity)
      return ends ? dist(ends[0], ends[1]) : Infinity
    })
    const points = chain.map((entity) => endpointsOf(entity)[0])
    points.push(endpointsOf(chain[chain.length - 1])[1])
    const tiny = lengths.filter((length) => length <= Math.max(2.5, tolMm * 100)).length
    if (run.length >= 5 && tiny === run.length) {
      // 三点定圆；点共线时半径为 Infinity，不会误报。
      const circle = circleThrough(points[0], points[Math.floor(points.length / 2)], points[points.length - 1])
      const onCircle = circle !== null
        && points.every((point) => Math.abs(dist(point, circle.center) - circle.radius) <= Math.max(0.2, tolMm * 5))
      if (onCircle) {
        violations.push({
          code: 'ARC_APPROXIMATED_BY_SHORT_LINES',
          message: `连续 ${run.length} 条短直线落在同一段圆弧上：这是折线拟合，不是圆弧`,
          refs: chain.map((entity) => entity.id),
        })
        continue
      }
    }
    if (run.length >= 12 && tiny === run.length) {
      violations.push({
        code: 'TOO_MANY_TINY_SEGMENTS',
        message: `连续 ${run.length} 条极短线段（≤2.5 mm）：轮廓应当用圆弧/样条表达，不要用点云折线`,
        refs: chain.map((entity) => entity.id),
      })
    }
  }
  return violations
}

function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a[0] * a[0] + a[1] * a[1]
  const b2 = b[0] * b[0] + b[1] * b[1]
  const c2 = c[0] * c[0] + c[1] * c[1]
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  const center = [ux, uy]
  return { center, radius: dist(center, a) }
}

/**
 * 分析一份设计定义里的草图：实体、关系覆盖、悬空端点、可推断关系、拟合违规、尺寸来源。
 * 纯函数：不读文件、不调用桥接器。
 */
export function analyzeSketch(definition, options = {}) {
  const tolMm = Number(options.toleranceMm ?? definition?.toleranceMm ?? DEFAULT_TOL_MM)
  const precision = options.precision === 'coordinate' ? 'coordinate' : 'relations'
  const output = options.output === 'sketch' || options.output === undefined ? 'sketch' : String(options.output)
  const requireRelations = precision === 'relations' && output === 'sketch'
  const allowOpen = options.allowOpen === true
  const acceptedAssumptions = Array.isArray(options.acceptedAssumptions) ? options.acceptedAssumptions : []
  const assumptions = (Array.isArray(options.assumptions) ? options.assumptions : [])
    .map(normalizeAssumption)
    .filter(Boolean)
  const blockers = []
  const { entities, relations } = collectSketchEntities(definition)

  if (entities.length === 0) {
    blockers.push(codeBlock('EMPTY_SKETCH', '设计定义里没有草图实体：先给 curves 或 primitives'))
  }

  // 关系引用必须能解析到实体；解析不到就是定义写错了，不能等到桥接器里才炸。
  const resolvedRelations = []
  for (const relation of relations) {
    const refEntities = relation.refs.map((ref) => resolveEntityId(ref, entities))
    const unknown = relation.refs.filter((ref, index) => refEntities[index] === null)
    if (unknown.length > 0) {
      blockers.push(codeBlock('BAD_REF', `关系 ${relation.type} 引用了不存在的曲线：${unknown.join(', ')}`, {
        relation, known: entities.map((entity) => entity.id),
      }))
      continue
    }
    if (!RELATION_TYPES.includes(relation.type)) {
      blockers.push(codeBlock('BAD_ARGUMENT', `不认识的关系类型：${relation.type}`))
      continue
    }
    resolvedRelations.push({ ...relation, entityIds: [...new Set(refEntities)] })
  }

  const covered = new Set()
  for (const relation of resolvedRelations) {
    for (const id of relation.entityIds) covered.add(id)
  }

  const openEnds = []
  const missingRelations = []
  const relationCandidates = []
  const fitViolations = []

  // 每个非构造、非 primitive 实体都必须参与至少一条关系：坐标式草稿不能算「可构建」。
  for (const entity of entities) {
    if (entity.construction || entity.primitive) continue
    if (!covered.has(entity.id)) {
      missingRelations.push({
        type: 'coincident',
        refs: [entity.id],
        reason: `${entity.id} 没有参与任何几何关系：它现在是按坐标钉死的`,
      })
    }
  }

  for (const entity of entities) {
    if (entity.construction) continue
    const ends = endpointsOf(entity)
    if (!ends || isClosedEntity(entity)) continue
    const labels = ['start', 'end']
    for (let index = 0; index < 2; index += 1) {
      const ref = `${entity.id}:${labels[index]}`
      const point = ends[index]
      const explicit = resolvedRelations.find((relation) => relation.type === 'coincident'
        && relation.refs.some((item) => normalizeRef(item) === ref || normalizeRef(item) === entity.id && relation.refs.length === 1))
      if (explicit) continue
      // 最近的另一个端点：既是「应该加哪条重合关系」的候选，也是悬空端点的证据。
      let nearest = null
      for (const other of entities) {
        if (other.id === entity.id || other.construction) continue
        const otherEnds = endpointsOf(other)
        if (!otherEnds || isClosedEntity(other)) continue
        for (let otherIndex = 0; otherIndex < 2; otherIndex += 1) {
          const distance = dist(point, otherEnds[otherIndex])
          if (nearest === null || distance < nearest.distance) {
            nearest = { id: other.id, end: ['start', 'end'][otherIndex], distance }
          }
        }
      }
      openEnds.push({
        curve: entity.id,
        end: labels[index],
        point: point.map((value) => Number(value.toFixed(6))),
        nearest: nearest !== null && nearest.distance <= tolMm * 10
          ? { ref: `${nearest.id}:${nearest.end}`, distance: Number(nearest.distance.toFixed(6)) }
          : null,
      })
      if (nearest !== null && nearest.distance <= tolMm) {
        relationCandidates.push({
          type: 'coincident',
          refs: [ref, `${nearest.id}:${nearest.end}`],
          distance: Number(nearest.distance.toFixed(6)),
          reason: '两个端点几何上重合，但没有重合关系',
        })
      } else {
        missingRelations.push({
          type: 'coincident',
          refs: [ref],
          reason: `${ref} 悬空：需要与相邻曲线的端点重合，或明确允许开口`,
        })
      }
    }
  }

  // 圆心落在弧/圆上：常见的「两个圆心互落对方弧」在没有关系时必须能被推断出来。
  for (const entity of entities) {
    if (entity.construction) continue
    const center = centerOf(entity)
    if (!center) continue
    for (const other of entities) {
      if (other.id === entity.id || other.construction) continue
      const otherCenter = centerOf(other)
      const otherRadius = circleRadius(other)
      if (otherCenter && otherRadius !== null) {
        if (dist(center, otherCenter) <= tolMm) {
          const refs = [`${entity.id}:center`, other.id]
          const exists = resolvedRelations.some((relation) => relation.type === 'coincident'
            && relation.refs.some((ref) => normalizeRef(ref) === refs[0])
            && relation.refs.some((ref) => normalizeRef(ref) === refs[1] || normalizeRef(ref) === `${other.id}:center`))
          if (!exists) {
            relationCandidates.push({
              type: 'coincident',
              refs,
              distance: 0,
              reason: `${entity.id} 的圆心与 ${other.id} 的圆心重合：应加同心/中心-曲线关系`,
            })
          }
        }
        const delta = Math.abs(dist(center, otherCenter) - otherRadius)
        if (delta <= tolMm) {
          const refs = [`${entity.id}:center`, other.id]
          const exists = resolvedRelations.some((relation) => relation.type === 'coincident'
            && relation.refs.some((ref) => normalizeRef(ref) === refs[0])
            && relation.refs.some((ref) => normalizeRef(ref) === refs[1]))
          if (!exists) {
            relationCandidates.push({
              type: 'coincident',
              refs,
              distance: Number(delta.toFixed(6)),
              reason: `${entity.id} 的圆心落在 ${other.id} 上：应加点到曲线重合关系`,
            })
          }
        }
      }
    }
  }

  for (const entity of entities) {
    if (entity.construction) continue
    const kind = String(entity.kind)
    if (kind !== 'arc' && kind !== 'ellipticArc') continue
    const hasCenter = centerOf(entity) !== null
    const centerRelation = resolvedRelations.find((relation) => (relation.type === 'concentric' || relation.type === 'coincident')
      && relation.refs.some((ref) => normalizeRef(ref).startsWith(`${entity.id}:center`)))
    if (!hasCenter && !centerRelation) {
      blockers.push(codeBlock('ARC_CENTER_MISSING',
        `${entity.id} 是圆弧但没有圆心：不能靠采样折线拟合，给 params.center 或 center 关系`))
    }
  }

  // 禁止折线拟合：relations 精度下 polyline 不是合法轮廓表达。
  if (requireRelations) {
    const polylines = entities.filter((entity) => !entity.construction && entity.kind === 'polyline')
    for (const entity of polylines) {
      fitViolations.push({
        code: 'POLYLINE_NOT_ALLOWED',
        message: `${entity.id} 用 polyline 表达轮廓：relations 精度下必须用圆弧/直线等原生实体`,
        refs: [entity.id],
      })
    }
    fitViolations.push(...detectShortLineArcs(entities, tolMm))
  }

  for (const violation of fitViolations) {
    blockers.push(codeBlock(violation.code, violation.message, { refs: violation.refs }))
  }

  // 尺寸来源：定义里的显式尺寸算标注；调用方给的 assumptions 需要被明确接受。
  const dimensions = collectDimensions(entities, options.dimensions)
  const pixelDimensions = dimensions.filter(isPixelDimension)
  for (const dimension of pixelDimensions) {
    blockers.push(codeBlock('PIXEL_DIMENSION',
      `尺寸 ${dimension.name} 来自像素：图纸扫描件不是等比图，像素不能当毫米，请用标注值`,
      { name: dimension.name, value: dimension.value }))
  }

  const unconfirmed = assumptions.filter((assumption) => !assumptionConfirmed(assumption, acceptedAssumptions))
  if (unconfirmed.length > 0) {
    blockers.push(codeBlock('DIMENSIONS_UNCONFIRMED',
      `有 ${unconfirmed.length} 条未确认的假设：${unconfirmed.map((item) => item.name).join(', ')}。先问用户再 build`,
      { assumptions: unconfirmed.map((item) => item.name) }))
  }

  if (!allowOpen && openEnds.length > 0) {
    blockers.push(codeBlock('SKETCH_OPEN',
      `轮廓有 ${openEnds.length} 个悬空端点：闭合轮廓才能拉伸/切除`,
      { openEnds }))
  }

  if (requireRelations && resolvedRelations.length === 0 && entities.some((entity) => !entity.construction && !entity.primitive)) {
    blockers.push(codeBlock('RELATIONS_REQUIRED',
      '这份草稿只有坐标、没有任何几何关系：区域坐标式草稿不能当作可编辑的设计',
      { hint: '给 feature.relations 加重合/同心/相切等关系，或在曲线里写 constraints' }))
  }

  return {
    entities: entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      construction: entity.construction,
      primitive: entity.primitive,
      closed: isClosedEntity(entity),
      center: centerOf(entity),
      featureId: entity.featureId,
    })),
    relations: resolvedRelations.map((relation) => ({
      type: relation.type,
      refs: relation.refs,
      entityIds: relation.entityIds,
      origin: relation.origin,
    })),
    openEnds,
    relationCandidates: dedupeCandidates(relationCandidates).slice(0, 24),
    missingRelations,
    fitViolations,
    blockers,
    dimensions,
    dimensionSources: {
      dimension: dimensions.map((dimension) => ({
        name: dimension.name, type: dimension.type, value: dimension.value,
        refs: dimension.refs, source: dimension.source,
      })),
      assumption: assumptions.map((assumption) => ({
        name: assumption.name,
        value: assumption.value,
        status: unconfirmed.some((item) => item.name === assumption.name) ? 'unconfirmed' : 'accepted',
      })),
    },
    assumptions: assumptions.map((assumption) => ({
      name: assumption.name,
      value: assumption.value,
      reason: assumption.reason,
      confirmed: !unconfirmed.some((item) => item.name === assumption.name),
    })),
    unconfirmedAssumptions: unconfirmed.map((item) => item.name),
    precision,
    output,
    toleranceMm: tolMm,
    requireRelations,
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set()
  const out = []
  for (const candidate of candidates) {
    const key = `${candidate.type}:${[...candidate.refs].sort().join('|')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

/**
 * 计划：能不能进入 build。
 *
 * ready=false 时 blockers 必须非空且每条都有 code —— 调用方据此回明确的错误码，
 * 不要只回一句「计划没通过」。
 */
export function planSketch(definition, options = {}) {
  const analysis = analyzeSketch(definition ?? {}, options)
  const blockers = [...analysis.blockers]
  const precision = options.precision === 'coordinate' ? 'coordinate' : 'relations'
  if (precision === 'coordinate') {
    blockers.push(codeBlock('RELATIONS_REQUIRED',
      'precision="coordinate" 只允许画坐标草稿；要交付的草图必须 precision="relations"'))
  }
  if (blockers.length === 0 && analysis.dimensions.length === 0 && options.requireDimensions === true) {
    blockers.push(codeBlock('DIMENSIONS_UNCONFIRMED',
      '没有任何标注尺寸：这张草图只是几何形状，不能证明按图纸建对了'))
  }
  const deduped = dedupeBlockers(blockers)
  return {
    ready: deduped.length === 0,
    blockers: deduped,
    entities: analysis.entities,
    openEnds: analysis.openEnds,
    relationCandidates: analysis.relationCandidates,
    missingRelations: analysis.missingRelations,
    fitViolations: analysis.fitViolations,
    dimensionSources: analysis.dimensionSources,
    assumptions: analysis.assumptions,
    unconfirmedAssumptions: analysis.unconfirmedAssumptions,
    relations: analysis.relations,
    precision,
    output: analysis.output,
    toleranceMm: analysis.toleranceMm,
  }
}

function dedupeBlockers(blockers) {
  const seen = new Set()
  const out = []
  for (const blocker of blockers) {
    const key = `${blocker.code}:${blocker.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(blocker)
  }
  return out
}

/**
 * `rejected` 只有两种合法形状：桥接器返回的逐条行（数组），或 live.json 里存的
 * 条数（非负有限数）。其它形状（`{}`、`"abc"`、`null`、NaN、负数）都表示「不知道
 * 有没有关系被拒」—— 这种「不知道」必须不放行，不能按 0 静默通过：否则一条被拒
 * 的关系换个外壳就能拿到「审计干净」的通行证。
 *
 * 字段本身没给（undefined）沿用旧语义 0：调用方没写这一项，不是写错这一项。
 */
function readRejected(raw) {
  if (Array.isArray(raw)) return { count: raw.length, known: true }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return { count: raw, known: true }
  if (raw === undefined) return { count: 0, known: true }
  return { count: 0, known: false, shape: describeRejectedShape(raw) }
}

function describeRejectedShape(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`
  return `${typeof value} ${String(value)}`
}

/**
 * 交付前的确定性关系审计：只看事实，不看图。
 *
 * 输入三选一（按优先级）：
 *   · audit      —— 服务在 build output=sketch / inspect relations 后写进 live.json 的记录；
 *   · project    —— projects/<id>.json（里面带设计定义与 assumptions）；
 *   · definition —— 直接给设计定义。
 *
 * 返回值里 gaps 为 null 表示「没有审计事实」—— 调用方必须拒绝，不能把「不知道」当通过。
 */
export function auditRelations({ audit = null, project = null, definition = null, acceptedAssumptions = null } = {}) {
  const assumptionsFromProject = Array.isArray(project?.assumptions) ? project.assumptions : []
  const accepted = Array.isArray(acceptedAssumptions)
    ? acceptedAssumptions
    : (Array.isArray(project?.acceptedAssumptions) ? project.acceptedAssumptions : (Array.isArray(audit?.acceptedAssumptions) ? audit.acceptedAssumptions : []))
  const def = definition ?? project?.definition ?? null

  if (audit !== null && typeof audit === 'object') {
    const gaps = Array.isArray(audit.gaps) ? audit.gaps : null
    // 桥接器回的是逐条 rejected 行，live.json 里存的是条数：两种形状都要按「条数」判，
    // 否则把桥接器结果直接喂进来时 Number([]) 得 NaN → 当成 0 → 被拒也判通过。
    // 其它形状（{}、"abc"）同样不能当 0：那是「不知道」，按已知事实不足处理。
    const rejection = readRejected(audit.rejected)
    const rejected = rejection.count
    const rejectedKnown = rejection.known
    const assumptions = Array.isArray(audit.assumptions) ? audit.assumptions : assumptionsFromProject
    const unconfirmed = assumptions
      .map(normalizeAssumption)
      .filter(Boolean)
      .filter((item) => !assumptionConfirmed(item, accepted))
      .map((item) => item.name)
    const missingRelations = Array.isArray(audit.missingRelations) ? audit.missingRelations : []
    return {
      source: 'live-audit',
      gaps,
      rejected,
      rejectedKnown,
      // 说不清的地方要能指出来源：'rejected' 形态不认识时，known 就是 false。
      unknown: rejectedKnown ? [] : ['rejected'],
      reason: rejectedKnown
        ? null
        : `关系审计里的 rejected 形态不认识（${rejection.shape}）：无法证明没有关系被拒`,
      missingRelations,
      assumptions: assumptions.map(normalizeAssumption).filter(Boolean).map((item) => ({ ...item, confirmed: !unconfirmed.includes(item.name) })),
      unconfirmedAssumptions: unconfirmed,
      ok: gaps !== null && gaps.length === 0 && rejectedKnown && rejected === 0
        && missingRelations.length === 0 && unconfirmed.length === 0,
      known: gaps !== null && rejectedKnown,
    }
  }

  if (def !== null && typeof def === 'object') {
    const analysis = analyzeSketch(def, { assumptions: assumptionsFromProject, acceptedAssumptions: accepted })
    return {
      source: 'project-definition',
      gaps: analysis.missingRelations,
      rejected: 0,
      missingRelations: analysis.missingRelations,
      assumptions: analysis.assumptions,
      unconfirmedAssumptions: analysis.unconfirmedAssumptions,
      ok: analysis.missingRelations.length === 0 && analysis.unconfirmedAssumptions.length === 0 && analysis.blockers.length === 0,
      known: true,
    }
  }

  return {
    source: 'none',
    gaps: null,
    rejected: 0,
    missingRelations: [],
    assumptions: [],
    unconfirmedAssumptions: [],
    ok: false,
    known: false,
  }
}

/**
 * build output="sketch" 的返回校验。
 *
 * 桥接器的返回形状由 T1 定义；这里按任务书兼容三种常见落点（顶层 relationAudit、
 * sketch.relationAudit、扁平的 gaps/rejected），任何一项缺失都当失败 —— 不能因为
 * 「没看到违规」就判通过。
 */
export function sketchBuildCheck(result, options = {}) {
  const sketch = result?.sketch ?? result?.changes?.sketch ?? null
  const closed = sketch?.closed ?? result?.closed ?? result?.description?.closed
  const audit = result?.relationAudit ?? sketch?.relationAudit ?? result?.audit ?? null
  const gaps = Array.isArray(audit?.gaps) ? audit.gaps
    : Array.isArray(result?.gaps) ? result.gaps
      : Array.isArray(sketch?.gaps) ? sketch.gaps
        : null
  const hasOwn = (object, key) => object !== null && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key)
  const rawRejected = hasOwn(audit, 'rejected') ? audit.rejected
    : hasOwn(result, 'rejected') ? result.rejected
      : hasOwn(sketch, 'rejected') ? sketch.rejected
        : undefined
  // 与 auditRelations 同一套形状判定：{} / "abc" / null 这类「不知道」不放行。
  const rejection = readRejected(rawRejected)
  const rejected = rejection.count
  const rejectedRows = Array.isArray(rawRejected) ? rawRejected : []
  const accepted = Array.isArray(options.acceptedAssumptions) ? options.acceptedAssumptions : []
  const assumptions = Array.isArray(options.assumptions) ? options.assumptions : []
  const unconfirmed = assumptions
    .map(normalizeAssumption)
    .filter(Boolean)
    .filter((item) => !assumptionConfirmed(item, accepted))
    .map((item) => item.name)
  const details = {
    closed,
    gaps,
    rejected,
    rejectedKnown: rejection.known,
    ...(rejection.known ? {} : { rejectedShape: rejection.shape }),
    rejectedRows,
    unconfirmedAssumptions: unconfirmed,
    audit,
  }

  if (closed !== true) {
    return { ok: false, error: { code: 'SKETCH_OPEN', message: `草图的 closed=${closed === undefined ? 'null' : closed}：轮廓没有闭合`, detail: details }, details }
  }
  if (gaps === null) {
    return { ok: false, error: { code: 'RELATIONS_REQUIRED', message: '桥接器没有返回关系审计：无法证明关系已经落地', detail: details }, details }
  }
  if (!rejection.known) {
    return {
      ok: false,
      error: {
        code: 'RELATIONS_REQUIRED',
        message: `关系审计没通过：rejected 的形态不认识（${rejection.shape}），无法证明没有关系被拒`,
        detail: details,
      },
      details,
    }
  }
  if (gaps.length > 0 || rejected > 0) {
    return {
      ok: false,
      error: {
        code: 'RELATIONS_REQUIRED',
        message: `关系审计没通过：缺 ${gaps.length} 条关系、被拒 ${rejected} 条`,
        detail: { ...details, exampleGaps: gaps.slice(0, 8) },
      },
      details,
    }
  }
  if (unconfirmed.length > 0) {
    return {
      ok: false,
      error: {
        code: 'DIMENSIONS_UNCONFIRMED',
        message: `这些假设还没被用户确认：${unconfirmed.join(', ')}`,
        detail: details,
      },
      details,
    }
  }
  return { ok: true, details }
}

/** 规划结果的简短摘要，给 model action=plan 的 summary 用。 */
export function describePlan(plan) {
  if (plan?.ready === true) {
    return `草图计划可以构建：${plan.entities.length} 个实体，${plan.relations.length} 条关系`
  }
  const first = plan?.blockers?.[0]
  return `草图计划不可构建：${plan?.blockers?.length ?? 0} 个阻断项`
    + (first ? `，第一项 ${first.code}：${first.message}` : '')
}
