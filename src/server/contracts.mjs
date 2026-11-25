// 统一契约 v4：引用、作业、任务、曲线、快照、事件、经验、能力表、差异。
//
// 为什么要有这个文件：桥接器（C#）和服务端（Node）各自都有一套“状态字符串”，
// 以前靠人记得同步。现在只有 contracts/enums.json 是事实源；zod 在这里把枚举变成
// 运行时可校验的 schema，tools/gen-contracts.mjs 再把同一份枚举生成 C# 常量。
// 任何一边改了词表，tools/check-contracts.mjs 会立刻失败。
//
// 这里刻意不引入 ajv 之类的依赖：zod 已经是现有依赖，且能直接导出 JSON Schema，
// 三份产物（Node 校验、仓库里的 schema 文件、C# 常量）来自同一个定义。
import { readFileSync } from 'node:fs'
import z from 'zod'

const enumsUrl = new URL('../contracts/enums.json', import.meta.url)
export const ENUMS = JSON.parse(readFileSync(enumsUrl, 'utf8'))

export const SCHEMA_VERSION = ENUMS.schemaVersion
export const PROTOCOL_VERSION = ENUMS.protocolVersion
export const BRIDGE_VERSION = ENUMS.bridgeVersion

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/, 'expected an ISO-8601 UTC timestamp')

const RefKind = z.enum(ENUMS.refKinds)
const JobState = z.enum(ENUMS.jobStates)
const TaskState = z.enum(ENUMS.taskStates)
const CurveKind = z.enum(ENUMS.curveKinds)
const CurveSource = z.enum(ENUMS.curveSources)
const ConstraintType = z.enum(ENUMS.constraintTypes)
const DimensionType = z.enum(ENUMS.dimensionTypes)
const Severity = z.enum(ENUMS.severities)
const EvidenceKind = z.enum(ENUMS.evidenceKinds)
const ExperienceKind = z.enum(ENUMS.experienceKinds)
const ExperienceStatus = z.enum(ENUMS.experienceStatus)
const EventName = z.enum(ENUMS.eventNames)

const Id = z.string().min(1).max(160)
const Quantity = z.object({
  value: z.number(),
  unit: z.enum([ENUMS.units.length, ENUMS.units.angle]).optional(),
  source: z.string().optional(),
})

export const Ref = z.object({
  kind: RefKind,
  id: Id,
})

const Refs = z
  .object({
    projectId: Id.optional(),
    runId: Id.optional(),
    instanceId: Id.optional(),
    documentId: Id.optional(),
    configuration: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .partial()

export const Progress = z.object({
  phase: z.string().max(160).optional(),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(4000).optional(),
  at: IsoDate,
})

export const JobError = z.object({
  code: z.string().min(1).max(80),
  message: z.string().max(8000),
  details: z.unknown().optional(),
})

export const Job = z.object({
  schemaVersion: z.number().int().min(4),
  jobId: Id,
  operationId: z.string().max(240).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  effect: z.enum(['none', 'applied', 'partial', 'unknown']).optional(),
  owner: z.object({ pid: z.number().int().positive(), token: Id }).optional(),
  reconciliation: z.object({
    at: IsoDate,
    note: z.string().min(1).max(4000),
    revision: z.number().int().nonnegative().nullable().optional(),
  }).optional(),
  op: z.string().min(1).max(80),
  state: JobState,
  refs: Refs.extend({ designId: Id.optional(), stageJobId: Id.optional() }).optional(),
  progress: Progress.optional(),
  worker: z
    .object({
      pid: z.number().int().positive().optional(),
      instanceId: Id.optional(),
    })
    .optional(),
  result: z.unknown().optional(),
  error: JobError.optional(),
  createdAt: IsoDate,
  startedAt: IsoDate.optional(),
  finishedAt: IsoDate.optional(),
  cancelRequested: z.boolean().optional(),
  retention: z.object({ until: IsoDate }).optional(),
})

export const TaskNode = z.object({
  nodeId: Id,
  op: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).optional(),
  refs: Refs.optional(),
  dependsOn: z.array(Id).default([]),
  resource: z.enum(['ui', 'cpu', 'any']).default('any'),
  retry: z
    .object({
      max: z.number().int().min(0).max(5).default(0),
      backoffMs: z.number().int().min(0).max(60000).default(0),
    })
    .optional(),
  continueOnError: z.boolean().default(false),
  state: TaskState.optional(),
  jobId: Id.optional(),
  error: JobError.optional(),
})

export const Task = z.object({
  schemaVersion: z.number().int().min(4),
  taskId: Id,
  runId: Id.optional(),
  nodes: z.array(TaskNode).min(1),
  state: TaskState.optional(),
  createdAt: IsoDate.optional(),
  updatedAt: IsoDate.optional(),
})

const Continuity = z.object({
  start: z.enum(['free', 'coincident', 'tangent', 'closed']).optional(),
  end: z.enum(['free', 'coincident', 'tangent', 'closed']).optional(),
})

export const Constraint = z.object({
  type: ConstraintType,
  refs: z.array(Id).default([]),
  value: z.number().optional(),
})

export const Dimension = z.object({
  name: Id,
  type: DimensionType,
  value: z.number(),
  refs: z.array(Id).default([]),
  driving: z.boolean().optional(),
})

export const Curve = z.object({
  kind: CurveKind,
  id: Id.optional(),
  construction: z.boolean().default(false),
  params: z.record(z.string(), z.unknown()),
  constraints: z.array(Constraint).default([]),
  dimensions: z.array(Dimension).default([]),
  continuity: Continuity.optional(),
  source: CurveSource.optional(),
  native: z
    .object({
      segmentType: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
    })
    .partial()
    .optional(),
  toleranceMm: z.number().positive().max(10).optional(),
})

export const SnapshotFile = z.object({
  kind: z.enum(ENUMS.fileKinds),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  bytes: z.number().int().nonnegative(),
})

export const Snapshot = z.object({
  schemaVersion: z.number().int().min(4),
  snapshotId: Id,
  documentId: Id.optional(),
  revision: z.number().int().nonnegative().optional(),
  configuration: z.string().optional(),
  at: IsoDate,
  files: z.array(SnapshotFile).min(1),
  measurements: z.unknown().optional(),
  features: z.array(z.unknown()).optional(),
  dimensions: z.array(z.unknown()).optional(),
})

export const Event = z.object({
  schemaVersion: z.number().int().min(4),
  eventId: Id,
  at: IsoDate,
  name: EventName,
  runId: Id.optional(),
  jobId: Id.optional(),
  documentId: Id.optional(),
  revision: z.number().int().nonnegative().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

export const EvidenceRef = z.object({
  kind: z.enum(['face', 'edge', 'feature', 'dimension', 'vertex', 'body']),
  id: Id,
  synthetic: z.boolean().optional(),
})

export const EvidenceRegion = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  w: z.number().positive(),
  h: z.number().positive(),
})

export const EvidenceItem = z.object({
  id: Id,
  severity: Severity,
  kind: EvidenceKind,
  view: z.string().min(1),
  region: EvidenceRegion,
  entityRef: EvidenceRef.optional(),
  expected: Quantity.optional(),
  measured: Quantity.optional(),
  delta: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  nextObservation: z.string().max(2000).optional(),
})

export const EvidenceDiff = z.object({
  schemaVersion: z.number().int().min(4),
  snapshotId: Id.optional(),
  sourceKey: Id.optional(),
  items: z.array(EvidenceItem),
})

export const ExperienceRecord = z.object({
  id: Id,
  schemaVersion: z.number().int().min(4),
  kind: ExperienceKind,
  title: z.string().min(1).max(240),
  conditions: z
    .object({
      taskKinds: z.array(z.string()).optional(),
      partTypes: z.array(z.string()).optional(),
      featureKinds: z.array(z.string()).optional(),
      swVersion: z.string().optional(),
      bridgeVersion: z.string().optional(),
      machine: z.string().optional(),
      units: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
  action: z.string().min(1),
  observation: z.string().min(1),
  evidenceRefs: z
    .array(
      z.object({
        kind: z.enum(['snapshot', 'file', 'job', 'document', 'drawing']),
        ref: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
        at: IsoDate.optional(),
      }),
    )
    .default([]),
  environment: z.record(z.string(), z.unknown()).optional(),
  benefit: z
    .object({
      wallMsSaved: z.number().nonnegative().optional(),
      rebuildsAvoided: z.number().int().nonnegative().optional(),
      failuresAvoided: z.number().int().nonnegative().optional(),
      reviewRoundsSaved: z.number().int().nonnegative().optional(),
    })
    .optional(),
  status: ExperienceStatus.default('draft'),
  supersedes: z.array(Id).default([]),
  supersededBy: Id.nullable().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate.optional(),
  lastUsedAt: IsoDate.optional(),
  uses: z.number().int().nonnegative().default(0),
})

export const CapabilityOp = z.object({
  name: z.string().min(1),
  summary: z.string().max(2000),
  args: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        required: z.boolean().default(false),
      }),
    )
    .default([]),
  mutates: z.boolean().default(false),
  requiresDocument: z.boolean().default(false),
  lockClass: z.enum(['free', 'read', 'write']).default('write'),
  since: z.string().optional(),
})

export const Capabilities = z.object({
  schemaVersion: z.number().int().min(4),
  protocolVersion: z.number().int().min(4),
  bridgeVersion: z.string(),
  generatedAt: IsoDate,
  ops: z.array(CapabilityOp).min(1),
})

export const Schemas = {
  ref: Ref,
  job: Job,
  task: Task,
  curve: Curve,
  snapshot: Snapshot,
  event: Event,
  experience: ExperienceRecord,
  capabilities: Capabilities,
  evidenceDiff: EvidenceDiff,
}

const TITLES = {
  ref: 'sw-mcp ref',
  job: 'sw-mcp job',
  task: 'sw-mcp task graph',
  curve: 'sw-mcp sketch curve',
  snapshot: 'sw-mcp same-revision snapshot',
  event: 'sw-mcp event',
  experience: 'sw-mcp experience record',
  capabilities: 'sw-mcp bridge capability manifest',
  evidenceDiff: 'sw-mcp drawing/model difference',
}

/** JSON Schema for every contract, keyed by the same names as Schemas. */
export function jsonSchemas() {
  const out = {}
  for (const [name, schema] of Object.entries(Schemas)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12' })
    out[name] = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://sw-mcp.local/contracts/${name}.schema.json`,
      title: TITLES[name] ?? name,
      ...json,
    }
  }
  return out
}

/**
 * Validate one contract value.
 * Returns {ok, errors:[{path,message}], value} where value is the parsed (defaults
 * applied, unknown keys stripped) copy — never store that copy as the record.
 */
export function validate(kind, value) {
  const schema = Schemas[kind]
  if (!schema) {
    return { ok: false, errors: [{ path: '', message: `unknown contract "${kind}"` }] }
  }
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, errors: [], value: result.data }
  return {
    ok: false,
    value: null,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  }
}

export class ContractError extends Error {
  constructor(kind, errors) {
    const first = errors[0]
    super(`${kind} contract invalid: ${first ? `${first.path || '<root>'}: ${first.message}` : 'unknown error'}`)
    this.name = 'ContractError'
    this.code = 'CONTRACT_INVALID'
    this.details = { kind, errors }
  }
}

export function assertValid(kind, value) {
  const result = validate(kind, value)
  if (!result.ok) throw new ContractError(kind, result.errors)
  return result.value
}

export function isTerminalJobState(state) {
  return ENUMS.terminalJobStates.includes(state)
}

export function isCurveKind(kind) {
  return ENUMS.curveKinds.includes(kind)
}
