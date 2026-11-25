// invoke 的单位换算：只换算确定是长度的位置，角度/枚举一律不碰。
//
// 事故来源（session-3f026ed8）：SelectByID2 的坐标按毫米写（2.5 / 20），API 要米，
// 于是什么都没选中，返回照样 true；后面的特征建在空选集上，错误指向完全无关处。
// 换算本身不该靠猜：只认已知是坐标的参数下标，其余原样透传。
import { convertLengthArgs, LENGTH_ARGS, SELECTION_MEMBERS } from '../server/invoke-units.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

// 1) 选择类 API：坐标转米，名字/类型/布尔/枚举原样
const select = convertLengthArgs('SelectByID2', ['', 'FACE', 2.5, 20, -0.75, false, 0, null, 0], 'mm')
check('SelectByID2 的 x/y/z 被换算', JSON.stringify(select.args.slice(2, 5)) === JSON.stringify([0.0025, 0.02, -0.00075]),
  select.args.slice(2, 5))
check('换算计数是 3', select.converted === 3, select.converted)
check('布尔没被当成数字', select.args[5] === false, select.args[5])
check('字符串没被动', select.args[1] === 'FACE', select.args[1])
check('null 没被动', select.args[7] === null, select.args[7])

// 2) 默认单位是米：什么都不换算
const metres = convertLengthArgs('SelectByID2', ['', 'FACE', 0.0025, 0.02, 0, false, 0, null, 0], undefined)
check('不给 units 时一个也不换', metres.converted === 0, metres.converted)
check('参数原样返回', metres.args[2] === 0.0025, metres.args[2])

// 3) 角度不能被当成长度：SelectByRay 全是坐标，但要确认没把别的成员算进来
const ray = convertLengthArgs('SelectByRay', [0, 0, 5, 0, 0, -1, 0.5], 'mm')
check('SelectByRay 三个点 + 方向 + 半径都换算', ray.converted === 7, ray.converted)
const chamfer = convertLengthArgs('InsertFeatureChamfer', [0, 1, 0.002, 0.7853981, 0, 0, 0, 0], 'mm')
check('倒角的角度参数不在换算表里', chamfer.converted === 0, chamfer.converted)

// 4) 未登记的成员一律不换算
const unknown = convertLengthArgs('FeatureExtrusion3', [false, false, false, 0, 0, 10, 0], 'mm')
check('未登记的成员不换算', unknown.converted === 0, unknown.converted)

// 5) 插入组件的位移
const comp = convertLengthArgs('InsertImportedComponent', ['C:/a.SLDPRT', 100, 0, -50, null], 'mm')
check('InsertImportedComponent 的位移换算', JSON.stringify(comp.args.slice(1, 4)) === JSON.stringify([0.1, 0, -0.05]),
  comp.args.slice(1, 4))

// 6) 选择类成员的正则要能认出会出现的几种写法
for (const name of ['SelectByID2', 'AndSelectByID', 'SelectByRay', 'SelectByID', 'SelectByRay2']) {
  check(`${name} 被认成选择类`, SELECTION_MEMBERS.test(name), name)
}
for (const name of ['FeatureExtrusion3', 'ClearSelection2', 'InsertSketch']) {
  check(`${name} 不被认成选择类`, !SELECTION_MEMBERS.test(name), name)
}

// 7) 参数不是数组时不炸
check('args 不是数组时原样返回', convertLengthArgs('SelectByID2', null, 'mm').converted === 0, null)

// 8) 换算表本身要克制：只登记确定是坐标的成员
check('换算表里没有建模类成员', !('FeatureExtrusion3' in LENGTH_ARGS), Object.keys(LENGTH_ARGS))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  · ${failure}`)
  process.exit(1)
}
