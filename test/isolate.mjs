// Isolates one question: after the bridge reports a successful save, can this same
// Node process see the file? Run standalone to keep directory churn out of the way.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bridge = path.join(path.dirname(here), 'bridge', 'bin', 'SwBridge.exe')
const outDir = path.join(here, 'out')

function call(req) {
  const p = spawnSync(bridge, [], { input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 64 << 20 })
  return JSON.parse((p.stdout || '').trim())
}

fs.mkdirSync(outDir, { recursive: true })
const target = path.join(outDir, 'isolate.sldprt')

console.log('outDir realpath:', fs.realpathSync(outDir))
console.log('before save, entries:', fs.readdirSync(outDir))

const design = JSON.parse(fs.readFileSync(path.join(here, 'design-base-b.json'), 'utf8'))
const built = call({ op: 'build', definition: design })
console.log('build ok:', built.ok, 'title:', built.document?.title)

const saved = call({ op: 'save', designId: 'base-b', path: target })
console.log('save response:', JSON.stringify(saved).slice(0, 300))

console.log('exists right after:', fs.existsSync(target))
console.log('entries right after:', fs.readdirSync(outDir))
try {
  console.log('stat:', fs.statSync(target).size)
} catch (e) {
  console.log('stat failed:', e.code)
}

// and what does a fresh listing from the OS say?
const again = spawnSync('cmd', ['/c', 'dir', '/b', outDir], { encoding: 'utf8' })
console.log('cmd dir says:', (again.stdout || '').trim().split(/\r?\n/).filter(Boolean))
