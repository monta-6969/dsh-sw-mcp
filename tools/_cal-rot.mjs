import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const d = 'ASM-U1B'
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout')), 120000); t.unref() })
const read = async (name) => { const c = await send({ op: 'components', designId: d }); const k = (c.components || []).find((x) => x.name === name); return k ? (k.transform || []).slice(0, 9).join(',') : 'MISSING' }
console.log('before ', await read('FR-11-1'))
const r1 = await send({ op: 'componentRotate', designId: d, component: 'FR-11-1', axis: 'y', angleDeg: 90, x: 185, y: 0, z: 0 })
console.log('rotY', r1.ok, JSON.stringify(r1.error || {}).slice(0, 100))
console.log('afterY ', await read('FR-11-1'))
const r2 = await send({ op: 'componentRotate', designId: d, component: 'FR-11-1', axis: 'x', angleDeg: 90, x: 185, y: 0, z: 0 })
console.log('rotX', r2.ok, JSON.stringify(r2.error || {}).slice(0, 100))
console.log('afterX ', await read('FR-11-1'))
child.stdin.end(); setTimeout(() => child.kill(), 100)