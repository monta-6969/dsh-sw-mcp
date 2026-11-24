// PTC 模式下的审查门：图从哪来、额度怎么算。
//
// 两个真事故（session-3f026ed8 实测）：
//   1. 模型 capture 了十几次，交付却一直回「这一轮没有留下任何图」。原因是 PTC 的
//      内层 mcp__sw__* 调用不经过宿主侧 tools/execute，插件只看得到外层 run_code，
//      而 run_code 的返回里没有图。
//   2. 「本次会话已经审过 6 次还没过」把交付永久锁死，可 logs/review.jsonl 里对这个
//      零件一行记录都没有 —— 6 次全是「没有图」的拒绝，每次都在真正送审之前就计数。
//
// 这条测试不启动 SOLIDWORKS，也不碰真机：用 MCP 服务写的 review/live.json 投影
// 「服务看得到的事实」，然后驱动真实的插件 waterfall。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../review-gate.js'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

function fakeCtx({ subagents, attachments }) {
  const handlers = new Map()
  return {
    logger: { warn() {}, info() {}, debug() {} },
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

const root = mkdtempSync(join(tmpdir(), 'sw-review-ptc-'))
process.env.SW_MCP_DATA = root
mkdirSync(join(root, 'review'), { recursive: true })
mkdirSync(join(root, 'images'), { recursive: true })
const shot = join(root, 'images', 'shot-01.png')
writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
const shot2 = join(root, 'images', 'shot-02.png')
writeFileSync(shot2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))

function startSession(verdict) {
  const subagents = {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return {
        childId: `c${this.calls.length}`,
        result: Promise.resolve({ structured: verdict, stopReason: 'stop' }),
        dispose: async () => {},
      }
    },
  }
  const attachments = { async saveImage() { return { id: 'att-1' } } }
  const ctx = fakeCtx({ subagents, attachments })
  apply(ctx, {})
  return { ctx, subagents }
}

const passedVerdict = { verdict: 'passed', confidence: 0.9, observations: [], unresolved: [] }

const agent = { id: 'ptc-1', session: { id: 'ptc-1' } }
const live = (revision, images, documentPath) => writeFileSync(join(root, 'review', 'live.json'), JSON.stringify({
  version: 1,
  designs: {
    'ptc-cover': {
      designId: 'ptc-cover',
      documentPath,
      revision,
      images,
      updatedAt: new Date().toISOString(),
    },
  },
}, null, 2))

try {
  // 1) 服务那一侧记了「revision 2 + 一张图」，插件本地什么都没有（PTC 的真实情形）。
  live(2, [{ path: shot, atRevision: 2 }], 'C:/tmp/ptc-cover.SLDPRT')
  const a = startSession(passedVerdict)
  const deliver = await a.ctx.emit('tools/pre-execute', {
    name: 'mcp__sw__deliver',
    arguments: { designId: 'ptc-cover', kind: 'sldprt', path: 'C:/tmp/ptc-cover.SLDPRT' },
    agent,
    signal: undefined,
  }, async () => ({ kind: 'allow' }))

  check('PTC 下能拿到服务记的图并真的送审', a.subagents.calls.length === 1, a.subagents.calls.length)
  check('送审用的是 live.json 里的那张图', JSON.stringify(a.subagents.calls[0] ?? {}).includes('shot-01.png'), true)
  check('审过之后放行交付', deliver?.kind === undefined || deliver?.kind === 'allow', deliver?.kind)

  // 2) 版本变了但没有新图：旧图是旧模型的照片，不许拿它审。
  live(3, [{ path: shot, atRevision: 2 }], 'C:/tmp/ptc-cover.SLDPRT')
  const b = startSession(passedVerdict)
  const stale = await b.ctx.emit('tools/pre-execute', {
    name: 'mcp__sw__deliver',
    arguments: { designId: 'ptc-cover' },
    agent: { id: 'ptc-2', session: { id: 'ptc-2' } },
    signal: undefined,
  }, async () => ({ kind: 'allow' }))
  check('版本变了、图是旧的 → 拒绝', stale?.kind === 'deny', stale?.kind)
  check('并说清是「改之前的图」', /改之前|重新截一张/.test(String(stale?.reason)), String(stale?.reason).slice(0, 160))
  check('这种拒绝不算一次审查', b.subagents.calls.length === 0, b.subagents.calls.length)

  // 3) 连拒 6 次之后额度不该被吃掉：第 7 次给了新图仍然照常送审。
  const c = startSession(passedVerdict)
  live(4, [], 'C:/tmp/ptc-cover.SLDPRT')
  const agent3 = { id: 'ptc-3', session: { id: 'ptc-3' } }
  let last = null
  for (let i = 0; i < 6; i += 1) {
    last = await c.ctx.emit('tools/pre-execute', {
      name: 'mcp__sw__deliver', arguments: { designId: 'ptc-cover' }, agent: agent3, signal: undefined,
    }, async () => ({ kind: 'allow' }))
  }
  check('没有图时一直拒绝', last?.kind === 'deny', last?.kind)
  check('拒绝理由不是「已经审过 6 次」', !/已经审了 6 次|已经审过 6 次/.test(String(last?.reason)), String(last?.reason).slice(0, 80))
  check('6 次拒绝没有触发任何真实审查', c.subagents.calls.length === 0, c.subagents.calls.length)

  live(4, [{ path: shot2, atRevision: 4 }], 'C:/tmp/ptc-cover.SLDPRT')
  const afterQuota = await c.ctx.emit('tools/pre-execute', {
    name: 'mcp__sw__deliver', arguments: { designId: 'ptc-cover' }, agent: agent3, signal: undefined,
  }, async () => ({ kind: 'allow' }))
  check('第 7 次给了新图就送审（额度没被假审查吃光）', c.subagents.calls.length === 1, c.subagents.calls.length)
  check('然后放行', afterQuota?.kind === undefined || afterQuota?.kind === 'allow', afterQuota?.kind)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
