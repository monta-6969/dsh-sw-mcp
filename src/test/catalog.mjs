// Exercises the capability catalog end to end over the real MCP stdio transport.
//
// The catalog is the answer to the failure that started this rewrite: a model
// asked for a spur gear, the bridge said UNKNOWN_FEATURE_KIND, and the model
// stopped because nothing told it what else was reachable. So the assertions
// here are about discoverability, not about any single operation.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
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
    clientInfo: { name: 'catalog-test', version: '0' },
  })
  notify('notifications/initialized', {})

  const tools = await send('tools/list', {})
  const names = (tools.tools ?? []).map((t) => t.name)
  check('catalog is registered', names.includes('catalog'), names.join(','))
  check('workspace is registered', names.includes('workspace'))

  console.log('catalog sources')
  const sources = await callTool('catalog', { action: 'sources', refresh: true })
  const src = sources.changes
  check('sources report a build time', typeof src.builtAt === 'string', src.builtAt)
  check('five sources are declared', src.sources.length === 5, String(src.sources.length))
  const nativeCount = src.counts['solidworks-native'] ?? 0
  check('native ops are curated and present', nativeCount >= 30, String(nativeCount))
  check('interop entries were generated', (src.counts.interop ?? 0) >= 100, String(src.counts.interop))
  check('add-ins were read from the registry', (src.counts.addin ?? 0) >= 10, String(src.counts.addin))
  check('local resources were scanned', (src.counts['local-resource'] ?? 0) >= 8, String(src.counts['local-resource']))
  check('external extensions are listed', (src.counts.external ?? 0) >= 5, String(src.counts.external))
  check('interop version is recorded', Boolean(src.interop?.interopVersion), JSON.stringify(src.interop))
  const total = Object.values(src.counts).reduce((a, b) => a + b, 0)
  check('catalog holds at least 200 entries', total >= 200, String(total))

  console.log('browsing')
  const page1 = await callTool('catalog', { action: 'list', limit: 10 })
  check('list paginates with a total', page1.changes.total >= 200, String(page1.changes.total))
  check('list returns exactly limit items', page1.changes.items.length === 10, String(page1.changes.items.length))
  check('list reports nextOffset', typeof page1.changes.nextOffset === 'number', String(page1.changes.nextOffset))
  const page2 = await callTool('catalog', { action: 'list', limit: 10, offset: page1.changes.nextOffset })
  check('second page differs from the first',
    page2.changes.items[0]?.id !== page1.changes.items[0]?.id)

  const filtered = await callTool('catalog', { action: 'list', source: 'solidworks-native', limit: 5 })
  check('filter by source works', filtered.changes.items.every((e) => e.source === 'solidworks-native'))
  check('filter reports its own total', filtered.changes.total === nativeCount,
    `${filtered.changes.total} vs ${nativeCount}`)

  console.log('search')
  const search = await callTool('catalog', { action: 'search', q: '孔' })
  check('search finds the hole operation', search.changes.items.length > 0, String(search.changes.total))
  check('search ranks a title hit first',
    /孔|hole/i.test(search.changes.items[0]?.title ?? ''), search.changes.items[0]?.title)

  const gear = await callTool('catalog', { action: 'search', q: 'gear' })
  check('search works in english too', gear.changes.total >= 1, String(gear.changes.total))

  console.log('detail')
  const detail = await callTool('catalog', { action: 'detail', id: 'feature.extrude' })
  check('detail returns the entry', detail.changes.entry.id === 'feature.extrude')
  check('detail carries a parameter schema', detail.changes.entry.schema?.type === 'object')
  check('detail carries an example', Array.isArray(detail.changes.entry.examples)
    && detail.changes.entry.examples.length > 0)
  check('detail carries evidence', Boolean(detail.changes.entry.evidence?.measured),
    JSON.stringify(detail.changes.entry.evidence ?? {}))
  check('detail says how to execute it', detail.changes.entry.execute?.tool === 'model')

  const ifaceDetail = await callTool('catalog', { action: 'detail', id: 'interop:IModelDoc2' })
  check('interop detail includes live member signatures',
    (ifaceDetail.changes.members?.members ?? []).length > 20,
    String(ifaceDetail.changes.members?.memberCount))
  check('interop members carry rendered signatures',
    typeof ifaceDetail.changes.members?.members?.[0]?.signature === 'string')

  const missing = await callTool('catalog', { action: 'detail', id: 'nope.nothing' })
  check('unknown id fails with suggestions', missing.status === 'failed'
    && missing.extra?.error?.code === 'NOT_FOUND', String(missing.extra?.error?.code))

  console.log('export')
  const exported = await callTool('catalog', { action: 'export' })
  check('export writes a file', exported.artifacts?.[0]?.bytes > 1000,
    String(exported.artifacts?.[0]?.bytes))

  console.log('caching')
  const cached = await callTool('catalog', { action: 'sources' })
  check('second read comes from cache', cached.changes.fromCache === true, String(cached.changes.fromCache))
} catch (error) {
  fail++
  console.log(`  FAIL harness — ${error.message}`)
} finally {
  child.kill()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
