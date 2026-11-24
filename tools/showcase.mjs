// 打开 SOLIDWORKS，把两张图的零件都开出来，各拍一张等轴测图，然后**保持打开**。
//
//   node tools/showcase.mjs            两个件都开、都拍
//   node tools/showcase.mjs --quit     收尾时把 SOLIDWORKS 关掉
//
// SOLIDWORKS 已经开着就直接用；没开就自己起一个（约 50 秒）。

import { spawn, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { repoRoot } from '../test/lib/mcp.mjs'

const bridge = join(repoRoot, 'bridge', 'bin', 'SwBridge.exe')
const quitAfter = process.argv.includes('--quit')

function bridgeSession() {
  const child = spawn(bridge, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiting = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const done = waiting.get(msg.id)
      if (done) { waiting.delete(msg.id); done(msg) }
    }
  })
  let nextId = 1
  return {
    call(op, args = {}) {
      const id = nextId++
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
      })
    },
    close() { child.kill() },
  }
}

function solidworksProcessCount() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process SLDWORKS -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' })
  return Number(out.trim())
}

const b = bridgeSession()

// 起 SOLIDWORKS（如果没开的话），然后等它接受 COM 附着。
if (solidworksProcessCount() === 0) {
  console.log('SOLIDWORKS 没开着，启动中（约 50 秒）…')
  execFileSync('powershell', ['-NoProfile', '-Command',
    "Start-Process -FilePath 'C:\\Users\\mota\\Desktop\\sw\\SOLIDWORKS Design 2026.lnk'"])
  const deadline = Date.now() + 300_000
  let ready = false
  while (Date.now() < deadline) {
    const s = await b.call('status')
    if (s.ready === true) { ready = true; break }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!ready) {
    console.error('启动后 5 分钟仍未就绪')
    process.exit(1)
  }
  console.log('就绪，pid', (await b.call('status')).processId)
} else {
  const s = await b.call('status')
  console.log('已有实例，pid', s.processId, 'reason', s.reason)
}

for (const [id, label] of [['p1-bracket', 'p1 支架'], ['p2-housing', 'p2 轴承座']]) {
  const part = join(repoRoot, 'test', 'out', id, `${id}.SLDPRT`)
  const opened = await b.call('open', { path: part })
  if (opened.ok === false) {
    console.error(`open ${id} 失败:`, JSON.stringify(opened.error ?? opened))
    continue
  }
  console.log(`open ${id}:`, opened.title ?? opened.path)

  // 上一次 select 留下的高亮会跟着截图跑（整块底板变成青色），拍之前先清掉。
  await b.call('select', { action: 'clear' })

  const shot = await b.call('capture', {
    path: join(repoRoot, 'test', 'out', id, 'showcase.png'),
    width: 1600, height: 1000, view: '*等轴测', caption: label,
  })
  // 截图拍的是「活动文档」，不是「刚刚打开的那个」。多开一个文档时拍错的那个版本
  // 一样返回 saved:true，所以这里把文档名当断言用，而不只是打印。
  const shotTitle = shot.document?.title ?? ''
  if (!shotTitle.toLowerCase().startsWith(id.slice(0, 2))) {
    console.error(`截图拍错了文档：想要 ${id}，实际 ${shotTitle}`)
    process.exitCode = 1
  }
  console.log(`shot ${id}:`, JSON.stringify({ saved: shot.saved, bytes: shot.bytes, document: shotTitle }))
}

if (quitAfter) {
  const q = await b.call('quit')
  console.log('quit:', JSON.stringify(q))
} else {
  const docs = await b.call('list')
  console.log('打开的文档:', JSON.stringify(docs.documents?.map((d) => d.title) ?? docs))
  console.log('SOLIDWORKS 保持打开')
}

b.close()
