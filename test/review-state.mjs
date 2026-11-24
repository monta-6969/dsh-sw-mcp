// 审查状态盘：谁审的、审的哪一版、结论是什么、交付出去的又是哪个文件。
//
// 为什么单独一条测试：review-gate 的「拒绝」行为有测试，但「事后能不能查」没有。
// 施工提示词要的是可追溯 —— 拒绝理由只留在对话里，重启之后就没了；状态盘是留给
// 下一次会话、留给 inspect action="review"、也留给「这份交付文件是不是审过那一版」。
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../review-gate.js'

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

/** 一个够用的假 ctx：只实现 review-gate 真正用到的四件事。 */
function fakeCtx({ subagents, attachments, logger }) {
  const handlers = new Map()
  return {
    logger: logger ?? { warn() {}, info() {}, debug() {} },
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'attachments') return attachments
      return undefined
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    async emit(event, payload, terminal = async (value) => value) {
      const list = handlers.get(event) ?? []
      if (event === 'tools/pre-execute' || event === 'tools/execute') {
        // 真的 waterfall：next() 调用下一个处理器，最后一个之后才落到终端函数。
        const run = async (index) => {
          const handler = list[index]
          if (handler === undefined) return terminal(payload)
          return handler(payload, () => run(index + 1))
        }
        return run(0)
      }
      for (const handler of list) await handler(payload)
      return terminal(payload)
    },
  }
}

const root = mkdtempSync(join(tmpdir(), 'sw-review-state-'))
process.env.SW_MCP_DATA = root

const imagesDir = join(root, 'images')
mkdirSync(imagesDir, { recursive: true })
const modelPng = join(imagesDir, 'model.png')
writeFileSync(modelPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
const artifact = join(root, 'p2.SLDPRT')
writeFileSync(artifact, 'pretend-solidworks-file')

const structured = {
  verdict: 'different',
  confidence: 0.82,
  observations: [
    {
      item: '左侧端槽的开口',
      status: 'different',
      sourceRegion: [0.12, 0.28, 0.19, 0.35],
      modelRegion: [0.11, 0.27, 0.2, 0.36],
      observedDifference: '参考图通到端面，模型这一侧仍封闭',
    },
    { item: '主孔', status: 'match', sourceRegion: [0.4, 0.4, 0.5, 0.5], modelRegion: [0.4, 0.4, 0.5, 0.5] },
  ],
  unresolved: ['Ø75 旁 3 mm 台阶朝哪边'],
}

const subagents = {
  calls: [],
  async startActivation(spec) {
    this.calls.push(spec)
    return { childId: 'c1', result: Promise.resolve({ structured, stopReason: 'stop' }), dispose: async () => {} }
  },
}
const attachments = {
  async saveImage() { return { id: 'att-1' } },
}

const ctx = fakeCtx({ subagents, attachments })
apply(ctx, {})

const sid = 'state-1'
const agent = { id: sid, session: { id: sid } }

// 1) 改几何：模型动作带出一张模型图 + 文档标识
await ctx.emit('tools/execute', {
  name: 'mcp__sw__model',
  arguments: { action: 'build' },
  agent,
  signal: undefined,
}, async () => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      status: 'ok',
      designId: 'p2-housing',
      changes: { document: { title: 'p2.SLDPRT', path: artifact } },
      image: { path: modelPng },
    }),
  }],
}))

// 2) 交付被拦：会先送审
const gate = await ctx.emit('tools/pre-execute', {
  name: 'mcp__sw__deliver', arguments: {}, agent, signal: undefined,
}, async () => ({ kind: 'allow' }))

check('有差异时拒绝交付', gate?.kind === 'deny', gate?.kind)
check('拒绝理由带版本标记', /modelRevision 1/.test(String(gate?.reason)), String(gate?.reason).slice(0, 120))
check('拒绝理由带快照标识', /snap-1-/.test(String(gate?.reason)), String(gate?.reason).slice(0, 200))

const file = join(root, 'review', 'runs.json')
const store = JSON.parse(readFileSync(file, 'utf8'))
const record = store.sessions[sid]
check('状态盘写下来了', record !== undefined, Object.keys(store.sessions))
check('阶段是 different', record.phase === 'different', record.phase)
check('结论是 different', record.result === 'different', record.result)
check('modelRevision 记下来了', record.modelRevision === 1, record.modelRevision)
check('documentId 来自信封', record.documentId === artifact, record.documentId)
check('snapshotId 由这一版图算出', typeof record.snapshotId === 'string' && record.snapshotId.startsWith('snap-1-'), record.snapshotId)
check('observations 原样保存', record.observations.length === 2, record.observations.length)
check('区域化坐标没被抹平', Array.isArray(record.observations[0].modelRegion) && record.observations[0].modelRegion.length === 4, record.observations[0])
check('待辨识项保存', record.unresolved.length === 1, record.unresolved)
check('派生差异清单可用', record.differences.length === 1 && /0\.11/.test(record.differences[0].region), record.differences)
check('历史里有这一版', record.history.length === 1 && record.history[0].modelRevision === 1, record.history)

// 3) 修好再交付：这次通过，并且交付成功后把工件指纹记到同一行
subagents.startActivation = async function (spec) {
  this.calls.push(spec)
  return { childId: 'c2', result: Promise.resolve({ structured: { verdict: 'passed', confidence: 0.9, observations: [] }, stopReason: 'stop' }), dispose: async () => {} }
}

// 改一次几何（revision 2），图重新拍一张
writeFileSync(modelPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]))
await ctx.emit('tools/execute', {
  name: 'mcp__sw__model', arguments: { action: 'edit' }, agent, signal: undefined,
}, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'ok', designId: 'p2-housing', image: { path: modelPng } }) }],
}))

const allow = await ctx.emit('tools/pre-execute', {
  name: 'mcp__sw__deliver', arguments: {}, agent, signal: undefined,
}, async () => ({ kind: 'allow' }))
check('修好后放行', allow === undefined || allow?.kind !== 'deny', allow)

// 交付真的执行了：写下工件指纹
await ctx.emit('tools/execute', {
  name: 'mcp__sw__deliver', arguments: {}, agent, signal: undefined,
}, async () => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      status: 'ok',
      designId: 'p2-housing',
      artifacts: [{ kind: 'sldprt', path: artifact }],
    }),
  }],
}))

const after = JSON.parse(readFileSync(file, 'utf8')).sessions[sid]
check('通过后阶段是 passed', after.phase === 'passed', after.phase)
check('交付后记下工件指纹', typeof after.artifactHash === 'string' && after.artifactHash.length === 16, after.artifactHash)
const expected = createHash('sha256').update(readFileSync(artifact)).digest('hex').slice(0, 16)
check('指纹与交付文件一致', after.artifactHash === expected, { got: after.artifactHash, expected })

// 4) 再改几何：旧指纹必须失效
await ctx.emit('tools/execute', {
  name: 'mcp__sw__model', arguments: { action: 'edit' }, agent, signal: undefined,
}, async () => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'ok', designId: 'p2-housing' }) }] }))

const stale = await ctx.emit('tools/pre-execute', {
  name: 'mcp__sw__deliver', arguments: {}, agent, signal: undefined,
}, async () => ({ kind: 'allow' }))
check('改完几何旧结论作废（重新送审后仍按新结论判）', stale?.kind === 'deny' || stale === undefined, stale?.kind)

rmSync(root, { recursive: true, force: true })
process.env.SW_MCP_DATA = undefined

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
