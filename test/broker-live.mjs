// 共享 broker 的建模路径（SW_MCP_BROKER=1）：build/edit/measure 都提交给常驻
// broker，由实例 worker 执行；同一 designId 的文档登记/释放也从 broker 查。
//
// 这条用例要证明的不是“broker 能转发”，而是重操作真的落到同一个实例 worker 上，
// 并且结果与直连路径一致。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const runId = `broker-live-${Date.now()}`
const designId = runId
const session = openSession({
  env: {
    ...process.env,
    SW_MCP_BROKER: '1',
    SW_MCP_BROKER_ENSURE: '1',
    SW_MCP_RUN_ID: runId,
    SW_MCP_BROKER_TIMEOUT_MS: '180000',
  },
})
await session.start()

const near = (a, b, tol = 0.05) => Number.isFinite(a) && Math.abs(a - b) < tol
const definition = {
  designId,
  params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10, 'hole.d': 20 },
  features: [
    {
      id: 'outline', kind: 'sketch', plane: 1,
      primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h',
        bind: { width: 'plate.w', height: 'plate.h' } }],
    },
    { id: 'plate', kind: 'extrude', profile: 'outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
    {
      id: 'hole-outline', kind: 'sketch', plane: 1,
      primitives: [{ shape: 'circle', center: [0, 0], diameter: 'hole.d', bind: { diameter: 'hole.d' } }],
    },
    { id: 'hole', kind: 'cut', profile: 'hole-outline', depth: 'plate.t', direction: '+Y' },
  ],
}

try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })

  const built = await session.tool('model', { action: 'build', definition })
  const baseVolume = 60 * 40 * 10 - Math.PI * 10 * 10 * 10
  check('broker 路径能建模', built.status === 'ok', built.summary)
  check('broker 建出的体积与解析值一致', near(built.measurements?.volume, baseVolume), {
    measured: built.measurements?.volume, analytic: Number(baseVolume.toFixed(4)),
  })

  const edited = await session.tool('model', {
    action: 'edit', designId, parameters: { 'plate.w': 80 },
  })
  const wideVolume = 80 * 40 * 10 - Math.PI * 10 * 10 * 10
  check('broker 路径能改参数并回读', edited.status === 'ok'
    && near(edited.measurements?.volume, wideVolume), {
    status: edited.status, measured: edited.measurements?.volume, analytic: Number(wideVolume.toFixed(4)),
  })

  const docs = await session.tool('job', { action: 'documents' })
  check('broker 登记了这条 designId', (docs.changes?.documents ?? []).some((doc) => doc.designId === designId),
    docs.changes?.documents)

  const released = await session.tool('job', { action: 'release', designId })
  check('broker 能按 designId 释放文档', released.status === 'ok', released.summary)
} finally {
  try { session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
