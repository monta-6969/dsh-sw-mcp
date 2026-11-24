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
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 180000); t.unref() })
const com = (o) => { const f = (x) => { if (!x || typeof x !== 'object') return null; if (x.kind === 'comObject' && x.handle) return x; for (const k of Object.keys(x)) { const r = f(x[k]); if (r) return r } return null }; return f(o) }
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }

await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const ring = { schemaVersion: 3, units: 'mm', features: [
  { kind: 'sketch', id: 'ring', plane: 0, primitives: [
    { shape: 'circle', center: [0, 0], diameter: 180 }, { shape: 'circle', center: [0, 0], diameter: 128 },
    { shape: 'circle', center: [-24.51, 74.03], diameter: 16 }, { shape: 'circle', center: [74.03, -24.51], diameter: 16 },
    { shape: 'circle', center: [84, 0], diameter: 6.6 }, { shape: 'circle', center: [0, 84], diameter: 6.6 },
    { shape: 'circle', center: [-84, 0], diameter: 6.6 }, { shape: 'circle', center: [0, -84], diameter: 6.6 }
  ] },
  { kind: 'extrude', id: 'body', profile: 'ring', depth: 6 } ] }
const b = await send({ op: 'build', designId: 'FR11C', definition: ring })
const g = b.geometry || {}
console.log('1 build vol=' + (g.massProperties && g.massProperties.volume) + ' box=' + (g.boundingBox && g.boundingBox.size.join('x')) + ' title=' + (b.document && b.document.title))
const bd = await send({ op: 'bodies', designId: 'FR11C' })
console.log('2 in-memory bodies=' + bd.count + ' vol=' + bd.totalVolumeMm3)
const outPath = join(P, 'FR-11-NEW.SLDPRT')
const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [] }))?.handle
const sa = await send({ op: 'object', action: 'call', handle: ext, member: 'SaveAs3', iface: 'IModelDocExtension', args: [outPath, 0, 1, null, null, 0, 0] })
console.log('3 SaveAs3 new path ok=' + sa.ok + ' ' + J(sa.error || sa.outArgs || {}).slice(0, 120))
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const op2 = await send({ op: 'open', path: outPath, designId: 'FR11D' })
console.log('4 reopen ok=' + op2.ok + ' warnings=' + op2.warnings + ' faces=' + op2.faces)
const bd2 = await send({ op: 'bodies', designId: 'FR11D' })
console.log('5 on-disk bodies=' + bd2.count + ' vol=' + bd2.totalVolumeMm3 + ' box=' + (bd2.bodies && bd2.bodies[0] && bd2.bodies[0].box && bd2.bodies[0].box.size.join('x')))
child.stdin.end(); setTimeout(() => child.kill(), 100)