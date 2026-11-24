import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const design = 'ASM-U1B'
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + (r.op || '') + (r.member || ''))), 240000); t.unref() })
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }

const made = await send({ op: 'assemblyNew', path: join(P, design + '.SLDASM'), designId: design })
console.log('assemblyNew', made.ok, J(made.error || { title: made.title, path: made.path, designId: made.designId }).slice(0, 240))

const stations = [[185, 45], [199, 135], [213, 225], [227, 315]]
const comps = []
for (const [x] of stations) comps.push({ path: join(P, 'FR-11.SLDPRT'), x, y: 0, z: 0, placement: 'bbox-center' })
for (const [y, z] of [[79, 0], [0, 79], [-79, 0], [0, -79]]) comps.push({ path: join(P, 'FR-12.SLDPRT'), x: 209, y, z, placement: 'bbox-center' })

const ins = await send({ op: 'componentInsert', designId: design, components: comps })
console.log('insert', ins.ok, J(ins.error || { inserted: (ins.inserted || []).length, failed: ins.failed, skipped: ins.skipped }).slice(0, 400))

let c = await send({ op: 'components', designId: design })
const list = c.components || []
console.log('components', list.length)

for (const [x, phi] of stations) {
  const ring = list.find((k) => k.name.startsWith('FR-11') && Math.abs((k.box[0] + k.box[3]) / 2 - x) < 1)
  if (!ring) { console.log('MISS ring at', x); continue }
  await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'y', angleDeg: 90, x, y: 0, z: 0 })
  const delta = phi + 45
  if (delta % 360 !== 0) await send({ op: 'componentRotate', designId: design, component: ring.name, axis: 'x', angleDeg: delta, x, y: 0, z: 0 })
  console.log('rotated', ring.name, 'delta', delta)
}

const sv = await send({ op: 'save', designId: design })
console.log('save', sv.ok, J(sv.error || sv.path || {}).slice(0, 160))

c = await send({ op: 'components', designId: design })
for (const k of (c.components || [])) console.log(k.name.padEnd(10), 'box', k.box.join(','), 'T', (k.transform || []).map((v) => Math.round(v * 1000) / 1000).slice(0, 9).join(','))
child.stdin.end(); setTimeout(() => child.kill(), 100)