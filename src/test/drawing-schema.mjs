#!/usr/bin/env node
// 读图记录的自检。
//
// 为什么要有这个：drawing.json 是「这张图我读成了什么」的唯一书面记录，
// 建模、核对、以及下一个接手的会话都靠它。它写错一条，后面全跟着错，
// 而且错得很安静 —— 一条 checks 里指向不存在标注 id 的条目，跑起来只是
// 「核对通过」，因为根本没核对任何东西。
//
// 这里查的都是「指向」：标注 → 视图、尺寸链 → 标注、特征 → 标注、核对 → 标注。
// 不查数值对不对（那是建模之后 measure 的事）。
//
// 字段名允许两种拼写（schema/schemaVersion、designId/drawingId、
// from 字符串或数组）：两件零件的记录是先后写的，逼它们改名的收益
// 不如让检查器认识两种写法 —— 但不认识「没有指向」。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './lib/mcp.mjs';
import { EVIDENCE_SCHEMA_VERSION } from '../server/drawing-evidence.mjs';

let passed = 0;
const failures = [];

function check(what, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${what}`);
  } catch (err) {
    failures.push(`${what}: ${err.message}`);
    console.log(`FAIL  ${what}\n        ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const DIRS = ['p1', 'p2'];

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const labelOf = (...cands) => cands.find((c) => typeof c === 'string' && c.trim().length > 1) || null;

function load(dir) {
  const file = join(repoRoot, 'drawings', dir, 'drawing.json');
  assert(existsSync(file), `没有 ${file}`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return { doc, file };
}

console.log('=== 读图记录自检');

for (const dir of DIRS) {
  let doc;
  try {
    ({ doc } = load(dir));
  } catch (err) {
    check(`${dir}: 能读到 drawing.json`, () => { throw err; });
    continue;
  }
  const dimIds = new Set((doc.dimensions || []).map((d) => d.id));
  const viewIds = new Set((doc.views || []).map((v) => v.id || v.label));

  check(`${dir}: 版本与零件对得上`, () => {
    const schema = doc.schema ?? doc.schemaVersion;
    assert(schema >= 1 && schema <= EVIDENCE_SCHEMA_VERSION, `schema=${schema}`);
    const designId = doc.designId ?? doc.drawingId;
    assert(designId, '缺 designId/drawingId');
    assert(existsSync(join(repoRoot, 'examples', 'designs', `${designId}.json`)), `没有 examples/designs/${designId}.json`);
  });

  check(`${dir}: 投影法明说且给了理由`, () => {
    const kind = doc.projection && doc.projection.kind;
    assert(kind === 'first-angle' || kind === 'third-angle', `projection.kind=${kind}`);
    const why = doc.projection.why || doc.projection.evidence || doc.projection.reason;
    assert(why && String(why).length > 8, '没有写判定理由');
  });

  check(`${dir}: 每个标注都说得出是什么`, () => {
    const dims = doc.dimensions || [];
    assert(dims.length >= 8, `只有 ${dims.length} 条标注`);
    for (const d of dims) {
      assert(typeof d.value === 'number' && d.value > 0, `标注 ${d.id} 的 value 不是正数`);
      assert(labelOf(d.what, d.label, d.anchor, d.note), `标注 ${d.id} 没说是什么`);
      if (d.unit != null) assert(d.unit === 'mm', `标注 ${d.id} 单位不是 mm`);
      if (d.view) assert(viewIds.has(d.view), `标注 ${d.id} 指向不存在的视图 ${d.view}`);
    }
  });

  check(`${dir}: 尺寸链引用的标注都存在`, () => {
    for (const c of doc.chains || []) {
      assert(c.expr && typeof c.expr === 'string', `链 ${c.id} 没写 expr`);
      assert(labelOf(c.why, c.note), `链 ${c.id} 没写为什么`);
      for (const id of [...asList(c.from), ...asList(c.terms)]) {
        assert(dimIds.has(id), `链 ${c.id} 引用了不存在的标注 ${id}`);
      }
    }
  });

  check(`${dir}: 每个特征都说得出由哪几条标注决定`, () => {
    for (const f of doc.features || []) {
      assert(labelOf(f.what, f.label, f.kind, f.note), `特征 ${f.id} 没说是什么`);
      const from = asList(f.from);
      assert(from.length > 0, `特征 ${f.id} 没有 from —— 那就等于凭印象画的`);
      for (const id of from) assert(dimIds.has(id), `特征 ${f.id} 引用了不存在的标注 ${id}`);
    }
  });

  check(`${dir}: 每条核对都指向真实标注`, () => {
    const checks = doc.checks || [];
    assert(checks.length >= 8, `只有 ${checks.length} 条核对`);
    for (const k of checks) {
      const name = k.what || k.name;
      assert(k.measure, `核对 ${name} 没写 measure`);
      assert(typeof k.expect === 'number', `核对 ${name} 的 expect 不是数字`);
      const from = asList(k.from);
      assert(from.length > 0, `核对 ${name} 没有 from —— 无法追溯它是哪条标注`);
      for (const id of from) assert(dimIds.has(id), `核对 ${name} 引用了不存在的标注 ${id}`);
    }
  });

  check(`${dir}: 歧义没有被悄悄当成定论`, () => {
    const assume = (doc.assumptions || []).length;
    const open = (doc.openQuestions || []).length;
    assert(assume >= 1, '一条假设都没有 —— 读图不可能这么干净');
    for (const q of doc.openQuestions || []) {
      if (typeof q === 'string') {
        assert(q.length > 4, '待确认条目太短，没说清是什么');
        continue;
      }
      assert(labelOf(q.what, q.question, q.label), `待确认 ${q.id} 缺 what`);
      assert(labelOf(q.current, q.note, q.status), `待确认 ${q.id} 缺 current（现在按什么处理的）`);
    }
    console.log(`        ${assume} 条假设，${open} 个待确认`);
  });
}

// 设计文件里的核对条目必须和读图记录数量一致，
// 否则「图纸上标了 10 条、实际只核对 6 条」这种漏检永远没人发现。
for (const dir of DIRS) {
  check(`${dir}: design 文件的核对条数与读图记录一致`, () => {
    const { doc } = load(dir);
    const designId = doc.designId ?? doc.drawingId;
    const design = JSON.parse(readFileSync(join(repoRoot, 'examples', 'designs', `${designId}.json`), 'utf8'));
    const inDesign = (design.__expect && design.__expect.checks) || [];
    const inDrawing = (doc.checks || []).length;
    assert(inDesign.length === inDrawing, `drawing.json 有 ${inDrawing} 条，design 有 ${inDesign.length} 条`);
  });
}

console.log('');
if (failures.length) {
  console.log(`failures:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
