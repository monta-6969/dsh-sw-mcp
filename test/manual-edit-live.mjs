// A3：模型被本工具之外的路径改动后，agent 仍能继续。
// 这里用原始 COM 句柄直接改一个原生尺寸（等价于人在 SOLIDWORKS 里拖尺寸），
// 不经过 handlePartEdit，也不更新项目文件；随后再走正常 edit，必须读到实际模型。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const designId = `manual-edit-${Date.now()}`
const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10 },
      features: [
        { kind: 'sketch', id: 'outline', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'plate.w', height: 'plate.h', bind: { width: 'plate.w', height: 'plate.h' } }] },
        { kind: 'extrude', id: 'body', profile: 'outline', depth: 'plate.t', direction: '+Y', bind: { depth: 'plate.t' } },
      ],
    },
  })
  check('建成', built.status === 'ok', built.summary)
  const dimName = built.changes?.dimensionBindings?.['plate.w']
  check('有 plate.w 的原生尺寸名', Boolean(dimName), built.changes?.dimensionBindings)

  // 外部修改：通过桥接器保留的原生尺寸句柄直接改 SystemValue，
  // 不经过 model.edit，也不更新项目文件（等价于在 SW 里手改尺寸）。
  const target = await session.tool('model', {
    action: 'object', objectAction: 'target', target: 'dimension',
    designId, param: 'plate.w',
  })
  const dimHandle = target.changes?.handle
  check('拿到 IDimension 句柄', Boolean(dimHandle), target)
  const set = await session.tool('model', {
    action: 'object', objectAction: 'set', handle: dimHandle, iface: 'IDimension',
    member: 'SystemValue', value: 0.09,
  })
  check('外部写入 SystemValue', set.status === 'ok', set)
  await session.tool('model', { action: 'rebuild', designId })
  const after = await session.tool('inspect', { action: 'model', designId })
  const outsideVolume = after.measurements?.massProperties?.volume
    ?? after.measurements?.volume
  check('外部修改后体积 90×40×10', Math.abs((outsideVolume ?? 0) - 36000) < 1, after)

  // 继续正常编辑：用模型当前状态作为起点，不得假设项目里的旧值。
  const edited = await session.tool('model', {
    action: 'edit', designId, parameters: { 'plate.h': 50 },
  })
  check('外部改动后继续 edit 成功', edited.status === 'ok', edited.summary)
  check('体积 90×50×10', Math.abs((edited.measurements?.volume ?? 0) - 45000) < 1, edited.measurements?.volume)
  check('继续编辑不要求先重启', edited.changes?.mode !== undefined, edited.changes?.mode)
  const driven = (edited.changes?.driven ?? []).find((entry) => entry.param === 'plate.h')
  check('回读到高 50 的原生尺寸', Boolean(driven?.bound), driven)
} finally {
  try { await session.tool('workspace', { action: 'cleanup' }) } catch { /* best effort */ }
  try { await session.close() } catch { }
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join('; ')); process.exit(1) }
process.exit(0)
