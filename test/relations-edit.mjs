// 关系引用的语法与工具面契约：本文件自己不启动 SOLIDWORKS。
//
// 语法本体在 C#（bridge/src/Relations.cs 的 ParseRef/Validate）。在 JS 里再写一份
// 断言等于只证明「复制品和自己的复制品一致」，所以这里直接把请求打给桥接器的
// `relations action="validate"`：它是纯解析路径，SW 关着也答（Operations.IsPureRequest）。
// 套件里跑时 SW 可能是开着的（suite 会先起实例），所以「非纯动作」的断言只要求
// 如实报错（not-running 或 NO_ACTIVE_DOC），不要求某一个特定码。
// 同时核对服务端工具面真的把 relationAction/dimensionAction 暴露出来。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPATCH } from '../server/catalog/dispatch.generated.mjs'
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

/** 直接驱动桥接器：一行请求、一行应答。SW 关着也必须答。 */
function bridgeSession() {
  const child = spawn(join(repoRoot, 'bridge', 'bin', 'SwBridge.exe'), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  const waiters = new Map()
  let nextId = 1
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
      if (waiter) { waiters.delete(message.id); waiter(message) }
    }
  })
  const call = (payload) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++
    waiters.set(id, resolvePromise)
    const timer = setTimeout(() => {
      waiters.delete(id)
      rejectPromise(new Error(`桥接器 ${payload.op} 超时（SW 关着时 validate 也必须秒回）`))
    }, 15_000)
    waiters.set(id, (value) => { clearTimeout(timer); resolvePromise(value) })
    child.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
  })
  return { call, close: () => child.kill() }
}

const bridge = bridgeSession()
try {
  // ------------------------------------------------------------ 引用语法
  const references = await bridge.call({
    op: 'relations',
    action: 'validate',
    segments: 4,
    refs: [
      'seg:1', 'seg:2:start', 'seg:3:end', 'seg:4:center',
      'seg:0', 'seg:9', 'seg:2:middle', 'a:b:c', 'arc1:centre',
    ],
  })
  check('SW 关着时 relations action=validate 也能答（纯解析路径）',
    references?.ok === true && references?.action === 'validate'
    && references?.error?.code === undefined, references?.error?.code ?? 'ok')

  const rows = Array.isArray(references?.refs) ? references.refs : []
  const row = (reference) => rows.find((item) => item.reference === reference) ?? {}
  check('整段引用：seg:1 合法且 canonical 不变',
    row('seg:1').valid === true && row('seg:1').kind === 'segment' && row('seg:1').canonical === 'seg:1',
    row('seg:1'))
  check('端点引用：seg:2:start 记成 start 点',
    row('seg:2:start').valid === true && row('seg:2:start').point === 'start', row('seg:2:start'))
  check('centre 是 center 的别名',
    row('arc1:centre').valid === true && row('arc1:centre').point === 'center', row('arc1:centre'))
  check('曲线 id 引用：arc1:centre 归为 curveId',
    row('arc1:centre').kind === 'curveId' && row('arc1:centre').curveId === 'arc1', row('arc1:centre'))
  check('线段从 1 开始编号：seg:0 被拒',
    row('seg:0').valid === false && /numbered from 1/.test(row('seg:0').error ?? ''), row('seg:0'))
  check('超出声明段数：seg:9 被拒（segments=4）',
    row('seg:9').valid === false && /beyond the declared segment count 4/.test(row('seg:9').error ?? ''), row('seg:9'))
  check('未知的点名：seg:2:middle 被拒并列出可选值',
    row('seg:2:middle').valid === false && /expected start, end or center/.test(row('seg:2:middle').error ?? ''),
    row('seg:2:middle'))
  check('冒号过多：a:b:c 被拒并给出正确写法',
    row('a:b:c').valid === false && /expected seg:<index>/.test(row('a:b:c').error ?? ''), row('a:b:c'))
  check('被拒引用汇总进 errors', Array.isArray(references?.errors) && references.errors.length === 4,
    references?.errors?.length)

  // ------------------------------------------------------------ 关系类型
  const relations = await bridge.call({
    op: 'relations',
    action: 'validate',
    segments: 4,
    relations: [
      { type: 'coincident', refs: ['seg:1:end', 'seg:2:start'] },
      { type: 'ATMIDDLE', refs: ['seg:3'] },
      { type: 'ATINTERSECT', refs: ['seg:1', 'seg:2'] },
      { type: 'ATPIERCE', refs: ['seg:1:center', 'seg:3'] },
      { type: 'FIXED', refs: ['seg:4'] },
      { type: 'nope', refs: ['seg:1'] },
      { type: 'coincident', refs: [] },
      { type: 'coincident', refs: ['seg:1', 'seg:2', 'seg:3', 'seg:4'] },
    ],
  })
  const relationRows = Array.isArray(relations?.relations) ? relations.relations : []
  const relationRow = (type, index) => relationRows.filter((item) => item.type === type)[index ?? 0] ?? {}
  check('COINCIDENT 两条引用：合法且有 relationType 编号',
    relationRow('coincident').valid === true && Number.isFinite(relationRow('coincident').relationType),
    relationRow('coincident'))
  check('别名 ATMIDDLE 被接受', relationRow('ATMIDDLE').valid === true, relationRow('ATMIDDLE'))
  check('ATINTERSECT 被接受', relationRow('ATINTERSECT').valid === true, relationRow('ATINTERSECT'))
  check('ATPIERCE 被接受', relationRow('ATPIERCE').valid === true, relationRow('ATPIERCE'))
  check('FIXED 被接受', relationRow('FIXED').valid === true, relationRow('FIXED'))
  check('未知关系类型：被拒并列出已知类型',
    relationRow('nope').valid === false && /unknown relation type/.test(relationRow('nope').error ?? ''),
    relationRow('nope').error)
  check('没有引用的关系：被拒',
    relationRow('coincident', 1).valid === false && /no refs/.test(relationRow('coincident', 1).error ?? ''),
    relationRow('coincident', 1).error)
  check('一条关系最多三个实体：四条引用被拒',
    relationRow('coincident', 2).valid === false && /at most 3/.test(relationRow('coincident', 2).error ?? ''),
    relationRow('coincident', 2).error)

  // ------------------------------------------------------------ 非纯动作要不含糊
  // SW 关着 → not-running；开着但没有文档 → NO_ACTIVE_DOC；开着且有文档 →
  // 关系**只认 designId**：礼貌模式取消了「退回当前活动文档」，所以未知 designId
  // 现在报 DOC_NOT_OPEN；没给 designId 报 DESIGN_ID_REQUIRED。两种都可以，唯独
  // 不许静默：成功时必须报出它读的是哪个文档（document.title/path），失败必须带码。
  const status = await bridge.call({ op: 'relations', action: 'status', designId: 'no-such-document' })
  // R12 起多了一种同样诚实的失败：桥接器没有绑定实例（--instance 缺失）时
  // fail-closed 报 INSTANCE_NOT_BOUND，而不是去跟随用户当前激活的窗口。
  const honestFailure = status?.ok === false
    && /^(not-running|NO_ACTIVE_DOC|NO_DOCUMENT|NO_SKETCH|DOC_NOT_OPEN|DESIGN_ID_REQUIRED|INSTANCE_NOT_BOUND)$/i
      .test(String(status?.error?.code))
  const namesDocument = status?.ok === true
    && Boolean(status?.document?.title || status?.document?.path)
  check('非纯动作：诚实报错，或明确报出读的是哪个文档（不猜文档）',
    honestFailure || namesDocument, { code: status?.error?.code, document: status?.document })
} finally {
  bridge.close()
}

// ------------------------------------------------------------ 契约与服务端工具面
{
  const ops = new Map((Array.isArray(DISPATCH) ? DISPATCH : []).map((entry) => [entry.op, entry]))
  check('分派表里有 relations 与 dimensions（能力表由真分派表生成）',
    ops.has('relations') && ops.has('dimensions'), [...ops.keys()].length)
  check('relations / dimensions 都标成已接线',
    ops.get('relations')?.dispatched === true && ops.get('dimensions')?.dispatched === true,
    [ops.get('relations'), ops.get('dimensions')])
}

{
  const work = mkdtempSync(join(tmpdir(), 'sw-mcp-relations-edit-'))
  const dataDir = join(work, 'data')
  mkdirSync(dataDir, { recursive: true })
  const session = openSession({ env: { ...process.env, SW_MCP_DATA: dataDir } })
  await session.start()
  try {
    const listed = await session.call('tools/list', {})
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    const inspect = tools.find((tool) => tool.name === 'inspect')
    const schema = inspect?.inputSchema ?? {}
    const properties = schema.properties ?? {}
    check('inspect 工具声明了 relations 与 dimensions 动作',
      String(properties.action?.description ?? '').length > 0
      && JSON.stringify(properties.action).includes('relations')
      && JSON.stringify(properties.action).includes('dimensions'),
      properties.action?.enum)
    check('relationAction 七个动作都暴露',
      JSON.stringify(properties.relationAction?.enum ?? []) === JSON.stringify(
        ['list', 'add', 'remove', 'edit', 'infer', 'apply', 'clear'],
      ), properties.relationAction?.enum)
    check('dimensionAction 四个动作都暴露',
      JSON.stringify(properties.dimensionAction?.enum ?? []) === JSON.stringify(
        ['list', 'add', 'edit', 'remove'],
      ), properties.dimensionAction?.enum)
    check('inspect 的动作带 designId（多文档不再靠「当前文档」）',
      Object.prototype.hasOwnProperty.call(properties, 'designId'), Object.keys(properties).slice(0, 12))

    // 走一遍真实工具调用：同样的规矩 —— 诚实报错，或明确报出读的是哪个文档。
    const viaTool = await session.tool('inspect', { action: 'relations', relationAction: 'list', designId: 'no-such-document' })
    const code = viaTool?.extra?.error?.code ?? viaTool?.error?.code
    const toolFailedHonestly = viaTool?.status === 'failed'
      && /^(not-running|NO_ACTIVE_DOC|NO_DOCUMENT|NO_SKETCH|SW_NOT_RUNNING|INSTANCE_NOT_BOUND)$/i.test(String(code))
    const toolNamesDocument = viaTool?.status !== 'failed'
      && Boolean(viaTool?.changes?.document?.title || viaTool?.changes?.document?.path)
    check('inspect action=relations：诚实报错，或明确报出读的是哪个文档',
      toolFailedHonestly || toolNamesDocument, { code, status: viaTool?.status })
  } finally {
    session.close()
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('\nfailures:')
  for (const failure of failures) console.log(`  FAIL  ${failure}`)
  process.exitCode = 1
}
