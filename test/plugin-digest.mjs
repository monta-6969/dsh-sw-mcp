// 目标收尾时的经验归并：同一 observation 只留最新一条，其余标 supersededBy。
// 不需要 SOLIDWORKS；也不启动 MCP server，只驱动插件的 tools/execute 钩子。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../experience-digest.js'

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

const root = mkdtempSync(join(tmpdir(), 'sw-plugin-digest-'))
const knowledge = join(root, 'knowledge')
mkdirSync(knowledge, { recursive: true })
const file = join(knowledge, 'notes.jsonl')
const observation = '改孔位后要回读驱动尺寸'
const rows = [
  { id: 'n-old', at: '2026-01-01T00:00:00Z', text: '旧记录', observation, status: 'working' },
  { id: 'n-new', at: '2026-06-01T00:00:00Z', text: '新记录', observation, status: 'working' },
  { id: 'n-other', at: '2026-03-01T00:00:00Z', text: '另一条观察', observation: '抽壳前先倒角', status: 'working' },
]
writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
process.env.SW_MCP_DATA = root

let handler = null
const logger = { warn() { } }
apply({ on(event, fn) { if (event === 'tools/execute') handler = fn }, logger })
check('插件挂上了 tools/execute', typeof handler === 'function')

try {
  await handler({ name: 'update_goal', arguments: { action: 'complete' } }, async () => ({ content: [] }))
  const after = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const old = after.find((row) => row.id === 'n-old')
  const other = after.find((row) => row.id === 'n-other')
  check('同一观察只留一条有效记录', old?.supersededBy === 'n-new', old)
  check('不同观察不动', !other?.supersededBy, other)
  check('行数与条目数不变（只改字段，不删记录）', after.length === 3, after.length)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
