// A5：作业在第一个 MCP 会话里提交后立刻断开，换一个新会话按 jobId 取结果。
// 这里不模拟“进程崩溃”，但确实杀掉第一个 server 子进程；job 存在 broker 的
// 持久目录里，第二个会话只凭 jobId 恢复。
import { openSession } from './lib/mcp.mjs'

let passed = 0
let failed = 0
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) }
  else { failed += 1; console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`) }
}

const designId = `resume-job-${Date.now()}`
const definition = {
  schemaVersion: 3,
  designId: `resume-def-${Date.now()}`,
  params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10 },
  features: [{ kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' }],
}

const first = await openSession()
await first.start()
const submit = await first.must('job', {
  action: 'submit', op: 'build', ensure: true,
  args: { definition, designId },
}, 'submit')
const jobId = submit.changes?.job?.jobId
check('提交后立刻拿到 jobId', typeof jobId === 'string' && jobId.startsWith('job_'), jobId)
first.close()
console.log(`      （第一个会话已断开，jobId=${jobId}）`)

const second = await openSession()
await second.start()
try {
  let job = null
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const got = await second.tool('job', { action: 'result', jobId })
    job = got.changes?.job ?? null
    if (job !== null && ['succeeded', 'failed', 'cancelled'].includes(job.state)) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  check('新会话能按 jobId 找到作业', job !== null && job.jobId === jobId, job?.state)
  check('作业在断开期间跑完并成功', job?.state === 'succeeded', job?.state)
  const volume = job?.result?.geometry?.massProperties?.volume
  check('结果里带实际体积 24000', Math.abs(Number(volume) - 24000) < 1e-6, volume)
  const release = await second.tool('job', { action: 'release', designId: definition.designId })
  check('按 designId 释放文档不报错', release.status !== 'failed', release.status)
} finally {
  second.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
