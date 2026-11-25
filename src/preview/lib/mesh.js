/**
 * S3DM 网格容器的读/写，STL（binary + ASCII）/OBJ 解析，缓存路径，以及 STEP 三角化子进程。
 *
 * S3DM 布局（小端）：
 *   0      : 'S3DM'               4 字节 ASCII 魔数
 *   4      : u32 headerJsonLength
 *   8      : headerJson（UTF-8，尾部可能补空格，使 8+len 正好 4 字节对齐）
 *   8+len  : 各 buffer 依次拼接，每个 buffer 相对数据区起点的偏移 4 字节对齐（补 0x00）
 * header.buffers[].offset 相对于「buffer 数据区」起点（= 8 + headerJsonLength），不是文件起点。
 * 客户端 parseS3DM 直接拿 8+len 当数据区起点、并要求绝对偏移 %4===0，所以 JSON 要补空格对齐。
 *
 * 本模块不依赖 DSH 运行时，可被 node 直接 import 做离线测试。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const S3DM_MAGIC = 'S3DM';
/** v2：新增可选 buffers（faceEdge）+ header.precision/faceEdgeCount；v1 数据仍然可读（缺字段即降级）。 */
export const S3DM_VERSION = 2;
export const S3DM_VERSION_MIN = 1;

/** 各 buffer 默认分量数；调用方可用 {array, components} 或 header.buffers[].components 覆盖。 */
export const DEFAULT_COMPONENTS = Object.freeze({
  position: 3,
  normal: 3,
  index: 3,
  faceOfTriangle: 1,
  edgePosition: 3,
  edgeSegment: 2,
  faceEdge: 2,
});

const CTOR_BY_TYPE = {
  f32: Float32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8: Uint8Array,
  i32: Int32Array,
  f64: Float64Array,
};
const TYPE_BY_CTOR = new Map(Object.entries(CTOR_BY_TYPE).map(([type, ctor]) => [ctor, type]));

/** 文件名，用于 python 探测与错误提示。 */
export const STEP_SCRIPT_NAME = 'step_mesh.py';
export const STEP_SCRIPT_PATH = fileURLToPath(new URL('./step_mesh.py', import.meta.url));

// --------------------------------------------------------------------------- 三角化精度常量
//
// 这三个值**必须与 lib/step_mesh.py 顶部的常量逐位一致**：
//   DEFAULT_DEFLECTION_MM          ↔ step_mesh.py: DEFAULT_DEFLECTION = 0.08
//   DEFAULT_ANGULAR_DEFLECTION_RAD ↔ step_mesh.py: ANGULAR_DEFLECTION = 0.12
//   DEFAULT_CREASE_ANGLE_DEG       ↔ step_mesh.py: CREASE_ANGLE_DEG = 35.0
// test/host.mjs 的 `testPythonConstants()` 会**直接读 step_mesh.py 源码文本**解析这些常量
// 做等式断言（不跑 python、不需要 OCP），两边一旦漂移测试就红 —— 这是为了防
// 「宿主默认值悄悄覆盖 python 侧调优」这类曾经真实发生过的缺陷（JS 旧默认 0.2 盖掉 0.08）。
//
// 它们在这里的用途有三个：(a) 缓存键的默认档位；(b) stepMeshArgs 的默认参数；(c) 供测试断言。
//
// ⚠ 传参行为（别被「默认值」这个词误导）：stepMeshArgs **总是显式传** --deflection /
// --angular-deflection / --crease-angle，即使调用方一个都没给 —— 它用的是这三个 JS 常量，
// **不是**靠「不传就让 python 用默认值」。所以 python 侧的常量在这里**只是文档与断言标的**，
// 运行时的实际数值永远是 JS 这一份；两边的一致性完全由上面那条源码解析断言保证。
// （详细理由见 stepMeshArgs 的注释：缓存键必须与实际生成的网格逐位一致。）

/** 弦高挠度（mm）。必须与 step_mesh.py 的 DEFAULT_DEFLECTION 一致。 */
export const DEFAULT_DEFLECTION_MM = 0.08;
/** 角向挠度（弧度）。必须与 step_mesh.py 的 ANGULAR_DEFLECTION 一致。 */
export const DEFAULT_ANGULAR_DEFLECTION_RAD = 0.12;
/** 折痕角阈值（度）。必须与 step_mesh.py 的 CREASE_ANGLE_DEG 一致。 */
export const DEFAULT_CREASE_ANGLE_DEG = 35.0;

// --------------------------------------------------------------------------- python 候选（跨机）
//
// 跨机原则：**源码里不写任何一台机器的绝对路径**。所有 venv 候选都由这四种可移植来源推导：
//   ① 环境变量 SW_3D_PREVIEW_PYTHON（显式指定，优先级最高）
//   ② sw-mcp 的数据根（SW_MCP_DATA → %LOCALAPPDATA%\sw-mcp）下的 .venv
//   ③ DSH profile 的 package.json 里以 link:/file: 指向的 sw-mcp 仓库（预设 @local/dsh-sw-preset）下的 .venv
//   ④ 插件目录同级的 sw-mcp\\.venv（有人把插件与 sw-mcp 平级放）
// 最后再退回启动器与 PATH：py -3 → python → python3。
// 每条候选即使失败也会在 probePython() 的 error 里留下可读原因。

/** 插件目录（lib/ 的上一层），用于探测同级 sw-mcp。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

/** 清掉首尾空白与成对引号（用户从资源管理器「复制路径」会带引号）。 */
function cleanPath(value) {
  return String(value ?? '').trim().replace(/^"+|"+$/g, '');
}

/** 调用方可注入 env / homedir（离线测试用）；默认取真实进程值，生产行为不变。 */
function envFrom(options) {
  return options && options.env ? options.env : process.env;
}

function homeFrom(options) {
  return cleanPath(options && options.homedir) || homedir();
}

/** 归一化路径用作去重键：尽量取真实路径（大小写 / 软链 / 8.3 短名都归一到同一个）。 */
function pathKey(value) {
  const base = cleanPath(value);
  if (!base) return '';
  let resolved = path.resolve(base);
  try {
    resolved = realpathSync(resolved);
  } catch {
    /* 路径还不存在（例如假 repo）：就用 resolve 结果 */
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** venv 里的解释器路径（Windows: .venv\\Scripts\\python.exe；其他平台: .venv/bin/python）。 */
function venvPythonIn(root) {
  const base = cleanPath(root);
  if (!base) return '';
  return process.platform === 'win32'
    ? path.join(base, '.venv', 'Scripts', 'python.exe')
    : path.join(base, '.venv', 'bin', 'python');
}

/** sw-mcp 数据根：SW_MCP_DATA 优先，否则 %LOCALAPPDATA%\sw-mcp（与 lib/paths.js 的 swMcpDataRoot 同语义）。 */
export function swMcpDataRootForPython(options) {
  const env = envFrom(options);
  const override = cleanPath(env.SW_MCP_DATA);
  if (override) return override;
  const base =
    env.LOCALAPPDATA || env.LOCAL_APP_DATA || path.join(homeFrom(options), 'AppData', 'Local');
  return path.join(base, 'sw-mcp');
}

/**
 * 候选 DSH profile 目录，按优先级有序回退。
 *
 * 为什么不能只看 DSH_PROFILE_DIR：这个变量是 dsh-shell-env 注入给 **shell 工具子进程** 的，
 * DSH **宿主进程自己没有**它（宿主里 pythonCandidates() 看不到），于是宿主侧就只剩
 * py -3 / python / python3 —— 明明装了 venv 的机器也报 PYTHON_MISSING。
 * 所以改成「越精确的来源越靠前 + 最后枚举 profiles 目录兜底」：
 *   ① DSH_PROFILE_DIR                              （最精确，来自 shell 子进程）
 *   ② DSH_HOME + DSH_PROFILE → <home>/profiles/<p>
 *   ③ os.homedir() + DSH_PROFILE → ~/.dsh/profiles/<p>
 *   ④ 枚举 os.homedir()/.dsh/profiles/*（每个含 package.json 的子目录；**必须遍历全部**，
 *      因为通常只有一两个 profile 真的 link 了 sw-mcp，其余 12 个都没有）
 * 目录名排序只为让输出稳定；正确性不依赖顺序 —— 下游是对所有 link:/file: 依赖逐个检查 .venv。
 *
 * @returns {{dirs:string[], error:string|null}} error 记录读 profiles 目录时的真实错误，供提示区分「没有 venv」与「读不到 profile」。
 */
function dshProfileDirs(options) {
  const env = envFrom(options);
  const home = homeFrom(options);
  const profile = cleanPath(env.DSH_PROFILE);
  const dirs = [];
  const seen = new Set();
  let error = null;
  const push = (value) => {
    const dir = cleanPath(value);
    if (!dir) return;
    const key = pathKey(dir);
    if (!key || seen.has(key)) return;
    seen.add(key);
    dirs.push(dir);
  };

  // ① 最精确：shell 子进程里的真实 profile 目录
  push(env.DSH_PROFILE_DIR);

  // ② DSH_HOME + DSH_PROFILE
  const dshHome = cleanPath(env.DSH_HOME);
  if (dshHome && profile) push(path.join(dshHome, 'profiles', profile));

  // ③ ~/.dsh/profiles/<DSH_PROFILE>
  const profilesRoot = path.join(home, '.dsh', 'profiles');
  if (profile) push(path.join(profilesRoot, profile));

  // ④ 枚举 ~/.dsh/profiles/* —— 停在一个 profile 上是错的，必须全部看一遍
  let entries = [];
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true });
  } catch (cause) {
    // 目录不存在（ENOENT）是正常情况；其它错误（EACCES/EPERM…）要能被提示说清楚
    if (cause && cause.code !== 'ENOENT') {
      error = `读不到 ${profilesRoot}（${cause.code || cause.message}）`;
    }
    entries = [];
  }
  const discovered = [];
  for (const entry of entries) {
    let isDir = false;
    try {
      isDir = entry.isDirectory() || (entry.isSymbolicLink() && existsSync(path.join(profilesRoot, entry.name, 'package.json')));
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const dir = path.join(profilesRoot, entry.name);
    if (!existsSync(path.join(dir, 'package.json'))) continue;
    discovered.push(dir);
  }
  // 稳定顺序：按目录名排序（不排序也能对，只是日志/候选顺序会随文件系统变化）
  discovered.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en'));
  for (const dir of discovered) push(dir);

  return { dirs, error };
}

/**
 * 从 DSH profile 的 package.json 反推 sw-mcp 仓库根（只读，失败就返回空数组）。
 * profile 里 sw-mcp 预设是 `"@local/dsh-sw-preset": "link:D:/…/sw-mcp"` 这种写法，
 * 所以把 link:/file: 依赖指向的目录里「有 .venv」的挑出来即可 —— 不依赖某个固定盘符。
 *
 * @param {object} [options] 可测试性注入口：{ env, homedir }；缺省取真实进程环境。
 * @returns {{roots:string[], profiles:number, errors:string[]}}
 *   profiles: 成功读到 package.json 的 profile 数；errors: 读失败的详细原因（用于提示区分情况）。
 */
function swMcpRepoRootsDetailed(options) {
  const { dirs, error: enumError } = dshProfileDirs(options);
  const roots = [];
  const usedKeys = new Set();
  const errors = [];
  if (enumError) errors.push(enumError);
  let readable = 0;
  for (const profileDir of dirs) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      readable += 1;
    } catch (cause) {
      // 只有「目录确实存在」时才算读失败；目录不存在（回退链里常见的空档）不算错
      if (existsSync(profileDir)) {
        errors.push(`${profileDir}（${(cause && cause.code) || (cause && cause.message) || '读取失败'}）`);
      }
      continue;
    }
    const deps = manifest && typeof manifest.dependencies === 'object' && manifest.dependencies ? manifest.dependencies : {};
    const entries = Object.entries(deps);
    // 名字像 sw-mcp/sw-preset 的排前面：同一 profile 里通常还有别的 link: 插件（没有 .venv）
    entries.sort((a, b) => {
      const rank = (key) => (/sw-mcp|sw-preset|sw_3d|sw3d/i.test(key) ? 0 : 1);
      return rank(a[0]) - rank(b[0]);
    });
    for (const [, spec] of entries) {
      const text = cleanPath(spec);
      const match = /^(?:link|file):(.+)$/i.exec(text);
      if (!match) continue;
      const repo = path.resolve(profileDir, match[1]);
      const python = venvPythonIn(repo);
      if (!python || !existsSync(python)) continue;
      const key = pathKey(repo);
      if (!key || usedKeys.has(key)) continue;
      usedKeys.add(key);
      roots.push(repo);
    }
  }
  return { roots, profiles: readable, errors };
}

/** 只要仓库根（兼容旧调用点）。 */
function swMcpRepoRoots(options) {
  return swMcpRepoRootsDetailed(options).roots;
}

/** 插件目录同级 / 上一级目录里的 sw-mcp（只返回真的存在解释器的）。 */
function siblingSwMcpRoots() {
  const roots = [];
  const parents = [path.dirname(PLUGIN_DIR), path.dirname(path.dirname(PLUGIN_DIR))];
  for (const parent of parents) {
    const repo = path.join(parent, 'sw-mcp');
    const python = venvPythonIn(repo);
    if (python && existsSync(python)) roots.push(repo);
  }
  return roots;
}

/**
 * python 候选（顺序即优先级）。每条 {command, prefixArgs, label, origin}。
 * origin：env | venv-data | venv-repo | venv-sibling | launcher | path
 *
 * @param {object} [options] 可测试性注入口：{ env, homedir }；缺省取真实进程环境（生产行为不变）。
 */
export function pythonCandidates(options) {
  const env = envFrom(options);
  const candidates = [];
  const seen = new Set();
  const add = (command, prefixArgs, label, origin) => {
    const cmd = origin === 'env' ? cleanPath(command) : String(command ?? '');
    if (!cmd) return;
    const key = `${cmd.toLowerCase()}|${(prefixArgs || []).join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ command: cmd, prefixArgs: prefixArgs || [], label: label || cmd, origin });
  };

  // ① 显式指定（最高优先级；测试「指错路径要看得到后续候选」就靠这一步）
  const fromEnv = cleanPath(env.SW_3D_PREVIEW_PYTHON);
  add(fromEnv, [], `SW_3D_PREVIEW_PYTHON=${fromEnv}`, 'env');

  // ② sw-mcp 数据根下的 venv
  const dataRoot = swMcpDataRootForPython(options);
  const dataPython = venvPythonIn(dataRoot);
  if (dataPython && existsSync(dataPython)) add(dataPython, [], `sw-mcp 数据根 venv（${dataPython}）`, 'venv-data');

  // ③ DSH profile 里 link 的 sw-mcp 仓库 venv（profile 目录走有序回退链，宿主进程里没有 DSH_PROFILE_DIR 也能找到）
  for (const repo of swMcpRepoRoots(options)) {
    const python = venvPythonIn(repo);
    add(python, [], `sw-mcp 仓库 venv（${python}）`, 'venv-repo');
  }

  // ④ 插件同级的 sw-mcp
  for (const repo of siblingSwMcpRoots()) {
    const python = venvPythonIn(repo);
    add(python, [], `同级 sw-mcp venv（${python}）`, 'venv-sibling');
  }

  // ⑤⑥⑦ 启动器 / PATH
  if (process.platform === 'win32') add('py', ['-3'], 'py -3', 'launcher');
  add('python', [], 'python', 'path');
  add('python3', [], 'python3', 'path');

  return candidates;
}

/**
 * profile 扫描的诊断信息（给提示文案区分「profile 里没有 .venv」和「profile 读不到」）。
 * @returns {{profiles:number, roots:string[], errors:string[]}}
 */
export function pythonCandidateDiagnostics(options) {
  return swMcpRepoRootsDetailed(options);
}

/**
 * 向后兼容的导出名（保留：可能被插件外部的脚本引用）。
 * 语义从「写死的本机路径」改成「本机推导出的首选 venv 解释器」；推不出来就是空串。
 */
export const RECOMMENDED_PYTHON = (() => {
  const derived = pythonCandidates().find(
    (candidate) => candidate.origin === 'venv-data' || candidate.origin === 'venv-repo' || candidate.origin === 'venv-sibling',
  );
  return derived ? derived.command : '';
})();

/**
 * 模块加载时扫一次 profile，只为让 PYTHON_MISSING_HINT 说清楚失败在哪一层
 * （读 profile 抛错 ≠ profile 里没有 venv）。任何异常都吞掉，绝不 because-of-提示 影响探测。
 */
const PROFILE_SCAN = (() => {
  try {
    const scan = pythonCandidateDiagnostics();
    return { profiles: scan.profiles, errors: scan.errors };
  } catch (error) {
    return { profiles: 0, errors: [String((error && error.message) || error || '未知错误')] };
  }
})();

/** 末尾那句按实际扫描结果分支：(a) profile 里没有 .venv；(b) profile 读不到/出错。 */
function pythonDerivationNote() {
  if (RECOMMENDED_PYTHON) return `。本机推导出的首选：${RECOMMENDED_PYTHON}`;
  if (PROFILE_SCAN.errors.length) {
    return `。推导失败原因：读 DSH profile 时出错 —— ${PROFILE_SCAN.errors.slice(0, 3).join('；')}（这是权限/IO 问题，不是没有装 venv）。`;
  }
  if (PROFILE_SCAN.profiles === 0) {
    return '。本机没找到任何 DSH profile 的 package.json，因此无从推导 sw-mcp venv。';
  }
  return `。已检查 ${PROFILE_SCAN.profiles} 个 DSH profile，其中没有任何 link:/file: 依赖指向带 .venv 的 sw-mcp（情况 a：profile 里没有 venv，不是读不到）。`;
}

/** 跨机可读的缺 python 指引（不假设任何一台机器的路径）。 */
export const PYTHON_MISSING_HINT =
  '这台机器上没找到能 import OCP 的 Python。处理顺序：' +
  '① 先用 `python -c "import OCP"`（或 `py -3 -c "import OCP"`）确认哪个 python 装了 OCP；' +
  '② 有就把它的绝对路径写进环境变量 SW_3D_PREVIEW_PYTHON 后重开 DSH；' +
  '③ 没有就装：`py -3 -m pip install cadquery-ocp`（或 `python -m pip install cadquery-ocp`）。' +
  '候选顺序：SW_3D_PREVIEW_PYTHON → sw-mcp 的 .venv（%LOCALAPPDATA%\\sw-mcp 或 DSH profile 里 link 的 sw-mcp 仓库）→ ' +
  '插件同级的 sw-mcp → py -3 → python / python3' +
  pythonDerivationNote();

// --------------------------------------------------------------------------- 工具

export function align4(value) {
  const n = Math.max(0, Math.trunc(Number(value) || 0));
  return (n + 3) & ~3;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value ?? '');
}

/** sha1(字符串按 UTF-8，Buffer 按原字节) → 40 位小写 hex。 */
export function sha1(value) {
  const hash = createHash('sha1');
  hash.update(Buffer.isBuffer(value) || value instanceof Uint8Array ? toBuffer(value) : String(value ?? ''), 'utf8');
  return hash.digest('hex');
}

// --------------------------------------------------------------------------- 缓存与标注目录

/** %LOCALAPPDATA%\sw-3d-preview（拿不到 LOCALAPPDATA 时退回 homedir\AppData\Local）。 */
export function localDataRoot() {
  const base =
    process.env.LOCALAPPDATA || process.env.LOCAL_APP_DATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(base, 'sw-3d-preview');
}

export function cacheDir() {
  return path.join(localDataRoot(), 'cache');
}

export function annotationDir() {
  return path.join(localDataRoot(), 'annotations');
}

/** 标注交接单目录：%LOCALAPPDATA%\sw-3d-preview\handoff。 */
export function handoffDir() {
  return path.join(localDataRoot(), 'handoff');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 缓存键：sha1(绝对路径小写 | mtimeMs | bytes | deflection | angularDeflection | creaseAngle | maxTriangles)。
 * 路径按小写归一，符合 Windows 大小写不敏感的事实；四个精度参数用调用方已归一过的数字，
 * 保证同一文件的不同精度档不会互相踩缓存。
 *
 * ⚠ 为什么 angularDeflection / creaseAngle 也必须进键（曾经漏掉的真实缺陷）：
 * 老版本只把 deflection + maxTriangles 拼进键。只改 python 侧的角向挠度/折痕角时，
 * 宿主算出的键一字不变 → 用户升级插件后打开**同一个 STEP** 直接命中旧网格，
 * 画质毫无变化，看起来像「改了没生效」。把它们纳入键之后，参数一变键就变，旧缓存自然失效。
 *
 * ⚠ 另一条「老缓存自然失效」的路径（已确认）：deflection 默认值 0.2 → 0.08 本身就改变了键，
 * 因为键里含 deflection 的原始字符串。所以哪怕调用方完全不传任何参数，
 * 升级后第一次打开也会 miss 并重建（见 test/host.mjs 的 1b 断言「缓存键含 deflection +
 * maxTriangles」：它断言 base 键与 deflection 减半后的键必然不同，即 deflection 确实进键）。
 */
export function cacheKeyFor({
  path: filePath = '',
  mtimeMs = 0,
  bytes = 0,
  deflection = DEFAULT_DEFLECTION_MM,
  angularDeflection = DEFAULT_ANGULAR_DEFLECTION_RAD,
  creaseAngle = DEFAULT_CREASE_ANGLE_DEG,
  maxTriangles = 0,
} = {}) {
  const normalizedPath = path.resolve(String(filePath)).toLowerCase();
  const key = sha1(
    `${normalizedPath}|${Math.round(Number(mtimeMs) || 0)}|${Math.round(Number(bytes) || 0)}|${deflection}|` +
      `ang:${angularDeflection}|crease:${creaseAngle}|` +
      `max:${Math.round(Number(maxTriangles) || 0)}`,
  );
  return key;
}

/** 缓存文件路径：<LOCALAPPDATA>\sw-3d-preview\cache\<sha1>.s3dm（目录按需创建）。 */
export function cachePathFor(options = {}) {
  ensureDir(cacheDir());
  return path.join(cacheDir(), `${cacheKeyFor(options)}.s3dm`);
}

// --------------------------------------------------------------------------- S3DM 写

function normalizeBuffer(name, raw, header) {
  let array = raw;
  let typeHint;
  let componentsHint;
  let bufferName = name;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !ArrayBuffer.isView(raw) && 'array' in raw) {
    array = raw.array;
    typeHint = raw.type;
    componentsHint = raw.components;
    if (typeof raw.name === 'string' && raw.name) bufferName = raw.name;
  }
  const declared = Array.isArray(header.buffers)
    ? header.buffers.find((entry) => entry && entry.name === bufferName)
    : undefined;
  const type = typeHint || (declared && declared.type) || TYPE_BY_CTOR.get(array && array.constructor) || 'f32';
  const ctor = CTOR_BY_TYPE[type];
  if (!ctor) throw new TypeError(`S3DM 不支持的 buffer 类型：${type}（${bufferName}）`);
  if (!array || typeof array.length !== 'number') {
    throw new TypeError(`S3DM buffer 必须是 TypedArray 或普通数组：${bufferName}`);
  }
  const typed = ArrayBuffer.isView(array) && array instanceof ctor ? array : new ctor(array);
  const components = Number(
    componentsHint ?? (declared && declared.components) ?? DEFAULT_COMPONENTS[bufferName] ?? 1,
  );
  if (!Number.isInteger(components) || components < 1) {
    throw new TypeError(`S3DM buffer components 非法：${bufferName}=${components}`);
  }
  if (typed.length % components !== 0) {
    throw new RangeError(
      `S3DM buffer ${bufferName} 的元素数 ${typed.length} 不是 components ${components} 的整数倍`,
    );
  }
  return {
    name: bufferName,
    type,
    components,
    count: typed.length / components,
    byteLength: typed.byteLength,
    buffer: Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength),
  };
}

/**
 * 写 S3DM：header 里除 buffers 外的字段原样保留，buffers 由入参重算（含 offset）。
 * @param {object} header S3DM header JSON（version/units/format/source/bbox/各 count/faces/edges/warnings）
 * @param {Record<string, TypedArray | {array: ArrayLike<number>, type?: string, components?: number}>} buffers
 * @returns {Buffer}
 */
export function writeS3dm(header, buffers = {}) {
  const base = header && typeof header === 'object' ? header : {};
  const entries = [];
  for (const [name, raw] of Object.entries(buffers || {})) entries.push(normalizeBuffer(name, raw, base));

  let cursor = 0;
  for (const entry of entries) {
    entry.offset = cursor;
    cursor += entry.byteLength;
    cursor += (4 - (cursor % 4)) % 4;
  }

  const outHeader = {
    ...base,
    buffers: entries.map(({ name, type, components, count, offset }) => ({
      name,
      type,
      components,
      count,
      offset,
    })),
  };
  const json = Buffer.from(JSON.stringify(outHeader), 'utf8');
  // 客户端（client.js 的 parseS3DM）把 base = 8 + headerJsonLength 直接当数据区起点，
  // 并且要求每个 buffer 的绝对偏移 % 4 === 0。为了让「8+len」既是数据区起点又是 4 的倍数，
  // 这里用空格把 header JSON 补到 4 字节对齐（JSON 尾部空白合法）。
  const pad = (4 - ((8 + json.length) % 4)) % 4;
  const headerJson = pad === 0 ? json : Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const sectionStart = 8 + headerJson.length;
  const out = Buffer.alloc(sectionStart + cursor);
  out.write(S3DM_MAGIC, 0, 'latin1');
  out.writeUInt32LE(headerJson.length, 4);
  headerJson.copy(out, 8);
  for (const entry of entries) entry.buffer.copy(out, sectionStart + entry.offset);
  return out;
}

// --------------------------------------------------------------------------- S3DM 读

export function readS3dmHeader(input) {
  const buf = toBuffer(input);
  if (buf.length < 8) throw new Error('S3DM 数据太短（不足 8 字节）');
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== S3DM_MAGIC) throw new Error(`S3DM 魔数不匹配：${JSON.stringify(magic)}`);
  const jsonLength = buf.readUInt32LE(4);
  if (jsonLength < 2 || 8 + jsonLength > buf.length) throw new Error(`S3DM 头长度非法：${jsonLength}`);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + jsonLength));
  return { header, jsonLength, sectionStart: align4(8 + jsonLength) };
}

/**
 * 读 S3DM：返回 header 与 name → TypedArray 的视图（对齐时零拷贝，不对齐时复制）。
 * 越界与未知类型都抛错，不返回半截数据。
 */
export function readS3dm(input) {
  const buf = toBuffer(input);
  const { header, jsonLength, sectionStart } = readS3dmHeader(buf);
  const buffers = {};
  for (const descriptor of Array.isArray(header.buffers) ? header.buffers : []) {
    const ctor = CTOR_BY_TYPE[descriptor && descriptor.type];
    if (!ctor) throw new Error(`S3DM 不认识的 buffer 类型：${descriptor && descriptor.type}`);
    const components = Math.max(1, Math.trunc(Number(descriptor.components) || 1));
    const count = Math.max(0, Math.trunc(Number(descriptor.count) || 0));
    const elements = count * components;
    const byteLength = elements * ctor.BYTES_PER_ELEMENT;
    const start = sectionStart + Math.max(0, Math.trunc(Number(descriptor.offset) || 0));
    const end = start + byteLength;
    if (end > buf.length) throw new Error(`S3DM buffer 越界：${descriptor.name}（需要 ${byteLength} 字节）`);
    if (start % ctor.BYTES_PER_ELEMENT === 0) {
      buffers[descriptor.name] = new ctor(buf.buffer, buf.byteOffset + start, elements);
    } else {
      const copy = Buffer.alloc(byteLength);
      buf.copy(copy, 0, start, end);
      buffers[descriptor.name] = new ctor(copy.buffer, copy.byteOffset, elements);
    }
  }
  return { header, buffers, jsonLength, sectionStart, byteLength: buf.length };
}

// --------------------------------------------------------------------------- 小几何工具

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cross(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function magnitude(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalizeVector(v) {
  const length = magnitude(v);
  if (!(length > 1e-12)) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * 由三角面表生成非索引化顶点/法向 + 面分组。
 * tris: [{ points: [[x,y,z]×3], normal: [x,y,z]|null }]
 * 面分组规则：法向（3 位小数）相同的三角形归为同一面 —— STL 没有 B-rep 面编号，按平面归并能让预览
 * 的点选面得到「同一平面区域」这种有意义的结果，而不是几万个单三角形面。
 */
function buildTriangles(tris) {
  const positions = [];
  const normals = [];
  const indices = [];
  const faceOf = [];
  const buckets = new Map();
  const faces = [];

  for (const tri of tris) {
    const [a, b, c] = tri.points;
    const computed = cross(a, b, c);
    const area = magnitude(computed) / 2;
    const unit = normalizeVector(tri.normal || [0, 0, 0]) || normalizeVector(computed) || [0, 0, 1];
    const key = `${roundTo(unit[0], 3)},${roundTo(unit[1], 3)},${roundTo(unit[2], 3)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { index: faces.length, area: 0, normal: unit, centroid: [0, 0, 0] };
      buckets.set(key, bucket);
      faces.push(bucket);
    }
    bucket.area += area;
    bucket.centroid[0] += (area * (a[0] + b[0] + c[0])) / 3;
    bucket.centroid[1] += (area * (a[1] + b[1] + c[1])) / 3;
    bucket.centroid[2] += (area * (a[2] + b[2] + c[2])) / 3;

    const base = positions.length / 3;
    for (const point of tri.points) positions.push(point[0], point[1], point[2]);
    for (let i = 0; i < 3; i += 1) normals.push(unit[0], unit[1], unit[2]);
    indices.push(base, base + 1, base + 2);
    faceOf.push(bucket.index);
  }

  const faceEntries = faces.map((bucket) => {
    const area = bucket.area > 0 ? bucket.area : 0;
    const divisor = area > 0 ? area : 1;
    return {
      index: bucket.index,
      kind: 'plane',
      areaMm2: roundTo(area, 4),
      normal: bucket.normal.map((value) => roundTo(value, 6)),
      point: [
        roundTo(bucket.centroid[0] / divisor, 4),
        roundTo(bucket.centroid[1] / divisor, 4),
        roundTo(bucket.centroid[2] / divisor, 4),
      ],
      radiusMm: null,
    };
  });

  return {
    vertices: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    triangles: faceOf.map((face, index) => ({ face, index })),
    faces: faceEntries,
  };
}

// --------------------------------------------------------------------------- STL

function looksBinaryStl(buf) {
  if (buf.length < 84) return false;
  const declaredCount = buf.readUInt32LE(80);
  const expected = 84 + declaredCount * 50;
  if (expected === buf.length) return true;
  const head = buf.toString('latin1', 0, Math.min(5, buf.length)).toLowerCase();
  // 有些导出器把 binary STL 的头写成 "solid ..."；此时长度校验更可信。
  if (head !== 'solid') return true;
  if (declaredCount > 0 && expected <= buf.length && buf.length - expected < 50) return true;
  return false;
}

function parseBinaryStl(buf) {
  const declaredCount = buf.readUInt32LE(80);
  const room = Math.floor((buf.length - 84) / 50);
  const count = Math.min(declaredCount, room);
  const tris = [];
  for (let i = 0; i < count; i += 1) {
    const base = 84 + i * 50;
    const normal = [buf.readFloatLE(base), buf.readFloatLE(base + 4), buf.readFloatLE(base + 8)];
    const points = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = base + 12 + corner * 12;
      points.push([buf.readFloatLE(offset), buf.readFloatLE(offset + 4), buf.readFloatLE(offset + 8)]);
    }
    tris.push({ points, normal: magnitude(normal) > 0 ? normal : null });
  }
  return buildTriangles(tris);
}

function parseAsciiStl(buf) {
  const text = buf.toString('utf8');
  const tris = [];
  let currentNormal = null;
  let pending = [];
  const flush = () => {
    if (pending.length >= 3) {
      for (let i = 1; i + 1 < pending.length; i += 1) {
        tris.push({ points: [pending[0], pending[i], pending[i + 1]], normal: currentNormal });
      }
    }
    pending = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('facet')) {
      flush();
      const parts = line.split(/\s+/);
      currentNormal = [num(parts[2]), num(parts[3]), num(parts[4])];
      if (magnitude(currentNormal) === 0) currentNormal = null;
    } else if (lower.startsWith('vertex')) {
      const parts = line.split(/\s+/);
      pending.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (lower.startsWith('endfacet')) {
      flush();
      currentNormal = null;
    }
  }
  flush();
  return buildTriangles(tris);
}

/**
 * 解析 STL（binary 与 ASCII 都支持）。
 * binary 判定：文件长度与 84 + 50*n 一致（含 50 字节容差），或前 5 字节不是 "solid"。
 * @returns {{vertices: Float32Array, normals: Float32Array, indices: Uint32Array, triangles: {face:number}[], faces: object[]}}
 */
export function parseStl(bytes) {
  const buf = toBuffer(bytes);
  if (buf.length === 0) throw new Error('STL 内容为空');
  const binary = looksBinaryStl(buf);
  return binary ? parseBinaryStl(buf) : parseAsciiStl(buf);
}

// --------------------------------------------------------------------------- OBJ

function parseObjCorner(token) {
  const parts = String(token).split('/');
  const vertexIndex = Number.parseInt(parts[0], 10);
  const normalIndex = parts.length >= 3 && parts[2] !== '' ? Number.parseInt(parts[2], 10) : null;
  return { vertexIndex, normalIndex };
}

function resolveIndex(rawIndex, list) {
  if (!Number.isInteger(rawIndex) || rawIndex === 0) return null;
  const index = rawIndex > 0 ? rawIndex - 1 : list.length + rawIndex;
  return list[index] || null;
}

/**
 * 解析 OBJ 文本：v / vn / f（支持 a、a/b、a//c、a/b/c 与负索引、多边形扇形三角化）。
 * 每条 `f` 语句 = 一个面（n 边形拆成 n-2 个三角形共用同一个 face 序号）。
 */
export function parseObj(text) {
  const source = String(text ?? '');
  const positions = [];
  const normals = [];
  const tris = [];
  const faces = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v' && parts.length >= 4) {
      positions.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (tag === 'vn' && parts.length >= 4) {
      normals.push([num(parts[1]), num(parts[2]), num(parts[3])]);
    } else if (tag === 'f' && parts.length >= 4) {
      const corners = parts.slice(1).map(parseObjCorner);
      const resolved = corners.map((corner) => ({
        point: resolveIndex(corner.vertexIndex, positions),
        normal: corner.normalIndex === null ? null : resolveIndex(corner.normalIndex, normals),
      }));
      if (resolved.some((corner) => !corner.point)) continue;

      const faceIndex = faces.length;
      const bucket = { index: faceIndex, area: 0, normal: [0, 0, 0], centroid: [0, 0, 0], weight: 0 };
      for (let i = 1; i + 1 < resolved.length; i += 1) {
        const a = resolved[0];
        const b = resolved[i];
        const c = resolved[i + 1];
        const computed = cross(a.point, b.point, c.point);
        const area = magnitude(computed) / 2;
        const unit = normalizeVector(computed) || [0, 0, 1];
        bucket.area += area;
        bucket.normal[0] += computed[0];
        bucket.normal[1] += computed[1];
        bucket.normal[2] += computed[2];
        bucket.centroid[0] += (area * (a.point[0] + b.point[0] + c.point[0])) / 3;
        bucket.centroid[1] += (area * (a.point[1] + b.point[1] + c.point[1])) / 3;
        bucket.centroid[2] += (area * (a.point[2] + b.point[2] + c.point[2])) / 3;
        bucket.weight += area;
        tris.push({ points: [a.point, b.point, c.point], normal: unit, face: faceIndex, corners: [a, b, c] });
      }
      faces.push(bucket);
    }
  }

  const vertexOut = [];
  const normalOut = [];
  const indexOut = [];
  const faceOf = [];
  for (const tri of tris) {
    const base = vertexOut.length / 3;
    tri.points.forEach((point, corner) => {
      vertexOut.push(point[0], point[1], point[2]);
      const explicit = tri.corners[corner].normal && normalizeVector(tri.corners[corner].normal);
      const unit = explicit || tri.normal;
      normalOut.push(unit[0], unit[1], unit[2]);
    });
    indexOut.push(base, base + 1, base + 2);
    faceOf.push(tri.face);
  }

  return {
    vertices: Float32Array.from(vertexOut),
    normals: Float32Array.from(normalOut),
    indices: Uint32Array.from(indexOut),
    triangles: faceOf.map((face, index) => ({ face, index })),
    faces: faces.map((bucket) => {
      const weight = bucket.weight > 0 ? bucket.weight : 1;
      const unit = normalizeVector(bucket.normal) || [0, 0, 1];
      return {
        index: bucket.index,
        kind: 'plane',
        areaMm2: roundTo(bucket.area, 4),
        normal: unit.map((value) => roundTo(value, 6)),
        point: bucket.centroid.map((value) => roundTo(value / weight, 4)),
        radiusMm: null,
      };
    }),
  };
}

// --------------------------------------------------------------------------- python 探测与 STEP 三角化

function collectLines(stream, sink) {
  stream?.setEncoding?.('utf8');
  stream?.on?.('data', (chunk) => sink.push(String(chunk)));
}

function tailText(text, limit = 800) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

const PROBE_CODE = [
  'import sys',
  "print('python=' + sys.version.split()[0])",
  'try:',
  '    import OCP',
  "    print('ocp=' + str(OCP.__version__))",
  'except Exception as error:',
  "    print('ocpError=' + type(error).__name__ + ': ' + str(error)[:200])",
].join('\n');

async function runProcess(command, args, { timeoutMs = 15000 } = {}) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, spawnError: error, stdout: '', stderr: '', timedOut: false, exitCode: null });
      return;
    }
    const out = [];
    const err = [];
    collectLines(child.stdout, out);
    collectLines(child.stderr, err);
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...payload, stdout: out.join(''), stderr: err.join(''), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, exitCode: null, spawnError: null });
    }, timeoutMs);
    child.on('error', (error) => finish({ ok: false, spawnError: error, exitCode: null }));
    child.on('close', (code) => finish({ ok: code === 0, exitCode: code, spawnError: null }));
  });
}

let probeMemo = { value: null, at: 0, inflight: null };

/**
 * 探测一个可用的 python（能 import OCP 才算成功）。
 * @returns {Promise<{path:string, ok:boolean, ocp:boolean, version:string, ocpVersion:string, error:string|null}>}
 */
export async function probePython({ timeoutMs = 15000 } = {}) {
  const failures = [];
  for (const candidate of pythonCandidates()) {
    const result = await runProcess(candidate.command, [...candidate.prefixArgs, '-c', PROBE_CODE], { timeoutMs });
    if (result.spawnError) {
      failures.push(`${candidate.label}: ${result.spawnError.code || result.spawnError.message}`);
      continue;
    }
    const stdout = result.stdout || '';
    const pythonVersion = /python=(\S+)/.exec(stdout)?.[1] || '';
    const ocpVersion = /ocp=(\S+)/.exec(stdout)?.[1] || '';
    const ocpError = /ocpError=(.*)/.exec(stdout)?.[1] || null;
    if (result.ok && pythonVersion && !ocpError) {
      return {
        path: [candidate.command, ...candidate.prefixArgs].join(' '),
        ok: true,
        ocp: true,
        version: pythonVersion,
        ocpVersion,
        error: null,
        candidate,
      };
    }
    failures.push(`${candidate.label}: ${ocpError || (result.timedOut ? '探测超时' : tailText(result.stderr, 200) || '不可用')}`);
  }
  return {
    path: pythonCandidates()[0]?.label || '',
    ok: false,
    ocp: false,
    version: '',
    ocpVersion: '',
    error: failures.join(' | ') || '没有可用的 python',
    candidate: null,
  };
}

/** 带缓存的探测：成功缓存 5 分钟，失败缓存 30 秒，并发调用共享同一个 inflight。 */
export async function probePythonCached(options = {}) {
  const now = Date.now();
  if (probeMemo.value && now - probeMemo.at < (probeMemo.value.ok ? 300000 : 30000)) return probeMemo.value;
  if (probeMemo.inflight) return probeMemo.inflight;
  probeMemo.inflight = probePython(options).then(
    (value) => {
      probeMemo = { value, at: Date.now(), inflight: null };
      return value;
    },
    (error) => {
      probeMemo.inflight = null;
      throw error;
    },
  );
  return probeMemo.inflight;
}

/**
 * 组装传给 lib/step_mesh.py 的参数表（纯函数，不启动进程 —— 测试可以直接断言它）。
 *
 * 设计选择：**三个精度参数总是显式传**（而不是「只在调用方给了才传」）。理由：
 *  1) 缓存键里记录的精度必须与实际生成的网格**逐位一致**。若只在显式传入时才写进命令行，
 *     一旦 step_mesh.py 的默认值将来被调整而 JS 常量没跟上，缓存键仍按旧默认算 → 又会出现
 *     「键没变、网格变了」或反过来「键变了、网格没变」的错配。
 *     总是传，则 python 收到的就是 key 里记的那一组数，两者不可能漂移。
 *  2) 数值上等价：常量值就等于 python 的默认值，所以「总是传」不改变任何默认行为。
 *  3) 单点权威靠 test 保证：test/host.mjs 的 `testPythonConstants()` 会直接解析
 *     step_mesh.py 源码里的 DEFAULT_DEFLECTION / ANGULAR_DEFLECTION / CREASE_ANGLE_DEG
 *     与本文件的 JS 常量做等式断言（纯文本，不跑 python），并断言本函数**总是**输出
 *     这三个 flag。谁改一边不改另一边，先红在那里 —— 而不是靠「谁不传谁负责」这种隐式约定。
 *
 * maxTriangles 仍只在 > 0 时才传：0 在 python 侧表示「用 MAX_TRIANGLES」，必须留空。
 *
 * @returns {string[]} 完整 argv（已含 python 前缀参数与脚本路径）
 */
export function stepMeshArgs({
  input,
  output,
  deflection = DEFAULT_DEFLECTION_MM,
  angularDeflection = DEFAULT_ANGULAR_DEFLECTION_RAD,
  creaseAngle = DEFAULT_CREASE_ANGLE_DEG,
  maxTriangles = 0,
  prefixArgs = [],
  scriptPath = STEP_SCRIPT_PATH,
} = {}) {
  const args = [
    ...(Array.isArray(prefixArgs) ? prefixArgs : []),
    String(scriptPath),
    '--in',
    String(input),
    '--out',
    String(output),
    '--deflection',
    String(deflection),
    '--angular-deflection',
    String(angularDeflection),
    '--crease-angle',
    String(creaseAngle),
  ];
  const cap = Math.round(Number(maxTriangles) || 0);
  if (cap > 0) args.push('--max-triangles', String(cap));
  return args;
}

/**
 * 调 lib/step_mesh.py 把 STEP 三角化成 S3DM 写到 output。
 *
 * 精度参数（三个都可选，默认值与 step_mesh.py 的常量一致，见文件顶部注释）：
 * @param {number} [options.deflection]          弦高挠度 mm → --deflection（默认 0.08）
 * @param {number} [options.angularDeflection]   角向挠度 rad → --angular-deflection（默认 0.12）
 * @param {number} [options.creaseAngle]         折痕角阈值度 → --crease-angle（默认 35）
 * @param {number} [options.maxTriangles]        三角形上限（精度档）；透传给 --max-triangles
 * @returns {Promise<{ok:boolean, code?:string, summary?:object, stderrTail:string, exitCode:number|null, timedOut:boolean}>}
 */
export async function runStepMesh({
  python,
  input,
  output,
  deflection = DEFAULT_DEFLECTION_MM,
  angularDeflection = DEFAULT_ANGULAR_DEFLECTION_RAD,
  creaseAngle = DEFAULT_CREASE_ANGLE_DEG,
  maxTriangles = 0,
  timeoutMs = 120000,
} = {}) {
  const candidate = python?.candidate || (python?.command ? { command: python.command, prefixArgs: python.prefixArgs || [] } : null);
  if (!candidate) return { ok: false, code: 'PYTHON_MISSING', stderrTail: '', exitCode: null, timedOut: false };
  const args = stepMeshArgs({
    input,
    output,
    deflection,
    angularDeflection,
    creaseAngle,
    maxTriangles,
    prefixArgs: candidate.prefixArgs || [],
  });
  const result = await runProcess(candidate.command, args, { timeoutMs });
  const stderrTail = tailText(result.stderr, 800);
  if (result.spawnError) {
    return { ok: false, code: 'PYTHON_SPAWN_FAILED', stderrTail: tailText(result.spawnError.message, 400), exitCode: null, timedOut: false };
  }
  if (result.timedOut) return { ok: false, code: 'TIMEOUT', stderrTail: stderrTail || 'step_mesh.py 超过超时时间', exitCode: null, timedOut: true };
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let summary = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      summary = JSON.parse(lines[i]);
      break;
    } catch {
      /* 继续往前找 */
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      code: summary?.code || 'STEP_MESH_FAILED',
      summary,
      stderrTail: stderrTail || `step_mesh.py 退出码 ${result.exitCode}`,
      exitCode: result.exitCode,
      timedOut: false,
    };
  }
  if (!summary) return { ok: false, code: 'STEP_MESH_BAD_OUTPUT', stderrTail: stderrTail || '没有 JSON 摘要', exitCode: result.exitCode, timedOut: false };
  return { ok: true, summary, stderrTail, exitCode: result.exitCode, timedOut: false };
}
