// 参数名的真相：写错就要报错，别静默当成另一件事。
//
// 实测代价（session-3f026ed8）：一次读图里，同一个模型先后写了
//   figure.path / figure.source / x,y,width,height / w,h / region / box / crop
// 六种写法，前五次都被当成「没给裁剪框」，每次都整页缩一遍；`catalog search`
// 用 `q` 写成了 `query` 也照样返回，模型以为搜过了。
//
// 这条测试只碰不依赖 SOLIDWORKS 的两件事：参数名检查、以及三种裁剪框写法。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSession } from './lib/mcp.mjs'
import { checkDocumentIdentity, normalizeTitle } from '../server/review-guard.mjs'
import { readLiveRecord, recordDocumentTitle } from '../server/review-live.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'sw-params-'))
const env = { ...process.env, SW_MCP_DATA: root }
const session = openSession({ env })

/** 造一张 200×100 的纯色 PNG：figure 要的是真图，不能拿假字节糊弄 GDI+。 */
function makeImage(path) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap 200,100`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$g.Dispose()',
    `$bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
  ].join('; ')
  spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return existsSync(path)
}

try {
  await session.start()

  // 1) 顶层参数写错：必须立刻报 UNKNOWN_PARAM，并指出最接近的键。
  const typo = await session.tool('catalog', { action: 'search', keyword: 'fillet' })
  check('catalog 用不存在的键 → failed', typo.status === 'failed', typo.status)
  check('错误码是 UNKNOWN_PARAM', typo.extra?.error?.code === 'UNKNOWN_PARAM', typo.extra?.error?.code)
  check('指出最接近的键是 q', /keyword\s*→\s*q/.test(typo.summary ?? ''), typo.summary)

  // 2) query 是 q 的别名（模型很自然会这么写）。
  const alias = await session.tool('catalog', { action: 'search', query: 'fillet' })
  check('catalog 接受 query 作为 q 的别名', alias.status === 'ok', alias.status)
  check('命中数是个数字', typeof alias.changes?.total === 'number', alias.changes?.total)

  // 3) 裁剪框三种写法都要真的生效：结果尺寸和裁剪范围必须跟着变。
  const image = join(root, 'sheet.png')
  check('测试图已生成', makeImage(image), image)

  const byObject = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'crop', x: 10, y: 10, width: 50, height: 40, scale: 2 },
  })
  check('{x,y,width,height} 被采纳', byObject.status === 'ok', byObject.summary)
  check('裁剪结果按 2× 放大 → 100×80', byObject.changes?.width === 100 && byObject.changes?.height === 80,
    [byObject.changes?.width, byObject.changes?.height])
  check('crop 记录的是源图坐标', JSON.stringify(byObject.changes?.crop) === JSON.stringify([10, 10, 60, 50]), byObject.changes?.crop)

  const byRegion = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'crop', region: [0, 0, 100, 50], scale: 1 },
  })
  check('region:[x0,y0,x1,y1] 被采纳', byRegion.changes?.width === 100 && byRegion.changes?.height === 50,
    [byRegion.changes?.width, byRegion.changes?.height])

  const byW = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'crop', crop: { x: 0, y: 0, w: 20, h: 10 }, scale: 3 },
  })
  check('{x,y,w,h} 被采纳', byW.changes?.width === 60 && byW.changes?.height === 30,
    [byW.changes?.width, byW.changes?.height])

  // 4) F5：嵌套键名/类型也要拦，而且报错要给**可复制的正确形态**。
  //    以前这里写的是「内部是开放的、额外键不影响」—— 实测代价是四次会话来
  //    5 次无效往返（figure.imagePath ×3、figure.grid:true、顶层 op/path）。
  const nestedTypo = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'info', nonsense: 1 },
  })
  check('figure 内部的未知键现在会被拒（不再静默忽略）', nestedTypo.status === 'failed', nestedTypo.status)
  check('嵌套未知键的错误码是 UNKNOWN_PARAM', nestedTypo.extra?.error?.code === 'UNKNOWN_PARAM', nestedTypo.extra?.error?.code)
  check('报错里给出可复制的正确形态', /"action":"figure"/.test(nestedTypo.summary ?? ''), nestedTypo.summary)

  const imagePathTypo = await session.tool('inspect', {
    action: 'figure',
    figure: { imagePath: image, op: 'info' },
  })
  check('figure.imagePath 被拒并指回 figure.source',
    imagePathTypo.status === 'failed' && /imagePath\s*→\s*figure\.source/.test(imagePathTypo.summary ?? ''),
    imagePathTypo.summary)

  const gridBool = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'fit', grid: true },
  })
  check('figure.grid:true 被拒（grid 是像素步长不是开关）',
    gridBool.status === 'failed' && /grid/.test(gridBool.summary ?? '') && /数字/.test(gridBool.summary ?? ''),
    gridBool.summary)

  const mixedRect = await session.tool('inspect', {
    action: 'figure',
    figure: { source: image, op: 'crop', crop: [0, 0, 10, 10], x: 0, y: 0, width: 10, height: 10 },
  })
  check('crop 与 x/y/width/height 混写被拒（要求二选一）',
    mixedRect.status === 'failed' && /二选一/.test(mixedRect.summary ?? ''), mixedRect.summary)

  // 5) inspect 顶层写错键要拦，而且不启动任何 SOLIDWORKS 调用。
  const inspectTypo = await session.tool('inspect', { action: 'faces', faceId: 'x' })
  check('inspect 顶层未知键 → UNKNOWN_PARAM', inspectTypo.extra?.error?.code === 'UNKNOWN_PARAM', inspectTypo.extra?.error?.code)
  check('并且列出允许的键', Array.isArray(inspectTypo.extra?.error?.detail?.allowed), inspectTypo.extra?.error?.detail?.allowed?.length)

  // 6) F6：文档身份断言（纯函数 + live.json 登记，不需要 SOLIDWORKS）。
  //    实测：designId=bracket-06v1 的 measure 回了 锁盖.SLDPRT 的「0 个圆柱面」，
  //    模型照用、照样验收。这里钉住「登记名 ≠ 实际标题 → WRONG_DOCUMENT」。
  check('标题归一：去目录、去扩展名、去空白', normalizeTitle('C:\\x\\支架06.SLDPRT') === '支架06',
    normalizeTitle('C:\\x\\支架06.SLDPRT'))
  const mismatch = checkDocumentIdentity({
    designId: 'bracket-06v1',
    expectedTitles: ['支架06.SLDPRT'],
    actualTitle: '锁盖.SLDPRT',
  })
  check('登记的标题与实际不一致 → 判 WRONG_DOCUMENT', mismatch.ok === false && mismatch.error.code === 'WRONG_DOCUMENT',
    mismatch.error?.message?.slice(0, 120))
  check('WRONG_DOCUMENT 带两个标题与 designId',
    mismatch.error?.detail?.expectedTitle === '支架06.SLDPRT'
      && mismatch.error?.detail?.actualTitle === '锁盖.SLDPRT'
      && mismatch.error?.detail?.designId === 'bracket-06v1',
    mismatch.error?.detail)
  const generic = checkDocumentIdentity({
    designId: 'd', expectedTitles: ['零件1.SLDPRT'], actualTitle: '锁盖.SLDPRT',
  })
  check('未存盘通名（零件N）不误报', generic.ok === true, generic.reason)
  const unregistered = checkDocumentIdentity({ designId: 'd', expectedTitles: [], actualTitle: '锁盖.SLDPRT' })
  check('没有登记时不拦（第一次量到的就是登记名）', unregistered.ok === true, unregistered.reason)

  recordDocumentTitle({ dataDir: root, designId: 'f6-doc', title: '支架06.SLDPRT', documentPath: 'C:\\x\\支架06.SLDPRT' })
  check('登记名写进 live.json', readLiveRecord({ dataDir: root, designId: 'f6-doc' })?.documentTitle === '支架06.SLDPRT',
    readLiveRecord({ dataDir: root, designId: 'f6-doc' })?.documentTitle)
} finally {
  await session.close()
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
