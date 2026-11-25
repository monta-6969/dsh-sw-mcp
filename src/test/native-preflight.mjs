// native 改造的离线回归：preflight / datum / componentRotate frame / placement datum / verify 读数。
//
// 不启动 SOLIDWORKS、不碰用户文档：SW_MCP_BROKER=0，桥接器不可达。这里要证明的正是
// 「桥接器不在时也不能装作成功」—— preflight 照样给出结构化事实与 notes，datum 建不出
// 真几何时绝不写一条假记录，placement 指到不存在的基准时在碰 SOLIDWORKS 之前就失败。
//
// 跑法：node test/native-preflight.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planPlacementComponents } from '../server/tools-datum.mjs'
import { poseFromTransformArray, rotationReadout } from '../server/bridge-readout.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const SERVER = join(repo, 'server', 'server.mjs')
const dataDir = mkdtempSync(join(tmpdir(), 'sw-native-'))
// 真离线：把桥接器指到一个不存在的 exe。否则在有 SOLIDWORKS 的机器上，
// preflight/status 会 attach 到用户正在编辑的实例。这个测试要证明的是
// 「桥接器不在时也不能装作成功」，所以必须让它真的不在。
const isoDir = mkdtempSync(join(tmpdir(), 'sw-native-cfg-'))
const isoConfig = join(isoDir, 'sw.config.json')
writeFileSync(isoConfig, JSON.stringify({ bridgeExe: join(isoDir, 'SwBridge-missing.exe') }), 'utf8')

const failures = []
let checks = 0
function check(name, condition, detail) {
  checks += 1
  if (condition) return
  failures.push({ name, detail })
  console.error('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)))
}
function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })
}

const child = spawn(process.execPath, [SERVER], {
  cwd: repo,
  env: { ...process.env, SW_MCP_BROKER: '0', SW_MCP_DATA: dataDir, SW_MCP_CONFIG: isoConfig },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = ''
let nextId = 1
const pending = new Map()
child.stderr.on('data', (chunk) => process.stderr.write('[server] ' + chunk))
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  }
})

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(method + ' timeout'))
      }
    }, 40_000)
  })
}

function payload(result) {
  const text = result?.content?.find((item) => item?.type === 'text')?.text ?? ''
  try { return JSON.parse(text) } catch { return { raw: text } }
}

async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args })
  return { result, body: payload(result) }
}

const started = Date.now()
try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'native-preflight', version: '1' },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // ---------------------------------------------------------------- 默认工具面
  const before = await request('tools/list', {})
  const beforeNames = before.tools.map((tool) => tool.name)
  check('datum 不在默认工具面', !beforeNames.includes('datum'), beforeNames)
  check('workspace 在默认工具面', beforeNames.includes('workspace'), beforeNames)
  const workspaceSchema = before.tools.find((tool) => tool.name === 'workspace').inputSchema
  check('workspace schema 声明 preflight', JSON.stringify(workspaceSchema).includes('preflight'), workspaceSchema)

  // ---------------------------------------------------------------- preflight（桥接器不可达）
  const pre = await call('workspace', { action: 'preflight', designId: 'native-none' })
  check('preflight 返回 ok', pre.body.status !== 'failed' || pre.body.changes !== undefined, pre.body)
  const preChanges = pre.body.changes ?? {}
  check('preflight 有 document 段', preChanges.document !== undefined, preChanges)
  check('preflight 有 binding 段', preChanges.binding !== undefined, preChanges)
  check('preflight 有 instance 段（pid/channel/broker）',
    preChanges.instance?.channel !== undefined && 'broker' in (preChanges.instance ?? {}), preChanges.instance)
  check('preflight 有单位/模板/精度', preChanges.units !== undefined && 'template' in preChanges && 'precision' in preChanges, preChanges)
  check('preflight 有能力清单', Array.isArray(preChanges.capabilities?.activated) && Array.isArray(preChanges.capabilities?.available), preChanges.capabilities)
  check('preflight 有 lastVerify/lastDelivery 键', 'lastVerify' in preChanges && 'lastDelivery' in preChanges, preChanges)
  check('preflight 直接给 nextActions', Array.isArray(pre.body.nextActions) && pre.body.nextActions.length > 0, pre.body.nextActions)
  check('桥接器不可达时 preflight 仍结构化（notes 说明）', Array.isArray(preChanges.notes) && preChanges.notes.length > 0, preChanges.notes)

  // ---------------------------------------------------------------- datum 激活 + 行为
  const activated = await call('catalog', { action: 'activate', capability: 'datum' })
  check('catalog 能激活 datum', payload(activated.result)?.status !== 'failed', payload(activated.result))
  const after = await request('tools/list', {})
  const afterNames = after.tools.map((tool) => tool.name)
  check('激活后 datum 出现在工具面', afterNames.includes('datum'), afterNames)
  check('默认工具面只多了 datum 一个', afterNames.length === beforeNames.length + 1, { before: beforeNames.length, after: afterNames.length })

  const noId = await call('datum', { action: 'list' })
  check('datum list 缺 designId 被拒', noId.body.status === 'failed' && JSON.stringify(noId.body).includes('DESIGN_ID_REQUIRED'), noId.body)

  const noProject = await call('datum', { action: 'create', designId: 'native-none', name: 'P1', kind: 'point', x: 10, y: 0, z: 0 })
  check('没有项目记录时 datum create 拒绝', noProject.body.status === 'failed'
    && JSON.stringify(noProject.body).includes('DESIGN_NOT_FOUND'), noProject.body)

  // 造一份项目记录（design.json 的真源是 projects/<id>.json，基准就落在这里）
  const projectsDir = join(dataDir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  writeFileSync(join(projectsDir, 'native-datum.json'), JSON.stringify({
    designId: 'native-datum',
    definition: { schemaVersion: 3, units: 'mm', params: { L: 20 }, features: [{ kind: 'basePlate' }] },
    revision: 1,
    updatedAt: new Date().toISOString(),
  }, null, 2))

  const badName = await call('datum', { action: 'create', designId: 'native-datum', name: 'A B', kind: 'point', x: 1, y: 2, z: 3 })
  check('含空格的基准名被拒', badName.body.status === 'failed' && JSON.stringify(badName.body).includes('BAD_ARGUMENT'), badName.body)

  // attach:false = 只登记；这条路径不需要桥接器，用来验证重名/删除/重建语义。
  const created = await call('datum', { action: 'create', designId: 'native-datum', name: 'P1', kind: 'point', x: 10, y: 20, z: 30, attach: false })
  check('datum create(attach:false) 成功', created.body.status === 'ok', created.body)
  const stored = JSON.parse(readFileSync(join(projectsDir, 'native-datum.json'), 'utf8'))
  check('基准写进 design.json', Array.isArray(stored.datums) && stored.datums[0]?.name === 'P1', stored.datums)

  const dup = await call('datum', { action: 'create', designId: 'native-datum', name: 'P1', kind: 'point', x: 0, y: 0, z: 0, attach: false })
  check('重名被 DATUM_EXISTS 拒绝', dup.body.status === 'failed' && JSON.stringify(dup.body).includes('DATUM_EXISTS'), dup.body)

  const got = await call('datum', { action: 'get', designId: 'native-datum', name: 'P1' })
  check('datum get 读到同一条', got.body.status === 'ok' && got.body.changes?.datum?.name === 'P1', got.body)

  const del = await call('datum', { action: 'delete', designId: 'native-datum', name: 'P1' })
  check('datum delete 成功', del.body.status === 'ok', del.body)
  const afterDelete = JSON.parse(readFileSync(join(projectsDir, 'native-datum.json'), 'utf8'))
  check('删除后 design.json 里没有它', (afterDelete.datums ?? []).length === 0, afterDelete.datums)

  const again = await call('datum', { action: 'create', designId: 'native-datum', name: 'P1', kind: 'axis', source: { type: 'coords' }, x: 1, y: 0, z: 0, attach: false })
  check('删除后同名可重建', again.body.status === 'ok' && again.body.changes?.datum?.kind === 'axis', again.body)

  const real = await call('datum', { action: 'create', designId: 'native-datum', name: 'REAL', kind: 'point', x: 1, y: 2, z: 3 })
  check('桥接器不可达时 create 明确失败、不写假记录', real.body.status === 'failed', real.body)
  const afterReal = JSON.parse(readFileSync(join(projectsDir, 'native-datum.json'), 'utf8'))
  check('失败后 design.json 没有新增', (afterReal.datums ?? []).filter((item) => item.name === 'REAL').length === 0, afterReal.datums)

  // ---------------------------------------------------------------- componentRotate frame
  const asmActivated = await call('catalog', { action: 'activate', capability: 'assembly' })
  check('激活 assembly', payload(asmActivated.result)?.status !== 'failed', payload(asmActivated.result))
  const withAssembly = await request('tools/list', {})
  const assemblyTool = withAssembly.tools.find((tool) => tool.name === 'assembly')
  check('assembly 工具存在', assemblyTool !== undefined)
  const assemblySchema = JSON.stringify(assemblyTool?.inputSchema ?? {})
  check('componentRotate 声明 frame', assemblySchema.includes('"frame"'), assemblySchema.slice(0, 600))
  check('frame 默认 global', assemblySchema.includes('"global"'), assemblySchema.slice(0, 600))
  check('frame 说明含 local', assemblySchema.includes('"local"'), assemblySchema.slice(0, 600))
  check('componentRotate 描述写明旋转点是装配坐标', assemblySchema.includes('旋转点'), assemblySchema.slice(0, 1200))
  check('components.placement 接受 datum:', assemblySchema.includes('datum:'), assemblySchema.slice(0, 2000))
  check('mate 描述写明两端只接受面', assemblySchema.includes('只接受面'), assemblySchema.slice(0, 4000))

  // placement="datum:<name>"：找不到基准必须在碰 SOLIDWORKS 之前失败
  const tmpPartDir = mkdtempSync(join(tmpdir(), 'sw-native-part-'))
  const partPath = join(tmpPartDir, 'plate.SLDPRT')
  writeFileSync(partPath, 'not-a-real-part')
  writeFileSync(join(tmpPartDir, 'plate.design.json'), JSON.stringify({
    designId: 'plate', kind: 'part', units: 'mm',
    datums: [{ name: 'CENTER', kind: 'point', frame: { origin: [5, 5, 0], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1] } }],
  }, null, 2))
  const missingDatum = await call('assembly', {
    action: 'assemble', designId: 'native-asm',
    components: [{ path: partPath, x: 10, y: 0, z: 0, placement: 'datum:NOPE' }],
  })
  check('placement 指到不存在的基准 → DATUM_NOT_FOUND',
    missingDatum.body.status === 'failed' && JSON.stringify(missingDatum.body).includes('DATUM_NOT_FOUND'), missingDatum.body)
  check('失败回包列出可用的基准名', JSON.stringify(missingDatum.body).includes('CENTER'), missingDatum.body)
  const badPlacement = await call('assembly', {
    action: 'assemble', designId: 'native-asm',
    components: [{ path: partPath, x: 0, y: 0, z: 0, placement: 'center-of-gravity' }],
  })
  check('未知 placement 被拒并列出口径', badPlacement.body.status === 'failed'
    && JSON.stringify(badPlacement.body).includes('bbox-center'), badPlacement.body)

  // placement="datum:<name>" 的纯换算：server 必须真的用这份结果去 componentInsert。
  // 以前算完 componentsForBridge 仍传原始 args.components，datum 换算被静默丢弃。
  const planned = planPlacementComponents([{ path: partPath, x: 10, y: 20, z: 0, placement: 'datum:CENTER' }])
  check('datum placement 换算成零件原点落位', planned.error === undefined
    && JSON.stringify(planned.components?.[0]?.placement) === '"origin"'
    && JSON.stringify([planned.components[0].x, planned.components[0].y, planned.components[0].z]) === '[5,15,0]',
  planned)
  check('datum placement 回包带 placementNotes', planned.notes?.[0]?.datum === 'CENTER'
    && planned.notes?.[0]?.datumOrigin?.[0] === 5, planned.notes)
  const plannedMissing = planPlacementComponents([{ path: partPath, x: 0, y: 0, z: 0, placement: 'datum:NOPE' }])
  check('纯换算对未知基准给 DATUM_NOT_FOUND', plannedMissing.error?.code === 'DATUM_NOT_FOUND'
    && JSON.stringify(plannedMissing.error.detail).includes('CENTER'), plannedMissing)

  // componentRotate 读数：桥接器回 nextArray（米），工具描述承诺 rotation/pose(mm)/centerDriftMm。
  const transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0.01, 0.02, 0.03, 0, 0, 0, 1]
  const pose = poseFromTransformArray(transform)
  check('Transform2 数组换算成 3×3 + 位姿(mm)', pose?.rotation?.length === 9
    && JSON.stringify(pose.pose.origin) === '[10,20,30]', pose)
  const readout = rotationReadout({ nextArray: transform, currentArray: transform, centerDriftMm: 1.25, pivotUsed: { source: 'bbox-center' }, method: 'SetTransformAndSolve3' })
  check('rotationReadout 带 rotation/pose/pivot/centerDrift',
    readout.rotation?.length === 9 && readout.centerDriftMm === 1.25
    && readout.pivotSource === 'bbox-center' && readout.method === 'SetTransformAndSolve3', readout)
  check('拿不到矩阵时读数是 null，不拿 0 冒充', rotationReadout({}).rotation === null
    && rotationReadout({}).pose === null && rotationReadout({}).centerDriftMm === null, rotationReadout({}))

  // ---------------------------------------------------------------- verify 读数
  // 桥接器不可达时 verify 自己会失败；读数函数单独测（它才是验收看的数字）。
  await call('catalog', { action: 'activate', capability: 'qa' })
  const verify = await call('qa', { action: 'verify', designId: 'native-datum' })
  check('桥接器不可达时 verify 明确失败', verify.body.status === 'failed', verify.body)

  const { geometryReadouts } = await import('../server/verify.mjs')
  const { evaluateTiers } = await import('../server/design-store.mjs')
  const readouts = geometryReadouts({
    massProperties: { volume: 1234.5 }, bodies: 1, boundingBox: { size: [20, 10, 5] }, faces: 6,
    holes: [{ diameter: 5 }, { diameter: 'x' }],
  }, [])
  checkEqual('readouts 体积', readouts.volumeMm3, 1234.5)
  checkEqual('readouts 实体数', readouts.bodies, 1)
  checkEqual('readouts 包围盒', readouts.boundingBoxMm, [20, 10, 5])
  checkEqual('readouts 孔数', readouts.holes, 2)
  checkEqual('readouts 读不到的孔径是 null', readouts.holeDiameters, [5, null])
  checkEqual('readouts 干涉缺失是 null', readouts.interference, null)
  checkEqual('readouts 单位', readouts.units, { volume: 'mm3', length: 'mm' })
  const withInterference = geometryReadouts({ interference: { count: 1, pairs: [{ a: 'A-1', b: 'B-1', volumeMm3: 0.7 }] } })
  checkEqual('readouts 保留干涉细节', withInterference.interference?.pairs?.[0]?.b, 'B-1')

  const rows = evaluateTiers({
    tiers: ['file', 'geometry', 'assembly'],
    design: { kind: 'assembly', expectations: null },
    manifest: null, cadPath: null, cadHash: null,
    geometry: { massProperties: { volume: 10 }, bodies: 1 },
  })
  check('档位验收返回逐行读数', rows.length > 0 && rows.every((row) => 'expected' in row && 'actual' in row), rows)
  check('没有记录的档位记 unmeasured', rows.some((row) => row.status === 'unmeasured'), rows)
  check('装配档零件会标 skipped 或按装配判', rows.some((row) => row.tier === 'assembly'), rows)

  // ---------------------------------------------------------------- 工具描述六要素（抽样）
  const modelTool = before.tools.find((tool) => tool.name === 'model')
  const modelDesc = modelTool?.description ?? ''
  for (const key of ['何时用', '前置', '返回', '下一步', '坑']) {
    check('model 描述含「' + key + '」', modelDesc.includes(key), modelDesc.slice(0, 300))
  }
  const captureTool = before.tools.find((tool) => tool.name === 'capture')
  check('capture 描述点明 section 不是真剖视', (captureTool?.description ?? '').includes('SECTION_UNSUPPORTED'), captureTool?.description)
  const deliverTool = before.tools.find((tool) => tool.name === 'deliver')
  check('deliver 描述点明回读字节/时间戳', (deliverTool?.description ?? '').includes('mtimeMs'), deliverTool?.description)
} catch (error) {
  failures.push({ name: 'harness', detail: error?.message ?? String(error) })
} finally {
  child.kill()
}

const ms = Date.now() - started
console.log('\n' + (failures.length === 0 ? 'PASS' : 'FAIL') + ` native-preflight: ${checks - failures.length}/${checks} 项通过，${ms} ms`)
for (const failure of failures) console.error('  - ' + failure.name + ': ' + JSON.stringify(failure.detail ?? null).slice(0, 600))
process.exit(failures.length === 0 ? 0 : 1)
