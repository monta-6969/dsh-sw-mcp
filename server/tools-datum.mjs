// 命名基准几何（native 模式）。
//
// 为什么要有它：装配定位如果只认拓扑面（persistentId 指向的那张面），一次重建
// 换了面序，配好的位置就悄悄指到别处 —— 回包还说 ok。基准是**名字**，名字由
// design.json 持有，位姿由 SOLIDWORKS 回读，重开之后按名字还找得到。
//
// 分工：
//   design.json  —— 唯一真源：名字、种类、来源、persistentId、最近一次全局位姿。
//   SOLIDWORKS   —— 真正的参考几何（点/轴/面/坐标系）；datumList 回读确认它还在。
// 两边对不上时（文件里有、模型里没有）报 stale，不装作在。
//
// 重名一律拒绝：基准名是稳定引用，两个同名基准等于没有名字。

import { designFileFor, readJsonFile } from './design-store.mjs'

const KINDS = ['point', 'axis', 'plane', 'coordSys']
const SOURCE_TYPES = ['coords', 'faceEdge', 'circleCenter', 'cylinderAxis', 'twoPlanes', 'planeOffset']

/** 基准名要能直接写进 placement:"datum:<name>"，所以不允许空白与冒号。 */
const NAME_PATTERN = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{1,64}$/

function normalizeName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return { error: 'name 必填（1–64 个字符，可含字母/数字/中文/_.-，不能有空格与冒号）' }
  if (!NAME_PATTERN.test(name)) {
    return { error: `基准名 "${raw}" 不能用：只接受字母/数字/中文/_.-，且不能含空格或冒号（placement 用 "datum:<name>" 引用它）` }
  }
  return { name }
}

function datumListOf(project) {
  return Array.isArray(project?.datums) ? project.datums : []
}

function frameOf(record) {
  if (record === null || typeof record !== 'object') return null
  const frame = record.frame
  if (frame === null || typeof frame !== 'object') return null
  const origin = Array.isArray(frame.origin) ? frame.origin : null
  const axes = Array.isArray(frame.axes) ? frame.axes : null
  if (origin === null && axes === null) return null
  return { origin, axes }
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(Number(value).toFixed(digits)) : null
}

function describeDatum(record) {
  const frame = frameOf(record)
  const at = frame?.origin ? frame.origin.map((v) => round(v, 3)).join(',') : '?'
  return `${record.kind} "${record.name}" @ (${at})`
}

export function registerDatumTools(server, z, deps) {
  const { envelope, ok, failed, fail, callBridge, readProject, writeProject, requireDesignId } = deps

  const sourceShape = z.object({
    type: z.enum(SOURCE_TYPES).describe('来源：coords=显式坐标；faceEdge=面/边交点；circleCenter=圆心；'
      + 'cylinderAxis=圆柱面轴线；twoPlanes=两平面交线（或 planeOffset=平面偏置）'),
    face: z.string().optional().describe('faceEdge/circleCenter/cylinderAxis：面 id 或 persistentId（inspect action="faces" 取）'),
    edge: z.string().optional().describe('faceEdge/circleCenter：边 id（inspect action="faces" 返回的边引用）'),
    first: z.union([z.string(), z.number().int().min(0).max(2)]).optional()
      .describe('twoPlanes：第一个平面（基准面序号 0/1/2，或面的 persistentId）'),
    second: z.union([z.string(), z.number().int().min(0).max(2)]).optional()
      .describe('twoPlanes：第二个平面'),
    offsetMm: z.number().optional().describe('planeOffset：相对 first 平面的偏置（mm）'),
  }).passthrough()

  const datumShape = {
    designId: deps.designIdArg,
    name: z.string().optional().describe('基准名（create/delete/get/rebuild 必填）。重名会被 DATUM_EXISTS 拒绝：'
      + '名字是稳定引用，改名请先 delete'),
    kind: z.enum(KINDS).optional().describe('create：point=基准点 / axis=基准轴 / plane=基准面 / coordSys=坐标系'),
    source: sourceShape.optional().describe('create：基准的来源。不给 source 时按 coords 用 x/y/z'),
    x: z.number().optional().describe('create：全局 X（mm，装配/零件文档坐标系）；也是 coords 来源的坐标'),
    y: z.number().optional().describe('create：全局 Y（mm）'),
    z: z.number().optional().describe('create：全局 Z（mm）'),
    axes: z.array(z.number()).length(9).optional()
      .describe('create：3×3 行主序朝向（coordSys/plane 用；缺省单位矩阵 = 与文档坐标系同向）'),
    attach: z.boolean().optional()
      .describe('create：true（默认）在 SOLIDWORKS 里建真参考几何；false 只登记到 design.json（不推荐，装配无法用它定位）'),
    includeStale: z.boolean().optional().describe('list：是否连「文件里有、模型里没有」的也一并返回（默认 true）'),
  }

  server.registerTool(
    'datum',
    {
      title: '命名基准几何',
      description: '创建/读取/删除命名基准点、基准轴、基准面、坐标系，并把名字与全局位姿写进 design.json；装配用 placement:"datum:<name>" 引用它，不依赖容易变的拓扑面。',
      inputSchema: z.object({
        action: z.enum(['create', 'list', 'get', 'delete', 'rebuild']).default('list')
          .describe('要做什么：create 建一个并登记；list 列表（含 stale 标记）；get 读一个；'
            + 'delete 删掉（释放名字）；rebuild 按 design.json 里记的来源把丢掉的基准重建回来'),
        ...datumShape,
      }),
    },
    async (args) => {
      const started = Date.now()
      try {
        switch (args.action) {
          case 'create': {
            const designId = requireDesignId(args.designId, { tool: 'datum', action: 'create' })
            const checked = normalizeName(args.name)
            if (checked.error) {
              return failed({ op: 'datum.create', designId, error: fail('BAD_ARGUMENT', checked.error, { given: args.name }) })
            }
            const name = checked.name
            if (!args.kind) {
              return failed({
                op: 'datum.create', designId,
                error: fail('BAD_ARGUMENT', 'create 需要 kind：point / axis / plane / coordSys', { supported: KINDS }),
              })
            }
            const project = readProject(designId)
            if (!project) {
              return failed({
                op: 'datum.create', designId,
                error: fail('DESIGN_NOT_FOUND', `没有 designId=${designId} 的项目记录：先 model action="build" 或 deliver 一次，基准才有地方落账`, { designId }),
                nextActions: ['先 workspace action="preflight" 看当前设计状态，再 build/deliver 建立项目记录'],
              })
            }
            const existing = datumListOf(project).find((item) => item?.name === name)
            if (existing) {
              return failed({
                op: 'datum.create', designId,
                error: fail('DATUM_EXISTS', `design.json 里已经有基准 "${name}"（${existing.kind}）：基准名是稳定引用，重名会让两处理解指向两个东西。`
                  + '要换位姿先 datum action="delete" 再 create，或用 rebuild', { name, existingKind: existing.kind }),
                nextActions: ['datum action="delete" name="' + name + '" 释放名字后重建，或换一个名字'],
              })
            }
            const source = args.source ?? {
              type: 'coords', x: args.x, y: args.y, z: args.z,
            }
            if (source.type === 'coords' && ![args.x, args.y, args.z].some((v) => Number.isFinite(v))) {
              return failed({
                op: 'datum.create', designId,
                error: fail('BAD_ARGUMENT', 'coords 来源缺少坐标：给 x/y/z（mm）', { source }),
              })
            }
            let bridged = null
            if (args.attach !== false) {
              try {
                bridged = await callBridge('datumCreate', {
                  designId, name, kind: args.kind, source,
                  x: args.x, y: args.y, z: args.z,
                  ...(Array.isArray(args.axes) ? { axes: args.axes } : {}),
                })
              } catch (error) {
                // 建不出真参考几何时绝不登记一条假的：design.json 里写着、模型里没有，
                // 之后装配会按一个不存在的位姿落位，而且看起来像成功。
                return failed({
                  op: 'datum.create', designId,
                  error: error?.code ? error : fail('DATUM_CREATE_FAILED', `基准没有建成：${error?.message ?? error}`, { name, kind: args.kind, source }),
                  nextActions: ['看 error.code：DATUM_UNSUPPORTED=这个种类/来源在当前 SOLIDWORKS 没有可用 API；DATUM_EXISTS=模型里已有同名特征'],
                })
              }
            }
            const record = {
              name,
              kind: args.kind,
              source,
              persistentId: bridged?.persistentId ?? null,
              feature: bridged?.feature ?? null,
              frame: bridged?.frame ?? null,
              attached: args.attach !== false,
              createdAt: new Date().toISOString(),
              revision: project.revision ?? null,
            }
            writeProject({
              ...project,
              datums: [...datumListOf(project), record],
              updatedAt: new Date().toISOString(),
            })
            return ok(
              envelope({
                summary: `已建基准 ${describeDatum(record)}${record.attached ? '' : '（只登记，未在 SOLIDWORKS 建参考几何）'}`,
                designId,
                changes: { datum: record, bridge: bridged },
                nextActions: [
                  'datum action="list" 确认它在（重开文档后名字仍然稳定）',
                  '装配里用它定位：assembly action="assemble" components[].placement="datum:' + name + '"',
                  '需要按基准朝向对齐时，assemble 后再用 componentRotate frame="local" 校一次朝向',
                ],
                timings: { totalMs: Date.now() - started },
              }),
            )
          }
          case 'list': {
            const designId = requireDesignId(args.designId, { tool: 'datum', action: 'list' })
            const project = readProject(designId)
            const stored = datumListOf(project)
            let live = null
            let liveError = null
            try {
              live = await callBridge('datumList', { designId })
            } catch (error) {
              liveError = { code: error?.code ?? 'DATUM_LIST_FAILED', message: error?.message ?? String(error) }
            }
            const liveNames = new Set((Array.isArray(live?.datums) ? live.datums : []).map((item) => item?.name))
            const rows = stored.map((item) => ({
              name: item.name,
              kind: item.kind,
              source: item.source ?? null,
              persistentId: item.persistentId ?? null,
              frame: item.frame ?? null,
              live: live === null ? null : liveNames.has(item.name),
              stale: live === null ? null : !liveNames.has(item.name),
            }))
            const includeStale = args.includeStale !== false
            const shown = includeStale ? rows : rows.filter((row) => row.stale === false)
            const staleCount = rows.filter((row) => row.stale === true).length
            return ok(
              envelope({
                summary: `${designId}：${shown.length} 个命名基准`
                  + (live === null ? '（模型回读不可用）' : staleCount > 0 ? `，其中 ${staleCount} 个在模型里已经不存在` : '，模型里都在'),
                designId,
                status: liveError === null ? 'ok' : 'incomplete',
                changes: { datums: shown, live: live?.datums ?? null, liveError },
                nextActions: [
                  ...(staleCount > 0 ? ['有 stale 基准：`datum action="rebuild"` 按 design.json 里的来源重建，或 delete 后重新 create'] : []),
                  ...(shown.length === 0 ? ['还没有基准：`datum action="create"` 建一个（先想好名字，装配要按名字引用它）'] : []),
                ],
                timings: { totalMs: Date.now() - started },
              }),
            )
          }
          case 'get': {
            const designId = requireDesignId(args.designId, { tool: 'datum', action: 'get' })
            const checked = normalizeName(args.name)
            if (checked.error) return failed({ op: 'datum.get', designId, error: fail('BAD_ARGUMENT', checked.error) })
            const project = readProject(designId)
            const record = datumListOf(project).find((item) => item?.name === checked.name)
            if (!record) {
              return failed({
                op: 'datum.get', designId,
                error: fail('DATUM_NOT_FOUND', `${designId} 里没有基准 "${checked.name}"`,
                  { available: datumListOf(project).map((item) => item?.name) }),
                nextActions: ['datum action="list" 看有哪些名字；名字必须与 design.json 里的一致'],
              })
            }
            return ok(
              envelope({
                summary: describeDatum(record),
                designId,
                changes: { datum: record },
                nextActions: ['要把它当装配定位用：placement="datum:' + record.name + '"'],
                timings: { totalMs: Date.now() - started },
              }),
            )
          }
          case 'delete': {
            const designId = requireDesignId(args.designId, { tool: 'datum', action: 'delete' })
            const checked = normalizeName(args.name)
            if (checked.error) return failed({ op: 'datum.delete', designId, error: fail('BAD_ARGUMENT', checked.error) })
            const project = readProject(designId)
            const record = datumListOf(project).find((item) => item?.name === checked.name)
            if (!record) {
              return failed({
                op: 'datum.delete', designId,
                error: fail('DATUM_NOT_FOUND', `${designId} 里没有基准 "${checked.name}"`,
                  { available: datumListOf(project).map((item) => item?.name) }),
              })
            }
            let bridgeDeleted = null
            let bridgeNote = null
            if (record.attached !== false) {
              try {
                const out = await callBridge('datumDelete', { designId, name: checked.name })
                bridgeDeleted = out?.deleted === true
              } catch (error) {
                // 模型里已经没有了也算删干净；真正的失败要说出来，但 design.json 必须同步，
                // 否则名字被永久占住（delete 之后再也 create 不了同一个名字）。
                bridgeNote = error?.code === 'DATUM_NOT_FOUND'
                  ? '模型里本来就没有这个基准（只删了登记）'
                  : `模型侧删除失败：${error?.message ?? error}`
              }
            }
            writeProject({
              ...project,
              datums: datumListOf(project).filter((item) => item?.name !== checked.name),
              updatedAt: new Date().toISOString(),
            })
            return ok(
              envelope({
                summary: `已删除基准 "${checked.name}"` + (bridgeDeleted === false ? '（模型侧未确认删除）' : ''),
                designId,
                status: bridgeNote !== null && bridgeDeleted !== true ? 'incomplete' : 'ok',
                changes: { name: checked.name, modelDeleted: bridgeDeleted, note: bridgeNote },
                nextActions: ['名字已释放：可以用同一个名字重新 create（重开文档后也不会指向旧几何）'],
                timings: { totalMs: Date.now() - started },
              }),
            )
          }
          case 'rebuild': {
            const designId = requireDesignId(args.designId, { tool: 'datum', action: 'rebuild' })
            const project = readProject(designId)
            const stored = datumListOf(project)
            if (stored.length === 0) {
              return failed({ op: 'datum.rebuild', designId, error: fail('DATUM_NOT_FOUND', `${designId} 的 design.json 里没有基准可重建`) })
            }
            const only = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null
            let liveNames = new Set()
            try {
              const live = await callBridge('datumList', { designId })
              liveNames = new Set((Array.isArray(live?.datums) ? live.datums : []).map((item) => item?.name))
            } catch {
              // 回读不了就全部重建：重名由桥接器拒，错误会出现在 rebuilt 里。
            }
            const targets = stored.filter((item) => only === null || item.name === only)
            if (targets.length === 0) {
              return failed({ op: 'datum.rebuild', designId, error: fail('DATUM_NOT_FOUND', `没有名为 "${only}" 的基准`) })
            }
            const rebuilt = []
            const nextDatums = [...stored]
            for (const record of targets) {
              if (only === null && liveNames.has(record.name)) {
                rebuilt.push({ name: record.name, rebuilt: false, note: '模型里已经存在，跳过' })
                continue
              }
              try {
                const out = await callBridge('datumCreate', {
                  designId, name: record.name, kind: record.kind, source: record.source ?? { type: 'coords' },
                  ...(frameOf(record)?.origin ? { x: frameOf(record).origin[0], y: frameOf(record).origin[1], z: frameOf(record).origin[2] } : {}),
                  ...(frameOf(record)?.axes ? { axes: frameOf(record).axes } : {}),
                })
                const index = nextDatums.findIndex((item) => item?.name === record.name)
                if (index >= 0) {
                  nextDatums[index] = {
                    ...nextDatums[index],
                    persistentId: out?.persistentId ?? nextDatums[index].persistentId ?? null,
                    feature: out?.feature ?? nextDatums[index].feature ?? null,
                    frame: out?.frame ?? nextDatums[index].frame ?? null,
                    rebuiltAt: new Date().toISOString(),
                  }
                }
                rebuilt.push({ name: record.name, rebuilt: true, frame: out?.frame ?? null })
              } catch (error) {
                rebuilt.push({ name: record.name, rebuilt: false, code: error?.code ?? 'DATUM_CREATE_FAILED', message: error?.message ?? String(error) })
              }
            }
            writeProject({ ...project, datums: nextDatums, updatedAt: new Date().toISOString() })
            const failedRows = rebuilt.filter((row) => row.rebuilt === false && row.note === undefined)
            return ok(
              envelope({
                summary: `重建基准：成功 ${rebuilt.filter((row) => row.rebuilt).length} 个，跳过 ${rebuilt.filter((row) => row.note).length} 个，失败 ${failedRows.length} 个`,
                designId,
                status: failedRows.length === 0 ? 'ok' : 'incomplete',
                changes: { rebuilt, datums: nextDatums },
                nextActions: failedRows.length > 0
                  ? ['失败项看 error.code：DATUM_UNSUPPORTED 表示这个来源在当前 SOLIDWORKS 建不出来；换来源（例如 coords）后重试']
                  : ['datum action="list" 确认所有基准 live=true'],
                timings: { totalMs: Date.now() - started },
              }),
            )
          }
          default:
            return failed({ op: 'datum', designId: args.designId, error: fail('UNKNOWN_ACTION', `未知动作 ${args.action}`) })
        }
      } catch (error) {
        return failed({ op: `datum.${args.action}`, designId: args.designId, error })
      }
    },
  )

  /** 供 assembly.assemble 解析 placement:"datum:<name>"；找不到返回带说明的 null。 */
}

/**
 * 装配 placement 的纯换算：把 placement:"datum:<name>" 变成「零件原点该落在哪」。
 *
 * 单独抽出来是为了能离线断言。以前 server.mjs 算完 componentsForBridge 却仍把
 * 原始 args.components 传给 componentInsert —— datum 换算被静默丢弃，零件按包围盒
 * 中心落位，回包还是 ok。这个函数只做数学与 design.json 读取，不碰 SOLIDWORKS。
 *
 * 返回 { components, notes } 或 { error: { code, message, detail } }。
 */
export function planPlacementComponents(components) {
  const list = Array.isArray(components) ? components : []
  const mapped = []
  const notes = []
  for (const [index, rawComponent] of list.entries()) {
    const component = rawComponent !== null && typeof rawComponent === 'object' ? rawComponent : {}
    const raw = typeof component.placement === 'string' && component.placement.length > 0
      ? component.placement
      : 'bbox-center'
    if (raw === 'origin' || raw === 'bbox-center') {
      mapped.push({ ...component, placement: raw })
      continue
    }
    if (!raw.startsWith('datum:')) {
      return {
        error: {
          code: 'BAD_ARGUMENT',
          message: `第 ${index} 个组件的 placement="${raw}" 不认识`,
          detail: { index, supported: ['origin', 'bbox-center', 'datum:<name>'] },
        },
      }
    }
    const name = raw.slice('datum:'.length).trim()
    if (!name) {
      return {
        error: {
          code: 'BAD_ARGUMENT',
          message: 'placement="datum:" 后面缺基准名',
          detail: { index, supported: ['origin', 'bbox-center', 'datum:<name>'] },
        },
      }
    }
    const path = typeof component.path === 'string' ? component.path : ''
    const resolved = resolvePlacementDatum(path, name)
    if (resolved.found !== true) {
      return {
        error: {
          code: 'DATUM_NOT_FOUND',
          message: `第 ${index} 个组件（${path || '没有 path'}）找不到基准 "${name}"：${resolved.reason}`,
          detail: { index, name, available: resolved.available ?? [] },
        },
      }
    }
    const target = [Number(component.x ?? 0), Number(component.y ?? 0), Number(component.z ?? 0)]
    const placedAt = target.map((value, axis) => Math.round((value - Number(resolved.origin[axis] ?? 0)) * 1e4) / 1e4)
    mapped.push({ ...component, x: placedAt[0], y: placedAt[1], z: placedAt[2], placement: 'origin' })
    notes.push({
      index, component: path || null, datum: name, kind: resolved.kind ?? null,
      requestedAt: target, datumOrigin: resolved.origin, partOriginAt: placedAt,
      note: 'datum 只对齐基准原点：朝向要再 componentRotate frame="local" 校一次（当前桥接器 local 未实现，回包会标 frameUnsupported）',
    })
  }
  return { components: mapped, notes }
}

/** 装配落位用：从零件旁边的 design.json 读基准位姿。
 *  找不到时返回带 available 的说明，调用方据此报 DATUM_NOT_FOUND（绝不静默退回原点）。 */
export function resolvePlacementDatum(cadPath, name) {
  try {
    const design = readJsonFile(designFileFor(cadPath))
    const record = datumListOf(design).find((item) => item?.name === name)
    if (!record) {
      return {
        found: false, name,
        available: datumListOf(design).map((item) => item?.name),
        reason: design === null
          ? `${cadPath} 旁边没有 design.json（基准只登记在那里）：先对那个零件做一次 deliver 建立记录`
          : `design.json 里没有基准 "${name}"`,
      }
    }
    const origin = frameOf(record)?.origin
    if (!Array.isArray(origin) || origin.length !== 3) {
      return { found: false, name, available: [], reason: `基准 "${name}" 没有记录全局位姿（frame.origin）` }
    }
    return { found: true, name, kind: record.kind, origin, axes: frameOf(record)?.axes ?? null, record }
  } catch (error) {
    return { found: false, name, available: [], reason: error?.message ?? String(error) }
  }
}
