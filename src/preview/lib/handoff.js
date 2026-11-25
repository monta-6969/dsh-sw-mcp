/**
 * 标注「交接单」：把某个文件的全部 3D 标注汇总成一份 Markdown，写到
 *   %LOCALAPPDATA%\sw-3d-preview\handoff\<sha1(小写路径)>.md
 * 并返回绝对路径，方便用户把路径直接丢给 agent（而不是把几十条标注全塞进输入框）。
 *
 * 本模块不依赖 DSH 运行时，可被 node 直接 import 做离线测试。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, handoffDir, sha1 } from './mesh.js';
import { findDesignIdForPath } from './paths.js';

/** 交接单路径：按小写绝对路径的 sha1 命名，一个文件一份。 */
export function handoffPathFor(filePath) {
  const normalized = path.resolve(String(filePath));
  return path.join(handoffDir(), `${sha1(normalized.toLowerCase())}.md`);
}

/** 一条标注记录里最有信息量的文本（客户端存的 text 优先，其次 note，最后 JSON）。 */
export function annotationTextOf(record) {
  if (!record) return '';
  const payload = record.annotation !== undefined ? record.annotation : record;
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload === 'object') {
    if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    if (note) return note;
    return JSON.stringify(payload);
  }
  return String(payload ?? '').trim();
}

function oneLine(value, fallback = '（无）') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/**
 * 生成交接单 Markdown 文本（纯函数，便于逐字符测试）。
 * @param {{filePath:string, designId?:string, annotations?:Array<object>, generatedAt?:string}} input
 * @returns {string}
 */
export function buildHandoffMarkdown({ filePath, designId = '', annotations = [], generatedAt = '' } = {}) {
  const items = Array.isArray(annotations) ? annotations : [];
  const at = generatedAt || new Date().toISOString();
  const lines = [];
  lines.push('# 3D 标注交接单');
  lines.push('');
  lines.push(`- 文件：${oneLine(filePath, '（未知）')}`);
  lines.push(`- 设计ID：${oneLine(designId, '（未匹配到 sw-mcp project 记录）')}`);
  lines.push(`- 生成时间：${at}`);
  lines.push(`- 标注条数：${items.length}`);
  lines.push('');
  lines.push('> 用法：把这份文件的路径交给 agent，agent 按每条标注的坐标/面号回到 SolidWorks 里定位；');
  lines.push('> 坐标单位 mm，取自模型坐标系（与 STEP 一致），三点取样用于在 SW 里重新找面。');
  lines.push('');
  if (items.length === 0) {
    lines.push('（该文件还没有保存任何标注）');
    lines.push('');
    return lines.join('\n');
  }
  items.forEach((record, index) => {
    const annotation = record && record.annotation !== undefined ? record.annotation : record;
    const at2 = record && typeof record.at === 'string' ? record.at : '';
    const id = record && typeof record.id === 'string' ? record.id : '';
    const subject = annotation && typeof annotation === 'object' && annotation.subject
      ? String(annotation.subject)
      : (annotation && typeof annotation === 'object' && typeof annotation.faceIndex === 'number' ? 'face' : 'edge');
    const label = `${subject === 'face' ? '面' : '边'} #${
      annotation && typeof annotation === 'object'
        ? (typeof annotation.index === 'number' ? annotation.index : (typeof annotation.faceIndex === 'number' ? annotation.faceIndex : (typeof annotation.edgeIndex === 'number' ? annotation.edgeIndex : '?')))
        : '?'
    }`;
    lines.push(`## 标注 ${index + 1} · ${label}${id ? ` · ${id}` : ''}`);
    lines.push('');
    if (at2) lines.push(`- 记录时间：${at2}`);
    if (annotation && typeof annotation === 'object') {
      if (annotation.kindLabel) lines.push(`- 类型：${annotation.kindLabel}`);
      if (Array.isArray(annotation.samples) && annotation.samples.length) {
        const points = annotation.samples
          .map((point) => `[${(point || []).map((value) => Number(value).toFixed(2)).join(',')}]`)
          .join(' ');
        lines.push(`- 三点取样：${points}`);
      }
      if (typeof annotation.note === 'string' && annotation.note.trim()) {
        lines.push(`- 修改意见：${annotation.note.trim()}`);
      }
    }
    lines.push('');
    lines.push('```text');
    lines.push(annotationTextOf(record) || '（空）');
    lines.push('```');
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 写交接单。annotations 是 /sw3d/annotation 里存的原始记录数组。
 * @returns {Promise<{ok:true, mdPath:string, count:number, bytes:number, designId:string, generatedAt:string}>
 *                  |{ok:false, code:string, message:string}>}
 */
export async function writeHandoffFile({ filePath, annotations = [], designId = '', generatedAt = '' } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    return { ok: false, code: 'BAD_REQUEST', message: '交接单需要绝对文件路径' };
  }
  const at = generatedAt || new Date().toISOString();
  const matched = designId || (await findDesignIdForPath(filePath));
  const markdown = buildHandoffMarkdown({ filePath, designId: matched, annotations, generatedAt: at });
  const mdPath = handoffPathFor(filePath);
  try {
    ensureDir(handoffDir());
    await fs.writeFile(mdPath, markdown, 'utf8');
  } catch (error) {
    return { ok: false, code: 'INTERNAL', message: `写交接单失败：${error && error.message ? error.message : error}` };
  }
  return {
    ok: true,
    mdPath,
    count: Array.isArray(annotations) ? annotations.length : 0,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    designId: matched || '',
    generatedAt: at,
  };
}
