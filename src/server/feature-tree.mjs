// 交付回读的特征树 → manifest 的 features[]
//
// R-61：features[] 不得为空。子会话交付已有文件时没有「建模意图」可抄，只能从
// 文件的特征树回读。但特征树是**文档结构**，不等于**建模特征**：SolidWorks 的树
// 里固定挂着 收藏 / 历史记录 / 选择集 / 传感器 / 注解 / 光源与相机 / 实体 / 曲面实体 /
// 备注 / 方程式 / 材质 / 设计活页夹 / Tables，外加三个默认基准面和原点。
// 这些节点每个零件都有，跟"这个件是怎么做出来的"无关；把它们抄进 features[] 会让
// 「数一数特征」「按顺序重放」这类消费方全部走偏（sw-native 实测 P-0009：24 条里
// 18 条是结构节点）。
//
// 所以这里分三类，并且**把丢掉的写回回执**：不静默过滤，也不为凑数保留。
//   feature   → 进 features[]（草图 ProfileFeature、拉伸 Extrusion、切除 ICE、…）
//   structure → 树容器（kind 以 Folder 结尾 / DetailCabinet）
//   reference → 参考几何（默认基准面 / 基准轴 / 基准点 / 原点 / 坐标系）
//
// 判定只按 kind 字符串，不按名字匹配：中文界面下名字是「收藏」「历史记录」，英文
// 界面是 Favorites / History，kind 才是稳定的。

const STRUCTURE_KINDS = new Set(['DetailCabinet'])
const REFERENCE_KINDS = new Set(['RefPlane', 'RefAxis', 'RefPoint', 'OriginProfileFeature', 'CoordSystem', 'CoordinateSystem'])

/** 一个树节点属于哪一类：'feature' | 'structure' | 'reference'。 */
export function classifyTreeNode(kind) {
  const key = typeof kind === 'string' ? kind.trim() : ''
  if (key.length === 0) return 'feature'
  if (STRUCTURE_KINDS.has(key) || /Folder$/.test(key)) return 'structure'
  if (REFERENCE_KINDS.has(key)) return 'reference'
  return 'feature'
}

/**
 * 回读树 → { features, filter }。
 *
 * features 只含建模特征，形状与之前一致（name/kind/id/source/params/note），调用方
 * 不用改。filter 是回执：树上一共几条、留下几条、按类别丢了哪些名字，全部写在
 * 交付响应里，谁都可以复核「没被抄进去的那些是什么」。
 */
export function featuresFromTree(tree) {
  if (!Array.isArray(tree)) {
    return { features: [], filter: { treeCount: 0, featureCount: 0, structure: [], reference: [] } }
  }
  const features = []
  const structure = []
  const reference = []
  for (const node of tree) {
    const name = node?.name ?? null
    const kind = node?.type ?? null
    const category = classifyTreeNode(kind)
    if (category === 'structure') { structure.push({ name, kind }); continue }
    if (category === 'reference') { reference.push({ name, kind }); continue }
    features.push({
      name,
      kind,
      id: node?.id ?? null,
      source: 'file-readback',
      params: null,
      note: '参数未记录：这条来自交付文件的特征树回读',
    })
  }
  return {
    features,
    filter: {
      treeCount: tree.length,
      featureCount: features.length,
      structure: structure.map((row) => row.name),
      reference: reference.map((row) => row.name),
      structureKinds: [...new Set(structure.map((row) => row.kind))].sort(),
      referenceKinds: [...new Set(reference.map((row) => row.kind))].sort(),
    },
  }
}
