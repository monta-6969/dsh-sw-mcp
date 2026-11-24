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
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }
const show = async (tag, name) => {
  const c = await send({ op: 'components', designId: 'TESTR' })
  const k = (c.components || []).find((x) => x.name === name)
  if (!k) { console.log(tag, 'not found'); return }
  console.log(tag.padEnd(14), 'box=' + k.box.join(','), 'T9=' + (k.transform || []).slice(0, 9).map((v) => Math.round(v * 1000) / 1000).join(','))
}

await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const made = await send({ op: 'assemblyNew', path: join(P, 'TESTR.SLDASM'), designId: 'TESTR' })
console.log('assemblyNew', made.ok)
const ins = await send({ op: 'componentInsert', designId: 'TESTR', components: [{ path: join(P, 'FR-11.SLDPRT'), x: 0, y: 0, z: 0, placement: 'bbox-center' }] })
const name = ((ins.inserted || [])[0] || {}).name
console.log('inserted', name, J((ins.inserted || [])[0] || {}).slice(0, 220))
await show('t0 inserted', name)
await send({ op: 'componentRotate', designId: 'TESTR', component: name, axis: 'y', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t1 after y90', name)
await send({ op: 'componentRotate', designId: 'TESTR', component: name, axis: 'x', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t2 after x90', name)
await send({ op: 'componentRotate', designId: 'TESTR', component: name, axis: 'x', angleDeg: 90, x: 0, y: 0, z: 0 })
await show('t3 after x180', name)
await send({ op: 'close', title: 'TESTR.SLDASM', allowDirty: true })
child.stdin.end(); setTimeout(() => child.kill(), 100)