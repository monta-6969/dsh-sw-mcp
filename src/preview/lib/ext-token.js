/**
 * 外部进程 Bearer token 旁路：配置归一化、定长比较、scope 判定。
 *
 * 为什么需要这条旁路：
 *   /sw3d/* 的信任栅栏是 ctx.connection.requestRejection(req)，它只认浏览器那套
 *   cookie/来源凭据。外部进程（Codex CLI、curl、Node 脚本）拿不到也不该伪造这种
 *   cookie，于是它们的请求全部被 401 挡掉。这里提供一个**配置驱动**的旁路：
 *   只有显式配置了 extToken 才生效，默认（extToken 为空）行为与没有这段代码逐字节一致。
 *
 * 安全约定（改代码前先读这四条）：
 *   1) 默认关闭：extToken 为空 / 太短 / 类型不对 → enabled === false，不产生任何新放行；
 *   2) 定长比较：候选值与配置值各自 sha256 成 32 字节再 timingSafeEqual，
 *      长度不同的输入也会走满一次比较，不靠提前 return 泄漏 token 长度；
 *   3) 只比 token，不对比对结果做任何区分：调用方对外统一回原来的 401/403，
 *      「token 存在但错了」「scope 不够」「压根没带 token」在响应上不可区分；
 *   4) 本模块不打印、不返回 token 明文；日志里只允许出现方法、路径、scope 和失败原因。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** token 长度下限：低于这个长度视为配置错误（fail-closed，当作没配）。 */
export const MIN_TOKEN_LENGTH = 16;

/** 目前支持的 scope。read = 只读；write = 会改状态/会产出用户可见文件。 */
export const SCOPES = Object.freeze(['read', 'write']);

/** 配了 token 但没配（或配错）scopes 时的默认值：最小权限，只给只读。 */
export const DEFAULT_SCOPES = Object.freeze(['read']);

const CONFIG_KEYS = Object.freeze(['extToken', 'extTokenScopes']);

/** 定长摘要：把任意长度的字符串压成 32 字节，再做 timingSafeEqual。 */
function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/**
 * 定长恒时比较候选 token 与配置 token。
 *
 * `timingSafeEqual` 在两侧长度不同时会**抛异常**（RangeError），而直接比长度又会把
 * 「token 有多长」变成可测的侧信道。所以两边先各自 sha256 成定长摘要：
 * 长度不同也照常比较，不抛异常，也不因长度差异提前返回。
 *
 * @param {unknown} candidate 请求头里带来的 token
 * @param {unknown} expected 配置里的 extToken
 * @returns {boolean} 两者完全相同才为 true
 */
export function tokensEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  // 空值不参与比较：配置为空时 enabled 本来就 false，这里再兜一层，
  // 避免「空串 == 空串」这种意外命中把外部访问打开。
  if (candidate === '' || expected === '') return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * 从请求头里取 Bearer token。
 *
 * 只认 `Authorization: Bearer <token>`；scheme 大小写不敏感（RFC 6750 允许），
 * 前后多余空白容忍。重复的 Authorization 头在 Node 里会合成数组或带逗号的串，
 * 这类歧义请求一律当作没有 token（fail-closed）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null} 取到就返回 token，取不到返回 null
 */
export function readBearerToken(req) {
  const headers = req && req.headers ? req.headers : {};
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  if (raw.includes(',')) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(raw);
  return match ? match[1] : null;
}

/**
 * 归一化 scope 列表：只保留已知名字、去重、只读兜底。
 *
 * @param {unknown} value 配置里的 extTokenScopes
 * @returns {{scopes: string[], problems: string[]}} 归一化结果 + 需要写进日志的问题描述
 */
export function normalizeScopes(value) {
  const problems = [];
  let list;
  if (value === undefined || value === null) {
    list = [...DEFAULT_SCOPES];
  } else if (typeof value === 'string') {
    // 容忍手写单个字符串（extTokenScopes: read），免得一个笔误把整行插件配错
    list = [value];
  } else if (Array.isArray(value)) {
    list = value;
  } else {
    problems.push('extTokenScopes 不是字符串或字符串数组；已按默认 read 处理');
    list = [...DEFAULT_SCOPES];
  }

  const kept = new Set();
  for (const item of list) {
    if (typeof item !== 'string') {
      problems.push(`extTokenScopes 里有非字符串项（${typeof item}），已忽略`);
      continue;
    }
    const name = item.trim().toLowerCase();
    if (!name) continue;
    if (!SCOPES.includes(name)) {
      problems.push(`extTokenScopes 里有未知 scope「${item}」，已忽略（支持：${SCOPES.join(' / ')}）`);
      continue;
    }
    kept.add(name);
  }

  if (kept.size === 0) {
    for (const name of DEFAULT_SCOPES) kept.add(name);
    problems.push('extTokenScopes 没有留下任何有效值；已按默认 read 处理');
  }
  return { scopes: [...kept].sort(), problems };
}

/**
 * 把插件配置解析成「外部访问决策」。
 *
 * 这里的每个异常分支都是 fail-closed：宁可外部访问关掉，也不要因为配置笔误
 * 打开一个没有 scope 限制的入口。
 *
 * @param {unknown} config 插件 row 的 config（可能 undefined）
 * @returns {{enabled: boolean, token: string, scopes: readonly string[], problems: string[]}}
 */
export function resolveExternalAuth(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const problems = [];

  let rawToken = source.extToken;
  if (rawToken !== undefined && rawToken !== null && typeof rawToken !== 'string') {
    problems.push('extToken 不是字符串；已按未配置处理（外部访问关闭）');
    rawToken = '';
  }
  const trimmed = typeof rawToken === 'string' ? rawToken.trim() : '';
  let token = trimmed;
  if (trimmed !== '' && trimmed.length < MIN_TOKEN_LENGTH) {
    problems.push(
      `extToken 只有 ${trimmed.length} 个字符，短于下限 ${MIN_TOKEN_LENGTH}；已按未配置处理（外部访问关闭）`,
    );
    token = '';
  }
  // P3：含逗号或空白的 token 能「配置成功」但**永远无法使用** ——
  // readBearerToken 会拒绝带逗号的 Authorization 头（防重复头合并的歧义），
  // 而 token 内部的空白会让 /^\s*bearer\s+(\S+)\s*$/i 只能吃下前半截。
  // 这里**不改变启用与否**（安全逻辑保持原样），只补一条可诊断的原因，
  // 免得用户对着「token 配了却一直 401」排查半天。
  if (token !== '' && /[,\s]/.test(token)) {
    problems.push(
      'extToken 含逗号或空白字符；这类 token 能生效但客户端永远带不上来（Authorization 头会被当作歧义头拒绝）。请改用不含空格与逗号的随机串，如 node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  const normalized = normalizeScopes(source.extTokenScopes);
  problems.push(...normalized.problems);

  const enabled = token !== '';
  return {
    enabled,
    token,
    // 未启用时保持空集合：任何 scope 判定都不可能命中，等价于把请求当匿名
    scopes: enabled ? Object.freeze(normalized.scopes) : Object.freeze([]),
    problems,
  };
}

/**
 * 校验并归一化插件配置（standard-schema 形状，cordis 直接调 `~standard.validate`）。
 *
 * 刻意**不抛错**：插件行是用户 profile 的一部分，一个类型笔误不该让整行插件
 * 激活失败、在设置页里变成错误行。所有异常都归一到「外部访问关闭」，原因由
 * {@link resolveExternalAuth} 的 problems 交给调用方写日志。
 *
 * @param {unknown} value 原始配置
 * @returns {{value: {extToken: string, extTokenScopes: string[]}}}
 */
export function validateExtConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const extToken = typeof source.extToken === 'string' ? source.extToken.trim() : '';
  const { scopes } = normalizeScopes(source.extTokenScopes);
  return { value: { extToken, extTokenScopes: scopes } };
}

/**
 * 插件 `Config` 定义。
 *
 * 用 standard-schema（`~standard`）而不是 `@deepseek-ai/schemastery`：
 * 本包离线可测（`node test/ext-token.mjs` 不装任何依赖），而 schemastery 只在
 * DSH 安装里能解析到；引用裸包名会让离线测试连 index.js 都 import 不进来。
 * 代价是 DSH 的 Config 检视接口会把本插件标成 `unsupported`（不投影 JSON Schema），
 * 但激活期的默认值/归一化照旧生效。
 */
export function createExtConfigSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-sw-3d-preview',
      validate: validateExtConfig,
    },
  };
}

/** 配置里允许出现的键（文档/自检用）。 */
export const EXT_CONFIG_KEYS = CONFIG_KEYS;
