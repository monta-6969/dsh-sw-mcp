// 零件只读核验 + 四视图取证。
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const part = arg('part', '')
const outdir = arg('outdir', '.')
const design = arg('design', basename(part).replace(/\.[^.]+$/, ''))
mkdirSync(outdir, { recursive: true })
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op)), 180000); t.unref() })
const show = (x) => { try { return JSON.stringify(x) } catch { return String(x) } }

const opened = await send({ op: 'open', path: part, readOnly: true, designId: design })
console.log('open', opened.ok, show(opened.document || opened.error || {}).slice(0, 200))
const bodies = await send({ op: 'bodies', designId: design })
if (bodies.ok) console.log('bodies', show({ count: bodies.count, totalVolumeMm3: bodies.totalVolumeMm3, box: bodies.bodies?.[0]?.box, faces: bodies.bodies?.[0]?.faces }))
else console.log('bodies FAIL', show(bodies.error).slice(0, 240))
for (const [tag, name, id] of [['iso', '等轴测', 7], ['front', '前视', 1], ['top', '上视', 6], ['right', '右视', 5]]) {
  await send({ op: 'invoke', target: 'doc', member: 'ShowNamedView2', args: [name, id], designId: design })
  await send({ op: 'invoke', target: 'doc', member: 'ViewZoomtofit2', args: [], designId: design })
  const c = await send({ op: 'capture', path: join(outdir, `${tag}.png`), width: 1200, height: 900, designId: design })
  console.log('  ', tag, c.ok ? c.bytes + 'B' : show(c.error).slice(0, 140))
}
child.stdin.end(); setTimeout(() => child.kill(), 100)