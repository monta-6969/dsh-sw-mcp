// Semantic measurement: does "measure" answer the question the drawing asks?
//
// The point of this test is not that numbers come back — it is that the numbers
// are the *right* numbers for a part whose dimensions we know exactly. A bore is
// built at a known height, two bores at a known centre distance, and the plate at
// a known thickness; measure has to recover all three from surfaces alone.

import { openSession, repoRoot } from './lib/mcp.mjs'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'

let pass = 0
let failCount = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    failCount++
    failures.push({ name, detail })
    console.log(`  FAIL ${name}`)
    if (detail !== undefined) console.log(`       ${JSON.stringify(detail)}`)
  }
}

// Two Ø20 bores drilled along Z through a 120 x 90 x 20 plate. Their axes are at
// y = 10 (mid-thickness) and x = ±30, so the centre distance is exactly 60 and
// the axis height above the plate bottom is exactly 10 — both recoverable only
// from the cylindrical surfaces.
const definition = {
  designId: 'measure-probe',
  units: 'mm',
  params: { plateLen: 120, plateWid: 90, plateThk: 60, boreDia: 20, boreHt: 30, pairGap: 60 },
  features: [
    {
      kind: 'sketch',
      id: 'base',
      plane: 1,
      primitives: [
        { shape: 'rect', center: [0, 0], width: 'plateLen', height: 'plateWid', bind: { width: 'plateLen', height: 'plateWid' } },
      ],
    },
    { kind: 'extrude', profile: 'base', depth: 'plateThk', direction: '+Y', bind: { depth: 'plateThk' } },
    {
      kind: 'sketch',
      id: 'bores',
      face: 'top',
      primitives: [
        { shape: 'circle', center: [-30, 'boreHt'], diameter: 'boreDia' },
        { shape: 'circle', center: [30, 'boreHt'], diameter: 'boreDia' },
      ],
    },
    { kind: 'cut', profile: 'bores', throughAll: true },
  ],
}



async function main() {
  const session = openSession({ cwd: repoRoot })
  await session.start()
  const startedHere = await ensureSolidworks((name, args) => session.tool(name, args))
  try {
    await session.tool('workspace', { action: 'cleanup' })
    const build = await session.must('model', { action: 'build', definition }, '建测量用零件')
    const volume = build.measurements?.volume
    // 120*60*90 - 2*pi*10^2*90 = 648000 - 56548.67 = 591451.33
    check('体积对得上解析值', Math.abs(volume - 591451.3297) < 1, { volume })

    const holes = await session.tool('inspect', { action: 'measure', measure: { kind: 'holes' } })
    const holeList = holes.changes?.result?.holes ?? []
    check('量到 2 个孔', holeList.length === 2, { count: holeList.length })
    check('孔径都是 Ø20', holeList.every((h) => Math.abs(h.diameter - 20) < 0.02), holeList.map((h) => h.diameter))
    check('轴线沿 Z', holeList.every((h) => Math.abs(Math.abs(h.axisDir[2]) - 1) < 0.01), holeList.map((h) => h.axisDir))

    const axis = await session.tool('inspect', { action: 'measure', measure: { kind: 'axis', diameter: 20 } })
    const heights = (axis.changes?.result?.heightAboveMinY ?? []).map((h) => h.heightAboveMinY)
    check('轴线高度都是 30', heights.length === 2 && heights.every((h) => Math.abs(h - 30) < 0.02), { heights })

    const spacing = await session.tool('inspect', { action: 'measure', measure: { kind: 'spacing', diameter: 20, axis: 'Z' } })
    const pairs = spacing.changes?.result?.pairs ?? []
    check('量到一对孔', pairs.length === 1, { pairs: pairs.length })
    check('孔心距 60', pairs[0] && Math.abs(pairs[0].distance - 60) < 0.02, pairs[0])

    const thickness = await session.tool('inspect', {
      action: 'measure',
      measure: { kind: 'distance', a: { plane: 'minY' }, b: { plane: 'maxY' } },
    })
    check('板厚 60', Math.abs((thickness.changes?.result?.distance ?? 0) - 60) < 0.02, thickness.changes?.result)

    // verify: semantic checks decide pass/fail, volume is auxiliary only.
    const verifyOk = await session.tool('inspect', {
      action: 'verify',
      expect: {
        checks: [
          { name: '孔心距', measure: 'spacing', args: { diameter: 20, axis: 'Z' }, pick: 'pairs[0].distance', expect: 60, tol: 0.02 },
          // 两个 Ø20 孔都不带定位信息时，按直径筛出 2 条候选 —— 取第一条说明不了「就是这条」。
          // 这条核对表达的是「孔径都是 Ø20」，所以显式允许取第一条（数量由另一条核对管）。
          { name: '孔径', measure: 'axis', args: { diameter: 20 }, pick: 'matches[0].diameter', expect: 20, tol: 0.02, allowFirst: true },
        ],
      },
    })
    check('验收：两条语义核对都通过', verifyOk.status === 'ok', verifyOk.changes?.checks)
    check('体积没被混进 checks', (verifyOk.changes?.checks ?? []).every((c) => c.name !== 'volume'))

    const verifyBad = await session.tool('inspect', {
      action: 'verify',
      expect: { checks: [{ name: '故意错的孔心距', measure: 'spacing', args: { diameter: 20, axis: 'Z' }, pick: 'pairs[0].distance', expect: 61, tol: 0.02 }] },
    })
    check('验收：错的值会被判失败', verifyBad.status === 'failed', verifyBad.changes?.checks)

    const verifyEmpty = await session.tool('inspect', { action: 'verify', expect: {} })
    check('验收：没有核对项时说 not-run，不说通过', verifyEmpty.status === 'not-run', verifyEmpty.status)

    const verifyAux = await session.tool('inspect', { action: 'verify', expect: { volume: 203433.63, tolerance: 0.001 } })
    check('验收：只有体积时仍是 not-run', verifyAux.status === 'not-run', verifyAux.status)
    check('验收：体积进了 auxiliary', (verifyAux.changes?.auxiliary ?? []).some((a) => a.name === 'volume'))
  } finally {
    // Quit through the still-open session, then close it: shutdownSolidworks needs
    // the MCP tool, and the tool needs a live session.
    await shutdownSolidworks((name, args) => session.tool(name, args), startedHere)
    await session.close()
  }

  console.log(`\nmeasure: ${pass} passed, ${failCount} failed`)
  if (failCount > 0) {
    console.log(JSON.stringify(failures, null, 2))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('measure test crashed:', error)
  process.exit(1)
})



