// inspect action="review" —— 模型能不能问「现在这一版审过没有」。
//
// 这条链两侧分工：宿主侧的 review-gate 写状态盘（它拿得到 subagents / attachments），
// MCP 服务只读（它是独立进程，拿不到那两个服务）。测试就照这个分工验：
//   · 盘里没有记录 → not-run，且说清「审查发生在交付那一刻」；
//   · 有记录 → 阶段、结论、区域、待辨识项原样带出去；
//   · 多会话共用一盘 → designId 指定时不许串台；
//   · 观察归一化必须能从 observations 推出差异清单（旧字段仍认）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, serverEntry } from './lib/mcp.mjs'
import { normalizeVerdict } from '../preset/review-gate.js'

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

function writeStore(root, sessions) {
  const dir = join(root, 'review')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'runs.json')
  writeFileSync(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, 'utf8')
  return file
}

function record(overrides = {}) {
  return {
    runId: 'run-a',
    sessionKey: 'sess-a',
    designId: 'p2-housing',
    documentId: 'D:/out/p2.SLDPRT',
    modelRevision: 4,
    reviewedRevision: 4,
    evidenceRevision: 2,
    snapshotId: 'snap-7',
    artifactHash: 'abc123',
    phase: 'different',
    result: 'different',
    confidence: 0.8,
    observations: [
      {
        item: '左侧端槽的开口',
        status: 'different',
        sourceRegion: [0.12, 0.28, 0.19, 0.35],
        modelRegion: [0.11, 0.27, 0.2, 0.36],
        observedDifference: '参考图该处通到端面，模型这一侧仍是封闭材料',
      },
    ],
    unresolved: ['Ø75 旁 3 mm 台阶的朝向'],
    differences: [{ region: '区域 [0.11, 0.27, 0.20, 0.36]', expected: '开口', actual: '封闭' }],
    images: [{ path: 'C:/tmp/a.png', atRevision: 4, origin: 'capture' }],
    reviews: 2,
    updatedAt: '2026-11-10T01:00:00.000Z',
    history: [{ at: '2026-11-10T00:40:00.000Z', modelRevision: 3, result: 'different', confidence: 0.6 }],
    ...overrides,
  }
}

// ---------------------------------------------------------------- 归一化（纯函数）

const derived = normalizeVerdict({
  verdict: 'different',
  confidence: 0.7,
  observations: [
    { item: '角撑', status: 'different', sourceRegion: [0.1, 0.2, 0.3, 0.4], modelRegion: [0.1, 0.2, 0.3, 0.4], observedDifference: '模型多一块' },
    { item: '孔', status: 'match', sourceRegion: [0, 0, 0.1, 0.1], modelRegion: [0, 0, 0.1, 0.1] },
    { item: '槽深', status: 'uncertain', sourceRegion: [0.5, 0.5, 0.6, 0.6], modelRegion: [0.5, 0.5, 0.6, 0.6] },
  ],
})
check('observations 能推出差异清单', derived.differences.length === 1, derived.differences)
check('不同项带上模型区域', String(derived.differences[0]?.region).includes('0.10'), derived.differences[0])
check('different 的内容被带出', String(derived.differences[0]?.actual).includes('多一块'), derived.differences[0])
check('uncertain 单独计数', derived.uncertain === 1, derived.uncertain)

const oldShape = normalizeVerdict({ verdict: 'different', confidence: 0.5, differences: [{ region: '顶面', expected: '有孔', actual: '无孔' }] })
check('旧 differences 字段仍然认', oldShape.differences.length === 1 && oldShape.differences[0].region === '顶面', oldShape.differences)

// ---------------------------------------------------------------- 真 MCP 会话

async function withServer(root, fn) {
  const session = openSession({ entry: serverEntry, env: { ...process.env, SW_MCP_DATA: root } })
  await session.start()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

const empty = mkdtempSync(join(tmpdir(), 'sw-review-read-'))
try {
  await withServer(empty, async (session) => {
    const res = await session.tool('inspect', { action: 'review', designId: 'p2-housing' })
    check('没有记录时不是 ok', res.status === 'not-run', res.status)
    check('没有记录时说清审查发生在交付那一刻',
      /交付|deliver/.test(res.summary ?? ''), res.summary)
    check('changes 带上试过的路径', Array.isArray(res.changes?.tried), res.changes?.tried)
  })
} finally {
  rmSync(empty, { recursive: true, force: true })
}

const withStore = mkdtempSync(join(tmpdir(), 'sw-review-read-'))
try {
  writeStore(withStore, {
    'sess-a': record(),
    'sess-b': record({
      runId: 'run-b', sessionKey: 'sess-b', designId: 'p1-bracket', phase: 'passed', result: 'passed',
      confidence: 0.9, differences: [], observations: [], unresolved: [],
      updatedAt: '2026-11-10T02:00:00.000Z',
    }),
  })

  await withServer(withStore, async (session) => {
    const res = await session.tool('inspect', { action: 'review', designId: 'p2-housing' })
    check('指定 designId 时不串台', res.changes?.phase === 'different', res.changes?.phase)
    check('有差异时状态是 failed', res.status === 'failed', res.status)
    check('摘要带差异行', /图纸「/.test(res.summary ?? ''), res.summary)
    check('带出待辨识项', (res.changes?.unresolved ?? []).length === 1, res.changes?.unresolved)
    check('带出版本三元组',
      res.changes?.modelRevision === 4 && res.changes?.snapshotId === 'snap-7' && res.changes?.artifactHash === 'abc123',
      { modelRevision: res.changes?.modelRevision, snapshotId: res.changes?.snapshotId, artifactHash: res.changes?.artifactHash })
    check('带出区域化观察',
      Array.isArray(res.changes?.observations) && res.changes.observations[0]?.modelRegion?.length === 4,
      res.changes?.observations)
    check('带出历史', (res.changes?.history ?? []).length === 1, res.changes?.history)
    check('给出可执行的下一步', (res.nextActions ?? []).length > 0, res.nextActions)

    const passed = await session.tool('inspect', { action: 'review', designId: 'p1-bracket' })
    check('passed 的记录是 ok', passed.status === 'ok', passed.status)
    check('passed 的下一步说可以交付', (passed.nextActions ?? []).some((a) => /可以交付/.test(a)), passed.nextActions)

    // 不指定 designId 时不再「取最近更新的一条」：实测那样会把别的零件（gate-live）
    // 的 passed 当成本次结论。现在要么给出 designId，要么回 not-run 并说明。
    const latest = await session.tool('inspect', { action: 'review' })
    check('不给 designId 时回 not-run 而不是猜一条', latest.status === 'not-run', latest.status)
    check('并说明不知道问的是哪个件', /不知道你在问哪个件/.test(latest.summary ?? ''), latest.summary)

    const unknown = await session.tool('inspect', { action: 'review', designId: 'no-such-design' })
    check('给了不存在的 designId 回 not-run', unknown.status === 'not-run', unknown.status)
    check('不串到别的零件', unknown.changes?.phase === undefined, unknown.changes?.phase)
  })
} finally {
  rmSync(withStore, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
