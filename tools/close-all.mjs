// 关掉 SW 里所有打开的文档（含未命名的“零件N”草稿），只留进程。
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const w = []
child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const f = w.shift(); if (f) f(m) } })
let n = 1
const send = (r) => new Promise((res) => { w.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); setTimeout(() => res({ timeout: true }), 30000) })
const st = await send({ op: 'status' })
const docs = st.documents || []
console.log('open docs:', docs.length)
for (const d of docs) {
  const r = await send({ op: 'close', title: d.title })
  console.log((r.ok === false ? 'FAIL ' : 'closed ') + d.title + (d.dirty ? '  (discarded edits)' : ''))
}
const st2 = await send({ op: 'status' })
console.log('remaining:', (st2.documents || []).length)
child.stdin.end(); setTimeout(() => child.kill(), 100)