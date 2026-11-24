// 代表性任务的前后对照探针（不进全套；需要已启动的 SOLIDWORKS）。
//
// 任务：100×60×20 板 + Ø10 贯穿孔，改两次宽度、再改一次厚度。
// 记录 build/edit/measure/snapshot 的墙钟时间；输出可直接贴进工程说明。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'

const N = Number(process.env.PERF_RUNS ?? 3)
const designIdBase = process.env.PERF_DESIGN ?? `perf-${Date.now()}`
const plate = {
  schemaVersion: 3,
  designId: designIdBase,
  units: 'mm',
  params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20, 'hole.d': 10 },
  features: [
    {
      kind: 'sketch', id: 'outline', plane: 0,
      primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }],
    },
    { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', symmetric: true, bind: { depth: 'plate.t' } },
    {
      kind: 'sketch', id: 'bore', face: 'top',
      primitives: [{ shape: 'circle', center: [0, 0], diameter: 'hole.d', bind: { diameter: 'hole.d' } }],
    },
    { kind: 'cut', id: 'through', profile: 'bore', throughAll: true },
  ],
}

const session = openSession({})
const samples = { build: [], edit: [], measure: [], snapshot: [] }
const rows = []

function timed(key, fn) {
  const started = Date.now()
  return fn().then((value) => {
    samples[key].push(Date.now() - started)
    return value
  })
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
  return { n: sorted.length, min: sorted[0] ?? null, median: at(50), p90: at(90), max: sorted[sorted.length - 1] ?? null }
}

await session.start()
try {
  for (let i = 0; i < N; i++) {
    const definition = { ...plate, designId: `${designIdBase}-b${i}` }
    const built = await timed('build', () => session.tool('model', { action: 'build', definition }))
    let volume = built.measurements?.volume ?? null
    const edits = []
    for (const [key, value] of [['plate.w', 110 + i * 10], ['plate.w', 120 + i * 10], ['plate.t', 15 + i]]) {
      const edited = await timed('edit', () => session.tool('model', { action: 'edit', parameters: { [key]: value } }))
      edits.push({ key, value, status: edited.status, mode: edited.changes?.mode, volume: edited.measurements?.volume })
      volume = edited.measurements?.volume ?? volume
    }
    const measured = await timed('measure', () => session.tool('inspect', { action: 'measure', designId: definition.designId, measure: { kind: 'holes' } }))
    const snap = await timed('snapshot', () => session.tool('inspect', {
      action: 'snapshot', designId: definition.designId,
      measures: [{ name: 'hole', measure: { kind: 'holes' } }],
    }))
    rows.push({
      designId: definition.designId,
      built: built.status, volume,
      edits,
      measured: measured.status,
      snapshot: { status: snap.status, sameTurn: snap.changes?.sameTurn, schemaVersion: snap.changes?.schemaVersion },
    })
    await session.tool('workspace', { action: 'close', designId: definition.designId }).catch(() => {})
  }
} finally {
  session.close()
}

const report = {
  at: new Date().toISOString(),
  runs: N,
  stats: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values)])),
  rows,
}
const out = join(repoRoot, 'test', 'out', 'perf-latest.json')
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(`\nwritten ${out}`)
