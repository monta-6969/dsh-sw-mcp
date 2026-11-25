/**
 * 路径与格式解析：把预览面板传来的路径解析成一个「可以拿去三角化的网格源」。
 *
 * 关键事实：
 * - .sldprt/.sldasm 是 SolidWorks 容器，本插件不解析；约定用 STEP 预览。
 *   一个 STEP 都找不到时，如果 sw-mcp 里有这个设计的草图记录，就降级成 `meshSource:'sketch-only'`
 *   （只画草图轮廓，没有实体），而不是硬失败 —— 只有草图、零实体的零件永远导不出 STEP。
 * - .step/.stp 走 python + OCCT；.stl/.obj 由 node 直接解析。
 * - 预览面板传来的 path **可能是相对路径**（DSH 的 session 资源地址里就是相对工作区的），
 *   宿主必须能补全，否则真实场景直接不可用。补全来源见 lib/paths.js。
 * - 失败一律返回 200 + { ok:false, code, message, hint }，code 只用约定集合。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  baseNameOf,
  findDesignIdForPath,
  findPathByBaseName,
  isAbsoluteFsPath,
  rememberResolvedPath,
} from './paths.js';
import { readSketchesForPath } from './sketches.js';

export const MESH_EXTENSIONS = Object.freeze(['.step', '.stp', '.stl', '.obj']);
export const NATIVE_EXTENSIONS = Object.freeze(['.sldprt', '.sldasm']);
export const ALLOWED_EXTENSIONS = Object.freeze([...MESH_EXTENSIONS, ...NATIVE_EXTENSIONS]);
export const STEP_EXTENSIONS = Object.freeze(['.step', '.stp']);

// 三角化默认精度：**不再在本文件写死数字**，统一从 lib/mesh.js 取，
// 让「缓存键默认值 = runStepMesh 默认值 = step_mesh.py 默认值」只有一处来源。
// （这三个值必须与 step_mesh.py 顶部常量一致，lib/mesh.js 里有等式说明与测试。）
export {
  DEFAULT_ANGULAR_DEFLECTION_RAD,
  DEFAULT_CREASE_ANGLE_DEG,
  DEFAULT_DEFLECTION_MM,
} from './mesh.js';
import {
  DEFAULT_ANGULAR_DEFLECTION_RAD as ANGULAR_DEFAULT_RAD,
  DEFAULT_CREASE_ANGLE_DEG as CREASE_DEFAULT_DEG,
  DEFAULT_DEFLECTION_MM as DEFLECTION_DEFAULT_MM,
} from './mesh.js';

export const DEFAULT_DEFLECTION = DEFLECTION_DEFAULT_MM;
export const MIN_DEFLECTION = 0.01;
export const MAX_DEFLECTION = 50;

export const DEFAULT_ANGULAR_DEFLECTION = ANGULAR_DEFAULT_RAD;
/** 与 step_mesh.py 的夹取一致：angular = clamp(0.01, π)。 */
export const MIN_ANGULAR_DEFLECTION = 0.01;
export const MAX_ANGULAR_DEFLECTION = Math.PI;

export const DEFAULT_CREASE_ANGLE = CREASE_DEFAULT_DEG;
/** 与 step_mesh.py 的夹取一致：0 = 纯平面着色，180 = 全平滑。 */
export const MIN_CREASE_ANGLE = 0;
export const MAX_CREASE_ANGLE = 180;

export const DEFAULT_MAX_TRIANGLES = 300000;
export const MIN_MAX_TRIANGLES = 2000;
export const MAX_MAX_TRIANGLES = 5000000;

/** 同名 STEP 比原生件旧超过这个时间，就提示「STEP 可能已过期」。 */
export const STALE_STEP_THRESHOLD_MS = 60000;

const NO_MESH_SOURCE_HINT =
  '让 agent 执行 deliver kind="step" designId=<设计ID> 导出 STEP，或把同名 .step 放到该目录再重试';

/** fs.stat 的静默版本：不存在/无权限都返回 null，不抛错。 */
export async function statSafe(target) {
  if (typeof target !== 'string' || !target) return null;
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

export function isAbsoluteFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32767 && !value.includes('\0') && path.isAbsolute(value) && isAbsoluteFsPath(value);
}

export function extensionOf(value) {
  return typeof value === 'string' ? path.extname(value).toLowerCase() : '';
}

export function isAllowedExtension(value) {
  return ALLOWED_EXTENSIONS.includes(extensionOf(value));
}

export function isNativeExtension(value) {
  return NATIVE_EXTENSIONS.includes(extensionOf(value));
}

function fail(code, message, hint, extra) {
  return { ok: false, code, message, hint, ...(extra || {}) };
}

function roundMs(value) {
  return Math.round(Number(value) || 0);
}

function fmtTime(ms) {
  const value = roundMs(ms);
  if (!value) return '未知';
  try {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch {
    return '未知';
  }
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// --------------------------------------------------------------------------- 同名 / 兜底 STEP 查找

function baseNameLower(value) {
  return path.basename(value, path.extname(value)).toLowerCase();
}

/**
 * 在同目录里找同名 .step/.stp（扩展名与文件名都比较小写，优先 .step，其次 .stp）。
 * @returns {Promise<string|null>} 命中的绝对路径
 */
export async function findSiblingStep(requestedPath) {
  const dir = path.dirname(requestedPath);
  const baseName = baseNameLower(requestedPath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const entryExt = extensionOf(entry.name);
    if (!STEP_EXTENSIONS.includes(entryExt)) continue;
    if (baseNameLower(entry.name) !== baseName) continue;
    matches.push({
      fullName: entry.name,
      rank: entryExt === '.step' ? 0 : 1,
      exactCase: entry.name === `${path.basename(requestedPath, path.extname(requestedPath))}${entryExt}` ? 0 : 1,
    });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.rank - b.rank || a.exactCase - b.exactCase || a.fullName.localeCompare(b.fullName));
  return path.join(dir, matches[0].fullName);
}

/** 文件名相似度 0..1：二元组 Dice 系数 + 公共前缀比例，各权重 0.6 / 0.4。 */
export function nameSimilarity(a, b) {
  const left = String(a || '').toLowerCase().replace(/\.[^.]+$/, '');
  const right = String(b || '').toLowerCase().replace(/\.[^.]+$/, '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  const bigrams = (text) => {
    const out = new Map();
    for (let i = 0; i + 1 < text.length; i += 1) {
      const key = text.slice(i, i + 2);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  };
  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of leftGrams.values()) leftTotal += count;
  for (const count of rightGrams.values()) rightTotal += count;
  for (const [key, count] of leftGrams) overlap += Math.min(count, rightGrams.get(key) || 0);
  const dice = leftTotal + rightTotal > 0 ? (2 * overlap) / (leftTotal + rightTotal) : 0;
  let prefix = 0;
  const span = Math.min(left.length, right.length);
  while (prefix < span && left[prefix] === right[prefix]) prefix += 1;
  return Math.round((0.6 * dice + 0.4 * (prefix / Math.max(left.length, right.length))) * 1000) / 1000;
}

/**
 * 第二级兜底：同目录里任意名字的 .step/.stp。
 * 规则：文件名相似度 >= 0.25 才有资格；先看「相似（>=0.5）」的组，再按修改时间新→旧挑。
 * 返回 null 表示没有像样的候选（宁可不猜，也不要给用户一个完全无关的模型）。
 * @returns {Promise<{path:string, name:string, similarity:number, mtimeMs:number, bytes:number}|null>}
 */
export async function findFallbackStep(requestedPath) {
  const dir = path.dirname(requestedPath);
  const targetName = path.basename(requestedPath);
  const selfPath = path.resolve(requestedPath);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const entryExt = extensionOf(entry.name);
    if (!STEP_EXTENSIONS.includes(entryExt)) continue;
    const fullPath = path.join(dir, entry.name);
    if (path.resolve(fullPath).toLowerCase() === selfPath.toLowerCase()) continue;
    const similarity = nameSimilarity(entry.name, targetName);
    if (similarity < 0.25) continue;
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    candidates.push({
      path: fullPath,
      name: entry.name,
      similarity,
      mtimeMs: roundMs(stat.mtimeMs),
      bytes: stat.size,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const groupA = a.similarity >= 0.5 ? 1 : 0;
    const groupB = b.similarity >= 0.5 ? 1 : 0;
    if (groupA !== groupB) return groupB - groupA;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.similarity - a.similarity;
  });
  return candidates[0];
}

// --------------------------------------------------------------------------- 路径补全

/**
 * 把相对路径补成绝对路径：先看 `base`（客户端给的会话工作区根），再按文件名查
 * sw-mcp 的 project 记录与最近成功解析索引。
 * @returns {Promise<{ok:true, path:string, completed:boolean, designId:string, source:string, notes:string[]}
 *                  |{ok:false, code:string, message:string, hint:string, received:string}>}
 */
export async function completeFilePath(requestedPath, { base = '' } = {}) {
  const received = typeof requestedPath === 'string' ? requestedPath.trim() : '';
  if (!received) {
    return fail('NOT_FOUND', '没有给出文件路径', '把预览文件的绝对路径通过 ?path= 传进来');
  }
  if (isAbsoluteFilePath(received)) {
    return { ok: true, path: path.resolve(received), completed: false, designId: '', source: 'absolute', notes: [] };
  }
  const notes = [];
  const baseName = baseNameOf(received);

  // 1) 客户端给了工作区根：直接用（随后由调用方 stat 校验）
  if (base && isAbsoluteFilePath(base)) {
    const joined = path.resolve(base, received);
    const stat = await statSafe(joined);
    if (stat && stat.isFile()) {
      notes.push(`已用会话工作区根补全路径：${base}`);
      return {
        ok: true,
        path: joined,
        completed: true,
        designId: await findDesignIdForPath(joined),
        source: 'workspace',
        notes,
      };
    }
  }

  // 2) 按文件名在 project 记录 / 最近索引里找真实存在的绝对路径
  const found = await findPathByBaseName(received);
  if (found) {
    notes.push(
      found.source === 'project'
        ? `已从 sw-mcp 的 project 记录补全为绝对路径（designId=${found.designId || '未知'}）`
        : '已从本插件最近解析索引补全为绝对路径',
    );
    return {
      ok: true,
      path: found.absolutePath,
      completed: true,
      designId: found.designId || '',
      source: found.source,
      notes,
    };
  }

  return fail(
    'NOT_FOUND',
    `需要绝对路径，收到的是：${received}` +
      (baseName && baseName !== received ? `（文件名 ${baseName} 也没在 project 记录/最近索引里找到）` : '（也没在 project 记录/最近索引里找到同名文件）'),
    '期望形态：C:\\work\\part.STEP（盘符 + 目录 + 文件名）。可以先用资源面板确认文件的完整路径，' +
      '或让 agent 用 deliver kind="step" 导出到已知目录后再打开',
    { received, expected: 'C:\\work\\part.STEP', completed: false },
  );
}

// --------------------------------------------------------------------------- 解析入口

/**
 * 解析一个请求路径。
 * 成功：
 *   { ok:true, path, format, meshSource:'step'|'sibling-step'|'fallback-step'|'stl'|'obj'|'sketch-only',
 *     sibling:string|null, bytes, mtimeMs, hints:string[], designId:string, completed:boolean }
 *   `sketch-only`（新增）：原生件但没有任何 STEP，而 sw-mcp 里能读到草图 —— 只能画草图轮廓，
 *   没有实体；多了 `deliver`（可直接复制的下一步）与 `sketch:{designId,sketchCount,polylineCount,url,solidBodies}`。
 * 失败：{ ok:false, code:'NO_MESH_SOURCE'|'UNSUPPORTED'|'NOT_FOUND', message, hint, received? }
 */
export async function resolveSource(requestedPath, options = {}) {
  const completed = await completeFilePath(requestedPath, options);
  if (!completed.ok) return completed;

  const normalized = completed.path;
  const extension = extensionOf(normalized);
  const stat = await statSafe(normalized);
  if (!stat || !stat.isFile()) {
    const richer =
      completed.completed || !isAbsoluteFilePath(String(requestedPath || ''))
        ? '路径补全后仍然找不到该文件（可能已被移动或删除）'
        : '文件不存在或不是文件';
    return fail(
      'NOT_FOUND',
      `${richer}：${normalized}`,
      '确认文件还在本机磁盘上，且预览的面板指向的是文件而不是目录',
      { received: String(requestedPath ?? '') },
    );
  }
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return fail(
      'UNSUPPORTED',
      `暂不支持 ${extension || '(无扩展名)'} 文件：${path.basename(normalized)}`,
      '支持 .step/.stp/.stl/.obj；SolidWorks 原生件 .sldprt/.sldasm 需要同目录同名 .step/.stp',
    );
  }

  const designId = completed.designId || (await findDesignIdForPath(normalized));
  const notes = completed.notes ? completed.notes.slice() : [];

  if (NATIVE_EXTENSIONS.includes(extension)) {
    const nativeLabel = extension.slice(1).toUpperCase();
    const sibling = await findSiblingStep(normalized);
    if (sibling) {
      const siblingStat = await statSafe(sibling);
      if (!siblingStat || !siblingStat.isFile()) {
        return fail('NO_MESH_SOURCE', `同名 STEP 存在但读不到：${sibling}`, NO_MESH_SOURCE_HINT);
      }
      const hints = [
        `${nativeLabel} 本身不能解析，已使用同名 ${path.extname(sibling).toUpperCase()}`,
        '模型改动后请重新导出 STEP，缓存按 STEP 的体积与修改时间失效',
        ...notes,
      ];
      appendStaleHint(hints, stat, siblingStat, nativeLabel, path.basename(sibling));
      void rememberResolvedPath(normalized);
      return {
        ok: true,
        path: normalized,
        format: extension.slice(1),
        meshSource: 'sibling-step',
        sibling,
        bytes: siblingStat.size,
        mtimeMs: roundMs(siblingStat.mtimeMs),
        hints,
        designId,
        completed: !!completed.completed,
      };
    }

    // 第二级兜底：同目录里名字最像、修改时间最新的 STEP（不启动 SOLIDWORKS）
    const fallback = await findFallbackStep(normalized);
    if (fallback) {
      const hints = [
        `未找到同名 STEP，使用最接近的 ${fallback.name}（文件名相似度 ${Math.round(fallback.similarity * 100)}%）`,
        '这是按文件名相似度 + 修改时间猜的，模型可能不是同一个零件：确认无误后让 agent 导出正式的同名 STEP',
        `候选 STEP 修改时间：${fmtTime(fallback.mtimeMs)}，大小 ${fmtBytes(fallback.bytes)}`,
        ...notes,
      ];
      appendStaleHint(hints, stat, { mtimeMs: fallback.mtimeMs }, nativeLabel, fallback.name);
      void rememberResolvedPath(normalized);
      return {
        ok: true,
        path: normalized,
        format: extension.slice(1),
        meshSource: 'fallback-step',
        sibling: fallback.path,
        bytes: fallback.bytes,
        mtimeMs: fallback.mtimeMs,
        hints,
        designId,
        completed: !!completed.completed,
        fallback: { name: fallback.name, similarity: fallback.similarity },
      };
    }

    // 第四级：没有任何 STEP。先看能不能降级成「草图视图」——只有草图、零实体的零件
    // （例如 fracture-section-01）**永远导不出 STEP 几何**，对它推「执行 deliver 导出 STEP」
    // 是死循环。所以只要 sw-mcp 里有这个设计的草图记录，就返回 ok:true + meshSource:'sketch-only'，
    // 让客户端把草图轮廓画出来，而不是甩一块红字失败卡。
    const sketchOnly = await probeSketchOnly(normalized, designId, nativeLabel, stat);
    if (sketchOnly) {
      void rememberResolvedPath(normalized);
      return sketchOnly;
    }

    // 第五级：连草图都读不到 —— 给出可直接复制的下一步 + 原生件的时间/大小，便于 agent 判断
    const deliver = `deliver kind="step" designId=${designId || '<设计ID>'}`;
    return fail(
      'NO_MESH_SOURCE',
      `${nativeLabel} 是 SolidWorks 原生格式，无法直接解析；同目录也没有可用的 .step/.stp`,
      `${NO_MESH_SOURCE_HINT}\n可直接复制的下一步：${deliver}\n` +
        `或把同名 .step 放到：${path.dirname(normalized)}\n` +
        `${path.basename(normalized)} 现状：修改时间 ${fmtTime(roundMs(stat.mtimeMs))}，大小 ${fmtBytes(stat.size)}`,
      {
        designId,
        deliver,
        directory: path.dirname(normalized),
        native: {
          path: normalized,
          bytes: stat.size,
          mtimeMs: roundMs(stat.mtimeMs),
          updatedAt: fmtTime(roundMs(stat.mtimeMs)),
        },
      },
    );
  }

  const format = extension === '.stp' ? 'step' : extension.slice(1);
  void rememberResolvedPath(normalized);
  return {
    ok: true,
    path: normalized,
    format,
    meshSource: format,
    sibling: null,
    bytes: stat.size,
    mtimeMs: roundMs(stat.mtimeMs),
    hints: format === 'stl' || format === 'obj'
      ? ['STL/OBJ 没有 B-rep 面/边拓扑，面按平面法向归并，线框为空', ...notes]
      : notes,
    designId,
    completed: !!completed.completed,
  };
}

/**
 * 原生件没有任何 STEP 时的最后一级：能不能降级成「草图视图」？
 *
 * 判据：sw-mcp 的 project 记录里能读出**至少一条有坐标的草图折线**。
 * 读不出来（没有 designId / 没有 project json / features 里没有 sketch / 只有参数没有坐标）
 * 一律返回 null，交回给调用方走原来的 NO_MESH_SOURCE 失败 —— 这样既有测试断言的失败路径
 * 与文案一个字节都不变，只是「有草图可看」的真实场景不再硬失败。
 *
 * @returns {Promise<null|{ok:true, path:string, format:string, meshSource:'sketch-only', ...}>}
 */
async function probeSketchOnly(normalized, designId, nativeLabel, stat) {
  let payload;
  try {
    payload = await readSketchesForPath(normalized);
  } catch {
    return null;
  }
  if (!payload || payload.ok !== true) return null;
  const sketches = Array.isArray(payload.sketches) ? payload.sketches : [];
  const drawable = sketches.filter(
    (item) => item && Array.isArray(item.polylines) && item.polylines.some((line) => line && Array.isArray(line.points) && line.points.length >= 2),
  );
  if (drawable.length === 0) return null;

  let polylineCount = 0;
  for (const sketch of drawable) polylineCount += sketch.polylines.length;
  const resolvedDesignId = payload.designId || designId || '';
  const deliver = `deliver kind="step" designId=${resolvedDesignId || '<设计ID>'}`;
  const nativeBytes = roundMs(stat && stat.size);
  const nativeMtime = roundMs(stat && stat.mtimeMs);

  const hints = [
    `${nativeLabel} 是 SolidWorks 原生格式，本身不能解析；同目录也没有可用的 .step/.stp`,
    `当前先把草图轮廓画给你看：${drawable.length} 条草图 / ${polylineCount} 条折线（来源 sw-mcp 设计记录 ${resolvedDesignId || '未知'}）`,
    '草图视图里没有实体：面/边/点拾取、剖切、封盖、三点取样都不可用，只能看轮廓与尺寸',
  ];
  if (!shapesIntoBody(payload)) {
    hints.push(
      '这个设计只有草图（零实体，bodies=0），**导不出 STEP 几何**：不要反复让 agent 执行 deliver，除非先在 SOLIDWORKS 里把草图拉伸成实体',
    );
  } else {
    hints.push(`想看到实体请让 agent 执行 ${deliver} 导出 STEP，或把同名 .step 放到：${path.dirname(normalized)}`);
  }
  hints.push(`${path.basename(normalized)} 现状：修改时间 ${fmtTime(nativeMtime)}，大小 ${fmtBytes(nativeBytes)}`);

  return {
    ok: true,
    path: normalized,
    format: extensionOf(normalized).slice(1),
    meshSource: 'sketch-only',
    sibling: null,
    bytes: nativeBytes,
    mtimeMs: nativeMtime,
    hints,
    designId: resolvedDesignId,
    completed: false,
    deliver,
    sketch: {
      designId: resolvedDesignId,
      sketchCount: drawable.length,
      polylineCount,
      // 客户端不用自己再拼 URL，直接用这个可以 GET 到同一份数据
      url: `/sw3d/sketches?path=${encodeURIComponent(normalized)}`,
      // 非草图特征数（extrude/cut/…）：0 = 零实体件，deliver 对它没用
      solidFeatureCount: solidFeatureCountOf(payload),
    },
  };
}

/** 非草图特征数：有 extrude/cut/… 才可能导出 STEP 几何。 */
function solidFeatureCountOf(payload) {
  const features = payload && Array.isArray(payload.features) ? payload.features : null;
  if (features) return features.filter((feature) => feature && feature.kind && feature.kind !== 'sketch').length;
  // /sw3d/sketches 的响应里 featureCount 就是「非草图特征数」
  return payload && Number.isFinite(Number(payload.featureCount)) ? Number(payload.featureCount) : 0;
}

/**
 * 这个设计到底有没有「能变成实体」的特征？
 * 有 → 只是还没导出 STEP（deliver 有意义）；没有 → 零实体件，对它是死循环。
 */
function shapesIntoBody(payload) {
  return solidFeatureCountOf(payload) > 0;
}

function appendStaleHint(hints, nativeStat, stepStat, nativeLabel, stepName) {
  const nativeMs = roundMs(nativeStat && nativeStat.mtimeMs);
  const stepMs = roundMs(stepStat && stepStat.mtimeMs);
  if (!nativeMs || !stepMs) return;
  if (nativeMs - stepMs <= STALE_STEP_THRESHOLD_MS) return;
  hints.push(
    `${nativeLabel} 比 ${stepName} 新 ${Math.round((nativeMs - stepMs) / 1000)} 秒：同名 STEP 可能已过期，` +
      `看到的几何可能不是最新模型（${nativeLabel} 更新于 ${fmtTime(nativeMs)}，STEP 更新于 ${fmtTime(stepMs)}）`,
  );
}

/** 把 angularDeflection 归一到 [0.01, π] 弧度，非数字用默认 0.12；缓存键用它保证同参数同文件。 */
export function normalizeAngularDeflection(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ANGULAR_DEFLECTION;
  const clamped = Math.min(MAX_ANGULAR_DEFLECTION, Math.max(MIN_ANGULAR_DEFLECTION, parsed));
  return Math.round(clamped * 100000) / 100000;
}

/** 把 creaseAngle 归一到 [0, 180] 度，非数字用默认 35；0 = 纯平面着色，180 = 全平滑。 */
export function normalizeCreaseAngle(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return DEFAULT_CREASE_ANGLE;
  // 注意：0 是合法值（纯平面着色），不能用 `parsed <= 0` 判空，只能判 NaN。
  const clamped = Math.min(MAX_CREASE_ANGLE, Math.max(MIN_CREASE_ANGLE, parsed));
  return Math.round(clamped * 100) / 100;
}

/** 把 deflection 归一到 [0.01, 50]，非数字用默认 0.08；缓存键用它保证同参数同文件。 */
export function normalizeDeflection(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEFLECTION;
  const clamped = Math.min(MAX_DEFLECTION, Math.max(MIN_DEFLECTION, parsed));
  return Math.round(clamped * 10000) / 10000;
}

/** 三角形上限：非数字用默认 300k，夹到 [2000, 5M]，取整。缓存键必须带上它。 */
export function normalizeMaxTriangles(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TRIANGLES;
  return Math.min(MAX_MAX_TRIANGLES, Math.max(MIN_MAX_TRIANGLES, Math.round(parsed)));
}

/**
 * 精度档 → {deflection, maxTriangles}；未知档返回 null。
 *
 * 数值依据（改这一组数时必须同时改 client.js 的同名表，否则默认档位下「客户端发的数」和
 * 「宿主默认的数」会不一致，缓存键分叉、同文件重复三角化两次）：
 *  - **mid = 默认档**（客户端 DEFAULT_PRECISION='mid'）：deflection 必须等于
 *    step_mesh.py 的 DEFAULT_DEFLECTION = 0.08；maxTriangles 必须等于其 MAX_TRIANGLES = 300000，
 *    这样「不传参」「传 mid」「python 自身默认」三条路径落到同一份缓存。
 *  - **high**：弦高再细一半（0.04 = mid/2，沿用原来 0.1 对 0.2 的半档关系），上限抬到 900000
 *    给细分留余量；只在用户明确要更细时才用，代价是三角数与耗时都翻倍左右。
 *  - **low**：弦高回到 0.2（= 改造前的旧 mid 值，2.5× 粗于新默认，视觉上明显更「棱」但很快），
 *    上限压到 120000。这是给大装配/弱机器兜底用的档，不是画质档。
 *  - 三档都不改 angularDeflection / creaseAngle：它们控制的是「圆弧切多细」和「棱保不保锐」，
 *    属于着色语义而非分辨率档位；需要时走 URL 的 angularDeflection= / creaseAngle= 单个覆盖。
 */
export const PRECISION_TIERS = Object.freeze({
  high: { deflection: 0.04, maxTriangles: 900000 },
  mid: { deflection: 0.08, maxTriangles: 300000 },
  low: { deflection: 0.2, maxTriangles: 120000 },
});

export function precisionTier(name) {
  const key = String(name || '').toLowerCase();
  return PRECISION_TIERS[key] ? { name: key, ...PRECISION_TIERS[key] } : null;
}
