// 「这个对象上到底有哪些成员」—— invoke 之前的必修课。
//
// 事故现场（session-acd58872）：三次 UNKNOWN_MEMBER 全是打错对象 ——
// SelectByID2 在 IModelDocExtension 上，FeatureExtrusion3 在 IModelDoc2 上，
// 调用方只能靠猜。这条用例钉住 kinds 的三件事：列得出、说得出在哪个接口、
// 翻得动页 —— 以及不知道接口名时给的是 UNKNOWN_TYPE，不是空列表。

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

const session = openSession({})
await session.start()

try {
  await session.must(
    'model',
    {
      action: 'build',
      designId: 'kinds-probe',
      definition: {
        designId: 'kinds-probe',
        features: [
          {
            kind: 'sketch',
            id: 'box_outline',
            plane: 1,
            primitives: [
              { shape: 'rect', center: [0, 0], width: 40, height: 30, bind: { width: 'box.w', height: 'box.d' } },
            ],
          },
          { kind: 'extrude', id: 'box', profile: 'box_outline', depth: 10, direction: '+Y', bind: { depth: 'box.t' } },
        ],
      },
    },
    '先建一个 40×30×10 的板',
  )

  // ---------------------------------------------------------- 基本清单
  const ext = await session.must('model', { action: 'kinds', target: 'extension', limit: 5 }, '列出 extension 的成员')
  const extTotal = ext.changes?.total ?? 0
  check('extension 上有几百个成员', extTotal > 300, { total: extTotal })
  check('每条成员都说得出声明它的接口', (ext.changes?.members ?? []).every((m) => m.where === 'IModelDocExtension'), {
    where: [...new Set((ext.changes?.members ?? []).map((m) => m.where))],
  })
  check('成员带签名；方法还带参数个数', (ext.changes?.members ?? []).every((m) => Boolean(m.signature) &&
    (m.kind === 'property' || Number.isInteger(m.paramCount))), {
    sample: ext.changes?.members?.[0] ?? null,
  })

  // ------------------------------------------------------------- 分页
  check('limit 生效，并给出 nextOffset', (ext.changes?.members ?? []).length === 5 && ext.changes?.nextOffset === 5, {
    got: ext.changes?.members?.length ?? null,
    nextOffset: ext.changes?.nextOffset ?? null,
  })
  const page2 = await session.must('model', { action: 'kinds', target: 'extension', limit: 5, offset: 5 }, '翻第二页')
  check('翻页拿到的是不同的成员', page2.changes?.members?.[0]?.name !== ext.changes?.members?.[0]?.name, {
    first: ext.changes?.members?.[0]?.name ?? null,
    second: page2.changes?.members?.[0]?.name ?? null,
  })

  // ------------------------------------------------- 多接口目标（关键）
  // partDoc 是真会跨接口的那种目标：IPartDoc 管几何，IModelDoc2 管文档。
  const doc = await session.must('model', { action: 'kinds', target: 'doc', limit: 3 }, '列出 doc 的成员')
  check('doc 的成员数在几百量级', (doc.changes?.total ?? 0) > 500, { doc: doc.changes?.total ?? null })
  const part = await session.must('model', { action: 'kinds', target: 'partDoc', limit: 3 }, '列出 partDoc 的成员')
  const ifaces = part.changes?.interfaces ?? []
  check('partDoc 背后不止一个接口', ifaces.length >= 2, { interfaces: ifaces })
  check('partDoc 的成员总数大于单个接口', (part.changes?.total ?? 0) > (doc.changes?.total ?? 0), {
    partDoc: part.changes?.total ?? null,
    doc: doc.changes?.total ?? null,
  })

  // ------------------------------------------------------ 指名某个接口
  const onlyPart = await session.must('model', { action: 'kinds', target: 'partDoc', iface: 'IPartDoc', limit: 3 }, '只看 IPartDoc')
  check('指名接口时只回这一个接口的成员', (onlyPart.changes?.members ?? []).every((m) => m.where === 'IPartDoc'), {
    where: [...new Set((onlyPart.changes?.members ?? []).map((m) => m.where))],
  })

  // --------------------------------------------------------- 失败要指路
  const bad = await session.tool('model', { action: 'kinds', target: 'extension', iface: 'INoSuchInterface' })
  check('接口名不存在时是 UNKNOWN_TYPE，不是空列表', bad.status === 'failed' && bad.extra?.error?.code === 'UNKNOWN_TYPE', {
    code: bad.extra?.error?.code ?? null,
  })

  // 没有活动文档时也要说清楚，而不是回 0 个成员
  await session.tool('workspace', { action: 'cleanup' })
} catch (error) {
  failures.push(`抛出异常: ${error.message}`)
  console.log(`FAIL  用例中断\n      ${error.message}`)
} finally {
  await session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
