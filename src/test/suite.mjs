// 测试套的总控：SOLIDWORKS 只起一次、只退一次。
//
// 每个测试文件自己不管生命周期（除了 m5/m6/m7，它们也接受外部已经起好的实例），
// 因为冷启动 50 秒、退出要等它写恢复数据；如果每个文件各起各退，一轮下来既慢，
// 又容易留下多个进程和一堆文档窗口——那正是"打开了十个 SW 窗口"的来历。
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  adoptOwned,
  killOwned,
  ownedSolidworks,
  reapTestInstances,
  snapshotSolidworks,
  TEST_TAG,
} from './lib/sw.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const LNK = 'C:\\Users\\mota\\Desktop\\sw\\SOLIDWORKS Design 2026.lnk'
// 这一轮里由 suite 启动的实例从哪个基线之后出现的；owned 的 pid 记在
// test/.state/sw-pids.json，收尾只按这个名单杀（pid + CreationDate 双条件）。
let ownedBaseline = []
let ownedSince = Date.now()

const files = process.argv.slice(2)
const plan = files.length ? files : [
  'syntax.mjs', 'contracts.mjs', 'dispatch.mjs', 'assemble-designid.mjs', 'affinity.mjs', 'instance-reap.mjs', 'jobs.mjs', 'broker.mjs', 'broker-run.mjs', 'tasks.mjs', 'mcp-ops.mjs', 'smoke.mjs', 'cwd.mjs', 'patch.mjs', 'isolation.mjs', 'images.mjs', 'actions.mjs', 'bridge-errors.mjs', 'prompt.mjs', 'plugins.mjs', 'bili-bypass.mjs', 'presets.mjs', 'polite-mode.mjs', 'sketch-plan.mjs', 'read-only-guard.mjs', 'relations-edit.mjs', 'delivery-check.mjs', 'deliver-route.mjs', 'definition-arg.mjs', 'design-store.mjs', 'design-contract.mjs', 'review-read.mjs', 'verify-designid.mjs', 'snapshot.mjs', 'params.mjs', 'invoke-units.mjs', 'lesson.mjs', 'acceptance.mjs',
  // plugin-fixes / envelope-shape 排在任何真机用例之前：它们只读源码与假桥接器，
  // 十秒内就能把「这一轮改的行为被回滚了」暴露出来，不必等真机跑起来才发现。
  'plugin-fixes.mjs', 'gear-params.mjs', 'feature-tree.mjs', 'stage-runtime.mjs', 'compact-surface.mjs', 'model-invoke-batch.mjs', 'envelope-shape.mjs', 'verify-shape.mjs', 'observe-mcp.mjs',
  'bindings.mjs', 'm3.mjs', 'acceptance-mcp.mjs', 'calculate.mjs', 'm5.mjs', 'm6.mjs', 'm7.mjs', 'kinds.mjs', 'curves.mjs', 'sweep-helix-loft.mjs', 'sketch-live.mjs', 'relations-live.mjs', 'sweep-helix-loft.mjs', 'gear.mjs', 'gear-native.mjs', 'pattern.mjs', 'objects.mjs',
  'drawing-schema.mjs', 'evidence-schema.mjs', 'noop-guard.mjs', 'unmeasured.mjs', 'cut-semantics.mjs', 'check-status.mjs', 'concurrency.mjs', 'bugfix-live.mjs', 'plugin-fixes-live.mjs',
  'compare.mjs', 'drawings.mjs', 'analysis.mjs', 'analysis-mesh.mjs', 'snapshot-live.mjs', 'broker-live.mjs', 'ui-live.mjs', 'diff-live.mjs', 'reclaim-live.mjs', 'native-dims.mjs', 'reopen-live.mjs', 'manual-edit-live.mjs', 'job-resume-live.mjs', 'parallel-live.mjs', 'parallel-overlap.mjs', 'assembly-parallel.mjs', 'multi-session.mjs', 'plugin-digest.mjs',
  'isolation-pid.mjs',
]
// 不需要 SOLIDWORKS 的排在前面，这样"先跑快的"能尽早暴露语法与契约问题。
const needsSolidworks = new Set(['objects.mjs', 'verify-shape.mjs', 'acceptance.mjs', 'observe-mcp.mjs', 'm3.mjs', 'acceptance-mcp.mjs', 'm5.mjs', 'm6.mjs', 'm7.mjs', 'kinds.mjs', 'curves.mjs', 'sweep-helix-loft.mjs', 'sketch-live.mjs', 'relations-live.mjs', 'gear.mjs', 'gear-native.mjs', 'pattern.mjs', 'noop-guard.mjs', 'unmeasured.mjs', 'compare.mjs', 'drawings.mjs', 'cut-semantics.mjs', 'check-status.mjs', 'concurrency.mjs', 'bugfix-live.mjs', 'plugin-fixes-live.mjs', 'deliver-gate.mjs', 'bindings.mjs', 'snapshot-live.mjs', 'broker-live.mjs', 'ui-live.mjs', 'diff-live.mjs', 'reclaim-live.mjs', 'native-dims.mjs', 'reopen-live.mjs', 'manual-edit-live.mjs', 'job-resume-live.mjs', 'parallel-live.mjs', 'parallel-overlap.mjs', 'assembly-parallel.mjs', 'multi-session.mjs'])

function processCount() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '@(Get-Process SLDWORKS -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' })
    const n = Number(out.trim())
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 启动 SOLIDWORKS 并记下「从这一基线之后出现的新 pid 才是我们的」。 */
function startSolidworks() {
  ownedBaseline = snapshotSolidworks()
  ownedSince = Date.now()
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Start-Process -FilePath '${LNK}'`], { stdio: 'ignore' })
}

/** 轮询期间新出现的进程也要认领：晚起的实例同样属于这一轮。
 *  只有「这一轮是测试自己启动的」才认领：用户先开着的实例绝不能记成 owned，
 *  否则收尾时可能误杀用户窗口（owned 名单只用于杀，不用于复用）。 */
function refreshOwned() {
  if (!startedHere) return ownedSolidworks()
  return adoptOwned({ baseline: ownedBaseline, since: ownedSince })
}

// 每个用例都要有上限：一次同步死循环就能让整套永远卡住，而且不抛错、没日志。
// 实测过：restrict 插件少一个防重入守卫，宿主主线程 100% 转圈。
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 15 * 60_000)

function run(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(here, file)], {
      cwd: repo, stdio: 'inherit', env: process.env,
    })
    let done = false
    const finish = (code, timedOut = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, timedOut })
    }
    const timer = setTimeout(() => {
      console.error(`测试 ${file} 超过 ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒没有结束，杀掉它继续下一个`)
      try { child.kill('SIGKILL') } catch {}
      finish(1, true)
    }, TEST_TIMEOUT_MS)
    child.on('exit', (code) => finish(code))
    child.on('error', (error) => { console.error(`测试 ${file} 起不来：${error.message}`); finish(1) })
  })
}

/** Reads one status line from the bridge without starting a whole MCP session. */
/** Reads one status line from the bridge without starting a whole MCP session. */
function bridgeStatus() {
  return new Promise((resolvePromise) => {
    let out = ''
    const child = spawn(join(repo, 'bridge', 'bin', 'SwBridge.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.includes('\n')) {
        child.kill()
        try { resolvePromise(JSON.parse(out.trim().split('\n')[0])) } catch { resolvePromise({ ready: false }) }
      }
    })
    child.on('exit', () => resolvePromise({ ready: false }))
    child.stdin.write(JSON.stringify({ id: 1, op: 'status' }) + '\n')
    setTimeout(() => { child.kill(); resolvePromise({ ready: false }) }, 20_000)
  })
}

/** SOLIDWORKS takes about a minute to answer COM; the tests assume it already does. */
async function waitUntilReady(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    refreshOwned()
    const status = await bridgeStatus()
    if (status.ready === true) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
  }
  return false
}

/** Builds a 10 mm cube and measures it.
 *
 * A long-lived SOLIDWORKS answers `status: ready` and still fails the first real
 * build — measured on an instance that had been up four hours: `ready` true, then
 * `NO_ACTIVE_DOC` right after a save. "It answers COM" is not "it can work", so the
 * suite asks for one cheap piece of evidence before spending ten minutes.
 */
async function healthProbe() {
  try {
    const { openSession } = await import('./lib/mcp.mjs')
    const s = openSession({})
    await s.start()
    try {
      await s.tool('workspace', { action: 'cleanup' })
      const built = await s.tool('model', {
        action: 'build',
        definition: {
          designId: 'health',
          features: [
            { kind: 'sketch', id: 's', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 10, height: 10 }] },
            { kind: 'extrude', id: 'e', profile: 's', depth: 10, direction: '+Y' },
          ],
        },
      })
      const volume = built.measurements?.volume
      const solidOk = built.status === 'ok' && Math.abs(volume - 1000) < 1

      // 「建得出来」不等于「还能参数化」。长时间运行的实例会正常建模、
      // 但每次往方程式管理器写东西都返回 -1 —— 件是静态的，尺寸改了不动。
      // 这一层只能靠「建一个带参数的件，看绑定回没回来」才能发现。
      const bound = await s.tool('model', {
        action: 'build',
        definition: {
          designId: 'health-params',
          params: { 'cube.w': 10, 'cube.h': 10, 'cube.t': 10 },
          features: [
            { kind: 'sketch', id: 'p', plane: 1, primitives: [{ shape: 'rect', center: [0, 0], width: 'cube.w', height: 'cube.h', bind: { width: 'cube.w', height: 'cube.h' } }] },
            { kind: 'extrude', id: 'pe', profile: 'p', depth: 'cube.t', bind: { depth: 'cube.t' } },
          ],
        },
      })
      const bindingCount = Object.keys(bound.changes?.bindings ?? {}).length
      const drivers = bound.changes?.drivers ?? {}
      // 这个实例接受方程式 → 绑定数就是判据；拒绝时官方现在的做法是把参数烘进几何、
      // 由 model action=edit 重建，所以「驱动方式被如实报告」也算健康。
      const driven = bindingCount > 0 || (drivers.mode === 'literal' && (drivers.requested ?? 0) > 0)
      return {
        ok: solidOk && driven,
        volume,
        bindingCount,
        drivers,
        summary: driven ? built.summary : `建模成功但既没绑上参数也没报告驱动方式（${bound.status}：${bound.summary}）`,
      }
    } finally {
      await s.close()
    }
  } catch (error) {
    return { ok: false, summary: error.message }
  }
}

// 桥接器是 MCP server / broker worker 的子进程。会话正常关闭时它会读到 stdin EOF
// 自己退，但测试里被杀掉的会话、被中断的脚本都会留下孤儿 —— 实测一套测试跑下来
// 攒过 19 个。这里只收「父进程已经不在」的孤儿：按名字全杀会连用户 broker 的
// 常驻 worker 一起干掉，那等于把用户的会话弄坏。
function killOrphanBridges() {
  try {
    const script = [
      "$bridges = @(Get-CimInstance Win32_Process -Filter \"Name='SwBridge.exe'\" -ErrorAction SilentlyContinue)",
      '$orphans = @()',
      'foreach ($bridge in $bridges) {',
      '  $parentAlive = $null -ne (Get-Process -Id $bridge.ParentProcessId -ErrorAction SilentlyContinue)',
      '  if (-not $parentAlive) { $orphans += $bridge.ProcessId }',
      '}',
      'if ($orphans.Count -gt 0) { Stop-Process -Id $orphans -Force -ErrorAction SilentlyContinue }',
      'Write-Output $orphans.Count',
    ].join('; ')
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    const count = Number.parseInt(out.trim(), 10)
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  }
}

const results = []
let startedHere = false
let ready = false

try {
  // broker 的 maintenance 按「launchedBy=test + 无 client + 空闲 > grace」回收实例；
  // 套件里大量用例直连桥接器，在 broker 眼里永远空闲，一旦某个用例（如 snapshot-live 的
  // job ensure）把 broker 拉起来，60 秒后它就会把套件的 SOLIDWORKS 收走（T6 复现过）。
  // 默认把 grace 拉到 1 小时；调用方显式设了就不覆盖。收尾仍是 workspace reap tag=test + owned 名单。
  if (!process.env.SW_MCP_REAP_GRACE_MS) {
    process.env.SW_MCP_REAP_GRACE_MS = '3600000'
    console.log('· 默认 SW_MCP_REAP_GRACE_MS=3600000（避免 broker maintenance 回收套件实例；已显式设置则不覆盖）')
  }
  const count = processCount()
  if (count === 0) {
    console.log('· SOLIDWORKS 没在跑，开始一次（约 50 秒）')
    startSolidworks()
    startedHere = true
  } else if (count > 1) {
    console.warn(`· 检测到 ${count} 个 SLDWORKS 进程；测试只会用其中一个，但你可能想先关掉多余的`)
  } else {
    console.log('· 复用已经开着的 SOLIDWORKS')
  }

  async function closeTestDocuments() {
    try {
      const { openSession, repoRoot } = await import('./lib/mcp.mjs')
      const { join } = await import('node:path')
      const s = openSession({})
      // 路径必须是 Windows 原生写法：桥接器拿 GetPathName() 的返回值做前缀比较
      await s.start()
      await s.tool('workspace', {
        action: 'closePath',
        pathPrefix: join(repoRoot, 'test', 'out'),
      })
      await s.close()
    } catch {
      // 清理失败不该让整个测试套失败：它只影响窗口数量。
    }
  }

  // 先要一块证据：它现在真的能建东西。只在失败时才动别人的实例。
  ready = await waitUntilReady()
  if (!ready) throw new Error('SOLIDWORKS 一直没就绪（等了 5 分钟）')
  const health = await healthProbe()
  if (!health.ok) {
    if (!startedHere) {
      throw new Error(`SOLIDWORKS 自检没通过（${health.summary ?? health.volume}），`
        + '但这个实例不是测试启动的：按约定不重启用户实例。请手动重启 SOLIDWORKS 后重跑，'
        + '或先关掉它让测试自己起（KEEP_SW=1 可保留测试起的实例）')
    }
    console.warn(`· 自检没通过（${health.summary ?? health.volume}），重启一次自己启动的 SOLIDWORKS`)
    killOwned()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
    startSolidworks()
    ready = await waitUntilReady()
    if (!ready) throw new Error('SOLIDWORKS 重启后仍然不可用')
    const retry = await healthProbe()
    if (!retry.ok) throw new Error(`SOLIDWORKS 重启后仍然建不出东西：${retry.summary}`)
    console.log(`· 重启后正常（体积 ${retry.volume} mm³）`)
  } else {
    console.log(`· 健康检查通过（体积 ${health.volume} mm³）`)
  }

  /** Between files: if SOLIDWORKS stopped answering, restart it once.
   *
   * A modal dialog or a dead COM connection shows up mid-run (measured: a build
   * followed by a drawing left a dialog behind, every later call failed with
   * SW_BLOCKED_BY_DIALOG). Failing the whole suite for that hides the tests that
   * would have passed; restarting costs fifty seconds.
   */
  async function ensureHealthy() {
    const status = await bridgeStatus()
    if (status.ready === true) return true
    if (!startedHere) {
      console.warn(`· SOLIDWORKS 不可用（${status.reason ?? '未知'}），但它不是测试启动的：不重启用户实例`)
      return false
    }
    console.warn(`· SOLIDWORKS 不可用（${status.reason ?? '未知'}），重启一次自己启动的实例`)
    killOwned()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
    startSolidworks()
    if (!(await waitUntilReady())) return false
    const retry = await healthProbe()
    if (!retry.ok) console.warn(`· 重启后仍然建不出东西：${retry.summary}`)
    return retry.ok
  }

  for (const file of plan) {
    console.log(`\n=== ${file}`)
    if (needsSolidworks.has(file)) await ensureHealthy()
    const outcome = await run(file)
    results.push({ file, code: outcome.code, timedOut: outcome.timedOut })
    // 每个文件跑完就把它留下的窗口关掉。测试会建几十个文档，不关的话 SOLIDWORKS
    // 里会堆出十几个窗口（用户为此提过一次），而重启一次要五十秒。
    await closeTestDocuments()
    const orphans = killOrphanBridges()
    if (orphans > 0) console.log(`· 收掉 ${orphans} 个遗留（父进程已退）的桥接器进程`)
    if (outcome.code !== 0 && needsSolidworks.has(file)) {
      console.error(`测试 ${file} 失败，后面的依赖 SOLIDWORKS 的用例不再继续`)
      break
    }
  }
} finally {
  killOrphanBridges()
  if (process.env.KEEP_SW !== '1') {
    // 先让 broker 按 tag=test 回收（cleanup 未存盘文档 → quit → 15 秒不退才按 pid 收尾），
    // 再拿 owned 名单兜底：broker 没起、或 workspace reap 还没实现时也能收干净。
    if (startedHere || ownedSolidworks().length > 0) {
      console.log('')
      console.log('· 回收测试实例（workspace reap tag=test → 只杀 owned）')
      try {
        const { openSession } = await import('./lib/mcp.mjs')
        const s = openSession({
          env: { ...process.env, SW_MCP_BROKER: '1', SW_MCP_BROKER_ENSURE: '0', SW_MCP_INSTANCE_TAG: TEST_TAG },
        })
        await s.start()
        try {
          const reaped = await reapTestInstances((name, args) => s.tool(name, args))
          console.log(`  reap: ${JSON.stringify(reaped?.changes ?? reaped)}`)
        } finally {
          s.close()
        }
      } catch (error) {
        console.warn(`  workspace reap 不可用（${error?.message ?? error}），直接按 owned 名单收尾`)
      }
      const result = killOwned()
      if (result.killed.length > 0) console.log(`· 按 owned 名单（pid+CreationDate）收掉 ${result.killed.join(', ')}`)
      else console.log('· 没有仍存活的 owned 实例')
    }
  } else {
    console.log('')
    console.log('· KEEP_SW=1：保留测试启动的 SOLIDWORKS（pid 名单留在 test/.state/sw-pids.json）')
  }

  const failed = results.filter((r) => r.code !== 0)
  console.log('\n=== 汇总')
  for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : r.timedOut ? 'FAIL(timeout)' : 'FAIL'}  ${r.file}`)
  console.log(`  ${results.length - failed.length}/${results.length} 个文件通过`)
  if (failed.length) process.exitCode = 1
}
