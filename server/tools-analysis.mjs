// 「analysis」工具：把常驻 Python worker 的 STEP/图像分析接进 MCP。
//
// 与建模工具分开登记：它不需要 SOLIDWORKS，也不改模型，只读文件。
// 输出保守（默认截断边数/面数），避免把整棵 B-rep 塞回模型上下文。
//
// action="mesh" 是唯一例外：三角网格本身可能几十万个点，所以默认不内联几何，
// 而是写成 <DATA_DIR>\preview\<basename>-<hash>.s3dm 二进制，只回路径与计数；
// 预览端（宿主插件）直接按绝对路径读文件，MCP 上下文里只有几百字节。
import { existsSync } from 'node:fs'
import { openAnalysis, AnalysisUnavailable } from './analysis/client.mjs'
import { writeS3dm } from './analysis/s3dm.mjs'
import { previewPathFor } from './analysis/preview.mjs'

const IDLE_MS = 5 * 60 * 1000
// 大模型三角化比其它 op 慢得多（SOLIDWORKS 不在回路里，但 OCCT 要跑网格）。
const MESH_TIMEOUT_MS = 180_000
const INLINE_LIMIT = 200

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

import { DESCRIPTIONS } from './tool-face.mjs'

export function registerAnalysisTools(server, z, deps) {
  const { envelope, ok, fail } = deps
  let worker = null
  let idleTimer = null

  function touch() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      worker?.close()
      worker = null
      idleTimer = null
    }, IDLE_MS)
    idleTimer.unref?.()
  }

  async function ensureWorker() {
    if (worker === null) worker = await openAnalysis()
    touch()
    return worker
  }

  function analysisFailed(error) {
    return ok(envelope({
      summary: `分析没跑成：${error?.message ?? error}`,
      status: 'failed',
      extra: { error: { code: error?.code ?? 'ANALYSIS_FAILED', message: error?.message ?? String(error), detail: error?.detail } },
      nextActions: error?.code === 'ANALYSIS_UNAVAILABLE'
        ? ['先建分析环境：python -m venv .venv && .venv/Scripts/pip install cadquery-ocp']
        : ['确认文件存在、是有效的 STEP/PNG；必要时重试一次'],
    }))
  }

  function requirePath(args) {
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw fail('BAD_ARGUMENT', '需要 path（STEP 或图片文件的绝对路径）')
    }
    if (!existsSync(args.path)) throw fail('FILE_NOT_FOUND', `文件不存在：${args.path}`)
    return args.path
  }

  function trim(polyline, maxPoints) {
    if (!Array.isArray(polyline?.points) || polyline.points.length <= maxPoints) return polyline
    return { ...polyline, points: polyline.points.slice(0, maxPoints), truncated: true }
  }

  server.registerTool(
    'analysis',
    {
      title: '几何与图像分析',
      description: DESCRIPTIONS.analysis,
      inputSchema: z.object({
        action: z.enum(['step', 'faces', 'mesh', 'hlr', 'section', 'diff', 'image', 'health']).default('step')
          .describe('要做什么：step / faces / mesh / hlr / section / diff / image / health'),
        path: z.string().optional().describe('要分析的文件路径；health 可省略'),
        comparePath: z.string().optional().describe('diff：第二份 STEP 的路径（path 作基准/预期）'),
        volumeToleranceMm3: z.number().min(0).optional().describe('diff：体积容差，默认 max(1, |V|*1e-4)'),
        lengthToleranceMm: z.number().min(0).default(0.01).describe('diff：包围盒容差，单位 mm'),
        viewDir: z.array(z.number()).length(3).optional().describe('hlr：视线方向，默认 [0,0,1]'),
        upDir: z.array(z.number()).length(3).optional().describe('hlr：视图上方方向，默认 [0,1,0]'),
        origin: z.array(z.number()).length(3).optional().describe('hlr/section：投影或剖切平面的原点，默认 [0,0,0]'),
        normal: z.array(z.number()).length(3).optional().describe('section：剖切平面法向，默认 [0,0,1]'),
        hidden: z.boolean().default(true).describe('hlr：是否返回隐藏边'),
        maxFaces: z.number().int().min(1).max(2000).default(200).describe('faces：最多返回多少张面'),
        maxEdges: z.number().int().min(1).max(20000).optional().describe('hlr：最多返回多少条边（默认 200）；mesh：最多输出多少条边（默认 4000）'),
        maxPoints: z.number().int().min(2).max(512).default(64).describe('每条折线最多保留多少个点'),
        threshold: z.number().int().min(0).max(255).default(128).describe('image：灰度阈值，低于它的算墨迹'),
        deflectionMm: z.number().min(0.001).max(50).default(0.2).describe('mesh：线性挠度（mm），越小三角形越多；超上限时自动加大重试一次'),
        angularDeflection: z.number().min(0.01).max(1.5).default(0.5).describe('mesh：角度挠度（弧度）'),
        maxTriangles: z.number().int().min(100).max(1000000).default(200000).describe('mesh：三角形上限，超了就截断并置 truncated.triangles'),
        maxEdgePoints: z.number().int().min(100).max(400000).default(200000).describe('mesh：边折线总点数上限，超了降采样并置 truncated.edges'),
        tolerance: z.number().min(0).default(0).describe('mesh：三角形面积下限（mm²），小于它的退化三角形丢弃；0 不过滤'),
        inline: z.boolean().default(false).describe('mesh：true 时把前 200 个三角形/边内联返回（仅调试，几何被截断）'),
      }),
    },
    async (args) => {
      try {
        const workerRef = await ensureWorker()
        if (args.action === 'health') {
          const health = await workerRef.health()
          return ok(envelope({
            summary: health.ocp ? `分析 worker 可用（Python ${health.python}，OCP + Pillow）` : `分析 worker 缺少 OCP：${health.ocpError}`,
            status: health.ocp ? 'ok' : 'failed',
            extra: { health },
          }))
        }
        const path = requirePath(args)
        if (args.action === 'step') {
          const info = await workerRef.request('step.info', { path })
          return ok(envelope({
            summary: `STEP：体积 ${info.volumeMm3} mm³，${info.faces} 张面、${info.edges} 条边`,
            measurements: info,
            changes: { source: path },
          }))
        }
        if (args.action === 'diff') {
          if (typeof args.comparePath !== 'string' || args.comparePath.length === 0) {
            throw fail('BAD_ARGUMENT', 'diff 需要 comparePath（第二份 STEP 的绝对路径）')
          }
          if (!existsSync(args.comparePath)) throw fail('FILE_NOT_FOUND', `文件不存在：${args.comparePath}`)
          const diff = await workerRef.request('step.diff', {
            a: path,
            b: args.comparePath,
            volumeToleranceMm3: args.volumeToleranceMm3,
            lengthToleranceMm: args.lengthToleranceMm,
          })
          const regions = diff.items.map((item) => item.region).join('、')
          return ok(envelope({
            summary: diff.equal
              ? '两份 STEP 在体积/包围盒/面边数上没有超差'
              : `两份 STEP 有 ${diff.items.length} 处差异：${regions}`,
            status: diff.equal ? 'ok' : 'diff',
            measurements: { equal: diff.equal, items: diff.items.length, a: diff.a, b: diff.b },
            changes: { ...diff, source: path, comparePath: args.comparePath },
            nextActions: diff.items.map((item) => item.nextObservation).filter((text, index, all) => all.indexOf(text) === index).slice(0, 4),
          }))
        }
        if (args.action === 'image') {
          const image = await workerRef.request('image.analyze', { path, threshold: args.threshold })
          return ok(envelope({
            summary: `图片 ${image.size?.[0]}×${image.size?.[1]}：墨迹像素 ${image.darkPixels}，覆盖率 ${image.coverage}`,
            measurements: image,
            changes: { source: path },
          }))
        }
        if (args.action === 'faces') {
          const faces = await workerRef.request('step.faces', { path, maxFaces: args.maxFaces })
          const types = faces.faces.reduce((acc, face) => { acc[face.surfaceType] = (acc[face.surfaceType] ?? 0) + 1; return acc }, {})
          return ok(envelope({
            summary: `STEP 面清点：${faces.faces.length} 张面（${Object.entries(types).map(([kind, count]) => `${kind} ${count}`).join('，')}）`,
            measurements: { faces: faces.faces.length, types },
            changes: { faces: faces.faces, truncated: faces.truncated, source: path },
          }))
        }
        if (args.action === 'mesh') {
          const startedAt = Date.now()
          const mesh = await workerRef.request('step.mesh', {
            path,
            deflectionMm: args.deflectionMm,
            angularDeflection: args.angularDeflection,
            maxTriangles: args.maxTriangles,
            maxEdges: args.maxEdges,
            maxEdgePoints: args.maxEdgePoints,
            tolerance: args.tolerance,
          }, { timeout: MESH_TIMEOUT_MS })
          // 默认落盘：预览端按绝对路径读，MCP 上下文里只有计数与路径。
          const previewPath = previewPathFor(path, {
            deflectionMm: args.deflectionMm,
            angularDeflection: args.angularDeflection,
            maxTriangles: args.maxTriangles,
            maxEdges: args.maxEdges,
            tolerance: args.tolerance,
          })
          let written
          try {
            written = writeS3dm(previewPath, mesh)
          } catch (error) {
            throw fail('ANALYSIS_FAILED', `网格已算出，但写预览文件失败：${error.message}`, { previewPath })
          }
          const counts = {
            faces: mesh.faceCount, edges: mesh.edgeCount,
            vertices: mesh.vertexCount, triangles: mesh.triangleCount,
          }
          const result = {
            ok: true,
            path: written.path,
            previewPath: written.path,
            sourcePath: path,
            format: 's3dm',
            units: mesh.units,
            bytes: written.bytes,
            counts,
            bbox: mesh.bbox,
            faceCount: mesh.faceCount,
            edgeCount: mesh.edgeCount,
            triangleCount: mesh.triangleCount,
            vertexCount: mesh.vertexCount,
            normalsMode: mesh.normalsMode,
            deflections: mesh.deflections,
            truncated: mesh.truncated,
            elapsedMs: Date.now() - startedAt,
          }
          if (args.inline) {
            result.inline = {
              note: 'inline=true 仅供调试：只给前 200 个面/三角形/边，几何被截断；预览请读 previewPath 的 s3dm 文件',
              truncated: mesh.faces.length > INLINE_LIMIT || mesh.triangles.length > INLINE_LIMIT || mesh.edges.length > INLINE_LIMIT,
              faces: mesh.faces.slice(0, INLINE_LIMIT),
              triangles: mesh.triangles.slice(0, INLINE_LIMIT),
              edges: mesh.edges.slice(0, INLINE_LIMIT),
              inlineFaces: Math.min(INLINE_LIMIT, mesh.faces.length),
              inlineTriangles: Math.min(INLINE_LIMIT, mesh.triangles.length),
              inlineEdges: Math.min(INLINE_LIMIT, mesh.edges.length),
            }
          }
          return ok(envelope({
            summary: `网格：${mesh.faceCount} 面 / ${mesh.edgeCount} 边 / ${mesh.triangleCount} 三角形`
              + `（挠度 ${mesh.deflections?.linearMm} mm）→ ${formatBytes(written.bytes)} 的 s3dm`,
            status: 'ok',
            measurements: { ...counts, bytes: written.bytes, elapsedMs: result.elapsedMs },
            changes: result,
            artifacts: [{ kind: 'mesh', path: written.path, bytes: written.bytes }],
            nextActions: [
              '3D 预览端直接读 changes.previewPath 指向的绝对路径；字节布局见 server/analysis/s3dm.mjs 顶部注释',
            ],
          }))
        }
        if (args.action === 'hlr') {
          const edgeLimit = args.maxEdges ?? 200
          const hlr = await workerRef.request('step.hlr', {
            path, viewDir: args.viewDir, upDir: args.upDir, origin: args.origin, hidden: args.hidden,
          })
          const visible = hlr.visible.slice(0, edgeLimit).map((edge) => trim(edge, args.maxPoints))
          const outline = hlr.outline.slice(0, edgeLimit).map((edge) => trim(edge, args.maxPoints))
          const hidden = hlr.hidden.slice(0, edgeLimit).map((edge) => trim(edge, args.maxPoints))
          return ok(envelope({
            summary: `消隐投影：可见边 ${hlr.visibleEdges} 条，隐藏边 ${hlr.hiddenEdges} 条`,
            measurements: { visibleEdges: hlr.visibleEdges, hiddenEdges: hlr.hiddenEdges },
            changes: {
              viewDir: hlr.viewDir, upDir: hlr.upDir,
              visible, outline, hidden,
              truncatedEdges: hlr.visible.length > edgeLimit || hlr.hidden.length > edgeLimit,
              source: path,
            },
          }))
        }
        if (args.action === 'section') {
          const section = await workerRef.request('step.section', { path, origin: args.origin, normal: args.normal })
          const loops = section.loops.slice(0, args.maxEdges ?? 200).map((loop) => trim(loop, args.maxPoints))
          return ok(envelope({
            summary: `剖面：${section.loops.length} 个环，总长 ${section.totalLength} mm，面积 ${section.areaMm2} mm²`,
            measurements: { loops: section.loops.length, totalLength: section.totalLength, areaMm2: section.areaMm2 },
            changes: { ...section, loops, source: path },
          }))
        }
        throw fail('UNKNOWN_ACTION', `不认识的 action：${args.action}`)
      } catch (error) {
        return analysisFailed(error)
      }
    },
  )
}

export { AnalysisUnavailable }
