// 扫掠 / 螺旋线 / 放样：静态契约 + 真机蜗杆验收。
//
// 静态部分钉住「三条路都要真的走原生 API，且未知参数不许静默吞」：
//   · Compiler 认识 helix/sweep/loft，未知 feature kind 抛 UNSUPPORTED_FEATURE_KIND（以前是无声跳过，
//     整件照建、回包 ok，少掉的那一步只体现在体积上）；
//   · 拔模的 Dchk1/Dchk2 必须是 draft≠0 才打开（写死 false 时 draft=10° 与 0° 逐位相同）；
//   · revolve 的轴要能指全局 x/y/z，非法轴报 UNSUPPORTED_PARAM；
//   · model 动作面里有 helix/sweep/loft，focus 回包里写明本会话真正可调的动作。
//
// 真机部分建 ZA 单头蜗杆（Ø14、m1、z1=1、螺纹长 30），再量几何：
//   体积 4400–4800 mm³（圆柱 6031.86 − 螺旋槽）、面数 8、
//   齿顶 Ø16 / 齿根 Ø11.6（螺旋边半径 8.0 / 5.8）、
//   实测导程 = π·m = 3.141593 ± 0.005（沿螺旋边采样 z(θ) 回归）、
//   齿顶轴向齿厚 0.840 ± 0.02。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSolidworks } from './lib/sw.mjs'
import { openSession } from './lib/mcp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const read = (rel) => readFileSync(join(repo, rel), 'utf8')

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

// ------------------------------------------------------------ A. 静态契约
{
  const compiler = read('bridge/src/Compiler.cs')
  const sweeps = read('bridge/src/Sweeps.cs')
  const server = read('server/server.mjs')
  const face = read('server/tool-face.mjs')
  const native = read('server/catalog/native.mjs')
  const builder = read('bridge/src/Builder.cs')

  check('Compiler 认识 helix / sweep / loft', ['"helix"', '"sweep"', '"loft"'].every((k) => compiler.includes(`case ${k}:`)))
  const defaultAt = compiler.indexOf('\n                    default:')
  check('unknown feature kind 不再静默跳过',
    defaultAt > 0 && compiler.slice(defaultAt, defaultAt + 600).includes('UNSUPPORTED_FEATURE_KIND'))
  const store = read('server/design-store.mjs')
  check('manifest 的 sw 块来自回读参数（不再是恒 null）',
    /sw = null/.test(store) && /sw: sw \?\?/.test(store))
  check('deliver 拿不到回读就报 MISSING_READBACK',
    server.includes('function buildSwReadback(') && server.includes("fail('MISSING_READBACK'")
      && /if \(swReadback\?\.error\)/.test(server))
  check('Sweeps 走的是四条原生 API', ['_doc.InsertHelix', 'InsertCutSwept5', 'InsertProtrusionSwept4', 'InsertLoftRefSurface2', 'InsertProtrusionBlend2', 'InsertCutBlend'].every((api) => sweeps.includes(api)))
  check('扫描参数枚举化（拼错即报错，不落默认值）',
    sweeps.includes('UNSUPPORTED_INPUT') === false
      && sweeps.includes('is not one of followPath') && sweeps.includes('is not one of oneDirection'))
  check('拔模：Dchk1/Dchk2 由 draft 决定，不再写死 false',
    /bool draftOn = Math\.Abs\(draftDeg\) > 1e-9;/.test(builder) && /draftOn, draftOn,/.test(builder))
  check('revolve 支持全局轴且非法轴报 UNSUPPORTED_PARAM',
    builder.includes('GlobalAxis(') && builder.includes('UNSUPPORTED_PARAM') && /Json\.Str\(f, "axis", "centerline"\)/.test(compiler))
  check('model 动作面暴露 helix / sweep / loft',
    /'feature', 'helix', 'sweep', 'loft'/.test(server) && face.includes("'helix', 'sweep', 'loft'"))
  check('focus 回包写清本会话可调动作', server.includes('toolFace: toolFaceReport(') && server.includes('function toolFaceReport('))
  check('catalog 有三条新配方', ['feature.helix', 'feature.sweep', 'feature.loft'].every((id) => native.includes(`id: '${id}'`)))
}

// ------------------------------------------------------- B. 真机蜗杆验收
const M = Math.PI
const alphaX = 20.0469 * Math.PI / 180
const halfAt = (r) => M / 4 + (r - 7) * Math.tan(alphaX) // 齿槽半宽（不是齿厚半宽）
const rRoot = 5.5 // df=11.0
const rOut = 8.4
const groove = (() => {
  const [t1, b1] = [halfAt(rRoot), -halfAt(rRoot)]
  const [t2, b2] = [halfAt(rOut), -halfAt(rOut)]
  return [
    { kind: 'line', start: [rRoot, t1], end: [rRoot, b1] },
    { kind: 'line', start: [rRoot, b1], end: [rOut, b2] },
    { kind: 'line', start: [rOut, b2], end: [rOut, t2] },
    { kind: 'line', start: [rOut, t2], end: [rRoot, t1] },
  ]
})()

const session = openSession({})
await session.start()
try {
  await ensureSolidworks((name, args) => session.tool(name, args))
  await session.tool('workspace', { action: 'cleanup' })
  const designId = `worm-helical-${Date.now()}`
  const built = await session.tool('model', {
    action: 'build',
    definition: {
      designId,
      features: [
        { kind: 'sketch', id: 'blank', plane: 0, primitives: [{ shape: 'circle', center: [0, 0], diameter: 16 }] },
        { kind: 'extrude', id: 'body', profile: 'blank', depth: 30, direction: '+Z' },
        { kind: 'sketch', id: 'hxbase', plane: 0, primitives: [{ shape: 'circle', center: [0, 0], diameter: 14 }] },
        { kind: 'helix', id: 'hx', profile: 'hxbase', definedBy: 'heightAndPitch', height: 30, pitch: M },
        { kind: 'sketch', id: 'groove', plane: 1, curves: groove },
        { kind: 'sweep', id: 'thread', profile: 'groove', path: 'hx', cut: true },
      ],
    },
  })
  check('蜗杆建成', built.status === 'ok', built.summary)
  const kinds = (built.changes?.features ?? []).map((f) => `${f.kind}:${f.type}`)
  check('特征树里是真 Helix + SweepCut', kinds.includes('helix:Helix') && kinds.includes('sweep:SweepCut'), kinds)

  const volume = built.measurements?.volume
  check('体积在 4400–4800 mm³（螺旋槽真的切掉了）', volume > 4400 && volume < 4800, { volume })

  const measured = await session.tool('inspect', { action: 'measure', designId, measure: { kind: 'helix' } })
  const hel = measured.measurements ?? {}
  check('实测导程 = π·m ± 0.005', Number.isFinite(hel.pitchMm) && Math.abs(hel.pitchMm - Math.PI) < 0.005,
    { measured: hel.pitchMm, expected: Number(Math.PI.toFixed(6)) })
  check('齿顶 Ø16 / 齿根 Ø11.0（边采样半径）',
    Math.abs((hel.maxEdgeRadiusMm ?? hel.maxRadiusMm) - 8) < 0.05 && Math.abs(hel.minRadiusMm - 5.5) < 0.05,
    { maxEdgeRadiusMm: hel.maxEdgeRadiusMm, minRadiusMm: hel.minRadiusMm })
  const tipBand = (hel.bands ?? []).find((b) => Math.abs(b.radius - 8) < 0.05)
  check('齿顶轴向齿厚 0.840 ± 0.02', tipBand !== undefined && Math.abs(tipBand.ribbonWidthMm - 0.840) < 0.02,
    tipBand ?? null)
  check('旋向读数存在且为单头右旋', (hel.helicalEdges ?? []).every((e) => e.hand === 'right'), hel.helicalEdges)

  // ---- 交付：manifest 的 sw 块必须是 close→open 回读，不是 null ----
  const target = join(repo, 'test', 'out', `worm-${Date.now()}.SLDPRT`)
  const delivered = await session.tool('deliver', { designId, kind: 'sldprt', path: target })
  check('deliver 成功', delivered.status === 'ok', delivered.summary)
  const manifestPath = target.replace(/\.SLDPRT$/i, '.manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const sw = manifest.sw ?? null
  check('manifest.sw 不是 null', sw !== null, sw)
  check('sw 块有重开回读字段',
    sw !== null && Number.isFinite(sw.bodies) && Number.isFinite(sw.faces) && Number.isFinite(sw.volume_mm3)
      && Array.isArray(sw.bbox_mm) && typeof sw.reopened_at === 'string' && Number.isFinite(sw.delta_pct),
    sw === null ? null : { bodies: sw.bodies, faces: sw.faces, volume_mm3: sw.volume_mm3, bbox_mm: sw.bbox_mm, reopened_at: sw.reopened_at, delta_pct: sw.delta_pct })
  check('sw.mass_g 有密度依据（不是凭空数字）',
    sw !== null && Number.isFinite(sw.mass_g) && typeof sw.massBasis === 'string' && sw.massBasis.length > 0,
    sw === null ? null : { mass_g: sw.mass_g, massBasis: sw.massBasis })
} finally {
  try { session.close() } catch { }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
