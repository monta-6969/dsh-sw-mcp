// 单元审查卡：三视图 + 剖视 + 干涉 + 数值栏，一次生成一张卡和一个 json。
// 用法: SW_MCP_INSTANCE_PID=2320 node tools/unit-report.mjs --design ASM-U1 --outdir "…\shots\u1" --title "U1 基座单元" --notes "…\notes.txt"
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const py = join(repoRoot, '.venv', 'Scripts', 'python.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const design = arg('design', '')
const outdir = arg('outdir', '.')
const title = arg('title', design)
const subtitle = arg('subtitle', new Date().toISOString().slice(0, 16).replace('T', ' '))
const notesFile = arg('notes', '')
const sectionPlane = arg('plane', '上视基准面')
const sectionOffset = Number(arg('offset', '0'))
mkdirSync(outdir, { recursive: true })

const child = spawn(exe, ['--instance', process.env.SW_MCP_INSTANCE_PID || ''], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; let m; try { m = JSON.parse(l) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let n = 1
const send = (r) => new Promise((res, rej) => { waiters.push(res); r.id = n++; child.stdin.write(JSON.stringify(r) + '\n'); const t = setTimeout(() => rej(new Error('timeout ' + r.op + '/' + (r.member || ''))), 180000); t.unref() })
const com = (o) => { const f = (x) => { if (!x || typeof x !== 'object') return null; if (x.kind === 'comObject' && x.handle) return x; for (const k of Object.keys(x)) { const r = f(x[k]); if (r) return r } return null }; return f(o) }
const shot = async (tag, view, id) => {
  await send({ op: 'invoke', target: 'doc', member: 'ShowNamedView2', args: [view, id], designId: design })
  await send({ op: 'invoke', target: 'doc', member: 'ViewZoomtofit2', args: [], designId: design })
  const p = join(outdir, `${tag}.png`)
  const c = await send({ op: 'capture', path: p, width: 1200, height: 900, designId: design })
  return c.ok ? p : null
}

const out = { design, title, subtitle, at: new Date().toISOString(), images: {}, steps: [] }

// 0 清掉可能残留的剖视
const mvm = com(await send({ op: 'invoke', target: 'doc', member: 'get_ModelViewManager', args: [], designId: design }))
let mvmH = mvm && mvm.handle
if (mvmH) { try { await send({ op: 'object', action: 'call', handle: mvmH, member: 'RemoveSectionView', iface: 'IModelViewManager', args: [] }) } catch {} }

// 1 三视图
out.images.iso = await shot('iso', '等轴测', 7)
out.images.front = await shot('front', '前视', 1)
out.images.top = await shot('top', '上视', 6)
out.steps.push({ step: 'three-views', ok: !!(out.images.iso && out.images.front && out.images.top) })

// 2 剖视
let sectionOk = false
try {
  const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [], designId: design })).handle
  await send({ op: 'invoke', target: 'doc', member: 'ClearSelection2', args: [true], designId: design })
  await send({ op: 'object', action: 'call', handle: ext, member: 'SelectByID2', iface: 'IModelDocExtension', args: [sectionPlane, 'PLANE', 0, 0, 0, false, 0, null, 0] })
  const sm = com(await send({ op: 'invoke', target: 'doc', member: 'get_SelectionManager', args: [], designId: design })).handle
  const ph = com(await send({ op: 'object', action: 'call', handle: sm, member: 'GetSelectedObject6', iface: 'ISelectionMgr', args: [1, -1] }))?.handle
  if (ph) {
    const data = com(await send({ op: 'object', action: 'call', handle: mvmH, member: 'CreateSectionViewData', iface: 'IModelViewManager', args: [] })).handle
    for (const [m, v] of [['FirstPlane', { $ref: ph }], ['FirstOffset', sectionOffset], ['ShowSectionCap', true], ['Redraw', true]]) {
      await send({ op: 'object', action: 'set', handle: data, member: m, iface: 'ISectionViewData', value: v })
    }
    const made = await send({ op: 'object', action: 'call', handle: mvmH, member: 'CreateSectionView', iface: 'IModelViewManager', args: [{ $ref: data }] })
    sectionOk = made.result === true
  }
} catch (e) { out.steps.push({ step: 'section', error: String(e.message).slice(0, 120) }) }
if (sectionOk) {
  out.images.section = await shot('section', '等轴测', 7)
  if (!out.images.section) out.images.section = await shot('section', '前视', 1)
  try { await send({ op: 'object', action: 'call', handle: mvmH, member: 'RemoveSectionView', iface: 'IModelViewManager', args: [] }) } catch {}
}
out.steps.push({ step: 'section-view', ok: !!out.images.section })

// 3 干涉
const auditOut = join(outdir, 'interference.json')
const r = spawnSync(process.execPath, [join(repoRoot, 'tools', 'asm-audit.mjs'), '--design', design, '--out', auditOut], { env: process.env, encoding: 'utf8' })
try { out.interference = JSON.parse(readFileSync(auditOut, 'utf8')) } catch { out.interference = { count: null, error: (r.stdout || r.stderr || '').slice(0, 300) } }

// 4 数值栏
const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : [
  `干涉：${out.interference.count ?? '?'} 处`,
].join('\n')
const imgs = ['iso', 'front', 'top', 'section'].map((k) => out.images[k]).filter(Boolean).join(',')
const cardOut = join(outdir, 'card.png')
if (imgs) {
  const pyres = spawnSync(py, [join(repoRoot, 'tools', 'card.py'), '--out', cardOut, '--title', title, '--subtitle', subtitle, '--images', imgs, '--notes', notes], { encoding: 'utf8' })
  out.card = pyres.status === 0 ? cardOut : null
  if (pyres.status !== 0) out.cardError = (pyres.stderr || '').slice(0, 200)
}
writeFileSync(join(outdir, 'report.json'), JSON.stringify(out, null, 2), 'utf8')
console.log(JSON.stringify({ design, images: Object.fromEntries(Object.entries(out.images).map(([k, v]) => [k, !!v])), interference: out.interference.count, card: out.card }, null, 2))
child.stdin.end(); setTimeout(() => child.kill(), 100)