// A4：两个独立 SOLIDWORKS 实例各自执行建模作业。
// SOLIDWORKS 默认复用现有实例；先让第一个实例打开文档，再直接启动第二个
// SLDWORKS.exe，才会出现独立的第二个 PID。本用例只证明「两个实例可同时
// 接作业」，不再用串行用例冒充并行。
import { spawn } from 'node:child_process'
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

const EXE = 'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe'
let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

function definition(designId, width) {
  return {
    designId,
    features: [
      { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width, height: 40 }] },
      { id: 'body', kind: 'extrude', profile: 'outline', depth: 10, direction: '+Y' },
    ],
  }
}

const session = openSession({
  env: { ...process.env, SW_MCP_BROKER: '1', SW_MCP_BROKER_ENSURE: '1', SW_MCP_BROKER_TIMEOUT_MS: '180000' },
})
await session.start()

async function waitJob(jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const status = await session.tool('job', { action: 'status', jobId })
    last = status.changes?.job ?? status.changes
    if (last && ['succeeded', 'failed', 'cancelled'].includes(last.state)) {
      const full = await session.tool('job', { action: 'result', jobId })
      return full.changes?.job ?? last
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return last
}

try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const ensured = await session.tool('job', { action: 'ensure' })
  const instances = ensured.changes?.instances ?? []
  const pidA = ensured.changes?.chosenPid ?? instances[0]?.pid
  check('第一个实例可用', Boolean(pidA), ensured.changes)

  // 先让实例 A 有打开的文档，否则第二次启动会被并回 A。
  const designA = `par-a-${Date.now()}`
  const submittedA = await session.tool('job', {
    action: 'submit', op: 'build', instancePid: pidA, operationId: `${designA}-op`,
    args: { definition: definition(designA, 60) },
  })
  const jobA = await waitJob(submittedA.changes?.job?.jobId ?? submittedA.changes?.jobId)
  const volumeA = jobA?.result?.geometry?.massProperties?.volume
  check('实例 A 建成 60×40×10', Math.abs((volumeA ?? 0) - 24000) < 1, { pidA, volumeA })

  // 已有两个实例时直接复用，避免测试每次都再开一个 SOLIDWORKS。
  let spawnedSecond = false
  const initial = await session.tool('workspace', { action: 'instances' })
  if ((initial.changes?.instances ?? []).length < 2) {
    const second = spawn(EXE, [], { detached: true, stdio: 'ignore' })
    second.unref()
    spawnedSecond = true
  }
  const deadline = Date.now() + 120_000
  let list = []
  while (Date.now() < deadline) {
    const shown = await session.tool('workspace', { action: 'instances' })
    list = shown.changes?.instances ?? []
    if (list.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  check('ROT 里出现两个实例', list.length >= 2, list.map((item) => item.pid))
  const pidB = list.map((item) => item.pid).find((pid) => pid !== pidA)
  check('第二个实例 PID 不同于第一个', Boolean(pidB), { pidA, pidB })

  if (pidB) {
    const designB = `par-b-${Date.now()}`
    const submittedB = await session.tool('job', {
      action: 'submit', op: 'build', instancePid: pidB, operationId: `${designB}-op`,
      args: { definition: definition(designB, 80) },
    })
    const jobB = await waitJob(submittedB.changes?.job?.jobId ?? submittedB.changes?.jobId)
    const volumeB = jobB?.result?.geometry?.massProperties?.volume
    check('实例 B 独立建成 80×40×10', Math.abs((volumeB ?? 0) - 32000) < 1, { pidB, volumeB })
    check('两个作业落在不同 instancePid', jobA?.worker?.instanceId !== jobB?.worker?.instanceId,
      { a: jobA?.worker, b: jobB?.worker })
    try { await session.tool('job', { action: 'release', designId: designB }) } catch { /* best effort */ }
  }
  try { await session.tool('job', { action: 'release', designId: designA }) } catch { /* best effort */ }
  // 只关掉本用例启动的第二个实例；用户已有实例不动。
  if (spawnedSecond && pidB) {
    try {
      await session.tool('job', { action: 'submit', op: 'quit', instancePid: pidB, operationId: `quit-${pidB}-${Date.now()}` })
    } catch { /* best effort */ }
  }
} finally {
  try { await session.tool('workspace', { action: 'cleanup' }) } catch { /* best effort */ }
  try { await session.close() } catch { }
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join('; ')); process.exit(1) }
process.exit(0)
