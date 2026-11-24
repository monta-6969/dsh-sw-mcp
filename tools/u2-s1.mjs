// U2-S1 刀盘单元：环 FR-11 + 刀轴 EX-02C + 刀盘 EX-01-tooth + 隔套 EX-07-20 + 带轮 DR-P60
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const design = 'ASM-U2S1'
const path = join(P, design + '.SLDASM')
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 240000); t.unref() })
const ctr = (k) => [(k.box[0] + k.box[3]) / 2, (k.box[1] + k.box[4]) / 2, (k.box[2] + k.box[5]) / 2]

const phi = 45
const rad = phi * Math.PI / 180
const P0 = [185, 35 * Math.cos(rad), 35 * Math.sin(rad)]
const u = [0, -Math.sin(rad), Math.cos(rad)]
const at = (s) => [P0[0] + s * u[0], P0[1] + s * u[1], P0[2] + s * u[2]]
const r2 = (v) => v.map((x) => Math.round(x * 10000) / 10000)
console.log('P0=' + r2(P0).join(','), 'u=' + r2(u).join(','))

const parts = [
  { file: 'FR-11.SLDPRT', center: [185, 0, 0], spin: 0, tag: 'ring' },
  { file: 'EX-02C.SLDPRT', center: at(30), spin: -45, tag: 'shaft' },
  { file: 'EX-01-tooth.SLDPRT', center: at(0), spin: -45, tag: 'blade' },
  { file: 'EX-07-20.SLDPRT', center: at(30), spin: -45, tag: 'spacer' },
  { file: 'DR-P60.SLDPRT', center: at(110), spin: -45, tag: 'pulley' },
]

await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
if (existsSync(path)) { try { unlinkSync(path) } catch (e) { console.log('unlink', e.message) } }
const made = await send({ op: 'assemblyNew', path, designId: design })
console.log('assemblyNew', made.ok)
const ins = await send({ op: 'componentInsert', designId: design, components: parts.map((p) => ({ path: join(P, p.file), x: p.center[0], y: p.center[1], z: p.center[2], placement: 'bbox-center' })) })
console.log('insert', ins.ok, 'n=' + (ins.inserted || []).length, 'fail=' + (ins.failed || []).length)
if ((ins.inserted || []).length !== parts.length) { console.log(JSON.stringify(ins.failed)); }

for (const p of parts) {
  let list = (await send({ op: 'components', designId: design })).components || []
  const me = list.find((k) => k.path.toLowerCase().endsWith(p.file.toLowerCase()) && Math.hypot(...[0, 1, 2].map((i) => ctr(k)[i] - p.center[i])) < 60)
  if (!me) { console.log('MISS', p.tag); continue }
  await send({ op: 'componentRotate', designId: design, component: me.name, axis: 'y', angleDeg: 90, x: p.center[0], y: p.center[1], z: p.center[2] })
  if (p.spin !== 0) await send({ op: 'componentRotate', designId: design, component: me.name, axis: 'z', angleDeg: p.spin, x: p.center[0], y: p.center[1], z: p.center[2] })
  let ok = false
  for (let it = 0; it < 6; it++) {
    list = (await send({ op: 'components', designId: design })).components || []
    const c2 = list.find((k) => k.name === me.name)
    if (!c2) break
    const c = ctr(c2)
    const d = [p.center[0] - c[0], p.center[1] - c[1], p.center[2] - c[2]]
    if (Math.hypot(d[0], d[1], d[2]) < 0.02) { ok = true; break }
    await send({ op: 'componentTranslate', designId: design, component: me.name, dx: d[0], dy: d[1], dz: d[2] })
  }
  console.log(p.tag.padEnd(7), me.name.padEnd(12), 'centered=' + ok, 'target=' + r2(p.center).join(','))
}
const sv = await send({ op: 'save', designId: design })
const finalList = (await send({ op: 'components', designId: design })).components || []
const out = { design, at: new Date().toISOString(), saved: sv.ok, P0: r2(P0), u: r2(u), rows: [] }
for (const k of finalList) {
  const c = ctr(k)
  out.rows.push({ name: k.name, center: c.map((v) => +v.toFixed(3)), size: [k.box[3] - k.box[0], k.box[4] - k.box[1], k.box[5] - k.box[2]].map((v) => +v.toFixed(2)) })
  console.log(String(k.name).padEnd(12), 'c=' + out.rows[out.rows.length - 1].center.join(','), 'size=' + out.rows[out.rows.length - 1].size.join('x'))
}
writeFileSync(join(P, design + '.u2.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('saved', sv.ok, 'N', finalList.length)
child.stdin.end(); setTimeout(() => child.kill(), 100)