// 只读通道的写子动作守卫（离线验收：不需要 SOLIDWORKS，也不起桥接器 / broker）。
//
// 背景（独立审计 S1）：SW_MCP_TOOLS 白名单只按**工具名**裁剪，而 inspect 一个工具
// 里同时带着读与写两类子动作 —— relationAction 的 add/remove/edit/apply/clear、
// dimensionAction 的 add/edit/remove 原样转给桥接器的写路径。于是 sw-review 的
// 「只读」MCP（mcp__sw-ro__inspect）实际能改用户文档，与 cordis.patch.yml /
// review-gate.js 的只读承诺冲突。
//
// 怎么证明「在进入桥接器之前」就拒了：把桥接器 exe 钉在一个**不存在**的路径
// （SW_MCP_CONFIG 的 bridgeExe）。守卫若没生效，调用会走到 startBridge 并以
// BRIDGE_MISSING 报错；守卫生效则报 READ_ONLY_TOOLSET。所以
// 「错误码是 READ_ONLY_TOOLSET 而不是 BRIDGE_MISSING」本身就是「没碰桥接器」的证据，
// 同时这个测试也绝不可能碰到正在跑的 SOLIDWORKS。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'

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

const work = mkdtempSync(join(tmpdir(), 'sw-mcp-read-only-guard-'))
const dataDir = join(work, 'data')
mkdirSync(dataDir, { recursive: true })
const fakeBridge = join(work, 'no-such-bridge', 'SwBridge.exe')
const configPath = join(work, 'sw.config.json')
writeFileSync(configPath, JSON.stringify({ bridgeExe: fakeBridge }), 'utf8')

const baseEnv = {
  ...process.env,
  SW_MCP_DATA: dataDir,
  SW_MCP_CONFIG: configPath,
  SW_MCP_BROKER: '0',
}
delete baseEnv.SW_MCP_TOOLS
const readOnlyEnv = { ...baseEnv, SW_MCP_TOOLS: 'inspect' }

const codeOf = (result) => result?.extra?.error?.code ?? null
const toolsOf = async (session) => {
  const listed = await session.call('tools/list', {})
  return Array.isArray(listed?.tools) ? listed.tools : []
}
const toolNames = async (session) => (await toolsOf(session)).map((tool) => tool.name).sort()

// 桥接器钉死：任何真的走到桥接器启动的调用都只会得到 BRIDGE_MISSING。
const BRIDGE_PINNED = 'BRIDGE_MISSING'

try {
  // ─────────────────────────────────────────────── 1. 只读实例：工具面只剩 inspect
  const ro = openSession({ env: readOnlyEnv })
  await ro.start()
  try {
    const names = await toolNames(ro)
    check('SW_MCP_TOOLS=inspect：tools/list 只有 inspect',
      names.length === 1 && names[0] === 'inspect', names)

    // schema/描述里要写清楚只读实例的界限，否则模型会一直试写子动作。枚举不收窄：
    // 同一个 inspect 在默认实例里仍然有全部子动作。
    const inspectTool = (await toolsOf(ro)).find((tool) => tool.name === 'inspect')
    const properties = inspectTool?.inputSchema?.properties ?? {}
    check('只读实例：relationAction / dimensionAction 的描述里注明 READ_ONLY_TOOLSET，且枚举不收窄',
      /READ_ONLY_TOOLSET/.test(properties.relationAction?.description ?? '')
      && /READ_ONLY_TOOLSET/.test(properties.dimensionAction?.description ?? '')
      && JSON.stringify(properties.relationAction?.enum ?? [])
        === JSON.stringify(['list', 'add', 'remove', 'edit', 'infer', 'apply', 'clear'])
      && JSON.stringify(properties.dimensionAction?.enum ?? [])
        === JSON.stringify(['list', 'add', 'edit', 'remove']),
      {
        relationAction: properties.relationAction?.description,
        dimensionAction: properties.dimensionAction?.description,
      })

    // ─────────────────────────────────────────── 2. 写子动作：进入桥接器之前就被拒
    const cases = [
      { name: 'relations add', args: { action: 'relations', relationAction: 'add', relations: [{ type: 'coincident', refs: ['l1:end', 'l2:start'] }] }, field: 'relationAction' },
      { name: 'relations remove', args: { action: 'relations', relationAction: 'remove', relationIds: [1] }, field: 'relationAction' },
      { name: 'relations edit', args: { action: 'relations', relationAction: 'edit', relationIds: [1] }, field: 'relationAction' },
      { name: 'relations apply', args: { action: 'relations', relationAction: 'apply' }, field: 'relationAction' },
      { name: 'relations clear', args: { action: 'relations', relationAction: 'clear', confirm: true }, field: 'relationAction' },
      { name: 'relations apply=true（旧写法）', args: { action: 'relations', apply: true }, field: 'apply' },
      { name: 'dimensions add', args: { action: 'dimensions', dimensionAction: 'add', dimensions: [{ kind: 'distance', refs: ['seg:1'], valueMm: 40 }] }, field: 'dimensionAction' },
      { name: 'dimensions edit', args: { action: 'dimensions', dimensionAction: 'edit', dimensions: [{ index: 1, valueMm: 41 }] }, field: 'dimensionAction' },
      { name: 'dimensions remove', args: { action: 'dimensions', dimensionAction: 'remove', dimensions: [{ index: 1 }] }, field: 'dimensionAction' },
    ]
    for (const item of cases) {
      const result = await ro.tool('inspect', { ...item.args, designId: 'guard-fixture' })
      const code = codeOf(result)
      const detail = result?.extra?.error?.detail ?? {}
      check(`只读实例：inspect ${item.name} 被 READ_ONLY_TOOLSET 拒（没碰桥接器）`,
        result?.status === 'failed'
        && code === 'READ_ONLY_TOOLSET'
        && detail.field === item.field
        && /进入桥接器之前/.test(result?.extra?.error?.message ?? ''),
        { status: result?.status, code, detail })
    }

    // 「没碰桥接器」的另一半证据：桥接器被钉死时，写调用没有报 BRIDGE_MISSING。
    const add = await ro.tool('inspect', { action: 'relations', relationAction: 'add', designId: 'guard-fixture' })
    check('只读实例：写子动作没有落到桥接器（错误码不是 BRIDGE_MISSING）',
      codeOf(add) !== BRIDGE_PINNED, codeOf(add))

    // ─────────────────────────────────────────── 3. 读子动作照样放行到桥接器
    for (const [what, args] of [
      ['relations list', { action: 'relations', relationAction: 'list' }],
      ['relations 默认（不写 relationAction）', { action: 'relations' }],
      ['relations infer（只推断不写入）', { action: 'relations', relationAction: 'infer' }],
      ['dimensions list', { action: 'dimensions', dimensionAction: 'list' }],
      ['model（纯读）', { action: 'model' }],
    ]) {
      const result = await ro.tool('inspect', { ...args, designId: 'guard-fixture' })
      check(`只读实例：inspect ${what} 不被只读守卫拦截（能走到桥接器）`,
        codeOf(result) === BRIDGE_PINNED, codeOf(result))
    }
  } finally {
    ro.close()
  }

  // ─────────────────────────────────────────────── 4. 默认实例（无白名单）：行为不变
  const full = openSession({ env: baseEnv })
  await full.start()
  try {
    const names = await toolNames(full)
    check('不带白名单：inspect 仍然注册，工具面不止一个（默认行为不变）',
      names.includes('inspect') && names.length > 1, names.slice(0, 6))

    for (const [what, args, field] of [
      ['relations relationAction=add', { action: 'relations', relationAction: 'add', relations: [{ type: 'coincident', refs: ['l1:end', 'l2:start'] }] }, 'relationAction'],
      ['relations apply=true', { action: 'relations', apply: true }, 'apply'],
      ['dimensions dimensionAction=add', { action: 'dimensions', dimensionAction: 'add', dimensions: [{ kind: 'distance', refs: ['seg:1'], valueMm: 40 }] }, 'dimensionAction'],
    ]) {
      const result = await full.tool('inspect', { ...args, designId: 'guard-fixture' })
      check(`不带白名单：inspect ${what} 不被只读守卫拦截（没有 READ_ONLY 类错误）`,
        codeOf(result) !== 'READ_ONLY_TOOLSET', { code: codeOf(result), field })
    }
    // 默认实例真的会往桥接器走：桥接器被钉死，所以这里必须报 BRIDGE_MISSING。
    const write = await full.tool('inspect', {
      action: 'relations',
      relationAction: 'add',
      relations: [{ type: 'coincident', refs: ['l1:end', 'l2:start'] }],
      designId: 'guard-fixture',
    })
    check('不带白名单：写调用确实走到了桥接器启动（BRIDGE_MISSING，说明守卫没拦）',
      codeOf(write) === BRIDGE_PINNED, codeOf(write))
  } finally {
    full.close()
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
