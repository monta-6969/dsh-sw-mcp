// 通用建件：清场 → build → 激活+重建 → SaveAs → 关 → 重开验证
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const [defPath, outPath, designId] = process.argv.slice(2)
const def = JSON.parse(readFileSync(defPath, 'utf8'))
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 180000); t.unref() })
const com = (o) => { const f = (x) => { if (!x || typeof x !== 'object') return null; if (x.kind === 'comObject' && x.handle) return x; for (const k of Object.keys(x)) { const r = f(x[k]); if (r) return r } return null }; return f(o) }
const P = 'C:\\Users\\mota\\Desktop\\工程自动化\\竹序\\R9-四瓣机\\建模\\parts'
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const b = await send({ op: 'build', designId, definition: def })
if (!b.ok) { console.log('BUILD FAIL', JSON.stringify(b.error).slice(0, 300)); process.exit(1) }
const title = b.document && b.document.title
const g = b.geometry || {}
console.log('build ok title=' + title + ' vol=' + (g.massProperties && g.massProperties.volume) + ' box=' + (g.boundingBox && g.boundingBox.size.join('x')))
await send({ op: 'invoke', target: 'app', member: 'ActivateDoc3', args: [title, true, 1, 0] })
await send({ op: 'invoke', target: 'doc', member: 'EditRebuild3', args: [] })
const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [] }))?.handle
const sa = await send({ op: 'object', action: 'call', handle: ext, member: 'SaveAs3', iface: 'IModelDocExtension', args: [outPath, 0, 1, null, null, 0, 0] })
if (!sa.ok) { console.log('SAVE FAIL', JSON.stringify(sa.error).slice(0, 200)); process.exit(1) }
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
const op2 = await send({ op: 'open', path: outPath, designId: designId + 'V' })
const bd = await send({ op: 'bodies', designId: designId + 'V' })
console.log('verify reopen=' + op2.ok + ' vol=' + bd.totalVolumeMm3 + ' box=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.size.join('x')) + ' min=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.min.join(',')) + ' max=' + (bd.bodies && bd.bodies[0] && bd.bodies[0].box.max.join(',')))
await send({ op: 'close', pathPrefix: P, untitled: true, allowDirty: true })
child.stdin.end(); setTimeout(() => child.kill(), 100)