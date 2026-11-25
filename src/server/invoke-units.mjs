/**
 * `model action="invoke"` 的单位换算。
 *
 * SOLIDWORKS 的 API 一律用**米**，而模型与图纸讨论的是毫米。实测一次会话里，
 * `AndSelectByID("", "EDGE", 2.5, 20, 0)` 什么都没选中，返回的仍是 true；
 * 之后的特征建在空选集上，报错却指向完全无关的地方。换 0.0025 / 0.02 才对。
 *
 * 这里只换算**确定是长度**的参数位置：选择类 API 的坐标、插入组件的位移。
 * 角度、枚举、标志位一律不碰 —— 全量「数字除以 1000」会把 0.785 弧度变成 0.000785。
 */

/** 会改变选集的成员：调用之后要回读「选中了几个」。 */
export const SELECTION_MEMBERS = /^(And)?Select(ByID2|ByRay|ByID|ByRay2)?$/i

/** 成员 → 参数里哪些下标是长度（米）。只列确定是坐标的位置。 */
export const LENGTH_ARGS = {
  SelectByID2: [2, 3, 4],
  AndSelectByID: [2, 3, 4],
  SelectByRay: [0, 1, 2, 3, 4, 5, 6],
  InsertImportedComponent: [1, 2, 3],
}

/**
 * @param {string} member 成员名
 * @param {unknown[]} args 按签名顺序的参数
 * @param {'m'|'mm'|undefined} units 调用方给的单位
 * @returns {{args: unknown[], converted: number}}
 */
export function convertLengthArgs(member, args, units) {
  if (units !== 'mm') return { args, converted: 0 }
  const positions = LENGTH_ARGS[member]
  if (!positions || !Array.isArray(args)) return { args, converted: 0 }
  let converted = 0
  const out = args.map((value, index) => {
    if (!positions.includes(index) || typeof value !== 'number') return value
    converted += 1
    return value / 1000
  })
  return { args: out, converted }
}
