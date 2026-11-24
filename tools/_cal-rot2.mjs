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
const read = async (name) => { const c = await send({ op: 'components', designId: d }); const k = (c.components || []).find((x) => x.name === name); return k ? (k.transform || []).slice(0, 9) : null }
const rot = async (name, axis, deg, x) => { await send({ op: 'componentRotate', designId: d, component: name, axis, angleDeg: deg, x, y: 0, z: 0 }); return read(name) }

console.log('S3 before', (await read('FR-11-3')).join(','))
let t = await rot('FR-11-3', 'y', 90, 213)
console.log('S3  +Y90 ', t.join(','))
t = await rot('FR-11-3', 'x', 270, 213)
console.log('S3  +X270', t.join(','))
console.log('S4 before', (await read('FR-11-4')).join(','))
t = await rot('FR-11-4', 'y', 180, 227)
console.log('S4  +Y180', t.join(','))
await send({ op: 'save', designId: d })
console.log('saved')
child.stdin.end(); setTimeout(() => child.kill(), 100)