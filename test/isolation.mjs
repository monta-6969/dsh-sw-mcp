// 题面隔离：模式可以自己读文件，但它不该被「喂」一份和验收用例一模一样的期望值。
//
// 这两件事不一样：
//   - 能力：预设里给 read / readImage 是有意给的（自己查参考图、翻读图记录）。
//   - 泄漏：把 __expect / checks 这种答案原样写进人设、工具说明或能力目录，
//     等于把答案摆在它面前。
// 这个文件钉住后者，顺带确认前者没被误删。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const L = String.fromCharCode(10)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${name}`)
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}`)
    console.log(`      ${JSON.stringify(detail)}`)
  }
}

// ---------------------------------------------------------------- 能力：读文件还在
check('预设仍然给文件读取（read + readImage）', /dsh-tool-fs/.test(patch) && /readImage:\s*true/.test(patch), {
  toolFs: /dsh-tool-fs/.test(patch),
})

// ---------------------------------------------------------------- 泄漏面：人设
const lines = patch.split(L)
const pStart = lines.findIndex((l) => l.includes('prefix: |-'))
let pEnd = pStart + 1
while (pEnd < lines.length && !/^ {10}(#|- id:)/.test(lines[pEnd])) pEnd += 1
const persona = lines.slice(pStart + 1, pEnd).map((l) => l.replace(/^ {16}/, '')).join(L)

check('人设里没有 __expect / checks 这种答案结构', !/__expect|"checks"|expect:\s*\[/.test(persona), {
  length: persona.length,
})
check('人设里没有具体零件的验收数字', !/1584\.7|726237|729979|591451|634759/.test(persona), {
  length: persona.length,
})
check('人设足够短（不靠清单堆信息）', persona.length > 200 && persona.length <= 1200, {
  length: persona.length,
})

// ---------------------------------------------------------------- 泄漏面：工具说明与能力目录
const serverFiles = ['server/server.mjs', 'server/tools-observe.mjs', 'server/tools-calculate.mjs']
const sources = serverFiles.map((f) => readFileSync(join(root, f), 'utf8')).join(L)
check('工具说明里没有把验收用例路径当例子', !/designs\/p[12]|designs\\p[12]|__expect/.test(sources), {
  hits: (sources.match(/designs\/p[12]|__expect/g) ?? []).length,
})

const catalogFiles = ['local.mjs', 'native.mjs', 'external.mjs', 'index.mjs']
const catalog = catalogFiles.map((f) => readFileSync(join(root, 'server', 'catalog', f), 'utf8')).join(L)
check('能力目录里没有答案字段', !/__expect|"checks"\s*:/.test(catalog), {
  hits: (catalog.match(/__expect/g) ?? []).length,
})

// ---------------------------------------------------------------- 经验注入只带通用结论
const digest = readFileSync(join(root, 'experience-digest.js'), 'utf8')
check('经验注入只读 curated，不整库灌进去', /curated/.test(digest) && /MAX_LINES|slice\(0,/.test(digest), {
  curated: /curated/.test(digest),
})

// ---------------------------------------------------------------- 运行态：读得到真文件
//
// workspace action="read" 只读本服务数据目录（SW_MCP_DATA 或 %LOCALAPPDATA%\sw-mcp）：
// 目录内的普通文件读得到，仓库路径一律 READ_OUTSIDE_DATA_DIR。这里给服务一个临时
// 数据目录，先在里面落一个普通文件当「自己的日志」，再拿仓库文件试越界。
const dataDir = mkdtempSync(join(tmpdir(), 'sw-isolation-data-'))
mkdirSync(join(dataDir, 'logs'), { recursive: true })
const ownLog = join(dataDir, 'logs', 'fixtest.jsonl')
writeFileSync(ownLog, `${JSON.stringify({ op: 'workspace.read', note: '数据目录里的普通文件' })}\n`)

const entry = join(root, 'server', 'server.mjs')
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, SW_MCP_DATA: dataDir },
})
let buffer = ''
let nextId = 1
const waiters = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf(L)) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    waiter(message.result ?? message.error)
  }
})
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++
  waiters.set(id, res)
  setTimeout(() => rej(new Error(`${method} 超时`)), 30_000)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + L)
})
const tool = async (name, args) => {
  const out = await rpc('tools/call', { name, arguments: args })
  const text = out?.content?.find((c) => c.type === 'text')?.text ?? ''
  try { return JSON.parse(text) } catch { return { raw: text } }
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'isolation', version: '0' },
})

const inside = await tool('workspace', { action: 'read', path: ownLog, limit: 3 })
check('模式自己读得到数据目录里的文件（能力没被误删）', inside.status === 'ok' && inside.changes?.returned > 0, {
  status: inside.status,
  returned: inside.changes?.returned,
})

const outside = await tool('workspace', { action: 'read', path: resolve(root, 'designs', 'p1-bracket.json'), limit: 3 })
check('模式读仓库文件被拒（只读数据目录）', outside.status === 'failed'
  && outside.extra?.error?.code === 'READ_OUTSIDE_DATA_DIR'
  && outside.changes?.text === undefined, {
  status: outside.status,
  code: outside.extra?.error?.code,
})

const notAFile = await tool('workspace', { action: 'read', path: dataDir })
check('模式读数据目录本身被拒（非普通文件）', notAFile.status === 'failed'
  && notAFile.extra?.error?.code === 'READ_NOT_A_FILE', {
  status: notAFile.status,
  code: notAFile.extra?.error?.code,
})

child.kill()
try { rmSync(dataDir, { recursive: true, force: true }) } catch { }

console.log(`${L}${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(`${L}failures:`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
