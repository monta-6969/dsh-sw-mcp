// 任务图：依赖顺序、资源串行、失败传播、环检测、取消。
import { TaskGraph, graphFromDefinition } from '../server/tasks.mjs'

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`)
  } else {
    failures.push(`${name}: ${JSON.stringify(detail)}`)
    console.log(`FAIL  ${name}\n      ${JSON.stringify(detail)}`)
  }
}

// 1) 线性依赖：顺序执行
{
  const graph = new TaskGraph()
  graph.add({ id: 'a', op: 'build' }).add({ id: 'b', op: 'measure', deps: ['a'] }).add({ id: 'c', op: 'save', deps: ['b'] })
  const order = []
  const out = await graph.run({ executor: async (node) => { order.push(node.id); return node.id } })
  check('线性任务按依赖顺序执行', order.join(',') === 'a,b,c', order)
  check('线性任务全部成功', out.ok === true && out.counts.succeeded === 3, out.counts)
}

// 2) 菱形依赖 + 不同资源：真正并行
{
  const graph = new TaskGraph({ concurrency: 2 })
  graph.add({ id: 'root', op: 'open' })
    .add({ id: 'left', op: 'build', deps: ['root'], resource: 'doc-left' })
    .add({ id: 'right', op: 'build', deps: ['root'], resource: 'doc-right' })
    .add({ id: 'join', op: 'assemble', deps: ['left', 'right'] })
  let active = 0
  let peak = 0
  const out = await graph.run({
    executor: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active--
    },
  })
  check('不同资源的兄弟任务并行', peak === 2, { peak })
  check('菱形图全部成功', out.ok === true, out.counts)
  check('join 在左右都完成后才跑', out.tasks.find((t) => t.id === 'join').state === 'succeeded', out.tasks)
}

// 3) 同一资源：串行
{
  const graph = new TaskGraph({ concurrency: 4 })
  graph.add({ id: 'a', op: 'edit', resource: 'doc-1' })
    .add({ id: 'b', op: 'edit', resource: 'doc-1' })
    .add({ id: 'c', op: 'edit', resource: 'doc-2' })
  let active = 0
  let peak = 0
  let sameDocPeak = 0
  let sameDocActive = 0
  await graph.run({
    executor: async (node) => {
      active++
      peak = Math.max(peak, active)
      if (node.resource === 'doc-1') {
        sameDocActive++
        sameDocPeak = Math.max(sameDocPeak, sameDocActive)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      active--
      if (node.resource === 'doc-1') sameDocActive--
    },
  })
  check('同一文档的编辑串行', sameDocPeak === 1, { sameDocPeak })
  check('不同文档仍可并行', peak === 2, { peak })
}

// 4) 失败传播：依赖被跳过，无关分支继续
{
  const graph = new TaskGraph()
  graph.add({ id: 'a', op: 'build' })
    .add({ id: 'b', op: 'boom', deps: ['a'] })
    .add({ id: 'c', op: 'after', deps: ['b'] })
    .add({ id: 'd', op: 'side', deps: ['a'] })
  const out = await graph.run({
    executor: async (node) => {
      if (node.op === 'boom') throw Object.assign(new Error('boom'), { code: 'FAKE_FAIL' })
    },
  })
  check('失败节点记录错误码', out.tasks.find((t) => t.id === 'b').error?.code === 'FAKE_FAIL', out.tasks)
  check('依赖失败的节点被跳过', out.tasks.find((t) => t.id === 'c').state === 'skipped', out.tasks)
  check('无关分支照常完成', out.tasks.find((t) => t.id === 'd').state === 'succeeded', out.tasks)
  check('有失败时整体不 ok', out.ok === false, out.counts)
}

// 5) 环与悬空依赖在开跑前拒绝
{
  const graph = new TaskGraph()
  graph.add({ id: 'a', op: 'x', deps: ['b'] }).add({ id: 'b', op: 'y', deps: ['a'] })
  let error = null
  try { graph.validate() } catch (caught) { error = caught }
  check('环被拒绝', error?.code === 'TASK_CYCLE', error?.code)

  let unknown = null
  try { graphFromDefinition({ tasks: [{ id: 'a', op: 'x', deps: ['nope'] }] }) } catch (caught) { unknown = caught }
  check('悬空依赖被拒绝', unknown?.code === 'TASK_UNKNOWN_DEP', unknown?.code)
}

// 6) 取消：未开始的任务标 skipped
{
  const graph = new TaskGraph()
  graph.add({ id: 'a', op: 'x' }).add({ id: 'b', op: 'y', deps: ['a'] })
  const controller = new AbortController()
  controller.abort()
  const out = await graph.run({ signal: controller.signal, executor: async () => {} })
  check('取消后没有任务算成功', out.cancelled === true && out.counts.succeeded === undefined, out.counts)
  check('取消的任务被标 skipped', out.tasks.every((t) => t.state === 'skipped'), out.tasks)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
