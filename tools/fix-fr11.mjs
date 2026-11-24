// 重建 FR-11 真环：先清空文档保证活动文档=新建文档，再 SaveAs，最后自证体积/包围盒。
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
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 300000); t.unref() })
const com = (o) => { const f = (x) => { if (!x || typeof x !== 'object') return null; if (x.kind === 'comObject' && x.handle) return x; for (const k of Object.keys(x)) { const r = f(x[k]); if (r) return r } return null }; return f(o) }
const J = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }

// 1 清场：所有文档关掉，避免 SaveAs 存错文档（今天 FR-11 就是这样被写坏的）
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
let st = await send({ op: 'status' })
console.log('docs before build:', (st.documents || []).length)

const ring = { schemaVersion: 3, units: 'mm', features: [
  { kind: 'sketch', id: 'ring', plane: 0, primitives: [
    { shape: 'circle', center: [0, 0], diameter: 180 }, { shape: 'circle', center: [0, 0], diameter: 128 },
    { shape: 'circle', center: [-24.51, 74.03], diameter: 16 }, { shape: 'circle', center: [74.03, -24.51], diameter: 16 },
    { shape: 'circle', center: [84, 0], diameter: 6.6 }, { shape: 'circle', center: [0, 84], diameter: 6.6 },
    { shape: 'circle', center: [-84, 0], diameter: 6.6 }, { shape: 'circle', center: [0, -84], diameter: 6.6 }
  ] },
  { kind: 'extrude', id: 'body', profile: 'ring', depth: 6 } ] }

const b = await send({ op: 'build', designId: 'FR11R', definition: ring })
const g = b.geometry || {}
console.log('build ok=' + b.ok, 'title=' + (b.document && b.document.title), 'vol=' + (g.massProperties && g.massProperties.volume), 'box=' + (g.boundingBox && g.boundingBox.size.join('x')))
st = await send({ op: 'status' })
const docs = st.documents || []
console.log('docs after build:', docs.map((d) => d.title + (d.saved ? '' : '(unsaved)')).join(' , '))
if (docs.length !== 1) { console.log('ABORT: 不是恰好一个文档，拒绝 SaveAs'); child.stdin.end(); setTimeout(() => child.kill(), 100); process.exit(1) }

const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [] }))?.handle
const outPath = join(P, 'FR-11.SLDPRT')
const sa = await send({ op: 'object', action: 'call', handle: ext, member: 'SaveAs3', iface: 'IModelDocExtension', args: [outPath, 0, 1, null, null, 0, 0] })
console.log('SaveAs3 ok=' + sa.ok, J(sa.error || {}).slice(0, 200))

// 2 关掉再重开，确认磁盘上的是这个环
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const chk = await send({ op: 'bodies', path: outPath })
console.log('disk check:', J(chk).slice(0, 400))
child.stdin.end(); setTimeout(() => child.kill(), 100)