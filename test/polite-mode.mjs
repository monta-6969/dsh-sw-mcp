// 「礼貌模式」的回归测试：AI 操作 SOLIDWORKS 时不许动用户正在看的窗口、不许改文档
// 的视图状态、不许把参数/存盘落到用户的零件上。
//
// 为什么这些断言写在源码上：这是用户第 4 次抱怨同一类问题，前 3 次只改了提示词，
// 机制没动。所以这里的判据是「C#/服务端代码里到底怎么写的」，而不是「人设里写了什么」——
// 提示词能被模型忽略，代码不能。整份测试不需要 SOLIDWORKS、不需要 broker、不碰真机。
//
// 覆盖：
//   A1 capture 默认不改文档视图（mutateView 总开关 + viewMutated 回报）
//   A2 九处「静默退回当前活动文档」的兜底已删；读操作改带回 documentFallback
//   A3 ui 不许隐式最大化、脏文档时跳过、不写用户首选项
//   A4 每个 op 结束把用户原来的活动文档还回去
//   A5 脏文档只允许关本会话建出来的那一份
//   A6 人设里的三条硬规则
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './lib/mcp.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  }
}

function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

/** 去掉 `//` 行注释后再做「不许出现某个字符串」这类负向断言：
 *  否则解释旧行为的注释本身会把断言绊倒（这里踩过一次）。 */
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//')
      return at >= 0 ? line.slice(0, at) : line
    })
    .join('\n')
}

/** 按 registerTool 切成工具块，返回 name → 源码块。 */
function toolBlock(source, name) {
  const starts = [...source.matchAll(/registerTool\(\s*\n?\s*'([a-z_]+)'/g)]
  for (let i = 0; i < starts.length; i++) {
    if (starts[i][1] !== name) continue
    const from = starts[i].index
    const to = i + 1 < starts.length ? starts[i + 1].index : source.length
    return source.slice(from, to)
  }
  return ''
}

/** 取一个 C# 方法体（从签名到配对的右括号），按大括号计数。
 *  只搜「这个方法自己写了什么」，而不是整份文件里有没有某个字符串 —— 否则
 *  别处的一行注释就能让断言假通过。 */
function csBody(source, signature) {
  const at = source.indexOf(signature)
  if (at < 0) return null
  const open = source.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return null
}

const operations = read('bridge/src/Operations.cs')
const documents = read('bridge/src/Documents.cs')
const userInterface = read('bridge/src/UserInterface.cs')
const observe = read('bridge/src/Observe.cs')
const measure = read('bridge/src/Measure.cs')
const relations = read('bridge/src/Relations.cs')
const assembly = read('bridge/src/Assembly.cs')
const server = read('server/server.mjs')
const toolsObserve = read('server/tools-observe.mjs')
const patch = read('cordis.patch.yml')

// ---------------------------------------------------------------- A2：不再退回前台

const requireDocumentOps = {
  capture: csBody(operations, 'Dictionary<string, object> Capture(Dictionary<string, object> req)'),
  edit: csBody(operations, 'Dictionary<string, object> Edit(Dictionary<string, object> req)'),
  save: csBody(operations, 'Dictionary<string, object> Save(Dictionary<string, object> req)'),
  export: csBody(operations, 'Dictionary<string, object> Export(Dictionary<string, object> req)'),
  inspect: csBody(operations, 'Dictionary<string, object> Inspect(Dictionary<string, object> req)'),
  patternCircular: csBody(operations, 'Dictionary<string, object> PatternCircular(Dictionary<string, object> req)'),
  sketchGeometry: csBody(operations, 'Dictionary<string, object> SketchGeometry(Dictionary<string, object> req)'),
  relations: csBody(relations, 'public static ISketch GetSketch(SwHost h, string designId, string name,'),
  components: csBody(assembly, 'public static Dictionary<string, object> Components(Dictionary<string, object> req)'),
}
for (const [op, body] of Object.entries(requireDocumentOps)) {
  check(`A2 ${op} 调用方不再退回当前活动文档`,
    body !== null && !body.includes('ActiveDocOrThrow'),
    body === null ? '找不到方法体' : body.match(/.*ActiveDocOrThrow.*/)?.[0]?.trim())
  check(`A2 ${op} 走 RequireDesignDocument`,
    body !== null && body.includes('RequireDesignDocument'))
}

// RequireDesignDocument 自己必须给出 DESIGN_ID_REQUIRED + knownDesignIds
const requireBody = csBody(operations, 'public static IModelDoc2 RequireDesignDocument(SwHost h, string designId, string op)')
check('A2 缺 designId 报 DESIGN_ID_REQUIRED',
  requireBody !== null && requireBody.includes('DESIGN_ID_REQUIRED')
  && /该操作必须指定 designId；未指定时不会退回到当前活动文档/.test(requireBody))
check('A2 错误 detail 带 knownDesignIds 方便自救',
  requireBody !== null && requireBody.includes('"knownDesignIds", KnownDesignIds()'))
check('A2 登记里找不到文档时报 DOC_NOT_OPEN（而不是放弃）',
  requireBody !== null && requireBody.includes('"DOC_NOT_OPEN"'),
  requireBody?.slice(0, 200))

// 整文件层面：不允许再出现「doc 为空就抓前台」这一类兜底
const fallbackLines = [...operations.matchAll(/^.*if \(doc == null\) doc = h\.ActiveDocOrThrow\(\);.*$/gm)].map((m) => m[0].trim())
check('A2 Operations.cs 里不再有 doc==null → 前台兜底', fallbackLines.length === 0, fallbackLines)

// 第二类：不收 designId 的读操作必须自报 documentFallback
const measureFallbacks = [...measure.matchAll(/OptionalDesignDocument\(h, req, "[a-z.]+", out fallback\)/g)].length
const observeFallbacks = [...observe.matchAll(/OptionalDesignDocument\(h, req, "[a-z]+", out fallback\)/g)].length
check('A2 Measure.cs 六个读操作都接受可选 designId', measureFallbacks >= 6, measureFallbacks)
check('A2 Observe.cs 五个读操作都接受可选 designId', observeFallbacks >= 5, observeFallbacks)
check('A2 返回体里带 documentFallback / documentTitle',
  /result\["documentFallback"\] = fallback/.test(operations)
  && /result\["documentTitle"\] = title/.test(operations))

// ---------------------------------------------------------------- A1：截图不动视图

const captureBody = requireDocumentOps.capture
check('A1 capture 的 mutateView 默认 false',
  captureBody !== null && captureBody.includes('Json.Bool(req, "mutateView", false)'))
check('A1 capture 的 zoomToFit 默认 false',
  captureBody !== null && captureBody.includes('Json.Bool(req, "zoomToFit", false)'))
check('A1 capture 的 hideReferenceGeometry 默认 false',
  captureBody !== null && captureBody.includes('Json.Bool(req, "hideReferenceGeometry", false)'))
check('A1 视图操作只在 mutateView:true 里执行',
  captureBody !== null && /if \(mutateView\)\s*\{[\s\S]*ShowNamedView2[\s\S]*ViewZoomtofit2[\s\S]*BlankRefGeom/.test(captureBody))
check('A1 返回体带 viewMutated',
  captureBody !== null && captureBody.includes('"viewMutated"')
  && /"zoomToFit", zoomApplied/.test(captureBody)
  && /"blankRefGeom", blankApplied/.test(captureBody)
  && /"namedView"/.test(captureBody))
check('A1 不静默忽略 view 参数（要出 warnings）',
  captureBody !== null && captureBody.includes('view 参数需要 mutateView:true 才生效')
  && captureBody.includes('warnings.Add'))
check('A1 视图调用走 TryVoid（真做成了才报 true）',
  /static bool TryVoid\(Action a\)/.test(operations) && captureBody !== null
  && /namedApplied = TryVoid/.test(captureBody)
  && /zoomApplied = TryVoid/.test(captureBody)
  && /blankApplied = TryVoid/.test(captureBody))

// 服务端 capture 工具不再给「默认 true」
const captureToolBlock = toolBlock(toolsObserve, 'capture')
check('A1 服务端 capture 工具声明 mutateView',
  captureToolBlock.includes('mutateView: z.boolean()') && captureToolBlock.includes('.default(false)'))
check('A1 服务端 capture 的 zoomToFit 默认 false',
  /zoomToFit: z\.boolean\(\)[\s\S]{0,80}\.default\(false\)/.test(captureToolBlock))
check('A1 服务端 capture 的 hideReferenceGeometry 默认 false',
  /hideReferenceGeometry: z\.boolean\(\)[\s\S]{0,80}\.default\(false\)/.test(captureToolBlock))
check('A1 服务端 capture 工具说明写明默认不改文档视图',
  captureToolBlock.includes('默认不改文档视图') && captureToolBlock.includes('mutateView'))
check('A1 服务端 capture 真的把 mutateView 发给桥接器',
  /mutateView: args\.mutateView === true/.test(toolsObserve)
  && /zoomToFit: args\.zoomToFit === true/.test(toolsObserve)
  && /hideReferenceGeometry: args\.hideReferenceGeometry === true/.test(toolsObserve))

// ---------------------------------------------------------------- A3：ui 加闸

const uiBody = csBody(operations, 'public Dictionary<string, object> Ui(Dictionary<string, object> req)')
check('A3 ui 不再有隐式 normalize 缺省',
  uiBody !== null && !uiBody.includes('Json.Str(req, "action", "normalize")')
  && uiBody.includes('Json.Str(req, "action", null)'))
check('A3 ui 不传 action 报 ACTION_REQUIRED',
  uiBody !== null && uiBody.includes('"ACTION_REQUIRED"'))
check('A3 ui 有脏文档时跳过（USER_DOC_DIRTY）',
  uiBody !== null && uiBody.includes('"USER_DOC_DIRTY"')
  && /skipped", true/.test(uiBody)
  && uiBody.includes('FirstDirtyDocumentTitle'))
check('A3 ui maximize 要求用户空闲（requireIdle:true）',
  uiBody !== null && /allowMaximize: true,\s*requireIdle: true/.test(uiBody),
  uiBody?.match(/UserInterface\.Normalize\([^)]*\)/s)?.[0])
check('A3 ui 写首选项必须是显式参数',
  uiBody !== null && /offNewsFeeds/.test(uiBody))

const userInterfaceNormalize = csBody(userInterface, 'public static Dictionary<string, object> Normalize(')
check('A3 首选项默认不写（writeNewsFeeds 默认 false）',
  /bool writeNewsFeeds = false/.test(userInterface))
check('A3 只在显式要求时才 SetUserPreferenceToggle，并回读确认',
  userInterfaceNormalize !== null
  && /if \(writeNewsFeeds\)[\s\S]{0,200}SetUserPreferenceToggle[\s\S]{0,400}newsWritten = true/.test(userInterfaceNormalize))
check('A3 返回体记录原值 restoredPreference',
  userInterfaceNormalize !== null && userInterfaceNormalize.includes('"restoredPreference"')
  && userInterfaceNormalize.includes('"showNewsFeedsInTaskPane", newsReadable ? (object)newsBefore : null'))
check('A3 自动路径仍然不允许最大化（SwHost 的 allowMaximize 保持 false）',
  /UserInterface\.Normalize\(\s*App, pid, allowMaximize: auto, requireIdle: true\)/.test(read('bridge/src/SwHost.cs')))

const uiCaseAt = server.indexOf("case 'ui': {")
const uiCase = uiCaseAt < 0 ? '' : server.slice(uiCaseAt, uiCaseAt + 2600)
const serverCode = stripComments(server)
check('A3 服务端不再用 args.uiAction ?? normalize 的隐式缺省',
  !serverCode.includes("args.uiAction ?? 'normalize'"),
  serverCode.match(/.*uiAction \?\?.*/)?.[0])
check('A3 服务端 ui 无 action 报 ACTION_REQUIRED',
  uiCase.includes('ACTION_REQUIRED') && uiCase.includes('if (!args.uiAction)'))
check('A3 服务端把 skipped 当成功并说明原因',
  uiCase.includes('result.skipped === true') && uiCase.includes('跳过窗口整理'))

// ---------------------------------------------------------------- A4：还回原来的文档

const dispatchBody = csBody(operations, 'Dictionary<string, object> DispatchUnlocked(string op, Dictionary<string, object> req)')
check('A4 Dispatch 入口记录原来的活动文档标题',
  dispatchBody !== null && /originalActiveTitle = ActiveDocumentTitle\(h\.App\)/.test(dispatchBody))
check('A4 正常返回时还回活动文档',
  dispatchBody !== null && dispatchBody.includes('WithRestoredDocument(result, originalActiveTitle)'))
check('A4 抛错时也还回活动文档',
  dispatchBody !== null && /catch\s*\{[\s\S]{0,200}RestoreActiveDocument\(originalActiveTitle\)/.test(dispatchBody))
const restoreBody = csBody(operations, 'static string RestoreActiveDocument(string title)')
check('A4 恢复用 ActivateDoc3 + swDontRebuildActiveDoc（复用 Documents.Activate）',
  restoreBody !== null && restoreBody.includes('Documents.Activate(h.App, title)')
  && /ActivateDoc3\(title, false,\s*\(int\)swRebuildOnActivation_e\.swDontRebuildActiveDoc, ref errors\)/.test(documents))
check('A4 恢复失败只记 warnings，不抛错',
  restoreBody !== null && !restoreBody.includes('throw ')
  && /AddWarning\(result, "操作把活动文档切走了，但切回/.test(operations))
check('A4 返回体带 restoredActiveDocument',
  /result\["restoredActiveDocument"\] = restored/.test(operations))

// ---------------------------------------------------------------- A5：不许静默丢弃未存盘

check('A5 CloseByTitle 增加脏文档归属检查',
  /if \(dirty && allowDirty && !IsOwnedTitle\(title, sessionId, designId\)\)[\s\S]{0,200}skippedReason = "USER_DOC_DIRTY"/.test(documents))
check('A5 IsOwnedTitle 只认 build/create 来源且不含别的会话',
  /public static bool IsOwnedTitle\(string title, string sessionId, string designId\)/.test(documents)
  && /WorkRegistry\.IsCreatedOrigin\(entry\.Origin\)/.test(documents)
  && /WorkRegistry\.IsForeignSession\(entry, sessionId\)/.test(documents))
check('A5 CloseDesign 把拒绝原因交回调用方（不再无条件 Forget）',
  /public static CloseResult CloseDesign\(ISldWorks app, string designId, string sessionId\)/.test(documents)
  && /if \(closed == null && reason != null\)[\s\S]{0,200}outcome\.Reason = reason;\s*return outcome;/.test(documents))
check('A5 build 前置关闭只认本会话建出来的文档，并回报两份清单',
  /Documents\.CloseResult previous = Documents\.CloseDesign\(h\.App, requestedId, sessionId\)/.test(operations)
  && /Documents\.CloseResult previous = Documents\.CloseDesign\(h\.App, requestedId, sketchSessionId\)/.test(operations)
  && /"closedDocuments", closedDocuments/.test(operations)
  && /"skippedDirty", skippedDirty/.test(operations))
check('A5 cleanup 返回 closedDocuments / skippedDirty',
  /"closedDocuments", sweep\.ClosedRecords/.test(operations)
  && /"skippedDirty", sweep\.SkippedDirty/.test(operations))

// ---------------------------------------------------------------- A6：人设硬规则

check('A6 人设：未存盘时禁 ui/cleanup/reap',
  /- 用户有未存盘件（标题带 \*）：禁 `workspace action="ui"`\/`"cleanup"`\/`"reap"`/.test(patch))
check('A6 人设：op 必带 designId',
  /- 建模\/检查 op 必带 designId；不带报 `DESIGN_ID_REQUIRED`/.test(patch))
check('A6 人设：截图默认不改视图 + mutateView',
  /- 截图默认不改文档视图；要视角传 `mutateView:true`/.test(patch))

// ---------------------------------------------------------------- 生成物没有被改坏

const dispatchCheck = spawnSync(process.execPath, [join(repoRoot, 'tools', 'gen-dispatch.mjs'), '--check'], {
  cwd: repoRoot, encoding: 'utf8',
})
check('dispatch 能力表与 Operations.cs 一致（DispatchUnlocked 重构没有破坏生成器）',
  dispatchCheck.status === 0, { status: dispatchCheck.status, stderr: dispatchCheck.stderr?.slice(-400) })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exit(1)
}
