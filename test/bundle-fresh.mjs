// 打包后的新会话冒烟：把 test/out/sw-ptc-check.zip 解到临时目录，用解出来的
// server.mjs 起一个全新 MCP 会话，确认工具清单与 workspace 状态可用。
//
// 这不是替代真实 DSH 新会话（那一步还要宿主装载 preset），但它能抓住最常见的
// 打包事故：漏文件、相对路径写死仓库、bridge/contracts 没带进去。
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openSession } from './lib/mcp.mjs'

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

const zip = resolve(import.meta.dirname, 'out', 'sw-ptc-check.zip')
if (!existsSync(zip)) {
  console.log('SKIP  没有 test/out/sw-ptc-check.zip；先跑 python tools/package.py')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'sw-bundle-'))
const dataDir = join(root, 'data')
// 跑一条外部命令，失败时把 stderr 带出来（以前 stdio:'ignore' 会把真正的原因吞掉，
// 只剩一句 "Command failed"）。
function run(label, command, args, options) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
  } catch (error) {
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim() || error.message
    throw new Error(`${label}失败（exit ${error.status ?? '?'}）：${detail.slice(0, 1500)}`)
  }
}

// 解压不要依赖宿主 PowerShell 7 的模块路径：从 PS7 起的 node 会继承 PS7 的
// PSModulePath，Windows PowerShell 5.1 会据此把 Microsoft.PowerShell.Archive
// 解析到 WindowsApps 下的 PS7 副本，而那处脚本执行被策略禁止 →
// "Expand-Archive 是找不到的命令"。删掉继承来的 PSModulePath，让 5.1 用回自己的默认值。
const ps51Env = { ...process.env }
delete ps51Env.PSModulePath
run('解压 test/out/sw-ptc-check.zip', 'powershell', ['-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${root.replace(/'/g, "''")}' -Force`],
{ env: ps51Env })
// 安装包不带 node_modules；真实安装由 install.ps1 跑 npm install。
run('npm install', 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
  { cwd: root, shell: true })

const session = openSession({
  entry: join(root, 'server', 'server.mjs'),
  cwd: root,
  env: { ...process.env, SW_MCP_DATA: dataDir },
})

try {
  await session.start()
  const tools = (await session.call('tools/list', {})).tools ?? []
  const names = tools.map((tool) => tool.name)
  check('打包后的 server 能起来并列出工具', names.includes('model') && names.includes('workspace'), names.length)
  check('新增工具在包里', ['analysis', 'job', 'task'].every((name) => names.includes(name)), names)
  const status = await session.must('workspace', { action: 'status' }, '打包后的 workspace 状态')
  check('workspace 状态是 ok（不是 failed/unavailable）', status.status === 'ok', status.status)
  const caps = status.capabilities?.items ?? []
  check('能力表完整（至少 19 项）', Array.isArray(caps) && caps.length >= 19, caps.length)
  check('桥接器已连接（当前有 SOLIDWORKS 时）', /已连接/.test(String(status.summary ?? '')), status.summary)
} finally {
  try { session.close() } catch { }
  // Windows 上子进程可能还没放开句柄；清不掉不影响本次结论，留个提示。
  try { rmSync(root, { recursive: true, force: true }) } catch (error) {
    console.log(`· 临时目录留到下次清理：${root}（${error.code}）`)
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
