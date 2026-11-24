// U1 基座：批量插入 → 每环 y90 + 局部z自转(45-phi) → 闭环推到 (X,0,0) → 保存 → 读回
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const design = 'ASM-U1'
const path = join(P, design + '.SLDASM')
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 240000); t.unref() })
const ctr = (k) => [(k.box[0] + k.box[3]) / 2, (k.box[1] + k.box[4]) / 2, (k.box[2] + k.box[5]) / 2]
const stations = [185, 199, 213, 227]
const phis = [45, 135, 225, 315]
const rodR = 84, rodX = 209

await send({ op: 'close', title: design + '.SLDASM', allowDirty: true })
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
if (existsSync(path)) { try { unlinkSync(path) } catch (e) { console.log('unlink failed', e.message) } }
const made = await send({ op: 'assemblyNew', path, designId: design })
console.log('assemblyNew', made.ok)
if (made.ok === false) { child.stdin.end(); setTimeout(() => child.kill(), 100); process.exit(1) }

const comps = []
for (const x of stations) comps.push({ path: join(P, 'FR-11.SLDPRT'), x, y: 0, z: 0, placement: 'bbox-center' })
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) comps.push({ path: join(P, 'FR-12.SLDPRT'), x: rodX, y, z, placement: 'bbox-center' })
const ins = await send({ op: 'componentInsert', designId: design, components: comps })
console.log('insert', ins.ok, 'n=' + (ins.inserted || []).length, 'fail=' + (ins.failed || []).length)

const rows = []
for (let i = 0; i < stations.length; i++) {
  const x = stations[i], phi = phis[i]
  let list = (await send({ op: 'components', designId: design })).components || []
  const ring = list.find((k) => k.path.endsWith('FR-11.SLDPRT') && Math.abs(ctr(k)[0] - x) < 2)
  if (!ring) { rows.push({ part: 'FR-11@' + x, error: 'NOT_FOUND' }); continue }
  await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'y', angleDeg: 90, x, y: 0, z: 0 })
  const spin = ((45 - phi) % 360 + 360) % 360
  if (spin !== 0) await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'z', angleDeg: spin, x, y: 0, z: 0 })
  let ok = false
  for (let it = 0; it < 5; it++) {
    list = (await send({ op: 'components', designId: design })).components || []
    const me = list.find((k) => k.name === ring.name)
    if (!me) break
    const c = ctr(me)
    const d = [x - c[0], -c[1], -c[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 0.02) { ok = true; break }
    await send({ op: 'componentTranslate', designId: design, component: ring.name, dx: d[0], dy: d[1], dz: d[2] })
  }
  rows.push({ part: ring.name, station: phi, spin, centered: ok })
  console.log('ring', ring.name, 'phi=' + phi, 'spin=' + spin, 'centered=' + ok)
}
// 拉杆不旋转，只闭环
for (const [y, z] of [[rodR, 0], [0, rodR], [-rodR, 0], [0, -rodR]]) {
  const list = (await send({ op: 'components', designId: design })).components || []
  const rod = list.find((k) => k.path.endsWith('FR-12.SLDPRT') && Math.abs(ctr(k)[1] - y) < 2 && Math.abs(ctr(k)[2] - z) < 2)
  if (!rod) { rows.push({ part: 'FR-12@' + y + ',' + z, error: 'NOT_FOUND' }); continue }
  for (let it = 0; it < 5; it++) {
    const l2 = (await send({ op: 'components', designId: design })).components || []
    const me = l2.find((k) => k.name === rod.name)
    if (!me) break
    const c = ctr(me)
    const d = [rodX - c[0], y - c[1], z - c[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 0.02) break
    await send({ op: 'componentTranslate', designId: design, component: rod.name, dx: d[0], dy: d[1], dz: d[2] })
  }
  console.log('rod', rod.name, 'r=' + y + '/' + z)
}
const sv = await send({ op: 'save', designId: design })
const finalList = (await send({ op: 'components', designId: design })).components || []
const out = { design, at: new Date().toISOString(), saved: sv.ok, count: finalList.length, rows: [] }
for (const k of finalList) {
  const c = ctr(k)
  out.rows.push({ name: k.name, center: c.map((v) => +v.toFixed(3)), box: k.box, size: [k.box[3] - k.box[0], k.box[4] - k.box[1], k.box[5] - k.box[2]].map((v) => +v.toFixed(2)) })
  console.log(String(k.name).padEnd(9), 'c=' + out.rows[out.rows.length - 1].center.join(','), 'size=' + out.rows[out.rows.length - 1].size.join('x'))
}
writeFileSync(join(P, design + '.u1.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('saved', sv.ok, 'N', finalList.length)
child.stdin.end(); setTimeout(() => child.kill(), 100)