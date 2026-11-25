// 文档引用图回收：项目是根。项目文件还在的文档保留；项目文件被删掉的未存盘文档关掉。
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\\n      ${JSON.stringify(detail)}`)
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'sw-reclaim-'))
const env = { ...process.env, SW_MCP_DATA: dataDir }
const session = openSession({ env })
await session.start()

function plate(designId, width) {
  return {
    designId,
    features: [
      { id: 'outline', kind: 'sketch', plane: 0, primitives: [{ shape: 'rect', center: [0, 0], width, height: 40 }] },
      { id: 'body', kind: 'extrude', profile: 'outline', depth: 10, direction: '-Z' },
    ],
  }
}

try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const keepId = `reclaim-keep-${Date.now()}`
  const dropId = `reclaim-drop-${Date.now()}`
  const outPath = join(dataDir, 'keep.sldprt')
  const keep = await session.tool('model', { action: 'build', definition: plate(keepId, 60) })
  check('保留件建成', keep.status === 'ok', keep.summary)
  const saved = await session.tool('deliver', { kind: 'sldprt', path: outPath })
  check('保留件已存盘', saved.status === 'ok' && existsSync(outPath), saved.artifacts?.[0])

  const drop = await session.tool('model', { action: 'build', definition: plate(dropId, 80) })
  check('待回收件建成', drop.status === 'ok', drop.summary)

  // 删掉 drop 的项目记录，模拟「项目已经结束/被清理，但文档还开着」。
  const projectFile = readdirSync(join(dataDir, 'projects'))
    .map((name) => join(dataDir, 'projects', name))
    .find((path) => path.includes(dropId.replace(/[^a-zA-Z0-9_-]/g, '_')))
  if (projectFile) unlinkSync(projectFile)
  check('drop 的项目记录已删除', Boolean(projectFile), projectFile)

  const reclaimed = await session.tool('workspace', { action: 'reclaim' })
  check('reclaim 跑通', reclaimed.status === 'ok', reclaimed.summary)
  const closedTitles = (reclaimed.changes?.closed ?? []).map((item) => item.title)
  const kept = reclaimed.changes?.kept ?? []
  // A dirty editor buffer is user data: reclaim reports it and leaves it open.
  check('无项目引用的未存盘文档因 dirty 被保留',
    kept.some((item) => item.reason === 'dirty-document'), kept)
  check('没有强关任何 dirty 文档', closedTitles.length === 0, closedTitles)
  check('保留件仍在（项目是根）', kept.some((item) => item.reason === 'project'), kept)

  // 删掉 keep 的项目记录后，已存盘路径仍应作为根，不能被回收。
  const keepProject = readdirSync(join(dataDir, 'projects'))
    .map((name) => join(dataDir, 'projects', name))
    .find((path) => path.includes(keepId.replace(/[^a-zA-Z0-9_-]/g, '_')))
  if (keepProject) unlinkSync(keepProject)
  const second = await session.tool('workspace', { action: 'reclaim' })
  check('已存盘文档因 saved-document 被保留',
    (second.changes?.kept ?? []).some((item) => item.reason === 'saved-document'), second.changes?.kept)
} finally {
  try { await session.tool('workspace', { action: 'cleanup' }) } catch { }
  try { session.close() } catch { }
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { }
}

console.log(`\\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\\n'))
  process.exitCode = 1
}
