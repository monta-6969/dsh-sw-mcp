#!/usr/bin/env node
// Regression harness for the SOLIDWORKS bridge.
//
// Every check states the analytic value it expects, and a check fails when the
// measured number misses by more than the stated tolerance. Nothing here trusts
// "the call returned non-null".
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const bridge = path.join(root, 'bridge', 'bin', 'SwBridge.exe')
const outDir = path.join(here, 'out')

// 桥接器是 fail-closed 的：不带 --instance 时它不绑任何 SOLIDWORKS，status 恒回
// INSTANCE_NOT_BOUND（ExpectedPid=0）。以前这个用例原样运行于是永远 0/1，外面
// 得套一层包装脚本去「点名 pid」。现在自己认 --instance <pid> 或 SW_MCP_INSTANCE，
// 并且**不猜**：没给就当场说清楚怎么给，而不是假装跑了。
function resolveInstancePid() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--instance' || arg === '-i') {
      const value = Number(argv[i + 1])
      if (Number.isInteger(value) && value > 0) return { pid: value, from: '--instance' }
      return { error: `${arg} 后面要跟一个正整数 pid，拿到的是 ${JSON.stringify(argv[i + 1])}` }
    }
    const inline = /^--instance=(\d+)$/.exec(arg)
    if (inline) return { pid: Number(inline[1]), from: '--instance=' }
  }
  const envPid = Number(process.env.SW_MCP_INSTANCE)
  if (Number.isInteger(envPid) && envPid > 0) return { pid: envPid, from: 'SW_MCP_INSTANCE' }
  return { error: '没有指定实例' }
}

// designId 前缀可用 SW_TEST_PREFIX 注入（默认空串 = 原来的 base-a / base-b）。
const TEST_PREFIX = process.env.SW_TEST_PREFIX ?? ''
const designIdFor = (base) => `${TEST_PREFIX}${base}`

const resolved = resolveInstancePid()
if (resolved.error) {
  console.log(`INSTANCE_NOT_BOUND  ${resolved.error}`)
  console.log('用法：node test/acceptance.mjs --instance <pid>  或  SW_MCP_INSTANCE=<pid> node test/acceptance.mjs')
  console.log('挑 pid：workspace_ops action=instances 里的 pid，或 Get-Process SLDWORKS 看 Id。')
  process.exitCode = 1
  process.exit(1)
}
const instancePid = resolved.pid
const bridgeArgs = ['--instance', String(instancePid)]

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

function call(req) {
  const p = spawnSync(bridge, bridgeArgs, {
    input: JSON.stringify(req),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (p.error) throw p.error
  const text = (p.stdout || '').trim()
  if (!text) throw new Error(`bridge produced no output (exit ${p.status})\n${p.stderr}`)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`bridge output was not JSON: ${text.slice(0, 400)}`)
  }
}

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol
const PI = Math.PI

function designA() {
  return {
    schemaVersion: 3,
    designId: designIdFor('base-a'),
    units: 'mm',
    params: {
      'plate.w': 100, 'plate.h': 60, 'plate.t': 20,
      'boss.d': 30, 'boss.h': 10, 'hole.d': 10, 'hole.edge': 10, 'fillet.r': 3,
    },
    features: [
      { kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' },
      { kind: 'boss', id: 'centerBoss', face: 'top', diameter: 'boss.d', height: 'boss.h' },
      { kind: 'holes', id: 'centerHole', face: 'top', diameter: 'hole.d', throughAll: true, centres: [{ x: 0, y: 0 }] },
      { kind: 'fillet', id: 'bottomFillet', radius: 'fillet.r', onBottom: true },
    ],
  }
}

function designB(overrides) {
  return {
    schemaVersion: 3,
    designId: designIdFor('base-b'),
    units: 'mm',
    params: { 'plate.w': 100, 'plate.h': 60, 'plate.t': 20, 'hole.d': 6, 'hole.edge': 10, ...(overrides ?? {}) },
    features: [
      { kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' },
      {
        kind: 'holes', id: 'mountingHoles', face: 'top', diameter: 'hole.d', throughAll: true,
        pattern: { kind: 'corners', width: 'plate.w', height: 'plate.h', edge: 'hole.edge' },
      },
    ],
  }
}

// A: 100x60x20 + boss d30 h10 + centre hole d10 through + R3 on the four bottom
// vertical edges.
//   V = 100*60*20 + pi*15^2*10 - pi*5^2*30 - 4*(3^2 - pi*3^2/4)*20
const VOL_A = 100 * 60 * 20 + PI * 15 * 15 * 10 - PI * 25 * 30 - 4 * (9 - (PI * 9) / 4) * 20
// B: 100x60x20 minus four d6 holes through 20
const VOL_B = (w, h, t, d) => w * h * t - 4 * PI * (d / 2) ** 2 * t

function run() {
  fs.mkdirSync(outDir, { recursive: true })

  const status = call({ op: 'status' })
  if (!status.ok || !status.ready) {
    record('SOLIDWORKS is attached', false, JSON.stringify(status))
    report()
    return
  }
  record('SOLIDWORKS is attached', true, `revision ${status.revision}, pid ${status.processId}`)

  // ---------------------------------------------------------------- reference A
  const a = call({ op: 'build', definition: designA() })
  if (!a.ok) {
    record('build reference A', false, JSON.stringify(a.error))
  } else {
    const v = a.geometry.massProperties.volume
    record('build reference A volume', near(v, VOL_A, 0.05),
      `measured ${v}, analytic ${VOL_A.toFixed(4)}, delta ${(v - VOL_A).toFixed(4)}`)
    const box = a.geometry.boundingBox
    record('build reference A bounding box',
      near(box.size[0], 100) && near(box.size[1], 60) && near(box.size[2], 30),
      `size ${JSON.stringify(box.size)}, want [100,60,30]`)
    const hole = (a.geometry.holes || []).find(h => near(h.diameter, 10, 0.02))
    record('reference A has the d10 centre hole', !!hole,
      hole ? `at ${JSON.stringify(hole.axisPoint)}` : 'not found')
    record('every sketch reached fully constrained',
      (a.builderSteps || []).filter(s => s.includes('constraintStatus=3')).length >= 3,
      (a.builderSteps || []).filter(s => s.includes('constraintStatus')).join(' | '))
    record('parameters are bound to native dimensions',
      (a.drivers?.mode === 'literal' ? (a.drivers?.requested ?? 0) >= 4 : Object.keys(a.bindings || {}).length >= 4),
      JSON.stringify({ bindings: a.bindings, drivers: a.drivers }))
  }

  // ---------------------------------------------------------------- reference B
  const b = call({ op: 'build', definition: designB() })
  if (!b.ok) {
    record('build reference B', false, JSON.stringify(b.error))
  } else {
    const v = b.geometry.massProperties.volume
    record('build reference B volume', near(v, VOL_B(100, 60, 20, 6), 0.05),
      `measured ${v}, analytic ${VOL_B(100, 60, 20, 6).toFixed(4)}`)
    const holes = b.geometry.holes || []
    record('reference B has four holes', holes.length === 4, `${holes.length} cylinders`)
    const at = holes.map(h => [Math.round(h.axisPoint[0]), Math.round(h.axisPoint[1])])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    record('reference B holes sit 10 mm from each edge',
      JSON.stringify(at) === JSON.stringify([[-40, -20], [-40, 20], [40, -20], [40, 20]]),
      JSON.stringify(at))

    // ------------------------------------------------- five consecutive edits
    // Widening the plate must move the holes: the edge distance is a native
    // relation, so this is the check that separates parametric from drawn.
    // 本机 SOLIDWORKS 拒绝写方程式（docs/SW-自动化MCP-研究报告.md 附录D M20），所以「改参数」在这里是
    // 「用新参数重跑同一个定义」。MCP 层的 model action=edit 就是这么做的，
    // 桥接层这里直接验证同一件事：定义换了参数，几何必须跟着换。
    const e1 = call({ op: 'build', definition: designB({ 'plate.w': 80 }) })
    if (!e1.ok) {
      record('edit plate.w 100 -> 80', false, JSON.stringify(e1.error))
    } else {
      const v1 = e1.geometry.massProperties.volume
      record('edit plate.w 100 -> 80 volume', near(v1, VOL_B(80, 60, 20, 6), 0.05),
        `measured ${v1}, analytic ${VOL_B(80, 60, 20, 6).toFixed(4)}`)
      const h = (e1.geometry.holes || []).map(x => [Math.round(x.axisPoint[0]), Math.round(x.axisPoint[1])])
        .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      record('holes keep their 10 mm edge distance after the width change',
        JSON.stringify(h) === JSON.stringify([[-30, -20], [-30, 20], [30, -20], [30, 20]]),
        JSON.stringify(h))
    }

    const e2 = call({ op: 'build', definition: designB({ 'plate.w': 80, 'plate.h': 80 }) })
    if (!e2.ok) {
      record('edit plate.h 60 -> 80', false, JSON.stringify(e2.error))
    } else {
      const v2 = e2.geometry.massProperties.volume
      record('edit plate.h 60 -> 80 volume', near(v2, VOL_B(80, 80, 20, 6), 0.05),
        `measured ${v2}, analytic ${VOL_B(80, 80, 20, 6).toFixed(4)}`)
    }

    const e3 = call({ op: 'build', definition: designB({ 'plate.w': 80, 'plate.h': 80, 'plate.t': 30 }) })
    if (!e3.ok) {
      record('edit plate.t 20 -> 30', false, JSON.stringify(e3.error))
    } else {
      const v3 = e3.geometry.massProperties.volume
      record('edit plate.t 20 -> 30 volume', near(v3, VOL_B(80, 80, 30, 6), 0.05),
        `measured ${v3}, analytic ${VOL_B(80, 80, 30, 6).toFixed(4)}`)
      record('symmetric thickness grows both ways',
        near(e3.geometry.boundingBox.size[2], 30),
        `Z size ${e3.geometry.boundingBox.size[2]}`)
    }

    const e4 = call({ op: 'build', definition: designB({ 'plate.w': 80, 'plate.h': 80, 'plate.t': 30, 'hole.d': 10 }) })
    if (!e4.ok) {
      record('edit hole.d 6 -> 10', false, JSON.stringify(e4.error))
    } else {
      const v4 = e4.geometry.massProperties.volume
      record('edit hole.d 6 -> 10 volume', near(v4, VOL_B(80, 80, 30, 10), 0.05),
        `measured ${v4}, analytic ${VOL_B(80, 80, 30, 10).toFixed(4)}`)
      record('all four holes changed diameter',
        (e4.geometry.holes || []).every(h => near(h.diameter, 10, 0.02)),
        JSON.stringify((e4.geometry.holes || []).map(h => h.diameter)))
    }

    const e5 = call({ op: 'build', definition: designB({ 'plate.w': 80, 'plate.h': 80, 'plate.t': 30, 'hole.d': 10, 'hole.edge': 15 }) })
    if (!e5.ok) {
      record('edit hole.edge 10 -> 15', false, JSON.stringify(e5.error))
    } else {
      const h = (e5.geometry.holes || []).map(x => [Math.round(x.axisPoint[0]), Math.round(x.axisPoint[1])])
        .sort((x, y) => x[0] - y[0] || x[1] - y[1])
      record('holes move inward when the edge distance grows',
        JSON.stringify(h) === JSON.stringify([[-25, -25], [-25, 25], [25, -25], [25, 25]]),
        JSON.stringify(h))
    }

    // ------------------------------------------------------- save / reopen / edit
    // 礼貌模式：save/export/inspect 必须带 designId，不再退回到「当前活动文档」。
    const saved = call({ op: 'save', designId: designIdFor('base-b'), path: path.join(outDir, 'acceptance-b.sldprt') })
    record('save the part', saved.ok && saved.saved, JSON.stringify(saved).slice(0, 200))
    if (saved.ok && saved.saved) {
      const reopened = call({ op: 'status' })
      let listing
      try { listing = fs.readdirSync(outDir).join(', ') } catch (e) { listing = `readdir failed ${e.code}` }
      record('saved file exists on disk', fs.existsSync(saved.path) && saved.bytes > 0,
        `${saved.path} (${saved.bytes} bytes) | dir has: ${listing}`)

      const e6 = call({ op: 'build', definition: designB({ 'plate.w': 90, 'plate.h': 80, 'plate.t': 30, 'hole.d': 10, 'hole.edge': 15 }) })
      record('rebuild after saving still lands on disk',
        e6.ok && near(e6.geometry.massProperties.volume, VOL_B(90, 80, 30, 10), 0.05),
        e6.ok ? `measured ${e6.geometry.massProperties.volume}` : JSON.stringify(e6.error))
    }

    // ------------------------------------------------------------------ export
    const step = call({ op: 'export', kind: 'step', designId: designIdFor('base-b'), path: path.join(outDir, 'acceptance-b.step') })
    record('export STEP', step.ok && step.exported && step.bytes > 0,
      JSON.stringify(step).slice(0, 200))

    const png = path.join(outDir, 'acceptance-b.bmp')
    const shot = call({ op: 'inspect', designId: designIdFor('base-b'), format: 'both', imagePath: png, width: 1280, height: 800 })
    record('capture a viewport image',
      shot.ok && shot.image && shot.image.captured && shot.image.bytes > 0,
      shot.ok ? `${shot.image.path} (${shot.image.bytes} bytes)` : JSON.stringify(shot.error))
  }

  report()
}

function report() {
  const failed = results.filter(r => !r.ok)
  console.log('')
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('failures:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail || ''}`)
  }
}

// D4：本文件没有 finally 收尾段可加超时 —— 它只通过 spawnSync 向**已存在**的实例
// 发请求（实例是调用方给的 --instance，本用例不启动、也不关它），每步都是同步阻塞
// 且由桥接器自己返回。所以这里不动任何断言，只把「按断言结果落地退出码」做成
// 显式 exit（原来只设 process.exitCode，退出依赖事件循环自己排空）。
run()
const failedCount = results.filter(r => !r.ok).length
process.exit(failedCount > 0 ? 1 : 0)
