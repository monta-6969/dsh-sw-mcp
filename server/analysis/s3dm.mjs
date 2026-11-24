// s3dm：sw-mcp 三角网格的二进制交换格式（3D 预览端直接读，不进 MCP 上下文）。
//
// 字节布局（全部小端；Windows/Linux x64 原生 LE，不做转序）：
//
//   offset  size            内容
//   ------  --------------  --------------------------------------------------
//   0       4              魔数 ASCII "S3DM"
//   4       4               uint32  headerLength = JSON 头字节数 N
//   8       N               JSON 头（UTF-8，不补零、不加密）
//   8+N     ...             数据区（六个定长数组，紧挨着排，顺序见下）
//
//   数据区（偏移都相对数据区起点；数组元素都是 4 字节，天然 4 字节对齐）：
//     1. positions     f32  × vertexCount*3      每个顶点 xyz
//     2. normals       f32  × vertexCount*3      与 positions 一一对应
//     3. indices       u32  × triangleCount*3    三角形三个顶点下标
//     4. faceIndex     u32  × triangleCount      该三角形所属 B-rep 面（faces[] 下标）
//     5. edgeSegments  f32  × edgePointCount*3   所有边折线点按边依次拼接的 xyz
//     6. edgeIndex     u32  × (edgeCount+1)      第 i 条边折线在 edgeSegments 里的起点
//                                                （单位是“点”，最后一个是总点数）
//
// JSON 头（version 1）：
//   {
//     format: "s3dm", version: 1, units: "mm", normalsMode: "face",
//     sourcePath: "C:\\...\\锁盖.STEP",
//     bbox: [minx,miny,minz,maxx,maxy,maxz],
//     counts: { vertices, triangles, faces, edges, edgePoints },
//     deflections: { linearMm, angularRad, retried? },
//     truncated: { triangles, edges },
//     faces: [ { index, kind, areaMm2, normal, point, radiusMm? }, ... ],
//     edges: [ { index, id, isCircle, radiusMm?, lengthMm, startMm, endMm, midMm,
//                faces:[i,j], pointCount }, ... ],
//     arrays: [ { name, type, count, dataOffset }, ... ]   // dataOffset 相对数据区
//   }
//
// 读取端只需认魔数 + version，再按 arrays[] 的 name/type/count/dataOffset 取数，
// 这样以后追加数组（例如每个面的独立缓冲）不需要提升 version。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const S3DM_MAGIC = 'S3DM'
export const S3DM_VERSION = 1

const ARRAY_LAYOUT = [
  { name: 'positions', type: 'f32', countKey: 'vertexCount', stride: 3 },
  { name: 'normals', type: 'f32', countKey: 'vertexCount', stride: 3 },
  { name: 'indices', type: 'u32', countKey: 'triangleCount', stride: 3 },
  { name: 'faceIndex', type: 'u32', countKey: 'triangleCount', stride: 1 },
  { name: 'edgeSegments', type: 'f32', countKey: 'edgePointCount', stride: 3 },
  { name: 'edgeIndex', type: 'u32', countKey: 'edgeCountPlusOne', stride: 1 },
]

function badFormat(message, detail) {
  const error = new Error(`s3dm: ${message}`)
  error.code = 'S3DM_BAD_FORMAT'
  if (detail !== undefined) error.detail = detail
  return error
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0
}

/** 把 worker 的 step.mesh 结果摊平成定长数组（纯函数，不碰磁盘）。 */
export function flattenMesh(mesh) {
  const vertices = Array.isArray(mesh?.vertices) ? mesh.vertices : []
  const triangles = Array.isArray(mesh?.triangles) ? mesh.triangles : []
  const edges = Array.isArray(mesh?.edges) ? mesh.edges : []
  const vertexCount = vertices.length
  const triangleCount = triangles.length
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(triangleCount * 3)
  const faceIndex = new Uint32Array(triangleCount)
  for (let index = 0; index < vertexCount; index += 1) {
    const point = vertices[index] ?? []
    positions[index * 3] = finiteOrZero(point[0])
    positions[index * 3 + 1] = finiteOrZero(point[1])
    positions[index * 3 + 2] = finiteOrZero(point[2])
    const normal = mesh?.normals?.[index] ?? []
    normals[index * 3] = finiteOrZero(normal[0])
    normals[index * 3 + 1] = finiteOrZero(normal[1])
    normals[index * 3 + 2] = finiteOrZero(normal[2])
  }
  for (let index = 0; index < triangleCount; index += 1) {
    const triangle = triangles[index] ?? []
    // 越界就是坏数据：写进去只会让预览端崩，这里直接钳到 0 并留痕（保证可读）。
    const clamp = (value) => {
      const asNumber = Number(value)
      return Number.isInteger(asNumber) && asNumber >= 0 && asNumber < vertexCount ? asNumber : 0
    }
    indices[index * 3] = clamp(triangle[0])
    indices[index * 3 + 1] = clamp(triangle[1])
    indices[index * 3 + 2] = clamp(triangle[2])
    const face = Number(triangle[3])
    faceIndex[index] = Number.isInteger(face) && face >= 0 ? face : 0
  }
  const edgePoints = []
  const edgeIndex = new Uint32Array(edges.length + 1)
  for (let edgeAt = 0; edgeAt < edges.length; edgeAt += 1) {
    edgeIndex[edgeAt] = edgePoints.length / 3
    for (const point of edges[edgeAt]?.polyline ?? []) {
      edgePoints.push(finiteOrZero(point?.[0]), finiteOrZero(point?.[1]), finiteOrZero(point?.[2]))
    }
  }
  edgeIndex[edges.length] = edgePoints.length / 3
  return {
    positions,
    normals,
    indices,
    faceIndex,
    edgeSegments: new Float32Array(edgePoints),
    edgeIndex,
    counts: {
      vertexCount,
      triangleCount,
      edgePointCount: edgePoints.length / 3,
      edgeCountPlusOne: edges.length + 1,
      faces: Array.isArray(mesh?.faces) ? mesh.faces.length : 0,
      edges: edges.length,
    },
  }
}

function typedArrayToBuffer(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

/** mesh（worker step.mesh 的结果）→ s3dm 字节（纯函数，可在内存里校验）。 */
export function buildS3dm(mesh) {
  const flat = flattenMesh(mesh)
  const arrays = []
  let dataOffset = 0
  for (const layout of ARRAY_LAYOUT) {
    const elementCount = flat[layout.name].length
    arrays.push({
      name: layout.name,
      type: layout.type,
      count: elementCount,
      dataOffset,
      shape: layout.stride > 1 ? [Math.floor(elementCount / layout.stride), layout.stride] : [elementCount],
    })
    dataOffset += elementCount * 4
  }
  const edges = Array.isArray(mesh?.edges) ? mesh.edges : []
  const header = {
    format: 's3dm',
    version: S3DM_VERSION,
    units: mesh?.units ?? 'mm',
    normalsMode: mesh?.normalsMode ?? 'face',
    sourcePath: mesh?.path ?? null,
    bbox: Array.isArray(mesh?.bbox) ? mesh.bbox : null,
    counts: {
      vertices: flat.counts.vertexCount,
      triangles: flat.counts.triangleCount,
      faces: flat.counts.faces,
      edges: flat.counts.edges,
      edgePoints: flat.counts.edgePointCount,
    },
    faceCount: flat.counts.faces,
    edgeCount: flat.counts.edges,
    triangleCount: flat.counts.triangleCount,
    vertexCount: flat.counts.vertexCount,
    deflections: mesh?.deflections ?? null,
    truncated: mesh?.truncated ?? { triangles: false, edges: false },
    faces: Array.isArray(mesh?.faces) ? mesh.faces : [],
    // 折线本体在 edgeSegments 里，头里只放每条边的元数据（pointCount 用于校验）。
    // start/end/mid 与 f32 折线端点对齐（同一套量化），预览端可以直接互相校验。
    edges: edges.map((edge) => {
      const { polyline, ...meta } = edge ?? {}
      const quantize = (point) => (Array.isArray(point) ? point.map((value) => Math.fround(Number(value) || 0)) : point)
      return {
        ...meta,
        startMm: quantize(meta.startMm),
        endMm: quantize(meta.endMm),
        midMm: quantize(meta.midMm),
        pointCount: Array.isArray(polyline) ? polyline.length : 0,
      }
    }),
    arrays,
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const out = Buffer.alloc(8 + headerBytes.length + dataOffset)
  out.write(S3DM_MAGIC, 0, 'ascii')
  out.writeUInt32LE(headerBytes.length, 4)
  headerBytes.copy(out, 8)
  const dataStart = 8 + headerBytes.length
  for (const entry of arrays) {
    const source = typedArrayToBuffer(flat[entry.name])
    source.copy(out, dataStart + entry.dataOffset)
  }
  return out
}

function readTyped(buffer, byteOffset, type, count) {
  const byteLength = count * 4
  if (byteOffset < 0 || byteOffset + byteLength > buffer.length) {
    throw badFormat('数组越界', { byteOffset, byteLength, size: buffer.length })
  }
  // 复制到独立 ArrayBuffer：Buffer 池的 byteOffset 不保证 4 字节对齐。
  const copy = new ArrayBuffer(byteLength)
  new Uint8Array(copy).set(buffer.subarray(byteOffset, byteOffset + byteLength))
  return type === 'f32' ? new Float32Array(copy) : new Uint32Array(copy)
}

/** s3dm 字节 → { header, mesh }（纯函数）。 */
export function parseS3dm(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length < 8) throw badFormat('文件太短', { size: bytes.length })
  if (bytes.toString('ascii', 0, 4) !== S3DM_MAGIC) {
    throw badFormat('魔数不对', { expected: S3DM_MAGIC, got: bytes.toString('ascii', 0, 4) })
  }
  const headerLength = bytes.readUInt32LE(4)
  if (8 + headerLength > bytes.length) {
    throw badFormat('JSON 头长度越界', { headerLength, size: bytes.length })
  }
  let header
  try {
    header = JSON.parse(bytes.toString('utf8', 8, 8 + headerLength))
  } catch (error) {
    throw badFormat('JSON 头解析失败', { message: error.message })
  }
  if (header?.version !== S3DM_VERSION) {
    throw badFormat(`版本不支持：${header?.version}（本端只认 ${S3DM_VERSION}）`)
  }
  const dataStart = 8 + headerLength
  const arrays = Array.isArray(header.arrays) ? header.arrays : []
  const find = (name) => arrays.find((entry) => entry.name === name)
  const positionsEntry = find('positions')
  const normalsEntry = find('normals')
  const indicesEntry = find('indices')
  const faceIndexEntry = find('faceIndex')
  const edgeSegmentsEntry = find('edgeSegments')
  const edgeIndexEntry = find('edgeIndex')
  for (const [name, entry] of [['positions', positionsEntry], ['normals', normalsEntry],
    ['indices', indicesEntry], ['faceIndex', faceIndexEntry],
    ['edgeSegments', edgeSegmentsEntry], ['edgeIndex', edgeIndexEntry]]) {
    if (!entry) throw badFormat(`缺数组：${name}`)
  }
  const positions = readTyped(bytes, dataStart + positionsEntry.dataOffset, 'f32', positionsEntry.count)
  const normals = readTyped(bytes, dataStart + normalsEntry.dataOffset, 'f32', normalsEntry.count)
  const indices = readTyped(bytes, dataStart + indicesEntry.dataOffset, 'u32', indicesEntry.count)
  const faceIndex = readTyped(bytes, dataStart + faceIndexEntry.dataOffset, 'u32', faceIndexEntry.count)
  const edgeSegments = readTyped(bytes, dataStart + edgeSegmentsEntry.dataOffset, 'f32', edgeSegmentsEntry.count)
  const edgeIndex = readTyped(bytes, dataStart + edgeIndexEntry.dataOffset, 'u32', edgeIndexEntry.count)
  if (indices.length !== faceIndex.length * 3) {
    throw badFormat('indices 与 faceIndex 数量不匹配', { indices: indices.length, faceIndex: faceIndex.length })
  }
  if (edgeIndex.length > 0 && edgeIndex[edgeIndex.length - 1] !== edgeSegments.length / 3) {
    throw badFormat('edgeIndex 末项与 edgeSegments 点数不匹配', {
      edgePoints: edgeIndex[edgeIndex.length - 1], segments: edgeSegments.length / 3,
    })
  }

  const vertexCount = header.counts?.vertices ?? Math.floor(positions.length / 3)
  const triangleCount = header.counts?.triangles ?? faceIndex.length
  const vertices = []
  for (let index = 0; index < vertexCount; index += 1) {
    vertices.push([positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]])
  }
  const normalList = []
  for (let index = 0; index < vertexCount; index += 1) {
    normalList.push([normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]])
  }
  const triangles = []
  for (let index = 0; index < triangleCount; index += 1) {
    triangles.push([indices[index * 3], indices[index * 3 + 1], indices[index * 3 + 2], faceIndex[index]])
  }
  const edgeMeta = Array.isArray(header.edges) ? header.edges : []
  const edges = edgeMeta.map((entry, edgeAt) => {
    const start = edgeIndex[edgeAt] ?? 0
    const end = edgeIndex[edgeAt + 1] ?? start
    const polyline = []
    for (let point = start; point < end; point += 1) {
      polyline.push([edgeSegments[point * 3], edgeSegments[point * 3 + 1], edgeSegments[point * 3 + 2]])
    }
    return { ...entry, polyline }
  })
  const bbox = Array.isArray(header.bbox) ? header.bbox.slice() : null
  return {
    header,
    mesh: {
      path: header.sourcePath,
      format: 'step',
      units: header.units,
      normalsMode: header.normalsMode,
      bbox,
      faceCount: header.faceCount ?? (Array.isArray(header.faces) ? header.faces.length : 0),
      edgeCount: header.edgeCount ?? edges.length,
      vertexCount,
      triangleCount,
      vertices,
      normals: normalList,
      triangles,
      faces: Array.isArray(header.faces) ? header.faces : [],
      edges,
      deflections: header.deflections,
      truncated: header.truncated,
    },
  }
}

/** 写文件；返回 { path, bytes, header }。目录不存在会自动建。 */
export function writeS3dm(filePath, mesh) {
  const buffer = buildS3dm(mesh)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, buffer)
  return { path: filePath, bytes: buffer.length }
}

/** 读文件；返回 { header, mesh, bytes }。 */
export function readS3dm(filePath) {
  const buffer = readFileSync(filePath)
  const parsed = parseS3dm(buffer)
  return { ...parsed, bytes: buffer.length }
}

/** 给预览端/调试用的布局说明（不读文件，纯常量）。 */
export function s3dmLayout() {
  return {
    magic: S3DM_MAGIC,
    version: S3DM_VERSION,
    prefixBytes: 8,
    header: 'JSON UTF-8，长度在 offset 4 的 uint32 LE',
    arrays: ARRAY_LAYOUT.map((layout) => ({ name: layout.name, type: layout.type, stride: layout.stride })),
    endianness: 'little',
  }
}
