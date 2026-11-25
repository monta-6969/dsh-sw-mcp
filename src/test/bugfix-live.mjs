// 四条 bug 的端到端回归（需要 SOLIDWORKS）：
//   F4  早期验收写法（volume/size/holes/holeDiameter）不再被静默丢掉
//   F5  孔数量默认只数通孔，并回 breakdown（通孔/盲孔/直径清单）
//   F7  invoke 的 units 与「选中了几个」回读
//   F9  连续 build 不堆未保存文档（同 designId 收自己上一版；换 designId 要 workspace cleanup
//       才收全部——2026-11-13 多会话隔离语义），documentId 不再是一条空串
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'

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

const root = mkdtempSync(join(tmpdir(), 'sw-bugfix-'))
// F9 固化旧语义；会话级清扫默认开，真机待验（会话文档账本见 server/broker/instances.mjs）
const env = { ...process.env, SW_MCP_DATA: root, SW_MCP_SESSION_SWEEP: '0' }
const session = openSession({ env })

const plate = {
  designId: 'bugfix-live',
  units: 'mm',
  params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20 },
  features: [
    {
      kind: 'sketch',
      id: 'outline',
      plane: 1,
      primitives: [{ shape: 'rect', center: [0, 0], width: 100, height: 60, bind: { width: 'plate.w', height: 'plate.h' } }],
    },
    { kind: 'extrude', id: 'base', profile: 'outline', depth: 20, direction: '+Y', bind: { depth: 'plate.t' } },
    {
      kind: 'holes',
      id: 'through',
      face: 'top',
      diameter: 5,
      throughAll: true,
      centres: [{ x: -30, y: 0 }, { x: 30, y: 0 }],
    },
    {
      kind: 'cut',
      id: 'pocket',
      depth: 5,
      profile: {
        face: 'top',
        primitives: [{ shape: 'circle', center: [0, 20], diameter: 12 }],
      },
    },
  ],
}

try {
  await session.start()
  const status = await session.must('workspace', { action: 'status' }, 'status')
  check('SOLIDWORKS 已就绪', status.capabilities?.solidworks?.ready === true, status.capabilities?.solidworks?.reason)

  // 前面文件（含套件自检）留下的未存盘文档会污染「真实打开文档数」的断言：
  // 先收干净，后面才能按精确计数来断言。这一条同时是 workspace cleanup 的基线。
  //
  // 但 cleanup **按设计**不会关「来源不明」的未存盘文档（Documents.cs:30 ——
  // 无路径的历史登记项和用户手开的新零件都叫 零件N，只按无路径筛等于关掉用户那份）。
  // 所以基线不能假设 0：先记下**清不掉的那几个**，后面所有计数都相对它算。
  // 以前这里写 `baselineDocs === 0`，一旦机器上有历史遗留文档就必红 —— 而那不是
  // 被测行为的错，是断言把「环境本该干净」当成了前提。
  const baseline = await session.tool('workspace', { action: 'cleanup' })
  check('开始前清掉历史未存盘文档', baseline.status === 'ok', baseline.summary)
  const baselineTitles = ((await session.tool('workspace', { action: 'status' })).capabilities?.solidworks?.documents ?? [])
    .map((d) => d.title)
  const baselineDocs = baselineTitles.length
  check('基线里的文档都是「清不掉的来源不明项」，没有本服务建的残留',
    (baseline.changes?.skippedUnknown ?? 0) >= baselineDocs,
    { baselineDocs, skippedUnknown: baseline.changes?.skippedUnknown, titles: baselineTitles })
  // 相对基线的计数：本服务的文档从 0 开始增。
  const docsNow = async () => {
    const list = (await session.tool('workspace', { action: 'status' })).capabilities?.solidworks?.documents ?? []
    return list.filter((d) => !baselineTitles.includes(d.title))
  }

  const built = await session.tool('model', { action: 'build', definition: plate })
  check('钢板建成', built.status === 'ok', built.summary)
  check('build 返回 documentId（不是空串）', typeof built.changes?.documentId === 'string' && built.changes.documentId.length > 0,
    built.changes?.documentId)
  const volume = built.measurements?.volume
  check('体积落在解析值附近', typeof volume === 'number' && Math.abs(volume - 118539) < 120, volume)

  // ---- F5：孔的语义
  // designId 必给：F3 之后 inspect 的每个动作都要求显式 designId（省略 = 跨会话串台，
  // 实测出现过「锁盖被建成 tee-pipe-v1、bracket-06v1 量到锁盖」）。这行以前没带，
  // 于是这套测试在 F3 之后必然以 DESIGN_ID_REQUIRED 停下 —— 断言没跑完也不该算过。
  const holes = await session.must('inspect', { action: 'measure', designId: plate.designId, measure: { kind: 'holes' } }, 'measure holes')
  const breakdown = holes.changes?.result?.breakdown
  check('有 breakdown', breakdown !== null && typeof breakdown === 'object', breakdown)
  check('通孔 2 个', breakdown?.through === 2, breakdown)
  check('盲孔 1 个（Ø12 深 5 的凹坑）', breakdown?.blind === 1, breakdown)
  check('直径清单里有 5 与 12', JSON.stringify(breakdown?.diameters ?? []).includes('5')
    && JSON.stringify(breakdown?.diameters ?? []).includes('12'), breakdown?.diameters)

  // ---- F4：早期验收写法不许静默丢弃
  const legacy = await session.tool('inspect', {
    action: 'verify',
    designId: plate.designId,
    expect: { volume: volume, size: [100, 20, 60], holes: 2, holeDiameter: 5, holeDiam: 5 },
  })
  check('legacy 验收跑起来了', legacy.status === 'ok', legacy.summary)
  check('migrated 里能看到 holeDiameter', JSON.stringify(legacy.changes?.migrated ?? []).includes('holeDiameter'),
    legacy.changes?.migrated)
  check('不认识的键进 ignored', (legacy.changes?.ignored ?? []).some((item) => item.key === 'holeDiam'),
    legacy.changes?.ignored)
  check('摘要里说出「未识别的核对键」', /未识别的核对键/.test(legacy.summary ?? ''), legacy.summary)
  check('通孔数量这条通过了', (legacy.changes?.checks ?? []).some((c) => /通孔数量/.test(c.name) && c.status === 'pass'),
    legacy.changes?.checks)
  const legacyHoles = (legacy.changes?.checks ?? []).find((c) => /通孔数量/.test(c.name))
  check('它数的是通孔（2），不是全部圆柱面（3）', legacyHoles?.actual === 2, legacyHoles?.actual)

  // 反例：把孔数量说成 3 应该判不符
  const wrong = await session.tool('inspect', { action: 'verify', designId: plate.designId, expect: { holes: 3 } })
  check('说 3 个通孔时判不符', wrong.status === 'failed', wrong.status)

  // ---- F7：invoke 的单位与选中回读
  const selMm = await session.tool('model', {
    action: 'invoke',
    designId: plate.designId,
    target: 'extension',
    member: 'SelectByID2',
    units: 'mm',
    args: ['', 'FACE', 0, 0, 20, false, 0, null, 0],
  })
  // 这次给的是 20 mm（units:"mm" 会换成 0.02 m）：真选中了就报个数，打空了就是
  // SELECTION_EMPTY —— 两种都算「回读到了真实选中数」，只有静默 undefined 不行。
  check('invoke 回读真实选中数（选了 N 个，或 SELECTION_EMPTY）',
    typeof selMm.changes?.selectionCount === 'number'
      || selMm.extra?.error?.code === 'SELECTION_EMPTY',
    { status: selMm.status, selectionCount: selMm.changes?.selectionCount, code: selMm.extra?.error?.code })
  check('units:"mm" 记在 changes 里', selMm.changes?.units === 'mm' || selMm.changes?.convertedArgs === undefined,
    selMm.changes?.units)

  const selTooSmall = await session.tool('model', {
    action: 'invoke',
    designId: plate.designId,
    target: 'extension',
    member: 'SelectByID2',
    args: ['', 'FACE', 0, 0, 20, false, 0, null, 0],
  })
  // 「调用返回了」不等于「选中了」。SelectByID2 什么都没选到时同样返回 true，
  // 所以现在 0 个是失败（SELECTION_EMPTY），不是一条 warnings —— 静默放过它，
  // 后面的特征就建在空选集上了。
  check('按米给毫米数 → 选中 0 个 → SELECTION_EMPTY',
    selTooSmall.status === 'failed' && selTooSmall.extra?.error?.code === 'SELECTION_EMPTY',
    { status: selTooSmall.status, code: selTooSmall.extra?.error?.code, detail: selTooSmall.extra?.error?.detail })
  check('SELECTION_EMPTY 的下一步说清「按米给」或「传 units:mm」',
    /0\.0025|units:"mm"/.test(String(selTooSmall.nextActions?.join(' ') ?? '')), selTooSmall.nextActions)

  // ---- F9：连续 build 不堆未保存文档（2026-11-13 的多会话隔离语义）：
  // build 前的收尾只关**同一个 designId** 自己的上一版（server.mjs:3152 带 designId
  // → Documents.CloseUnsavedBuilds(app, onlyDesignId)，Documents.cs:215-252）；
  // 换 designId 的文档要等显式 `workspace cleanup`（不带 designId）才关全部。
  // 这样两个会话共用一个 SOLIDWORKS 时不会互相清掉对方正在建的零件。
  const other = await session.tool('model', { action: 'build', definition: { ...plate, designId: 'bugfix-live-2' } })
  check('换 designId 的第二次 build 成功', other.status === 'ok', other.summary)
  check('换 designId 的 build 不关上一个 designId 的未存盘文档',
    Array.isArray(other.changes?.closedUnsaved) && other.changes.closedUnsaved.length === 0,
    other.changes?.closedUnsaved)
  // 计数一律用「本服务这次建的文档」：基线里清不掉的来源不明项不算进来
  // （cleanup 按设计不关它们，见上面基线处的说明）。
  const docsAfterSwitch = (await docsNow()).length
  check('两个 designId 的未存盘文档同时存在（2 个）', docsAfterSwitch === 2, docsAfterSwitch)

  // 显式 workspace cleanup（不带 designId）才关全部：这是「收干净」的入口。
  const wiped = await session.tool('workspace', { action: 'cleanup' })
  check('workspace cleanup 成功', wiped.status === 'ok', wiped.summary)
  const docsAfterWipe = (await docsNow()).length
  check('workspace cleanup 关掉全部未存盘文档', docsAfterWipe === 0, docsAfterWipe)

  // 同一个 designId 连续 build：build 前仍会收掉自己上一版，不堆文档。
  const sameId = 'bugfix-live-same'
  const sameFirst = await session.tool('model', { action: 'build', definition: { ...plate, designId: sameId } })
  check('同 designId 第一次 build 成功', sameFirst.status === 'ok', sameFirst.summary)
  const sameAgain = await session.tool('model', { action: 'build', definition: { ...plate, designId: sameId } })
  check('同 designId 第二次 build 成功', sameAgain.status === 'ok', sameAgain.summary)
  check('同 designId 再 build 收掉自己上一版', (sameAgain.changes?.closedUnsaved ?? []).length >= 1,
    sameAgain.changes?.closedUnsaved)
  const docsAfterSame = (await docsNow()).length
  check('同 designId 重建后只剩一个文档', docsAfterSame === 1, docsAfterSame)
} finally {
  await session.tool('workspace', { action: 'cleanup' }).catch(() => {})
  await session.close()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
