// verify 必须真的核对调用方写下的期望值：体积/包围盒/特征/草图数量
// 以前 expect.size 只进 auxiliary、expect.features/sketches 被静默忽略，
// 于是「验收通过」可能一条结构核对都没跑。这个用例把四种键都钉住。
import { openSession, repoRoot } from './lib/mcp.mjs'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const session = await openSession()
let passed = 0
let failed = 0
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`PASS  ${name}`) }
  else { failed++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`) }
}

try {
  await session.start()
  const designId = `verify-shape-${Date.now()}`
  const build = await session.must('model', {
    action: 'build',
    designId,
    definition: {
      schemaVersion: 3,
      designId,
      params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10 },
      features: [{ kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' }],
    },
  }, 'build')
  check('build 60×40×10', Math.abs(build.measurements?.volume - 24000) < 1e-6,
    JSON.stringify(build.measurements))

  const good = await session.must('inspect', {
    action: 'verify', designId,
    expect: { size: [60, 40, 10], features: ['plate'], sketches: 1 },
  }, 'verify-good')
  check('尺寸/特征/草图都参与判定并通过', good.status === 'ok', good.summary)
  const checks = good.changes?.checks ?? []
  check('boundingBox 进入 checks', checks.some((c) => c.name === 'boundingBox' && c.status === 'pass'),
    JSON.stringify(checks.map((c) => [c.name, c.status])))
  check('features 进入 checks', checks.some((c) => c.name === 'features' && c.status === 'pass'))
  check('sketches 进入 checks', checks.some((c) => c.name === 'sketches' && c.status === 'pass'))

  const rel = `test/out/verify-shape-rel-${Date.now()}.png`
  const cap = await session.must('capture', { designId, path: rel }, 'capture-relative')
  check('相对路径 capture 落盘', existsSync(resolve(repoRoot, rel)), cap.changes?.path)
  rmSync(resolve(repoRoot, rel), { force: true })

  const bad = await session.tool('inspect', {
    action: 'verify', designId,
    expect: { size: [60, 40, 12], sketches: 2 },
  })
  check('错的包围盒/草图数被判 failed', bad.status === 'failed', bad.summary)
  check('失败项在 checks 里', (bad.changes?.checks ?? []).some((c) => c.name === 'boundingBox' && c.status === 'fail'))
} finally {
  session.close()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
