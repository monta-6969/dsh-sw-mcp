// workspace and model: the two entry points M1 adds besides the catalog.
//
// The assertions split in two. Without SOLIDWORKS, the file-side actions must
// still work — that is the whole reason experience and project data live in the
// server rather than the bridge. With SOLIDWORKS, `model action=invoke` must
// reach a real API member, because that is the escape hatch the rewrite depends
// on.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const live = process.argv.includes('--live')

// workspace action="read" 只读本服务数据目录（SW_MCP_DATA 或 %LOCALAPPDATA%\sw-mcp）。
// 给服务一个干净的临时数据目录，读侧用例才会稳定：目录内能读、目录内的缺失文件是
// FILE_NOT_FOUND、仓库路径是 READ_OUTSIDE_DATA_DIR（两种错误码不能混）。
const dataDir = mkdtempSync(join(tmpdir(), 'sw-workspace-data-'))
const projectsDir = join(dataDir, 'projects')
mkdirSync(projectsDir, { recursive: true })

const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, SW_MCP_DATA: dataDir },
})

let buffer = ''
const waiters = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  }
})

let nextId = 1
function send(method, params) {
  const id = nextId++
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      rejectPromise(new Error(`${method} timed out`))
    }, 180_000)
    waiters.set(id, {
      resolve: (v) => { clearTimeout(timer); resolvePromise(v) },
      reject: (e) => { clearTimeout(timer); rejectPromise(e) },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}
async function callTool(name, args) {
  const result = await send('tools/call', { name, arguments: args })
  const text = result?.content?.find((c) => c.type === 'text')?.text
  if (!text) throw new Error(`no text content from ${name}`)
  return JSON.parse(text)
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'm1-test', version: '0' },
  })
  notify('notifications/initialized', {})

  const tools = await send('tools/list', {})
  const names = (tools.tools ?? []).map((t) => t.name)
  check('model tool is registered', names.includes('model'), names.join(','))

  console.log('status without SOLIDWORKS assumptions')
  const status = await callTool('workspace', { action: 'status' })
  check('status returns an envelope', typeof status.summary === 'string')
  check('status names either ready or a concrete reason',
    /\d+\.\d+\.\d+/.test(status.summary) || /不可用/.test(status.summary), status.summary)
  if (status.status === 'unavailable') {
    check('unavailable status suggests a next action',
      Array.isArray(status.nextActions) && status.nextActions.length > 0,
      JSON.stringify(status.nextActions))
    check('unavailable status does not blame the wrong cause',
      !/未连接（SW_NOT_RUNNING）/.test(status.summary), status.summary)
  }

  console.log('read')
  // 数据目录里的普通文件：26 行，正好够验分页（limit 20 / 续读 nextOffset）。
  const fixture = join(projectsDir, 'read-fixture.md')
  writeFileSync(fixture, Array.from({ length: 26 }, (_, i) => `line ${i + 1}: SOLIDWORKS 分页素材`).join('\n') + '\n')
  const read = await callTool('workspace', { action: 'read', path: fixture, limit: 20 })
  check('read returns lines', read.changes.returned === 20, String(read.changes.returned))
  check('read reports total lines', read.changes.totalLines > 21, String(read.changes.totalLines))
  check('read reports a next offset', typeof read.changes.nextOffset === 'number')
  const read2 = await callTool('workspace', {
    action: 'read',
    path: fixture,
    offset: read.changes.nextOffset,
    limit: 5,
  })
  check('read continues from the offset', read2.changes.returned > 0
    && read2.changes.text !== read.changes.text)

  const missingFile = await callTool('workspace', { action: 'read', path: join(dataDir, 'nope.md') })
  check('read of a missing file inside the data dir fails with FILE_NOT_FOUND',
    missingFile.status === 'failed' && missingFile.extra.error.code === 'FILE_NOT_FOUND',
    missingFile.extra?.error?.code)

  // 仓库路径（技能手册、设计定义、源码）不在数据目录里：必须越界拒绝，不能读走。
  const repoSide = await callTool('workspace', {
    action: 'read',
    path: join(root, 'skills', 'sw-troubleshooting', 'SKILL.md'),
    limit: 20,
  })
  check('read of a repo path fails with READ_OUTSIDE_DATA_DIR',
    repoSide.status === 'failed' && repoSide.extra.error.code === 'READ_OUTSIDE_DATA_DIR'
    && repoSide.changes === undefined,
    repoSide.extra?.error?.code)

  // 数据目录本身是目录不是普通文件：READ_NOT_A_FILE，和「越界」分开。
  const dirRead = await callTool('workspace', { action: 'read', path: dataDir })
  check('read of a directory fails with READ_NOT_A_FILE',
    dirRead.status === 'failed' && dirRead.extra.error.code === 'READ_NOT_A_FILE',
    dirRead.extra?.error?.code)

  console.log('search')
  const search = await callTool('workspace', { action: 'search', q: 'solidworks' })
  check('search returns both buckets',
    Array.isArray(search.changes.notes) && Array.isArray(search.changes.projects))

  console.log('resume / history')
  const resume = await callTool('workspace', { action: 'resume' })
  check('resume either finds a project or says there is none',
    resume.status === 'ok' || resume.extra?.error?.code === 'NO_PROJECT',
    String(resume.extra?.error?.code ?? resume.status))

  console.log('reload')
  const reload = await callTool('workspace', { action: 'reload' })
  check('reload reports before and after versions',
    reload.changes?.before !== undefined && reload.changes?.after !== undefined,
    JSON.stringify(reload.changes?.after ?? {}))
  check('reload leaves a working bridge', typeof reload.changes.after.version === 'string',
    String(reload.changes.after.version))

  if (live) {
    console.log('live model actions')
    const invoke = await callTool('model', {
      action: 'invoke', target: 'app', iface: 'ISldWorks', member: 'RevisionNumber',
    })
    check('invoke reaches SOLIDWORKS', invoke.status === 'ok', JSON.stringify(invoke.extra?.error ?? {}).slice(0, 160))
    check('invoke reports the revision', /^\d+\.\d+/.test(String(invoke.changes?.result)), String(invoke.changes?.result))
    check('invoke shows the signature it picked',
      typeof invoke.changes?.signature === 'string', invoke.changes?.signature)

    const unknown = await callTool('model', {
      action: 'invoke', target: 'app', member: 'NoSuchMemberAtAll',
    })
    check('unknown member fails with a code and a next step',
      unknown.status === 'failed' && unknown.extra.error.code === 'UNKNOWN_MEMBER'
      && unknown.nextActions.length > 0, String(unknown.extra?.error?.code))
  } else {
    console.log('  ..   skipping live model checks (pass --live with SOLIDWORKS running)')
  }
} catch (error) {
  fail++
  console.log(`  FAIL harness — ${error.message}`)
} finally {
  child.kill()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
