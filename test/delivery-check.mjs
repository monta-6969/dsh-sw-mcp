// 程序化交付检查（没有模型、没有子代理）：只看可验证的事实。
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateDeliveryEvidence } from '../review-gate.js'

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS ', name) }
  else { fail += 1; console.log('FAIL ', name, JSON.stringify(detail ?? null)) }
}

const base = { designId: 'demo', revision: 3, lastMutationAt: Date.now(), images: [{ atRevision: 3, path: 'x.png' }] }

check('当前 revision 有图 → 通过', evaluateDeliveryEvidence(base).ok === true)
const none = evaluateDeliveryEvidence({ ...base, images: [] })
check('没有图 → NO_CURRENT_VIEW', none.ok === false && none.code === 'NO_CURRENT_VIEW', none)
const oldOnly = evaluateDeliveryEvidence({ ...base, images: [{ atRevision: 2, path: 'old.png' }] })
check('只有旧版本的图 → 仍然拒', oldOnly.ok === false && oldOnly.code === 'NO_CURRENT_VIEW')

const dir = mkdtempSync(join(tmpdir(), 'delivery-check-'))
const oldFile = join(dir, 'old.step')
writeFileSync(oldFile, 'x')
const past = new Date(Date.now() - 120000)
utimesSync(oldFile, past, past)
const stale = evaluateDeliveryEvidence(base, { arguments: { path: oldFile, kind: 'step' } })
check('输出路径上是旧文件 → ARTIFACT_STALE', stale.ok === false && stale.code === 'ARTIFACT_STALE', stale)

const freshFile = join(dir, 'fresh.step')
writeFileSync(freshFile, 'x')
const fresh = evaluateDeliveryEvidence({ ...base, lastMutationAt: Date.now() - 120000 }, { arguments: { path: freshFile } })
check('新文件 + 当前图 → 通过', fresh.ok === true, fresh)

check('检查结果带 designId / revision / 图片数',
  fresh.detail.designId === 'demo' && fresh.detail.revision === 3 && fresh.detail.images === 1, fresh.detail)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)