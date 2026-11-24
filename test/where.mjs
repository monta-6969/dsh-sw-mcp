import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'out')
const target = path.join(outDir, 'acceptance-b.sldprt')

console.log('here    :', JSON.stringify(here))
console.log('outDir  :', JSON.stringify(outDir))
console.log('target  :', JSON.stringify(target))
console.log('outDir exists:', fs.existsSync(outDir))
try {
  console.log('readdir :', fs.readdirSync(outDir))
} catch (e) {
  console.log('readdir error:', e.code)
}
console.log('target exists:', fs.existsSync(target))

// write a probe file and read it back to prove the directory is writable here
const probe = path.join(outDir, 'probe.txt')
fs.writeFileSync(probe, 'ok')
console.log('probe written, exists:', fs.existsSync(probe), 'readdir now:', fs.readdirSync(outDir))
