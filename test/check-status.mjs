// 验收状态必须说真话。
//
// 两条规则，都是被真实事故推出来的：
//   1. 「没量成」不是「对得上」。10 条核对里 4 条没量成、6 条碰巧对，以前回 ok
//      并在摘要里写「验收通过」—— 这是闭环自证最典型的一步。
//   2. 「同直径两个孔，取第一个」是猜。没有定位信息时应当记成有歧义（没量成），
//      而不是碰巧选中一个就当通过。
import { openSession, repoRoot } from './lib/mcp.mjs'

const session = openSession({ cwd: repoRoot })
await session.start()

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) {
    console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

const design = {
  designId: 'status-truth',
  units: 'mm',
  features: [
    {
      id: 'plate_outline',
      kind: 'sketch',
      plane: 1,
      primitives: [{ shape: 'rect', center: [0, 0], width: 100, height: 60 }],
    },
    { id: 'plate', kind: 'extrude', profile: 'plate_outline', depth: 15, direction: '+Y' },
    {
      id: 'holes_outline',
      kind: 'sketch',
      plane: 1,
      primitives: [
        { shape: 'circle', center: [-30, 0], diameter: 8 },
        { shape: 'circle', center: [30, 0], diameter: 8 },
      ],
    },
    { id: 'holes', kind: 'cut', profile: 'holes_outline', throughAll: true, both: true, direction: '+Y' },
  ],
}

await session.must('model', { action: 'build', definition: design }, 'build status-truth')

// ── 1. 有歧义的核对 → incomplete，且摘要不能写「通过」 ─────────────────
{
  const result = await session.must(
    'inspect',
    {
      action: 'verify',
      designId: 'status-truth',
      expect: {
        checks: [
          {
            name: 'Ø8 孔径',
            measure: 'axis',
            args: { diameter: 8 },
            pick: 'matches[0].diameter',
            expect: 8,
          },
        ],
      },
    },
    'verify ambiguous',
  )
  const first = result.changes.checks[0]
  check('两个 Ø8 孔、没有定位 → 记成有歧义', first.reason === 'AMBIGUOUS_MATCH', first.reason)
  check('歧义条目带候选清单', Array.isArray(first.candidates) && first.candidates.length === 2, first.candidates?.length)
  check('整体状态是 incomplete', result.status === 'incomplete', result.status)
  check('摘要不写「通过」', !String(result.summary).includes('通过') || String(result.summary).includes('未完成'), result.summary)
}

// ── 2. 明确 index → ok ────────────────────────────────────────────────
{
  const result = await session.must(
    'inspect',
    {
      action: 'verify',
      designId: 'status-truth',
      expect: {
        checks: [
          {
            name: 'Ø8 孔径',
            measure: 'axis',
            args: { diameter: 8 },
            pick: 'matches[0].diameter',
            index: 0,
            expect: 8,
          },
        ],
      },
    },
    'verify pinned',
  )
  check('明确 index 后通过', result.status === 'ok', result.status)
  check('通过时摘要写「验收通过」', String(result.summary).includes('验收通过'), result.summary)
}

// ── 3. 一条对、一条没量成 → incomplete ────────────────────────────────
{
  const result = await session.must(
    'inspect',
    {
      action: 'verify',
      designId: 'status-truth',
      expect: {
        checks: [
          { name: '孔数量', measure: 'holes', pick: 'count', expect: 2, tol: 0 },
          { name: '不存在的 Ø99', measure: 'axis', args: { diameter: 99 }, pick: 'matches[0].diameter', expect: 99 },
        ],
      },
    },
    'verify mixed',
  )
  check('一过一没量成 → incomplete', result.status === 'incomplete', result.status)
  check('计数显示没量成 1 条', result.changes.counts.unmeasured === 1, result.changes.counts)
  check('摘要写出没量成的条数', String(result.summary).includes('没量成'), result.summary)
}

// ── 4. 只有体积 → not-run（体积永远不是判据） ─────────────────────────
{
  const result = await session.must(
    'inspect',
    { action: 'verify', designId: 'status-truth', expect: { volume: 100 } },
    'verify volume only',
  )
  check('只有体积 → not-run', result.status === 'not-run', result.status)
  check('体积进的是 auxiliary', result.changes.auxiliary.length === 1 && result.changes.checks.length === 0, result.changes.auxiliary.length)
}

await session.close()
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'))
  process.exitCode = 1
}
