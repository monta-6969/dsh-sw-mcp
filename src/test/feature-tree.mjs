// features[] 分类的离线测试（不碰 SOLIDWORKS）。
//
// 这一组守的是一条具体的错：交付回读把整棵特征树抄进 manifest.features[]，
// 于是 24 条「特征」里 18 条是 收藏/历史记录/选择集/材质/基准面 这类文档结构
// （sw-native 实测 P-0009）。数特征、按顺序重放的消费方全被带偏。
import {
  classifyTreeNode, featuresFromTree,
} from '../server/feature-tree.mjs'

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS ', name) }
  else { fail += 1; console.log('FAIL ', name, JSON.stringify(detail ?? null)) }
}

check('收藏是结构', classifyTreeNode('FavoriteFolder') === 'structure')
check('历史记录是结构', classifyTreeNode('HistoryFolder') === 'structure')
check('选择集是结构', classifyTreeNode('SelectionSetFolder') === 'structure')
check('实体文件夹是结构（SolidBodyFolder）', classifyTreeNode('SolidBodyFolder') === 'structure')
check('注解是结构（DetailCabinet 不以 Folder 结尾）', classifyTreeNode('DetailCabinet') === 'structure')
check('任何 *Folder 兜底为结构', classifyTreeNode('SomeNewFolder') === 'structure')
check('基准面是参考几何', classifyTreeNode('RefPlane') === 'reference')
check('原点是参考几何', classifyTreeNode('OriginProfileFeature') === 'reference')
check('草图是特征', classifyTreeNode('ProfileFeature') === 'feature')
check('拉伸是特征', classifyTreeNode('Extrusion') === 'feature')
check('切除（ICE）是特征', classifyTreeNode('ICE') === 'feature')
check('kind 缺失按特征处理（宁可留下也不丢）', classifyTreeNode(null) === 'feature')

// P-0009 的回读树原样：24 条，其中 6 条是真特征。
const tree = [
  { name: '收藏', type: 'FavoriteFolder', id: 65 },
  { name: '历史记录', type: 'HistoryFolder', id: 66 },
  { name: '选择集', type: 'SelectionSetFolder', id: 67 },
  { name: '传感器', type: 'SensorFolder', id: 62 },
  { name: '设计活页夹', type: 'DocsFolder', id: 7 },
  { name: '注解', type: 'DetailCabinet', id: 1 },
  { name: '标注', type: 'InkMarkupFolder', id: 70 },
  { name: '光源与相机', type: 'EnvFolder', id: 6 },
  { name: '实体', type: 'SolidBodyFolder', id: 9 },
  { name: '曲面实体', type: 'SurfaceBodyFolder', id: 10 },
  { name: '备注', type: 'CommentsFolder', id: 8 },
  { name: '方程式', type: 'EqnFolder', id: 61 },
  { name: '材质 <未指定>', type: 'MaterialFolder', id: 29 },
  { name: '前视基准面', type: 'RefPlane', id: 2 },
  { name: '上视基准面', type: 'RefPlane', id: 3 },
  { name: '右视基准面', type: 'RefPlane', id: 4 },
  { name: '原点', type: 'OriginProfileFeature', id: 5 },
  { name: 'Tables', type: 'ConfigTableFolder', id: 71 },
  { name: 'keyPlate', type: 'ProfileFeature', id: 73 },
  { name: 'keyBody', type: 'Extrusion', id: 81 },
  { name: 'endRight', type: 'ProfileFeature', id: 82 },
  { name: 'endRightBoss', type: 'ICE', id: 89 },
  { name: 'endLeft', type: 'ProfileFeature', id: 90 },
  { name: 'endLeftBoss', type: 'ICE', id: 97 },
]
const { features, filter } = featuresFromTree(tree)
check('24 条树 → 6 条特征', features.length === 6, features.map((f) => f.name))
check('结构节点 14 条、参考几何 4 条', filter.structure.length === 14 && filter.reference.length === 4, filter)
check('特征按树顺序保留', features.map((f) => f.name).join(',') === 'keyPlate,keyBody,endRight,endRightBoss,endLeft,endLeftBoss', features.map((f) => f.name))
check('保留下来的仍带 source=file-readback 与 params:null', features.every((f) => f.source === 'file-readback' && f.params === null && typeof f.note === 'string'))
check('id 不丢（能回到树上定位）', features.find((f) => f.name === 'endLeftBoss')?.id === 97)
check('过滤器不过滤名字叫「实体」之外的结构（无漏网）', !features.some((f) => /Folder|Cabinet/.test(String(f.kind))), features.map((f) => f.kind))
check('回执里点数=24、留数=6', filter.treeCount === 24 && filter.featureCount === 6, filter)
check('回执能回答「丢了哪些」', filter.structure.includes('收藏') && filter.reference.includes('前视基准面'))
check('非数组返回空 features + 零回执', featuresFromTree(null).features.length === 0 && featuresFromTree('x').filter.treeCount === 0)
check('空树也不炸', featuresFromTree([]).filter.featureCount === 0)
check('全是结构节点时 features 为空（由调用方回落到建模意图）', featuresFromTree(tree.slice(0, 18)).features.length === 0)

console.log(`\nfeature-tree: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
