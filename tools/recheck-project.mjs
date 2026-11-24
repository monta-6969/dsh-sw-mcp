// 拿一份已经建过的项目 + 它当时用过的核对表，重跑一次「建 + 验」。
//
// 用处只有一个：当工具本身改了（比如 measure 不再默认只匹配孔），要能回答「那
// 些失败里有多少是模型的错、有多少是工具的错」。靠回忆答不了，靠重跑能。
//
//   node tools/recheck-project.mjs lagerbock-20
//   node tools/recheck-project.mjs lagerbock-20 --session <session-id>   # 从会话日志里取核对表
//
// 不带 --session 时用项目文件里 definition.__expect.checks（如果有）。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { repoRoot } from '../test/lib/mcp.mjs'
import { openSession } from '../test/lib/mcp.mjs'

const designId = process.argv[2]
if (!designId) {
  console.error('用法：node tools/recheck-project.mjs <designId> [--session <session-id>]')
  process.exit(2)
}
const sessionFlag = process.argv.indexOf('--session')
const sessionId = sessionFlag > 0 ? process.argv[sessionFlag + 1] : null

const dataDir = join(process.env.LOCALAPPDATA, 'sw-mcp')
const projectPath = join(dataDir, 'projects', `${designId}.json`)
if (!existsSync(projectPath)) {
  console.error(`没有这个项目：${projectPath}`)
  process.exit(2)
}
const project = JSON.parse(readFileSync(projectPath, 'utf8'))
const definition = project.definition ?? project.design
if (!definition) {
  console.error('项目文件里没有 definition')
  process.exit(2)
}

function checksFromSession(id) {
  // 会话日志是 zstd 分帧的，复用工作区里的解压工具
  const helper = join(repoRoot, '..', '..', '临时文件', 'zstd-frames.mjs')
  const search = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-ChildItem 'C:\\Users\\mota\\.dsh\\sessions' -Recurse -Directory -Filter 'session-${id}*' | Select-Object -First 1 -ExpandProperty FullName`],
  { encoding: 'utf8' }).trim()
  if (!search) throw new Error(`找不到会话 ${id}`)
  const file = join(search, 'session.v4.jsonl.zstd')
  const helperUrl = pathToFileURL(helper).href
  const raw = execFileSync(process.execPath, ['-e', `
    import('${helperUrl}').then(m => {
      process.stdout.write(m.readZstdMulti(${JSON.stringify(file)}).toString('utf8'))
    })
  `], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  let best = null
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type !== 'tool/call') continue
    if (event.data?.name !== 'mcp__sw__inspect') continue
    let args
    try { args = JSON.parse(event.data.arguments) } catch { continue }
    if (args?.action !== 'verify') continue
    const checks = args?.expect?.checks
    if (Array.isArray(checks) && (!best || checks.length >= best.length)) best = checks
  }
  return best
}

let checks = definition.__expect?.checks ?? null
if (sessionId) {
  const found = checksFromSession(sessionId)
  if (found) {
    checks = found
    console.log(`从会话 ${sessionId} 取到 ${found.length} 条核对`)
  } else {
    console.log('会话里没有 verify 调用，退回项目文件里的核对表')
  }
}
if (!checks?.length) {
  console.error('没有可用的核对表；用 --session 指定一份有 verify 调用的会话')
  process.exit(2)
}

const session = openSession({})
await session.start()
try {
  const built = await session.must('model', { action: 'build', definition }, `重建 ${designId}`)
  console.log('build:', built.summary)

  const verified = await session.tool('inspect', {
    action: 'verify',
    designId: built.designId ?? designId,
    expect: { checks },
  })
  const counts = verified.changes?.counts ?? {}
  console.log('verify status:', verified.status)
  console.log('summary:', verified.summary)
  console.log('counts:', JSON.stringify(counts))
  for (const c of verified.changes?.checks ?? []) {
    if (c.status === 'pass') continue
    console.log(`  ${c.status.toUpperCase().padEnd(10)} ${c.name}`
      + `  expect=${c.expected} actual=${c.actual}`
      + (c.note ? `  (${c.note})` : ''))
  }
  if (verified.nextActions?.length) {
    console.log('nextActions:')
    for (const a of verified.nextActions) console.log('  -', a)
  }
} finally {
  await session.close()
}
