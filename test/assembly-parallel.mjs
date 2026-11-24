// A4 闭环：两个零件分别由两个 SOLIDWORKS 实例建成并存盘，第三个装配作业
// 消费磁盘上的结果。不是“同一实例里顺序建两个再装”，也不是只看作业时间重叠。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession } from './lib/mcp.mjs'
import { ensureSolidworks } from './lib/sw.mjs'

const EXE = 'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe'
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const stamp = Date.now().toString(36)
const partA = join(outDir, `asm-a-${stamp}.SLDPRT`)
const partB = join(outDir, `asm-b-${stamp}.SLDPRT`)
const assemblyPath = join(outDir, `asm-${stamp}.SLDASM`)

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

function definition(designId, width, height, path) {
  return {
    designId,
    path,
    features: [
      { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width, height }] },
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
  }
  return last
}

async function submitBuild(designId, definitionSpec, instancePid) {
  const submitted = await session.tool('job', {
    action: 'submit', op: 'build', instancePid, ensure: true,
    operationId: `${designId}-build`,
    args: { definition: definitionSpec, designId },
  })
  const jobId = submitted.changes?.job?.jobId ?? submitted.changes?.jobId
  const job = await waitJob(jobId)
  return { jobId, job }
}

async function savePart(designId, path, instancePid) {
  const submitted = await session.tool('job', {
    action: 'submit', op: 'save', instancePid, ensure: true,
    operationId: `save-${designId}`,
    args: { designId, path },
  })
  const jobId = submitted.changes?.job?.jobId ?? submitted.changes?.jobId
  return waitJob(jobId)
}

let startedSecond = false
let pidB = null
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })

  const ensured = await session.tool('job', { action: 'ensure' })
  const pidA = ensured.changes?.chosenPid ?? ensured.changes?.instances?.[0]?.pid
  check('实例 A 可用', Boolean(pidA), ensured.changes)

  const idA = `asm-a-${stamp}`
  const builtA = await submitBuild(idA, definition(idA, 100, 60, partA), pidA)
  check('实例 A 建成零件 A', builtA.job?.state === 'succeeded', builtA.job?.state)
  const savedA = await savePart(idA, partA, pidA)
  check('零件 A 已写盘', savedA?.state === 'succeeded' && existsSync(partA),
    existsSync(partA) ? statSync(partA).size : savedA?.state)

  const initial = await session.tool('workspace', { action: 'instances' })
  if ((initial.changes?.instances ?? []).length < 2) {
    const second = spawn(EXE, [], { detached: true, stdio: 'ignore' })
    second.unref()
    startedSecond = true
  }
  const deadline = Date.now() + 120_000
  let list = []
  while (Date.now() < deadline) {
    const shown = await session.tool('workspace', { action: 'instances' })
    list = shown.changes?.instances ?? []
    if (list.length >= 2) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  }
  pidB = list.map((item) => item.pid).find((pid) => pid !== pidA)
  check('实例 B 可用且不同于 A', Boolean(pidB), { pidA, pidB })

  if (pidB) {
    const idB = `asm-b-${stamp}`
    const builtB = await submitBuild(idB, definition(idB, 40, 40, partB), pidB)
    check('实例 B 建成零件 B', builtB.job?.state === 'succeeded', builtB.job?.state)
    const savedB = await savePart(idB, partB, pidB)
    check('零件 B 已写盘', savedB?.state === 'succeeded' && existsSync(partB),
      existsSync(partB) ? statSync(partB).size : savedB?.state)

    const assembled = await session.tool('model', {
      action: 'assemble',
      outputPath: assemblyPath,
      components: [
        { path: partA, x: 0, y: 0, z: 0 },
        { path: partB, x: 200, y: 0, z: 0 },
      ],
    })
    const placed = assembled.changes?.components ?? []
    check('装配消费两个实例的产物', assembled.status === 'ok' && placed.length === 2,
      placed.map((item) => item.name))
    check('装配文件已写盘', existsSync(assemblyPath),
      existsSync(assemblyPath) ? statSync(assemblyPath).size : assembled.status)

    await session.tool('workspace', { action: 'open', path: assemblyPath })
    const readback = await session.tool('inspect', { action: 'assembly' })
    check('装配回读组件数为 2', readback.changes?.count === 2, readback.changes?.count)
    check('两个零件来自不同实例', builtA.job?.worker?.instanceId !== builtB.job?.worker?.instanceId,
      { a: builtA.job?.worker, b: builtB.job?.worker })
  }
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  try { await session.tool('workspace', { action: 'cleanup' }) } catch { /* best effort */ }
  if (startedSecond && pidB) {
    try {
      await session.tool('job', {
        action: 'submit', op: 'quit', instancePid: pidB,
        operationId: `quit-${pidB}-${Date.now()}`,
      })
    } catch { /* best effort */ }
  }
  try { await session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
