// verify 的回包必须自己说清「expect 能用哪些键」，失败分支必须给指路。
//
// 为什么有这条测试（R2 实测）：一次建模会话里，模型为凑对 inspect verify 的 expect
// 键连写了 30 个错键、8 次调用（约 7.4 s 工具时间、按 31.9 s/轮 ≈ 4.3 分钟墙钟），
// 因为每次失败只回一句「未识别的核对键 X（没有参与判定）」，不给可用键白名单 ——
// 而白名单本来就在 server.mjs 里。这个用例钉住四件事：
//   1) 非法核对键 → 摘要带「可用键」白名单，nextActions 指向 expect.checks[]；
//   2) 合法核对键 → 摘要不被白名单噪音弄脏（正常回包保持原样）；
//   3) 有真失败项（原来 nextActions 是 undefined）→ 也给指路，且不重复文案；
//   4) 顶层把 expect 写成 expectations → UNKNOWN_PARAM 的指路指向 expect schema，
//      不再送去 workspace action=project（那是改设计参数的入口，与 verify 无关）。
//   5) NO_MEASUREMENT 的「候选直径」指路不分 measure.kind：holes 的直径在
//      breakdown.diameters、cylinders 只在记录里，只读 available.diameters 时
//      孔场景下提示是空的（R2 实测的「模型无从下手」）。都没有时要说「没有可用候选」。
//
// 全部离线：broker + 本文件现写的假 worker（SW_MCP_BROKER=1），不设
// SW_MCP_BROKER_ENSURE（默认不探 ROT、不启动 SOLIDWORKS），也不碰 *-live.mjs。
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'sw-verify-hints-'))
const workDir = join(root, 's1')
mkdirSync(workDir, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 假 worker：只回答 verify 会碰的两类 op（inspect 取几何、measure 取数）。
// 孔是 2 个 Ø5 通孔 —— 这样「期望 2」通过、「期望 3」真的不符。
const workerSource = `
const NL = String.fromCharCode(10)
const GEOMETRY = {
  document: { title: '假件' },
  geometry: {
    massProperties: { volume: 24000 },
    boundingBox: { size: [60, 40, 10], min: [0, 0, 0], max: [60, 40, 10] },
    holes: [{ diameter: 5, x: 10, y: 10 }, { diameter: 5, x: 50, y: 30 }],
  },
}
function handle(op, args) {
  if (op === 'instances') return { instances: [] }
  if (op === 'version') return { ready: true, revision: 'fake-verify-hints' }
  if (op === 'status') return { ready: true, revision: 'fake-verify-hints', documents: [] }
  if (op === 'inspect') {
    if (args.action === 'model' || args.format === 'tree') {
      return { changes: { featureTree: [], sketches: [] } }
    }
    return GEOMETRY
  }
  if (op === 'measure') {
    const kind = args.kind ?? 'axis'
    if (kind === 'holes') {
      // 照真 Measure.Holes 的形状：没有 available，直径只出现在 breakdown.diameters
      // （还是字符串，和 C# 的 Json.R(diameter) + "" 一致）。K2 就是钉这个：
      // 「孔量不到」时的候选直径必须能从 breakdown 里捞出来。
      return {
        kind, count: 2, cylinderFaces: 2,
        breakdown: { through: 2, blind: 0, unknown: 0, diameters: ['5', '18'] },
        holes: [{ diameter: 5, through: true }, { diameter: 5, through: true }],
        matches: [], pairs: [],
      }
    }
    if (kind === 'cylinders') {
      // 照真 Measure.Cylinders：既没有 available 也没有 breakdown，直径只在记录里。
      return {
        kind, count: 2,
        cylinders: [{ diameter: 11.1, isHole: false, kind: 'boss' }, { diameter: 5.7, isHole: true, kind: 'hole' }],
      }
    }
    if (kind === 'planes') return { kind, count: 1, planes: [{ normal: [0, 0, 1] }] }
    if (kind === 'axis') {
      return {
        kind, diameter: args.diameter ?? null, count: 1,
        matches: [{ diameter: args.diameter ?? null }],
        heightAboveMinY: [{ heightAboveMinY: 30 }], available: { diameters: [args.diameter ?? 0] },
      }
    }
    if (kind === 'spacing') return { kind, count: 2, pairs: [{ distance: 40 }], available: { diameters: [] } }
    if (kind === 'distance') return { kind, distance: 25, along: 'Y', available: { diameters: [] } }
    return { kind, count: 1, available: { diameters: [] } }
  }
  return { __error: { code: 'FAKE_UNKNOWN_OP', message: op } }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    const { id, op, ...args } = request
    let outcome
    try { outcome = handle(op, args) } catch (error) {
      outcome = { __error: { code: 'FAKE_WORKER_ERROR', message: String(error && error.message ? error.message : error) } }
    }
    const payload = outcome.__error ? { id, ok: false, error: outcome.__error } : { id, ok: true, ...outcome }
    process.stdout.write(JSON.stringify(payload) + NL)
  }
})
process.stdin.on('end', () => process.exit(0))
`
const workerPath = join(workDir, 'fake-worker.mjs')
writeFileSync(workerPath, workerSource)

const pipe = '\\\\.\\pipe\\sw-verify-hints-' + process.pid + '-' + Date.now()
const env = {
  ...process.env,
  SW_MCP_BROKER: '1',
  SW_MCP_BROKER_PIPE: pipe,
  SW_MCP_BROKER_DIR: join(workDir, 'broker'),
  SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, workerPath]),
  SW_MCP_DATA: join(workDir, 'data'),
  SW_MCP_SESSION_SWEEP: '0',
}
// 关键：不设 SW_MCP_BROKER_ENSURE —— 默认不探 ROT、不启动 SOLIDWORKS。
delete env.SW_MCP_BROKER_ENSURE
delete env.SW_MCP_SESSION_ID
delete env.SW_MCP_BROKER_INSTANCE

const session = openSession({ env })
try {
  await session.start()

  // ── 1. 非法核对键（R2 里的那批霰弹键）──────────────────────────────────
  // 期望值一项都没有合法键 → 语义仍是 not-run，但摘要必须给出白名单。
  const illegal = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: { thickness: 15, boundingBox: [60, 40, 10], diameter: 40, length: 60, width: 40 },
  })
  check('非法键：回包没崩（status/summary 都在）',
    typeof illegal.status === 'string' && typeof illegal.summary === 'string',
    { status: illegal.status, summary: illegal.summary })
  check('非法键：status 保持 not-run 原语义（没有核对项可跑）', illegal.status === 'not-run', illegal.status)
  check('非法键：原始前缀「未识别的核对键 …（没有参与判定）」还在',
    /未识别的核对键[^；]*（没有参与判定）/.test(String(illegal.summary)), illegal.summary)
  check('非法键：ignored 里逐条记下没被听见的键',
    (illegal.changes?.ignored ?? []).map((item) => item.key).join(',') === 'thickness,boundingBox,diameter,length,width',
    illegal.changes?.ignored)
  check('非法键：摘要给出「可用键」白名单', String(illegal.summary).includes('可用键'), illegal.summary)
  check('非法键：白名单里能直接看到 holeDiameter（R2 猜了 9 次才凑到的那个）',
    String(illegal.summary).includes('holeDiameter'), illegal.summary)
  check('非法键：摘要说明逐项核对用 expect.checks[]', String(illegal.summary).includes('expect.checks'), illegal.summary)
  check('非法键：nextActions 非空且指向 expect.checks',
    Array.isArray(illegal.nextActions) && illegal.nextActions.length > 0
      && illegal.nextActions.join(' ').includes('expect.checks'),
    illegal.nextActions)

  // ── 2. 数组写法的 holes：在 schema 层就被明确拒掉，不是静默丢弃 ─────────
  // （zod schema 里 expect.holes 是 number；这一层在 handler 之前，回的是
  //   isError 的校验错误。这里钉住「它响亮地失败」，而不是被当成没写。）
  const rawArray = await session.call('tools/call', {
    name: 'inspect',
    arguments: { action: 'verify', designId: 'verify-hints', expect: { holes: [{ diameter: 40 }], thickness: 15 } },
  })
  const arrayText = rawArray?.content?.find((c) => c.type === 'text')?.text ?? ''
  check('holes 传数组：schema 层明确拒绝（isError）而不是静默通过', rawArray?.isError === true, rawArray)
  check('holes 传数组：错误点指出 expect.holes 该是 number',
    /expect\.holes/.test(arrayText) && /expected number/i.test(arrayText), arrayText)

  // ── 3. 合法核对键：回包保持干净，不许出现白名单噪音 ────────────────────
  const good = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: { holeCount: 2, holeDiameter: 5 },
  })
  const goodChecks = good.changes?.checks ?? []
  check('合法键：真的跑了核对并判 ok', good.status === 'ok' && goodChecks.length === 1,
    { status: good.status, checks: goodChecks.map((c) => [c.name, c.status]), summary: good.summary })
  check('合法键：摘要仍写「验收通过」', String(good.summary).includes('验收通过'), good.summary)
  check('合法键：摘要没有「可用键」白名单噪音', !String(good.summary).includes('可用键'), good.summary)
  check('合法键：摘要没有「未识别」噪音', !String(good.summary).includes('未识别'), good.summary)

  // ── 4. 有真失败项：原来 nextActions 是 undefined，现在必须指路 ──────────
  const mixed = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: {
      checks: [{ name: '孔数', measure: 'holes', pick: 'count', expect: 3, tol: 0 }],
      thickness: 15,
    },
  })
  const mixedNext = mixed.nextActions ?? []
  check('真不符：status 仍是 failed（判定语义没动）', mixed.status === 'failed', mixed.summary)
  check('真不符：摘要里同时有失败项与白名单',
    /验收未通过/.test(String(mixed.summary)) && String(mixed.summary).includes('可用键'), mixed.summary)
  check('真不符：nextActions 不再 undefined', Array.isArray(mixed.nextActions) && mixed.nextActions.length > 0, mixedNext)
  check('真不符：指路列出没参与判定的键并说改成 expect.checks[]',
    mixedNext.some((item) => item.includes('thickness') && item.includes('expect.checks')), mixedNext)
  check('真不符：指路给出可用键清单',
    mixedNext.some((item) => item.includes('可用键') && item.includes('holeDiameter')), mixedNext)
  check('真不符：指路要求改模型后重跑 build→relations→verify',
    mixedNext.some((item) => item.includes('build') && item.includes('relations') && item.includes('verify')), mixedNext)

  // ── 5. 顶层把 expect 写成 expectations：指路指向 expect schema ──────────
  const typo = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expectations: [{ measure: 'holes', expect: 2 }],
  })
  const typoNext = typo.nextActions ?? []
  check('顶层错键：错误码仍是 UNKNOWN_PARAM', typo.extra?.error?.code === 'UNKNOWN_PARAM', typo.extra?.error)
  check('顶层错键：指路指向 expect 的可用键与 checks[]',
    typoNext.some((item) => item.includes('可用键')) && typoNext.some((item) => item.includes('expect.checks')),
    typoNext)
  check('顶层错键：不再把模型送去 workspace action=project（跨域误导）',
    !typoNext.join(' ').includes('workspace'), typoNext)
  check('顶层错键：同义词指路 expectations → expect',
    /expectations\s*→\s*expect/.test(String(typo.summary)), typo.summary)

  // ── 6. NO_MEASUREMENT 的指路：候选直径不分 kind 都要读得到 ──────────────
  // 缺口：提示只读 result.available.diameters，而 kind="holes" 把直径放在
  // breakdown.diameters（Measure.cs:456）、kind="cylinders" 只在记录里
  // （Measure.cs:462-477）。于是「孔量不到」时那句提示是空的，模型无从下手。
  const holesHint = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: { checks: [{ name: '孔径', measure: 'holes', pick: 'diameter', expect: 5, tol: 0 }] },
  })
  const holesCheck = holesHint.changes?.checks?.[0] ?? {}
  check('没量成：holes 的 breakdown 直径进了提示（不靠 axis 的 available）',
    holesCheck.reason === 'NO_MEASUREMENT'
      && holesHint.status === 'incomplete'
      && String(holesCheck.note).includes('5, 18')
      && holesCheck.available === null,
    { status: holesHint.status, reason: holesCheck.reason, note: holesCheck.note, available: holesCheck.available })

  const cylindersHint = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: { checks: [{ name: '轴径', measure: 'cylinders', pick: 'diameter', expect: 11.1, tol: 0 }] },
  })
  const cylindersCheck = cylindersHint.changes?.checks?.[0] ?? {}
  check('没量成：cylinders 记录里的直径也进提示，并去重排序',
    cylindersCheck.reason === 'NO_MEASUREMENT'
      && String(cylindersCheck.note).includes('5.7, 11.1'),
    { reason: cylindersCheck.reason, note: cylindersCheck.note })

  const emptyHint = await session.tool('inspect', {
    action: 'verify',
    designId: 'verify-hints',
    expect: { checks: [{ name: '任意面', measure: 'planes', pick: 'diameter', expect: 1, tol: 0 }] },
  })
  const emptyCheck = emptyHint.changes?.checks?.[0] ?? {}
  check('一个候选都没有：不崩，且明说「没有可用候选」而不是留半句空话',
    emptyHint.status === 'incomplete'
      && emptyCheck.reason === 'NO_MEASUREMENT'
      && String(emptyCheck.note).includes('没有可用候选'),
    { status: emptyHint.status, reason: emptyCheck.reason, note: emptyCheck.note })
} finally {
  try { session.child.kill() } catch { /* 已经在退 */ }
  if (session.child.exitCode === null) await Promise.race([once(session.child, 'exit'), sleep(2000)])
  try {
    const client = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 3000 })
    try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } finally { client.close() }
  } catch { /* broker 已经没了 */ }
  await sleep(250)
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中的文件留到下一轮 */ }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
