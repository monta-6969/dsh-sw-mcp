// deliver 路由决策的离线测试（不需要 SOLIDWORKS）。
//
// 重点是这里：多会话共用一个 SW 实例时，活动文档可能已经不是这一份了。
// 「活动文档不匹配 → 按设计定义 rebuilt」必须是决策层的结论，而不是靠真机碰运气。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DELIVER_SOURCES, closeOutcomeTitle, closeTargetFacts, judgeReopenedDocument, matchOpenDeliverDocument,
  normalizeOpenDocuments, partIdOf, planDeliverRoute,
} from '../server/deliver-route.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSource = readFileSync(join(repo, 'server', 'server.mjs'), 'utf8')

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS ', name) }
  else { fail += 1; console.log('FAIL ', name, JSON.stringify(detail ?? null)) }
}

// ── partId 与 list 回包规整 ────────────────────────────────────────────────
check('partIdOf 取文件名去扩展名', partIdOf('C:\\parts\\M6-14.SLDPRT') === 'M6-14', partIdOf('C:\\parts\\M6-14.SLDPRT'))
check('partIdOf 认正斜杠', partIdOf('D:/out/m6-14.sldprt') === 'm6-14')
check('partIdOf 空值返回 null', partIdOf('') === null && partIdOf(null) === null && partIdOf(undefined) === null)
check('normalizeOpenDocuments：数组原样', normalizeOpenDocuments([{ title: 'a' }]).length === 1)
check('normalizeOpenDocuments：{documents:[]}', Array.isArray(normalizeOpenDocuments({ documents: [] })))
check('normalizeOpenDocuments：拿不到返回 null', normalizeOpenDocuments(null) === null && normalizeOpenDocuments('x') === null)

// ── 已打开文档的匹配 ──────────────────────────────────────────────────────
const designId = 'M6-14-r2'
const cadPath = 'C:\\work\\parts\\M6-14.SLDPRT'
const targetPath = 'D:\\work\\out\\M6-14-r2.SLDPRT'

const byRegistry = matchOpenDeliverDocument({
  designId,
  registry: { title: 'M6-14.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'M6-14.SLDPRT', path: cadPath, dirty: false }],
  knownPaths: [cadPath, targetPath],
})
check('按 designId 登记标题匹配', byRegistry?.by === 'designId' && byRegistry.path === cadPath, byRegistry)

const byPath = matchOpenDeliverDocument({
  designId,
  registry: { title: '旧标题.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'M6-14.SLDPRT', path: 'c:/WORK/parts/m6-14.sldprt', dirty: false }],
  knownPaths: [cadPath, targetPath],
})
check('登记标题过期时按路径匹配（大小写/斜杠不敏感）', byPath?.by === 'path', byPath)

const byPartId = matchOpenDeliverDocument({
  designId,
  registry: null,
  openDocuments: [{
    title: 'M6-14.SLDPRT',
    path: 'C:\\archive\\M6-14.SLDPRT',
    dirty: false,
    contract: { designId: 'M6-14', partId: 'M6-14', definitionHash: 'sha256:def-a' },
  }],
  knownPaths: [cadPath, targetPath],
  definitionHash: 'sha256:def-a',
})
check('同一份定义（哈希相同）时按 partId 匹配', byPartId?.by === 'partId' && byPartId.path === 'C:\\archive\\M6-14.SLDPRT', byPartId)

const byPartIdWrongDefinition = matchOpenDeliverDocument({
  designId,
  registry: null,
  openDocuments: [{
    title: 'M6-14.SLDPRT',
    path: 'C:\\archive\\M6-14.SLDPRT',
    contract: { designId: 'M6-14', partId: 'M6-14', definitionHash: 'sha256:other' },
  }],
  knownPaths: [cadPath, targetPath],
  definitionHash: 'sha256:def-a',
})
check('partId 相同但定义哈希不同 → 不匹配', byPartIdWrongDefinition === null, byPartIdWrongDefinition)

const titleCollision = matchOpenDeliverDocument({
  designId,
  registry: { title: '别的.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'M6-14.SLDPRT', path: 'C:\\Users\\mota\\Desktop\\M6-14.SLDPRT', dirty: true }],
  knownPaths: [cadPath, targetPath],
  definitionHash: 'sha256:def-a',
})
check('标题撞名但没有登记/路径/定义证明 → 不匹配（不能抢用户文档）', titleCollision === null, titleCollision)

const sameTitleOtherPath = matchOpenDeliverDocument({
  designId,
  registry: { title: 'M6-14.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'M6-14.SLDPRT', path: 'C:\\Users\\mota\\Desktop\\M6-14.SLDPRT', dirty: false }],
  knownPaths: [cadPath, targetPath],
  definitionHash: 'sha256:def-a',
})
check('登记标题对上但路径不同 → 不按标题认（我们那份可能已被关掉）',
  sameTitleOtherPath === null, sameTitleOtherPath)

// ── 路由：活动文档不匹配 → rebuilt（任务书要求的那条）─────────────────────
const rebuiltWhenActiveMismatch = planDeliverRoute({
  designId,
  kind: 'sldprt',
  targetPath,
  registry: { title: 'M6-14.SLDPRT', path: cadPath },
  // 窗口里只剩"别的会话的"零件：标题和路径都不是这一份
  openDocuments: [{ title: '零件7', path: 'C:\\Users\\mota\\Desktop\\零件7.SLDPRT', dirty: true }],
  cadPath: null,
  cadFile: { exists: false, bytes: 0 },
  cadCurrent: null,
  hasDefinition: true,
  definitionHash: 'sha256:def-a',
})
check('活动文档不匹配 → rebuilt', rebuiltWhenActiveMismatch.ok === true
  && rebuiltWhenActiveMismatch.source === 'rebuilt'
  && rebuiltWhenActiveMismatch.reason === 'NO_OPEN_DOC_NO_FILE'
  && rebuiltWhenActiveMismatch.rebuild === true, rebuiltWhenActiveMismatch)
check('rebuilt 的 source 在允许的枚举里', DELIVER_SOURCES.includes(rebuiltWhenActiveMismatch.source))

// ── 其余分支 ──────────────────────────────────────────────────────────────
const preflightUnknown = planDeliverRoute({
  designId, kind: 'sldprt', targetPath, registry: null, openDocuments: null, hasDefinition: true,
})
check('拿不到打开清单 → 先按 designId 直接存（active/PREFLIGHT_UNAVAILABLE）',
  preflightUnknown.source === 'active' && preflightUnknown.reason === 'PREFLIGHT_UNAVAILABLE'
  && preflightUnknown.activatePath === null, preflightUnknown)

const activeByRegistry = planDeliverRoute({
  designId, kind: 'sldprt', targetPath,
  registry: { title: 'M6-14.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'M6-14.SLDPRT', path: cadPath }],
  cadPath, cadFile: { exists: true, bytes: 10 }, cadCurrent: true, hasDefinition: true,
})
check('窗口里有这一份 → active，且不需要再 open',
  activeByRegistry.source === 'active' && activeByRegistry.reason === 'OPEN_DOC_REGISTRY'
  && activeByRegistry.activatePath === null, activeByRegistry)

const activeByPath = planDeliverRoute({
  designId, kind: 'sldprt', targetPath,
  registry: { title: '旧.SLDPRT', path: cadPath },
  openDocuments: [{ title: 'm6-14.SLDPRT', path: cadPath }],
  cadPath, cadFile: { exists: true, bytes: 10 }, cadCurrent: true, hasDefinition: true,
})
check('按路径匹配到 → active，并带 activatePath 重新绑定 designId',
  activeByPath.source === 'active' && activeByPath.reason === 'OPEN_DOC_PATH'
  && activeByPath.activatePath === cadPath, activeByPath)

const reopenCurrent = planDeliverRoute({
  designId, kind: 'sldprt', targetPath, registry: null, openDocuments: [],
  cadPath, cadFile: { exists: true, bytes: 10 }, cadCurrent: true, hasDefinition: true,
})
check('文件就是当前定义编译的 → reopened（不白重建）',
  reopenCurrent.source === 'reopened' && reopenCurrent.reason === 'ARTIFACT_CURRENT'
  && reopenCurrent.reopenPath === cadPath, reopenCurrent)

const rebuildStale = planDeliverRoute({
  designId, kind: 'sldprt', targetPath, registry: null, openDocuments: [],
  cadPath, cadFile: { exists: true, bytes: 10 }, cadCurrent: false, hasDefinition: true,
})
check('文件与定义对不上 → rebuilt（定义是唯一真源）',
  rebuildStale.source === 'rebuilt' && rebuildStale.reason === 'ARTIFACT_STALE_OR_UNPROVEN', rebuildStale)

const reopenNoDefinition = planDeliverRoute({
  designId, kind: 'sldprt', targetPath, registry: null, openDocuments: [],
  cadPath, cadFile: { exists: true, bytes: 10 }, cadCurrent: false, hasDefinition: false,
})
check('只有文件、没有设计存档 → reopened（降级路径，理由写清楚）',
  reopenNoDefinition.source === 'reopened' && reopenNoDefinition.reason === 'ARTIFACT_WITHOUT_DEFINITION', reopenNoDefinition)

const noSource = planDeliverRoute({
  designId, kind: 'sldprt', targetPath, registry: null, openDocuments: [],
  cadPath: null, cadFile: { exists: false, bytes: 0 }, cadCurrent: null, hasDefinition: false,
})
check('什么都没有 → 明确失败 NO_SOURCE，不硬存',
  noSource.ok === false && noSource.source === null && noSource.reason === 'NO_SOURCE', noSource)

const unsupported = planDeliverRoute({ designId, kind: 'step', targetPath: 'x.step', openDocuments: [] })
check('非 sldprt 不归这条路管', unsupported.ok === false && unsupported.reason === 'UNSUPPORTED_KIND', unsupported)

// ── 重开后的读数判据 ──────────────────────────────────────────────────────
check('零件实体数 1 → 通过', judgeReopenedDocument({ kind: 'part', bodies: 1 }).ok === true)
check('零件实体数 0 → 不通过', judgeReopenedDocument({ kind: 'part', bodies: 0 }).ok === false
  && judgeReopenedDocument({ kind: 'part', bodies: 0 }).reason === 'NO_SOLID_BODIES')
check('零件读数缺失 → 不通过', judgeReopenedDocument({ kind: 'part', bodies: null }).ok === false)
check('装配组件数 3 → 通过且按 components 判',
  judgeReopenedDocument({ kind: 'assembly', components: 3 }).ok === true
  && judgeReopenedDocument({ kind: 'assembly', components: 3 }).metric === 'components')
check('装配组件数 0 → 不通过', judgeReopenedDocument({ kind: 'assembly', components: 0 }).ok === false)

// ── 「按标题关」的安全性 ──────────────────────────────────────────────────
const uniqueClose = closeTargetFacts({
  openDocuments: [{ title: 'M6-14-r2.SLDPRT', path: targetPath, dirty: false }],
  targetPath,
})
check('标题唯一且路径一致 → 允许关掉重开',
  uniqueClose.ok === true && uniqueClose.reason === 'UNIQUE' && uniqueClose.title === 'M6-14-r2.SLDPRT', uniqueClose)

const ambiguousClose = closeTargetFacts({
  openDocuments: [
    { title: 'M6-14-r2.SLDPRT', path: targetPath, dirty: false },
    { title: 'M6-14-r2.SLDPRT', path: 'C:\\users\\mota\\M6-14-r2.SLDPRT', dirty: false },
  ],
  targetPath,
})
check('同名两份同时开着 → 不按标题关（会关错）',
  ambiguousClose.ok === false && ambiguousClose.reason === 'TITLE_AMBIGUOUS', ambiguousClose)

const elsewhereClose = closeTargetFacts({
  openDocuments: [{ title: 'M6-14-r2.SLDPRT', path: 'C:\\users\\mota\\M6-14-r2.SLDPRT', dirty: false }],
  targetPath,
})
check('同名但路径不是目标 → 不关', elsewhereClose.ok === false && elsewhereClose.reason === 'TITLE_POINTS_ELSEWHERE', elsewhereClose)

const dirtyClose = closeTargetFacts({
  openDocuments: [{ title: 'M6-14-r2.SLDPRT', path: targetPath, dirty: true }],
  targetPath,
})
check('目标文档还是脏的 → 不关', dirtyClose.ok === false && dirtyClose.reason === 'DIRTY', dirtyClose)

const notOpenClose = closeTargetFacts({ openDocuments: [], targetPath })
check('目标没开着 → 不关（直接 open 回读）', notOpenClose.ok === false && notOpenClose.reason === 'NOT_OPEN', notOpenClose)

const unknownClose = closeTargetFacts({ openDocuments: null, targetPath })
check('拿不到清单 → 不冒险关', unknownClose.ok === false && unknownClose.reason === 'OPEN_LIST_UNKNOWN', unknownClose)

// ── 接线：决策要被真的用上（源码断言，防"抽了函数但没接进去"）─────────────
check('handlePartExport 把 sldprt 交给 deliverPartFile',
  serverSource.includes("if (args.kind === 'sldprt') return await deliverPartFile({ designId, path, started })"))
check('deliverPartFile 用 planDeliverRoute 决策',
  serverSource.includes('const facts = await collectDeliverFacts({ designId, project, targetPath })')
  && serverSource.includes('route = planDeliverRoute(facts)'))
check('保存后回读走 close→open→inspect，且 close 按 designId 走 broker 通道',
  serverSource.includes("callBridge('close', { title: closable.title, allowDirty: true, designId }, { broker: true })")
  && serverSource.includes('verifyDeliveredPartFile({ designId, targetPath, project: projectNow })'))
check('回包带 delivery{saved,bytes,designId,source,elapsedMs}（顶层与 changes 同一个对象）',
  serverSource.includes('delivery,')
  && serverSource.includes('saved: wrote,')
  && serverSource.includes('elapsedMs,'))
check('拿不到打开清单时按"未知"处理，不硬判成没开',
  serverSource.includes('openDocuments: enrichOpenDocuments(await listOpenDocumentsForDeliver(designId))'))

// close 回包的成功判据：按标题关回的是标题**字符串**，不是布尔。以前一律写
// `closed?.closed === true`，成功的关闭全被记成 false，和 lockFileAfter:"absent"
// 自相矛盾（sw-native 交付实测）。
check('close 回"标题字符串"算关掉了', closeOutcomeTitle({ closed: 'P-0009.SLDPRT', found: true }) === 'P-0009.SLDPRT')
check('close 回数组算关掉了，取第一条标题', closeOutcomeTitle({ closed: ['A.SLDPRT'], closedCount: 1 }) === 'A.SLDPRT')
check('close 回 null 算没关掉', closeOutcomeTitle({ closed: null, found: false }) === null)
check('空字符串不当成功', closeOutcomeTitle({ closed: '' }) === null)
check('空数组不当成功', closeOutcomeTitle({ closed: [] }) === null)
check('桥接器只说 true 时仍算成功（返回 true 而不是 null）', closeOutcomeTitle({ closed: true }) === true)
check('回包里没有 closed 字段算没关掉', closeOutcomeTitle({}) === null && closeOutcomeTitle(null) === null)
check('server 的关闭判据走同一个函数（不再写 === true）',
  serverSource.includes('closeOutcomeTitle(closed)') && !serverSource.includes('closed?.closed === true'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
