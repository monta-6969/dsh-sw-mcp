/**
 * 路径补全与「最近使用」索引。
 *
 * 存在的理由（真实 bug）：DSH 预览面板的 resourceAddress 里带的路径**不一定**是绝对路径
 * （`dsh-resource://file/session/<sid>/轴承支架.SLDPRT` 里的就是相对会话工作区的相对路径）。
 * 客户端在资源 stat 还没 live 时会降级成裸文件名，宿主收到 `轴承支架.SLDPRT` 只能拒绝。
 * 这里提供宿主侧的兜底：按 basename 在已知目录里找真实绝对路径。
 *
 * 数据来源（都只读本机、不联网、不改被预览的文件）：
 *   1. `%LOCALAPPDATA%\sw-mcp\projects\*.json` —— sw-mcp 的设计记录，artifacts[].path 里
 *      有 SLDPRT/STEP 的绝对路径，顶层有 designId；
 *   2. `%LOCALAPPDATA%\sw-3d-preview\recent.json` —— 本插件自己写的最近成功解析索引。
 *
 * 本模块不依赖 DSH 运行时，可被 node 直接 import 做离线测试。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { localDataRoot } from './mesh.js';

export const MAX_PROJECT_FILES = 400;
export const MAX_PROJECT_BYTES = 1024 * 1024;
export const MAX_RECENT_PATHS = 60;
const MAX_SCAN_NODES = 40000;
const MAX_SCAN_DEPTH = 10;

/** `%LOCALAPPDATA%\sw-mcp`（sw-mcp 的数据根；只读，不修改）。 */
export function swMcpDataRoot() {
  const base = process.env.LOCALAPPDATA || process.env.LOCAL_APP_DATA || '';
  if (!base) return path.join(path.dirname(localDataRoot()), 'sw-mcp');
  return path.join(base, 'sw-mcp');
}

export function projectsDir() {
  return path.join(swMcpDataRoot(), 'projects');
}

export function recentIndexPath() {
  return path.join(localDataRoot(), 'recent.json');
}

export function isAbsoluteFsPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function baseNameOf(value) {
  if (typeof value !== 'string' || !value) return '';
  const parts = value.replace(/\//g, '\\').split('\\');
  return parts[parts.length - 1] || '';
}

/** 比较用归一：斜杠方向、大小写、首尾空白（Windows 大小写不敏感）。 */
export function normalizeForCompare(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isSamePath(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function looksLikePathString(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 4 || value.length > 32767) return false;
  return isAbsoluteFsPath(value);
}

/** 深度遍历 JSON，收集所有「看着像绝对路径」的字符串（有节点/深度上限，防病态输入）。 */
export function collectPathStrings(root) {
  const found = [];
  let visited = 0;
  const walk = (node, depth) => {
    if (node == null || depth > MAX_SCAN_DEPTH || visited > MAX_SCAN_NODES) return;
    visited += 1;
    if (typeof node === 'string') {
      if (looksLikePathString(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function designIdOfRecord(record) {
  if (!record || typeof record !== 'object') return '';
  const direct = record.designId || (record.definition && record.definition.designId);
  return typeof direct === 'string' && direct.trim() ? direct.trim() : '';
}

/**
 * 读 sw-mcp 的 project 记录（按文件修改时间新→旧，最多 MAX_PROJECT_FILES 个）。
 * 坏 JSON 跳过，不抛错。
 * @returns {Promise<Array<{file:string, designId:string, paths:string[], mtimeMs:number}>>}
 */
export async function readProjectRecords() {
  let entries;
  try {
    entries = await fs.readdir(projectsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.json') continue;
    files.push(path.join(projectsDir(), entry.name));
  }
  const records = [];
  for (const file of files.slice(0, MAX_PROJECT_FILES)) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) continue;
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    records.push({
      file,
      designId: designIdOfRecord(parsed) || path.basename(file, '.json'),
      paths: collectPathStrings(parsed),
      mtimeMs: Math.round(stat.mtimeMs),
    });
  }
  records.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return records;
}

/** 某个绝对路径对应的设计 ID（project 记录里 artifact 路径精确匹配，或同目录同名异扩展名的兄弟文件）。 */
export async function findDesignIdForPath(absPath) {
  if (!isAbsoluteFsPath(absPath)) return '';
  const target = normalizeForCompare(absPath);
  const targetBase = normalizeForCompare(baseNameOf(absPath)).replace(/\.[^.]+$/, '');
  const targetDir = normalizeForCompare(path.dirname(absPath));
  const records = await readProjectRecords();
  for (const record of records) {
    for (const candidate of record.paths) {
      if (normalizeForCompare(candidate) === target) return record.designId;
      if (
        normalizeForCompare(path.dirname(candidate)) === targetDir &&
        normalizeForCompare(baseNameOf(candidate)).replace(/\.[^.]+$/, '') === targetBase
      ) {
        return record.designId;
      }
    }
  }
  return '';
}

/** 读最近成功解析索引（坏的/缺的都当空表）。 */
export async function readRecentPaths() {
  let text;
  try {
    text = await fs.readFile(recentIndexPath(), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    const value = typeof item === 'string' ? item : item && item.path;
    if (typeof value !== 'string' || !isAbsoluteFsPath(value)) continue;
    out.push({
      path: value,
      at: (item && typeof item.at === 'string' ? item.at : '') || '',
    });
  }
  return out;
}

/** 记一条最近成功解析的绝对路径（同路径去重，新的在前，最多 MAX_RECENT_PATHS 条）。 */
export async function rememberResolvedPath(absPath) {
  if (!isAbsoluteFsPath(absPath)) return;
  try {
    const existing = await readRecentPaths();
    const next = [{ path: path.resolve(absPath), at: new Date().toISOString() }];
    for (const item of existing) {
      if (isSamePath(item.path, absPath)) continue;
      next.push(item);
      if (next.length >= MAX_RECENT_PATHS) break;
    }
    const dir = path.dirname(recentIndexPath());
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(recentIndexPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* 索引只是加速手段，写失败不影响预览 */
  }
}

/**
 * 按文件名在 project 记录与最近索引里找一个**真实存在**的绝对路径。
 * @param {string} name 文件名（可带目录，只取 basename）
 * @returns {Promise<{absolutePath:string, designId:string, source:'project'|'recent', bytes:number, mtimeMs:number}|null>}
 */
export async function findPathByBaseName(name) {
  const base = baseNameOf(name);
  if (!base) return null;
  const wanted = normalizeForCompare(base);
  const candidates = [];

  const records = await readProjectRecords();
  for (const record of records) {
    for (const candidate of record.paths) {
      if (normalizeForCompare(baseNameOf(candidate)) !== wanted) continue;
      candidates.push({ absolutePath: candidate, designId: record.designId, source: 'project' });
    }
  }
  for (const item of await readRecentPaths()) {
    if (normalizeForCompare(baseNameOf(item.path)) !== wanted) continue;
    candidates.push({ absolutePath: item.path, designId: '', source: 'recent' });
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const key = normalizeForCompare(candidate.absolutePath);
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = await fs.stat(candidate.absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    return {
      absolutePath: path.resolve(candidate.absolutePath),
      designId: candidate.designId || (await findDesignIdForPath(candidate.absolutePath)),
      source: candidate.source,
      bytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    };
  }
  return null;
}
