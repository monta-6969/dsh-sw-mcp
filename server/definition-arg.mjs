// definition 参数的容错（纯函数，离线可测）。
//
// 现场：model action="build" 的 definition 在 MCP 传输层偶尔变成 JSON 字符串
// （客户端或模型把对象序列化了一次），到了 normalizeDesign 就只剩字符下标，
// 于是报 BAD_ARGUMENT「设计定义缺少 features 数组」—— 模型以为定义写错了，
// 实际只是传输形态变了。返修件反复卡在这里。
//
// 规则：只还原「以 { 开头的字符串」；解析失败把原字符串原样交回去，让原来的
// 校验/报错照旧发生（不把「定义真的不合法」伪装成「JSON 解析失败」）。

export function coerceDefinition(input) {
  if (typeof input !== 'string') return input
  const text = input.trim().replace(/^\uFEFF+/, '')
  if (text.startsWith('{') !== true) return input
  try {
    return JSON.parse(text)
  } catch {
    return input
  }
}
