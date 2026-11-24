// 两张图纸的验收用例。
//
// 这个文件的存在理由：把「这套东西能按图纸建模」变成一个可复跑的判断，而不是一句叙述。
// 判定依据只有一条：designs/*.json 里 __expect.checks 那些语义核对（孔径、轴线高度、
// 槽圆心距、板厚……）全部通过。体积、包围盒、截图大小只记不判 —— 体积对上只能说明画的
// 是一个实心件，说明不了孔在正确的高度。
//
// 需要 SOLIDWORKS —— 由 test/suite.mjs 统一起停。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
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
  const started = Date.now()
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, 'tools', 'run-design.mjs'), join(repoRoot, 'designs', design)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15 * 60 * 1000 },
  )
  const id = design.replace(/\.json$/, '')
  const reportPath = join(repoRoot, 'test', 'out', id, 'report.json')
  let report = null
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { /* 留给断言去报 */ }
  const buildStep = report?.steps?.find((s) => s.step === 'build')
  return { id, code: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', report, buildStep, ms: Date.now() - started }
}

function measured(buildStep) {
  const detail = buildStep?.detail ?? ''
  const volume = Number((detail.match(/volume ([\d.]+)/) ?? [])[1])
  const boxText = (detail.match(/box \[([^\]]+)\]/) ?? [])[1] ?? ''
  const box = boxText ? boxText.split(',').map((v) => Number(v.trim())) : null
  return { volume, box }
}

/** 语义核对是唯一的判定依据；顺带把体积和包围盒当观察记录打出来。 */
function verify(name, r, minimumChecks) {
  const rows = r.report?.checks ?? []
  check(`${name} 建模成功`, r.code === 0, {
    code: r.code,
    ms: r.ms,
    tail: (r.stdout + r.stderr).slice(-300),
  })

  check(`${name} 跑过语义核对（${rows.length} 项，至少 ${minimumChecks} 项）`,
    rows.length >= minimumChecks, { rows: rows.length })

  const failed = rows.filter((row) => row.pass !== true)
  check(`${name} 语义核对全部通过`, rows.length > 0 && failed.length === 0, {
    failed: failed.map((row) => ({
      name: row.name, expected: row.expected, actual: row.actual, note: row.note,
    })),
  })

  const { volume, box } = measured(r.buildStep)
  const aux = r.report?.auxiliary ?? []
  console.log(`      （辅助观察，不参与判定）体积 ${volume} mm³，包围盒 ${JSON.stringify(box)}`
    + (aux.length ? `，辅助项 ${aux.length} 条` : ''))

  for (const view of ['iso', 'front', 'top', 'right']) {
    const png = join(repoRoot, 'test', 'out', r.id, `${view}.png`)
    const size = existsSync(png) ? statSync(png).size : 0
    // 截图只查「文件非空」：图的大小说明不了模型对不对。
    check(`${name} ${view} 视图写出来了`, size > 10_000, { bytes: size })
  }
}

verify('p1 支架', build('p1-bracket.json'), 8)
verify('p2 轴承座', build('p2-housing.json'), 10)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('failures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
