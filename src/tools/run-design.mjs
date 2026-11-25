// Builds one design file end to end and leaves pictures behind.
//
//   node tools/run-design.mjs examples/designs/p1-bracket.json            build + screenshots
//   node tools/run-design.mjs examples/designs/p1-bracket.json --keep     leave SOLIDWORKS running
//   node tools/run-design.mjs examples/designs/p1-bracket.json --no-shots skip the screenshots
//
// The point is that a drawing becomes a design file, and a design file becomes a
// verified model with a picture — the same three steps every time, so a failure
// says which step failed instead of which ad-hoc script was being run.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { openSession, repoRoot } from '../test/lib/mcp.mjs'
import { ensureSolidworks, shutdownSolidworks } from '../test/lib/sw.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('usage: node tools/run-design.mjs <design.json> [--no-shots] [--keep] [--name <id>]')
  process.exit(2)
}

const designPath = resolve(process.cwd(), file)
const design = JSON.parse(readFileSync(designPath, 'utf8'))
const designId = process.env.DESIGN_ID
  ?? (args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined)
  ?? basename(designPath, '.json')

const outDir = join(repoRoot, 'test', 'out', designId)
mkdirSync(outDir, { recursive: true })

const wantShots = !args.includes('--no-shots')
const session = openSession()
let startedHere = false
const report = { designId, design: designPath, steps: [] }
const t0 = Date.now()

function log(step, detail) {
  const ms = Date.now() - t0
  console.log(`[${String(ms).padStart(6)} ms] ${step}${detail ? ' — ' + detail : ''}`)
  report.steps.push({ step, ms, detail })
}

try {
  await session.start()
  const sw = await ensureSolidworks(session.tool)
  startedHere = sw.startedHere
  log('status', `solidworks ${sw.reason}`)
  if (sw.reason !== 'ready') {
    throw new Error(`SOLIDWORKS not ready: ${sw.reason}`)
  }

  // A build always starts from a clean slate: a leftover document makes SOLIDWORKS
  // answer mismatched and the volume check then blames the geometry.
  await session.tool('workspace', { action: 'cleanup' })

  design.designId = designId
  const built = await session.must('model', { action: 'build', designId, definition: design }, 'build')
  const volume = built.measurements?.volume
  const box = built.measurements?.boundingBox
  log('build', `volume ${volume} mm3, box ${JSON.stringify(box)}`)
  if (built.changes?.notes?.length) {
    for (const note of built.changes.notes.slice(0, 12)) log('  note', note)
  }

  const features = built.changes?.features ?? []
  log('features', features.map((f) => `${f.kind}:${f.featureName ?? '-'}`).join(', '))

  // Save first: a screenshot of an unsaved document still works, but a failure
  // later should not cost the geometry.
  const partPath = join(outDir, `${designId}.SLDPRT`)
  const saved = await session.tool('deliver', { designId, kind: 'sldprt', path: partPath })
  if (saved.status === 'ok' && existsSync(partPath)) {
    log('save', `${partPath} (${statSync(partPath).size} bytes)`)
  } else {
    log('save', `FAILED ${saved.summary}`)
  }

  if (wantShots) {
    const shots = design.__shots ?? [
      { name: 'iso', view: '*等轴测' },
      { name: 'front', view: '*前视' },
      { name: 'top', view: '*上视' },
      { name: 'right', view: '*右视' },
    ]
    for (const shot of shots) {
      const png = join(outDir, `${shot.name}.png`)
      const shotResult = await session.tool('capture', {
        designId,
        path: png,
        width: shot.width ?? 1100,
        height: shot.height ?? 800,
        view: shot.view,
        caption: `${designId} · ${shot.name}`,
      })
      if (shotResult.status === 'ok') log(`shot ${shot.name}`, `${png} ${statSync(png).size} bytes`)
      else log(`shot ${shot.name}`, `FAILED ${shotResult.summary}`)
    }
  }

  // Say out loud what the model actually is, so a wrong interpretation is
  // visible in the log instead of only in the picture.
  const volumeReport = design.__expectVolume
  if (typeof volumeReport === 'number') {
    const delta = Math.abs(volume - volumeReport) / volumeReport
    log('volume check', `expected ${volumeReport}, got ${volume}, delta ${(delta * 100).toFixed(3)}%`)
    if (delta > 0.005) report.volumeMismatch = true
  }

  // Semantic checks: these decide whether the model matches the drawing. Volume
  // and bounding box are recorded but never decide anything — a solid of the right
  // size can still be the wrong shape.
  if (design.__expect?.checks?.length) {
    const check = await session.tool('inspect', {
      action: 'verify',
      designId,
      expect: design.__expect,
    })
    report.checks = check.changes?.checks ?? []
    report.checkStatus = check.status
    log('checks', `${check.status}: ${check.summary}`)
    for (const row of report.checks) {
      log(`  ${row.pass ? 'ok  ' : 'FAIL'} ${row.name}`, row.detail ?? '')
    }
    if (check.status !== 'ok') report.checksFailed = true
  }

  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  log('done', `artifacts in ${outDir}`)
  if (report.volumeMismatch) process.exitCode = 3
} catch (error) {
  log('ERROR', error.message)
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  try {
    await shutdownSolidworks(session.tool, startedHere)
  } catch {
    /* gone is fine */
  }
  session.close()
}
