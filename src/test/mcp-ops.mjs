// 新工具的接线：analysis / task / job 在一个真实 MCP 会话里能被调用。
//
// job 用假 worker（broker 的 worker 命令由环境变量指定），不需要 SOLIDWORKS；
// task 只验证图构建；analysis 需要 .venv 与一份 STEP，缺失时跳过而不是失败。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

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

const dir = mkdtempSync(join(tmpdir(), 'sw-mcp-ops-'))
const pipe = `\\\\.\\pipe\\sw-mcp-ops-${process.pid}-${Date.now()}`
const fakeWorker = join(repoRoot, 'test', 'fixtures', 'fake-worker.mjs')
const env = {
  ...process.env,
  SW_MCP_BROKER_PIPE: pipe,
  SW_MCP_BROKER_DIR: dir,
  SW_MCP_BROKER_WORKER_CMD: JSON.stringify([process.execPath, fakeWorker]),
}

const session = openSession({ env })
try {
  await session.start()
  const tools = await session.call('tools/list', {})
  const names = new Set((tools.tools ?? []).map((tool) => tool.name))
  check('analysis 工具已登记', names.has('analysis'), [...names].join(','))
  check('task 工具已登记', names.has('task'))
  check('job 工具已登记', names.has('job'))

  const health = await session.tool('analysis', { action: 'health' })
  check('analysis health 返回结构化状态', health.extra?.health?.python !== undefined, health.summary)

  const stepPath = join(repoRoot, 'test', 'out', 'mcp-acceptance-a.step')
  if (existsSync(stepPath) && health.extra?.health?.ocp) {
    const info = await session.tool('analysis', { action: 'step', path: stepPath })
    check('analysis step 量出体积与面数', info.measurements?.volumeMm3 > 0 && info.measurements?.faces > 0, info.summary)
    const otherPath = join(repoRoot, 'test', 'out', 'acceptance-b.step')
    if (existsSync(otherPath)) {
      const diff = await session.tool('analysis', { action: 'diff', path: stepPath, comparePath: otherPath })
      check('analysis diff 给出差异项与下一次观察', diff.changes?.equal === false && diff.changes?.items?.length > 0
        && diff.nextActions?.length > 0, diff.summary)
    }
  } else {
    console.log('SKIP  analysis step（没有 STEP 或 OCP）')
  }

  const validate = await session.tool('task', {
    action: 'validate',
    tasks: [{ id: 'a', op: 'version' }, { id: 'b', op: 'status', deps: ['a'] }],
  })
  check('task validate 接受无环图', validate.status === 'ok' && validate.changes?.tasks?.length === 2, validate.summary)

  const cycle = await session.tool('task', {
    action: 'validate',
    tasks: [{ id: 'a', op: 'version', deps: ['b'] }, { id: 'b', op: 'status', deps: ['a'] }],
  })
  check('task validate 拒绝环', cycle.status === 'failed' && cycle.extra?.error?.code === 'TASK_CYCLE', cycle.extra?.error)

  const brokerHealth = await session.tool('job', { action: 'health' })
  check('job health 连上 broker', brokerHealth.changes?.workers !== undefined, brokerHealth.summary)

  const submitted = await session.tool('job', {
    action: 'submit', op: 'echo', args: { value: 42 }, operationId: 'mcp-job-1', runId: 'mcp-run',
  })
  const jobId = submitted.changes?.job?.jobId
  check('job submit 立即返回 jobId', typeof jobId === 'string', submitted.summary)
  let job = submitted.changes?.job
  for (let attempt = 0; attempt < 40 && !['succeeded', 'failed'].includes(job?.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const status = await session.tool('job', { action: 'status', jobId })
    job = status.changes?.job
  }
  check('job 后台完成并能取结果', job?.state === 'succeeded' && job?.result?.value === 42, job)
} finally {
  try { session.child.kill() } catch { }
  try {
    const client = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 3000 })
    await client.request('shutdown', {}, { timeoutMs: 2000 })
    client.close()
  } catch { }
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
