// broker 端到端：两个客户端共享同一个常驻进程，作业按 jobId 取回。
//
// 这里不碰 SOLIDWORKS；验的是 P1 的传输与作业语义：幂等提交、跨客户端读取、
// 状态机落盘、取消、回收、关停。
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const dir = mkdtempSync(join(tmpdir(), 'sw-broker-'))
const pipe = `\\\\.\\pipe\\sw-mcp-broker-test-${process.pid}-${Date.now()}`
process.env.SW_MCP_BROKER_DIR = dir
// 图片回收要在自己的数据目录里做，别碰真实的 review/ 和 images/。
const dataDir = join(dir, 'data')
const imagesDir = join(dataDir, 'images')
mkdirSync(imagesDir, { recursive: true })
mkdirSync(join(dataDir, 'review'), { recursive: true })
const staleImage = join(imagesDir, 'stale.png')
const keptImage = join(imagesDir, 'kept.png')
writeFileSync(staleImage, 'x')
writeFileSync(keptImage, 'x')
const old = new Date(Date.now() - 48 * 3600_000)
utimesSync(staleImage, old, old)
utimesSync(keptImage, old, old)
writeFileSync(join(dataDir, 'review', 'snapshots.json'), JSON.stringify({ snapshots: [{ imagePath: keptImage }] }))
process.env.SW_MCP_DATA = dataDir
// 实例登记表/失败标记也放进临时目录：下面的 ensure 用例不允许碰真实的
// %LOCALAPPDATA%\sw-mcp\instances.json（生产实例清单必须保持干净）。
process.env.SW_MCP_INSTANCES_FILE = join(dir, 'instances.json')
process.env.SW_MCP_LAUNCH_FAILURE_FILE = join(dir, 'launch-failure.json')
// broker 的「默认」实例策略固定成 shared/1，这样「按请求覆盖」才测得出来。
process.env.SW_MCP_INSTANCE_POLICY = 'shared'
process.env.SW_MCP_MAX_INSTANCES = '1'
delete process.env.SW_MCP_INSTANCE_TAG

const a = await BrokerClient.connect({ pipe, spawnIfMissing: true, timeoutMs: 15_000 })
const b = await BrokerClient.connect({ pipe, spawnIfMissing: false, timeoutMs: 5_000 })

try {
  const hello = await a.hello()
  check('hello 返回 pid 与协议版本', Number.isInteger(hello.pid) && hello.protocolVersion === 4, hello)
  check('两个客户端连到同一个 broker', (await b.hello()).pid === hello.pid)

  // A（多实例缺陷）：ensure 必须能按请求覆盖实例策略，而不是只认 broker 启动时的 env。
  // 显式 instancePid 让 ensure 不真去启动 SOLIDWORKS，只走「分配 + 回显」这段。
  const overridden = await a.request('instances.ensure', {
    clientId: 'policy-test',
    instancePid: 424242,
    startWorker: false,
    timeoutMs: 5_000,
    policy: 'isolated',
    maxInstances: 3,
    tag: 'multitest',
  }, { timeoutMs: 20_000 })
  check('instances.ensure 按请求覆盖并回显 policy/maxInstances/tag',
    overridden.policy === 'isolated' && overridden.maxInstances === 3 && overridden.tag === 'multitest',
    { policy: overridden.policy, maxInstances: overridden.maxInstances, tag: overridden.tag })
  check('instances.ensure 回显 instancePid（与 chosenPid 一致）',
    overridden.instancePid === 424242 && overridden.chosenPid === 424242,
    { instancePid: overridden.instancePid, chosenPid: overridden.chosenPid })
  check('instances.ensure 覆盖带 source/overridden 审计信息',
    overridden.overrides?.overridden === true && overridden.overrides?.effective?.policy === 'isolated'
      && overridden.overrides?.effective?.maxInstances === 3, overridden.overrides)
  const inherited = await a.request('instances.ensure', {
    clientId: 'policy-test-default',
    instancePid: 424243,
    startWorker: false,
    timeoutMs: 5_000,
  }, { timeoutMs: 20_000 })
  check('instances.ensure 不带参数时沿用 broker env（shared/1）',
    inherited.policy === 'shared' && inherited.maxInstances === 1 && inherited.tag === null,
    { policy: inherited.policy, maxInstances: inherited.maxInstances, tag: inherited.tag })
  check('instances.ensure 不带参数时不算运行时覆盖',
    inherited.overrides?.overridden === false, inherited.overrides)
  await a.request('instances.release', { clientId: 'policy-test' }).catch(() => { })
  await a.request('instances.release', { clientId: 'policy-test-default' }).catch(() => { })

  const submitted = await a.submitJob({ op: 'build', operationId: 'op-1', refs: { runId: 'run-a' } })
  check('提交后是 queued', submitted.job.state === 'queued' && submitted.reused === false, submitted.job)
  const fetched = await b.getJob(submitted.job.jobId)
  check('另一个客户端能按 jobId 取回', fetched.job.jobId === submitted.job.jobId, fetched.job.jobId)

  const duplicate = await b.submitJob({ op: 'build', operationId: 'op-1', refs: { runId: 'run-a' } })
  check('跨客户端重试复用同一个 job', duplicate.reused === true && duplicate.job.jobId === submitted.job.jobId,
    { first: submitted.job.jobId, duplicate: duplicate.job.jobId })

  const running = await a.request('jobs.transition', { jobId: submitted.job.jobId, state: 'running' })
  check('broker 能推进到 running', running.job.state === 'running', running.job)
  const done = await b.request('jobs.transition', {
    jobId: submitted.job.jobId, state: 'succeeded', patch: { result: { volume: 42 } },
  })
  check('broker 能写入终态与结果', done.job.state === 'succeeded' && done.job.result.volume === 42, done.job)

  const path = join(dir, 'jobs', `${submitted.job.jobId}.json`)
  check('作业落盘到 broker 目录', existsSync(path), path)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  check('落盘记录带 schemaVersion 4', record.schemaVersion === 4, record.schemaVersion)

  const listed = await a.listJobs({ state: 'succeeded' })
  check('list 按状态过滤', listed.jobs.length === 1 && listed.jobs[0].jobId === submitted.job.jobId, listed.jobs)

  const queued = await a.submitJob({ op: 'measure', operationId: 'op-2', refs: { runId: 'run-a' } })
  const cancelled = await b.cancelJob(queued.job.jobId)
  check('queued 作业取消后立即终态', cancelled.cancelled === true && cancelled.job.state === 'cancelled', cancelled.job)

  const reclaimed = await a.request('jobs.reclaim', { keepMs: 0 })
  check('reclaim 删掉终态记录', reclaimed.removed.length >= 2, reclaimed)
  check('未完成作业仍在', (await b.listJobs({ state: 'queued' })).jobs.length === 0)
  const upkeep = await a.request('maintenance', { keepMs: 7 * 24 * 3600_000, workerIdleMs: 0, imageKeepMs: 3600_000 })
  check('maintenance 回收过期记录并报告空闲 worker', Array.isArray(upkeep.removed)
    && Number.isInteger(upkeep.stoppedWorkers) && Number.isInteger(upkeep.keptWarm) && typeof upkeep.at === 'string', upkeep)
  check('旧图只删没被快照引用的', upkeep.removedImages === 1 && !existsSync(staleImage) && existsSync(keptImage),
    { removedImages: upkeep.removedImages, stale: existsSync(staleImage), kept: existsSync(keptImage) })
} finally {
  try { await a.request('shutdown', {}, { timeoutMs: 2000 }) } catch { }
  a.close()
  b.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
