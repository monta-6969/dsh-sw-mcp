// verify 的 expect.checks[] 必须量 designId 登记的那一份文档。
//
// 这条用例来自一个真机 bug（P1）：verify 回包里的两种数字互相矛盾 ——
//   boundingBox: [386,130,8]  pass   ← 走 server.mjs 的 inspect{designId}，对的
//   高130: actual=8  fail     ← 走 runCheck → measure，**没带 designId**
//   厚8:   actual=392 fail    ← 同上
// 而 8 和 392 正是另一份文档（底板）的 Y 厚和 Z 长。桥接器的 measure 把 designId
// 当可选参数（Operations.cs OptionalDesignDocument），不带就量「前台那份」，
// 于是多零件工作流里从第二件开始就静默量错，还给出一串看起来合理的假数字。
//
// 这里全部用假 callBridge，不需要 SOLIDWORKS，能进 CI：
//   1. runCheck 把 designId 原样交给 measure（单文档也要带）；
//   2. 多文档场景（活动文档 A、被验的是 B）→ measure 收到的必须是 B；
//   3. spec.designId / spec.args.designId 可以显式覆盖；
//   4. 漏传 designId 时明确报错，不静默退回旧行为；
//   5. 返回体里记下这一条量的是哪份文档。
import { runCheck, resolveCheckDesignId, tallyChecks } from '../server/verify.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed++
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
}

/**
 * 假桥接器：按 designId 回**不同的**数字，并且把每次请求原样记下来。
 *
 * 「活动文档」故意设成 A，而 A 的数字和 B 完全不同 —— 这正是真机上量错时
 * 出现假数字的机制：不带 designId 就落到 active 上，数字看着还挺合理。
 */
function fakeBridge(activeDesignId, numbers) {
  const calls = []
  return {
    calls,
    async call(op, request) {
      calls.push({ op, request: JSON.parse(JSON.stringify(request ?? {})) })
      const measured = request?.designId ?? activeDesignId
      const table = numbers[measured] ?? {}
      const kind = request?.kind ?? 'holes'
      if (kind === 'distance') {
        return { kind, distance: table.distance, along: request?.along ?? 0 }
      }
      if (kind === 'holes') {
        return { kind, count: table.holes ?? 0, cylinderFaces: table.holes ?? 0 }
      }
      // axis：matches[0] 给个能取到数的形状
      return {
        kind,
        count: 1,
        diameter: request?.diameter ?? 0,
        matches: [{ diameter: request?.diameter ?? 0, heightAboveMinY: [table.height] }],
        heightAboveMinY: [{ heightAboveMinY: table.height }],
      }
    },
  }
}

// ── 1. runCheck 把 designId 交给 measure（单文档也得带）────────────
{
  const bridge = fakeBridge('A', { B: { distance: 130 } })
  const result = await runCheck(
    { name: '高130', measure: 'distance', args: { a: { plane: 'minY' }, b: { plane: 'maxY' } }, pick: 'distance', expect: 130, tol: 0.01 },
    bridge.call,
    'B',
  )
  check('measure 请求里带上了 designId', bridge.calls.length === 1 && bridge.calls[0].request.designId === 'B',
    bridge.calls)
  check('带的正是传进去的那一个', bridge.calls[0]?.request?.designId === 'B', bridge.calls[0]?.request)
  check('这条核对判通过', result.status === 'pass' && result.actual === 130, result)
  check('记录里写清了量的是哪份文档', result.designId === 'B', result.designId)
}

// ── 2. 多文档：活动文档是 A，被验的是 B —— 这就是那个 bug 的现场 ──
{
  // 两份文档的同一个测量给出**不同**的数：B 的高是 130，A（前台）的高是 8。
  const bridge = fakeBridge('A', {
    A: { distance: 8, holes: 2, height: 8 },   // 底板的 Y 厚 = 8：真机上被错当成后板的高
    B: { distance: 130, holes: 3, height: 130 }, // 后板该有的高
  })
  const result = await runCheck(
    { name: '高130', measure: 'distance', args: { a: { plane: 'minY' }, b: { plane: 'maxY' } }, pick: 'distance', expect: 130, tol: 0.01 },
    bridge.call,
    'B',
  )
  check('多文档场景：measure 收到的是 B 而不是前台 A',
    bridge.calls[0]?.request?.designId === 'B', bridge.calls[0]?.request)
  check('于是量到的是 B 的 130，不是 A 的 8', result.actual === 130 && result.status === 'pass', {
    actual: result.actual, status: result.status, expected: 130,
  })
  // 反证：如果 designId 丢了，桥接器会回前台 A 的 8，这条就会像真机上那样假 fail。
  // 这里显式把「不带 designId」的请求走一遍同一个假桥接器，确认它确实会错 ——
  // 保证上面那条断言不是恰好通过。
  const wrong = await bridge.call('measure', { kind: 'distance', pick: 'distance' })
  check('假桥接器确实会按「前台文档」回错误数字（反证这条测试抓得住 bug）',
    wrong.distance === 8, wrong)
}

// ── 3. spec.designId 覆盖（有些核对确实要量别的文档）──────────────
{
  const bridge = fakeBridge('A', { A: { distance: 8 }, B: { distance: 130 } })
  const result = await runCheck(
    { name: '量底板厚', measure: 'distance', designId: 'A', args: { a: { plane: 'minY' }, b: { plane: 'maxY' } }, pick: 'distance', expect: 8, tol: 0.01 },
    bridge.call,
    'B',
  )
  check('spec.designId 覆盖 runCheck 的 designId', bridge.calls[0]?.request?.designId === 'A', bridge.calls[0]?.request)
  check('覆盖之后量到的是 A 的 8', result.actual === 8 && result.status === 'pass', { actual: result.actual, status: result.status })
}

// ── 3b. 兼容老写法：spec.args.designId 也算覆盖，且不会被 args 悄悄盖掉解析结果 ──
{
  const bridge = fakeBridge('A', { A: { distance: 8 } })
  const result = await runCheck(
    { name: '量底板厚', measure: 'distance', args: { designId: 'A', a: { plane: 'minY' }, b: { plane: 'maxY' } }, pick: 'distance', expect: 8, tol: 0.01 },
    bridge.call,
    'B',
  )
  check('spec.args.designId 也能指定文档（老写法继续生效）',
    bridge.calls[0]?.request?.designId === 'A', bridge.calls[0]?.request)
  check('解析出来的 designId 不会被 args 里别的值盖掉', result.actual === 8, { actual: result.actual })
}

// ── 4. 漏传 designId 必须明确报错，不能静默退回「前台那份」────────
{
  const bridge = fakeBridge('A', { A: { distance: 8 } })
  let thrown = null
  try {
    await runCheck({ name: '高130', measure: 'distance', pick: 'distance', expect: 130 }, bridge.call)
  } catch (error) {
    thrown = error
  }
  check('漏传 designId 直接抛 DESIGN_ID_REQUIRED', thrown?.code === 'DESIGN_ID_REQUIRED', thrown?.code)
  check('报错信息说清为什么（不退回前台文档）', /designId/.test(thrown?.message ?? '') && /前台/.test(thrown?.message ?? ''),
    thrown?.message)
  check('没有发出任何 measure 请求', bridge.calls.length === 0, bridge.calls)
}

// ── 4b. designId 传了但不是字符串 / 是空串，同样报错 ─────────────
{
  let thrown = null
  try {
    await runCheck({ name: 'x', measure: 'distance' }, async () => ({}), '   ')
  } catch (error) {
    thrown = error
  }
  check('空白 designId 视为没传', thrown?.code === 'DESIGN_ID_REQUIRED', thrown?.code)

  let invalid = null
  try {
    resolveCheckDesignId({ designId: 42 }, 'B')
  } catch (error) {
    invalid = error
  }
  check('spec.designId 不是字符串时报 BAD_ARGUMENT', invalid?.code === 'BAD_ARGUMENT', invalid?.code)

  let invalidArgs = null
  try {
    resolveCheckDesignId({ args: { designId: false } }, 'B')
  } catch (error) {
    invalidArgs = error
  }
  check('spec.args.designId 不是字符串时报 BAD_ARGUMENT', invalidArgs?.code === 'BAD_ARGUMENT', invalidArgs?.code)
}

// ── 5. 桥接器抛错时仍记成 unmeasured（原有语义不变），并带上 designId ──
{
  const boom = async () => { throw Object.assign(new Error('no doc'), { code: 'NO_ACTIVE_DOC' }) }
  const result = await runCheck({ name: '高130', measure: 'distance', expect: 130 }, boom, 'B')
  check('测量本身失败仍是 unmeasured，不是 fail', result.status === 'unmeasured' && result.reason === 'MEASURE_FAILED', {
    status: result.status, reason: result.reason,
  })
  check('失败记录里也带着 designId', result.designId === 'B', result.designId)
}

// ── 6. 端到端形状：四态判定仍按 designId 传下去的结果算 ──────────
{
  const bridge = fakeBridge('A', { A: { distance: 8, holes: 2 }, B: { distance: 130, holes: 3 } })
  const checks = [
    await runCheck({ name: '高130', measure: 'distance', args: { a: { plane: 'minY' }, b: { plane: 'maxY' } }, pick: 'distance', expect: 130, tol: 0.01 }, bridge.call, 'B'),
    await runCheck({ name: '通孔数量', measure: 'holes', args: { through: true }, pick: 'count', expect: 3, tol: 0 }, bridge.call, 'B'),
  ]
  check('每条 measure 请求都带同一个 designId',
    bridge.calls.length === 2 && bridge.calls.every((call) => call.request.designId === 'B'),
    bridge.calls.map((call) => call.request))
  // holes 的默认取的是 count（假桥接器没给 breakdown，按 pickPath 落到 count）
  check('计数核对能取到 B 的数', checks[1].status === 'pass' && checks[1].actual === 3, checks[1])
  check('分类计数是 2 条通过', JSON.stringify(tallyChecks(checks)) === JSON.stringify({ pass: 2, fail: 0, unmeasured: 0 }),
    tallyChecks(checks))
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
