// 测试环境隔离（只给 test/ 下的用例用，不进产品代码）。
//
// 为什么必须有：server 侧默认 policy=isolated，每个 MCP 会话（每条通道）都会让
// broker 起一个**专属** SOLIDWORKS；而桥接器的 WorkRegistry（documents.json）是
// exe 目录下**所有实例共用的一个文件**。两会话各持一个实例时：
//   A 会话 build A（登记进共享 registry，文档在实例 1）
//   B 会话 build B（同一份 registry，文档在实例 2）
//   A 会话再 inspect A → 落到实例 1，而实例 1 里那份文档可能已被会话级清扫关掉
// 结果就是 D3 的 DOC_NOT_OPEN。测试要验的是**同一实例内的连续 build**，
// 所以这里把策略锁成：单实例、共享、**绝不认领用户实例**（不用 adopt-user ——
// 那会把用户开着的窗口当成测试实例）。shared + maxInstances=1：broker 只养一个
// 服务实例，会话都复用它，且不会再起第二个。
//
// 必须在 import './lib/sw.mjs' 或 './lib/mcp.mjs' **之前** import 本文件：
// session-id.mjs 在模块求值时就把 policy 固定下来了。
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const explicit = process.env.SW_MCP_TEST_ISOLATION === '0'

/** 测试用的 SW_MCP_DATA：独立目录，避免和用户/其它会话的 lanes.json 互相覆盖。 */
export const TEST_DATA_DIR = process.env.SW_MCP_TEST_DATA ?? join(tmpdir(), 'sw-mcp-test-data')

if (!explicit) {
  process.env.SW_MCP_BROKER ??= '1'
  process.env.SW_MCP_BROKER_ENSURE ??= '1'
  process.env.SW_MCP_INSTANCE_POLICY = 'shared'
  process.env.SW_MCP_MAX_INSTANCES = '1'
  process.env.SW_MCP_LANES = '1'
  process.env.SW_MCP_DATA ??= TEST_DATA_DIR
}

/**
 * 每个用例的 designId 前缀。默认值与原文件里写死的前缀完全一致，
 * 只是换成可注入：SW_TEST_PREFIX 让同一台机器上并行的两轮测试互不撞名
 * （桥接器 registry 是全局文件，同名 designId 会互相覆盖登记）。
 */
export const TEST_PREFIX = process.env.SW_TEST_PREFIX ?? ''

/** `native-dims` → `native-dims`（默认）／`d3native-dims`（SW_TEST_PREFIX=d3）。 */
export function prefixed(base) {
  return `${TEST_PREFIX}${base}`
}

/** designId 生成器：`prefixed('native-dims')` + 时间戳，形状与原来的 `xxx-${Date.now()}` 一致。 */
export function designId(base, stamp = Date.now()) {
  return `${prefixed(base)}-${stamp}`
}
