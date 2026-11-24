// A4：两个独立实例上的作业真正重叠执行；并且验证 2026-11-13 的会话归属语义：
//   · 不同 MCP 会话（不同 clientId）各自绑自己的实例 —— 并发时按会话分开；
//   · 同一会话的请求粘滞在它绑定的实例上（affinity.mjs 的 chooseInstance: clientPid 命中即复用，
//     docs/SW-自动化MCP-研究报告.md §3.4「同一会话回到原实例」）。
// 这里不看“能不能开两个 SW”，只看执行时间区间与 instanceId 归属。
import { spawn } from 'node:child_process'
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

const EXE = 'C:/Program Files/SOLIDWORKS Corp/SOLIDWORKS/SLDWORKS.exe'
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

// 两个会话 = 两个 MCP 服务进程 = 两个 clientId。粘滞按会话 id 判定，所以必须真起两个会话。
const brokerEnv = { ...process.env, SW_MCP_BROKER: '1', SW_MCP_BROKER_ENSURE: '1', SW_MCP_BROKER_TIMEOUT_MS: '240000' }
const sessionA = openSession({ env: brokerEnv })
const sessionB = openSession({ env: brokerEnv })
await Promise.all([sessionA.start(), sessionB.start()])

async function waitJob(session, jobId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await session.tool('job', { action: 'status', jobId })
    const job = status.changes?.job ?? status.changes
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      const full = await session.tool('job', { action: 'result', jobId })
      return full.changes?.job ?? job
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

/** 从作业列表里挑出这些 designId 的、已成功的 build 作业。 */
async function jobsFor(session, designIds) {
  const listed = await session.tool('job', { action: 'list', limit: 40 })
  return (listed.changes?.jobs ?? []).filter((job) => job.op === 'build' && job.state === 'succeeded'
    && job.refs?.designId && designIds.includes(job.refs.designId))
}

try {
  await ensureSolidworks((name, args) => sessionA.tool(name, args))
  await sessionA.tool('workspace', { action: 'cleanup' })
  const ensured = await sessionA.tool('job', { action: 'ensure' })
  const pidA = ensured.changes?.chosenPid
  check('第一个实例可用', Boolean(pidA), ensured.changes)

  // 让 A 先打开一个文档，避免第二个 SLDWORKS 进程并回同一个实例。
  const seedDesign = `overlap-seed-${Date.now()}`
  await sessionA.tool('job', {
    action: 'submit', op: 'build', instancePid: pidA, operationId: `${seedDesign}-op`,
    args: { definition: definition(seedDesign, 20) },
  }).then((r) => waitJob(sessionA, r.changes?.job?.jobId ?? r.changes?.jobId))

  let spawnedSecond = false
  const before = await sessionA.tool('workspace', { action: 'instances' })
  if ((before.changes?.instances ?? []).length < 2) {
    const second = spawn(EXE, [], { detached: true, stdio: 'ignore' })
    second.unref()
    spawnedSecond = true
  }
  let list = []
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const shown = await sessionA.tool('workspace', { action: 'instances' })
    list = shown.changes?.instances ?? []
    if (list.length >= 2) break
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  const pidB = list.map((item) => item.pid).find((pid) => pid !== pidA)
  check('两个实例同时存在', list.length >= 2 && pidB !== pidA, { pidA, pidB })

  if (pidB) {
    // 两个会话各自绑一个实例：会话 B 显式绑到 pidB，会话 A 保持 pidA。
    const boundB = await sessionB.tool('job', { action: 'ensure', instancePid: pidB })
    check('第二个会话绑定到另一个实例', boundB.changes?.chosenPid === pidB, boundB.changes?.chosenPid)
    const boundA = await sessionA.tool('job', { action: 'ensure' })
    check('第一个会话还绑在原来的实例', boundA.changes?.chosenPid === pidA, boundA.changes?.chosenPid)

    // 作业重叠：两个不同会话各提交一个作业，执行区间必须真重叠（阈值保持原强度 500ms）。
    const designA = `overlap-a-${Date.now()}`
    const designB = `overlap-b-${Date.now()}`
    const [ra, rb] = await Promise.all([
      sessionA.tool('job', {
        action: 'submit', op: 'build', instancePid: pidA, operationId: `${designA}-op`,
        args: { definition: definition(designA, 60) },
      }),
      sessionB.tool('job', {
        action: 'submit', op: 'build', instancePid: pidB, operationId: `${designB}-op`,
        args: { definition: definition(designB, 80) },
      }),
    ])
    const [jobA, jobB] = await Promise.all([
      waitJob(sessionA, ra.changes?.job?.jobId ?? ra.changes?.jobId),
      waitJob(sessionB, rb.changes?.job?.jobId ?? rb.changes?.jobId),
    ])
    check('两个作业都成功', jobA?.state === 'succeeded' && jobB?.state === 'succeeded',
      { a: jobA?.state, b: jobB?.state })
    check('体积各自正确', Math.abs(jobA?.result?.geometry?.massProperties?.volume - 24000) < 1
      && Math.abs(jobB?.result?.geometry?.massProperties?.volume - 32000) < 1,
    { a: jobA?.result?.geometry?.massProperties?.volume, b: jobB?.result?.geometry?.massProperties?.volume })

    const startA = Date.parse(jobA?.startedAt), finishA = Date.parse(jobA?.finishedAt)
    const startB = Date.parse(jobB?.startedAt), finishB = Date.parse(jobB?.finishedAt)
    const overlapMs = Math.min(finishA, finishB) - Math.max(startA, startB)
    check('两个不同会话的作业执行区间有重叠', overlapMs > 500,
      { startA, finishA, startB, finishB, overlapMs })

    // 同一会话粘滞：sessionA 连续两次普通入口（不指定 instancePid）都回到它绑定的实例。
    const stick1 = `sticky-a1-${Date.now()}`
    const stick2 = `sticky-a2-${Date.now()}`
    const s1 = await sessionA.tool('model', { action: 'build', designId: stick1, definition: definition(stick1, 30) })
    const s2 = await sessionA.tool('model', { action: 'build', designId: stick2, definition: definition(stick2, 40) })
    check('同一会话连续两次普通入口 build 都成功', s1.status === 'ok' && s2.status === 'ok',
      { a: s1.status, b: s2.status })
    const stickyJobs = await jobsFor(sessionA, [stick1, stick2])
    const stickyInstances = new Set(stickyJobs.map((job) => job.worker?.instanceId).filter(Boolean))
    check('同一会话的请求粘滞在同一个 instanceId', stickyJobs.length === 2 && stickyInstances.size === 1,
      {
        jobs: stickyJobs.map((job) => ({ designId: job.refs?.designId, instanceId: job.worker?.instanceId })),
        instances: [...stickyInstances],
      })
    check('粘滞的实例就是该会话绑定的实例', [...stickyInstances][0] === `inst_${pidA}`,
      { instanceId: [...stickyInstances][0], boundPid: pidA })

    // 不同会话并发普通入口：各自落回自己绑定的实例（会话隔离），不会串到同一个实例。
    const normalA = `normal-a-${Date.now()}`
    const normalB = `normal-b-${Date.now()}`
    await Promise.all([
      sessionA.tool('model', { action: 'build', designId: normalA, definition: definition(normalA, 50) }),
      sessionB.tool('model', { action: 'build', designId: normalB, definition: definition(normalB, 70) }),
    ])
    const crossJobs = await jobsFor(sessionA, [normalA, normalB])
    const crossInstances = new Set(crossJobs.map((job) => job.worker?.instanceId).filter(Boolean))
    check('两个会话的普通入口并发分别落到各自实例', crossJobs.length === 2 && crossInstances.size === 2,
      {
        jobs: crossJobs.map((job) => ({ designId: job.refs?.designId, instanceId: job.worker?.instanceId })),
        instances: [...crossInstances],
      })

    try { await sessionA.tool('workspace', { action: 'reclaim' }) } catch { }
  }
  if (spawnedSecond && pidB) {
    try { await sessionA.tool('job', { action: 'submit', op: 'quit', instancePid: pidB, operationId: `quit-${pidB}-${Date.now()}` }) } catch { }
  }
} finally {
  try { await sessionA.tool('workspace', { action: 'cleanup' }) } catch { }
  try { await sessionB.tool('workspace', { action: 'cleanup' }) } catch { }
  try { await sessionA.close() } catch { }
  try { await sessionB.close() } catch { }
}
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.join('; ')); process.exit(1) }
process.exit(0)
