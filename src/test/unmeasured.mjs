// 「量不到」不是「不对」。
//
// 这条用例来自一次真实事故：measure kind="axis" 默认只匹配孔，于是量 Ø11,1 凸台时
// matches 为空、pick 拿到 undefined，verify 把四条正确的特征判成「尺寸不对」。模型
// 接着去修那些本来正确的特征 —— 假失败比假通过更费时间，因为它朝反方向使劲。
//
// 这里钉住三件事：
//   1. 凸台默认就能量到（不再被 hole 过滤器藏起来）；
//   2. 显式 hole:true 时，结果里要能看出「这个零件上有这个直径的凸台」；
//   3. pick 指到不存在的字段时，报告是 not-run + unmeasured，不是 failed。

import { openSession, repoRoot } from './lib/mcp.mjs'

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

const session = openSession({})
await session.start()
try {
  // 一块 100×60×10 的板，上面一个 Ø11.1 高 8.4 的凸台，中间一个 Ø5.7 通孔。
  // 数字不重要，重要的是「同一个零件上既有孔也有凸台」。
  const built = await session.must('model', {
    action: 'build',
    definition: {
      designId: 'unmeasured-probe',
      parameters: {},
      features: [
        {
          kind: 'sketch',
          id: 'plate_outline',
          plane: 1,
          primitives: [{ shape: 'rect', center: [0, 0], width: 100, height: 60 }],
        },
        { kind: 'extrude', id: 'plate', profile: 'plate_outline', depth: 10, direction: '+Y' },
        {
          kind: 'sketch',
          id: 'boss_outline',
          plane: 1,
          primitives: [{ shape: 'circle', center: [0, 0], diameter: 11.1 }],
        },
        { kind: 'extrude', id: 'boss', profile: 'boss_outline', depth: 8.4, startOffset: 10, direction: '+Y' },
        {
          kind: 'sketch',
          id: 'bore_outline',
          plane: 1,
          primitives: [{ shape: 'circle', center: [0, 0], diameter: 5.7 }],
        },
        { kind: 'cut', id: 'bore_cut', profile: 'bore_outline', throughAll: true, both: true },
      ],
    },
  }, '建一个带凸台和孔的零件')

  check('零件建出来了', built.status === 'ok', { status: built.status, summary: built.summary })

  // 1. 默认查询必须看见凸台
  const boss = await session.must('inspect', {
    action: 'measure',
    designId: 'unmeasured-probe',
    measure: { kind: 'axis', diameter: 11.1 },
  }, '量 Ø11.1 凸台')
  const bossMatches = boss.changes?.result?.matches ?? []
  check('默认查询能命中 Ø11.1 凸台', bossMatches.length === 1, {
    count: boss.changes?.result?.count,
    kind: bossMatches[0]?.kind,
  })
  check('命中记录说明它是凸台，不只是 isHole:false', bossMatches[0]?.kind === 'boss', {
    kind: bossMatches[0]?.kind,
    isHole: bossMatches[0]?.isHole,
  })

  // 2. 显式只要孔时，同一次查询返回空，但 available 里要能看到那个凸台
  const holesOnly = await session.must('inspect', {
    action: 'measure',
    designId: 'unmeasured-probe',
    measure: { kind: 'axis', diameter: 11.1, hole: true },
  }, '只查孔时的 Ø11.1')
  const empty = holesOnly.changes?.result ?? {}
  const availableBosses = empty.available?.bosses ?? []
  check('显式 hole:true 时这个直径命中 0 条', empty.count === 0, { count: empty.count })
  check('但 available.bosses 里看得到 11.1', availableBosses.includes(11.1), {
    bosses: availableBosses,
    holes: empty.available?.holes,
  })

  // 3. 量不到 ≠ 不对
  const verified = await session.tool('inspect', {
    action: 'verify',
    designId: 'unmeasured-probe',
    expect: {
      checks: [
        {
          name: '凸台外径 Ø11,1',
          measure: 'axis',
          args: { diameter: 11.1 },
          pick: 'matches[0].diameter',
          expect: 11.1,
          tol: 0.01,
        },
        {
          name: '故意指到一个不存在的字段',
          measure: 'axis',
          args: { diameter: 11.1 },
          pick: 'matches[0].noSuchField',
          expect: 1,
        },
      ],
    },
  })
  const checks = verified.changes?.checks ?? []
  const counts = verified.changes?.counts ?? {}
  check('真实存在的尺寸判通过', checks[0]?.status === 'pass', {
    status: checks[0]?.status,
    actual: checks[0]?.actual,
  })
  check('取不到数的核对记成 unmeasured，不是 fail', checks[1]?.status === 'unmeasured', {
    status: checks[1]?.status,
    reason: checks[1]?.reason,
  })
  check('它没说这是尺寸不对', !/验收未通过/.test(verified.summary ?? checks[0]?.note ?? ''), {
    summary: (verified.summary ?? '').slice(0, 90),
  })
  check('汇总里出现「没量成」', /没量成/.test(verified.summary ?? ''), {
    summary: (verified.summary ?? '').slice(0, 120),
  })
  check('分类计数对得上', counts.pass === 1 && counts.unmeasured === 1 && counts.fail === 0, counts)
  check('nextActions 指向查直径而不是改模型',
    (verified.nextActions ?? []).some((a) => /available\.diameters|有没有量成/.test(a)), {
    nextActions: verified.nextActions,
  })
} finally {
  // 收掉这个用例建出来的文档，别把窗口堆在别人的 SOLIDWORKS 里
  try {
    await session.tool('workspace', { action: 'closePath', pathPrefix: repoRoot, untitled: true })
  } catch { /* 清理失败不影响判定 */ }
  await session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
