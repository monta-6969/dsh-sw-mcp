// 工具产出的图片：名字要短、要能打开、要会清理。
//
// 之前是 `%TEMP%\figure-1794138540897.png` —— 名字没意义，而且一个进程跑一晚就攒几百张。
// 现在固定落在 <数据目录>\images\fig-01.png，进程启动和每 20 张清一次。
// 这个用例不需要 SOLIDWORKS：figure 只跟图纸文件打交道。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const L = String.fromCharCode(10)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dataDir = join(tmpdir(), `sw-mcp-images-${Date.now()}`)
mkdirSync(dataDir, { recursive: true })

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

const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
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
  setTimeout(() => rej(new Error(`${method} 超时`)), 120_000)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + L)
})
const tool = async (name, args) => {
  const out = await rpc('tools/call', { name, arguments: args })
  const text = out?.content?.find((c) => c.type === 'text')?.text ?? ''
  const parsed = (() => { try { return JSON.parse(text) } catch { return { raw: text } } })()
  parsed._images = (out?.content ?? []).filter((c) => c.type === 'image').length
  return parsed
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'images', version: '0' },
})

const drawing = 'D:/静静/临时文件/draws/p2.jpg'
const crop = async (x) => tool('inspect', {
  action: 'figure',
  figure: { op: 'crop', source: drawing, crop: [x, 60, x + 120, 180], scale: 4 },
})

const one = await crop(300)
const two = await crop(340)
check('裁剪成功并回报落盘路径', one.status === 'ok' && typeof one.changes?.output === 'string', {
  output: one.changes?.output,
})
check('名字短且带序号（不是 figure-<毫秒>.png）', /fig-\d{2}\.png$/.test(one.changes?.output ?? '') && /fig-\d{2}\.png$/.test(two.changes?.output ?? ''), {
  a: one.changes?.output,
  b: two.changes?.output,
})
check('落在数据目录的 images 下，不是 %TEMP%', (one.changes?.output ?? '').includes(join(dataDir, 'images')), {
  output: one.changes?.output,
})
check('两张图各回了一个 image part', one._images === 1 && two._images === 1, {
  a: one._images,
  b: two._images,
})

const pathOne = one.changes.output
check('文件真的在磁盘上', existsSync(pathOne), { exists: existsSync(pathOne) })
const head = existsSync(pathOne) ? readFileSync(pathOne).subarray(0, 4).toString('hex') : ''
check('内容是 PNG（扩展名和内容一致，能双击打开）', head === '89504e47', { magic: head })
const size = existsSync(pathOne) ? statSync(pathOne).size : 0
check('不是零字节', size > 1000, { size })

// 清理：放一堆旧图进去，重启后应该只留下最近的 keep 张
const imagesDir = join(dataDir, 'images')
const old = Date.now() - 5 * 24 * 3600 * 1000
const { utimesSync } = await import("node:fs")
for (let i = 0; i < 5; i += 1) {
  const fake = join(imagesDir, `fig-9${i}.png`)
  writeFileSync(fake, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  utimesSync(fake, new Date(old), new Date(old))
}
child.kill()
await new Promise((r) => setTimeout(r, 300))

// 第二个进程先 initialize 再断言：清理发生在注册工具时，握手完成就说明已经跑过了。
// 用固定 sleep 会变成时间竞态（上一版就是 1500ms，机器一慢就红）。
const child2 = spawn(process.execPath, [join(root, "server", "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SW_MCP_DATA: dataDir },
})
let buf2 = ""
const firstLine = new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error("初始化超时")), 30_000)
  child2.stdout.setEncoding("utf8")
  child2.stdout.on("data", (chunk) => {
    buf2 += chunk
    const i = buf2.indexOf(String.fromCharCode(10))
    if (i < 0) return
    clearTimeout(timer)
    res(buf2.slice(0, i))
  })
})
child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "images2", version: "0" } } }) + String.fromCharCode(10))
await firstLine
child2.kill()
const left = readdirSync(imagesDir).filter((n) => n.endsWith(".png"))
check("启动时清掉了两天前的旧图", !left.includes("fig-90.png") && left.length >= 2, { left })
rmSync(dataDir, { recursive: true, force: true })

console.log(`${L}${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(`${L}failures:`)
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
