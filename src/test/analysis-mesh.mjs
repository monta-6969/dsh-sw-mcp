// 离线三角化 + 边线框：worker step.mesh、s3dm 二进制往返、analysis action="mesh" 的落盘约定。
//
// 全程不碰 SOLIDWORKS：只用 .venv 里的 OCP 读本地 STEP。没有 .venv / OCP / 样例 STEP
// 时跳过（打包不含 .venv），不阻塞无 SW 的套件。样例用桌面上的锁盖.STEP：
// 42 面 / 113 条唯一边 / 840 三角形 / bbox 30×58×5 mm，量级固定，适合断言。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAnalysis } from '../server/analysis/client.mjs'
import { readS3dm, S3DM_MAGIC, s3dmLayout, writeS3dm } from '../server/analysis/s3dm.mjs'
import { openSession } from './lib/mcp.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const SAMPLE_STEP = 'C:\\Users\\mota\\Desktop\\工程自动化\\锁盖.STEP'

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

if (!existsSync(join(repoRoot, '.venv', 'Scripts', 'python.exe'))) {
  console.log('SKIP  analysis-mesh: no .venv (run: python -m venv .venv && .venv/Scripts/pip install cadquery-ocp)')
  process.exit(0)
}
if (!existsSync(SAMPLE_STEP)) {
  console.log(`SKIP  analysis-mesh: missing ${SAMPLE_STEP}（样例 STEP 不在本机，跳过三角化断言）`)
  process.exit(0)
}

const fround = (value) => Math.fround(value)
const equalPointlist = (left, right) => left.length === right.length
  && left.every((point, index) => point.length === right[index].length
    && point.every((value, axis) => right[index][axis] === fround(value)))

const scratch = mkdtempSync(join(tmpdir(), 'sw-mcp-mesh-test-'))
const worker = await openAnalysis()
try {
  const health = await worker.health()
  if (!health.ocp) {
    console.log(`SKIP  analysis-mesh: OCP not installed in .venv（${health.ocpError ?? 'ocp=false'}）`)
    process.exit(0)
  }

  // ------------------------------------------------------------------ step.mesh
  const startedAt = Date.now()
  const mesh = await worker.request('step.mesh', { path: SAMPLE_STEP })
  const elapsedMs = Date.now() - startedAt
  console.log(`      step.mesh 用时 ${elapsedMs} ms`)

  check('mesh 单位是 mm', mesh.units === 'mm' && mesh.format === 'step', { units: mesh.units, format: mesh.format })
  check('mesh 三角形数 > 100', mesh.triangleCount > 100 && mesh.triangles.length === mesh.triangleCount,
    { triangleCount: mesh.triangleCount })
  check('mesh 面数 > 20', mesh.faceCount > 20 && mesh.faces.length === mesh.faceCount, { faceCount: mesh.faceCount })
  check('mesh 边数 > 50', mesh.edgeCount > 50 && mesh.edges.length === mesh.edgeCount, { edgeCount: mesh.edgeCount })
  check('mesh 顶点/法向等长', mesh.vertices.length === mesh.vertexCount
    && mesh.normals.length === mesh.vertices.length, {
    vertices: mesh.vertices.length, normals: mesh.normals.length, vertexCount: mesh.vertexCount,
  })
  check('mesh 法向已注明模式', typeof mesh.normalsMode === 'string', mesh.normalsMode)

  // bbox 是 6 个数，单位 mm。锁盖 30×58×5：最薄方向只有 5 mm，所以按「全部 ≤120 且
  // 至少两轴 ≥20」判量级，硬套「三轴都 20..120」会把这份正确数据判错。
  const bbox = mesh.bbox
  const sizes = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
  check('bbox 是 6 个数', Array.isArray(bbox) && bbox.length === 6 && bbox.every((value) => Number.isFinite(value)), bbox)
  check('bbox 量级像 30×58×5 mm', sizes.every((size) => size > 0 && size <= 120)
    && sizes.filter((size) => size >= 20).length >= 2, sizes.map((size) => Number(size.toFixed(3))))

  check('每个三角形都能追溯回面', mesh.triangles.every((triangle) => triangle.length === 4
    && Number.isInteger(triangle[3]) && triangle[3] >= 0 && triangle[3] < mesh.faceCount), {
    sample: mesh.triangles.slice(0, 3), faceCount: mesh.faceCount,
  })
  check('三角形下标都在顶点表内', mesh.triangles.every((triangle) => [0, 1, 2]
    .every((slot) => Number.isInteger(triangle[slot]) && triangle[slot] >= 0 && triangle[slot] < mesh.vertices.length)))
  check('每条边至少 2 点折线', mesh.edges.every((edge) => Array.isArray(edge.polyline) && edge.polyline.length >= 2),
    { shortest: Math.min(...mesh.edges.map((edge) => edge.polyline.length)) })
  check('圆弧边采样够密（≥8 段）', mesh.edges.filter((edge) => edge.isCircle).length > 0
    && mesh.edges.filter((edge) => edge.isCircle).every((edge) => edge.polyline.length >= 8), {
    circles: mesh.edges.filter((edge) => edge.isCircle).length,
    minCirclePoints: Math.min(...mesh.edges.filter((edge) => edge.isCircle).map((edge) => edge.polyline.length)),
  })
  check('每条边都带相邻面', mesh.edges.every((edge) => Array.isArray(edge.faces)
    && edge.faces.length >= 1 && edge.faces.every((index) => index >= 0 && index < mesh.faceCount)),
  { withFaces: mesh.edges.filter((edge) => edge.faces.length > 0).length })
  check('边有长度/端点/中点', mesh.edges.every((edge) => edge.lengthMm > 0
    && edge.startMm.length === 3 && edge.endMm.length === 3 && edge.midMm.length === 3))
  check('面有类型与面积', mesh.faces.every((face) => typeof face.kind === 'string' && face.areaMm2 >= 0
    && face.normal.length === 3 && face.point.length === 3), { kinds: [...new Set(mesh.faces.map((face) => face.kind))] })
  check('默认不截断', mesh.truncated.triangles === false && mesh.truncated.edges === false, mesh.truncated)

  // ------------------------------------------------------------------ s3dm 往返
  const meshPath = join(scratch, 'lid-mesh.s3dm')
  const written = writeS3dm(meshPath, mesh)
  const back = readS3dm(meshPath)
  check('s3dm 文件头是魔数', readFileSync(meshPath).toString('ascii', 0, 4) === S3DM_MAGIC, {
    magic: S3DM_MAGIC, bytes: written.bytes, layout: s3dmLayout().arrays.map((array) => array.name),
  })
  check('s3dm 顶点往返一致', equalPointlist(mesh.vertices, back.mesh.vertices),
    { vertices: mesh.vertices.length })
  check('s3dm 法向往返一致', equalPointlist(mesh.normals, back.mesh.normals), { normals: mesh.normals.length })
  check('s3dm 三角形往返一致', back.mesh.triangles.length === mesh.triangles.length
    && back.mesh.triangles.every((triangle, index) => triangle.every((value, slot) => value === mesh.triangles[index][slot])),
  { triangles: back.mesh.triangles.length })
  check('s3dm 边折线往返一致', back.mesh.edges.length === mesh.edges.length
    && back.mesh.edges.every((edge, index) => edge.isCircle === mesh.edges[index].isCircle
      && edge.faces.join(',') === mesh.edges[index].faces.join(',')
      && equalPointlist(mesh.edges[index].polyline, edge.polyline)), { edges: back.mesh.edges.length })
  check('s3dm 面元数据往返一致', JSON.stringify(back.mesh.faces) === JSON.stringify(mesh.faces))
  const secondPath = join(scratch, 'lid-mesh-2.s3dm')
  writeS3dm(secondPath, back.mesh)
  check('s3dm 写→读→再写字节完全相同',
    readFileSync(meshPath).equals(readFileSync(secondPath)),
    { first: readFileSync(meshPath).length, second: readFileSync(secondPath).length })

  // ------------------------------------------------------------------ tool 层
  const dataDir = join(scratch, 'data')
  const session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
  try {
    await session.start()
    const result = await session.tool('analysis', { action: 'mesh', path: SAMPLE_STEP })
    const text = JSON.stringify(result)
    check('analysis mesh 返回 ok', result.status === 'ok' && result.changes?.ok === true, result.summary)
    check('analysis mesh 报面/边/三角形数', result.changes?.faceCount > 20 && result.changes?.edgeCount > 50
      && result.changes?.triangleCount > 100 && result.changes?.counts?.triangles === result.changes.triangleCount,
    result.changes?.counts)
    check('analysis mesh 有 previewPath 且文件存在', typeof result.changes?.previewPath === 'string'
      && existsSync(result.changes.previewPath) && result.changes.path === result.changes.previewPath,
    { previewPath: result.changes?.previewPath, bytes: result.changes?.bytes })
    check('previewPath 落在 SW_MCP_DATA/preview 下',
      result.changes?.previewPath.startsWith(join(dataDir, 'preview')), result.changes?.previewPath)
    check('previewPath 是可直读的 s3dm 文件',
      readFileSync(result.changes.previewPath).toString('ascii', 0, 4) === S3DM_MAGIC,
      { bytes: result.changes?.bytes })
    check('默认不内联几何（返回体 < 8 KB）', text.length < 8192
      && result.changes?.inline === undefined && result.changes?.vertices === undefined
      && result.changes?.triangles === undefined && result.changes?.edges === undefined,
    { responseBytes: text.length })

    const inlined = await session.tool('analysis', { action: 'mesh', path: SAMPLE_STEP, inline: true, maxTriangles: 400 })
    check('inline=true 只给前 200 个三角形/边', inlined.changes?.inline?.triangles?.length === 200
      && inlined.changes?.inline?.edges?.length <= 200
      && inlined.changes?.inline?.triangles.length <= 200
      && inlined.changes?.inline?.truncated === true, {
      triangles: inlined.changes?.inline?.triangles?.length,
      edges: inlined.changes?.inline?.edges?.length,
    })

    // 现有 action 不能被改动带偏（面数/边数仍是 explorer 口径 42/226）。
    const info = await session.tool('analysis', { action: 'step', path: SAMPLE_STEP })
    check('action=step 行为未变', info.measurements?.faces === 42 && info.measurements?.edges === 226, info.summary)
  } finally {
    session.close()
  }

  // ------------------------------------------------------------------ 失败路径
  let meshError = null
  try {
    await worker.request('step.mesh', { path: join(scratch, 'not-a-file.step') })
  } catch (error) {
    meshError = error
  }
  check('缺文件时返回结构化错误而不是崩溃', meshError?.code === 'ANALYSIS_FAILED'
    && typeof meshError.message === 'string', { code: meshError?.code, message: meshError?.message })
  const alive = await worker.health()
  check('失败后 worker 仍可用', alive.ok === true && alive.ocp === true)
} finally {
  worker.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
