// 真机验证：这一轮改的四处行为，在真实 SOLIDWORKS 上是什么结果。
//
// 只用一个**自己建的、临时目录里的**零件（designId=plugin-fix-probe-<ts>），
// 不碰用户已经打开的文档：桥接器按 registry 解析 designId，解析不到就 DOC_NOT_OPEN，
// 这正是第 1 条要证明的事。
//
// 判定原则：凡是「这台机器 / 这个实例不支持」的，如实记为 skip，不写成 pass。
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'
let passed = 0
const failures = []
const skipped = []
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) }
  else { failures.push(name); console.log(`FAIL  ${name}`) }
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
function skip(name, why) {
  skipped.push(name)
  console.log(`SKIP  ${name}\n      ${why}`)
}

const stamp = String(Date.now())
const designId = `plugin-fix-${stamp}`
const outDir = mkdtempSync(join(tmpdir(), 'sw-plugin-fix-'))
mkdirSync(outDir, { recursive: true })

const session = openSession({})
await session.start()
const log = (...args) => console.log('·', ...args)

try {
  // ── 0. 前置：真的连上了实例，而且它能建模 ────────────────────────────
  //
  // workspace status 即便桥接器根本绑不上实例也可能回 status:"ok"，把
  // INSTANCE_NOT_BOUND 塞在 extra/capabilities 里。只看顶层 status 会得到一条
  // 「PASS：SOLIDWORKS 可用」而真实摘要写着「不可用」——假绿比红更糟，所以这里
  // 把四个可能的失败位都查一遍。
  const status = await session.tool('workspace', { action: 'status' })
  const swCap = status?.capabilities?.solidworks ?? {}
  const statusError = status?.extra?.error
  const swReason = String(swCap.reason ?? '')
  const reachable = status?.status !== 'failed'
    && statusError === undefined
    && swCap.ready !== false
    && !/INSTANCE_NOT_BOUND|not bound|isolation/i.test(swReason)
  check('前置：SOLIDWORKS 可用', reachable,
    { status: status?.status, error: statusError, ready: swCap.ready, reason: swCap.reason })
  if (!reachable) throw new Error('SOLIDWORKS 不可用，后面的真机断言没有意义')

  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      params: { 'probe.w': 40, 'probe.h': 20, 'probe.t': 6 },
      features: [
        // 与 test/suite.mjs 的 healthProbe 同款（那套已经被证明在这台机器上能建成）：
        // 矩形轮廓 + 单方向拉伸 + 尺寸绑参数。
        { kind: 'sketch', id: 'base', plane: 1,
          primitives: [{ shape: 'rect', center: [0, 0], width: 'probe.w', height: 'probe.h',
            bind: { width: 'probe.w', height: 'probe.h' } }] },
        { kind: 'extrude', id: 'body', profile: 'base', depth: 'probe.t', direction: '+Y',
          bind: { depth: 'probe.t' } },
      ],
    },
  })
  check('前置：建出一个 40×20×6 的板', built?.status === 'ok', built?.summary)
  log('体积', built?.measurements?.volume)

  // ── 1. target:"doc" 由 designId 决定 ────────────────────────────────
  const invoked = await session.tool('model', {
    action: 'invoke', designId, target: 'doc', member: 'EditRebuild3', args: [],
  })
  check('1a invoke target=doc 带 designId → 成功且回包标明落在了哪份文档',
    invoked?.status === 'ok' && typeof invoked?.changes?.document?.title === 'string',
    { status: invoked?.status, document: invoked?.changes?.document, activeDocument: invoked?.changes?.activeDocument })
  check('1b 带 designId 时不是前台兜底（activeDocument 不为 true）',
    invoked?.changes?.activeDocument !== true, invoked?.changes?.activeDocument)

  // 一个本机绝对不存在、也没打开过的 designId：必须明确拒绝，不能悄悄动前台那份。
  const ghost = `plugin-fix-ghost-${stamp}`
  const ghostCall = await session.tool('model', {
    action: 'invoke', designId: ghost, target: 'doc', member: 'EditRebuild3', args: [],
  })
  check('1c designId 解析不到 → DOC_NOT_OPEN（不退回前台那份）',
    ghostCall?.status === 'failed' && ghostCall?.extra?.error?.code === 'DOC_NOT_OPEN',
    { status: ghostCall?.status, code: ghostCall?.extra?.error?.code, summary: ghostCall?.summary })
  check('1d DOC_NOT_OPEN 的下一步说清「不会退回前台」',
    /DOC_NOT_OPEN|按 designId 解析|activeDoc/.test(String(ghostCall?.nextActions?.join(' ') ?? '')),
    ghostCall?.nextActions)

  // ── 2. dimensions：驱动 vs 参考，回包要能分辨 ──────────────────────
  const dims = await session.tool('inspect', { action: 'dimensions', designId, dimensionAction: 'list' })
  const dimEnvelope = dims?.changes ?? {}
  check('2a dimensions list 顶层给 driving/reference 计数',
    typeof dimEnvelope.driving === 'number' && typeof dimEnvelope.reference === 'number',
    { driving: dimEnvelope.driving, reference: dimEnvelope.reference, count: dimEnvelope.count })
  if (typeof dimEnvelope.driving === 'number') {
    check('2b 摘要同时报驱动数和参考数',
      /驱动 \d+/.test(dims.summary ?? '') && /参考 \d+/.test(dims.summary ?? ''), dims.summary)
    const total = (dimEnvelope.driving ?? 0) + (dimEnvelope.reference ?? 0)
    check('2c driving+reference 等于清单条数', total === (dimEnvelope.count ?? -1),
      { driving: dimEnvelope.driving, reference: dimEnvelope.reference, count: dimEnvelope.count })
  } else {
    skip('2b/2c dimensions 计数', '这个桥接器没回 driving/reference（老二进制）')
  }

  // ── 3. bodies：形状稳定，不再抛 TypeError ───────────────────────────
  const bodies = await session.tool('inspect', { action: 'bodies', designId })
  check('3a bodies 不再抛 TypeError，且量到总体积',
    bodies?.status === 'ok' && bodies?.measurements?.totalVolumeMm3 !== undefined,
    { status: bodies?.status, measurements: bodies?.measurements, error: bodies?.extra?.error })
  const bodyVolume = bodies?.measurements?.totalVolumeMm3
  const builtVolume = built?.measurements?.volume
  check('3b bodies 的总体积与 build 报的体积一致（同一份文档）',
    Number.isFinite(bodyVolume) && Number.isFinite(builtVolume)
      && Math.abs(bodyVolume - builtVolume) <= Math.max(1, Math.abs(builtVolume) * 1e-3),
    { bodyVolume, builtVolume })

  // ── 4. undo：前后都给数字 + baseline ───────────────────────────────
  //
  // 注意这里**不能**断言 volumeAfter 的数字：实测撤一步就把刚建成的整个拉伸
  // 撤掉了，撤销后文档里 0 个实体（inspect 回 bodies:0），所以体积本来就不存在。
  // 那正是要证明的破坏性 —— 断言的重点是「撤销前量到了真数字」+「撤销后如实
  // 报告变成 null，而不是编一个 0 或 undefined」。
  const undone = await session.tool('model', { action: 'undo', designId, steps: 1 })
  const undoC = undone?.changes ?? {}
  check('4a undo 记下了撤销前的真实体积（不是 null）',
    Number.isFinite(undoC.volumeBefore) && undoC.volumeBefore > 0,
    { volumeBefore: undoC.volumeBefore, volumeAfter: undoC.volumeAfter, volumeDelta: undoC.volumeDelta })
  check('4b undo 回包带可照着重建的 baseline（撤销前的体积+包围盒）',
    undoC.baseline !== null && typeof undoC.baseline === 'object'
      && Number.isFinite(undoC.baseline.volume) && Array.isArray(undoC.baseline.boundingBox),
    undoC.baseline)
  check('4c 撤销前后都是真数字、不打印 undefined', !/undefined|NaN/.test(undone?.summary ?? ''),
    undone?.summary)
  // 两次实测见过两种结局：撤一步把整个拉伸撤没了（bodies 1→0，体积 null），
  // 以及这次撤一步什么都没撤掉（4800→4800，Δ 0）。所以这里**不指定**哪种对，
  // 只要求：①撤销前后的数都量到了；②摘要与数字一致，不美化。
  check('4d 回包自洽：volumeDelta 与前后体积一致',
    undoC.volumeDelta === null || undoC.volumeDelta === undoC.volumeAfter - undoC.volumeBefore,
    { before: undoC.volumeBefore, after: undoC.volumeAfter, delta: undoC.volumeDelta })
  check('4e 摘要里的体积与 volumeAfter 一致（不美化也不隐瞒）',
    undoC.volumeAfter === null
      ? /未量到/.test(undone?.summary ?? '')
      : String(undone?.summary ?? '').includes(String(undoC.volumeAfter)),
    { summary: undone?.summary, volumeAfter: undoC.volumeAfter })
  check('4f undo 的下一步不让继续 undo 追',
    /撤错了不要再用 undo 追|按 baseline/.test(String(undone?.nextActions?.join(' ') ?? '')),
    undone?.nextActions)
  log(`undo 实测：体积 ${undoC.volumeBefore} → ${undoC.volumeAfter}（Δ ${undoC.volumeDelta}）；`
    + `实体 ${undoC.bodiesBefore} → ${undoC.bodiesAfter}；`
    + `包围盒 ${JSON.stringify(undoC.boundingBoxBefore)} → ${JSON.stringify(undoC.boundingBoxAfter)}`)

  // ── 5. 收尾：把这次探针建的文档收掉，不动用户的 ─────────────────────
  const cleaned = await session.tool('workspace', { action: 'cleanup', designId })
  log('cleanup', cleaned?.summary)
} finally {
  session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped.length} skipped`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
