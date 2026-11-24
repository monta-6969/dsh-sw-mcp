// 能力清单必须来自真实分派表。
//
// 手写 CAPABILITIES 的两次漂移：sketchSlot 标 unavailable 但桥接器能用，
// linearPattern 标可用但 COM 拒绝。这里钉住生成器本身：操作集合不能重复、
// 每个 SupportedOps 都要有分派分支、mutating 与 LockFree 互补。
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

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

const run = spawnSync(process.execPath, [join(root, 'tools', 'gen-dispatch.mjs'), '--check'], {
  cwd: root, encoding: 'utf8',
})
check('生成器与 Operations.cs 没有漂移', run.status === 0, { status: run.status, stderr: run.stderr?.trim() })

const { DISPATCH, DISPATCH_VERSION } = await import(
  pathToFileURL(join(root, 'server', 'catalog', 'dispatch.generated.mjs')).href
)
const ops = DISPATCH.map((entry) => entry.op)
check('能力表版本为 1', DISPATCH_VERSION === 1, { DISPATCH_VERSION })
check('操作名不重复', new Set(ops).size === ops.length, { count: ops.length, unique: new Set(ops).size })
check('每个操作都有分派分支', DISPATCH.every((entry) => entry.dispatched === true),
  { missing: DISPATCH.filter((e) => !e.dispatched).map((e) => e.op) })
check('mutating 与 lockFree 互补', DISPATCH.every((entry) => entry.mutating === !entry.lockFree))
check('核心操作都在表里', ['build', 'edit', 'save', 'measure', 'sketchGeometry', 'capture'].every((op) => ops.includes(op)),
  { ops })
check('导出别名不会被当成操作', !ops.includes('step') && !ops.includes('stl'), { step: ops.includes('step'), stl: ops.includes('stl') })
// instances / list 进 LockFree 是为了切断 broker 60s ROT 探针触发的窗口整理
// （见 docs/SW-自动化MCP-研究报告.md §3.2）：非 LockFree 操作会调 SwHost.NormalizeUi，
// 即新进程里的 ShowWindow(maximize) —— 心跳曾经每分钟抢一次用户的窗口。
const lockFreeOps = DISPATCH.filter((e) => e.lockFree).map((e) => e.op)
const expectedLockFree = ['status', 'ping', 'version', 'diagnose', 'list', 'interopIndex', 'kinds', 'addins', 'instances']
const asSet = (list) => [...list].sort().join()
check('只读操作确实不走全局锁', asSet(lockFreeOps) === asSet(expectedLockFree),
  { expected: expectedLockFree, lockFree: lockFreeOps })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
