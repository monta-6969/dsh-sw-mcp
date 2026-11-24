// 原生对象句柄：invoke/object 返回 obj_N，后续 get/call/set 直接接着用。
// 还要验证 batch 在一次 worker turn 里跑多步。
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'

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
let startedHere = false
try {
  await session.start()
  const sw = await ensureSolidworks((name, args) => session.tool(name, args))
  startedHere = sw.startedHere
  await session.tool('workspace', { action: 'cleanup' })

  const designId = `objects-${Date.now()}`
  const build = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 60, height: 40 }] },
        { id: 'plate', kind: 'extrude', profile: 'outline', depth: 10, direction: '+Y' },
      ],
    },
  })
  check('建出零件', build.status === 'ok', build.summary)

  const target = await session.tool('model', { action: 'object', objectAction: 'target', target: 'featureManager' })
  const fmHandle = target.changes?.handle
  check('object target 返回句柄', /^obj_\d+$/.test(fmHandle ?? ''), target)

  const features = await session.tool('model', { action: 'object', objectAction: 'call', handle: fmHandle, member: 'GetFeatures', args: [true] })
  const items = features.changes?.result?.items ?? []
  check('句柄上调用方法返回数组', features.changes?.result?.kind === 'array' && items.length > 0, features)
  const featureHandle = items.find((item) => item?.type === 'FeatureClass')?.handle ?? items.find((item) => item?.handle)?.handle
  check('数组元素带句柄', /^obj_\d+$/.test(featureHandle ?? ''), items.slice(0, 2))

  const name = await session.tool('model', { action: 'object', objectAction: 'get', handle: featureHandle, member: 'Name' })
  check('句柄上读属性', typeof name.changes?.result === 'string' && name.changes.result.length > 0, name.changes?.result)

  const renamed = await session.tool('model', { action: 'object', objectAction: 'set', handle: featureHandle, member: 'Name', value: 'RenamedByTest' })
  check('句柄上写属性', renamed.status === 'ok' && renamed.changes?.value === 'RenamedByTest', renamed.changes ?? renamed.extra)

  const released = await session.tool('model', { action: 'object', objectAction: 'release', handle: featureHandle })
  check('句柄可释放', released.changes?.released === true, released.changes)
  const gone = await session.tool('model', { action: 'object', objectAction: 'get', handle: featureHandle, member: 'Name' })
  check('释放后的句柄明确报错', gone.status === 'failed' && gone.extra?.error?.code === 'HANDLE_NOT_FOUND', gone.extra?.error)

  const batch = await session.tool('task', {
    action: 'run',
    tasks: [{
      id: 'one-turn',
      op: 'batch',
      args: { ops: [{ op: 'measure', args: { designId } }, { op: 'inspect', args: { designId, format: 'geometry' } }] },
    }],
  })
  const batchResult = batch.changes?.tasks?.[0]?.result?.result ?? batch.changes?.tasks?.[0]?.result
  check('batch 在一次调用里跑多步', batchResult?.count === 2 && batchResult?.results?.every((step) => step.ok), batchResult ?? batch.changes)
} finally {
  try { await session.tool('workspace', { action: 'cleanup' }) } catch { }
  if (startedHere) {
    try { await shutdownSolidworks((name, args) => session.tool(name, args), startedHere) } catch { }
  }
  try { session.child.kill() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
