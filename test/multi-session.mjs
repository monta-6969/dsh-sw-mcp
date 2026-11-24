// 两个 MCP 会话同时建模：默认 shared 策略下它们共用同一个 SOLIDWORKS 实例，
// 但 build 前的清理只能关自己 designId 的未存盘文档，不能把对方正在建的零件一起关掉。
//
// 另有一个 isolated 用例（broker 级）：显式 isolated 时不同会话必须拿到不同实例，
// 达到上限后再来的会话只能排队拿 INSTANCE_BUSY，绝不再起一个新进程。
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'
import { BrokerClient } from '../server/broker/client.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`) }
  else { failed += 1; console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`) }
}

const brokerEnv = { ...process.env, SW_MCP_BROKER: '1', SW_MCP_BROKER_ENSURE: '1' }

// ---------------------------------------------------------------- shared（默认）
{
  const a = openSession({ env: brokerEnv })
  const b = openSession({ env: brokerEnv })
  await a.start()
  await b.start()
  try {
    await ensureSolidworks((name, args) => a.tool(name, args))
    const stamp = Date.now()
    const designA = `multi-a-${stamp}`
    const designB = `multi-b-${stamp}`

    const builtA = await a.tool('model', {
      action: 'build',
      definition: {
        designId: designA,
        params: { w: 60, d: 40, t: 10 },
        features: [
          { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'w', height: 'd' }] },
          { id: 'body', kind: 'extrude', profile: 'outline', depth: 't', direction: '+Y' },
        ],
      },
    })
    check('会话 A 建模成功', builtA.status === 'ok', builtA.summary)
    const titleA = builtA.changes?.document?.title
    const instanceA = builtA.changes?.instanceId

    const builtB = await b.tool('model', {
      action: 'build',
      definition: {
        designId: designB,
        params: { w: 50, d: 30, t: 8 },
        features: [
          { id: 'outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'w', height: 'd' }] },
          { id: 'body', kind: 'extrude', profile: 'outline', depth: 't', direction: '+Y' },
        ],
      },
    })
    check('会话 B 建模成功', builtB.status === 'ok', builtB.summary)
    const titleB = builtB.changes?.document?.title
    const instanceB = builtB.changes?.instanceId
    check('两个会话拿到不同文档', titleA !== titleB, { titleA, titleB })
    // shared（默认）的验收就是这一条：两个会话共用同一个实例，不再各起一个窗口。
    check('shared 下两个会话共用同一个实例', Boolean(instanceA) && instanceA === instanceB,
      { instanceA, instanceB })

    // B 的 build 不能把 A 的未存盘文档清掉。
    const aliveA = await a.tool('inspect', { action: 'model', designId: designA })
    check('B 建模后 A 的文档仍在', aliveA.status === 'ok', aliveA.summary)

    const editedA = await a.tool('model', { action: 'edit', designId: designA, parameters: { w: 80 } })
    check('A 还能继续改参', editedA.status === 'ok' && Math.round(editedA.measurements?.volume) === 32000,
      { status: editedA.status, volume: editedA.measurements?.volume })

    const aliveB = await b.tool('inspect', { action: 'model', designId: designB })
    check('A 改参后 B 的文档仍在', aliveB.status === 'ok', aliveB.summary)
  } finally {
    try { a.close() } catch { }
    try { b.close() } catch { }
  }
}

// ------------------------------------------------------------- isolated（独占）
// 只测 broker 的分配规则：explicit isolated 时两个 client 拿不同 pid；
// 第三个 client 在上限（2）已满时被要求排队（INSTANCE_BUSY），而不是又起一个 SW。
if (process.env.SW_MCP_NO_ISOLATED !== '1') {
  let client = null
  try {
    client = await BrokerClient.connect({ spawnIfMissing: true, timeoutMs: 15_000 })
    const ensure = (clientId) => client.request('instances.ensure', {
      clientId,
      policy: 'isolated',
      maxInstances: 2,
      tag: process.env.SW_MCP_INSTANCE_TAG ?? 'test',
      startWorker: false,
      timeoutMs: 180_000,
    }, { timeoutMs: 195_000 })
    const first = await ensure('iso-test-a')
    const second = await ensure('iso-test-b')
    check('isolated 下两个会话拿到不同实例',
      Boolean(first.chosenPid) && Boolean(second.chosenPid) && first.chosenPid !== second.chosenPid,
      { first: first.chosenPid, second: second.chosenPid })
    let busy = null
    try {
      busy = await client.request('instances.ensure', {
        clientId: 'iso-test-c',
        policy: 'isolated',
        maxInstances: 2,
        tag: process.env.SW_MCP_INSTANCE_TAG ?? 'test',
        startWorker: false,
        timeoutMs: 5_000,
      }, { timeoutMs: 20_000 })
    } catch (error) {
      busy = { code: error.code, details: error.details }
    }
    check('isolated 到上限后排队返回 INSTANCE_BUSY，不新起进程',
      busy?.code === 'INSTANCE_BUSY' && Number(busy?.details?.retryAfterMs) > 0, busy)
    // 释放两个绑定，别把实例继续占给别的用例。
    await client.request('instances.release', { clientId: 'iso-test-a' }).catch(() => { })
    await client.request('instances.release', { clientId: 'iso-test-b' }).catch(() => { })
  } catch (error) {
    check('isolated 用例可运行（需要 live SOLIDWORKS）', false, { message: error.message, code: error.code })
  } finally {
    try { client?.close() } catch { }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
