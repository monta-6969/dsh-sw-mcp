// 端到端跑一次「真的建模 + 真的截图 + 审查门」。
//
// 单独用假 ctx 测 review-gate 有一个盲点：我假定工具返回的 envelope 长成某个样子。
// 一旦真实 envelope 的字段路径变了（image.path 换成 artifacts[].path、或者服务改成
// 只回文本），假 ctx 里的测试照样全绿，而真机上审查门永远拿不到图。
// 所以这里用真实 MCP 会话产出的原始结果去喂 hook，验的是「真实数据能穿过门」。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../preset/review-gate.js'
import { ensureSolidworks, shutdownSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const session = openSession({})
let startedHere = false

try {
  await session.start()
  startedHere = await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })

  // 1) 真的建一个件
  const build = await session.call('tools/call', {
    name: 'model',
    arguments: {
      action: 'build',
      definition: {
        // 每次运行都用新 designId：服务侧 review/live.json 会跨进程累积，
        // 复用同名设计会把上一次的 revision/图带进本轮，测到的就不是本轮行为。
        designId: `gate-live-${Date.now()}`,
        params: { w: 100, h: 60, t: 20 },
        features: [
          { id: 'plate_outline', kind: 'sketch', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'w', height: 'h' }] },
          { id: 'plate', kind: 'extrude', profile: 'plate_outline', depth: 't', direction: '+Y' },
        ],
      },
    },
  })
  const buildEnvelope = JSON.parse(build.content.find((c) => c.type === 'text').text)
  check('真实 build 成功', buildEnvelope.status === 'ok', buildEnvelope.summary)

  // 2) 真的截一张图
  const shot = await session.call('tools/call', { name: 'capture', arguments: { width: 900, height: 600, view: '*等轴测' } })
  const shotEnvelope = JSON.parse(shot.content.find((c) => c.type === 'text').text)
  const shotPath = shotEnvelope.artifacts?.find((a) => a.kind === 'image')?.path
  check('真实 capture 回了一个图片路径', typeof shotPath === 'string' && existsSync(shotPath), shotPath)
  check('capture 的图是 PNG', /\.png$/i.test(shotPath ?? ''), shotPath)

  // 3) 把真实结果喂给审查门
  const handlers = new Map()
  const spawned = []
  let verdict = { verdict: 'different', confidence: 0.7, differences: [{ region: '顶面右侧', expected: '有一块凸台', actual: '平的' }] }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    get(service) {
      if (service === 'subagents') {
        return {
          async startActivation(spec) {
            spawned.push(spec)
            return { childId: 'c1', result: Promise.resolve({ structured: verdict, stopReason: 'stop' }), dispose: async () => {} }
          },
        }
      }
      if (service === 'attachments') return { saveImage: async ({ name }) => `att://${name}` }
      return undefined
    },
    async fire(event, payload, fallback) {
      const list = handlers.get(event) ?? []
      if (event.startsWith('tools/')) return list.length ? list[0](payload, fallback) : fallback()
      for (const handler of list) handler(payload)
    },
  }
  apply(ctx, {})
  const agent = { id: 'live-1', session: { id: 'live-1' } }
  await ctx.fire('tools/execute', { name: 'mcp__sw__model', arguments: { action: 'build' }, agent }, async () => build)
  await ctx.fire('tools/execute', { name: 'mcp__sw__capture', arguments: {}, agent }, async () => shot)

  const deny = await ctx.fire('tools/pre-execute', { name: 'mcp__sw__deliver', arguments: {}, agent }, async () => ({ kind: 'allow' }))
  check('真实的图能被审查门收到', spawned.length === 1, spawned.length)
  const spec = spawned[0]
  const request = spec.request ?? spec
  const promptText = request.prompt.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const images = request.prompt.filter((b) => b.type === 'image')
  check('送审带着真实的图片块', images.length >= 1, images.length)
  check('prompt 清单里写着真实路径', promptText.includes(shotPath ?? '###'), promptText.slice(0, 240))
  check('清单标出来源是 capture', /来源 capture/.test(promptText), promptText.slice(0, 240))
  check('结论 different 时拒绝交付', deny.kind === 'deny' && String(deny.reason).includes('顶面右侧'), deny.reason)

  // 4) 结论改成 passed → 放行
  verdict = { verdict: 'passed', confidence: 0.9, differences: [] }
  const editResult = await session.call('tools/call', {
    name: 'model',
    arguments: { action: 'edit', designId: buildEnvelope.designId, parameters: { w: 80 } },
  })
  const editEnvelope = JSON.parse(editResult.content.find((c) => c.type === 'text').text)
  check('真实 edit 改了几何', editEnvelope.status === 'ok' && /96000/.test(String(editEnvelope.summary ?? '')), editEnvelope.summary)
  await ctx.fire('tools/execute', { name: 'mcp__sw__model', arguments: { action: 'edit' }, agent }, async () => editEnvelope)
  const shot2 = await session.call('tools/call', { name: 'capture', arguments: { width: 900, height: 600, view: '*等轴测' } })
  await ctx.fire('tools/execute', { name: 'mcp__sw__capture', arguments: {}, agent }, async () => shot2)
  const allow = await ctx.fire('tools/pre-execute', { name: 'mcp__sw__deliver', arguments: {}, agent }, async () => ({ kind: 'allow' }))
  check('重截后审过 → 放行', allow.kind === 'allow', allow.kind)

  // 5) 再改模型不截图 → 旧图作废，拒绝
  const edit2 = await session.call('tools/call', {
    name: 'model',
    arguments: { action: 'edit', designId: buildEnvelope.designId, parameters: { w: 90 } },
  })
  const edit2Envelope = JSON.parse(edit2.content.find((c) => c.type === 'text').text)
  await ctx.fire('tools/execute', { name: 'mcp__sw__model', arguments: { action: 'edit' }, agent }, async () => edit2Envelope)
  const stale = await ctx.fire('tools/pre-execute', { name: 'mcp__sw__deliver', arguments: {}, agent }, async () => ({ kind: 'allow' }))
  check('改完不截图 → 拒绝并要求重截', stale.kind === 'deny' && String(stale.reason).includes('改之前'), stale.reason)

  await session.tool('workspace', { action: 'cleanup' })
} catch (error) {
  check('端到端没有抛异常', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
} finally {
  try { await session.close() } catch {}
  try { await shutdownSolidworks(null, startedHere) } catch {}
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
