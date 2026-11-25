// 3D 预览文件的落点：<DATA_DIR>\preview\<basename>-<hash>.s3dm
//
// DATA_DIR 与 server.mjs 同一套规则（SW_MCP_DATA → %LOCALAPPDATA%\sw-mcp → 系统临时目录），
// 这样工具层不用为了一个目录去改 server.mjs 的注册签名。
// 文件名里的 hash 由「源文件路径 + 大小 + mtime + 挠度参数」算出：同一份 STEP、同一组
// 参数反复预览会命中同一个文件，预览端可以安心缓存；改了文件或参数就自然换新文件。
import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

export function dataRoot(env = process.env) {
  const base = env.LOCALAPPDATA
  return env.SW_MCP_DATA || (base ? join(base, 'sw-mcp') : join(tmpdir(), 'sw-mcp'))
}

export function previewDir(env = process.env) {
  return join(dataRoot(env), 'preview')
}

export function ensurePreviewDir(env = process.env) {
  const dir = previewDir(env)
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileStamp(sourcePath) {
  try {
    const stat = statSync(sourcePath)
    return `${stat.size}:${Math.round(stat.mtimeMs)}`
  } catch {
    return 'missing'
  }
}

function sanitizeStem(sourcePath) {
  const stem = basename(sourcePath, extname(sourcePath))
  // 只挡 Windows 文件名非法字符；中文/空格照留，预览文件一眼能认出是哪个模型。
  const cleaned = stem
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
  return cleaned || 'mesh'
}

/** 预览文件绝对路径；只算路径，不建目录、不写文件。 */
export function previewPathFor(sourcePath, options = {}) {
  const key = JSON.stringify({
    source: sourcePath,
    stamp: fileStamp(sourcePath),
    deflectionMm: options.deflectionMm ?? 0.2,
    angularDeflection: options.angularDeflection ?? 0.5,
    maxTriangles: options.maxTriangles ?? 200000,
    maxEdges: options.maxEdges ?? 4000,
    tolerance: options.tolerance ?? 0,
  })
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 12)
  return join(previewDir(), `${sanitizeStem(sourcePath)}-${hash}.s3dm`)
}
