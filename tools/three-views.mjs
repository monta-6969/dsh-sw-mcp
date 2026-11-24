// 三视图取证：iso / front / top，各存一张 PNG。只改视图，不改几何。
// 用法: SW_MCP_INSTANCE_PID=20356 node tools/three-views.mjs --design ASM-DEMO --prefix out\asm [--suffix ""]
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const design = arg('design', 'ASM-DEMO')
const prefix = arg('prefix', 'shot')
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout')), 120000); t.unref() })
for (const [tag, view] of [['iso', '等轴测'], ['front', '前视'], ['top', '上视'], ['right', '右视']]) {
  const r = await send({ op: 'capture', path: `${prefix}-${tag}.png`, designId: design, view, mutateView: true, zoomToFit: true, width: 1400, height: 1000 })
  console.log(tag, view, r.ok ? `${r.bytes} B` : JSON.stringify(r.error).slice(0, 160))
}
child.stdin.end(); setTimeout(() => child.kill(), 100)