import { randomUUID } from 'node:crypto'
import z from 'zod'

const STR = { type: 'string' }
const NUM = { type: 'number' }
const BOOL = { type: 'boolean' }
const MAP = { type: 'object', additionalProperties: true }
const array = (items) => ({ type: 'array', items })
const choice = (...values) => ({ ...STR, enum: values })
const object = (properties, required = [], open = false) => ({
  type: 'object', properties, required, additionalProperties: open,
})

// Args and examples describe the high-level handler, whose original Zod schema
// still validates them. The same registry drives SDK operation names and help.
const stage = (action, keys, example, mutates = true, tool = 'model') =>
  ({ tool, action, keys: keys.split(' ').filter(Boolean), example, mutates })
const inspect = (action, keys = '', example = {}, mutates = false) =>
  stage(action, keys, example, mutates, 'inspect')
const workspace = (action, keys = '', example = {}, mutates = false) =>
  stage(action, keys, example, mutates, 'workspace')

const plate = {
  schemaVersion: 3, units: 'mm', params: { L: 30, W: 20, T: 5 },
  features: [{ kind: 'basePlate', length: 'L', width: 'W', thickness: 'T' }],
}
const planKeys = 'definition output precision assumptions acceptedAssumptions dimensions allowOpen requireDimensions'
const relationKeys = 'sketch relationAction relations relationIds apply tolerance confirm atomic'
const dimensionKeys = 'sketch dimensionAction dimensions'
const invokeExample = { target: 'doc', member: 'GetTitle', args: [] }
const stages = {
  plan: stage('plan', planKeys, { definition: plate }, false),
  build: stage('build', planKeys, { definition: plate }),
  edit: stage('edit', 'parameters revert', { parameters: { L: 35 } }),
  verify: inspect('verify', 'expect', { expect: { size: [30, 20, 5], parametric: true } }),
  relations: inspect('relations', relationKeys, { relationAction: 'list' }, true),
  dimensions: inspect('dimensions', dimensionKeys, { dimensionAction: 'list' }, true),
  create: stage('create', 'template', {}),
  rebuild: stage('rebuild', '', {}),
  pattern: stage('pattern', 'feature featureIndex count angleDeg axisPlanes flip', { feature: 'Boss', count: 4 }),
  undo: stage('undo', 'steps', { steps: 1 }),
  select: { ...stage(undefined, 'ids append clear', { ids: ['ref:face:…'] }, true, 'select'), action: undefined },
  invoke: stage('invoke', 'target iface member args units', invokeExample),
  object: stage('object', 'target iface param member handle objectAction value index args', { objectAction: 'get', handle: 'obj_1', member: 'Name' }),
  batch: stage('batch', 'ops stopOnError', { ops: [{ op: 'invoke', args: invokeExample }], stopOnError: true }),
  assemble: stage('assemble', 'components', { components: [{ path: 'C:/parts/base.SLDPRT' }] }),
  drawing: stage('drawing', 'model views projection', { model: 'C:/parts/base.SLDPRT', views: ['*前视'] }),
  open: workspace('open', 'path', { path: 'C:/parts/base.SLDPRT' }, true),
  cleanup: workspace('cleanup', '', {}, true),
  ensure: stage('ensure', '', {}, true, 'job'),
}

const reads = {
  status: workspace('status'),
  projects: workspace('projects'),
  project: workspace('project'),
  history: workspace('history'),
  instances: workspace('instances', 'tag'),
  logs: workspace('logs', 'log logOffset logLimit', { log: { level: 'warn' }, logLimit: 10 }),
  model: inspect('model', 'format', { format: 'geometry' }),
  faces: inspect('faces', 'limit', { limit: 20 }),
  bodies: inspect('bodies'),
  assembly: inspect('assembly'),
  measure: inspect('measure', 'measure', { measure: { kind: 'holes', includeIds: true } }),
  sketch: inspect('sketch', 'sketch'),
  relations: inspect('relations', 'sketch relationAction tolerance', { relationAction: 'list' }),
  dimensions: inspect('dimensions', 'sketch dimensionAction', { dimensionAction: 'list' }),
  figure: inspect('figure', 'figure', { figure: { op: 'fit', source: 'C:/parts/drawing.png' } }),
  compare: inspect('compare', 'compare', { compare: { drawing: 'C:/parts/drawing.png', view: 'front' } }),
  evidence: inspect('evidence', 'drawingPath'),
  review: inspect('review', 'documentPath'),
  capture: stage(undefined, 'width height highlight caption', {}, false, 'capture'),
}

const stageNames = Object.keys(stages)
const readNames = Object.keys(reads)
const kinds = ['sldprt', 'step', 'stl', 'pdf', 'dxf', 'dwg']

const runInput = object({
  designId: STR, runId: STR, operationId: STR, expectedRevision: NUM,
  action: choice('start', 'cancel'), jobId: STR, wait: BOOL,
  definition: object({ schemaVersion: NUM, units: choice('mm', 'm'), params: MAP,
    features: array(object({ kind: STR, name: STR }, ['kind'], true)) }, ['features'], true),
  steps: array(object({ id: STR, op: choice(...stageNames), deps: array(STR), args: MAP }, ['op'])),
})
const readInput = object({
  kind: choice(...readNames, 'job', 'detail'), designId: STR, args: MAP,
  jobId: STR, detailRef: STR, field: STR, offset: NUM, limit: NUM,
}, ['kind'])
const helpInput = object({ op: STR, q: STR, id: STR, offset: NUM, limit: NUM })
const deliverInput = object({
  designId: STR, kind: choice(...kinds), path: STR, force: choice('manual'), reason: STR,
}, ['designId'])

// Standard Schema has a separate runtime validator and JSON Schema projection.
// Keep business failures in structuredContent instead of transport errors.
function displaySchema(jsonSchema, validate = (value) => ({ value })) {
  return { '~standard': { version: 1, vendor: 'sw-mcp', validate,
    jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
  } }
}

export function reviewInspectSchema(zodSchema) {
  const relationAction = {
    type: 'string', enum: ['list', 'add', 'remove', 'edit', 'infer', 'apply', 'clear'],
    description: 'relations 子动作；只读实例只放行 list/infer，写子动作在进入桥接器之前以 READ_ONLY_TOOLSET 拒。',
  }
  const dimensionAction = {
    type: 'string', enum: ['list', 'add', 'edit', 'remove'],
    description: 'dimensions 子动作；只读实例只放行 list，其余以 READ_ONLY_TOOLSET 拒。',
  }
  return displaySchema(object({
    action: choice('model', 'faces', 'bodies', 'assembly', 'sketch', 'relations', 'dimensions', 'measure', 'review', 'evidence'),
    designId: STR, sketch: STR, format: choice('tree', 'geometry', 'both'),
    relationAction, dimensionAction,
    measure: MAP, documentPath: STR,
  }, [], true), zodSchema['~standard'].validate)
}

const id = z.string().trim().min(1).max(160)
const argsShape = z.record(z.string(), z.unknown())
const pageKeys = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() }
const startSchema = z.strictObject({
  action: z.literal('start').optional(),
  designId: id, runId: id, operationId: id, expectedRevision: z.number().int().nonnegative().optional(),
  wait: z.boolean().optional(),
  definition: z.looseObject({ features: z.array(argsShape) }).optional(),
  steps: z.array(z.strictObject({
    id: id.optional(), op: z.enum(stageNames), deps: z.array(id).max(24).optional(), args: argsShape.optional(),
  })).min(1).max(24),
})
const cancelSchema = z.strictObject({ action: z.literal('cancel'), jobId: id })
const readSchema = z.strictObject({
  kind: z.enum([...readNames, 'job', 'detail']), designId: id.optional(), args: argsShape.optional(),
  jobId: id.optional(), detailRef: id.optional(), field: z.string().max(400).optional(), ...pageKeys,
})
const helpSchema = z.strictObject({ op: id.optional(), q: id.optional(), id: id.optional(), ...pageKeys })

function bad(code, message, detail) {
  return { status: 'failed', summary: message, extra: { error: { code, message, detail } } }
}

function parse(schema, input) {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed
  const fields = parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
  return { error: bad('BAD_ARGUMENT', fields[0] ? `${fields[0].field || '参数'}：${fields[0].message}` : '参数无效', { fields }) }
}

function only(obj, keys) {
  return Object.fromEntries(keys.filter((key) => obj?.[key] !== undefined).map((key) => [key, obj[key]]))
}

function getOwn(obj, key) {
  return obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined
}

function resolved(entry, args, designId) {
  const unsupported = Object.keys(args).filter((key) => !entry.keys.includes(key))
  if (unsupported.length) return { error: bad('UNKNOWN_PARAM', '这项操作没有这些参数：' + unsupported.join(', '),
    { allowed: entry.keys }) }
  return {
    ...args,
    ...(entry.action !== undefined ? { action: entry.action } : {}),
    ...(designId && ['model', 'inspect', 'workspace', 'select', 'capture'].includes(entry.tool) ? { designId } : {}),
  }
}

const documentReads = new Set(['project', 'history', 'model', 'faces', 'bodies', 'assembly', 'measure',
  'sketch', 'relations', 'dimensions', 'review', 'capture', 'compare'])

function readError(kind, args) {
  if (kind === 'relations' && ![undefined, 'list', 'infer'].includes(args.relationAction)) {
    return bad('READ_ONLY_TOOLSET', '关系变更请用 run 的 relations 操作。')
  }
  if (kind === 'dimensions' && ![undefined, 'list'].includes(args.dimensionAction)) {
    return bad('READ_ONLY_TOOLSET', '尺寸变更请用 run 的 dimensions 操作。')
  }
  if (args.figure?.output !== undefined || args.compare?.output !== undefined) {
    return bad('READ_ONLY_TOOLSET', 'read 生成的图片由服务分配临时路径。')
  }
  return null
}

function stageError(op, args, designId) {
  if (args.definition?.designId && args.definition.designId !== designId) {
    return bad('WRONG_DOCUMENT', 'definition.designId 必须与阶段 designId 一致。')
  }
  if ((op === 'invoke' || op === 'object') && ['activeDoc', 'app'].includes(args.target)) {
    return bad('WRONG_DOCUMENT', '阶段操作请指定本设计的 doc 或该文档的接口。')
  }
  if (op !== 'batch' || !Array.isArray(args.ops)) return null
  // Batch forwards low-level operations in one request. Explicitly retain the
  // design binding, even for steps that override the bridge-level defaults.
  const permitted = new Set(['invoke', 'object', 'inspect', 'measure', 'faces', 'bodies', 'edges', 'relations', 'dimensions'])
  for (const [index, step] of args.ops.entries()) {
    const nested = step?.args
    const operation = String(step?.op ?? '').toLowerCase()
    if (!permitted.has(operation) || (nested?.designId !== undefined && nested.designId !== designId)
      || ['activeDoc', 'app'].includes(nested?.target)) {
      return bad('WRONG_DOCUMENT', 'batch 步骤必须绑定本设计并使用受支持的操作。', { field: 'ops[' + index + ']', op: step?.op })
    }
  }
  return null
}

function stageMutates(op, args) {
  if (op === 'relations') return !['list', 'infer'].includes(args.relationAction ?? (args.apply === true ? 'apply' : 'list'))
  if (op === 'dimensions') return (args.dimensionAction ?? 'list') !== 'list'
  return stages[op].mutates
}

function unwrapped(result, parseEnvelopeText) {
  const parsed = parseEnvelopeText(result)
  return parsed ?? bad(result?.isError ? 'MCP_TOOL_ERROR' : 'BAD_TOOL_RESULT',
    result?.content?.find((entry) => entry.type === 'text')?.text ?? '操作未返回业务回执。')
}

function topMeasure(blob) {
  const measures = blob.measurements ?? blob.changes?.measurements
  if (!measures || typeof measures !== 'object') return undefined
  const keys = ['volume', 'totalVolumeMm3', 'solidBodies', 'bodies', 'faces', 'edges', 'boundingBox', 'holes',
    'volumeBefore', 'volumeAfter', 'volumeDelta', 'partVolumeMm3', 'params', 'parameters', 'parametric']
  const chosen = only(measures, keys)
  if (Object.keys(chosen).length) return chosen
  return only(measures.geometry ?? measures, ['bodies', 'boundingBox', 'massProperties', 'kind', 'count', 'distanceMm'])
}

const displayChangeKeys = ['ready', 'blockers', 'mode', 'document', 'path', 'imagePath', 'view', 'viewMutated',
  'bytes', 'width', 'height', 'crop', 'map', 'source', 'scaled', 'warnings', 'count', 'total', 'returned',
  'nextOffset', 'step', 'audit', 'relationAudit', 'closed', 'fullyDefined', 'reference', 'driving', 'sketchCount',
  'checks', 'unmeasured', 'available', 'passed', 'failed', 'repairedEquations', 'result', 'verification', 'review',
  'reopened', 'receipt', 'snapshotId', 'features', 'matches', 'pairs']

function summarize(blob) {
  const summary = only(blob, ['status', 'summary', 'designId', 'revision', 'effect', 'job', 'error', 'next',
    'completed', 'artifacts', 'nextActions', 'detailRef'])
  const changes = only(blob.changes, displayChangeKeys)
  if (Array.isArray(changes.checks)) {
    const issues = changes.checks.filter((item) => item?.status !== 'pass')
    changes.checkCount = changes.checks.length
    changes.checks = (issues.length ? issues : changes.checks).slice(0, 4)
  }
  if (Array.isArray(changes.features)) {
    changes.featureCount = changes.features.length
    changes.features = changes.features.slice(0, 4).map((item) => only(item, ['id', 'name', 'kind', 'type']))
  }
  if (Object.keys(changes).length) summary.changes = changes
  const measurements = topMeasure(blob)
  if (measurements && Object.keys(measurements).length) summary.measurements = measurements
  if (blob.extra?.error) summary.extra = { error: blob.extra.error }
  if (Array.isArray(blob.steps)) {
    summary.steps = blob.steps.map((step) => {
      const item = only(step, ['id', 'op', 'state', 'status', 'effect', 'error'])
      if (step.result) {
        item.summary = step.result.summary
        item.measurements = topMeasure(step.result)
        item.changes = only(step.result.changes, ['ready', 'closed', 'audit', 'mode', 'driving'])
      }
      return item
    })
  }
  return summary
}

const isContainer = (item) => item !== null && typeof item === 'object'

// Coarsen nested values on a short receipt. The detail pointer navigates the
// original result, so omitted rows remain reachable without replaying CAD.
function bound(value, depth = 0) {
  if (typeof value === 'string') return value.length > 600 ? value.slice(0, 599) + '…' : value
  if (!isContainer(value)) return value
  const entries = Object.entries(value)
  if (depth >= 5) return Array.isArray(value) ? { total: value.length } : { fields: Object.keys(value).slice(0, 16) }
  if (Array.isArray(value)) return value.slice(0, depth < 2 ? 24 : 8).map((entry) => bound(entry, depth + 1))
  return Object.fromEntries(entries.slice(0, depth < 2 ? 24 : 16).map(([key, item]) => [key, bound(item, depth + 1)]))
}

function page(value, field, offset = 0, limit = 12) {
  const parts = field ? field.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')) : []
  if (field && !field.startsWith('/')) return bad('BAD_ARGUMENT', 'field 用 JSON Pointer，例如 /changes/checks。')
  const item = parts.reduce(getOwn, value)
  if (item === undefined) return bad('NOT_FOUND', '结果中没有 ' + field)
  const result = { status: 'ok', field: field ?? '', offset }
  const collection = typeof item === 'string' ? item : Array.isArray(item) ? item
    : isContainer(item) ? Object.entries(item) : null
  if (collection === null) return { ...result, value: item }
  if (typeof collection === 'string') {
    limit = Math.min(limit * 60, 1800)
    return { ...result, value: item.slice(offset, offset + limit), total: item.length,
      nextOffset: offset + limit < item.length ? offset + limit : null }
  }
  const rows = []
  let budget = 2600
  for (const row of collection.slice(offset, offset + limit)) {
    const limited = bound(row, 2)
    const size = JSON.stringify(limited).length
    if (rows.length && size > budget) break
    rows.push(size <= budget ? limited : (Array.isArray(item) ? { fields: Object.keys(row ?? {}).slice(0, 16) }
      : [row[0], { fields: Object.keys(row[1] ?? {}).slice(0, 16) }]))
    budget -= size
  }
  return { ...result, value: Array.isArray(item) ? rows : Object.fromEntries(rows),
    total: collection.length, nextOffset: offset + rows.length < collection.length ? offset + rows.length : null }
}

function mcpResult(data, original) {
  return {
    structuredContent: data,
    content: [{ type: 'text', text: JSON.stringify(data) },
      ...(original?.content ?? []).filter((part) => part.type !== 'text')],
  }
}

export function registerCompactTools(server, deps) {
  const { runtime, dispatchOperation, validateOperation, operations, revisionOf, parseEnvelopeText } = deps
  const details = new Map()
  const maxDetails = 64

  function remember(data) {
    const key = randomUUID()
    details.set(key, data)
    if (details.size > maxDetails) details.delete(details.keys().next().value)
    return key
  }

  function compact(raw, result, keepFull = false) {
    const revision = raw.designId ? (raw.revision ?? revisionOf(raw.designId)) : undefined
    const shared = { ...raw, ...(revision != null ? { revision } : {}) }
    const data = keepFull
      ? shared
      : bound({ ...summarize(shared), ...(shared.job?.jobId ? {} : { detailRef: remember(shared) }) })
    if (JSON.stringify(data).length > 5400 && !keepFull) {
      const core = only(data, ['status', 'summary', 'designId', 'revision', 'job', 'effect', 'extra', 'error', 'next',
        'nextActions', 'artifacts', 'completed', 'detailRef'])
      if (Array.isArray(data.steps)) core.steps = data.steps.map((step) => only(step, ['id', 'op', 'state', 'status']))
      return mcpResult(core, result)
    }
    return mcpResult(data, result)
  }

  async function execute(entry, args, designId, context) {
    const call = resolved(entry, args, designId)
    if (call.error) return { raw: call.error }
    const result = await dispatchOperation(entry.tool, call, context)
    return { result, raw: unwrapped(result, parseEnvelopeText) }
  }

  server.registerTool('run', {
    description: '推进一个设计阶段。必须给 designId、runId、operationId、steps；重连重提原参数查同一作业。默认等待，长阶段可 wait:false。steps 默认依序，deps 可指定依赖。plan / build 共用 definition，edit 用 args.parameters。核对用 verify，差异详见 read job。取消传 action:cancel 和 jobId。',
    inputSchema: displaySchema(runInput),
  }, async (input, mcp) => {
    const askingCancel = input?.action === 'cancel'
    const parsed = parse(askingCancel ? cancelSchema : startSchema, input)
    if (parsed.error) return mcpResult(parsed.error)
    const args = parsed.data
    if (askingCancel) return compact(await runtime.cancel({ jobId: args.jobId }))
    const steps = []
    for (const [index, step] of args.steps.entries()) {
      const entry = stages[step.op]
      const stepArgs = { ...step.args }
      if (['plan', 'build'].includes(step.op)) stepArgs.definition ??= args.definition
      const call = resolved(entry, stepArgs, args.designId)
      const error = call.error ?? stageError(step.op, call, args.designId)
      if (error) return mcpResult({ ...error, field: 'steps[' + index + '].args' })
      const checked = validateOperation(entry.tool, call)
      if (checked.error) return compact({ ...unwrapped(checked.error, parseEnvelopeText), field: 'steps[' + index + '].args' })
      steps.push({ id: step.id ?? String(index + 1), op: step.op, tool: entry.tool,
        args: call, deps: step.deps, mutates: stageMutates(step.op, call) })
    }
    const request = { ...only(args, ['runId', 'operationId', 'designId', 'expectedRevision']), steps }
    return compact(await runtime.submit(request, { wait: args.wait, context: { mcp } }))
  })

  server.registerTool('read', {
    description: '按 designId 查看模型、图纸、尺寸和项目，可用 capture 出图。按 jobId 查询持久阶段，按 detailRef 查近期结果。field 用 JSON Pointer，例如 /steps/0/result/changes/checks；offset、limit 分页。',
    inputSchema: displaySchema(readInput),
  }, async (input, mcp) => {
    const parsed = parse(readSchema, input)
    if (parsed.error) return mcpResult(parsed.error)
    const { kind, designId, field, args = {}, jobId, detailRef, offset, limit } = parsed.data
    if (kind === 'job') {
      if (!jobId) return mcpResult(bad('BAD_ARGUMENT', '查询阶段需要 jobId。'))
      const job = await runtime.get({ jobId })
      return field !== undefined && job?.job?.jobId ? mcpResult(page(job, field, offset, limit)) : compact(job)
    }
    if (kind === 'detail') {
      const raw = details.get(detailRef)
      return mcpResult(raw ? page(raw, field, offset, limit) : bad('NOT_FOUND', '近期结果引用不存在，请重读或改用持久作业 ID。'))
    }
    if (!designId && documentReads.has(kind)) return mcpResult(bad('DESIGN_ID_REQUIRED', '此查询需要 designId。'))
    const disallowed = readError(kind, args)
    if (disallowed) return mcpResult(disallowed)
    const { raw, result } = await execute(reads[kind], args, designId, { mcp, readOnly: true })
    if (field !== undefined && raw.status === 'ok') return mcpResult(page(raw, field, offset, limit), result)
    return compact(raw, result)
  })

  server.registerTool('help', {
    description: '查可用操作、参数与示例。op 查 run/read 操作，可用 read.relations 指定查询版本。q 搜能力目录；id 查一条，例如 feature.extrude 或 interop:IModelDoc2。',
    inputSchema: displaySchema(helpInput),
  }, async (input, mcp) => {
    const parsed = parse(helpSchema, input)
    if (parsed.error) return mcpResult(parsed.error)
    const { op, id: entryId, q, offset = 0, limit = 8 } = parsed.data
    if (op) {
      const designId = 'part-a'
      const readName = op.startsWith('read.') ? op.slice(5) : op
      const entry = getOwn(stages, op) ?? getOwn(reads, readName)
      if (!entry) return mcpResult(bad('UNKNOWN_OPERATION', '没有此操作，省略 op 查看可用列表。'))
      const forRun = Object.hasOwn(stages, op)
      const fields = z.toJSONSchema(operations.get(entry.tool).inputSchema, { io: 'input' }).properties
      const args = Object.fromEntries(entry.keys.map((name) => {
        const field = fields?.[name] ?? {}
        return [name, only(field, ['type', 'enum', 'description', 'default'])]
      }))
      const example = forRun
        ? { designId, runId: designId, operationId: op, steps: [{ op, args: entry.example }] }
        : { kind: readName, ...(documentReads.has(readName) ? { designId } : {}), args: entry.example }
      const guide = forRun ? { tool: 'run', op, args, example }
        : { tool: 'read', op: readName, args, example }
      return mcpResult({ status: 'ok', ...bound(guide) })
    }
    if (entryId || q) {
      const result = await dispatchOperation('catalog', entryId
        ? { action: 'detail', id: entryId }
        : { action: 'search', q, offset, limit: Math.min(limit, 20) }, { mcp, readOnly: true })
      const raw = unwrapped(result, parseEnvelopeText)
      if (raw.status !== 'ok') return compact(raw)
      const detailRef = remember(raw)
      const fields = entryId ? ['entry', 'members'] : ['items', 'total', 'nextOffset', 'offset']
      const changes = only(raw.changes, fields)
      if (Array.isArray(changes.members?.members)) {
        changes.members = { ...changes.members, members: changes.members.members.slice(0, 6) }
      }
      return mcpResult(bound({ status: raw.status, summary: raw.summary, changes, detailRef }))
    }
    return mcpResult({ status: 'ok', run: stageNames, read: [...readNames, 'job', 'detail'],
      examples: [
        { designId: 'part-a', runId: 'part-a', operationId: 'first-build', definition: plate,
          steps: [{ op: 'plan' }, { op: 'build' }, { op: 'relations' }] },
        { designId: 'part-a', runId: 'part-a', operationId: 'first-edit',
          steps: [{ op: 'edit', args: { parameters: { L: 35 } } }, { op: 'verify', args: { expect: { size: [35, 20, 5] } } }] },
      ] })
  })

  server.registerTool('deliver', {
    description: '交付已经核对与审查的当前设计版本。designId 必填；kind 默认 sldprt。把核对、read capture 和 deliver 放在同一段 run_code，截图后保持版本一致。',
    inputSchema: displaySchema(deliverInput),
  }, async (args, mcp) => {
    const result = await dispatchOperation('deliver', args, { mcp })
    return compact(unwrapped(result, parseEnvelopeText), result, true)
  })
}

