// 桥接器回包的纯读数换算：不碰 SOLIDWORKS，不读文件。
//
// 为什么单独一个文件：componentRotate 以前读 `out.rotation` / `out.pose` /
// `out.pivot`，而桥接器实际回的是 `nextArray` / `pivotUsed` / `centerDriftMm`
// —— 字段名对不上，于是工具描述承诺的 3×3 矩阵与位姿永远是 null，摘要只剩
// 一句「已转动」。这里把桥接器的真实回包翻译成工具描述承诺的形状，并用离线
// 测试钉住（test/native-preflight.mjs 直接 import 本文件）。

/** 桥接器 Transform2.ArrayData 的布局：[R00..R22, Tx, Ty, Tz, 0, 0, 0, 1]。
 *  平移量是米（SOLIDWORKS API 单位）；对外统一换回 mm。
 *  行主序：rotation[0..2] 是第一行。 */
export function poseFromTransformArray(array) {
  if (!Array.isArray(array) || array.length < 12) return null
  const nums = array.slice(0, 12).map((value) => Number(value))
  if (nums.some((value) => !Number.isFinite(value))) return null
  const rotation = nums.slice(0, 9)
  const originMm = nums.slice(9, 12).map((value) => Number((value * 1000).toFixed(4)))
  return { rotation, pose: { origin: originMm, axes: rotation } }
}

/** componentRotate 的对外读数。任何一项拿不到就是 null，不拿 0 冒充。 */
export function rotationReadout(payload) {
  const next = poseFromTransformArray(payload?.nextArray)
  const current = poseFromTransformArray(payload?.currentArray)
  const pivot = payload?.pivotUsed ?? payload?.pivot ?? null
  const drift = Number(payload?.centerDriftMm)
  return {
    rotation: next?.rotation ?? null,
    pose: next?.pose ?? null,
    before: current,
    pivot,
    pivotSource: typeof payload?.pivotUsed?.source === 'string'
      ? payload.pivotUsed.source
      : (typeof payload?.pivotSource === 'string' ? payload.pivotSource : null),
    centerBeforeMm: Array.isArray(payload?.centerBeforeMm) ? payload.centerBeforeMm : null,
    centerAfterMm: Array.isArray(payload?.centerAfterMm) ? payload.centerAfterMm : null,
    centerDriftMm: Number.isFinite(drift) ? drift : null,
    method: typeof payload?.method === 'string' ? payload.method : null,
    saved: payload?.saved === true,
  }
}

/** 通用：把桥接器回包里的 3×3 行主序矩阵格式化成一行可读文本。 */
export function formatMatrix(matrix, digits = 4) {
  if (!Array.isArray(matrix) || matrix.length !== 9) return null
  return [0, 1, 2]
    .map((row) => '[' + matrix.slice(row * 3, row * 3 + 3)
      .map((value) => Number(Number(value).toFixed(digits))).join(',') + ']')
    .join(' ')
}

/** 通用：把 mm 向量格式化成一行可读文本。 */
export function formatPoint(point, digits = 3) {
  if (!Array.isArray(point) || point.length !== 3) return null
  return point.map((value) => Number(Number(value).toFixed(digits))).join(',')
}
