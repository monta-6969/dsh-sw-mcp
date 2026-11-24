// 机械配算：每条用例的期望值都用独立算式手算出来写在注释里，不复用被测代码的公式。
// 一个计算器最危险的不是算错，而是"算出一个漂亮的数"却漏了约束 —— 所以 checks 也要验。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(resolve(here, '..'), 'server', 'server.mjs')

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = ''
let nextId = 1
const waiters = new Map()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    waiter(message.result ?? message.error)
  }
})

const rpc = (method, params) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    setTimeout(() => rejectPromise(new Error(`${method} 超时`)), 60_000)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) passed += 1
  else failures.push(name)
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const near = (actual, expected, tol = 1e-3) => Math.abs((actual ?? NaN) - expected) <= Math.abs(expected) * tol

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'calculate-probe', version: '0' },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)

  // calculate 是按需组：默认工具面只有 8 个核心工具，先激活再调。
  // 不激活时 tools/call 会回 "Tool calculate not found"，那不是算错，是没开组。
  await tool('catalog', { action: 'activate', capability: 'calculate' })

  const list = await tool('calculate', { action: 'list' })
  const ids = (list.changes?.calculators ?? []).map((c) => c.id)
  check('calculate lists its calculators', ids.length >= 8, ids.join(','))
  check('every calculator states its assumptions', (list.changes?.calculators ?? []).every((c) => c.assumptions?.length > 0))

  // 三级行星：8/392 → 1+392/8=50；20/100 → 6；16/96 → 7；总 50×6×7=2100
  const planetary = await tool('calculate', {
    action: 'run',
    calculator: 'planetary',
    inputs: {
      stages: [
        { sun: 8, ring: 392, planets: 4 },
        { sun: 20, ring: 100, planets: 3 },
        { sun: 16, ring: 96, planets: 4 },
      ],
      inputSpeed: 1500,
    },
  })
  check('planetary total ratio is 50×6×7', near(planetary.measurements?.totalRatio, 2100), planetary.measurements?.totalRatio)
  // 1500 / 2100 = 0.714285…
  check('output speed is the input divided by the ratio', near(planetary.measurements?.outputSpeed, 1500 / 2100), planetary.measurements?.outputSpeed)
  check('the ratio steps show every stage', (planetary.extra?.steps ?? []).some((s) => s.total === 2100))

  const failedChecks = (planetary.extra?.checks ?? []).filter((c) => !c.passed)
  check('four planets in stage 1 violate the neighbour condition',
    failedChecks.some((c) => c.stage === 1 && c.name === '邻接条件'),
    failedChecks.map((c) => `L${c.stage}:${c.name}`))
  check('the warning says how many planets would fit', /最多只能放 2 个行星轮/.test(
    failedChecks.find((c) => c.stage === 1 && c.name === '邻接条件')?.note ?? ''))
  check('an 8-tooth sun gear is flagged for undercut',
    failedChecks.some((c) => c.stage === 1 && c.name === '根切'))

  const twoPlanets = await tool('calculate', {
    action: 'run',
    calculator: 'planetary',
    inputs: {
      stages: [
        { sun: 8, ring: 392, planets: 2 },
        { sun: 20, ring: 100, planets: 3 },
        { sun: 16, ring: 96, planets: 4 },
      ],
    },
  })
  check('two planets clear the neighbour condition in stage 1',
    (twoPlanets.extra?.checks ?? []).find((c) => c.stage === 1 && c.name === '邻接条件')?.passed === true)
  check('the ratio does not depend on the planet count', near(twoPlanets.measurements?.totalRatio, 2100))

  // 直齿 m=2 z=20/40 α=20°：d1=40 d2=80 a=60
  // ε = (√(44²-37.588²)+√(84²-75.176²) - 2·60·sin20°)/(2π·2·cos20°) = 1.635
  const spur = await tool('calculate', {
    action: 'run',
    calculator: 'spur',
    inputs: { module: 2, z1: 20, z2: 40, pressureAngle: 20 },
  })
  check('spur pitch diameters', near(spur.measurements?.d1, 40) && near(spur.measurements?.d2, 80),
    [spur.measurements?.d1, spur.measurements?.d2])
  check('spur centre distance is 60', near(spur.measurements?.centerDistance, 60), spur.measurements?.centerDistance)
  check('spur contact ratio is 1.635', near(spur.measurements?.contactRatio, 1.635, 0.002), spur.measurements?.contactRatio)

  // 轴承：C/P = 5，L10 = 5³×10⁶ = 1.25e8 转，n=1500 → 1.25e8/(60×1500) = 1388.89 h
  const bearing = await tool('calculate', {
    action: 'run',
    calculator: 'bearing',
    inputs: { C: 10000, P: 2000, speed: 1500 },
  })
  check('bearing L10 revolutions', bearing.measurements?.revolutions === 125000000, bearing.measurements?.revolutions)
  check('bearing L10h is 1388.89 h', near(bearing.measurements?.hours, 1388.8889, 0.001), bearing.measurements?.hours)

  // 螺纹 M8×1.25：d2 = 8-0.6495×1.25 = 7.1881；As = π/4×(8-0.9382×1.25)² = 36.61
  const thread = await tool('calculate', {
    action: 'run',
    calculator: 'thread',
    inputs: { diameter: 8, pitch: 1.25, propertyClass: '8.8' },
  })
  check('thread pitch diameter', near(thread.measurements?.pitchDiameter, 7.188, 0.001), thread.measurements?.pitchDiameter)
  check('thread stress area', near(thread.measurements?.stressArea, 36.61, 0.002), thread.measurements?.stressArea)
  check('thread tightening torque is computed', thread.measurements?.tighteningTorque > 0, thread.measurements?.tighteningTorque)

  // 轴 Ø30 传 100 N·m：τ = 16×100×10³/(π×30³) = 18.86 MPa
  const shaft = await tool('calculate', {
    action: 'run',
    calculator: 'shaft',
    inputs: { torque: 100, diameter: 30 },
  })
  check('shaft torsional stress', near(shaft.measurements?.shearStress, 18.86, 0.002), shaft.measurements?.shearStress)

  // 弹簧 d=2 D=20 n=10 G=79000：C=10，k=79000×16/(8×8000×10)=1.975 N/mm，Hs=(10+2)×2=24
  const spring = await tool('calculate', {
    action: 'run',
    calculator: 'spring',
    inputs: { wire: 2, meanDiameter: 20, activeCoils: 10 },
  })
  check('spring rate', near(spring.measurements?.rate, 1.975, 0.002), spring.measurements?.rate)
  check('spring index', near(spring.measurements?.index, 10), spring.measurements?.index)
  check('spring solid height', near(spring.measurements?.solidHeight, 24), spring.measurements?.solidHeight)

  // 失败路径
  const unknown = await tool('calculate', { action: 'run', calculator: 'nope', inputs: {} })
  check('an unknown calculator fails with a code', unknown.status === 'failed'
    && unknown.extra?.error?.code === 'UNKNOWN_CALCULATOR', unknown.extra?.error?.code)
  check('the failure lists what does exist', (unknown.extra?.error?.detail?.available ?? []).includes('planetary'))

  const badInput = await tool('calculate', { action: 'run', calculator: 'spur', inputs: { module: 'abc' } })
  check('a non-numeric input is rejected', badInput.status === 'failed'
    && badInput.extra?.error?.code === 'BAD_ARGUMENT', badInput.extra?.error?.code)

  const formula = await tool('calculate', { action: 'formula', calculator: 'planetary' })
  check('formula returns the equations without numbers',
    (formula.changes?.calculator?.formulas ?? []).some((f) => f.includes('i = 1 + z_ring')))
} catch (error) {
  failures.push(error.message)
  console.error('FAIL ', error.message)
} finally {
  child.kill()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exitCode = 1
}
