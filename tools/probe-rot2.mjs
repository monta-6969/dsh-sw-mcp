import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 120000); t.unref() })
const show = async (tag) => {
  const c = await send({ op: 'components', designId: 'TESTR2' })
  const k = (c.components || []).find((x) => x.name === 'FR-11-1')
  if (!k) { console.log(tag, 'not found'); return }
  console.log(tag.padEnd(12), 'box=' + k.box.join(','), 'T9=' + (k.transform || []).slice(0, 9).map((v) => Math.round(v * 1000) / 1000).join(','))
}
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
await send({ op: 'assemblyNew', path: join(P, 'TESTR2.SLDASM'), designId: 'TESTR2' })
await send({ op: 'componentInsert', designId: 'TESTR2', components: [{ path: join(P, 'FR-11.SLDPRT'), x: 0, y: 0, z: 0, placement: 'bbox-center' }] })
await show('t0')
await send({ op: 'componentRotate', designId: 'TESTR2', component: 'FR-11-1', axis: 'y', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t1 y90')
await send({ op: 'componentRotate', designId: 'TESTR2', component: 'FR-11-1', axis: 'z', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t2 z90')
await send({ op: 'componentRotate', designId: 'TESTR2', component: 'FR-11-1', axis: 'z', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t3 z180')
await send({ op: 'close', title: 'TESTR2.SLDASM', allowDirty: true })
child.stdin.end(); setTimeout(() => child.kill(), 100)