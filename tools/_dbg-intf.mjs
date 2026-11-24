import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeExe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const child = spawn(bridgeExe, (process.env.SW_MCP_INSTANCE_PID ? ['--instance', process.env.SW_MCP_INSTANCE_PID] : []), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let seq = 1
const send = (req) => new Promise((res, rej) => { waiters.push(res); req.id = seq++; child.stdin.write(JSON.stringify(req) + '\n'); const t = setTimeout(() => rej(new Error('timeout')), 120000); t.unref() })
const dig = (o, kind) => { if (!o || typeof o !== 'object') return null; if (o.kind === kind && o.handle) return o; for (const k of Object.keys(o)) { const r = dig(o[k], kind); if (r) return r } return null }
const mgr = await send({ op: 'invoke', target: 'assemblyDoc', designId: 'ASM-DEMO', member: 'get_InterferenceDetectionManager', args: [] })
const mh = dig(mgr, 'comObject').handle
const res = await send({ op: 'object', action: 'call', handle: mh, member: 'GetInterferences', args: [] })
const arr = dig(res, 'array')
const h0 = arr.items[0].handle
console.log('COMPONENTS', JSON.stringify(await send({ op: 'object', action: 'get', handle: h0, member: 'Components', iface: 'IInterference' })))
console.log('COUNT', JSON.stringify(await send({ op: 'object', action: 'call', handle: h0, member: 'GetComponentCount', args: [], iface: 'IInterference' })))
console.log('IGET0', JSON.stringify(await send({ op: 'object', action: 'call', handle: h0, member: 'IGetComponents', args: [1], iface: 'IInterference' })))
child.stdin.end(); setTimeout(() => child.kill(), 100)