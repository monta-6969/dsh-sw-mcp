// Ad-hoc probe: send one or more tool calls and print the envelopes.
//   node tools/probe.mjs model '{"action":"build",...}'
//   node tools/probe.mjs '[["model",{...}],["inspect",{"action":"relations"}]]'
import { openSession } from '../test/lib/mcp.mjs'

const [toolName, json] = process.argv.slice(2)
if (!toolName) {
  console.error('usage: node tools/probe.mjs <tool> [json]  |  node tools/probe.mjs <calls-json-array>')
  process.exit(2)
}

const isBatch = toolName.trim().startsWith('[')
const calls = isBatch ? JSON.parse(toolName) : [[toolName, json ? JSON.parse(json) : {}]]

const session = openSession()
try {
  await session.start()
  for (const [name, args] of calls) {
    const result = await session.tool(name, args)
    const image = result._image
    delete result._image
    console.log(`\n=== ${name} -> ${result.status}`)
    console.log(JSON.stringify(result, null, 2))
    if (image) console.log(`(image ${image.mimeType}, ${Math.round(image.data.length / 1365)} KB)`)
  }
} catch (error) {
  console.error('ERROR', error.message)
  process.exitCode = 1
} finally {
  session.close()
}
