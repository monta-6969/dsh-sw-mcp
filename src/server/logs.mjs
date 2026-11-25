// Structured logs for every tool call and every bridge round-trip.
//
// The reason this exists: when a build fails, the answer to "what did I actually
// send, and what did SOLIDWORKS actually say" has to be readable after the fact.
// console output from a stdio MCP server goes nowhere, and a failing call's
// envelope only shows the last error — not the three features before it, not the
// arguments that caused it, not the bridge's own diagnostic lines.
//
// One JSON object per line, in %LOCALAPPDATA%\sw-mcp\logs. Nothing here is
// required for the tools to work: a logging failure must never break a call.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.LOCALAPPDATA || process.env.TEMP || '.'
// SW_MCP_DATA 是测试用的隔离库；日志跟着走，跑测试不会把真日志挤掉。
export const LOG_DIR = process.env.SW_MCP_DATA
  ? join(process.env.SW_MCP_DATA, 'logs')
  : join(ROOT, 'sw-mcp', 'logs')

const MAX_FILE_BYTES = 8 * 1024 * 1024
const KEEP_DAYS = 7

let seq = 0

function pad(n) {
  return String(n).padStart(2, '0')
}

export function stampFor(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function currentFile() {
  return join(LOG_DIR, `mcp-${stampFor()}.jsonl`)
}

/** Drops the parts of an argument object that would drown the log line, and
 *  says how much it dropped rather than silently truncating. */
export function digestArgs(args, maxText = 400) {
  if (args === null || args === undefined) return null
  if (Array.isArray(args)) return { arrayLength: args.length }
  if (typeof args !== 'object') return args

  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      out[key] = value.length > maxText
        ? `${value.slice(0, maxText)}…(${value.length} chars)`
        : value
    } else if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[key] = { arrayLength: value.length }
      } else if (key === 'definition') {
        out[key] = {
          designId: value.designId,
          featureCount: Array.isArray(value.features) ? value.features.length : undefined,
          features: Array.isArray(value.features)
            ? value.features.map((f) => `${f?.kind ?? '?'}${f?.id ? `:${f.id}` : ''}`)
            : undefined,
        }
      } else {
        out[key] = digestArgs(value, maxText)
      }
    } else {
      out[key] = value
    }
  }
  return out
}

export function writeEvent(event) {
  try {
    ensureDir()
    const file = currentFile()
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        // Rotate rather than grow without bound: a long test suite writes a lot.
        const rotated = join(LOG_DIR, `mcp-${stampFor()}-${Date.now().toString(36)}.jsonl`)
        renameSync(file, rotated)
      }
    } catch {
      // rotation is best-effort
    }
    seq += 1
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq,
      pid: process.pid,
      ...event,
    })
    appendFileSync(file, `${line}\n`)
    return true
  } catch {
    // A log write must never be the reason a tool call fails.
    return false
  }
}

export function newCorrelationId(tool) {
  seq += 1
  return `${tool}-${Date.now().toString(36)}-${seq.toString(36)}`
}

function readFileEvents(file) {
  const events = []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return events
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      events.push({ ts: null, level: 'corrupt', text: line.slice(0, 200) })
    }
  }
  return events
}

/** Recent log entries, newest first.
 *
 *  Reads today's file and, when more entries are asked for than today holds,
 *  yesterday's as well — a failure that spans midnight is the one you most want
 *  to see whole.
 */
export function readEvents({ limit = 50, offset = 0, level, tool, code, since, correlationId } = {}) {
  const files = []
  try {
    const names = readdirSync(LOG_DIR)
      .filter((n) => n.startsWith('mcp-') && n.endsWith('.jsonl'))
      .sort()
      .reverse()
    for (const name of names) files.push(join(LOG_DIR, name))
  } catch {
    return { events: [], total: 0, files: [] }
  }

  const wanted = []
  for (const file of files) {
    const events = readFileEvents(file)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (level && e.level !== level) continue
      if (tool && e.tool !== tool) continue
      if (code && e.code !== code) continue
      if (correlationId && e.cid !== correlationId) continue
      if (since && e.ts && e.ts < since) continue
      wanted.push(e)
    }
    // Stop once we have enough plus a page; reading every file ever written is
    // not worth the milliseconds.
    if (wanted.length >= offset + limit + 50) break
  }

  return {
    events: wanted.slice(offset, offset + limit),
    total: wanted.length,
    offset,
    limit,
    nextOffset: offset + limit < wanted.length ? offset + limit : null,
    files: files.slice(0, 7).map((f) => f.replace(LOG_DIR, '.')),
  }
}

/** Cleans up log files older than KEEP_DAYS. Called once at startup. */
export function pruneLogs() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.startsWith('mcp-') || !name.endsWith('.jsonl')) continue
      const full = join(LOG_DIR, name)
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full)
        }
      } catch {
        // ignore a file that vanished or is locked
      }
    }
  } catch {
    // no log directory yet
  }
}

