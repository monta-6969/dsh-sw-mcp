// Observation tools: look at the model, mean a face twice, and show a picture.
//
// These live in their own module because each one is a small policy decision on
// top of a bridge operation, and server.mjs is already long enough that those
// decisions get lost in it.
//
// The shared idea: nothing here guesses. A face is named by the persistent
// reference SOLIDWORKS itself hands out, and a claim about the picture is made
// by the renderer that drew it — not by mapping coordinates into an image frame
// whose basis we would have to reverse-engineer.

import { describeMeasure, measureHints } from './verify.mjs'
import { describeEvidence, loadDrawing, validateDrawing } from './drawing-evidence.mjs'
import { createSnapshot, describeSnapshot } from './snapshot.mjs'
import { DESCRIPTIONS } from './tool-face.mjs'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join as pathJoin, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = dirname(fileURLToPath(import.meta.url))

/** 读 review-gate.js 落的状态盘：每个会话一条最新记录，取最近更新的那条。 */
function readReviewState({ designId, documentPath } = {}) {
  // 没有 designId 就不猜。以前会退回「所有会话里最新的一条」，于是本会话问
  // 「这一版审过没有」，拿回来的是别的零件（实测拿到 gate-live 的 passed）——
  // 「找到了」在这里比「找不到」危险得多。
  if (typeof designId !== 'string' || designId.length === 0) {
    return { record: null, path: null, tried: [], count: 0, reason: 'NO_DESIGN_ID' }
  }
  // SW_MCP_DATA 一设就只认它：测试要的是「这一盘里没有记录」，
  // 回退到真盘会把别的会话的结论当成本次的，那种「找到了」比找不到更糟。
  const roots = process.env.SW_MCP_DATA
    ? [process.env.SW_MCP_DATA]
    : [
      process.env.LOCALAPPDATA ? pathJoin(process.env.LOCALAPPDATA, 'sw-mcp') : null,
      pathJoin(homedir(), 'AppData', 'Local', 'sw-mcp'),
    ]
  const tried = []
  for (const root of roots) {
    if (!root) continue
    const file = pathJoin(root, 'review', 'runs.json')
    tried.push(file)
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let store
    try {
      store = JSON.parse(raw)
    } catch {
      continue
    }
    const sessions = Object.values(store?.sessions ?? {}).filter((r) => r && typeof r === 'object')
    if (sessions.length === 0) return { record: null, path: file, tried, count: 0 }
    // designId 是主键；documentPath 给得更细时再比一次 —— 同一个设计可能先后
    // 落在两个零件文件上，只按 designId 匹配会把上一版的结论当这一版。
    const scoped = sessions.filter((r) => r.designId === designId
      && (typeof documentPath !== 'string' || documentPath.length === 0 || r.documentPath === documentPath))
    // 指定了 designId 就必须是它的记录：退回「所有会话里最新的一条」会把别的零件的
    // 结论当成本次的结论 —— 「找到了」在这里比找不到危险得多。
    if (scoped.length === 0) return { record: null, path: file, tried, count: sessions.length, reason: 'NO_MATCH' }
    const pool = scoped
    pool.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return { record: pool[0], path: file, tried, count: sessions.length }
  }
  return { record: null, path: null, tried, count: 0 }
}


// 工具产出的图片落在这里，名字短、可覆盖，进程启动时清一次。
// 之前的做法是往 %TEMP% 写 figure-<13位毫秒>.png，名字没意义又永远不删。
let IMAGE_DIR = null
let imageSeq = 0
const LEGACY_PNG = /^(figure-d{10,}|sw-capture-d{10,}|sw-inspect-d{10,}|cmp-|compare-).*.(png|bmp)$/

/** 清旧图：自己的暂存目录保留最近 keep 张且两天内；%TEMP% 里旧命名的只清一天前的。 */
function pruneImages({ keep = 200, maxAgeDays = 2, tmp } = {}) {
  if (typeof IMAGE_DIR !== 'string') return 0
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
  let removed = 0
  try {
    if (existsSync(IMAGE_DIR)) {
      const files = readdirSync(IMAGE_DIR)
        .filter((n) => n.endsWith('.png'))
        .map((n) => ({ name: n, at: statSync(pathJoin(IMAGE_DIR, n)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const [index, file] of files.entries()) {
        if (index < keep && file.at > cutoff) continue
        try { unlinkSync(pathJoin(IMAGE_DIR, file.name)); removed += 1 } catch {}
      }
    }
  } catch {}
  try {
    const dayAgo = Date.now() - 24 * 3600 * 1000
    if (typeof tmp === 'string' && existsSync(tmp)) {
      for (const name of readdirSync(tmp)) {
        if (!LEGACY_PNG.test(name)) continue
        const full = pathJoin(tmp, name)
        try {
          if (statSync(full).mtimeMs > dayAgo) continue
          unlinkSync(full)
          removed += 1
        } catch {}
      }
    }
  } catch {}
  return removed
}

/** 短名：fig-07.png / cmp-03.png / shot-12.png，序号在同一进程里递增。 */
function imagePath(kind, wanted) {
  if (!IMAGE_DIR) throw new Error("imagePath used before registerObserveTools")
  if (wanted) return wanted.toLowerCase().endsWith(".png") ? wanted : `${wanted}.png`
  mkdirSync(IMAGE_DIR, { recursive: true })
  imageSeq += 1
  if (imageSeq % 20 === 0) pruneImages()
  return pathJoin(IMAGE_DIR, `${kind}-${String(imageSeq).padStart(2, "0")}.png`)
}
const figureScript = pathJoin(serverDir, 'figure.ps1')
const compareScript = pathJoin(serverDir, 'compare.ps1')

/** Runs server/figure.ps1 and returns its JSON line, or throws with its stderr.
 *
 * The script does the pixel work (crop, zoom, grid, contrast); this wrapper only
 * decides the arguments. Plate-scale drawings are unreadable at full page size —
 * a 225 mm part in a 700 px scan is 2 px/mm — so "zoom into that corner" has to
 * be one call, not a round of guesswork. */
/** 裁剪框的几种自然写法 → [x0, y0, x1, y1]（源图像素）。
 *
 * 收下这些：`[x0,y0,x1,y1]`、`{x,y,width,height}`、`{x,y,w,h}`、`{left,top,right,bottom}`。
 * 看不懂就返回 null，让调用方用整页 —— 猜错一个框比不裁更糟。
 */
function normalizeCrop(spec, width, height) {
  if (spec === null || spec === undefined) return null
  if (Array.isArray(spec)) {
    const nums = spec.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    if (nums.length === 4) return nums
    if (nums.length === 2) return [0, 0, nums[0], nums[1]]
    return null
  }
  if (typeof spec !== 'object') return null
  const x = Number(spec.x ?? spec.left ?? 0)
  const y = Number(spec.y ?? spec.top ?? 0)
  const w = Number(spec.width ?? spec.w ?? NaN)
  const h = Number(spec.height ?? spec.h ?? NaN)
  if (Number.isFinite(w) && Number.isFinite(h)) {
    return [x, y, Math.min(width, x + w), Math.min(height, y + h)]
  }
  const right = Number(spec.right ?? NaN)
  const bottom = Number(spec.bottom ?? NaN)
  if (Number.isFinite(right) && Number.isFinite(bottom)) return [x, y, right, bottom]
  return null
}

function runFigure({ source, output, crop, scale, grid, contrast, probe }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', figureScript,
    '-In', source, '-Out', output ?? `${source}.figure.png`]
  if (probe) args.push('-Probe')
  else {
    if (crop) args.push('-Crop', crop.join(','))
    if (typeof scale === 'number') args.push('-Scale', String(scale))
    if (grid) args.push('-Grid', String(grid))
    if (contrast) args.push('-Contrast', String(contrast))
  }
  const run = spawnSync('powershell', args, { encoding: 'utf8', timeout: 120_000 })
  const line = (run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line || !line.startsWith('{')) {
    throw new Error(`figure.ps1 没有返回 JSON（exit ${run.status}）：${(run.stderr ?? '').trim().slice(-300)}`)
  }
  return JSON.parse(line)
}

/** 图纸文件不在时，把同目录下「去掉空格后最像」的几个名字摆出来。
 *
 * 实测：那张图纸的真名里有一个空格（`练习图纸 .png`），模型顺手把空格删掉，只拿到
 * 一句 FileNotFoundException —— 那句话里没有候选，它没法自救，只能回头对用户说
 * 「识别不了」。这里替它把同目录的候选列出来，空格/中文都不是问题。 */
function closestFiles(source) {
  const dir = dirname(source)
  const target = stripSpaces(basename(source))
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { dir, candidates: [] }
  }
  const scored = []
  for (const name of names) {
    const full = pathJoin(dir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    const key = stripSpaces(name)
    // 去掉空格后一模一样就是它（这就是本次故障：只差一个 U+0020）；含得下也算近。
    const score = key === target ? 0 : (key.includes(target) || target.includes(key) ? 1 : nameDistance(target, key))
    scored.push({ name, path: full, score })
  }
  scored.sort((a, b) => a.score - b.score)
  const limit = Math.max(2, Math.ceil(target.length / 3))
  return { dir, candidates: scored.filter((item) => item.score <= limit).slice(0, 3) }
}

/** 只用来给候选名排序：去掉半角/全角空格再比，大小写不敏感。 */
function stripSpaces(name) {
  return name.replace(/[\s\u3000]/g, '').toLowerCase()
}

/** 编辑距离，只用在候选名排序上（名字不对时的「你大概想说的是哪个」）。 */
function nameDistance(a, b) {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
    const cur = [i]
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 扩展名与内容不符时给模型的那一句：说清「照样能取图」，也说清产物才是给别人用的。 */
function formatMismatchHint(source, contentFormat) {
  return `扩展名与实际内容不符（${extname(source) || '无扩展名'} 实际是 ${contentFormat}），`
    + '系统按内容解码，可正常取图；若要给别的读图工具用，请读 figure 产出的 PNG'
}

/** Puts a drawing crop next to a model view, at the same height, so the two can be
 * compared by eye in one look instead of two.
 *
 * Deliberately does NOT try to score the match pixel by pixel: a scanned drawing is
 * not to scale (measured 1.15–2.33 px/mm inside a single sheet), and a shaded model
 * has no line weight to compare with. What is worth comparing — "is the outline in the
 * same place, is the hole at the same height" — is answered by the measurements in
 * `inspect action=verify`, not by overlaying two pictures that were never drawn at the
 * same scale. */
function runCompare({ left, right, out, labelLeft, labelRight, caption, height }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', compareScript,
    '-Left', left, '-Right', right, '-Out', out]
  if (labelLeft) args.push('-LabelLeft', labelLeft)
  if (labelRight) args.push('-LabelRight', labelRight)
  if (caption) args.push('-Caption', caption)
  if (typeof height === 'number') args.push('-Height', String(height))
  const run = spawnSync('powershell', args, { encoding: 'utf8', timeout: 120_000 })
  const line = (run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (!line || !line.startsWith('{')) {
    throw new Error(`compare.ps1 没有返回 JSON（exit ${run.status}）：${(run.stderr ?? '').trim().slice(-300)}`)
  }
  return JSON.parse(line)
}

export function registerObserveTools(server, z, deps) {
  if (!IMAGE_DIR) IMAGE_DIR = pathJoin(deps.dataDir ?? pathJoin(deps.tmpdir(), 'sw-mcp'), 'images')
  pruneImages({ tmp: deps.tmpdir() })
  const {
    envelope, ok, failed, fail, callBridge, resolveDesignId, designIdArg,
    readFileSync, join, tmpdir, dataDir, handlePartCheck, handlePartInspect, handlePartExport,
    recordRelationAudit,
    // F2：本设计自己的实时 revision（relations 审计落账必须带它）。
    liveRevisionOf,
    // F6：文档身份核对（量到的标题 ≠ designId 登记名 → WRONG_DOCUMENT）。
    documentIdentityCheck,
    // F3：缺 designId 直接报 DESIGN_ID_REQUIRED。
    requireDesignId,
  } = deps

  /** F3：observe 里凡是「要量/要看/要拍某一份」的动作都必带 designId。 */
  function needDesignId(given, action) {
    if (typeof requireDesignId === 'function') return requireDesignId(given, { tool: 'inspect', action })
    return resolveDesignId(given)
  }

  /** F6：回包里带的 document 与 designId 登记不一致时直接把这段数字判掉。 */
  function identityFailure(designId, document) {
    if (typeof documentIdentityCheck !== 'function') return null
    const verdict = documentIdentityCheck({ designId, document })
    return verdict?.ok === true ? null : verdict.error
  }

  /**
   * F5：figure 的嵌套参数校验。
   *
   * 报错必须给**可复制的正确形态**：取证里 5 次无效往返全部来自「键名/类型写错，
   * 而报错只说没有这个键」。这里把三种实际撞过的写法单独点名：
   *   figure.imagePath → 那是 inspect 顶层预览图的键，图纸路径是 figure.source
   *   figure.grid:true  → grid 是源图像素步长，不是开关（要网格写数字）
   *   crop + x/y 同给   → 二选一，混着写以前会被静默忽略一种
   */
  const FIGURE_SPEC_KEYS = new Set([
    'op', 'source', 'path', 'image', 'file', 'output', 'crop', 'region', 'box',
    'x', 'y', 'width', 'height', 'w', 'h', 'scale', 'grid', 'contrast', 'maxSide',
  ])
  const FIGURE_EXAMPLE = '{"action":"figure","figure":{"source":"<图纸绝对路径>","op":"crop",'
    + '"crop":[x0,y0,x1,y1],"scale":4,"grid":40}}'
  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }
  function isRect(value) {
    if (Array.isArray(value)) return value.length === 4 && value.every(isFiniteNumber)
    if (value !== null && typeof value === 'object') {
      return isFiniteNumber(value.x) && isFiniteNumber(value.y)
        && isFiniteNumber(value.width ?? value.w) && isFiniteNumber(value.height ?? value.h)
    }
    return false
  }
  function validateFigureSpec(spec) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      return fail('UNKNOWN_PARAM', `inspect action=figure 的 figure 必须是对象。正确形态：${FIGURE_EXAMPLE}`, {
        example: FIGURE_EXAMPLE,
      })
    }
    const unknown = Object.keys(spec).filter((key) => !FIGURE_SPEC_KEYS.has(key))
    if (unknown.length > 0) {
      const hints = unknown.map((key) => {
        const lower = key.toLowerCase()
        if (lower === 'imagepath' || lower === 'imagedir') return `${key} → figure.source（imagePath 是 inspect 顶层预览图的键，不是图纸路径）`
        if (lower === 'path' || lower === 'file' || lower === 'image') return `${key} 也是 figure.source 的别名`
        if (lower === 'zoom') return `${key} → figure.scale（放大倍数）`
        if (lower === 'step') return `${key} → figure.grid（网格步长，像素）`
        return `${key} 不是 figure 的键，去掉它`
      })
      return fail('UNKNOWN_PARAM',
        `inspect action=figure 不认 figure 里的这些键：${unknown.join(', ')}。${hints.join('；')}。`
          + `正确形态：${FIGURE_EXAMPLE}`,
        { unknown, legal: [...FIGURE_SPEC_KEYS], example: FIGURE_EXAMPLE })
    }
    if (spec.grid !== undefined && typeof spec.grid !== 'number') {
      return fail('UNKNOWN_PARAM',
        `figure.grid 必须是数字（源图像素步长），收到 ${JSON.stringify(spec.grid)}。`
          + ' 要网格写 grid:40，不要写 grid:true（以前只报 "expected number, received boolean"，没有指路）。'
          + ` 正确形态：${FIGURE_EXAMPLE}`,
        { received: spec.grid, example: FIGURE_EXAMPLE })
    }
    if (spec.grid !== undefined && (!isFiniteNumber(spec.grid) || spec.grid < 0)) {
      return fail('UNKNOWN_PARAM', `figure.grid 必须是 >=0 的数字（0 = 不画网格），收到 ${JSON.stringify(spec.grid)}。正确形态：${FIGURE_EXAMPLE}`,
        { received: spec.grid, example: FIGURE_EXAMPLE })
    }
    const rectKey = ['crop', 'region', 'box'].find((key) => spec[key] !== undefined)
    const usesXY = ['x', 'y', 'width', 'height', 'w', 'h'].some((key) => spec[key] !== undefined)
    if (rectKey !== undefined && usesXY) {
      return fail('UNKNOWN_PARAM',
        `figure.${rectKey} 和 figure.x/y/width/height 只能二选一，不要混着写（以前混写时其中一种被静默忽略）。`
          + ` 二选一：{"crop":[x0,y0,x1,y1]} 或 {"x":0,"y":0,"width":120,"height":80}。`
          + ` 正确形态：${FIGURE_EXAMPLE}`,
        { rectKey, example: FIGURE_EXAMPLE })
    }
    if (rectKey !== undefined && !isRect(spec[rectKey])) {
      return fail('UNKNOWN_PARAM',
        `figure.${rectKey} 形状不对：要 [x0,y0,x1,y1] 四个数，或 {x,y,width,height}（都是源图像素，mm 不行）。`
          + ` 收到 ${JSON.stringify(spec[rectKey])}。正确形态：${FIGURE_EXAMPLE}`,
        { received: spec[rectKey], example: FIGURE_EXAMPLE })
    }
    if (usesXY && !(isFiniteNumber(spec.x) && isFiniteNumber(spec.y)
      && isFiniteNumber(spec.width ?? spec.w) && isFiniteNumber(spec.height ?? spec.h))) {
      return fail('UNKNOWN_PARAM',
        'figure.x/y/width/height 四个都要给（数字，源图像素）：以前少给一个就整页缩一遍，模型以为裁过了。'
          + ` 正确形态：${FIGURE_EXAMPLE}`,
        { x: spec.x, y: spec.y, width: spec.width ?? spec.w, height: spec.height ?? spec.h, example: FIGURE_EXAMPLE })
    }
    for (const key of ['scale', 'contrast', 'maxSide']) {
      if (spec[key] !== undefined && !isFiniteNumber(spec[key])) {
        return fail('UNKNOWN_PARAM', `figure.${key} 必须是数字，收到 ${JSON.stringify(spec[key])}。`, {
          received: spec[key], example: FIGURE_EXAMPLE,
        })
      }
    }
    return null
  }

  // ------------------------------------------------------------------ inspect

  server.registerTool(
    'inspect',
    {
      title: '看模型',
      description: DESCRIPTIONS.inspect,
      inputSchema: z.object({
        action: z.enum(['model', 'faces', 'bodies', 'verify', 'assembly', 'assemblyFaces', 'mates', 'relations', 'dimensions', 'measure', 'sketch', 'figure', 'compare', 'evidence', 'review', 'snapshot']).default('model')
          .describe('要看什么：model（特征树/尺寸/方程）· faces（每张面）· bodies（各实体）· '
            + 'verify（核对期望值；改过几何或尺寸之后必须重跑一次，旧读数不是这一版的证据）· '
            + 'assembly（装配组件）· relations（草图几何关系）· measure（语义测量：孔/轴/间距/距离）· '
            + 'figure（图纸裁剪放大）· compare（图纸与模型并排对照）'),
        designId: designIdArg,
        drawingPath: z.string().optional().describe('evidence 动作：直接指向一份读图记录；省略时按 designId 找 drawings/<id>/drawing.json'),
        documentPath: z.string().optional().describe('review 动作：模型的零件文件全路径；给了就连同 designId 一起匹配，避免把上一版或别的零件的结论当这一版'),
        format: z.enum(['tree', 'geometry', 'both']).default('both').describe('model 动作要看的内容'),
        includeImage: z.boolean().optional().describe('是否把预览图作为图片返回，默认 false'),
        imagePath: z.string().optional().describe('预览图落盘路径'),
        width: z.number().int().min(320).max(2560).optional().describe('图宽，默认 1280'),
        height: z.number().int().min(240).max(1600).optional().describe('图高，默认 800'),
        limit: z.number().int().min(1).max(1000).default(200).describe('faces 动作最多返回多少张面'),
        sketch: z.string().optional().describe('relations 动作看哪张草图（按特征名）；省略时看最后一张'),
        apply: z.boolean().optional().describe('relations 动作：true = 把推断出来的关系写进草图（只读实例会被 READ_ONLY_TOOLSET 拒）'),
        tolerance: z.number().optional().describe('relations 动作的几何容差，mm，默认 0.02'),
        relationAction: z.enum(['list', 'add', 'remove', 'edit', 'infer', 'apply', 'clear']).optional()
          .describe('relations 动作；只读实例只放行 list/infer，写子动作在进入桥接器之前就以 READ_ONLY_TOOLSET 拒'),
        relations: z.array(z.object({
          type: z.string().describe('关系类型：coincident / tangent / concentric / equal / parallel / perpendicular / horizontal / vertical / symmetric / midpoint / fix'),
          refs: z.array(z.string()).optional().describe('引用：seg:<1 基序号>[:start|end|center] 或 curve:<曲线 id>[:start|end|center]'),
        }).passthrough()).optional().describe('relations add/edit 要加/改的关系'),
        relationIds: z.array(z.number().int()).optional().describe('relations remove/edit 的关系序号（1 基，list 返回的 index）'),
        confirm: z.boolean().optional().describe('relations clear 必须为 true'),
        atomic: z.boolean().optional().describe('relations add：失败时回滚本次新增（默认 true）'),
        dimensionAction: z.enum(['list', 'add', 'edit', 'remove']).optional()
          .describe('dimensions 动作；只读实例只放行 list，其余以 READ_ONLY_TOOLSET 拒。'
            + 'add/edit 必须能在目标草图里选中并进入编辑态，否则 SKETCH_NOT_EDITABLE；'
            + '落成参考尺寸（reference=true）时写动作会报 failed/DIMENSION_NOT_DRIVING —— '
            + '参考尺寸读得出来，但改它模型不动'),
        dimensions: z.array(z.object({
          kind: z.enum(['distance', 'diameter', 'radius', 'angle']).optional().describe('尺寸类型'),
          refs: z.array(z.string()).optional().describe('引用：seg:<序号> 或 curve:<曲线 id>'),
          valueMm: z.number().optional().describe('尺寸值，mm（角度用度）'),
          name: z.string().optional().describe('尺寸名'),
          index: z.number().int().optional().describe('edit/remove 的 1 基序号'),
          position: z.object({ xMm: z.number(), yMm: z.number() }).passthrough().optional().describe('尺寸文字位置，mm'),
        }).passthrough()).optional().describe('dimensions add/edit 的尺寸定义'),
        expect: z
          .object({
            volume: z.number().optional().describe('期望体积，mm³（只是辅助观察，不参与验收判定）'),
            tolerance: z.number().optional().describe('体积相对容差，默认 0.001'),
            size: z.array(z.number()).length(3).optional().describe('期望包围盒 [x,y,z]，mm（进主判定）'),
            holes: z.number().int().optional().describe('期望通孔的数量（默认只数通孔；要数全部圆柱面用 checks 里 args.all）'),
            holeCount: z.number().int().optional().describe('holes 的别名'),
            holeDiameter: z.number().optional().describe('配合 holes 用：只数这个直径的孔'),
            parametric: z.boolean().optional().describe('是否要求每个参数都绑在原生尺寸上'),
            checks: z
              .array(z.object({
                name: z.string().describe('这一条查什么，例如「主孔轴线高」'),
                measure: z.enum(['axis', 'spacing', 'distance', 'holes', 'cylinders', 'planes']).describe('用哪种测量'),
                args: z.object({}).passthrough().optional().describe('传给测量的参数，例如 {diameter:40} 或 {a:{plane:"minY"},b:{plane:"maxY"}}'),
                pick: z.string().optional().describe('从测量结果里取哪个数，例如 "matches[0].diameter"；省略时按测量类型取常见项'),
                expect: z.number().optional().describe('期望值'),
                tol: z.number().optional().describe('容差（绝对，mm 或缺省 0.02）'),
                any: z.boolean().optional().describe('为 true 时只要候选值里有一个落在容差内就算通过'),
                candidates: z.string().optional().describe('any=true 时从哪个数组取候选，例如 "pairs"'),
                index: z.number().optional().describe('有多条候选时明确取第几条（从 0 起）。不写而候选多于一条时，这条会记成「没量成/有歧义」而不是碰巧对上'),
                allowFirst: z.boolean().optional().describe('明确表示「接受第一条候选」。默认不接受：同直径两个孔取第一条等于猜'),
              }))
              .optional()
              .describe('逐条语义核对。这些才决定验收通过与否：体积和包围盒证明不了「按图纸建对了」'),
          })
          .passthrough()
          .optional()
          .describe('verify 的验收条件：checks 决定通过与否，体积/包围盒只作辅助'),
        tiers: z.array(z.enum(['file', 'geometry', 'dimensions', 'positions', 'topology', 'assembly'])).optional()
          .describe('档位验收：按 design.json 里记录的期望值逐档核对。没记录的项记 unmeasured（不算通过）；'
            + 'file=文件字节与哈希，geometry=体积/实体数，dimensions=包围盒与各孔径数量，positions=孔心/孔距，'
            + 'topology=单实体与开口边，assembly=组件数与干涉（零件会标 skipped）'),
        measure: z
          .object({ kind: z.enum(['faces', 'cylinders', 'holes', 'axis', 'spacing', 'distance', 'planes', 'helix']) })
          .passthrough()
          .optional()
          .describe('measure 动作要测什么（kind 见 schema；holes 列孔，axis 取轴线位置与高度，spacing 取两孔轴线距离，distance 取点到面/面的距离）'),
        figure: z
          .object({
            op: z.enum(['info', 'crop', 'fit', 'frame']).optional().describe('info=只问尺寸；crop=裁一块放大；fit=整图缩到能看清布局；frame=整图加网格'),
            source: z.string().optional().describe('图纸文件路径（png/jpg/bmp）'),
            output: z.string().optional().describe('输出 PNG 路径；省略时写到临时目录'),
            // 裁剪框三种写法都收：数组 / {x,y,w,h} / {left,top,right,bottom}。
            // 只声明数组时，写成对象会在进入工具之前被 schema 拒掉 —— 实测就是这样
            // 白试了五次。
            crop: z.union([
              z.array(z.number()).length(4),
              z.object({ x: z.number(), y: z.number() }).passthrough(),
            ]).optional().describe('[x0,y0,x1,y1] 或 {x,y,width,height}，源图像素坐标'),
            region: z.union([z.array(z.number()).length(4), z.object({ x: z.number(), y: z.number() }).passthrough()])
              .optional().describe('crop 的别名'),
            box: z.union([z.array(z.number()).length(4), z.object({ x: z.number(), y: z.number() }).passthrough()])
              .optional().describe('crop 的别名'),
            x: z.number().optional().describe('裁剪框左上角 x（配合 width/height 使用）'),
            y: z.number().optional().describe('裁剪框左上角 y'),
            width: z.number().optional().describe('裁剪框宽'),
            height: z.number().optional().describe('裁剪框高'),
            w: z.number().optional().describe('width 的别名'),
            h: z.number().optional().describe('height 的别名'),
            path: z.string().optional().describe('source 的别名'),
            scale: z.number().optional().describe('放大倍数；省略时 crop 用 4，fit 用自动值'),
            grid: z.union([z.number(), z.boolean()]).optional()
              .describe('网格步长（源图像素，数字；0=关）。**不是开关**：写 grid:true 会被拒并告诉你写数字'),
            contrast: z.number().optional().describe('0..100，扫描件提对比度'),
            maxSide: z.number().optional().describe('fit 时输出长边的上限像素，默认 1400'),
          })
          .passthrough()
          .optional()
          .describe('figure 动作：把图纸裁一块放大到能读清尺寸标注；返回的图与裁剪信息同源，map 给出 源坐标 = crop 原点 + 图内坐标 / scale。直接打开图纸文件可能因扩展名与内容不符被拒，用 figure 取图。'),
        compare: z
          .object({
            drawing: z.string().describe('参考图纸文件路径（扫描件/截图都行）'),
            crop: z.array(z.number()).length(4).optional().describe('图纸上要裁的矩形 [x0,y0,x1,y1]（源图像素）；省略用整张'),
            view: z.enum(['front', 'top', 'right', 'iso', 'back', 'left']).optional().describe('模型用哪个视图去对照，默认 front'),
            scale: z.number().optional().describe('图纸裁块的放大倍数，默认 2'),
            contrast: z.number().optional().describe('图纸对比度提升 0..100，默认 20'),
            labelLeft: z.string().optional().describe('左图标题，默认「图纸」'),
            labelRight: z.string().optional().describe('右图标题，默认「模型 <视图>」'),
            caption: z.string().optional().describe('整张合成图顶部的一行说明'),
            output: z.string().optional().describe('合成图落盘路径；省略时写到临时目录'),
          })
          .passthrough()
          .optional()
          .describe('compare 动作：把图纸上的一个视图和模型的对应视图并排放进一张图。'
            + '这张图是给人看的，不是判据 —— 判据是 inspect action=verify 的语义核对'),
        measures: z
          .array(
            z.object({
              name: z.string().optional(),
              measure: z.object({ kind: z.string() }).passthrough(),
            }),
          )
          .optional()
          .describe('snapshot 动作：跟着这个版本一起取的测量（各条独立，失败的那条记在 missing 里）'),
        artifactPath: z
          .string()
          .optional()
          .describe('snapshot 动作：已导出的文件路径；给了就把它的指纹一起钉进快照'),
      }),
    },
    async (args) => {
      if (args.action === 'verify') return handlePartCheck(args)
      if (args.action === 'evidence') {
        // 读图记录的「能不能被追溯」由代码判，不由模型自述。这份记录是后面
        // 「独立审查」能成立的唯一理由：审查者要看的是同一份带指向的说明，
        // 而不是模型临时回忆的几句话。
        const loaded = loadDrawing({ repoRoot: deps.repoRoot ?? pathJoin(serverDir, '..'), designId: args.designId, path: args.drawingPath })
        if (!loaded.doc) {
          return failed({
            op: 'inspect.evidence',
            error: Object.assign(new Error(`没有找到读图记录（试过 ${(loaded.tried ?? []).join(' ; ')}）`), {
              code: 'NO_EVIDENCE',
            }),
            nextActions: [
              '先用 inspect action="figure" 放大看图纸，把视图/标注/尺寸链/特征写成 drawings/<designId>/drawing.json',
              '也可以直接传 drawingPath 指向一份现成的读图记录',
            ],
          })
        }
        const verdict = validateDrawing(loaded.doc)
        return ok(
          envelope({
            summary: `${describeEvidence(verdict)}${verdict.ok ? '' : '；先补齐再建模'}`,
            designId: args.designId ?? loaded.doc.drawingId,
            status: verdict.ok ? 'ok' : 'failed',
            changes: {
              path: loaded.path,
              schemaVersion: loaded.doc.schemaVersion,
              projection: loaded.doc.projection?.kind,
              stats: verdict.stats,
              errors: verdict.errors,
              notes: verdict.notes,
              openQuestions: verdict.openQuestions,
            },
            nextActions: verdict.ok
              ? (verdict.openQuestions.length
                ? ['这些待澄清项要在建模前问清楚，或者写进 assumptions 并说明取舍']
                : undefined)
              : ['按 errors[].where 补齐：每条标注要有 anchor 与 view，每个特征要有 from，尺寸链的项必须真实存在'],
          }),
        )
      }
      if (args.action === 'snapshot') {
        // 图、测量、文件指纹在同一个持锁窗口里取（桥接器的写操作本来就串行），
        // 取完绑成一个 snapshotId。这是「审查的是这一版、交付的也是这一版」的地基。
        const started = Date.now()
        try {
          const record = await createSnapshot({
            callBridge,
            designId: resolveDesignId(args.designId),
            measures: args.measures ?? [],
            view: args.view,
            caption: args.caption,
            width: args.width ?? 1280,
            height: args.height ?? 800,
            artifactPath: args.artifactPath,
          })
          const bytes = readFileSync(record.image.path)
          const env = envelope({
            summary: describeSnapshot(record),
            designId: record.designId ?? args.designId,
            status: (record.missing ?? []).length === 0 ? 'ok' : 'partial',
            changes: {
              snapshotId: record.snapshotId,
              schemaVersion: record.schemaVersion,
              sameTurn: record.sameTurn,
              document: record.document,
              image: record.image,
              measurements: record.measurements,
              features: record.features,
              artifact: record.artifact,
              digests: record.digests,
              missing: record.missing,
              at: record.at,
            },
            artifacts: [{ kind: 'image', path: record.image.path, mimeType: 'image/png' }],
            timings: { snapshotMs: Date.now() - started },
            nextActions: (record.missing ?? []).length > 0
              ? ['这几条没量成：先看 measure 报的错（目标不存在 / 歧义 / 文档不对），再重取快照']
              : ['把 snapshotId 连同审查结论一起引用；交付时传 artifactPath 再取一次，就能证明交付的就是审过的那一版'],
          })
          // 图跟文本一起回：只给路径的话，模型看不到自己刚取的那一版长什么样。
          return {
            content: [
              { type: 'text', text: JSON.stringify(env) },
              { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
            ],
          }
        } catch (error) {
          return failed({
            op: 'inspect.snapshot',
            error: fail(error?.code ?? 'SNAPSHOT_FAILED', `取快照失败：${error?.message ?? error}`),
            nextActions: ['先确认 SOLIDWORKS 里有活动文档（workspace action="status" → inspect action="model"）'],
          })
        }
      }
      if (args.action === 'review') {
        // 状态盘由 review-gate.js（宿主侧插件）写，这里只读。为什么不在这一侧写：
        // 审查要用 subagents + attachments 服务，那两样在宿主侧；MCP 服务是独立进程，
        // 拿不到它们。一个人写、一个人读，比两边都写更不容易互相覆盖。
        const wantId = typeof args.designId === 'string' && args.designId.length > 0
          ? args.designId
          : resolveDesignId(args.designId)
        const loaded = readReviewState({ designId: wantId, documentPath: args.documentPath })
        if (loaded.record === null) {
          return ok(
            envelope({
              summary: loaded.reason === 'NO_DESIGN_ID'
                ? '不知道你在问哪个件：带上 designId 再问（我不会替你猜是哪一个）'
                : `没有 ${wantId} 的审查记录（没审过 / 没交付过 / 审查门没挂载）`,
              designId: wantId,
              status: 'not-run',
              changes: { path: loaded.path, tried: loaded.tried, sessions: loaded.count, reason: loaded.reason ?? 'NO_RECORD' },
              nextActions: [
                '审查发生在交付与宣布完成的那一刻：先 capture 一张模型图，再 deliver 或 update_goal',
                '想看当前阶段可以在交付失败时读被拒绝的理由，它带差异与区域',
              ],
            }),
          )
        }
        const record = loaded.record
        const diff = (record.differences ?? []).slice(0, 6)
        const lines = diff.map((d) => `· ${d.region}：图纸「${d.expected}」，模型「${d.actual}」`)
        return ok(
          envelope({
            summary: [
              `${record.phase === 'passed' ? '已审过并通过' : record.phase === 'different' ? '审过但有差异' : record.phase === 'incomplete' ? '审了但证据不足' : '审查中/未审'}`,
              `（modelRevision ${record.modelRevision ?? '?'}，结论 ${record.result ?? '?'}，把握 ${record.confidence ?? '?'}）`,
              ...lines,
              ...(record.unresolved ?? []).slice(0, 3).map((u) => `· 待辨识：${u}`),
            ].join(String.fromCharCode(10)),
            designId: record.designId ?? args.designId,
            status: record.phase === 'passed' ? 'ok' : record.phase === 'different' ? 'failed' : 'not-run',
            changes: {
              path: loaded.path,
              phase: record.phase,
              result: record.result,
              confidence: record.confidence,
              modelRevision: record.modelRevision,
              reviewedRevision: record.reviewedRevision,
              snapshotId: record.snapshotId,
              artifactHash: record.artifactHash,
              observations: record.observations ?? [],
              differences: diff,
              unresolved: record.unresolved ?? [],
              history: (record.history ?? []).slice(-5),
            },
            nextActions: record.phase === 'passed'
              ? ['这一版可以交付；交付后改过几何就要重新审']
              : record.phase === 'different'
                ? ['按 differences[].region 定位改模型，改完重新 capture 再交付']
                : ['证据不足：补一张能看清争议区域的视图（capture view 或 inspect action=compare）'],
          }),
        )
      }
      if (args.action === 'sketch') {
        const cid = Date.now()
        try {
          const designId = needDesignId(args.designId, 'sketch')
          // designId 必须下传：省略时桥接器只能猜「当前活动文档」，多开一个零件就会读到别人。
          const result = await callBridge('sketchGeometry', { designId, sketch: args.sketch, index: args.sketchIndex ?? -1 })
          const identityError = identityFailure(designId, result?.document)
          if (identityError !== null) return failed({ op: 'inspect.sketch', designId, error: identityError })
          return ok(
            envelope({
              summary: `草图 ${result.sketch}：${result.count} 段几何（闭合 ${result.description?.closed === true ? '是' : '否'}，`
                + `悬空端点 ${result.description?.openEnds ?? '?'}）`
                + (result.description?.constructionSegments
                  ? `，另有 ${result.description.constructionSegments} 条构造线`
                  : ''),
              designId: resolveDesignId(args.designId),
              changes: { sketch: result.sketch, segments: result.segments, description: result.description },
              timings: { sketchMs: Date.now() - cid },
              nextActions: result.description?.closed === false
                ? ['轮廓是开的：悬空端点数就是缺口数，对照 segments 里每段的 start/end 找哪里没接上']
                : [],
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.sketch', designId: resolveDesignId(args.designId), error })
        }
      }
      if (args.action === 'figure') {
        // 路径只认 figure 里那几种写法（source / path / image / file）。
        // 顶层 source 不在 inspect 的 schema 里：rejectUnknownArgs 会在进入这里之前
        // 就回 UNKNOWN_PARAM，所以这里不再兜底读 args.source —— 那几行永远走不到，
        // 却让报错文案许诺「顶层 source 也认」，模型照着写只会再撞一次墙（实测撞过）。
        const spec = args.figure ?? {}
        // F5：figure 的**嵌套**键名/类型也要判。
        // 实测代价（四个会话合计 5 次无效往返 + 每会话约 1 分钟）：
        //   · figure.imagePath ×3（a00b4504）—— imagePath 是顶层预览图的名字，不是图纸路径
        //   · figure.grid:true（096f18c3）—— grid 是像素步长，不是开关
        //   · 顶层 op/path（8d1c3adf）—— 已由 rejectUnknownArgs 拦，但报错要指回 figure
        // 这里给的是**可复制的正确形态**，不是「你写错了」。
        const figureError = validateFigureSpec(spec)
        if (figureError !== null) return failed({ op: 'inspect.figure', error: figureError })
        const source = spec.source ?? spec.path ?? spec.image ?? spec.file
        if (!source) {
          const example = {
            action: 'figure',
            figure: { source: 'D:/path/to/drawing.jpg', op: 'info' },
          }
          return failed({
            op: 'inspect.figure',
            error: fail('BAD_ARGUMENT',
              'inspect action=figure 没拿到图纸路径：路径要写在 figure.source 里；顶层 source / path 不收。',
              {
                received: Object.keys(args),
                legal: [
                  'figure.source（别名 figure.path / figure.image / figure.file）',
                  'figure.op（info / crop / fit / frame）',
                  'figure.crop（别名 region / box）、figure.scale、figure.grid、figure.contrast、figure.maxSide、figure.output',
                ],
                example,
                nextAction: `直接照抄：{"action":"figure","figure":{"source":"<图纸路径>","op":"info"}}`,
              }),
          })
        }
        if (!existsSync(source)) {
          // 文件不在时 FromFile 只回一句 FileNotFoundException，模型没法自救。
          // 把同目录最像的名字摆出来，并明说空格/中文不是问题 —— 真名里就有一个空格。
          const near = closestFiles(source)
          const candidates = near.candidates.map((item) => item.path)
          return failed({
            op: 'inspect.figure',
            error: fail('FIGURE_FAILED',
              `没有这个文件：${source}。`
                + (candidates.length
                  ? `同一目录下最接近的是：${candidates.join('；')}。`
                  : `那个目录里没有名字相近的文件（${near.dir}）。`)
                + '文件名里有空格、中文都支持，请原样传入绝对路径（空格不要删、不要补）。',
              { source, dir: near.dir, candidates }),
            nextActions: ['照抄上面候选里的完整路径再试一次：空格是文件名的一部分，不要自己整理文件名'],
          })
        }
        const started = Date.now()
        try {
          const op = spec.op ?? 'crop'
          const info = runFigure({ source, probe: true })
          if (op === 'info') {
            // 扩展名会和内容对不上：实测那张图纸叫 .png，里面是 GIF89a。figure 按内容
            // 解码，照样取得出来；把判定结果说清楚，模型才不会再拿别的读图工具撞墙。
            const contentFormat = info.contentFormat ?? 'unknown'
            const extensionMatchesContent = info.extensionMatchesContent !== false
            const changes = { source, width: info.width, height: info.height, contentFormat, extensionMatchesContent }
            if (!extensionMatchesContent) changes.hint = formatMismatchHint(source, contentFormat)
            return ok(envelope({
              summary: `图纸 ${info.width}×${info.height} 像素`,
              changes,
              nextActions: ['先用 op="fit" 看整页布局，再用 op="crop" 把要读的那块放大'],
            }))
          }

          const [w, h] = [info.width, info.height]
          // 裁剪框的写法放宽到「人自然会写的那几种」：一次实测里，同一个人先后写了
          // crop:[x0,y0,x1,y1]、{x,y,width,height}、{x,y,w,h}、region、box —— 五次
          // 都被当成「没给裁剪框」，每次都整页缩一遍。这里统一收下。
          const cropSpec = spec.crop ?? spec.region ?? spec.box
            ?? (typeof spec.x === 'number' ? { x: spec.x, y: spec.y ?? 0, width: spec.width ?? spec.w, height: spec.height ?? spec.h } : null)
          let crop = normalizeCrop(cropSpec, w, h) ?? [0, 0, w, h]
          let scale = spec.scale
          if (typeof scale !== 'number') {
            scale = op === 'fit' || op === 'frame'
              ? Math.min((spec.maxSide ?? 1400) / Math.max(1, crop[2] - crop[0]),
                (spec.maxSide ?? 1400) / Math.max(1, crop[3] - crop[1]))
              : 4
          }
          const output = imagePath('fig', spec.output)
          const grid = op === 'frame' ? (spec.grid ?? 25) : spec.grid
          const result = runFigure({
            source,
            output,
            crop,
            scale,
            grid,
            contrast: spec.contrast ?? (op === 'crop' ? 20 : 0),
          })
          if (!result.ok) throw new Error(JSON.stringify(result))

          const summary = envelope({
            summary: `裁自 ${result.crop[0]},${result.crop[1]}–${result.crop[2]},${result.crop[3]}`
              + `（${w}×${h} 的图），放大 ${result.scale}× → ${result.width}×${result.height}`
              + (result.grid ? `，网格步长 ${grid} 源像素` : ''),
            changes: {
              source,
              output: result.output,
              crop: result.crop,
              width: result.width,
              height: result.height,
              scale: result.scale,
              grid: result.grid ?? 0,
              // Without this the model reads a pixel and calls it a millimetre.
              map: result.map,
            },
            artifacts: [{ kind: 'image', path: result.output, mimeType: 'image/png' }],
            timings: { figureMs: Date.now() - started },
            nextActions: [
              '图里的坐标是放大后的像素；换算回源图用 map 里的公式，别把像素当毫米',
              '尺寸要以标注文字为准：这种扫描件每个视图的横向和纵向比例都不一样',
            ],
          })
          return {
            content: [
              { type: 'text', text: JSON.stringify(summary) },
              { type: 'image', data: readFileSync(result.output).toString('base64'), mimeType: 'image/png' },
            ],
          }
        } catch (error) {
          return failed({ op: 'inspect.figure', error: fail('FIGURE_FAILED', error.message) })
        }
      }
      if (args.action === 'compare') {
        const spec = args.compare ?? {}
        if (!spec.drawing) {
          return failed({
            op: 'inspect.compare',
            error: fail('BAD_ARGUMENT',
              'inspect action=compare 需要 compare.drawing（参考图纸文件路径）与 compare.crop'),
          })
        }
        const started = Date.now()
        try {
          const designId = resolveDesignId(args.designId)
          const info = runFigure({ source: spec.drawing, probe: true })
          const crop = spec.crop ?? [0, 0, info.width, info.height]
          const views = { front: '*前视', top: '*上视', right: '*右视', iso: '*等轴测', back: '*后视', left: '*左视' }
          const viewKey = spec.view ?? 'front'
          const viewName = views[viewKey] ?? '*前视'
          const stamp = Date.now()
          const drawingPng = pathJoin(tmpdir(), `cmp-drawing-${stamp}.png`)
          const modelPng = pathJoin(tmpdir(), `cmp-model-${stamp}.png`)
          const out = imagePath('cmp', spec.output)

          const drawn = runFigure({
            source: spec.drawing,
            output: drawingPng,
            crop,
            scale: spec.scale ?? 2,
            contrast: spec.contrast ?? 20,
          })
          if (!drawn.ok) throw new Error(JSON.stringify(drawn))

          const shot = await callBridge('capture', {
            designId,
            path: modelPng,
            width: spec.width ?? 1100,
            height: spec.height ?? 800,
            view: viewName,
            caption: '',
            // A1：这张图必须是指定视图才能和图纸并排比 —— 这里是**显式**要求改视图，
            // 所以开 mutateView。摘要里会带上 viewMutated，让调用方知道要告知用户。
            mutateView: true,
            zoomToFit: true,
          })
          if (!shot.saved) {
            throw new Error(`模型截图没有落地：${shot.error?.message ?? '未知原因'}`)
          }
          const active = shot.document?.title
          const shotViewMutated = shot.viewMutated ?? { zoomToFit: false, blankRefGeom: false, namedView: null }
          const composed = runCompare({
            left: drawn.output,
            right: modelPng,
            out,
            labelLeft: spec.labelLeft ?? '图纸',
            labelRight: spec.labelRight ?? `模型 ${viewName}`,
            caption: spec.caption ?? '',
          })
          if (!composed.ok) throw new Error(JSON.stringify(composed))

          const summary = envelope({
            summary: `并排对照已出图：左=图纸裁块（${drawn.crop.join(',')}），右=模型 ${viewName}`
              + (active ? `（${active}）` : ''),
            designId,
            status: 'ok',
            changes: {
              drawing: { source: spec.drawing, crop: drawn.crop, scale: drawn.scale, output: drawn.output },
              model: { view: viewName, output: modelPng, document: active ?? null, viewMutated: shotViewMutated },
              composite: { output: composed.output, width: composed.width, height: composed.height },
            },
            artifacts: [{ kind: 'image', path: composed.output, mimeType: 'image/png' }],
            measurements: null,
            timings: { compareMs: Date.now() - started },
            nextActions: [
              '这张图是给人看的：轮廓对不对得上，一眼就能看出来，但它不是判据',
              '判据仍然是 inspect action=verify 的那些语义核对（孔径/轴线高度/间距）——扫描件不是等比图，像素比像素没有意义',
            ],
          })
          return {
            content: [
              { type: 'text', text: JSON.stringify(summary) },
              { type: 'image', data: readFileSync(composed.output).toString('base64'), mimeType: 'image/png' },
            ],
          }
        } catch (error) {
          return failed({ op: 'inspect.compare', error: fail('COMPARE_FAILED', error.message) })
        }
      }
      if (args.action === 'measure') {
        const started = Date.now()
        let designId = null
        try {
          designId = needDesignId(args.designId, 'measure')
        } catch (error) {
          return failed({ op: 'inspect.measure', error })
        }
        const req = args.measure ?? { kind: 'holes' }
        try {
          const result = await callBridge('measure', { ...req, designId })
          // F6：量到的文档不是 designId 登记的那一份 → 这组数字不能用来验收。
          const identityError = identityFailure(designId, result?.document)
          if (identityError !== null) return failed({ op: 'inspect.measure', designId, error: identityError })
          return ok(
            envelope({
              summary: describeMeasure(result),
              designId,
              status: 'ok',
              measurements: result,
              changes: { measure: req, result },
              timings: { measureMs: Date.now() - started },
              nextActions: measureHints(result),
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.measure', designId, error })
        }
      }
      // "model" means the feature tree / dimensions / equations, which is what the
      // original part_inspect handler returns. It used to be reachable through the
      // same line as "faces", so splitting "faces" out into its own branch silently
      // sent "model" to the faces reader as well.
      if (args.action === 'model') return handlePartInspect(args)
      if (args.action === 'mates') {
        const started = Date.now()
        try {
          const result = await callBridge('mates', { designId: resolveDesignId(args.designId) })
          return ok(
            envelope({
              summary: `${result.assembly?.title ?? '装配体'}：${result.count} 个配合`,
              changes: result,
              timings: { matesMs: Date.now() - started },
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.mates', designId: resolveDesignId(args.designId), error })
        }
      }
      if (args.action === 'assemblyFaces') {
        const started = Date.now()
        try {
          const result = await callBridge('assemblyFaces', { designId: resolveDesignId(args.designId) })
          const cylinders = (result.faces ?? []).filter((f) => f.kind === 'cylinder')
          return ok(
            envelope({
              summary: `${result.assembly?.title ?? '装配体'}：${result.count} 张面（其中 ${cylinders.length} 张圆柱面）`,
              changes: {
                assembly: result.assembly,
                components: result.components,
                count: result.count,
                faces: result.faces,
              },
              timings: { assemblyFacesMs: Date.now() - started },
              nextActions: [
                '挑两张不同零件的圆柱面（diameter 相同的那一对）把 id 传给 model action="mate"',
                '圆柱面用 coincident 即同心；平面之间用 coincident 或 distance',
              ],
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.assemblyFaces', designId: resolveDesignId(args.designId), error })
        }
      }
      if (args.action === 'assembly') {
        const started = Date.now()
        try {
          const result = await callBridge('components', { designId: resolveDesignId(args.designId) })
          return ok(
            envelope({
              summary: `${result.assembly?.title ?? '当前装配体'}：${result.count} 个组件`,
              changes: {
                assembly: result.assembly,
                components: result.components,
                count: result.count,
              },
              timings: { componentsMs: Date.now() - started },
              nextActions: result.count === 0
                ? ['装配体是空的；用 model action=assemble 放零件进来']
                : [],
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.assembly', designId: resolveDesignId(args.designId), error })
        }
      }
      if (args.action === 'relations') {
        const started = Date.now()
        let designId = null
        try {
          designId = needDesignId(args.designId, 'relations')
        } catch (error) {
          return failed({ op: 'inspect.relations', error })
        }
        // list 是默认：读操作不该因为「没传 apply」而变成一次写入。
        // apply=true 是旧写法，等价于 relationAction=apply。
        const relationAction = args.relationAction ?? (args.apply === true ? 'apply' : 'list')
        try {
          const payload = {
            designId,
            action: relationAction,
            sketch: args.sketch,
            tolerance: args.tolerance,
          }
          if (Array.isArray(args.relations)) payload.relations = args.relations
          if (Array.isArray(args.relationIds)) payload.relationIds = args.relationIds
          if (args.confirm !== undefined) payload.confirm = args.confirm
          if (args.atomic !== undefined) payload.atomic = args.atomic
          const result = await callBridge('relations', payload)
          const identityError = identityFailure(designId, result?.document)
          if (identityError !== null) return failed({ op: 'inspect.relations', designId, error: identityError })
          // 关系是交付门禁的确定性事实：把这次回读/修改的结果记进 live.json，
          // review-gate 交付前只读这份账，不再从对话里猜。
          //
          // F2：必须带**本设计自己的实时 revision**。旧代码不传 revision，服务只能
          // 回退成「上一次落账的版本」，于是每次回读审计版本只挪一格（4→5、6→7→8），
          // 永远追不上几何版本（10/18/21）—— 40 次 RELATIONS_INCOMPLETE 的根因。
          // 取不到可信 revision 就**不落账**，并如实回 AUDIT_REVISION_UNKNOWN。
          const revision = typeof liveRevisionOf === 'function' ? liveRevisionOf(designId) : null
          let auditRecorded = false
          if (Number.isFinite(revision) && typeof recordRelationAudit === 'function') {
            try {
              auditRecorded = recordRelationAudit({
                designId,
                documentPath: result?.document?.path,
                relationAction,
                result,
                revision,
              }) !== null
            } catch { /* 记账失败不影响观察结果 */ }
          }
          const auditCode = auditRecorded ? null : 'AUDIT_REVISION_UNKNOWN'
          const rejectedCount = Array.isArray(result.rejected)
            ? result.rejected.length
            : (Number.isFinite(Number(result.rejected)) ? Number(result.rejected) : 0)
          const count = Number(result.count ?? result.relations?.length ?? result.accepted ?? 0)
          const appliedCount = Array.isArray(result.applied) ? result.applied.length : Number(result.accepted ?? 0)
          const summary = relationAction === 'list' || relationAction === 'status'
            ? `${result.sketch ?? '草图'}：${count} 条关系`
              + `（${result.closed === false ? '轮廓未闭合，' : ''}约束状态 ${result.constrainedStatus ?? '?'}`
              + `${result.fullyConstrained ? '，已完全定义' : ''}）`
            : relationAction === 'infer'
              ? `${result.sketch ?? '草图'}：推断出 ${result.candidates ?? appliedCount} 条候选，未写入`
              : relationAction === 'apply'
                ? `${result.sketch ?? '草图'}：写入 ${appliedCount} 条关系（拒绝 ${rejectedCount}）`
                : relationAction === 'add'
                  ? `${result.sketch ?? '草图'}：新增 ${appliedCount} 条关系（拒绝 ${rejectedCount}）`
                  : relationAction === 'remove'
                    ? `${result.sketch ?? '草图'}：删除 ${Array.isArray(result.removed) ? result.removed.length : (result.removed ?? 0)} 条关系`
                    : relationAction === 'clear'
                      ? `${result.sketch ?? '草图'}：清空 ${result.removed ?? 0} 条关系`
                      : `${result.sketch ?? '草图'}：关系已更新`
          return ok(
            envelope({
              summary: auditCode === null
                ? summary
                : `${summary}（这次审计没落账：AUDIT_REVISION_UNKNOWN）`,
              designId,
              status: rejectedCount > 0 ? 'partial' : 'ok',
              changes: {
                relationAction,
                ...result,
                // F2：把「这一版审计有没有记进门禁的账」如实告诉调用方。
                audit: {
                  recorded: auditRecorded,
                  revision: Number.isFinite(revision) ? revision : null,
                  ...(auditCode === null
                    ? {}
                    : {
                      code: auditCode,
                      reason: '这台设计还没有 live.json 记录（或者读不到），拿不到可信 revision，'
                        + '所以没有落账 —— 用旧版本号凑一份会让门禁反复拒（F2）。先 model action=build 一次，再 inspect action=relations。',
                    }),
                },
              },
              timings: { relationsMs: Date.now() - started },
              nextActions: auditCode !== null
                ? ['先 model action=build（或 create）一次，让这一版有明确的 revision，再 inspect action="relations"：审计会带上实时版本']
                : rejectedCount > 0
                  ? [`有 ${rejectedCount} 条关系被桥接器拒绝：看 changes.rejected 的 error，按可用关系类型改；没有静默跳过`]
                  : relationAction === 'list' || relationAction === 'status'
                    ? (result.openEnds > 0 || result.closed === false
                      ? ['轮廓还有悬空端点：先用 inspect action=sketch 找出缺口，再 add 重合关系']
                      : ['要写回关系用 relationAction=apply 或 add；改尺寸用 inspect action=dimensions'])
                    : ['再跑 relationAction=list 确认关系数与 constrainedStatus 已变化'],
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.relations', designId, error })
        }
      }
      if (args.action === 'dimensions') {
        const started = Date.now()
        const designId = resolveDesignId(args.designId)
        const dimensionAction = args.dimensionAction ?? 'list'
        try {
          const payload = {
            designId,
            sketch: args.sketch,
            action: dimensionAction,
            tolerance: args.tolerance,
          }
          if (Array.isArray(args.dimensions)) payload.dimensions = args.dimensions
          if (Array.isArray(args.relationIds)) payload.relationIds = args.relationIds
          const result = await callBridge('dimensions', payload)
          const rows = Array.isArray(result.dimensions) ? result.dimensions : []
          const applied = Array.isArray(result.applied) ? result.applied.length : 0
          const removed = Array.isArray(result.removed) ? result.removed.length : 0
          const updated = Array.isArray(result.updated) ? result.updated.length : 0
          // remove 逐目标回报：成功项与失败项同时回，服务端按 failures 判 status，
          // 不再让一条删不掉把整批成功项吞进 error.detail。
          const failures = Array.isArray(result.failures)
            ? result.failures
            : (Number.isFinite(Number(result.failureCount)) ? Number(result.failureCount) : 0)
          const failureCount = Array.isArray(failures) ? failures.length : failures
          // 驱动/参考口径：写动作落地了但全是参考尺寸，等于没落地。
          const referenceCount = typeof result.reference === 'number'
            ? result.reference
            : rows.filter((row) => row?.reference === true || row?.driving === false).length
          const drivingCount = typeof result.driving === 'number'
            ? result.driving
            : rows.length - referenceCount
          const wroteNothing = (dimensionAction === 'add' || dimensionAction === 'edit')
            && (applied + updated) === 0
          const onlyReference = (dimensionAction === 'add' || dimensionAction === 'edit')
            && !wroteNothing && referenceCount > 0
          const removeFailed = dimensionAction === 'remove' && failureCount > 0
          return ok(
            envelope({
              summary: dimensionAction === 'list'
                ? `${result.sketch ?? '草图'}：${rows.length} 个尺寸（驱动 ${drivingCount}，参考 ${referenceCount}）`
                : dimensionAction === 'add'
                  ? (wroteNothing
                    ? '一个尺寸都没加上'
                    : `新增 ${applied} 个尺寸` + (onlyReference ? '，但全部是参考尺寸（改不动的）' : ''))
                  : dimensionAction === 'edit'
                    ? (wroteNothing
                      ? '一个尺寸都没改到'
                      : `改了 ${updated || applied} 个尺寸` + (onlyReference ? '，但全是参考尺寸（改不动的）' : ''))
                    : `删除 ${removed} 个尺寸`
                      + (failureCount > 0 ? `，${failureCount} 个没删掉（成功项已保留）` : ''),
              // 写不进东西、或写进去的全是参考尺寸，都是失败而不是 ok ——
              // 以前这两条都被报成 ok，于是「加了尺寸但模型不动」一路走到底。
              // remove 有任意一条失败也报 failed，但 removed[] 会一起回。
              status: wroteNothing || onlyReference || removeFailed ? 'failed' : 'ok',
              designId,
              changes: { dimensionAction, driving: drivingCount, reference: referenceCount, ...result },
              timings: { dimensionsMs: Date.now() - started },
              nextActions: wroteNothing
                ? ['这次写动作一条都没落地：先确认草图在编辑态（桥接器会自己 EditSketch），'
                  + '再确认 refs 指向的是草图里真实存在的段/曲线（inspect action="sketch" 可读）']
                : onlyReference
                  ? ['加上的尺寸是参考尺寸（IsReferenceDim=true）：它读得出来但驱动不了模型。'
                    + '先补定义它的草图关系（对称/重合/到边距离），再重加尺寸；'
                    + '不要把它当成参数化已经落地']
                  : removeFailed
                    ? [
                      `有 ${failureCount} 个目标没删掉：看 changes.failures[].index 与 reason，`
                        + '只针对那几条重试，不要整批重删（已经删掉的 ' + removed + ' 条不用再动）',
                      '删不掉通常是这条尺寸被关系/几何定义着：先解掉定义它的关系，或改成保留它',
                    ]
                    : dimensionAction === 'list'
                    ? [referenceCount > 0
                      ? `有 ${referenceCount} 个是参考尺寸：它们改不动模型，不要把「有尺寸」当「参数化」`
                      : '尺寸全是驱动状态；要加尺寸用 dimensionAction=add，值必须是图纸标注值；'
                        + '没有标注的值写进 assumptions 并问用户']
                    : ['再跑 dimensionAction=list 确认尺寸数与驱动状态（driving）'],
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.dimensions', designId, error })
        }
      }
      if (args.action === 'bodies') {
        const startedBodies = Date.now()
        const designId = resolveDesignId(args.designId)
        try {
          const result = await callBridge('bodies', { designId })
          // 形状要稳：同一个字段以前有时在顶层、有时在 changes.measurements，
          // 调用方只能每次先探测形状（16 次 `reading 'totalVolumeMm3' of undefined`）。
          // 这里先按两种位置取，再在回包里给出**唯一**的 measurements 位置。
          const measured = result.totalVolumeMm3 !== undefined
            ? result.totalVolumeMm3
            : (result.measurements?.totalVolumeMm3 ?? null)
          const count = result.count ?? result.measurements?.bodyCount ?? null
          const separate = (count ?? 0) > 1
          const identity = identityFailure(designId, result.document)
          if (identity) return failed({ op: 'inspect.bodies', designId, error: identity })
          return ok(
            envelope({
              summary: `${result.document?.title ?? '当前零件'}：${count ?? '?'} 个实体`
                + (separate ? '（不是一个整体，有多块分开的料）' : '')
                + `，总体积 ${measured ?? '未量到'} mm³`,
              designId,
              status: 'ok',
              changes: { document: result.document, bodies: result.bodies, count },
              measurements: { totalVolumeMm3: measured, bodyCount: count },
              nextActions: separate
                ? ['实体多于一个，通常是某次拉伸方向反了：对照每块的 box.min/max，'
                  + '看哪一块不在它该在的位置']
                : measured === null
                  ? ['这次没量到总体积：实体可能全是曲面（不是实心），或文档不是零件。'
                    + '先用 inspect action="model" 确认 bodyType，别把 null 当成 0']
                  : [],
              timings: { bodiesMs: Date.now() - startedBodies },
            }),
          )
        } catch (error) {
          return failed({ op: 'inspect.bodies', designId, error })
        }
      }

      const designId = resolveDesignId(args.designId)
      const started = Date.now()
      try {
        const result = await callBridge('faces', { designId, limit: args.limit })
        return ok(
          envelope({
            summary: `${result.document?.title ?? '当前零件'}：${result.count} 张面`,
            designId,
            changes: { document: result.document, faces: result.faces },
            timings: { facesMs: Date.now() - started },
            nextActions: [
              '把某张面的 id 传给 select action=select mode=byId，就能重新选中它',
              'capture 的 highlight 也可以直接吃这些 id，图上会由 SOLIDWORKS 自己高亮',
            ],
          }),
        )
      } catch (error) {
        return failed({ op: 'inspect.faces', designId, error })
      }
    },
  )

  // ------------------------------------------------------------------- select

  server.registerTool(
    'select',
    {
      title: '选中几何',
      description: DESCRIPTIONS.select,
      inputSchema: z.object({
        action: z.enum(['select', 'list', 'clear']).default('select')
          .describe('做什么：select 按 mode 选、list 读当前选择集、clear 清空。'
            + '**返回 true 不等于选中**：调完必须读 selection.count（选完了 ≠ 选中了），count=0 就是没选中 —— '
            + '坐标按毫米给、名字写错、面被重建换掉，这三种都返回 true 但一个都没选上'),
        mode: z.enum(['byId', 'byRay', 'byName']).default('byId').describe('怎么选'),
        designId: designIdArg,
        persistentId: z.string().optional().describe('byId 用的持久引用（inspect action=faces 的 id）'),
        x: z.number().optional().describe('byRay 的屏幕 x'),
        y: z.number().optional().describe('byRay 的屏幕 y'),
        name: z.string().optional().describe('byName 的名字'),
        type: z.string().optional().describe('byName 的类型，默认 PLANE'),
        append: z.boolean().optional().describe('是否追加到已有选择，默认 false'),
        mark: z.number().int().optional().describe('选择记号，默认 0'),
      }),
    },
    async (args) => {
      const designId = resolveDesignId(args.designId)
      const started = Date.now()
      try {
        const mode = args.action === 'clear' ? 'clear' : args.action === 'list' ? 'list' : args.mode
        const result = await callBridge('select', {
          mode,
          designId,
          persistentId: args.persistentId,
          x: args.x,
          y: args.y,
          name: args.name,
          type: args.type,
          append: args.append,
          mark: args.mark,
        })
        const count = result.selection?.count ?? 0
        // 「选完了」不等于「选中了」。
        //
        // SelectByID2 在什么都没选到时**照样返回 true**（实测：坐标按毫米给了、
        // 名字写错、面已经被重建换掉，三种都返回 true）。旧实现把这种结果原样
        // 当成功回给调用方，摘要只写「没有选中任何对象」—— 于是后续的特征建在
        // 空选集上，报错指向完全无关的地方。
        //
        // clear 和 list 例外：清空之后本来就是 0 个，那只读不写。
        const selecting = mode === 'byId' || mode === 'byRay' || mode === 'byName'
        if (selecting && count === 0) {
          return failed({
            op: `select.${mode}`,
            designId,
            error: fail('SELECTION_EMPTY',
              `select mode=${mode} 之后选中的对象是 0 个（桥接器返回 selected=${JSON.stringify(result.selected)}，`
                + '那个返回值不代表真的选中了东西）。接下来的步骤不会作用在任何几何上。',
              {
                mode,
                selected: result.selected ?? null,
                selection: result.selection ?? null,
                ...(mode === 'byName' ? { name: args.name ?? null, type: args.type ?? null } : {}),
                ...(mode === 'byRay' ? { x: args.x ?? null, y: args.y ?? null } : {}),
                ...(mode === 'byId' ? { persistentId: args.persistentId ?? null } : {}),
              }),
            nextActions: mode === 'byName'
              ? [
                'byName 的名字必须与 SOLIDWORKS 特征树里的完全一致（含空格、后缀、大小写）：'
                  + '先 inspect action="model" format="tree" 看真实名字，别照图纸/图纸标题写。',
                '面、边、草图段不能用 byName 选：面/边走 inspect action="faces" 拿持久引用 id 再 byId。',
              ]
              : mode === 'byRay'
                ? [
                  '像素必须来自**同一视图状态**的投影：先 capture 出图、再按那张图的像素给坐标；'
                    + '视图切过（旋转/缩放/切视图）之后旧像素就打到别处或打空。',
                  '按图片比例自己换算像素会偏：用 inspect/session 给的 project 结果，不要手算。',
                ]
                : [
                  '持久引用 id 可能已失效（重建/改特征之后）：重新 inspect action="faces" 取新 id；'
                    + '真失效的 id 会报 STALE_SELECTION，静默 0 个只说明这条 id 本身没解析中。',
                  '确认 designId 指的就是你想选的那份文档：选到别人的零件上，后面所有步骤都作用错对象。',
                ],
          })
        }
        return ok(
          envelope({
            summary: mode === 'list'
              ? `当前选中 ${count} 个对象`
              : count > 0 ? `已选中 ${count} 个对象` : '选择已清空（0 个对象）',
            designId,
            changes: { mode, selected: result.selected, selection: result.selection, ray: result.ray },
            timings: { selectMs: Date.now() - started },
            nextActions: count === 0
              ? ['clear 之后本来就该是 0 个；要再选就先 inspect action=faces 拿持久引用 id']
              : ['把这些 id 传给 capture 的 highlight，图里就会由 SOLIDWORKS 自己高亮'],
          }),
        )
      } catch (error) {
        return failed({ op: `select.${args.mode}`, designId, error })
      }
    },
  )

  // ------------------------------------------------------------------ capture

  server.registerTool(
    'capture',
    {
      title: '出图',
      description: DESCRIPTIONS.capture,
      inputSchema: z.object({
        designId: designIdArg,
        path: z.string().optional().describe('落盘路径（.png）；省略时写到临时目录'),
        width: z.number().int().min(320).max(2560).default(1280).describe('图宽'),
        height: z.number().int().min(240).max(1600).default(800).describe('图高'),
        highlight: z.array(z.string()).optional().describe('要高亮的持久引用 id 列表'),
        caption: z.string().optional().describe('左上角的一行说明文字'),
        mutateView: z.boolean().optional().default(false)
          .describe('总开关：true 才允许改文档视图（view/zoomToFit/hideReferenceGeometry 生效）。默认 false = 只出图、不动文档'),
        view: z.string().optional().describe('命名视图，例如 "*等轴测"；只有 mutateView:true 才生效'),
        zoomToFit: z.boolean().optional().default(false)
          .describe('渲染前缩放到合适大小；默认 false（ViewZoomtofit2 会改动并随存盘落盘的视口状态）'),
        hideReferenceGeometry: z.boolean().optional().default(false)
          .describe('渲染前隐藏参考几何（平面/轴/草图）；默认 false（BlankRefGeom 会改用户的显示状态）'),
        views: z.array(z.string()).max(6).optional()
          .describe('一次出多张：["iso","top","front","right"]；按顺序切命名视图（会改文档视图），每张各回一个图'),
      }),
    },
    async (args) => {
      const started = Date.now()
      const path = resolvePath(args.path ?? imagePath('shot'))
      let designId = typeof args.designId === 'string' ? args.designId : null
      try {
        // designId must reach the bridge: without it the bridge falls back to
        // "whatever document happens to be active", which is a different part
        // whenever more than one is open — and the picture still comes back fine.
        // F3：所以这里从「必须带」升级成真的拒（以前省略就传 null 下去）。
        designId = needDesignId(args.designId, 'capture')
        if (Array.isArray(args.views) && args.views.length > 0) {
          const shots = []
          const warnings = []
          const NAMED = { iso: '*等轴测', top: '*上视', bottom: '*下视', front: '*前视', back: '*后视', left: '*左视', right: '*右视' }
          for (let i = 0; i < args.views.length && i < 6; i++) {
            const view = String(args.views[i])
            if (/^(section|cut|剖视|剖)$/i.test(view)) {
              // 不是「跳过一张图」：要剖视的人拿到普通视角会以为看到的是剖面。
              // 明确拒绝，并给两条真能拿到剖面的路。
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify(failed({
                    op: 'capture.views', designId,
                    error: fail('SECTION_UNSUPPORTED',
                      `"${view}" 不是可渲染的命名视图：capture 只会给普通视角，没有真剖视（剖切）能力。`
                      + '要给剖面就用 analysis action="section"（对导出的 STEP 做几何剖切），或 model action="drawing" 出工程图剖视图',
                      { requested: view, supported: Object.keys(NAMED) }),
                    nextActions: [
                      '要剖面读数：先 deliver kind="step"，再 analysis action="section"',
                      '要工程图剖视图：model action="drawing"，剖视图需另建（这个动作只落标准视图）',
                    ],
                  })),
                }],
              }
            }
            const viewPath = path.replace(/\.png$/i, '') + '-' + (i + 1) + '-' + view.replace(/[^a-z0-9]+/gi, '') + '.png'
            const shot = await callBridge('capture', {
              designId, path: viewPath, width: args.width, height: args.height,
              highlight: args.highlight, caption: args.caption,
              mutateView: true, view: NAMED[view.toLowerCase()] ?? view, zoomToFit: true,
            })
            if (shot?.saved) shots.push({ view, path: viewPath, bytes: shot.bytes })
          }
          const missing = args.views.length - shots.length
          return {
            content: [
              { type: 'text', text: JSON.stringify(envelope({
                summary: '出图 ' + shots.length + '/' + args.views.length + ' 张：' + shots.map((s) => s.view).join('、') + '（已改文档视图）',
                designId,
                status: shots.length > 0 ? 'ok' : 'failed',
                changes: { views: shots, missing, warnings },
                artifacts: shots.map((s) => ({ kind: 'image', path: s.path, bytes: s.bytes })),
                timings: { captureMs: Date.now() - started },
                nextActions: missing > 0 ? ['有视图没出成：换 *前视 / *上视 / *等轴测 再试'] : [],
              })) },
              ...shots.map((s) => ({ type: 'image', data: readFileSync(s.path).toString('base64'), mimeType: 'image/png' })),
            ],
          }
        }
        const result = await callBridge('capture', {
          designId,
          path,
          width: args.width,
          height: args.height,
          highlight: args.highlight,
          caption: args.caption,
          // A1：默认只出图、不动文档。mutateView 是总开关，桥接器里再判一次。
          mutateView: args.mutateView === true,
          view: args.view,
          zoomToFit: args.zoomToFit === true,
          hideReferenceGeometry: args.hideReferenceGeometry === true,
        })
        if (!result.saved) {
          return failed({
            op: 'capture',
            designId,
            error: fail('CAPTURE_FAILED', `SOLIDWORKS 没有写出图片（${path}）`),
          })
        }
        // F6：拍到的不是这一份文档 → 这张图不能当「这一版的证据」。
        const identityError = identityFailure(designId, result?.document)
        if (identityError !== null) return failed({ op: 'capture', designId, error: identityError })
        const viewMutated = result.viewMutated ?? { zoomToFit: false, blankRefGeom: false, namedView: null }
        const changedView = viewMutated.zoomToFit === true || viewMutated.blankRefGeom === true
          || viewMutated.namedView != null
        const summary = envelope({
          summary: `${result.width}×${result.height} 的图，已高亮 ${result.highlight?.count ?? 0} 个对象` +
            (result.document?.title ? `，拍的是 ${result.document.title}` : '') +
            (changedView ? '（已改变文档视图）' : '（未改动文档视图）'),
          designId,
          changes: {
            path, bytes: result.bytes, highlight: result.highlight, view: result.view,
            // 调用方要能看出"我以为切了视图，其实没有"。
            viewMutated,
            // The picture is evidence only if we know which document it came from.
            document: result.document,
            ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          },
          artifacts: [{ kind: 'image', path, bytes: result.bytes, mimeType: 'image/png' }],
          timings: { captureMs: Date.now() - started },
          nextActions: changedView
            ? ['截图改动了文档视图（会随存盘落盘）：结束前告知用户"已改变文档视图"']
            : (Array.isArray(result.warnings) && result.warnings.length > 0
              ? ['view/zoomToFit/hideReferenceGeometry 需要 mutateView:true 才生效；默认只出图、不动文档']
              : []),
        })
        return {
          content: [
            { type: 'text', text: JSON.stringify(summary) },
            { type: 'image', data: readFileSync(path).toString('base64'), mimeType: 'image/png' },
          ],
        }
      } catch (error) {
        return failed({ op: 'capture', designId, error })
      }
    },
  )

  // ------------------------------------------------------------------ deliver

  server.registerTool(
    'deliver',
    {
      title: '交付文件',
      description: DESCRIPTIONS.deliver,
      inputSchema: z.object({
        kind: z.enum(['sldprt', 'step', 'stl', 'pdf', 'dxf', 'dwg']).default('sldprt').describe('要哪种文件'),
        designId: designIdArg,
        path: z.string().optional().describe('输出路径；省略时写到项目目录'),
        force: z.enum(['manual']).optional()
          .describe('逃生口：仅在门禁不可达（GATE_UNREACHABLE）且用户已明确授权时传 "manual"；会写进 review/bypass.jsonl 留痕，正常交付不要用'),
        reason: z.string().optional().describe('配合 force:"manual"：一句话说明为什么绕门，写进 bypass.jsonl 留痕（先取得用户确认）'),
      }),
    },
    async (args) => handlePartExport(args),
  )
}


