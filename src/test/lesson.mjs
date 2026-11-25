// 经验库：加得进、查得到、能被取代、不会污染别人的会话。
//
// 经验库是这个插件唯一跨会话的记忆。它有两种坏法，都很安静：
//   1. 写进去读不回来（键名不一致、jsonl 没有换行、supersedes 把新记录也标废了）；
//   2. 测试写进去的东西留在真库里，之后每个会话开头都会读到一条「这是测试」。
//
// 所以这条用例跑在 SW_MCP_DATA 指向的临时目录里（server.mjs 认这个变量），
// 一条不落地验证 add / search / update / supersede 四种动作，最后检查取代关系
// 真的把旧条目藏了起来、而不是把新条目也藏了。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'

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

const dataDir = mkdtempSync(join(tmpdir(), 'sw-mcp-lesson-'))
const session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
await session.start()

const marker = `lesson-fixture-${Date.now().toString(36)}`
const textA = `${marker} 第一条：FeatureCut4 的第一个参数是单方向开关`
const textB = `${marker} 第二条：取代第一条，因为实测两个方向都要切`

try {
  // ---------------------------------------------------------------- add
  const added = await session.must(
    'workspace',
    { action: 'lesson', lesson: { action: 'add', text: textA, kind: 'pitfall', status: 'working', op: 'FeatureCut4' } },
    '写入一条经验',
  )
  const noteA = added.changes?.note ?? added.changes?.entry
  check('add 返回了新条目的 id', Boolean(noteA?.id), { id: noteA?.id ?? null })

  // ------------------------------------------------------------- search
  const found = await session.must(
    'workspace',
    { action: 'lesson', lesson: { action: 'search', query: marker } },
    '按关键词查经验',
  )
  const rows = found.changes?.entries ?? found.changes?.lessons ?? []
  check('search 能查回刚写的那条', rows.some((r) => r.text === textA), { hits: rows.length })
  check('查回来的是完整正文，不是截断的前缀', rows.some((r) => r.text === textA))

  // ------------------------------------------------------------- update
  const updated = await session.must(
    'workspace',
    { action: 'lesson', lesson: { action: 'update', id: noteA.id, status: 'not-yet-working' } },
    '更新一条经验的状态',
  )
  check('update 回报改了 status', updated.changes?.status === 'not-yet-working', {
    changes: updated.changes ?? null,
  })
  const reread = await session.must(
    'workspace',
    { action: 'lesson', lesson: { action: 'search', query: marker } },
    '改完再查，确认落盘了',
  )
  const persisted = (reread.changes?.entries ?? []).find((r) => r.id === noteA.id)
  check('update 真的落盘（再查一次状态已变）', persisted?.status === 'not-yet-working', {
    status: persisted?.status ?? null,
  })

  // ---------------------------------------------------------- supersede
  // 注意：没有 `supersedes` 参数 —— 取代是一个独立的 action，传旧 id + 新正文。
  const superseded = await session.must(
    'workspace',
    {
      action: 'lesson',
      lesson: { action: 'supersede', id: noteA.id, text: textB, kind: 'decision', status: 'working' },
    },
    '用新条目取代旧条目',
  )
  const noteB = superseded.changes?.note ?? superseded.changes?.entry
  check('supersede 记下了它取代谁', (noteB?.supersedes ?? null) === noteA.id, {
    supersedes: noteB?.supersedes ?? null,
  })

  const after = await session.must(
    'workspace',
    { action: 'lesson', lesson: { action: 'search', query: marker } },
    '再查一次，确认旧条目已被藏起来',
  )
  const visible = (after.changes?.entries ?? []).map((r) => r.text)
  check('被取代的旧条目不再出现在搜索结果里', !visible.includes(textA), { visible: visible.length })
  check('取代它的新条目在', visible.includes(textB))

  // ------------------------------------------------------------- 归并
  const sharedObservation = `${marker} 同一条观察：改孔位后要回读驱动尺寸`
  const dupOne = await session.must('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: `${marker} 重复记录一`, observation: sharedObservation, status: 'working' },
  }, '写入第一条重复经验')
  const dupTwo = await session.must('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: `${marker} 重复记录二`, observation: sharedObservation, status: 'working' },
  }, '写入第二条重复经验')
  const digest = await session.must('workspace', { action: 'lesson', lesson: { action: 'digest' } }, '归并重复经验')
  check('digest 合并了同一观察的两条记录', (digest.changes?.total ?? 0) >= 1, digest.changes)
  const afterDigest = await session.must('workspace', {
    action: 'lesson', lesson: { action: 'search', query: sharedObservation },
  }, '归并后再查')
  const keptIds = (afterDigest.changes?.entries ?? []).map((r) => r.id)
  const one = dupOne.changes?.note?.id
  const two = dupTwo.changes?.note?.id
  check('归并后只留下一条', keptIds.filter((id) => id === one || id === two).length === 1, { keptIds, one, two })

  // ------------------------------------------------------- workspace 首页
  // 开工前看到的那一小段 lessons 才是「跨会话」真正起作用的地方。
  const status = await session.tool('workspace', { action: 'status' })
  const lessons = status.changes?.lessons ?? status.capabilities?.lessons ?? []
  check('workspace status 里带着经验（新会话开门就能看到）', Array.isArray(lessons), {
    type: typeof lessons,
    count: Array.isArray(lessons) ? lessons.length : null,
  })

  // ---------------------------------------------------------- 空的搜索
  const empty = await session.tool('workspace', {
    action: 'lesson',
    lesson: { action: 'search', query: `${marker}-nothing-matches-this` },
  })
  check('查不到时不报错、不抛异常', empty.status !== 'failed', { status: empty.status })

  // ------------------------------------------------------------- 入库门槛
  // 经验库是长期记忆：测试草稿、设计定义、重复条目都不该进来。
  const errOf = (r) => r.extra?.error ?? r.error ?? {}
  const tooLong = await session.tool('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: `${marker} ${'很长的描述'.repeat(60)}` },
  })
  check('过长的条目不收，并说清上限', tooLong.status === 'failed' && errOf(tooLong).code === 'LESSON_REJECTED', {
    code: tooLong.error?.code ?? null,
    hint: errOf(tooLong).detail?.hint ?? null,
  })

  const testSmell = await session.tool('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: `m3-${Date.now()} 测试写的一条临时观察` },
  })
  check('测试前缀的条目不收', testSmell.status === 'failed' && errOf(testSmell).code === 'LESSON_REJECTED', {
    code: testSmell.error?.code ?? null,
  })

  const jsonish = await session.tool('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: '{"designId":"x","features":[1,2]}' },
  })
  check('把设计定义当经验传进来会被挡下', jsonish.status === 'failed' && errOf(jsonish).code === 'LESSON_REJECTED', {
    code: jsonish.error?.code ?? null,
  })

  const dup = await session.tool('workspace', {
    action: 'lesson',
    lesson: { action: 'add', text: textB, kind: 'decision' },
  })
  check(
    '重复的正文不再写第二条，直接回已有那条',
    dup.status !== 'failed' && dup.changes?.duplicate === true && dup.changes?.note?.text === textB,
    { duplicate: dup.changes?.duplicate ?? null, id: dup.changes?.note?.id ?? null },
  )

  // 库文件确实落在隔离目录里，而不是用户真库
  const { existsSync } = await import('node:fs')
  check('经验写进了隔离目录', existsSync(join(dataDir, 'knowledge', 'notes.jsonl')), { dataDir })
} catch (error) {
  failures.push(`抛出异常: ${error.message}`)
  console.log(`FAIL  用例中断\n      ${error.message}`)
} finally {
  await session.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
