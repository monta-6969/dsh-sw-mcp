// M2: read the model back, and mean the same face twice.
//
// The decisive check is a round trip: take a face, ask where its centre lands on
// screen, select at that pixel, and see whether the answer is the same face —
// same persistent reference. If that holds, "look at the picture and pick the
// face" and "select the face from last call" are the same mechanism.
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test', 'out')

// One bridge process, one request per line, same protocol the server speaks.
const child = spawn(join(root, 'bridge', 'bin', 'SwBridge.exe'), [], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
})
let buffer = ''
const waiters = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = waiters.get(message.id)
    if (!waiter) continue
    waiters.delete(message.id)
    waiter(message)
  }
})

let seq = 0
function call(payload) {
  const id = `t${++seq}`
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      rejectPromise(new Error(`${payload.op} timed out`))
    }, 120_000)
    waiters.set(id, (message) => {
      clearTimeout(timer)
      if (message.ok) {
        const { ok: _ok, op: _op, id: _id, ...rest } = message
        resolvePromise(rest)
      } else rejectPromise(Object.assign(new Error(message.error.message), message.error))
    })
    child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`) }
}

const plate = {
  schemaVersion: 3,
  designId: 'm2-plate',
  params: { 'plate.w': 60, 'plate.h': 40, 'plate.t': 10, 'hole.d': 6, 'hole.edge': 8 },
  features: [
    { kind: 'basePlate', id: 'plate', plane: 0, width: 'plate.w', height: 'plate.h', thickness: 'plate.t' },
    {
      kind: 'holes', id: 'mountingHoles', face: 'top', diameter: 'hole.d', throughAll: true,
      pattern: { kind: 'corners', width: 'plate.w', height: 'plate.h', edge: 'hole.edge' },
    },
  ],
}

const bmpPlain = join(outDir, 'observe-plain.bmp')
const bmpMarked = join(outDir, 'observe-marked.bmp')
const bmpPartial = join(outDir, 'observe-partial.bmp')
for (const f of [bmpPlain, bmpMarked, bmpPartial]) if (existsSync(f)) unlinkSync(f)

try {
  console.log('build a plate to look at')
  const built = await call({ op: 'build', definition: plate })
  check('the part was built', built.geometry?.massProperties?.volume > 0,
    JSON.stringify(built.geometry?.massProperties))
  const analytic = 60 * 40 * 10 - 4 * Math.PI * 9 * 10
  check('volume matches the analytic value',
    Math.abs(built.geometry.massProperties.volume - analytic) < 1,
    `${built.geometry.massProperties.volume} vs ${analytic.toFixed(3)}`)

  console.log('faces')
  const faces = await call({ op: 'faces', limit: 100 })
  check('faces are enumerated', faces.count >= 6, String(faces.count))
  check('every face carries a persistent id',
    faces.faces.every((f) => typeof f.id === 'string' && f.id.length > 8))
  check('every face reports its surface kind',
    faces.faces.every((f) => typeof f.kind === 'string'))
  check('every face reports an area', faces.faces.every((f) => typeof f.area === 'number'))
  const planes = faces.faces.filter((f) => f.kind === 'plane')
  check('the plate has planar faces', planes.length >= 6, String(planes.length))
  const top = planes.find((f) => f.normal && f.normal[2] > 0.99 && f.area > 1000)
  check('the top face is identified by its normal', Boolean(top),
    planes.map((f) => `${f.area}@${f.normal}`).join(' '))
  check('holes leave the top face smaller than the flat area',
    top && top.area < 60 * 40, top?.area)
  const ids = new Set(faces.faces.map((f) => f.id))
  check('persistent ids are distinct', ids.size === faces.faces.length,
    `${ids.size} vs ${faces.faces.length}`)

  console.log('projection')
  const projected = await call({ op: 'project', points: [top.center] })
  check('the centre projects to a point', projected.count === 1, JSON.stringify(projected.points))
  const [px, py] = projected.points[0]
  check('the projected pixel is finite', Number.isFinite(px) && Number.isFinite(py), `${px},${py}`)
  check('the view reports a client size',
    projected.view.clientWidth > 100 && projected.view.clientHeight > 100,
    `${projected.view.clientWidth}x${projected.view.clientHeight}`)
  check('the pixel is inside that client area',
    px >= 0 && py >= 0 && px <= projected.view.clientWidth && py <= projected.view.clientHeight,
    `${px},${py} in ${projected.view.clientWidth}x${projected.view.clientHeight}`)

  console.log('selection round trip')
  const byRay = await call({ op: 'select', mode: 'byRay', x: px, y: py })
  check('a ray at that pixel selects something', byRay.selected === true)
  check('exactly one thing is selected', byRay.selection.count === 1, String(byRay.selection.count))
  check('it is a face', byRay.selection.items[0]?.kind === 'face', byRay.selection.items[0]?.kind)

  // Which side of the plate the camera sees decides whether the ray lands on
  // the top or the bottom face, so the invariant is not "it must be `top`".
  // It is: the face that was hit must project back onto the pixel that was
  // clicked. That holds for whichever face is actually in front.
  const hitId = byRay.selection.items[0]?.id
  const hit = faces.faces.find((f) => f.id === hitId)
  check('the hit is a face this call enumerated', Boolean(hit), hitId)
  const back = await call({ op: 'project', points: [hit.center] })
  check('the hit face projects back onto the clicked pixel',
    Math.abs(back.points[0][0] - px) < 3 && Math.abs(back.points[0][1] - py) < 3,
    `clicked ${px},${py} → back ${back.points[0][0]},${back.points[0][1]}`)

  const byId = await call({ op: 'select', mode: 'byId', persistentId: top.id })
  check('a persistent id selects the same face', byId.selected === true)
  check('the id survives the round trip', byId.selection.items[0]?.id === top.id)

  let stale = null
  try {
    await call({ op: 'select', mode: 'byId', persistentId: 'deadbeefdeadbeefdeadbeefdeadbeef' })
  } catch (error) { stale = error }
  check('a bogus id fails with a code, not a crash', stale && stale.code === 'STALE_SELECTION',
    stale?.code ?? 'no error')

  console.log('capture')
  const plain = await call({ op: 'capture', path: bmpPlain, width: 900, height: 600 })
  check('a plain capture is written', plain.saved && plain.bytes > 10000, String(plain.bytes))
  check('it highlights nothing when asked for nothing',
    plain.highlight?.count === 0, JSON.stringify(plain.highlight))

  const marked = await call({
    op: 'capture', path: bmpMarked, width: 900, height: 600,
    highlight: [top.id, hitId],
    caption: 'M2 observe: 高亮的是本次读到的面',
  })
  check('a highlighted capture is written', marked.saved && marked.bytes > 10000, String(marked.bytes))
  check('both highlights were applied', marked.highlight?.count === 2,
    JSON.stringify(marked.highlight?.failed))
  check('the highlight reports the ids it used',
    (marked.highlight?.applied ?? []).length === 2)

  // BMP is uncompressed, so two images of the same size have the same byte
  // count no matter what was drawn on them. Compare the content instead.
  const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12)
  check('the highlighted image differs from the plain one',
    existsSync(bmpPlain) && existsSync(bmpMarked) && hash(bmpPlain) !== hash(bmpMarked),
    `${hash(bmpPlain)} vs ${hash(bmpMarked)}`)

  // A stale id must not abort the capture: the picture is still useful.
  const partial = await call({ op: 'capture', path: bmpPartial, width: 600, height: 400,
    highlight: [top.id, 'deadbeefdeadbeefdeadbeefdeadbeef'],
  })
  check('a stale id is reported, not thrown', partial.saved === true
    && partial.highlight?.count === 1 && partial.highlight?.failed?.length === 1,
    JSON.stringify({ count: partial.highlight?.count, failed: partial.highlight?.failed?.length }))

  // 截图拍的是「活动文档」，不是「刚刚打开的那个」。连着开两个零件时，第二个 open
  // 没有把文档切到前台，结果两张图都是第二个零件，而两次都回 saved:true。
  console.log('两个文档连着开，看截图拍的是不是各自的那个')
  const pathA = join(outDir, 'activate-a.SLDPRT')
  const pathB = join(outDir, 'activate-b.SLDPRT')
  for (const p of [pathA, pathB]) if (existsSync(p)) unlinkSync(p)

  await call({ op: 'save', path: pathA })
  const cube = {
    schemaVersion: 3,
    designId: 'm2-cube-b',
    params: { 'b.s': 20 },
    features: [{ kind: 'basePlate', id: 'cube', plane: 0, width: 'b.s', height: 'b.s', thickness: 'b.s' }],
  }
  await call({ op: 'build', definition: cube })
  await call({ op: 'save', path: pathB })

  // 此时活动文档是 B。再 open A —— A 早就开着，OpenDoc6 会直接返回它而不切前台。
  const reopened = await call({ op: 'open', path: pathA })
  check('open 之后 activeIsRequested 为真', reopened.activeIsRequested === true,
    JSON.stringify({ wanted: reopened.title, active: reopened.activeTitle }))
  const shotA = await call({ op: 'capture', path: join(outDir, 'activate-a.bmp'), width: 400, height: 300 })
  check('open A 之后拍的是 A', shotA.document?.title === 'activate-a.SLDPRT',
    JSON.stringify({ captured: shotA.document?.title }))

  await call({ op: 'open', path: pathB })
  const shotB = await call({ op: 'capture', path: join(outDir, 'activate-b.bmp'), width: 400, height: 300 })
  check('open B 之后拍的是 B', shotB.document?.title === 'activate-b.SLDPRT',
    JSON.stringify({ captured: shotB.document?.title }))
} catch (error) {
  fail++
  console.log(`  FAIL harness — ${error.message}`)
} finally {
  child.kill()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
