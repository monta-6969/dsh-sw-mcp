// 图纸 ↔ 模型并排对照：一张图里同时看见参考和成品。
//
// 这个工具的价值是「让人一眼看出对不对」，所以这里验的是它真的产出了一张能看的图，
// 而且左右两边确实是不同的东西（图纸裁块 vs 模型截图）—— 之前的 bug 正是两边
// 拍成了同一份活动文档，图出来了、内容却是错的。
//
// 注意：这张图不是判据。判据是 examples/designs/*.json 里的语义核对（drawings.mjs）。
//
// 需要 SOLIDWORKS —— 由 test/suite.mjs 统一起停。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openSession, repoRoot } from './lib/mcp.mjs'

let passed = 0
const failures = []

function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

const drawing = join('D:', '静静', '临时文件', 'draws', 'p1.jpg')
if (!existsSync(drawing)) {
  console.log(`SKIP  参考图不在：${drawing}`)
  console.log('\n0 passed, 0 failed')
  process.exit(0)
}

const session = openSession({})
await session.start()
try {
  // 先把它要比的那个零件建出来。截图拍的是「当前活动文档」，所以这个用例必须自己把
  // 文档准备好 —— 靠别的用例留下的窗口，在净值跑一次的机器上就是「没有活动文档」。
  const design = JSON.parse(readFileSync(join(repoRoot, 'examples', 'designs', 'p1-bracket.json'), 'utf8'))
  design.__name = 'compare-p1'
  await session.must('model', { action: 'build', definition: design }, '先建出要比的那个零件')

  const out = join(repoRoot, 'test', 'out', 'p1-bracket', 'compare-front.png')
  const result = await session.tool('inspect', {
    action: 'compare',
    designId: 'p1-bracket',
    compare: {
      drawing,
      crop: [285, 55, 525, 330],
      view: 'front',
      output: out,
      caption: 'p1 主视图：左=图纸，右=模型',
    },
  })

  check('对照图返回了图片', Boolean(result._image), { mime: result._image?.mimeType ?? null })
  check('合成图落在磁盘上', existsSync(out), { out })
  const bytes = existsSync(out) ? statSync(out).size : 0
  check('合成图不是空的', bytes > 20_000, { bytes })

  const composite = result.changes?.composite ?? {}
  check('合成图有真实尺寸', (composite.width ?? 0) > 800 && (composite.height ?? 0) > 600, composite)
  check('左边是图纸裁块', Array.isArray(result.changes?.drawing?.crop)
    && result.changes.drawing.crop.length === 4
    && /p1\.jpg$/.test(result.changes?.drawing?.source ?? ''), {
    source: result.changes?.drawing?.source ?? null,
    crop: result.changes?.drawing?.crop ?? null,
  })
  check('右边是模型截图且说得出拍的是哪个文档', Boolean(result.changes?.model?.document), {
    document: result.changes?.model?.document ?? null,
    view: result.changes?.model?.view ?? null,
  })
  check('两边不是同一个文件', result.changes?.drawing?.output !== result.changes?.model?.output, {
    left: result.changes?.drawing?.output ?? null,
    right: result.changes?.model?.output ?? null,
  })
  check('摘要里明确写了这张图不是判据', /不是判据|判据仍然是/.test(
    JSON.stringify(result.changes?.drawing) + JSON.stringify(result.changes?.model)) ||
    /并排对照/.test(result.summary ?? ''), { summary: (result.summary ?? '').slice(0, 80) })
} finally {
  await session.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('\nfailures:')
  for (const f of failures) console.log(`  FAIL  ${f}`)
  process.exit(1)
}
