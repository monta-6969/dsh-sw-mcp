// 快照：图、测量、文件指纹必须是「同一刻」的三样东西。
//
// 这条测试用假的 callBridge 跑：真桥接器要 SOLIDWORKS，而这里要验的是**绑定逻辑**
// —— 同一个 id 在不同时刻必须不一样、同样的内容必须算出同样的 id、一条测量失败
// 不能把整张快照判成好，也不能把它整个丢掉。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshot, describeSnapshot, loadSnapshot } from '../server/snapshot.mjs'

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

const root = mkdtempSync(join(tmpdir(), 'sw-snapshot-'))
process.env.SW_MCP_DATA = root
const docPath = join(root, 'p2.SLDPRT')
writeFileSync(docPath, 'doc-v1')
const artifact = join(root, 'p2.step')
writeFileSync(artifact, 'step-v1')

/** 假桥接器：capture 真写一个文件（内容由 pixels 决定），measure 按 kind 回数。 */
function fakeBridge({ pixels = 'png-a', failKinds = [], docBytes = 'doc-v1' } = {}) {
  const calls = []
  return {
    calls,
    async call(op, args) {
      calls.push({ op, args })
      if (op === 'capture') {
        mkdirSync(join(args.path, '..'), { recursive: true })
        writeFileSync(args.path, pixels)
        if (docBytes !== null) writeFileSync(docPath, docBytes)
        return {
          saved: true,
          path: args.path,
          bytes: Buffer.byteLength(pixels),
          width: args.width ?? 1280,
          height: args.height ?? 800,
          document: { title: 'p2.SLDPRT', path: docPath, dirty: false },
        }
      }
      if (op === 'measure') {
        if (failKinds.includes(args.kind)) {
          const error = new Error(`no ${args.kind}`)
          error.code = 'NO_MEASUREMENT'
          throw error
        }
        if (args.kind === 'cylinders') return { kind: 'cylinders', matches: [{ diameter: 40 }, { diameter: 80 }] }
        return { kind: args.kind, count: 2 }
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
}

// ── 1. 正常一张 ────────────────────────────────────────────────
{
  const bridge = fakeBridge()
  const snapshot = await createSnapshot({
    callBridge: bridge.call,
    designId: 'p2-housing',
    view: '*右视',
    measures: [
      { name: '孔数', measure: { kind: 'holes', expect: 'count' } },
      { name: '外径', measure: { kind: 'cylinders' } },
    ],
  })

  check('有 snapshotId', typeof snapshot.snapshotId === 'string' && snapshot.snapshotId.length === 12, snapshot.snapshotId)
  check('图落下来了', snapshot.image.digest !== null && snapshot.image.bytes > 0, snapshot.image)
  check('两条测量都在', snapshot.measurements.length === 2, snapshot.measurements.map((m) => m.name))
  check('没量成的列表为空', snapshot.missing.length === 0, snapshot.missing)
  check('文档标识带出来', snapshot.document?.title === 'p2.SLDPRT', snapshot.document?.title)
  check('文档指纹算出来了', typeof snapshot.digests.document === 'string', snapshot.digests)
  check('摘要说清是什么', /快照 .*2 条测量.*全部量成/.test(describeSnapshot(snapshot)), describeSnapshot(snapshot))

  const stored = loadSnapshot(snapshot.snapshotId)
  check('状态盘里读得回来', stored.record?.snapshotId === snapshot.snapshotId, stored.path)
  check('状态盘记了视图', stored.record?.image?.view === '*右视', stored.record?.image)

  const again = await createSnapshot({ callBridge: fakeBridge().call, designId: 'p2-housing', view: '*右视', measures: [
    { name: '孔数', measure: { kind: 'holes', expect: 'count' } },
    { name: '外径', measure: { kind: 'cylinders' } },
  ] })
  check('同样内容算出同样的 id（可比对）', again.snapshotId === snapshot.snapshotId, {
    first: snapshot.snapshotId, second: again.snapshotId,
  })

  const changed = await createSnapshot({ callBridge: fakeBridge({ pixels: 'png-b' }).call, designId: 'p2-housing', view: '*右视', measures: [] })
  check('图变了 id 就变', changed.snapshotId !== snapshot.snapshotId, {
    before: snapshot.snapshotId, after: changed.snapshotId,
  })
}

// ── 2. 一条测量失败 ────────────────────────────────────────────
{
  const snapshot = await createSnapshot({
    callBridge: fakeBridge({ failKinds: ['holes'] }).call,
    measures: [
      { name: '孔数', measure: { kind: 'holes' } },
      { name: '外径', measure: { kind: 'cylinders' } },
    ],
  })
  check('失败的那条进 missing', snapshot.missing.includes('孔数'), snapshot.missing)
  check('失败原因记下来了', snapshot.measurements[0].ok === false && snapshot.measurements[0].error.code === 'NO_MEASUREMENT',
    snapshot.measurements[0])
  check('其他测量仍可用', snapshot.measurements[1].ok === true, snapshot.measurements[1].name)
  check('摘要如实说不全', /1 条没量成/.test(describeSnapshot(snapshot)), describeSnapshot(snapshot))
}

// ── 3. 带交付文件指纹 ─────────────────────────────────────────
{
  const bridge = fakeBridge({ docBytes: 'doc-v2' })
  const snapshot = await createSnapshot({ callBridge: bridge.call, measures: [], artifactPath: artifact })
  check('交付文件指纹钉进来了', snapshot.artifact?.digest !== null, snapshot.artifact)
  check('artifact 指纹进了总指纹', snapshot.digests.artifact === snapshot.artifact.digest, snapshot.digests)

  writeFileSync(artifact, 'step-v2')
  const later = await createSnapshot({ callBridge: fakeBridge({ docBytes: 'doc-v2' }).call, measures: [], artifactPath: artifact })
  check('换了一份交付文件 id 就变', later.snapshotId !== snapshot.snapshotId, {
    before: snapshot.snapshotId, after: later.snapshotId,
  })
}

// ── 4. capture 失败要抛，而不是返回一张空快照 ─────────────────
{
  let threw = null
  try {
    await createSnapshot({
      callBridge: async () => { throw Object.assign(new Error('no doc'), { code: 'NO_ACTIVE_DOC' }) },
      measures: [],
    })
  } catch (error) {
    threw = error
  }
  check('取不到图时立刻失败', threw?.code === 'NO_ACTIVE_DOC', threw?.code)
}

check('状态盘文件真的写了', (() => {
  try {
    const store = JSON.parse(readFileSync(join(root, 'review', 'snapshots.json'), 'utf8'))
    return Object.keys(store.snapshots).length >= 3
  } catch {
    return false
  }
})(), join(root, 'review', 'snapshots.json'))

// ── 5. 分步兜底路径必须带 designId，且两条路行为一致 ────────────
//
// 桥接器对文档的解析分两类（Operations.cs）：
//   · capture → RequireDesignDocument  → 不带 designId 直接 DESIGN_ID_REQUIRED
//   · measure → OptionalDesignDocument → 不带 designId **静默量前台那份**
// 第二类是这个 bug 的来源：多开一份文档就量到别人，而且回的是看起来合理的假数字。
// 这里用「原子路径失败」逼代码走分步兜底，再断言两个请求都带上了同一个 designId。
{
  // atomicBridge：snapshot 故意不认识（旧桥接器），capture/measure 正常。
  const inner = fakeBridge({ pixels: 'png-fallback' })
  const calls = []
  const bridge = {
    async call(op, args) {
      calls.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) })
      if (op === 'snapshot') {
        const error = new Error('BAD_ARGUMENT: unknown op snapshot')
        error.code = 'BAD_ARGUMENT'
        throw error
      }
      return inner.call(op, args)
    },
  }
  const snapshot = await createSnapshot({
    callBridge: bridge.call,
    designId: 'B-后板',
    measures: [
      { name: '高', measure: { kind: 'distance' } },
      { name: '孔数', measure: { kind: 'holes' } },
    ],
  })
  const captureCall = calls.find((call) => call.op === 'capture')
  const measureCalls = calls.filter((call) => call.op === 'measure')
  check('分步兜底：capture 带 designId（否则 RequireDesignDocument 直接报错）',
    captureCall?.args?.designId === 'B-后板', captureCall?.args)
  check('分步兜底：每条 measure 都带 designId（否则静默量前台文档）',
    measureCalls.length === 2 && measureCalls.every((call) => call.args.designId === 'B-后板'),
    measureCalls.map((call) => call.args))
  check('分步兜底：measure 的 kind 没被 designId 顶掉',
    measureCalls.map((call) => call.args.kind).join(',') === 'distance,holes',
    measureCalls.map((call) => call.args.kind))
  check('分步兜底：记录里 request 也写着 designId（可回看量的是哪份）',
    (snapshot.measurements ?? []).every((item) => item.request?.designId === 'B-后板'),
    snapshot.measurements.map((item) => item.request))
  check('分步兜底：快照本身仍然成立',
    typeof snapshot.snapshotId === 'string' && snapshot.image.digest !== null, snapshot.snapshotId)
}

// ── 5b. 单条 measure 可以覆盖 designId；不传 designId 时保持原样（不硬塞 null）──
{
  const inner = fakeBridge({ pixels: 'png-override' })
  const calls = []
  const bridge = {
    async call(op, args) {
      calls.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) })
      if (op === 'snapshot') throw Object.assign(new Error('no snapshot'), { code: 'BAD_ARGUMENT' })
      return inner.call(op, args)
    },
  }
  await createSnapshot({
    callBridge: bridge.call,
    designId: 'B-后板',
    measures: [{ name: '量底板', measure: { kind: 'distance', designId: 'A-底板' } }],
  })
  const measureCall = calls.find((call) => call.op === 'measure')
  check('spec.measure.designId 覆盖快照的 designId', measureCall?.args?.designId === 'A-底板', measureCall?.args)

  const noDesign = []
  const bridge2 = {
    async call(op, args) {
      noDesign.push({ op, args: JSON.parse(JSON.stringify(args ?? {})) })
      if (op === 'snapshot') throw Object.assign(new Error('no snapshot'), { code: 'BAD_ARGUMENT' })
      return inner.call(op, args)
    },
  }
  await createSnapshot({ callBridge: bridge2.call, measures: [{ name: '孔数', measure: { kind: 'holes' } }] })
  const noDesignMeasure = noDesign.find((call) => call.op === 'measure')
  check('没有 designId 时请求里不出现 designId 字段（保持旧契约，不塞 null）',
    noDesignMeasure !== undefined && !('designId' in noDesignMeasure.args), noDesignMeasure?.args)
}

rmSync(root, { recursive: true, force: true })
process.env.SW_MCP_DATA = undefined

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
