// 按安装点落位：逐件插 → 转 → 闭环推回 → 存 → 回读。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const spec = JSON.parse(readFileSync(arg('spec'), 'utf8'))
const design = spec.design
const P = spec.partsDir
const path = join(P, design + '.SLDASM')
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 240000); t.unref() })
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }
const centerOf = (k) => [(k.box[0] + k.box[3]) / 2, (k.box[1] + k.box[4]) / 2, (k.box[2] + k.box[5]) / 2]

await send({ op: 'close', title: design + '.SLDASM' })
if (existsSync(path)) { try { unlinkSync(path) } catch (e) { console.log('unlink failed', e.message) } }
const made = await send({ op: 'assemblyNew', path, designId: design })
console.log('assemblyNew', made.ok)

const placed = []
for (const p of spec.parts) {
  const ins = await send({ op: 'componentInsert', designId: design, components: [{ path: join(P, p.file), x: p.center[0], y: p.center[1], z: p.center[2], placement: 'bbox-center' }] })
  const item = (ins.inserted || [])[0]
  const name = item && (item.name || item.component)
  if (!name) { console.log('INSERT FAIL', p.file, J(ins).slice(0, 200)); continue }
  let c = p.center
  if (p.rot) {
    const delta = p.rot[0] === 'ring' ? p.rot[1] + 45 : p.rot[0] === 'shaft' ? p.rot[1] + 180 : 0
    await send({ op: 'componentRotate', designId: design, component: name, axis: 'y', angleDeg: 90, x: c[0], y: c[1], z: c[2] })
    if (delta % 360 !== 0) await send({ op: 'componentRotate', designId: design, component: name, axis: 'x', angleDeg: delta, x: c[0], y: c[1], z: c[2] })
  }
  // 闭环：量中心，推回
  for (let k = 0; k < 3; k++) {
    const cur = (await send({ op: 'components', designId: design })).components || []
    const me = cur.find((x) => x.name === name)
    if (!me) break
    const [cx, cy, cz] = centerOf(me)
    const d = [c[0] - cx, c[1] - cy, c[2] - cz]
    if (Math.hypot(...d) < 0.02) break
    await send({ op: 'componentTranslate', designId: design, component: name, dx: d[0], dy: d[1], dz: d[2] })
  }
  placed.push({ name, file: p.file, expect: c, rot: p.rot || null })
}
const sv = await send({ op: 'save', designId: design })
const cur = (await send({ op: 'components', designId: design })).components || []
const rows = []
for (const pl of placed) {
  const k = cur.find((x) => x.name === pl.name)
  if (!k) { rows.push({ ...pl, missing: true }); continue }
  const c = centerOf(k)
  const res = Math.hypot(c[0] - pl.expect[0], c[1] - pl.expect[1], c[2] - pl.expect[2])
  rows.push({ name: pl.name, center: c.map((v) => Number(v.toFixed(2))), expect: pl.expect, residualMm: Number(res.toFixed(3)), T: (k.transform || []).slice(0, 9).map((v) => Math.round(v * 1000) / 1000), box: k.box })
}
const maxRes = rows.reduce((a, r) => Math.max(a, r.residualMm ?? 99), 0)
writeFileSync(join(P, design + '.verify.json'), JSON.stringify({ design, saved: sv.ok, count: rows.length, maxResidualMm: maxRes, rows }, null, 2), 'utf8')
for (const r of rows) console.log(String(r.name).padEnd(11), 'c=' + (r.center || []).join(','), '残差', r.residualMm)
console.log('MAX', maxRes, 'N', rows.length, 'saved', sv.ok)
child.stdin.end(); setTimeout(() => child.kill(), 100)