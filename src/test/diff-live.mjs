// 建模闭环：把当前模型导出 STEP，与基准 STEP 比较。
// 先建 60 宽的板并导出基准，再建 80 宽的板，diff 必须指出 X 包围盒和体积的差。
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\\n      ${JSON.stringify(detail)}`)
  }
}

function plate(designId, width) {
  return {
    designId,
    features: [
      {
        id: 'outline',
        kind: 'sketch',
        plane: 0,
        primitives: [{ shape: 'rect', center: [0, 0], width, height: 40 }],
      },
      { id: 'body', kind: 'extrude', profile: 'outline', depth: 10, direction: '-Z' },
    ],
  }
}

const session = openSession({})
await session.start()

try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })

  const outDir = join(process.cwd(), 'test', 'out')
  mkdirSync(outDir, { recursive: true })
  const refPath = join(outDir, `diff-ref-${Date.now()}.step`)
  const a = await session.tool('model', { action: 'build', definition: plate(`diff-a-${Date.now()}`, 60) })
  check('基准件建成 60 宽', a.status === 'ok' && Math.abs(a.measurements?.volume - 24000) < 1, a)
  const delivered = await session.tool('deliver', { kind: 'step', path: refPath })
  check('基准 STEP 已落盘', delivered.status === 'ok' && existsSync(refPath) && delivered.artifacts?.[0]?.bytes > 0, {
    path: refPath, bytes: delivered.artifacts?.[0]?.bytes,
  })

  const b = await session.tool('model', { action: 'build', definition: plate(`diff-b-${Date.now()}`, 80) })
  check('对比件建成 80 宽', b.status === 'ok' && Math.abs(b.measurements?.volume - 32000) < 1, b)

  const diff = await session.tool('model', { action: 'diff', comparePath: refPath })
  check('diff 返回业务差异而不是异常', diff.status === 'diff', diff.summary)
  const items = diff.changes?.items ?? []
  const regions = items.map((item) => item.region)
  check('指出 X 包围盒差异', regions.some((region) => /bbox|bounding|包围盒/i.test(region) && /x/i.test(region)), regions)
  const volume = items.find((item) => /volume|体积/i.test(item.region))
  check('体积差异是 8000 mm³', volume && Math.abs(volume.delta - 8000) < 1, volume)
  check('每项带实体引用与下一次观察', items.length > 0
    && items.every((item) => item.entityRef && item.nextObservation), items[0])
  check('返回导出的 STEP 路径', typeof diff.changes?.source === 'string'
    && diff.changes.source.endsWith('.step') && existsSync(diff.changes.source), diff.changes?.source)
} finally {
  try { session.close() } catch { }
}

console.log(`\\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\\n'))
  process.exitCode = 1
}
