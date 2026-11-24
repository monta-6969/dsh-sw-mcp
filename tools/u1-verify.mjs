// U1 只读复核：按 SolidWorks 行向量约定读 Transform.ArrayData
// [0..2]=局部X轴像, [3..5]=Y轴像, [6..8]=Z轴像, [9..11]=平移
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const design = process.argv[2] || 'ASM-U1'

const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 240000); t.unref() })
const ctr = (k) => [(k.box[0] + k.box[3]) / 2, (k.box[1] + k.box[4]) / 2, (k.box[2] + k.box[5]) / 2]
const ang = (u, v) => {
  const nu = Math.hypot(...u), nv = Math.hypot(...v)
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI
}
const stations = [
  { x: 185, phi: 45,  ex: [0, 1, 0], ey: [0, 0, 1], ez: [1, 0, 0] },
  { x: 199, phi: 135, ex: [0, 0, 1], ey: [0, -1, 0], ez: [1, 0, 0] },
  { x: 213, phi: 225, ex: [0, -1, 0], ey: [0, 0, -1], ez: [1, 0, 0] },
  { x: 227, phi: 315, ex: [0, 0, -1], ey: [0, 1, 0], ez: [1, 0, 0] },
]
const rodR = 79, rodX = 209
const list = (await send({ op: 'components', designId: design })).components || []
const rows = []
for (const s of stations) {
  const k = list.find((x) => x.path.endsWith('FR-11.SLDPRT') && Math.abs(ctr(x)[0] - s.x) < 1.0)
  if (!k) { rows.push({ part: 'FR-11', x: s.x, missing: true }); continue }
  const c = ctr(k)
  const R = (k.transform || []).slice(0, 12)
  const EX = R.slice(0, 3), EY = R.slice(3, 6), EZ = R.slice(6, 9)
  const hole = (lx, ly) => [c[0] + lx * EX[0] + ly * EY[0], c[1] + lx * EX[1] + ly * EY[1], c[2] + lx * EX[2] + ly * EY[2]]
  const h1 = hole(-24.51, 74.03), h2 = hole(74.03, -24.51)
  const mid = [(h1[0] + h2[0]) / 2, (h1[1] + h2[1]) / 2, (h1[2] + h2[2]) / 2]
  const axis = [h2[0] - h1[0], h2[1] - h1[1], h2[2] - h1[2]]
  const an = Math.hypot(...axis)
  const aunit = axis.map((v) => v / an)
  const dot = mid[1] * aunit[1] + mid[2] * aunit[2]
  const nearest = [mid[1] - dot * aunit[1], mid[2] - dot * aunit[2]]
  rows.push({
    part: k.name, station: s.phi,
    center: c.map((v) => +v.toFixed(3)),
    centerResidualMm: +Math.hypot(c[0] - s.x, c[1], c[2]).toFixed(3),
    axisErrDeg: { X: +ang(EX, s.ex).toFixed(3), Y: +ang(EY, s.ey).toFixed(3), Z: +ang(EZ, s.ez).toFixed(3) },
    holeA: h1.map((v) => +v.toFixed(3)), holeB: h2.map((v) => +v.toFixed(3)),
    shaftAxisDir: aunit.map((v) => +v.toFixed(4)),
    shaftLineMinR: +Math.hypot(nearest[0], nearest[1]).toFixed(3),
    shaftMinPhi: +(((Math.atan2(nearest[1], nearest[0]) * 180 / Math.PI) + 360) % 360).toFixed(2),
    box: k.box,
  })
}
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) {
  const k = list.find((x) => x.path.endsWith('FR-12.SLDPRT') && Math.abs(ctr(x)[1] - y) < 1.0 && Math.abs(ctr(x)[2] - z) < 1.0)
  if (!k) { rows.push({ part: 'FR-12', at: [y, z], missing: true }); continue }
  const c = ctr(k)
  rows.push({ part: k.name, at: [y, z], center: c.map((v) => +v.toFixed(3)), centerResidualMm: +Math.hypot(c[0] - rodX, c[1] - y, c[2] - z).toFixed(3), box: k.box })
}
const maxRes = rows.reduce((a, r) => Math.max(a, r.centerResidualMm ?? 99), 0)
const maxAng = rows.reduce((a, r) => Math.max(a, r.axisErrDeg ? Math.max(r.axisErrDeg.X, r.axisErrDeg.Y, r.axisErrDeg.Z) : 0), 0)
const out = { design, at: new Date().toISOString(), count: list.length, maxResidualMm: +maxRes.toFixed(3), maxAxisErrDeg: +maxAng.toFixed(3), rows }
writeFileSync(join(P, design + '.verify2.json'), JSON.stringify(out, null, 2), 'utf8')
for (const r of rows) {
  if (r.missing) { console.log(r.part, 'MISSING'); continue }
  console.log(String(r.part).padEnd(9), 'c=' + r.center.join(','), 'res=' + r.centerResidualMm,
    r.axisErrDeg ? 'axisErr=' + [r.axisErrDeg.X, r.axisErrDeg.Y, r.axisErrDeg.Z].join('/') : '',
    r.shaftLineMinR !== undefined ? 'lineMinR=' + r.shaftLineMinR + ' minPhi=' + r.shaftMinPhi : '')
}
console.log('MAXRES', maxRes.toFixed(3), 'MAXAXISERR', maxAng.toFixed(3), 'N', list.length)
child.stdin.end(); setTimeout(() => child.kill(), 100)