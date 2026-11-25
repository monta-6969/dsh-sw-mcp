// 目标引用：把「项目 / 运行 / 实例 / 文档 / 配置 / 修订 / 作业 / 产物」变成可传递、
// 可持久化、可比较的字符串，工具之间只传引用，不再靠标题、路径或“当前活动文档”猜。
//
// 规范形式是 `sw:<kind>:<id>`。id 不透明，生成后不随路径大小写、斜杠方向变化；
// 同一份文件在同一设计里必须得到同一个 documentId，这一点由 documentIdFor 保证。
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { ENUMS } from './contracts.mjs'

export const REF_PREFIX = 'sw:'
export const REF_KINDS = ENUMS.refKinds

const PREFIX_BY_KIND = {
  project: 'proj_',
  run: 'run_',
  instance: 'inst_',
  document: 'doc_',
  configuration: 'cfg_',
  revision: 'rev_',
  job: 'job_',
  artifact: 'art_',
}

export class BadRefError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'BadRefError'
    this.code = 'BAD_REF'
    this.details = details
  }
}

function assertKind(kind) {
  if (!REF_KINDS.includes(kind)) {
    throw new BadRefError(`unknown ref kind "${kind}"`, { kind, known: REF_KINDS })
  }
  return kind
}

export function newId(kind) {
  const prefix = PREFIX_BY_KIND[assertKind(kind)]
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export function newRef(kind, id = newId(kind)) {
  return { kind: assertKind(kind), id: String(id) }
}

export function isRef(value) {
  if (!value || typeof value !== 'object') return false
  return REF_KINDS.includes(value.kind) && typeof value.id === 'string' && value.id.length > 0
}

export function isRefString(value) {
  return typeof value === 'string' && value.startsWith(REF_PREFIX)
}

/** Parse `sw:<kind>:<id>` or `{kind,id}`. Never falls back to paths. */
export function parseRef(value) {
  if (isRef(value)) return { kind: value.kind, id: value.id }
  if (typeof value !== 'string') {
    throw new BadRefError('ref must be a string or {kind,id}', { value })
  }
  const text = value.trim()
  if (!text.startsWith(REF_PREFIX)) {
    throw new BadRefError(`ref must start with "${REF_PREFIX}"`, { value })
  }
  const rest = text.slice(REF_PREFIX.length)
  const split = rest.indexOf(':')
  if (split < 0) throw new BadRefError('ref must be sw:<kind>:<id>', { value })
  const kind = rest.slice(0, split)
  const id = rest.slice(split + 1)
  if (!kind || !id) throw new BadRefError('ref must be sw:<kind>:<id>', { value })
  assertKind(kind)
  return { kind, id }
}

export function tryParseRef(value) {
  try {
    return parseRef(value)
  } catch {
    return null
  }
}

export function refToString(ref) {
  const parsed = isRef(ref) ? ref : parseRef(ref)
  return `${REF_PREFIX}${parsed.kind}:${parsed.id}`
}

export function refKey(ref) {
  const parsed = isRef(ref) ? ref : parseRef(ref)
  return `${parsed.kind}:${parsed.id}`
}

export function refsEqual(a, b) {
  return refKey(a) === refKey(b)
}

/**
 * Canonical path used only for identity hashing. Windows paths are case-insensitive,
 * accept either slash, and may arrive with the `\\?\` long-path prefix.
 */
export function canonicalPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new BadRefError('path is required to derive a document ref', { input })
  }
  let text = input.trim()
  // \\?\C:\x -> C:\x ; \\?\UNC\server\share -> \\server\share
  text = text.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  text = text.replace(/^\?\\/, '')
  let full = resolve(text)
  if (process.platform === 'win32') {
    full = full.replace(/\//g, '\\').toLowerCase()
  }
  while (full.length > 3 && /[\\/]$/.test(full)) full = full.slice(0, -1)
  return full
}

export function hashText(text, length = 24) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, length)
}

/** Stable id for one document: same path + design always maps to the same id. */
export function documentIdFor({ path, designId = '' } = {}) {
  const canonical = canonicalPath(path)
  const design = String(designId ?? '').trim().toLowerCase()
  return `doc_${hashText(`${canonical}|${design}`)}`
}

export function documentRefFor({ path, designId = '' } = {}) {
  return { kind: 'document', id: documentIdFor({ path, designId }) }
}

export function artifactRefFor(sha256, length = 24) {
  const digest = String(sha256 ?? '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new BadRefError('artifact ref needs a full sha256', { sha256 })
  }
  return { kind: 'artifact', id: `art_${digest.slice(0, length)}` }
}

export function revisionRef(documentRef, revision) {
  const ref = isRef(documentRef) ? documentRef : parseRef(documentRef)
  if (ref.kind !== 'document') throw new BadRefError('revision ref needs a document ref', { ref })
  return { kind: 'revision', id: `rev_${hashText(`${ref.id}|${Number(revision)}`)}` }
}

/**
 * Resolve any accepted target form to a document ref.
 * Accepted: document ref, {kind:'document',id}, {path,designId}, or a path string.
 * Legacy callers that only know designId still work, but the path is required to
 * make the identity stable; without it the call fails loudly rather than inventing one.
 */
export function toDocumentRef(target, { designId = '' } = {}) {
  if (!target) throw new BadRefError('a document ref or path is required', { target })
  if (typeof target === 'string' && target.startsWith(REF_PREFIX)) {
    const ref = parseRef(target)
    if (ref.kind !== 'document') throw new BadRefError('expected a document ref', { target })
    return ref
  }
  if (typeof target === 'string') return documentRefFor({ path: target, designId })
  if (isRef(target)) {
    if (target.kind !== 'document') throw new BadRefError('expected a document ref', { target })
    return { kind: 'document', id: target.id }
  }
  if (typeof target === 'object') {
    if (typeof target.path === 'string' && target.path) {
      return documentRefFor({ path: target.path, designId: target.designId ?? designId })
    }
    if (typeof target.id === 'string') return { kind: 'document', id: target.id }
  }
  throw new BadRefError('could not resolve a document ref', { target })
}

export function describeRef(ref) {
  const parsed = isRef(ref) ? ref : parseRef(ref)
  return { ref: refToString(parsed), kind: parsed.kind, id: parsed.id }
}
