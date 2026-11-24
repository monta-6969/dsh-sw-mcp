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
const seg = [[62,5],[62,7],[66,7],[66,5],[74,5],[74,7],[78,7],[78,5],[200,5],[200,0],[0,0],[0,5]]
const def = { schemaVersion: 3, units: 'mm', features: [
  { kind: 'sketch', id: 'prof', plane: 0, axis: 'x', axisSpan: 210, primitives: [ { shape: 'path', closed: true, start: [0,5], segments: seg.map((p) => ({ to: p })) } ] },
  { kind: 'revolve', id: 'shaft', profile: 'prof', angle: 360, axis: 'x' } ] }
const b = await send({ op: 'build', designId: 'EX02CR', definition: def })
const g = b.geometry || {}
const title = b.document && b.document.title
console.log('build', b.ok, 'title=' + title, 'vol=' + (g.massProperties && g.massProperties.volume), 'box=' + (g.boundingBox && g.boundingBox.size.join('x')))
if (!b.ok) { console.log(J(b.error).slice(0, 300)); child.stdin.end(); setTimeout(() => child.kill(), 100); process.exit(1) }
await send({ op: 'invoke', target: 'app', member: 'ActivateDoc3', args: [title, true, 1, 0] })
await send({ op: 'invoke', target: 'doc', member: 'EditRebuild3', args: [] })
const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [] }))?.handle
const outPath = join(P, 'EX-02C.SLDPRT')
const sa = await send({ op: 'object', action: 'call', handle: ext, member: 'SaveAs3', iface: 'IModelDocExtension', args: [outPath, 0, 1, null, null, 0, 0] })
console.log('SaveAs3', sa.ok, J(sa.error || {}).slice(0, 120))
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const op2 = await send({ op: 'open', path: outPath, designId: 'EX02CV' })
const bd = await send({ op: 'bodies', designId: 'EX02CV' })
console.log('reopen ok=' + op2.ok, 'vol=' + bd.totalVolumeMm3, 'box=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.size.join('x')), 'min=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.min.join(',')), 'max=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.max.join(',')))
child.stdin.end(); setTimeout(() => child.kill(), 100)