// 装配剩余自由度：SOLIDWORKS 没有公开的 DOF 读数接口。
//
// 实测依据（2026-11-26，本机 2026 SP3.2 的 interop 程序集）：
//   IAssemblyDoc 上没有 GetDOF/DegreesOfFreedom/GetDegreesOfFreedom 任何成员；
//   IComponent2 / IMate2 也没有。官方的自由度只活在 Motion 插件与"完全定义"的
//   界面颜色里，API 侧拿不到。
// 所以这里按配合类型扣自由度：每个自由组件 6 个，每种配合扣掉它约束的自由度。
//
// 这是**近似值**，两条局限必须一起报给调用方（caveats）：
//   1. 冗余/过定义的配合照样扣，扣到 0 也不会回弹（真实装配里过定义会报错，
//      但"已经过定义"这件事需要建模器自己发现）；
//   2. 配合的几何细节没参与计算：两个点重合和两个平面重合都记 3。
// 宁可给一个写明方法的近似值，也不给一个看起来精确的 null。

/** 各配合约束掉的自由度。键是 SolidWorks GetTypeName2() 的大写形式。 */
export const MATE_REMOVED_DOF = {
  LOCK: 6,
  HINGE: 5,
  CONCENTRIC: 4,
  WIDTH: 4,
  SLOT: 4,
  COINCIDENT: 3,
  PARALLEL: 2,
  PERPENDICULAR: 2,
  SYMMETRIC: 2,
  DISTANCE: 1,
  LIMITDISTANCE: 1,
  ANGLE: 1,
  LIMITANGLE: 1,
  TANGENT: 1,
  GEAR: 1,
  RACKPINION: 1,
  CAM: 1,
}

export function removedByMate(mate) {
  if (!mate) return 0
  const type = String(mate.type ?? '').trim().toUpperCase()
  const base = MATE_REMOVED_DOF[type]
  // 未知配合类型：不猜。报 0 并让 dofFromMates 把它列进 unknownTypes，
  // 调用方看到 unknownTypes 非空就知道 remaining 是上限而不是精确值。
  if (base === undefined) return 0
  return base + (mate.lockRotation === true ? 1 : 0)
}

/**
 * @param {{components?: Array<{name?:string, fixed?:boolean, suppressed?:boolean}>, mates?: Array<{type?:string, suppressed?:boolean, lockRotation?:boolean}>}} [input]
 * @returns {{remaining:number, total:number, removed:number, freeComponents:number, fixedComponents:number, mateCount:number, byType:Record<string,number>, unknownTypes:string[], overConstrained:boolean, method:string, caveats:string[]}}
 */
export function dofFromMates({ components = [], mates = [] } = {}) {
  const list = Array.isArray(components) ? components : []
  const free = list.filter((component) => component && component.fixed !== true && component.suppressed !== true)
  const fixed = list.filter((component) => component && component.fixed === true).length
  const activeMates = (Array.isArray(mates) ? mates : []).filter((mate) => mate && mate.suppressed !== true)

  const total = 6 * free.length
  const byType = {}
  const unknownTypes = new Set()
  let removed = 0
  for (const mate of activeMates) {
    const type = String(mate.type ?? '').trim().toUpperCase() || 'UNKNOWN'
    byType[type] = (byType[type] ?? 0) + 1
    const delta = removedByMate(mate)
    if (delta === 0) unknownTypes.add(type)
    removed += delta
  }

  return {
    remaining: Math.max(0, total - removed),
    total,
    removed,
    freeComponents: free.length,
    fixedComponents: fixed,
    mateCount: activeMates.length,
    byType,
    unknownTypes: [...unknownTypes],
    overConstrained: removed > total,
    method: '6×自由组件 − Σ每配合扣掉：concentric 4 / coincident 3 / distance·angle·tangent·gear 1 / parallel·perpendicular 2 / lock 6 / hinge 5 / width·slot 4',
    caveats: [
      'SOLIDWORKS 没有公开 DOF 接口（IAssemblyDoc/IComponent2/IMate2 都没有），这是按配合类型扣的近似值',
      '冗余与过定义配合不会被识别：overConstrained 只看「扣掉的比总量多」',
      '配合的几何细节不参与：点-点重合与面-面重合都记 3',
      ...(unknownTypes.size ? [`未知配合类型 ${[...unknownTypes].join('/')} 按 0 扣，remaining 是上限`] : []),
    ],
  }
}
