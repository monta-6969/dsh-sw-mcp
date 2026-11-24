// 在装配体里建一个剖视图并截图。只读诊断用：不改模型几何，只改视图状态。
// 用法: SW_MCP_INSTANCE_PID=20356 node tools/section-shot.mjs --out a.png [--plane "Front Plane"] [--offset 0] [--view Isometric]
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bridgeExe = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const out = arg('out', 'section.png')
const planeName = arg('plane', '上视基准面')
const offset = Number(arg('offset', '0'))
const view = arg('view', 'Front')

const child = spawn(bridgeExe, process.env.SW_MCP_INSTANCE_PID ? ['--instance', process.env.SW_MCP_INSTANCE_PID] : [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
child.stdout.setEncoding('utf8')
let buf = ''; const waiters = []
child.stdout.on('data', (c) => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line) } catch { continue } const w = waiters.shift(); if (w) w(m) } })
let seq = 1
const send = (req) => new Promise((res, rej) => { waiters.push(res); req.id = seq++; child.stdin.write(JSON.stringify(req) + '\n'); const t = setTimeout(() => rej(new Error('timeout')), 180000); t.unref() })
const com = (o) => { const f = (x) => { if (!x || typeof x !== 'object') return null; if (x.kind === 'comObject' && x.handle) return x; for (const k of Object.keys(x)) { const r = f(x[k]); if (r) return r } return null }; return f(o) }
const step = async (label, req) => { const r = await send(req); const ok = r.ok !== false; console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : ' :: ' + JSON.stringify(r.error).slice(0, 200)}`); return r }

// 1. 选基准面
await step('select plane', { op: 'invoke', target: 'doc', member: 'get_Extension', args: [] })
const ext = com(await send({ op: 'invoke', target: 'doc', member: 'get_Extension', args: [] }))?.handle
const sel = await step('SelectByID2', { op: 'object', action: 'call', handle: ext, member: 'SelectByID2', iface: 'IModelDocExtension', args: [planeName, 'PLANE', 0, 0, 0, false, 0, null, 0] })
const selOk = sel?.result?.result
const sm = com(await send({ op: 'invoke', target: 'doc', member: 'get_SelectionManager', args: [] }))?.handle
const picked = await send({ op: 'object', action: 'call', handle: sm, member: 'GetSelectedObject6', iface: 'ISelectionMgr', args: [1, -1] })
const ph = com(picked)?.handle
console.log('plane handle', ph, 'select result', selOk)

// 2. 建 SectionViewData
const mvm = com(await send({ op: 'invoke', target: 'doc', member: 'get_ModelViewManager', args: [] }))?.handle
const data = com(await send({ op: 'object', action: 'call', handle: mvm, member: 'CreateSectionViewData', iface: 'IModelViewManager', args: [] }))?.handle
console.log('data handle', data)

const t = (m, v) => send({ op: 'object', action: 'set', handle: data, member: m, iface: 'ISectionViewData', value: v })
if (ph) console.log('set FirstPlane', (await t('FirstPlane', { $ref: ph })).ok)
console.log('set FirstOffset', (await t('FirstOffset', offset)).ok)
console.log('set ShowSectionCap', (await t('ShowSectionCap', true)).ok)
console.log('set Redraw', (await t('Redraw', true)).ok)


const made = await send({ op: 'object', action: 'call', handle: mvm, member: 'CreateSectionView', iface: 'IModelViewManager', args: [{ $ref: data }] })
console.log('CreateSectionView ->', JSON.stringify(made.result ?? made.error).slice(0, 200))

// 3. 视角 + 截图
const cap = await send({ op: 'capture', path: out, designId: 'ASM-DEMO', view, mutateView: true, zoomToFit: true, width: 1600, height: 1100 })
console.log('capture ->', JSON.stringify(cap.error ?? { path: cap.path, bytes: cap.bytes, applied: cap.applied }).slice(0, 300))
child.stdin.end(); setTimeout(() => child.kill(), 200)