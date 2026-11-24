import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLiveRecord } from './review-live.mjs'

const TTL_MS = 120_000
const TOKEN = /^[a-f0-9]{64}$/
let lastCleanup = 0

export function reviewDigest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function liveReviewFingerprint(dataDir, designId) {
  const live = readLiveRecord({ dataDir, designId })
  if (!live) return null
  return reviewDigest(JSON.stringify({
    designId: live.designId ?? designId,
    documentPath: live.documentPath ?? null,
    documentTitle: live.documentTitle ?? null,
    revision: live.revision,
    images: (live.images ?? []).filter((image) => image.atRevision === live.revision),
    verify: live.verify ?? null,
    relations: live.relationAudit ?? null,
  }))
}

function directory(dataDir) {
  return join(dataDir, 'review', 'receipts')
}

function stale(message) {
  return Object.assign(new Error(message), { code: 'REVIEW_RECEIPT_STALE' })
}

/** Host-only capability for one exact, upcoming compact delivery call. */
export function issueReviewReceipt({ dataDir, designId, kind, path, basis, fingerprint, evidence }) {
  if (!fingerprint || liveReviewFingerprint(dataDir, designId) !== fingerprint) {
    throw stale('交付目标或核对证据已变化，请重新核对当前版本。')
  }
  const dir = directory(dataDir)
  const now = Date.now()
  mkdirSync(dir, { recursive: true })
  if (now - lastCleanup >= TTL_MS) {
    lastCleanup = now
    for (const filename of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}(?:\.claimed)?$/.test(filename)) continue
      const file = join(dir, filename)
      try {
        if (now - statSync(file).mtimeMs >= TTL_MS) unlinkSync(file)
      } catch { /* A different consumer already removed it. */ }
    }
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(join(dir, token), JSON.stringify({
    designId, kind, path: path ?? null, basis, fingerprint, evidence, expires: now + TTL_MS,
  }), { flag: 'wx', mode: 0o600 })
  return token
}

/** Call while holding the broker's design lease, before the save/export command. */
export function consumeReviewReceipt(token, { dataDir, designId, kind, path, force }) {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw stale('交付缺少当前版本的审查凭据。')
  const file = join(directory(dataDir), token)
  const claimed = `${file}.claimed`
  let record
  try {
    renameSync(file, claimed)
  } catch {
    throw stale('交付凭据已经使用或失效，请重新发起交付。')
  }
  try {
    record = JSON.parse(readFileSync(claimed, 'utf8'))
  } finally {
    try { unlinkSync(claimed) } catch { /* Expiry cleanup will reclaim it. */ }
  }
  if (record.expires < Date.now() || record.designId !== designId || record.kind !== kind
    || record.path !== (path ?? null) || record.basis !== (force === 'manual' ? 'manual' : 'review')
    || record.fingerprint !== liveReviewFingerprint(dataDir, designId)) {
    throw stale('审查凭据与当前交付目标、文档或版本不符，请重新核对当前版本。')
  }
  for (const image of record.evidence ?? []) {
    let actual
    try { actual = reviewDigest(readFileSync(image.path)) } catch { /* Missing evidence is stale. */ }
    if (actual !== image.digest) throw stale('送审图片已变化，请重新取证并审查。')
  }
}
