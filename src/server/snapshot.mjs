// 同一版本的快照：图、测量、文件指纹在同一个窗口里取，绑成一个 id。
//
// 为什么不能各取各的：截图和测量分两次拿，中间只要有一次重建或切文档，两边说的就不是
// 同一个模型 —— 而这种「看起来都对」最贵。快照把三样东西钉在一起：
//   · 图片：这一刻渲染器画出来的样子；
//   · 测量：这一刻几何读出来的数（孔径、轴线高、间距…）；
//   · 指纹：这一刻文档与导出文件的字节哈希。
// snapshotId 由这三样的摘要算出来，任何一个变了 id 就变。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SNAPSHOT_SCHEMA_VERSION = 2

function dataRoot() {
  return process.env.SW_MCP_DATA || join(homedir(), 'AppData', 'Local', 'sw-mcp')
}

function shortDigest(buffer, length = 16) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, length)
}

function fileDigest(path, length = 16) {
  try {
    return shortDigest(readFileSync(path), length)
  } catch {
    return null
  }
}

/** 一条快照测量要量哪一份文档。
 *
 * 和 verify 的 runCheck 是同一个 bug 形态，但契约不同：`createSnapshot` 的 designId
 * 本来就是**可选**的（无 designId 时快照记录里 designId 为 null，调用方看得见），
 * 所以这里不抛错，只负责「有就一定要传下去，且 spec 可以覆盖」。
 *
 * 为什么必须传：桥接器 measure 走 OptionalDesignDocument（Operations.cs:348）——
 * 不带 designId 就量**前台那份**，不报错。多开一份文档就会静默量错，而且回的是
 * 看起来合理的假数字。优先级：spec.designId > spec.measure.designId > 快照的 designId。
 */
export function resolveSnapshotDesignId(spec, designId) {
  const raw = spec?.designId ?? spec?.measure?.designId
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  const given = typeof designId === 'string' ? designId.trim() : ''
  return given.length > 0 ? given : null
}

/**
 * 取一次快照。
 *
 * @param {object} options
 * @param {(op: string, args: object) => Promise<any>} options.callBridge 桥接器调用（可注入，测试用假的）
 * @param {string} [options.designId]
 * @param {Array<{name?: string, measure: object}>} [options.measures] 要一起取哪些测量
 * @param {string} [options.imagePath] 截图落哪里；省略时放数据目录的 images/ 下
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {string} [options.view]
 * @param {string} [options.caption]
 * @param {string} [options.document] 只对这份文档取快照（路径）
 * @param {string} [options.artifactPath] 已导出的文件；给了就把它的指纹也钉进来
 * @param {boolean} [options.persist]
 */
export async function createSnapshot(options) {
  const {
    callBridge,
    designId = null,
    measures = [],
    imagePath,
    width = 1280,
    height = 800,
    view,
    caption,
    document,
    artifactPath,
    persist = true,
  } = options

  const dir = join(dataRoot(), 'images')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const target = imagePath ?? join(dir, `snap-${stamp}.png`)

  const captureArgs = { path: target, width, height, hideReferenceGeometry: true }
  if (view) captureArgs.view = view
  if (caption) captureArgs.caption = caption
  if (document) captureArgs.document = document
  // designId 必须下传，两条路都要。桥接器对文档的解析分两类（Operations.cs）：
  //   · capture → RequireDesignDocument  —— 不带就 **DESIGN_ID_REQUIRED**（:534 → :333）
  //   · measure → OptionalDesignDocument —— 不带就**静默量前台那份**（:348 → :358）
  // 第二类是「看起来合理的假数字」的来源：多开一份文档，量到的就是别人，而且不报错。
  // 以前 captureArgs 与下面的 measure request 都没有这个字段：分步兜底路径在现在的
  // 桥接器上必然失败，在还不认识 snapshot 的旧桥接器上则会静默拍错/量错。
  if (designId) captureArgs.designId = designId

  // 优先让桥接器在一个 worker turn 里同时取图、测量、特征树：这样「同一版本」
  // 由时序保证，而不是事后比对哈希。旧桥接器不认识 snapshot 时退回分步流程。
  let atomic = null
  try {
    atomic = await callBridge('snapshot', {
      ...captureArgs,
      designId,
      measures: measures.map((spec) => ({ name: spec.name, measure: spec.measure ?? spec })),
    })
  } catch (error) {
    if (process.env.SW_SNAPSHOT_DEBUG) console.error('[snapshot] atomic failed:', error?.code, error?.message, error?.detail)
    atomic = null
  }

  let capture
  let results = []
  let featureDigest = null
  let featureCount = null
  if (atomic?.image && Array.isArray(atomic.measurements)) {
    capture = atomic.image
    results = atomic.measurements.map((item, index) => {
      const spec = measures[index] ?? {}
      const request = { ...(spec.measure ?? spec) }
      if (request.document === undefined && document) request.document = document
      // 记录里的 request 也要如实带上 designId：桥接器在 C# 侧会给每个子测量补
      // designId（Operations.cs:1982-1983），回包里不写就会出现「原子路径看不出量的是
      // 哪份文档、分步路径看得出」——同一份代码两种行为，正是这轮 bug 的教训。
      const targetDesignId = resolveSnapshotDesignId(spec, designId)
      if (targetDesignId) request.designId = targetDesignId
      return item.ok
        ? { name: item.name ?? spec.name ?? request.kind ?? 'measure', request, ok: true, result: item.result }
        : {
            name: item.name ?? spec.name ?? request.kind ?? 'measure',
            request,
            ok: false,
            error: item.error ?? { code: 'MEASURE_FAILED', message: 'snapshot measure failed' },
          }
    })
    if (atomic.features !== null && atomic.features !== undefined) {
      featureDigest = shortDigest(JSON.stringify(atomic.features), 16)
      featureCount = Array.isArray(atomic.features) ? atomic.features.length : Object.keys(atomic.features).length
    }
  } else {
    capture = await callBridge('capture', captureArgs)
    for (const spec of measures) {
      const request = { ...(spec.measure ?? spec) }
      if (request.document === undefined && document) request.document = document
      // designId 放最后：它说了算，不让 spec.measure 里那个悄悄盖掉解析结果。
      // 没有它，measure 会量「前台那份」—— 和 verify 的 runCheck 是同一个 bug 形态。
      const targetDesignId = resolveSnapshotDesignId(spec, designId)
      if (targetDesignId) request.designId = targetDesignId
      try {
        const result = await callBridge('measure', request)
        results.push({ name: spec.name ?? request.kind ?? 'measure', request, ok: true, result })
      } catch (error) {
        // 一条测量失败不该毁掉整次快照：其他的仍然属于这一刻，失败的那条如实记下来，
        // 后面判「证据齐不齐」时它会变成 incomplete 的理由。
        results.push({
          name: spec.name ?? request.kind ?? 'measure',
          request,
          ok: false,
          error: { code: error?.code ?? 'MEASURE_FAILED', message: error?.message ?? String(error) },
        })
      }
    }
  }

  const imageFile = capture?.path ?? target
  const imageDigest = fileDigest(imageFile, 16)
  const documentPath = capture?.document?.path ?? document ?? null
  const documentDigest = documentPath ? fileDigest(documentPath, 16) : null
  const artifactDigest = artifactPath ? fileDigest(artifactPath, 16) : null
  const measurementDigest = shortDigest(JSON.stringify(results), 16)

  const snapshotId = shortDigest(
    [imageDigest ?? 'noimage', measurementDigest, documentDigest ?? 'nodoc',
      artifactDigest ?? 'noartifact', featureDigest ?? 'nofeatures'].join('|'),
    12,
  )

  const record = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    designId,
    at: new Date().toISOString(),
    sameTurn: atomic?.sameTurn === true,
    document: capture?.document ?? null,
    documentPath,
    image: {
      path: imageFile,
      digest: imageDigest,
      bytes: (() => {
        try {
          return statSync(imageFile).size
        } catch {
          return null
        }
      })(),
      view: view ?? null,
    },
    measurements: results,
    measurementDigest,
    features: featureDigest ? { digest: featureDigest, count: featureCount } : null,
    artifact: artifactPath ? { path: artifactPath, digest: artifactDigest } : null,
    digests: {
      image: imageDigest,
      measurements: measurementDigest,
      document: documentDigest,
      artifact: artifactDigest,
      features: featureDigest,
    },
    missing: results.filter((item) => !item.ok).map((item) => item.name),
  }

  if (persist) {
    try {
      const file = join(dataRoot(), 'review', 'snapshots.json')
      mkdirSync(join(dataRoot(), 'review'), { recursive: true })
      let store = { version: 1, snapshots: {} }
      try {
        store = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        // 没有或坏了：重开一份。历史快照丢了不影响这一张。
      }
      store.snapshots[snapshotId] = record
      const ids = Object.keys(store.snapshots)
      while (ids.length > 40) {
        const oldest = ids.shift()
        delete store.snapshots[oldest]
      }
      writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`)
    } catch (error) {
      record.persistError = error?.message ?? String(error)
    }
  }

  return record
}

/** 读回一张快照（不重新取）。 */
export function loadSnapshot(snapshotId) {
  const file = join(dataRoot(), 'review', 'snapshots.json')
  if (!existsSync(file)) return { record: null, path: file }
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'))
    return { record: store?.snapshots?.[snapshotId] ?? null, path: file }
  } catch {
    return { record: null, path: file }
  }
}

/** 一句话说清这张快照值不值得当证据。 */
export function describeSnapshot(record) {
  if (!record) return '没有快照'
  const missing = record.missing ?? []
  const parts = [
    `快照 ${record.snapshotId}`,
    record.image?.view ? `视图 ${record.image.view}` : null,
    `${record.measurements.length} 条测量`,
    missing.length > 0 ? `其中 ${missing.length} 条没量成（${missing.slice(0, 3).join('、')}）` : '全部量成',
    record.artifact ? '含交付文件指纹' : null,
  ].filter(Boolean)
  return parts.join('，')
}
