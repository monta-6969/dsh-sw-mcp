// broker 执行作业：job 先落盘，再交给实例 worker，结果写回同一个 job。
//
// 用假 worker 验传输与状态机；真 SolidWorks worker 在 test/sta.mjs 里验。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrokerClient } from '../server/broker/client.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const fakeWorker = join(here, 'fixtures', 'fake-worker.mjs')

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

const dir = mkdtempSync(join(tmpdir(), 'sw-broker-run-'))
const pipe = `\\\\.\\pipe\\sw-mcp-broker-run-${process.pid}-${Date.now()}`
process.env.SW_MCP_BROKER_DIR = dir
process.env.SW_MCP_BROKER_WORKER_CMD = JSON.stringify([process.execPath, fakeWorker])
// 温热池默认保留 1 个；这个用例要验「停 worker 前 cleanup」，先关掉保底。
process.env.SW_MCP_MIN_WARM = '0'

const client = await BrokerClient.connect({ pipe, spawnIfMissing: true, timeoutMs: 15_000 })
try {
  const run = await client.request('jobs.run', {
    op: 'echo', args: { value: 7 }, operationId: 'run-1', refs: { runId: 'r1' },
  })
  check('jobs.run 返回 succeeded', run.job.state === 'succeeded', run.job)
  check('结果来自 worker', run.job.result?.value === 7, run.job.result)
  check('第一次不是复用', run.reused === false)

  const duplicate = await client.request('jobs.run', {
    op: 'echo', args: { value: 7 }, operationId: 'run-1', refs: { runId: 'r1' },
  })
  check('同操作重试复用终态，不重复执行', duplicate.reused === true && duplicate.job.jobId === run.job.jobId,
    { first: run.job.jobId, duplicate: duplicate.job.jobId })

  const boom = await client.request('jobs.run', {
    op: 'boom', operationId: 'run-2', refs: { runId: 'r1' },
  })
  check('worker 报错写回 failed 与错误码', boom.job.state === 'failed' && boom.job.error?.code === 'FAKE_BOOM', boom.job)

  const slow = await client.request('jobs.run', {
    op: 'slow', args: { value: 9 }, operationId: 'run-3', refs: { runId: 'r1' },
  })
  check('慢请求也能完成', slow.job.state === 'succeeded' && slow.job.result?.afterMs === 100, slow.job.result)

  const dispatch = await client.request('jobs.dispatch', {
    op: 'slow', args: { value: 11 }, operationId: 'run-4', refs: { runId: 'r1' },
  })
  check('dispatch 立即返回 jobId', typeof dispatch.job.jobId === 'string' && ['running', 'succeeded'].includes(dispatch.job.state), dispatch.job)
  let finished = dispatch.job
  for (let attempt = 0; attempt < 30 && !['succeeded', 'failed'].includes(finished.state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    finished = (await client.request('jobs.get', { jobId: dispatch.job.jobId })).job
  }
  check('后台执行完成后能取回结果', finished.state === 'succeeded' && finished.result?.value === 11, finished)

  const workers = await client.request('workers.list')
  check('broker 登记了 worker', workers.workers.length === 1 && workers.workers[0].pending === 0, workers)

  // 停 worker 之前必须先让桥接收掉它建过、尚未存盘的文档；这里用假 worker
  // 验调用发生且不会因为 cleanup 失败而卡住整轮维护。
  const upkeep = await client.request('maintenance', { workerIdleMs: 0, keepMs: 7 * 24 * 3600_000 })
  check('maintenance 停空闲 worker 并回报清理数', upkeep.stoppedWorkers === 1
    && Number.isInteger(upkeep.cleanedDocs), upkeep)
} finally {
  try { await client.request('shutdown', {}, { timeoutMs: 2000 }) } catch { }
  client.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
