#!/usr/bin/env node
// 契约漂移检查：仓库里的 schema / C# 常量必须与 contracts/enums.json + server/contracts.mjs
// 完全一致。build.ps1 和测试都跑这一条；不一致时给出要重新生成的文件。
import { generateContracts } from './gen-contracts.mjs'

const result = generateContracts({ check: true })
if (result.changed) {
  for (const file of result.files) {
    if (file.status === 'stale') console.error(`stale: ${file.path}`)
  }
  console.error('contracts are stale: run node tools/gen-contracts.mjs')
  process.exit(1)
}
console.log(`contracts up to date (${result.files.length} artifacts)`)
