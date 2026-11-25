import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sw-lanes-'))
process.env.SW_MCP_LANES = '4'
process.env.SW_MCP_DATA = dir
process.env.SW_MCP_MAX_INSTANCES = '2'

let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) passed += 1
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`)
}

const mod = await import('../server/session-id.mjs?lanes=1')

check('LANES 解析为 4', mod.SW_LANES === 4, mod.SW_LANES)
check('单通道开关关闭时回到原 clientId 形态', mod.clientIdFor(null).includes('#L'), mod.clientIdFor(null))

const ids = ['C04-02', 'C05-01', 'C05-02', 'C06-01', 'C07-01', 'C08-01', 'C09-01', 'C10-01']
const map = ids.map((id) => [id, mod.clientIdFor(id)])
const lanes = new Set(map.map(([, cid]) => cid))

check('8 个零件铺满 4 条通道', lanes.size === 4, [...lanes])
check('同一 design 两次拿到同一通道', mod.clientIdFor('C04-02') === map[0][1], [map[0][1], mod.clientIdFor('C04-02')])
check('不同 design 不会全挤在一条通道', new Set(map.map(([, cid]) => cid)).size > 1)

const params = mod.instanceRequestParams('C04-02')
check('请求参数带通道 clientId', params.clientId === map[0][1], params.clientId)
check('实例上限至少等于通道数', params.maxInstances === 4, params.maxInstances)

const mod2 = await import('../server/session-id.mjs?lanes=2')
check('重启后同一 design 仍回原通道', mod2.clientIdFor('C04-02') === map[0][1], [mod2.clientIdFor('C04-02'), map[0][1]])

const one = await (async () => {
  process.env.SW_MCP_LANES = '1'
  return import('../server/session-id.mjs?lanes=3')
})()
check('SW_MCP_LANES=1 时 clientId 与旧行为一致（无通道后缀）', !one.clientIdFor('C04-02').includes('#L'), one.clientIdFor('C04-02'))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) process.exit(1)