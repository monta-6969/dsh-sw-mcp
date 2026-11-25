// 测试用的假 worker：不需要 SOLIDWORKS，只验证 broker 的提交/执行/状态语义。
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    const { id, op, value } = request
    if (op === 'echo') {
      process.stdout.write(`${JSON.stringify({ id, ok: true, value, pid: process.pid })}\n`)
    } else if (op === 'boom') {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: 'FAKE_BOOM', message: 'intentional' } })}\n`)
    } else if (op === 'slow') {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({ id, ok: true, value, afterMs: 100 })}\n`)
      }, 100)
    } else {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: 'FAKE_UNKNOWN_OP', message: op } })}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
