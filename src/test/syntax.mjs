// 语法自检：每个 .mjs/.js 都用 node --check 过一遍。
//
// 存在的理由很具体：这一轮里用脚本批量改 JS 时，`\n` 被写成了真换行，
// 于是 review-gate.mjs 里一个字符串跨了两行 —— 直到跑那一个测试文件才炸。
// 一个 3 秒的全仓语法扫描比那种「跑到第 12 个文件才发现」便宜得多。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const targets = []
for (const dir of ['.', 'server', 'server/catalog', 'server/tools', 'test', 'test/lib', 'tools']) {
  let entries
  try { entries = readdirSync(join(root, dir)) } catch { continue }
  for (const entry of entries) {
    if (!/\.(mjs|js)$/.test(entry)) continue
    const full = join(root, dir, entry)
    if (!statSync(full).isFile()) continue
    targets.push(full)
  }
}

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) passed += 1
  else failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail !== undefined) console.log(`      ${detail}`)
}

check('扫到的文件数合理（>= 15）', targets.length >= 15, targets.length)

for (const file of targets) {
  const shown = relative(root, file).split(String.fromCharCode(92)).join('/')
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    check(shown, true)
  } catch (error) {
    const text = `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? ''}`
    const first = text.split('\n').find((line) => line.trim() && !/^\s*\^/.test(line)) ?? ''
    check(shown, false, first.trim().slice(0, 160))
  }
}

// CRLF 混进正则/字符串是同一类事故的另一种形态：仓库统一用 LF。
//
// 注意这里曾经恒 PASS：readFileSync 没被 import，try/catch 把 ReferenceError 吞掉，
// 于是每个文件都算「不含 CR」。补上 import 之后，再用一个**故意含 CRLF 的临时文件**
// 证明这条断言真的会 FAIL（见文件末尾的自检），否则又只是一个永远绿的字面量。
function crlfFiles(files) {
  return files.filter((file) => {
    try { return readFileSync(file, 'utf8').includes(String.fromCharCode(13)) } catch { return false }
  })
}
const crlf = crlfFiles(targets)
check('没有 CRLF 文件', crlf.length === 0, crlf.map((f) => relative(root, f)).join(', '))

// 自检：造一个含 CRLF 的文件，同一套判据必须把它挑出来；随后删掉，不留痕。
const probeDir = mkdtempSync(join(tmpdir(), 'sw-syntax-crlf-'))
const probeFile = join(probeDir, 'crlf-probe.mjs')
try {
  writeFileSync(probeFile, `const a = 1${String.fromCharCode(13)}${String.fromCharCode(10)}export default a\n`, 'utf8')
  const caught = crlfFiles([probeFile]).length === 1
  check('CRLF 断言自检：造一个 CRLF 文件必须被挑出来', caught,
    caught ? undefined : `${probeFile} 含 CRLF 却没被挑出来 —— 这条断言是假的`)
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
