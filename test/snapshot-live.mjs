// 同 turn 快照：图、测量、特征树必须在一次桥接调用里取完。
// 旧流程是 capture → measure 两次独立调用，中间一次重建就能让图和数说的不是同一版。
import { openSession } from './lib/mcp.mjs'
import { ensureSolidworks } from './lib/sw.mjs'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out')

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
try {
  await session.start()
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })

  const instances = await session.tool('workspace', { action: 'instances' })
  const listed = instances.changes?.instances ?? []
  check('ROT 列出正在运行的实例', instances.status === 'ok' && listed.length >= 1
    && listed.every((item) => Number.isInteger(item.pid) && item.startedAt), listed)

  const ensured = await session.tool('job', { action: 'ensure' })
  check('broker 取得实例并预热 worker', ensured.status === 'ok'
    && Number.isInteger(ensured.changes?.chosenPid) && ensured.changes?.warmed === true, {
    pid: ensured.changes?.chosenPid, warmed: ensured.changes?.warmed, waitedMs: ensured.changes?.waitedMs,
  })

  const designId = `snapshot-live-${Date.now()}`
  const build = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 60, height: 40 }] },
        { id: 'plate', kind: 'extrude', profile: 'outline', depth: 10, direction: '+Y' },
        { id: 'hole-outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'circle', center: [0, 0], diameter: 20 }] },
        { id: 'hole', kind: 'cut', profile: 'hole-outline', depth: 10, direction: '+Y' },
      ],
    },
  })
  check('建出带孔零件', build.status === 'ok', build.summary)

  const docs = await session.tool('job', { action: 'documents' })
  check('broker 登记文档并关联 designId', docs.status === 'ok'
    && (docs.changes?.documents ?? []).some((doc) => doc.designId === designId), docs.changes?.documents)

  // 同一版本先把 STEP 落盘，再让快照把它的指纹一起钉住（A6 的文件类证据）。
  const artifactPath = join(outDir, `snapshot-live-${Date.now()}.step`)
  writeFileSync(artifactPath, ['ISO-10303-21;', 'HEADER;', 'ENDSEC;'].join(String.fromCharCode(10)))

  const snap = await session.tool('inspect', {
    action: 'snapshot',
    designId,
    artifactPath,
    measures: [
      { name: '孔', measure: { kind: 'holes' } },
      { name: '圆柱面', measure: { kind: 'cylinders' } },
    ],
  })
  const changes = snap.changes ?? {}
  check('快照成功', snap.status === 'ok', snap.summary)
  check('标记为同一 worker turn', changes.sameTurn === true, changes.sameTurn)
  check('快照 schema v2', changes.schemaVersion === 2, changes.schemaVersion)
  check('两条测量都量成', Array.isArray(changes.measurements) && changes.measurements.length === 2
    && changes.measurements.every((item) => item.ok === true), changes.measurements?.map((item) => ({ name: item.name, ok: item.ok })))
  check('特征树指纹进快照', typeof changes.features?.digest === 'string' && changes.features.digest.length === 16, changes.features)
  check('图片落地且有字节', changes.image?.digest && changes.image?.bytes > 0, changes.image)
  check('snapshotId 12 位', /^[0-9a-f]{12}$/.test(changes.snapshotId ?? ''), changes.snapshotId)
  check('原生文件指纹进快照', typeof changes.artifact?.digest === 'string'
    && changes.artifact.digest.length === 16 && existsSync(artifactPath), changes.artifact)

  const released = await session.tool('job', { action: 'release', designId })
  check('按 designId 释放文档', released.status === 'ok', released.summary)
} finally {
  session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
