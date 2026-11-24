// 「特征跑完但模型没变」必须报错，不能静默成功。
//
// 这个用例来自一次真实的浪费：p1 的角撑轮廓完全落在旁边的加强筋里，拉伸返回了特征对象、
// 体积一位没变，之后所有测量都在怪别的特征。现在 Builder.VerifyChanged 会抛
// FEATURE_CHANGED_NOTHING，并且把前后体积写进消息。
//
// 两个方向都要验：
//   1. designs/noop-guard.json —— 「画在已有材料里」必须失败；
//   2. designs/p1-bracket.json —— 正常件必须仍然成功（不能因为加了守卫把好件也拦掉）。
//
// 需要 SOLIDWORKS —— 由 test/suite.mjs 统一起停。

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { repoRoot } from './lib/mcp.mjs'

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

function build(design) {
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, 'tools', 'run-design.mjs'), join(repoRoot, 'designs', design)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15 * 60 * 1000 },
  )
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

const bad = build('noop-guard.json')
check('轮廓完全落在已有材料里时构建失败', bad.code !== 0, { exit: bad.code })
check('失败码是 FEATURE_CHANGED_NOTHING', /FEATURE_CHANGED_NOTHING/.test(bad.out), {
  seen: (bad.out.match(/\[[A-Z_]+\]/g) ?? []).slice(0, 3),
})
check('消息里带着前后体积', /before and after/.test(bad.out), {
  sample: (bad.out.match(/\d+\.\d+ mm3 before and after/) ?? [])[0] ?? null,
})
check('消息里说明了三种可能原因', /inside existing material/.test(bad.out), {
  hasHint: /passes through empty space/.test(bad.out),
})

const good = build('p1-bracket.json')
check('正常零件不受这条守卫影响', good.code === 0, { exit: good.code })
// 体积会随图纸细节补齐而变（补上筋板脚部的 45° 倒角后是 1584.70），所以判一个区间：
// 这条用例关心的是「守卫有没有误伤好件」，不是把某个具体毫米数钉死。
const goodVolume = Number((good.out.match(/volume ([\d.]+) mm3/) ?? [])[1] ?? 0)
check('正常零件的体积仍然对', goodVolume > 1580 && goodVolume < 1595, {
  volume: goodVolume || null,
  expected: '1580–1595（解析值 1583.37）',
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
