// 导出退化（EXPORT_DEGENERATE / F1）与幽灵参数（DEPRECATED_ARG / F2）的离线回归。
//
// 真机那一步（清空选择后 STEP 不再退化）没法离线跑：它要 SOLIDWORKS 和一个真实零件，
// 而且要碰用户正开着的文档。所以这里锁住三件**能离线证明**的事：
//   1. bridge/src/Operations.cs 的 Export() 结构 —— 清空选择发生在 SaveAs3 之前、
//      ClearSelection2(true) 失败有 (false) 回落、成功体保留原有字段名并新增
//      selfCheck{bytes,path}、退化判据是「返回码 / 文件存在 / 字节数」三者之和、
//      退化时错误码 EXPORT_DEGENERATE 且 nextActions 指向 analysis action="step"；
//   2. all 不再是可静默忽略的参数：Export() 见到 all 就抛 DEPRECATED_ARG，并指向
//      measure holes（F2）；schema 侧本来就没有 all，没有可删的参数说明；
//   3. 契约词表同步：contracts/enums.json、bridge/src/Contracts.Generated.cs 与
//      contracts/schema/* 三者一致（等于进程内跑 node tools/gen-contracts.mjs --check）。
//
// 真机复核（用户在场时一条命令，详见报告 §3.5.4「导出与交付」）：本文件不碰
// SOLIDWORKS。人工复核走 MCP：先 select clear 再 deliver kind=step，然后
// analysis action=step 读回体积/面数 —— 历史退化值 10,642 B / 0 mm³ / 1 面，
// 同一零件清空选择后重导是 98,948 B / 41 面 / 642,853.408595 mm³。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateContracts } from '../tools/gen-contracts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let passed = 0
const failures = []
/** 一条断言一个 PASS/FAIL：conditions 里任何一项不为真就算没过，明细照打。 */
function check(id, name, conditions, detail) {
  const failed = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key)
  const ok = failed.length === 0
  if (ok) passed += 1
  else failures.push(`${id} ${name}（未通过：${failed.join(', ')}）`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}`)
  if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`)
  if (!ok) console.log(`      未通过的条件：${failed.join(', ')}`)
}

// ---------------------------------------------------------------- 源码切片

const opsPath = join(root, 'bridge', 'src', 'Operations.cs')
const source = readFileSync(opsPath, 'utf8')
const exportStart = source.indexOf('Dictionary<string, object> Export(Dictionary<string, object> req)')
const helperStart = source.indexOf('static bool ClearSelectionForExport')
const registerStart = source.indexOf('static Dictionary<string, object> RegisterCreated')
const exportBody = exportStart >= 0 && helperStart > exportStart ? source.slice(exportStart, helperStart) : ''
const helperBody = helperStart >= 0
  ? source.slice(helperStart, registerStart > helperStart ? registerStart : helperStart + 1200)
  : ''
const clearIndex = exportBody.indexOf('ClearSelectionForExport(doc)')
const saveAsIndex = exportBody.indexOf('SaveAs3(')

// ---------------------------------------------------------------- 1：选择卫生

check('01', '导出前清空选择：ClearSelectionForExport 在 SaveAs3 之前，true 失败回落 false', {
  methodFound: exportStart >= 0,
  clearBeforeSave: clearIndex >= 0 && saveAsIndex > clearIndex,
  primaryTrue: helperBody.indexOf('ClearSelection2(true)') >= 0,
  fallbackFalse: helperBody.indexOf('ClearSelection2(false)') > helperBody.indexOf('ClearSelection2(true)'),
  fallbackGuarded: helperBody.includes('catch (COMException)') && helperBody.includes('catch (Exception)'),
}, {
  exportStart,
  clearIndex,
  saveAsIndex,
  helperLength: helperBody.length,
})

// ---------------------------------------------------------------- 2：成功返回体

check('02', '成功返回体：原有字段名不变，新增 selfCheck{bytes,path}', {
  preservedFields: ['"exported"', '"kind"', '"path"', '"bytes"', '"errors"', '"warnings"']
    .every((key) => exportBody.includes(key)),
  selfCheckReturned: /"selfCheck",\s*selfCheck/.test(exportBody),
  selfCheckShape: exportBody.includes('Json.Dict("bytes", bytes, "path", path)'),
  selectionClearedReported: exportBody.includes('"selectionCleared", selectionCleared'),
}, {
  returnedFields: ['exported', 'kind', 'path', 'bytes', 'errors', 'warnings', 'selfCheck', 'selectionCleared'],
})

// ---------------------------------------------------------------- 3：退化判据

check('03', '退化判据：返回码 / 文件存在 / 字节数任一不成立即 EXPORT_DEGENERATE', {
  codePresent: exportBody.includes('"EXPORT_DEGENERATE"'),
  conditionPresent: /if \(!ok \|\| !exists \|\| bytes == 0\)/.test(exportBody),
  byteCountReadBack: exportBody.includes('new FileInfo(path).Length'),
  oldEmptyCodeFolded: !exportBody.includes('EXPORT_EMPTY'),
}, {
  // 旧实现只在 ok && bytes == 0 时报 EXPORT_EMPTY，SaveAs3 返回 false 时会静默成功。
  oldCode: 'EXPORT_EMPTY (removed)',
})

// ---------------------------------------------------------------- 4：下一步动作

check('04', '退化时 nextActions 指向 analysis action="step" 复核体积/面数', {
  nextActionsPresent: exportBody.includes('"nextActions"'),
  pointsAtAnalysis: exportBody.includes('analysis action=\\"step\\"'),
  detailCarriesSelfCheck: exportBody.includes('"selfCheck", selfCheck'),
  detailCarriesSelectionState: exportBody.includes('"selectionCleared", selectionCleared'),
}, {
  expectedAction: 'analysis action="step" path=<导出文件>',
})

// ---------------------------------------------------------------- 5：all 幽灵参数

check('05', 'all 不再被静默忽略：传 all 抛 DEPRECATED_ARG，并说明改传 measure holes', {
  rejectsAll: exportBody.includes('req.ContainsKey("all")'),
  deprecatedCode: exportBody.includes('"DEPRECATED_ARG"'),
  pointsAtMeasure: /measure holes/.test(exportBody),
  noSilentRead: !/Json\.Bool\(req,\s*"all"/.test(exportBody),
  noAllInVersionSwitch: !/case "all"/.test(exportBody),
}, {
  message: 'all 对文件导出无效：export 只写一个文件；多体统计改传 all:true 给 measure holes',
})

// ---------------------------------------------------------------- 6：契约词表

const enums = JSON.parse(readFileSync(join(root, 'contracts', 'enums.json'), 'utf8'))
const codes = Array.isArray(enums.errorCodes) ? enums.errorCodes : []
const generated = readFileSync(join(root, 'bridge', 'src', 'Contracts.Generated.cs'), 'utf8')
check('06', '契约词表：enums.json 含两个新错误码且无重复；Contracts.Generated.cs 已同步', {
  hasDegenerate: codes.includes('EXPORT_DEGENERATE'),
  hasDeprecated: codes.includes('DEPRECATED_ARG'),
  noDuplicate: new Set(codes).size === codes.length,
  generatedDegenerate: generated.includes('EXPORTDEGENERATE = "EXPORT_DEGENERATE"'),
  generatedDeprecated: generated.includes('DEPRECATEDARG = "DEPRECATED_ARG"'),
}, {
  errorCodeCount: codes.length,
  added: codes.filter((code) => code === 'EXPORT_DEGENERATE' || code === 'DEPRECATED_ARG'),
})

// ---------------------------------------------------------------- 7：生成物无漂移

let drift = { changed: null, stale: ['generateContracts 抛异常'] }
try {
  const report = generateContracts({ check: true })
  drift = { changed: report.changed, stale: report.files.filter((file) => file.status !== 'same').map((file) => file.path) }
} catch (error) {
  drift = { changed: true, stale: [String(error?.message ?? error)] }
}
check('07', '生成物无漂移：generateContracts({check:true}) 无 stale（等价 node tools/gen-contracts.mjs --check）', {
  noDrift: drift.changed === false,
  nothingStale: drift.stale.length === 0,
}, { changed: drift.changed, stale: drift.stale })

// ---------------------------------------------------------------- 8：schema 侧

// F2 的另一半是「从 schema / 参数说明里移除」。deliver 与 model 的 inputSchema 从来没有
// 声明过 export 的 all（它只是被调用方随手塞进 payload 的幽灵参数），所以这一条是
// 防止它再被写回 schema：deliver 只允许 kind/designId/path。
const observe = readFileSync(join(root, 'server', 'tools-observe.mjs'), 'utf8')
const deliverStart = observe.indexOf("'deliver'")
const deliverEnd = observe.indexOf('handlePartExport(args)', deliverStart)
const deliverBlock = deliverStart >= 0 && deliverEnd > deliverStart
  ? observe.slice(deliverStart, deliverEnd)
  : ''
check('08', 'deliver 的 inputSchema 仍只有 kind/designId/path，没有把 all 写进参数说明', {
  blockFound: deliverBlock.length > 0,
  kindsUnchanged: deliverBlock.includes("kind: z.enum(['sldprt', 'step', 'stl', 'pdf', 'dxf', 'dwg'])"),
  hasDesignId: deliverBlock.includes('designId: designIdArg'),
  hasPath: deliverBlock.includes('path: z.string()'),
  noAllParameter: !/\ball\b/.test(deliverBlock),
}, {
  schema: 'deliver({kind, designId?, path?})',
  note: 'export 的 all 从未在 schema 里声明；bridge 现在显式拒绝它，两条路都不再静默',
})

// ---------------------------------------------------------------- 汇总

const exePath = join(root, 'bridge', 'bin', 'SwBridge.exe')
try {
  const stat = readFileSync(exePath)
  console.log(`\n构建产物：${exePath}（${stat.length} 字节）`)
} catch {
  console.log(`\n构建产物缺失：${exePath}`)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exitCode = 1
}
