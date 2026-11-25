// 重放 abd5f23f 里真实失败过的访问表达式，看现在还犯不犯。
//
// 不猜：每个用例都用会话里**原文**那句 `j.changes.X` 的形式，对着当前 envelope 跑。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repo, 'server', 'server.mjs'), 'utf8')
const start = source.indexOf('function envelope(')
const end = source.indexOf('\nfunction ok(', start)
const envelope = new Function(`${source.slice(start, end)}; return envelope`)()

let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) }
  else { failures.push(name); console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`) }
}
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, error: e.message } } }

// ── 类 1：失败回包缺 changes（会话里 11 次）──────────────────────────────
// 原文：j.changes.applied / j.changes.updated / j.changes.result / j.changes.document
{
  const failed = envelope({
    summary: 'inspect.dimensions 失败：SOLIDWORKS returned no distance dimension for the selection',
    status: 'failed', designId: 'C04-01',
    extra: { error: { code: 'DIMENSION_CREATE_FAILED', message: 'no distance dimension' } },
  })
  const j = failed
  for (const [name, expr] of [
    ['j.changes.applied', () => (j.changes.applied || [])],
    ['j.changes.updated', () => (j.changes.updated || [])],
    ['j.changes.result', () => j.changes.result],
    ['j.changes.document', () => j.changes.document],
  ]) {
    const r = attempt(expr)
    check(`失败回包里 ${name} 不抛 TypeError`, r.ok, r.error)
  }
  check('失败时真正的错误码仍然读得到（没被 TypeError 盖住）',
    failed.extra?.error?.code === 'DIMENSION_CREATE_FAILED', failed.extra?.error?.code)
}

// ── 类 2：changes.measurements.totalVolumeMm3（会话里 9 次）───────────────
{
  const bodies = envelope({
    summary: 'C04-01.SLDPRT：1 个实体', designId: 'C04-01',
    changes: { document: { title: 'C04-01.SLDPRT' }, bodies: [{ index: 0, volumeMm3: 24280.7, faces: 24 }], count: 1 },
    measurements: { totalVolumeMm3: 24280.7, bodyCount: 1 },
  })
  for (const [name, expr] of [
    ['j.changes.measurements.totalVolumeMm3（会话原文）', () => bodies.changes.measurements.totalVolumeMm3],
    ['j.measurements.totalVolumeMm3（顶层）', () => bodies.measurements.totalVolumeMm3],
    ['j.changes.bodies[0].faces（会话原文）', () => bodies.changes.bodies[0].faces],
  ]) {
    const r = attempt(expr)
    check(`${name} 读得到`, r.ok && r.value === 24280.7 || (r.ok && r.value === 24), r.error ?? r.value)
  }
  check('两处 measurements 是同一个数',
    bodies.changes.measurements.totalVolumeMm3 === bodies.measurements.totalVolumeMm3,
    { inChanges: bodies.changes.measurements.totalVolumeMm3, top: bodies.measurements.totalVolumeMm3 })
}

// ── 类 3：成功回包本来就有的路径不能被这次改动弄坏 ──────────────────────
{
  const okEnv = envelope({
    summary: 'x', designId: 'd',
    changes: { segments: [{ kind: 'circle' }], dimensions: [{ name: 'a' }], applied: [{}] },
  })
  check('changes.applied 仍是调用方给的那个数组', okEnv.changes.applied.length === 1)
  check('changes 里没有塞进多余的 measurements', okEnv.changes.measurements === undefined)
  const withOwn = envelope({ summary: 'x', changes: { measurements: { totalVolumeMm3: 1 } }, measurements: { totalVolumeMm3: 2 } })
  check('调用方自己给的 changes.measurements 不被覆盖', withOwn.changes.measurements.totalVolumeMm3 === 1,
    withOwn.changes.measurements)
  const noChanges = envelope({ summary: 'x' })
  check('既没 changes 也没 measurements 时，changes 是空对象', Object.keys(noChanges.changes).length === 0, noChanges.changes)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)
