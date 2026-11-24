// design.json / manifest.json / 档位验收的离线测试（不需要 SOLIDWORKS）。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESIGN_SCHEMA, buildDesign, buildManifest, canonicalJson, designFileFor, driftOf, evaluateTiers,
  hashFile, hashText, manifestFileFor, patchDesign, readContract, restoreCad, snapshotCad, writeJsonAtomic,
} from '../server/design-store.mjs'

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS ', name) }
  else { fail += 1; console.log('FAIL ', name, JSON.stringify(detail ?? null)) }
}

const dir = mkdtempSync(join(tmpdir(), 'design-store-'))
const cadPath = join(dir, 'C04-02.SLDPRT')
writeFileSync(cadPath, 'solidworks-bytes-v1')

// 文件命名
check('design 文件落在 CAD 旁边', designFileFor(cadPath) === join(dir, 'C04-02.design.json'), designFileFor(cadPath))
check('manifest 文件落在 CAD 旁边', manifestFileFor(cadPath) === join(dir, 'C04-02.manifest.json'), manifestFileFor(cadPath))

// 规范化哈希：键序不影响
const a = { b: 1, a: [1, 2, { z: true, y: null }] }
const b = { a: [1, 2, { y: null, z: true }], b: 1 }
check('canonicalJson 对键序稳定', canonicalJson(a) === canonicalJson(b), [canonicalJson(a), canonicalJson(b)])
check('hashText 是 sha256:', hashText('x').startsWith('sha256:'), hashText('x'))
check('hashFile 能读文件', hashFile(cadPath) === hashText('solidworks-bytes-v1'), hashFile(cadPath))
check('hashFile 对缺失文件返回 null', hashFile(join(dir, 'nope.sldprt')) === null)

// 设计文件
const design = buildDesign({
  designId: 'c04-02', partId: 'C04-02',
  definition: { schemaVersion: 3, designId: 'c04-02', params: { plate_width: 60, pivot_hole_pitch: 60 }, features: [] },
  revision: 3, expectations: { volume: 24280.7, boundingBox: [60, 120, 6], bodies: 1 }, cadPath,
  now: '2026-11-17T00:00:00.000Z',
})
check('design 带 schema 与 units', design.schema === DESIGN_SCHEMA && design.units === 'mm', design.schema)
check('design.parameters 从定义里展开', design.parameters.plate_width === 60 && design.parameters.pivot_hole_pitch === 60)

// 参数补丁
const patched = patchDesign(design, { pivot_hole_pitch: 62, 'params.plate_width': 70 })
check('补丁改到既有参数', patched.applied.length === 2 && patched.rejected.length === 0, patched.applied)
check('补丁同时写回 definition.params', patched.design.definition.params.pivot_hole_pitch === 62 && patched.design.parameters.plate_width === 70)
const unknown = patchDesign(design, { not_a_param: 5 })
check('未声明的参数被拒', unknown.rejected.length === 1 && unknown.rejected[0].reason === 'NOT_A_DECLARED_PARAMETER', unknown.rejected)
const notNumber = patchDesign(design, { plate_width: 'wide' })
check('非数字被拒', notNumber.rejected.length === 1 && notNumber.rejected[0].reason === 'NOT_A_FINITE_NUMBER', notNumber.rejected)

// manifest 与漂移
const designPath = designFileFor(cadPath)
const manifestPath = manifestFileFor(cadPath)
writeJsonAtomic(designPath, design)
const manifest = buildManifest({ design, cadPath, cadBytes: statSync(cadPath).size, cadHash: hashFile(cadPath), features: [{ name: 'Boss-Extrude1' }], now: '2026-11-17T00:00:00.000Z' })
writeJsonAtomic(manifestPath, manifest)
const contract = readContract(cadPath)
check('readContract 读得回两份文件', contract?.design?.partId === 'C04-02' && contract?.manifest?.revision === 3, Object.keys(contract ?? {}))

const clean = driftOf({ design, manifest, cadPath, cadHash: hashFile(cadPath) })
check('没动过 → clean', clean.status === 'clean', clean)

const editedDesign = { ...design, parameters: { ...design.parameters, pivot_hole_pitch: 62 } }
const designDrift = driftOf({ design: editedDesign, manifest, cadPath, cadHash: hashFile(cadPath) })
check('只改设计 → design-changed', designDrift.status === 'design-changed' && designDrift.designChanged && !designDrift.cadChanged, designDrift)

check('只改 CAD → cad-changed', driftOf({ design, manifest, cadPath, cadHash: hashText('other') }).status === 'cad-changed')

const both = driftOf({ design: editedDesign, manifest, cadPath, cadHash: hashText('other') })
check('两边都改 → both-changed', both.status === 'both-changed', both)

// 快照与回滚
const snap = snapshotCad(cadPath, 3)
check('快照写到 _rev', snap !== null && existsSync(snap) && snap.includes('_rev'), snap)
writeFileSync(cadPath, 'broken-bytes')
restoreCad(snap, cadPath)
check('回滚后文件内容复原', readFileSync(cadPath, 'utf8') === 'solidworks-bytes-v1')

// 档位验收
const geometry = {
  bodies: 1, openEnds: 0,
  massProperties: { volume: 24280.7 },
  boundingBox: { size: [60, 120, 6] },
  holes: [
    { diameter: 42, axisPoint: [0, 30, 0] },
    { diameter: 42, axisPoint: [0, -30, 0] },
    { diameter: 5.5, axisPoint: [23, 42, 0] },
    { diameter: 6.6, axisPoint: [-18, 52, 0] },
  ],
}
const withPositions = {
  ...design,
  expectations: {
    ...design.expectations,
    holes: [{ diameter: 42, count: 2 }, { diameter: 5.5, count: 1 }],
    holePositions: [{ diameter: 42, at: [0, 30] }, { diameter: 42, at: [0, -30] }],
    pitches: [{ a: [0, 30], b: [0, -30], distance: 60 }],
  },
}
const rows = evaluateTiers({ tiers: ['file', 'geometry', 'dimensions', 'positions', 'topology'], design: withPositions, manifest, cadPath, cadHash: hashFile(cadPath), geometry })
const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
check('file.exists 通过', byName['file.exists']?.status === 'pass', byName['file.exists'])
check('file.hash 通过', byName['file.hash']?.status === 'pass', byName['file.hash'])
check('geometry.volume 通过', byName['geometry.volume']?.status === 'pass', byName['geometry.volume'])
check('geometry.bodies 通过', byName['geometry.bodies']?.status === 'pass', byName['geometry.bodies'])
check('dimensions.boundingBox 通过', byName['dimensions.boundingBox']?.status === 'pass', byName['dimensions.boundingBox'])
check('dimensions 孔数按直径通过', byName['dimensions.holesØ42']?.status === 'pass', byName['dimensions.holesØ42'])
check('positions 孔心命中', byName['positions.Ø42@0,30']?.status === 'pass', byName['positions.Ø42@0,30'])
check('positions 中心距 60 命中', byName['pitch.0,30-0,-30']?.status === 'pass', byName['pitch.0,30-0,-30'])
check('topology 单实体通过', byName['topology.singleSolid']?.status === 'pass', byName['topology.singleSolid'])

const wrong = evaluateTiers({ tiers: ['dimensions'], design: withPositions, manifest, cadPath, cadHash: hashFile(cadPath), geometry: { ...geometry, boundingBox: { size: [60, 121, 6] } } })
check('包围盒不符 → fail', wrong.find((row) => row.name === 'dimensions.boundingBox')?.status === 'fail', wrong)

const noExpect = evaluateTiers({ tiers: ['positions'], design, manifest, cadPath, cadHash: hashFile(cadPath), geometry })
check('没有记录孔位 → unmeasured（不算通过）', noExpect[0]?.status === 'unmeasured', noExpect)

const assemblyRows = evaluateTiers({ tiers: ['assembly'], design, manifest, cadPath, cadHash: hashFile(cadPath), geometry })
check('零件查装配档 → skipped', assemblyRows[0]?.status === 'skipped', assemblyRows)

const assemblyDesign = { ...design, kind: 'assembly', expectations: { components: 5 } }
const assemblyPart = evaluateTiers({ tiers: ['assembly'], design: assemblyDesign, manifest, cadPath, cadHash: hashFile(cadPath), geometry: { ...geometry, components: 5, interference: { count: 0 } } })
check('装配组件数 + 干涉通过', assemblyPart.every((row) => row.status === 'pass'), assemblyPart)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)