// 逐对列出装配体干涉：哪两个件、体积多少。只读，不改模型。
// 用法: SW_MCP_INSTANCE_PID=20356 node tools/asm-audit.mjs --design ASM-DEMO [--out x.json] [--only NAME]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeExe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const design = arg('design', 'ASM-DEMO')
const pid = process.env.SW_MCP_INSTANCE_PID || ''
const out = arg('out', '')
const only = arg('only', '')

const child = spawn(bridgeExe, pid ? ['--instance', pid] : [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''
const waiters = []
child.stdout.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    const w = waiters.shift(); if (w) w(msg)
  }
})
let seq = 1
function send(req) {
  return new Promise((resolve, reject) => {
    waiters.push(resolve)
    req.id = seq++
    child.stdin.write(JSON.stringify(req) + '\n')
    const t = setTimeout(() => reject(new Error('TIMEOUT')), 180000)
    t.unref()
  })
}
const first = (o, pred) => {
  if (!o || typeof o !== 'object') return null
  if (pred(o)) return o
  for (const k of Object.keys(o)) { const r = first(o[k], pred); if (r) return r }
  return null
}
const anyCom = (o) => first(o, (x) => x.kind === 'comObject' && x.handle)
const raw = (o) => {
  if (o == null) return null
  if (typeof o !== 'object') return o
  if ('result' in o && !('ok' in o)) return raw(o.result)
  if ('result' in o) return raw(o.result)
  return null
}
const num = (o) => {
  const v = raw(o)
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && typeof v.value === 'number') return v.value
  return null
}

try {
  const mgr = await send({ op: 'invoke', target: 'assemblyDoc', designId: design, member: 'get_InterferenceDetectionManager', args: [] })
  const mh = anyCom(mgr)?.handle
  if (!mh) throw new Error('no manager handle')
  await send({ op: 'object', action: 'call', handle: mh, member: 'TreatCoincidenceAsInterference', args: [false] })
  const res = await send({ op: 'object', action: 'call', handle: mh, member: 'GetInterferences', args: [] })
  const arr = first(res, (x) => x.kind === 'array' && Array.isArray(x.items))
  if (!arr) { const summary = { design, at: new Date().toISOString(), count: 0, totalVolumeMm3: 0, rows: [] }; if (out) writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8'); console.log('TOTAL 0   （GetInterferences 返回 null = 无干涉）'); child.stdin.end(); setTimeout(() => child.kill(), 100); process.exit(0) }
  const rows = []
  for (const item of arr.items) {
    const row = { index: rows.length, volume_mm3: null, parts: [], fastener: null, possible: null, note: '' }
    const v = num(await send({ op: 'object', action: 'get', handle: item.handle, member: 'Volume', iface: 'IInterference' }))
    row.volume_mm3 = v == null ? null : Number((v * 1e9).toFixed(3))
    const compsResp = await send({ op: 'object', action: 'get', handle: item.handle, member: 'Components', iface: 'IInterference' })
    const cArr = first(compsResp, (x) => x.kind === 'array' && Array.isArray(x.items))
    const handles = cArr ? cArr.items.map((x) => x.handle).filter(Boolean) : []
    row.componentCount = handles.length
    for (const ch of handles) {
      let name = null
      try { name = raw(await send({ op: 'object', action: 'get', handle: ch, member: 'Name2', iface: 'IComponent2' })) } catch (e) { row.note += 'name:' + e.message.slice(0, 30) }
      row.parts.push(name)
    }
    if (!only || row.parts.some((p) => p && String(p).includes(only))) rows.push(row)
  }
  const totalVol = rows.reduce((a, r) => a + (r.volume_mm3 || 0), 0)
  const summary = { design, at: new Date().toISOString(), count: rows.length, totalVolumeMm3: Number(totalVol.toFixed(2)), rows }
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8')
  for (const r of rows) console.log(`#${r.index}  ${r.parts.join('  x  ')}   ${r.volume_mm3} mm3  ${r.note}`)
  console.log('TOTAL ' + rows.length + '  体积合计 ' + summary.totalVolumeMm3 + ' mm3')
} catch (e) {
  console.error('FAIL ' + e.message)
  process.exitCode = 1
} finally {
  try { child.stdin.end() } catch {}
  setTimeout(() => child.kill(), 100)
}