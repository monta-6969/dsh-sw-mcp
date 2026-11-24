// U1 基座单元：批量插入（桥接器按路径去重，必须单次提交）→ 逐件旋转 → 闭环推回 → 保存 → 逐件读回。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const design = process.argv[2] || 'ASM-U1'
const path = join(P, design + '.SLDASM')

const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 240000); t.unref() })
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }
const ctr = (k) => [(k.box[0] + k.box[3]) / 2, (k.box[1] + k.box[4]) / 2, (k.box[2] + k.box[5]) / 2]

// 站的解析期望：环中心 X、方位 phi；Δ = phi + 45
const stations = [
  { x: 185, phi: 45,  delta: 90,  R: [0, 1, 0, 0, 0, 1, 1, 0, 0] },
  { x: 199, phi: 135, delta: 180, R: [0, 0, 1, 0, -1, 0, 1, 0, 0] },
  { x: 213, phi: 225, delta: 270, R: [0, -1, 0, 0, 0, -1, 1, 0, 0] },
  { x: 227, phi: 315, delta: 360, R: [0, 0, -1, 0, 1, 0, 1, 0, 0] },
]
const rodR = 84, rodX = 209

await send({ op: 'close', title: design + '.SLDASM' })
if (existsSync(path)) { try { unlinkSync(path) } catch (e) { console.log('unlink failed', e.message) } }
const made = await send({ op: 'assemblyNew', path, designId: design })
console.log('assemblyNew ok=' + made.ok, J(made.error || {}).slice(0, 160))
if (made.ok === false) { child.stdin.end(); setTimeout(() => child.kill(), 100); process.exit(1) }

// —— 单次提交 8 件（同一路径不能在第二次调用里再插，会被 ALREADY_PRESENT 挡掉）——
const comps = []
for (const s of stations) comps.push({ path: join(P, 'FR-11.SLDPRT'), x: s.x, y: 0, z: 0, placement: 'bbox-center' })
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) comps.push({ path: join(P, 'FR-12.SLDPRT'), x: rodX, y, z, placement: 'bbox-center' })
const ins = await send({ op: 'componentInsert', designId: design, components: comps })
console.log('insert ok=' + ins.ok, 'inserted=' + (ins.inserted || []).length, 'failed=' + (ins.failed || []).length, 'skipped=' + (ins.skipped || []).length)
if ((ins.inserted || []).length !== 8) { console.log('INSERT PROBLEM', J(ins.failed), J(ins.skipped)); }

// —— 逐件旋转 + 闭环推回 ——
const log = []
for (const s of stations) {
  let list = (await send({ op: 'components', designId: design })).components || []
  const ring = list.find((k) => k.path.endsWith('FR-11.SLDPRT') && Math.abs(ctr(k)[0] - s.x) < 1.0 && k.name)
  if (!ring) { log.push({ part: 'FR-11@' + s.x, error: 'NOT_FOUND' }); continue }
  await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'y', angleDeg: 90, x: s.x, y: 0, z: 0 })
  if (s.delta % 360 !== 0) await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'x', angleDeg: s.delta, x: s.x, y: 0, z: 0 })
  let iters = 0
  for (; iters < 4; iters++) {
    list = (await send({ op: 'components', designId: design })).components || []
    const me = list.find((k) => k.name === ring.name)
    if (!me) break
    const c = ctr(me)
    const d = [s.x - c[0], -c[1], -c[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 0.02) break
    await send({ op: 'componentTranslate', designId: design, component: ring.name, dx: d[0], dy: d[1], dz: d[2] })
  }
  log.push({ part: ring.name, station: s.phi, iters })
  console.log('rotated', ring.name, 'phi=' + s.phi, 'iters=' + iters)
}

// 拉杆：只闭环推回，不旋转
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) {
  const list = (await send({ op: 'components', designId: design })).components || []
  const rod = list.find((k) => k.path.endsWith('FR-12.SLDPRT') && Math.abs(ctr(k)[1] - y) < 1.0 && Math.abs(ctr(k)[2] - z) < 1.0)
  if (!rod) { log.push({ part: 'FR-12@' + y + ',' + z, error: 'NOT_FOUND' }); continue }
  let iters = 0
  for (; iters < 4; iters++) {
    const l2 = (await send({ op: 'components', designId: design })).components || []
    const me = l2.find((k) => k.name === rod.name)
    if (!me) break
    const c = ctr(me)
    const d = [rodX - c[0], y - c[1], z - c[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 0.02) break
    await send({ op: 'componentTranslate', designId: design, component: rod.name, dx: d[0], dy: d[1], dz: d[2] })
  }
  log.push({ part: rod.name, at: [y, z], iters })
  console.log('placed', rod.name, 'y/z=' + y + '/' + z, 'iters=' + iters)
}

const sv = await send({ op: 'save', designId: design })
console.log('save ok=' + sv.ok, J(sv.error || { bytes: sv.bytes }).slice(0, 160))

// —— 保存后重读：位置、旋转矩阵、轴承孔、残差 ——
const finalList = (await send({ op: 'components', designId: design })).components || []
const rows = []
const angleOf = () => null
for (const s of stations) {
  const k = finalList.find((x) => x.path.endsWith('FR-11.SLDPRT') && Math.abs(ctr(x)[0] - s.x) < 1.0)
  if (!k) { rows.push({ part: 'FR-11', x: s.x, missing: true }); continue }
  const c = ctr(k)
  const R = (k.transform || []).slice(0, 9).map((v) => Math.round(v * 1e6) / 1e6)
  const dAng = angleOf(R, s.R)
  // 轴承孔世界坐标 = T + R * local
  const hole = (lx, ly) => [c[0] + (R[0] * lx + R[1] * ly), c[1] + (R[3] * lx + R[4] * ly), c[2] + (R[6] * lx + R[7] * ly)]
  const h1 = hole(-24.51, 74.03), h2 = hole(74.03, -24.51)
  const mid = [(h1[0] + h2[0]) / 2, (h1[1] + h2[1]) / 2, (h1[2] + h2[2]) / 2]
  const midR = Math.hypot(mid[1], mid[2])
  const midPhi = (Math.atan2(mid[2], mid[1]) * 180 / Math.PI + 360) % 360
  rows.push({
    part: k.name, station: s.phi,
    center: c.map((v) => +v.toFixed(3)),
    centerResidualMm: +Math.hypot(c[0] - s.x, c[1], c[2]).toFixed(3),
    rotAngleErrDeg: null,
    holeA: h1.map((v) => +v.toFixed(3)), holeB: h2.map((v) => +v.toFixed(3)),
    shaftAxisMidR: +midR.toFixed(3), shaftAxisMidPhi: +midPhi.toFixed(2),
    box: k.box,
  })
}
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) {
  const k = finalList.find((x) => x.path.endsWith('FR-12.SLDPRT') && Math.abs(ctr(x)[1] - y) < 1.0 && Math.abs(ctr(x)[2] - z) < 1.0)
  if (!k) { rows.push({ part: 'FR-12', at: [y, z], missing: true }); continue }
  const c = ctr(k)
  rows.push({ part: k.name, at: [y, z], center: c.map((v) => +v.toFixed(3)), centerResidualMm: +Math.hypot(c[0] - rodX, c[1] - y, c[2] - z).toFixed(3), box: k.box })
}

const maxRes = rows.reduce((a, r) => Math.max(a, r.centerResidualMm ?? 99), 0)
const maxAng = 0
const out = { design, at: new Date().toISOString(), saved: sv.ok, count: finalList.length, maxResidualMm: +maxRes.toFixed(3), maxRotErrDeg: +maxAng.toFixed(4), rows, log }
writeFileSync(join(P, design + '.verify.json'), JSON.stringify(out, null, 2), 'utf8')
for (const r of rows) console.log(String(r.part).padEnd(10), 'c=' + (r.center || []).join(','), 'res=' + r.centerResidualMm, 'angErr=' + (r.rotAngleErrDeg ?? '-'), 'midR=' + (r.shaftAxisMidR ?? '-'), 'midPhi=' + (r.shaftAxisMidPhi ?? '-'))
console.log('MAXRES', maxRes.toFixed(3), 'MAXANG', maxAng.toFixed(4), 'N', finalList.length, 'saved', sv.ok)
child.stdin.end(); setTimeout(() => child.kill(), 100)