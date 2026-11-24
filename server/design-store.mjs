// 设计真源与编译清单。
//
// 分工：
//   <part>.design.json   —— 唯一可信的设计：特征、参数、材料、验收期望。模型只改这里。
//   <part>.manifest.json —— 程序写的编译缓存：哈希、版本、特征/尺寸绑定、CAD 指纹。
//   <part>.SLDPRT        —— 由 design.json 编译出来的成品。
//
// 判断「有没有人动过文件」只认哈希，不认 mtime：SOLIDWORKS 一次保存会重写整份文件，
// mtime 只能说明「动过」，哈希才能说明「内容变了」。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const DESIGN_SCHEMA = 1

export function designFileFor(cadPath) {
  return join(dirname(cadPath), basename(cadPath).replace(/\.[^.]+$/, '') + '.design.json')
}

export function manifestFileFor(cadPath) {
  return join(dirname(cadPath), basename(cadPath).replace(/\.[^.]+$/, '') + '.manifest.json')
}

export function revisionDirFor(cadPath) {
  return join(dirname(cadPath), '_rev')
}

export function canonicalJson(value) {
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return JSON.stringify(node ?? null)
    if (Array.isArray(node)) return '[' + node.map(walk).join(',') + ']'
    const keys = Object.keys(node).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + walk(node[key])).join(',') + '}'
  }
  return walk(value)
}

export function hashText(text) {
  return 'sha256:' + createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function hashFile(path) {
  try {
    return 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
  return path
}

/** 从一份构建结果生成 design.json 的内容。 */
export function buildDesign({ designId, partId, definition, revision = 1, expectations = null, kind = 'part', cadPath = null, now = new Date().toISOString() }) {
  const parameters = { ...(definition?.params ?? {}) }
  return {
    schema: DESIGN_SCHEMA,
    partId: partId ?? designId,
    designId,
    kind,
    revision,
    units: 'mm',
    revisedAt: now,
    parameters,
    definition,
    expectations: expectations ?? null,
    cad: cadPath ? { path: cadPath } : null,
  }
}

/**
 * 参数补丁。只允许改 params 里的既有参数（除非 allowNew）：
 * 放开新键就等于允许模型往设计里塞一个没人校验的变量。
 * 同时接受 'pitch' 和 'params.pitch' 两种写法。
 */
export function patchDesign(design, changes, { allowNew = false } = {}) {
  const next = JSON.parse(JSON.stringify(design))
  const params = { ...(next.parameters ?? {}) }
  const declared = new Set(Object.keys(params))
  const applied = []
  const rejected = []
  for (const [rawKey, value] of Object.entries(changes ?? {})) {
    const key = String(rawKey).replace(/^params\./, '')
    if (!declared.has(key) && allowNew !== true) {
      rejected.push({ key: rawKey, reason: 'NOT_A_DECLARED_PARAMETER', known: [...declared] })
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      rejected.push({ key: rawKey, reason: 'NOT_A_FINITE_NUMBER', value })
      continue
    }
    applied.push({ key, from: params[key] ?? null, to: value })
    params[key] = value
  }
  next.parameters = params
  if (next.definition && typeof next.definition === 'object') {
    next.definition = { ...next.definition, params: { ...(next.definition.params ?? {}), ...Object.fromEntries(applied.map((row) => [row.key, row.to])) } }
  }
  return { design: next, applied, rejected }
}

export function buildManifest({ design, cadPath, cadBytes = null, cadHash = null, features = [], bindings = {}, dimensionBindings = {}, drivers = null, swVersion = null, status = 'compiled', now = new Date().toISOString() }) {
  return {
    schema: DESIGN_SCHEMA,
    partId: design?.partId ?? null,
    designId: design?.designId ?? null,
    revision: design?.revision ?? 0,
    designHash: design ? hashText(canonicalJson(design)) : null,
    status,
    compiledAt: now,
    cad: cadPath
      ? { path: cadPath, bytes: cadBytes, sha256: cadHash }
      : null,
    features: Array.isArray(features) ? features : [],
    bindings: bindings ?? {},
    dimensionBindings: dimensionBindings ?? {},
    drivers: drivers ?? null,
    sw: swVersion ? { version: swVersion } : null,
  }
}

export function readContract(cadPath) {
  if (!cadPath) return null
  return {
    design: readJsonFile(designFileFor(cadPath)),
    manifest: readJsonFile(manifestFileFor(cadPath)),
  }
}

/**
 * 漂移判定：design.json 变了 = 有人改了设计（这是合法入口，重编即可）；
 * SLDPRT 变了而 design 没变 = 有人在 SOLIDWORKS 里手改了模型（必须问，不能静默覆盖）。
 */
export function driftOf({ design, manifest, cadPath, cadHash }) {
  const designHashNow = design ? hashText(canonicalJson(design)) : null
  const designChanged = Boolean(design && manifest?.designHash && designHashNow !== manifest.designHash)
  const haveCad = Boolean(cadPath && cadHash)
  const cadChanged = Boolean(haveCad && manifest?.cad?.sha256 && cadHash !== manifest.cad.sha256)
  let status = 'clean'
  if (!design) status = 'no-design'
  else if (!manifest) status = 'no-manifest'
  else if (designChanged && cadChanged) status = 'both-changed'
  else if (designChanged) status = 'design-changed'
  else if (cadChanged) status = 'cad-changed'
  return { status, designChanged, cadChanged, designHashNow, cadHash }
}

export function snapshotCad(cadPath, revision = 0) {
  if (!cadPath || !existsSync(cadPath)) return null
  const dir = revisionDirFor(cadPath)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, basename(cadPath).replace(/\.[^.]+$/, '') + '.r' + String(revision) + '.sldprt')
  copyFileSync(cadPath, target)
  return target
}

export function restoreCad(snapshotPath, cadPath) {
  if (!snapshotPath || !cadPath || !existsSync(snapshotPath)) return false
  copyFileSync(snapshotPath, cadPath)
  return true
}

const tierStatus = (pass, unmeasured = false) => (unmeasured ? 'unmeasured' : pass ? 'pass' : 'fail')
const close = (a, b, tol = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol

function holeList(geometry) {
  const rows = Array.isArray(geometry?.holes) ? geometry.holes : []
  return rows.map((hole) => ({
    diameter: Number(hole?.diameter ?? NaN),
    at: Array.isArray(hole?.axisPoint) ? hole.axisPoint.slice(0, 2) : (Array.isArray(hole?.at) ? hole.at.slice(0, 2) : null),
    axis: hole?.axisDir ?? hole?.throughAxis ?? null,
  }))
}

/**
 * 档位验收：file / geometry / dimensions / positions / topology / assembly。
 * 输入是同一份几何回包，所以「文件说的是不是这份模型量的」能被比较。
 * 不知道的项一律记 unmeasured（不是通过），不猜。
 */
export function evaluateTiers({ tiers, design, manifest, cadPath, cadHash, geometry }) {
  const rows = []
  const expectations = design?.expectations ?? null
  const want = new Set((tiers ?? []).map((t) => String(t).toLowerCase()))
  const push = (tier, name, pass, expected, actual, note, unmeasured = false) => {
    rows.push({ tier, name, status: tierStatus(pass, unmeasured), pass: pass === true, expected, actual, note })
  }

  if (want.has('file')) {
    const exists = Boolean(cadPath && existsSync(cadPath))
    const bytes = exists ? statSync(cadPath).size : 0
    push('file', 'file.exists', exists && bytes > 0, 'exists', exists ? bytes : 'missing', cadPath ?? '没有登记交付路径')
    if (manifest?.cad?.bytes) push('file', 'file.bytes', bytes === manifest.cad.bytes, manifest.cad.bytes, bytes, '与 manifest 记录的字节数一致')
    if (manifest?.cad?.sha256) push('file', 'file.hash', Boolean(cadHash) && cadHash === manifest.cad.sha256, manifest.cad.sha256, cadHash ?? 'unreadable', '哈希不一致 = 文件被外部改过或没保存')
  }

  if (want.has('geometry')) {
    const volume = geometry?.massProperties?.volume
    const expectedVolume = expectations?.volume
    if (Number.isFinite(expectedVolume)) {
      const relative = Number.isFinite(volume) && expectedVolume !== 0 ? Math.abs(volume - expectedVolume) / Math.abs(expectedVolume) : 1
      push('geometry', 'geometry.volume', relative <= 0.005, expectedVolume, volume ?? null, '容差 0.5%')
    } else {
      push('geometry', 'geometry.volume', false, 'recorded', volume ?? null, '设计里没有记录期望体积（先交付一次）', true)
    }
    const bodies = geometry?.bodies
    const expectedBodies = expectations?.bodies
    if (Number.isFinite(expectedBodies)) push('geometry', 'geometry.bodies', bodies === expectedBodies, expectedBodies, bodies ?? null, '实体数')
  }

  if (want.has('dimensions')) {
    const expectedBox = expectations?.boundingBox
    const box = geometry?.boundingBox?.size
    if (Array.isArray(expectedBox) && expectedBox.length === 3) {
      const pass = Array.isArray(box) && expectedBox.every((v, i) => close(Number(v), Number(box[i]), 0.01))
      push('dimensions', 'dimensions.boundingBox', pass, expectedBox, box ?? null, '包围盒三相，容差 0.01mm')
    } else {
      push('dimensions', 'dimensions.boundingBox', false, 'recorded', box ?? null, '设计里没有记录包围盒', true)
    }
    for (const spec of Array.isArray(expectations?.holes) ? expectations.holes : []) {
      const diameter = Number(spec?.diameter)
      const expectedCount = Number(spec?.count ?? NaN)
      if (!Number.isFinite(diameter) || !Number.isFinite(expectedCount)) continue
      const actual = holeList(geometry).filter((hole) => close(hole.diameter, diameter, 0.05)).length
      push('dimensions', 'dimensions.holesØ' + diameter, actual === expectedCount, expectedCount, actual, '按直径计数')
    }
  }

  if (want.has('positions')) {
    const holes = holeList(geometry)
    const wanted = Array.isArray(expectations?.holePositions) ? expectations.holePositions : []
    if (wanted.length === 0) {
      push('positions', 'positions.holeCenters', false, 'recorded', holes.length, '设计里没有记录孔心位置', true)
    }
    for (const spec of wanted) {
      const diameter = Number(spec?.diameter)
      const at = Array.isArray(spec?.at) ? spec.at.map(Number) : null
      if (at === null) continue
      const hit = holes.some((hole) => close(hole.diameter, diameter, 0.05)
        && Array.isArray(hole.at) && close(hole.at[0], at[0], 0.05) && close(hole.at[1], at[1], 0.05))
      push('positions', 'positions.Ø' + diameter + '@' + at.join(','), hit, at, hit ? at : null, '孔心容差 0.05mm')
    }
    for (const spec of Array.isArray(expectations?.pitches) ? expectations.pitches : []) {
      const distance = Number(spec?.distance)
      const a = Array.isArray(spec?.a) ? spec.a.map(Number) : null
      const b = Array.isArray(spec?.b) ? spec.b.map(Number) : null
      if (!Number.isFinite(distance) || a === null || b === null) continue
      const found = holes.some((ha) => holes.some((hb) => Array.isArray(ha.at) && Array.isArray(hb.at)
        && close(ha.at[0], a[0], 0.05) && close(ha.at[1], a[1], 0.05)
        && close(hb.at[0], b[0], 0.05) && close(hb.at[1], b[1], 0.05)))
      push('positions', 'pitch.' + a.join(',') + '-' + b.join(','), found, distance, found ? distance : null, '孔距/中心距')
    }
  }

  if (want.has('topology')) {
    const bodies = geometry?.bodies
    push('topology', 'topology.singleSolid', bodies === 1, 1, bodies ?? null, '单实体')
    const openEnds = geometry?.openEnds
    if (Number.isFinite(openEnds)) push('topology', 'topology.openEnds', openEnds === 0, 0, openEnds, '开口边')
  }

  if (want.has('assembly')) {
    if (design?.kind !== 'assembly') {
      rows.push({ tier: 'assembly', name: 'assembly.applicable', status: 'skipped', pass: true, note: '这个设计是零件，不是装配体' })
    } else {
      const components = Number(geometry?.components ?? geometry?.componentCount ?? NaN)
      const expected = Number(expectations?.components ?? NaN)
      if (Number.isFinite(expected)) push('assembly', 'assembly.components', components === expected, expected, Number.isFinite(components) ? components : null, '组件数')
      const interference = geometry?.interference
      if (interference && Number.isFinite(Number(interference.count))) {
        push('assembly', 'assembly.interference', Number(interference.count) === 0, 0, Number(interference.count), '干涉体积>0 的组件对')
      } else {
        push('assembly', 'assembly.interference', false, 0, null, '桥接器还没有回干涉结果（未实现，不是通过）', true)
      }
    }
  }
  return rows
}