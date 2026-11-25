/**
 * 草图叠加层的数据侧（宿主半边）。
 *
 * 数据从哪来（**只读**，不碰 SOLIDWORKS、不写 sw-mcp）：
 *   %LOCALAPPDATA%\sw-mcp\projects\<designId>.json
 *     .definition.features[] 里 kind="sketch" 的段就是草图：
 *       老格式 schemaVersion<=2: { kind:'sketch', id, plane, curves:[{kind:'line'|'arc'|'circle'|…}] }
 *       新格式 schemaVersion=3  : { kind:'sketch', id, plane, primitives:[{shape:'rect'|'circle'|'polyline'|…}] }
 *     .definition.params  —— 参数表（值可以是数字，也可以是 "plate_w-2*corner_r" 这种算式）
 *     .definition.units   —— 实测全部是 "mm"
 *     .measurements.boundingBox —— 只给尺寸，不是 min/max
 *
 * 坐标系结论（对真实设计反推出来的，见 test/host.mjs 的注释）：
 *   definition 里的草图是**二维**的，平面用数字下标表示（0/1/2 = SOLIDWORKS 的前视/上视/右视基准面），
 *   原点就是模型原点，单位 mm —— 与 /sw3d/mesh 出来的 S3DM（STEP 三角化结果）用同一套 mm 坐标系，
 *   所以可以直接叠加，不需要缩放或平移。三个平面的 (u,v) → (x,y,z) 基向量：
 *     0 前视(Front, 法向 +Z): u→+X, v→+Y
 *     1 上视(Top,   法向 +Y): u→+X, v→-Z
 *     2 右视(Right, 法向 +X): u→-Z, v→+Y
 *   验证（真实数据）：
 *     tee-pipe-v2 / 锁盖.STEP：plane 0 草图半径 15 的圆弧 + 中心 (0,±20) 半径 9 的圆弧 →
 *       实测网格 bbox [-15,-29,-5,15,29,0]，X/Y 完全对上；深度 5、方向 -Z 也对上 Z∈[-5,0]。
 *     bracket-1602 / 轴承支架.step：plane 1 的底板矩形 20.2×13.4、中心 (0,-6.7) →
 *       实测 bbox X∈[-10.1,10.1]（u→X 精确匹配）、Z∈[0,13.4]（v→-Z 精确匹配）。
 *     bearing-seat-6 / bearing-seat-6.STEP：plane 2 的 bore Ø40 圆心 (0,60) →
 *       STEP 里确实是 Ø20 轴线沿 X、位置 (112.5,60,0) 的孔：v=60→Y=60、u=0→Z=0。
 *
 * 本模块不依赖 DSH 运行时，可被 node 直接 import 做离线测试。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { isAbsoluteFsPath, findDesignIdForPath, projectsDir, readProjectRecords } from './paths.js';

/** 一个整圆采样多少段（LineSegments 顶点数 = 段数×2）。 */
export const CIRCLE_SEGMENTS = 48;
/** 一段圆弧采样多少段。 */
export const ARC_SEGMENTS = 16;
/** 圆弧/整圆段数上限，防病态输入。 */
export const MAX_SEGMENTS = 256;

/** 平面下标 → 基准面名（0/1/2 = 前视/上视/右视）。 */
export const PLANE_LABELS = {
  0: '基准面-前视',
  1: '基准面-上视',
  2: '基准面-右视',
};

/** 平面下标 → 二维 (u,v) 到三维 (x,y,z) 的基向量。原点固定为模型原点。 */
export const PLANE_BASES = {
  0: { u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  1: { u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0] },
  2: { u: [0, 0, -1], v: [0, 1, 0], normal: [1, 0, 0] },
};

/** 消费草图的那种特征的中文名（definition 里只有 kind/id，没有 SOLIDWORKS 显示名）。 */
const FEATURE_KIND_LABELS = {
  extrude: '拉伸',
  cut: '切除',
  revolve: '旋转',
  boss: '凸台',
  fillet: '圆角',
  chamfer: '倒角',
  pattern: '阵列',
  holes: '孔',
  basePlate: '底板',
};

function round3(value) {
  const n = Number(value);
  if (!isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

/** 平面下标 → '基准面-上视'；未知返回 ''。 */
export function planeLabel(plane) {
  if (typeof plane !== 'number' || !PLANE_LABELS[plane]) return '';
  return PLANE_LABELS[plane];
}

/** 草图二维点 → 模型三维点（mm）。未知平面按平面 0 处理并让调用方给 warning。 */
export function sketchPointToWorld(plane, u, v) {
  const base = PLANE_BASES[typeof plane === 'number' && PLANE_BASES[plane] ? plane : 0];
  const a = Number(u);
  const b = Number(v);
  const uu = isFinite(a) ? a : 0;
  const vv = isFinite(b) ? b : 0;
  return [
    round3(base.u[0] * uu + base.v[0] * vv),
    round3(base.u[1] * uu + base.v[1] * vv),
    round3(base.u[2] * uu + base.v[2] * vv),
  ];
}

/** 二维点数组 → {points:[[x,y,z],…], closed, kind}。点不够两个就返回 null。 */
export function toPolyline(plane, points2d, closed, kind) {
  const list = Array.isArray(points2d) ? points2d : [];
  const points = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const world = sketchPointToWorld(plane, item[0], item[1]);
    points.push(world);
  }
  if (points.length < 2) return null;
  return { points, closed: !!closed, kind: kind || 'line' };
}

function arcSamples(cx, cy, radius, a0, a1, segments) {
  const count = Math.max(2, Math.min(MAX_SEGMENTS, Math.round(segments) || ARC_SEGMENTS));
  const out = [];
  for (let i = 0; i <= count; i += 1) {
    const t = a0 + ((a1 - a0) * i) / count;
    out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
  }
  return out;
}

function circleSamples(cx, cy, radius, segments) {
  const out = arcSamples(cx, cy, radius, 0, Math.PI * 2, segments || CIRCLE_SEGMENTS);
  out.pop(); // 闭合由 closed 标记承担，别让首尾点重复
  return out;
}

function sweep(a0, a1, direction) {
  const twoPi = Math.PI * 2;
  let delta = a1 - a0;
  if (direction >= 0) {
    while (delta < 0) delta += twoPi;
    while (delta > twoPi) delta -= twoPi;
  } else {
    while (delta > 0) delta -= twoPi;
    while (delta < -twoPi) delta += twoPi;
  }
  return delta;
}

/** 圆角矩形：4 条直边 + 4 段圆角，各自成线（kind 分别为 line / arc）。 */
function roundedRectPolylines(prim) {
  const center = Array.isArray(prim.center) ? prim.center : [0, 0];
  const cx = Number(center[0]) || 0;
  const cy = Number(center[1]) || 0;
  const halfW = Math.abs(Number(prim.width) || 0) / 2;
  const halfH = Math.abs(Number(prim.height) || 0) / 2;
  const r = Math.min(Math.abs(Number(prim.r != null ? prim.r : prim.radius) || 0), Math.min(halfW, halfH));
  const x0 = cx - halfW, x1 = cx + halfW, y0 = cy - halfH, y1 = cy + halfH;
  if (!(r > 0)) {
    return [{ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, kind: 'line' }];
  }
  return [
    { points: [[x0 + r, y0], [x1 - r, y0]], closed: false, kind: 'line' },
    { points: arcSamples(x1 - r, y0 + r, r, -Math.PI / 2, 0), closed: false, kind: 'arc' },
    { points: [[x1, y0 + r], [x1, y1 - r]], closed: false, kind: 'line' },
    { points: arcSamples(x1 - r, y1 - r, r, 0, Math.PI / 2), closed: false, kind: 'arc' },
    { points: [[x1 - r, y1], [x0 + r, y1]], closed: false, kind: 'line' },
    { points: arcSamples(x0 + r, y1 - r, r, Math.PI / 2, Math.PI), closed: false, kind: 'arc' },
    { points: [[x0, y1 - r], [x0, y0 + r]], closed: false, kind: 'line' },
    { points: arcSamples(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5), closed: false, kind: 'arc' },
  ];
}

/** 腰形槽（slot）：两端半圆 + 两条直边，采样成一条闭合折线。 */
function slotPolyline(prim) {
  const from = Array.isArray(prim.from) ? prim.from : [0, 0];
  const to = Array.isArray(prim.to) ? prim.to : [0, 0];
  const ax = Number(from[0]) || 0, ay = Number(from[1]) || 0;
  const bx = Number(to[0]) || 0, by = Number(to[1]) || 0;
  const half = Math.max(0, Number(prim.width) || 0) / 2;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9) || !(half > 0)) return null;
  const angle = Math.atan2(dy, dx);
  const nx = -Math.sin(angle) * half, ny = Math.cos(angle) * half;
  const points = [
    [ax + nx, ay + ny], [bx + nx, by + ny],
  ];
  const capA = arcSamples(bx, by, half, angle - Math.PI / 2, angle + Math.PI / 2, 12);
  const capB = arcSamples(ax, ay, half, angle + Math.PI / 2, angle + Math.PI * 1.5, 12);
  return { points: points.concat(capA.slice(1, -1), [[bx - nx, by - ny], [ax - nx, ay - ny]], capB.slice(1, -1)), closed: true, kind: 'line' };
}

/** 正多边形（polygon）：center + diameter + sides + rotate。 */
function polygonPoints(prim) {
  const center = Array.isArray(prim.center) ? prim.center : [0, 0];
  const cx = Number(center[0]) || 0, cy = Number(center[1]) || 0;
  const radius = Math.abs(Number(prim.diameter) || 0) / 2;
  const sides = Math.max(3, Math.min(256, Math.round(Number(prim.sides) || 3)));
  if (!(radius > 0)) return null;
  const rotate = (Number(prim.rotate) || 0) * (Math.PI / 180);
  const out = [];
  for (let i = 0; i < sides; i += 1) {
    const t = rotate + (Math.PI * 2 * i) / sides;
    out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
  }
  return out;
}

/**
 * 图元里的尺寸经常不是数字而是**参数名**（`{"width":"plate_l","bind":{"width":"plate_l"}}`）：
 * 用 definition.params 求出来的值替换掉，否则 Number('plate_l') = NaN，整条折线会塌成原点。
 */
export function resolvePrimitive(prim, params) {
  const source = prim && typeof prim === 'object' ? prim : {};
  const table = params && typeof params === 'object' ? params : {};
  const bind = source.bind && typeof source.bind === 'object' ? source.bind : null;
  if (!bind) return source;
  const out = Object.assign({}, source);
  for (const field of Object.keys(bind)) {
    const paramName = String(bind[field]);
    const value = table[paramName];
    if (typeof value === 'number' && isFinite(value)) out[field] = value;
  }
  return out;
}

/**
 * 曲线/图元字段取数：数字原样；字符串按参数名到 definition.params 求值表里查。
 * 真实数据里有 `{"radius":"r"}`（curve-zoo / profile.C2，definition.params.r=15），
 * 直接 Number('r') 会得到 NaN，整条圆就被当成「半径无效」丢了。
 */
function fieldNumber(value, table) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string' && table && typeof table === 'object') {
    const resolved = table[value.trim()];
    if (typeof resolved === 'number' && isFinite(resolved)) return resolved;
  }
  return NaN;
}

/**
 * 把一个 sketch 特征拧成三维折线。
 *
 * 构造几何（`construction: true`，SOLIDWORKS 的构造线/中心线）**默认不画进轮廓**：
 * 不进 polylines，但会收进 constructionPolylines 并计入 constructionSkipped，
 * 同时在 warnings 里明写「已跳过 N 条构造几何」—— 过滤不等于悄悄丢。
 *
 * 字段位置注意：老格式 schemaVersion<=2 里同一份坐标有两种写法，**两种都要认**：
 *   新：`{kind:'line', params:{start,end}}`      （fracture-section-01.json 等真实数据）
 *   老：`{kind:'line', start, end}`              （curve-zoo.json / tee-pipe.json 等）
 * line / arc / circle / spline 都按 `params.x ?? curve.x` 取值，别只读一边。
 *
 * @param {object} feature definition.features[] 里 kind='sketch' 的那一项
 * @param {object} [params] definition.params 求值后的表（resolveParams 的结果）
 * @returns {{polylines:Array<{points:number[][],closed:boolean,kind:string}>,
 *            warnings:string[],
 *            constructionSkipped:number,
 *            constructionPolylines:Array<{points:number[][],closed:boolean,kind:string}>}}
 */
export function tessellateSketch(feature, params) {
  const sketch = feature || {};
  const plane = typeof sketch.plane === 'number' ? sketch.plane : 0;
  /** definition.params 求值表（曲线循环里的局部变量叫 params，别被遮蔽）。 */
  const paramsTable = params && typeof params === 'object' ? params : {};
  const polylines = [];
  const warnings = [];
  const name = String(sketch.id || 'sketch');
  /** 构造几何的折线（默认不画，留着给以后「显示构造线」用，也保证数据没被丢掉）。 */
  const constructionPolylines = [];
  /** 被跳过的构造几何源段数（一个 roundedRect 采出多段也只算 1 条）。 */
  let constructionSkipped = 0;
  /** 当前源段（曲线/图元）是不是构造几何，以及它的标识。 */
  let currentConstruction = false;
  let currentSource = '';
  const countedSources = new Set();
  const add = (points2d, closed, kind) => {
    const line = toPolyline(plane, points2d, closed, kind);
    if (!line) return line;
    if (currentConstruction) {
      constructionPolylines.push(line);
      if (!countedSources.has(currentSource)) {
        countedSources.add(currentSource);
        constructionSkipped += 1;
      }
    } else {
      polylines.push(line);
    }
    return line;
  };

  if (typeof sketch.plane !== 'number') {
    warnings.push(`草图 ${name}：definition 里没有 plane 字段，按前视基准面（XY）叠加`);
  } else if (!PLANE_BASES[sketch.plane]) {
    warnings.push(`草图 ${name}：plane=${sketch.plane} 不在 0/1/2 内，按前视基准面（XY）叠加`);
  }

  /* ---------------- 新格式：primitives ---------------- */
  const primitives = Array.isArray(sketch.primitives) ? sketch.primitives : [];
  for (let i = 0; i < primitives.length; i += 1) {
    const rawPrim = primitives[i];
    const prim = resolvePrimitive(rawPrim, params);
    const shape = String(prim.shape || '');
    const where = `草图 ${name}：#${i} ${shape || '(无 shape)'}`;
    currentSource = 'primitive#' + i;
    currentConstruction = prim.construction === true;
    if (shape === 'rect') {
      const center = Array.isArray(prim.center) ? prim.center : [0, 0];
      const cx = Number(center[0]) || 0, cy = Number(center[1]) || 0;
      const halfW = Math.abs(Number(prim.width) || 0) / 2;
      const halfH = Math.abs(Number(prim.height) || 0) / 2;
      add([[cx - halfW, cy - halfH], [cx + halfW, cy - halfH], [cx + halfW, cy + halfH], [cx - halfW, cy + halfH]], true, 'line');
    } else if (shape === 'circle') {
      const center = Array.isArray(prim.center) ? prim.center : [0, 0];
      const radius = Math.abs(Number(prim.diameter) || 0) / 2;
      if (!(radius > 0)) { warnings.push(`${where}：diameter 无效，已跳过`); continue; }
      add(circleSamples(Number(center[0]) || 0, Number(center[1]) || 0, radius), true, 'circle');
    } else if (shape === 'polyline') {
      const pts = Array.isArray(prim.points) ? prim.points : [];
      if (!add(pts, prim.closed !== false, 'polyline')) warnings.push(`${where}：点数不足 2，已跳过`);
    } else if (shape === 'roundedRect') {
      for (const line of roundedRectPolylines(prim)) add(line.points, line.closed, line.kind);
    } else if (shape === 'slot') {
      const line = slotPolyline(prim);
      if (line) add(line.points, line.closed, line.kind);
      else warnings.push(`${where}：from/to/width 无效，已跳过`);
    } else if (shape === 'path') {
      const start = Array.isArray(prim.start) ? prim.start : null;
      const segments = Array.isArray(prim.segments) ? prim.segments : [];
      let cursor = start ? [Number(start[0]) || 0, Number(start[1]) || 0] : null;
      if (!cursor) { warnings.push(`${where}：缺少 start，已跳过`); continue; }
      let emitted = 0;
      for (const segment of segments) {
        if (!segment || typeof segment !== 'object') continue;
        const arc = segment.arc;
        if (arc && Array.isArray(segment.to)) {
          const center = Array.isArray(arc.center) ? arc.center : [0, 0];
          const cx = Number(center[0]) || 0, cy = Number(center[1]) || 0;
          const radius = Math.hypot(cursor[0] - cx, cursor[1] - cy);
          const a0 = Math.atan2(cursor[1] - cy, cursor[0] - cx);
          const a1 = Math.atan2((Number(segment.to[1]) || 0) - cy, (Number(segment.to[0]) || 0) - cx);
          const delta = sweep(a0, a1, Number(arc.dir) >= 0 ? 1 : -1);
          if (radius > 0) { add(arcSamples(cx, cy, radius, a0, a0 + delta), false, 'arc'); emitted += 1; }
          cursor = [Number(segment.to[0]) || 0, Number(segment.to[1]) || 0];
          continue;
        }
        if (Array.isArray(segment.to)) {
          const to = [Number(segment.to[0]) || 0, Number(segment.to[1]) || 0];
          if (Math.hypot(to[0] - cursor[0], to[1] - cursor[1]) > 1e-9) {
            add([cursor, to], false, 'line');
            emitted += 1;
          }
          cursor = to;
        }
      }
      if (!emitted) warnings.push(`${where}：segments 里没有可用线段，已跳过`);
    } else if (shape === 'polygon') {
      const pts = polygonPoints(prim);
      if (pts) add(pts, true, 'line');
      else warnings.push(`${where}：diameter 无效，已跳过`);
    } else if (shape === 'gear') {
      // 只有齿数/模数，没有位置或中心：拿不到坐标，明确说清而不是瞎画
      warnings.push(`${where}：只有 module/pressureAngle/teeth，没有位置坐标，无法叠加`);
    } else {
      warnings.push(`${where}：不认识的图元，已跳过`);
    }
  }

  /* ---------------- 老格式：curves ---------------- */
  //
  // 字段位置：真实数据里两种写法都有（同一个 schemaVersion 下并存），所以**每个字段都按
  // `params.x ?? curve.x` 取**。曾经这里只认 curve.start，导致 fracture-section-01 的
  // 4 条轮廓直边（坐标在 params.start/params.end 下）全被「缺少 start/end」丢掉，
  // 画出来是不闭合的残图。
  const curves = Array.isArray(sketch.curves) ? sketch.curves : [];
  for (let i = 0; i < curves.length; i += 1) {
    const curve = curves[i] || {};
    const kind = String(curve.kind || '');
    const params = curve.params && typeof curve.params === 'object' ? curve.params : {};
    const where = `草图 ${name}：曲线 #${i} ${kind || '(无 kind)'}`;
    /** params 优先、curve 兜底（同一字段两种写法都认）。 */
    const pick = (key) => (params[key] !== undefined ? params[key] : curve[key]);
    const pickPoint = (key) => {
      const value = pick(key);
      return Array.isArray(value) && value.length >= 2 ? value : null;
    };
    currentSource = 'curve#' + i;
    currentConstruction = curve.construction === true;
    if (kind === 'line') {
      const start = pickPoint('start');
      const end = pickPoint('end');
      if (start && end) add([start, end], false, 'line');
      else warnings.push(`${where}：缺少 start/end，已跳过`);
    } else if (kind === 'arc') {
      const center = pickPoint('center');
      const start = pickPoint('start');
      const end = pickPoint('end');
      let radius = fieldNumber(pick('radius'), paramsTable);
      // 有些记录只给 startAngle/endAngle + center/radius，没有 start/end 点：按角度补出来
      const startAngle = fieldNumber(pick('startAngle'), paramsTable);
      const endAngle = fieldNumber(pick('endAngle'), paramsTable);
      const hasAngles = isFinite(startAngle) && isFinite(endAngle);
      const hasEndpoints = !!(start && end);
      if (!center || !(radius > 0) || (!hasEndpoints && !hasAngles)) {
        warnings.push(`${where}：圆弧参数不全，已跳过`);
        continue;
      }
      const cx = Number(center[0]) || 0, cy = Number(center[1]) || 0;
      const from = start || [cx + radius * Math.cos((startAngle * Math.PI) / 180), cy + radius * Math.sin((startAngle * Math.PI) / 180)];
      const to = end || [cx + radius * Math.cos((endAngle * Math.PI) / 180), cy + radius * Math.sin((endAngle * Math.PI) / 180)];
      const a0 = Math.atan2(Number(from[1]) - cy, Number(from[0]) - cx);
      const a1 = Math.atan2(Number(to[1]) - cy, Number(to[0]) - cx);
      const dir = Number(pick('direction') != null ? pick('direction') : 1) >= 0 ? 1 : -1;
      const delta = hasAngles && !hasEndpoints
        ? sweep((startAngle * Math.PI) / 180, (endAngle * Math.PI) / 180, dir)
        : sweep(a0, a1, dir);
      add(arcSamples(cx, cy, radius, a0, a0 + delta), false, 'arc');
    } else if (kind === 'circle') {
      const center = pickPoint('center') || [0, 0];
      // diameter / radius 两种写在哪个层级都要认（真实数据两种都有：35 条圆的 radius 只写在 curve 上）
      const diameter = fieldNumber(pick('diameter'), paramsTable);
      const radius = isFinite(diameter) && diameter > 0 ? diameter / 2 : fieldNumber(pick('radius'), paramsTable);
      if (!(radius > 0)) { warnings.push(`${where}：半径无效，已跳过`); continue; }
      add(circleSamples(Number(center[0]) || 0, Number(center[1]) || 0, radius), true, 'circle');
    } else if (kind === 'spline') {
      const pts = Array.isArray(pick('points')) ? pick('points') : [];
      if (!add(pts, pick('closed') === true, 'spline')) warnings.push(`${where}：点数不足 2，已跳过`);
    } else if (kind === 'polyline') {
      const pts = Array.isArray(pick('points')) ? pick('points') : [];
      if (!add(pts, pick('closed') === true, 'polyline')) warnings.push(`${where}：点数不足 2，已跳过`);
    } else if (kind === 'ellipse' || kind === 'ellipticArc') {
      // major/minor 是长短半轴（不是直径）：按 64 段采样近似，标 warning 说明是近似
      const center = pickPoint('center') || [0, 0];
      const major = Math.abs(fieldNumber(pick('major'), paramsTable) || 0);
      const minor = Math.abs(fieldNumber(pick('minor'), paramsTable) || 0);
      if (!(major > 0) || !(minor > 0)) { warnings.push(`${where}：长短轴无效，已跳过`); continue; }
      const cx = Number(center[0]) || 0, cy = Number(center[1]) || 0;
      const full = kind === 'ellipse';
      const t0 = full ? 0 : Number(pick('startParam')) || 0;
      const t1 = full ? Math.PI * 2 : (Number(pick('endParam')) || Math.PI * 2);
      const count = Math.max(4, Math.min(MAX_SEGMENTS, 64));
      const pts = [];
      for (let s = 0; s <= count; s += 1) {
        const t = t0 + ((t1 - t0) * s) / count;
        pts.push([cx + major * Math.cos(t), cy + minor * Math.sin(t)]);
      }
      if (full) pts.pop();
      add(pts, full, 'arc');
      warnings.push(`${where}：椭圆/椭圆弧按长短半轴近似采样（${count} 段）`);
    } else if (kind === 'equationCurve') {
      warnings.push(`${where}：参数方程曲线拿不到离散坐标，已跳过`);
    } else {
      warnings.push(`${where}：不认识的曲线类型，已跳过`);
    }
  }

  if (!primitives.length && !curves.length) {
    warnings.push(`草图 ${name}：既没有 primitives 也没有 curves，没有可画的东西`);
  }
  if (constructionSkipped > 0) {
    // 过滤不等于悄悄丢：数出来、说出来，data 也留在 constructionPolylines 里
    warnings.push(`草图 ${name}：已跳过 ${constructionSkipped} 条构造几何（construction=true，不计入轮廓）`);
  }
  return { polylines, warnings, constructionSkipped, constructionPolylines };
}

/* ------------------------------------------------------------------ */
/* 尺寸                                                                */
/* ------------------------------------------------------------------ */

const DIMENSION_FIELDS = [
  'width', 'height', 'diameter', 'radius', 'r', 'length', 'sides', 'depth', 'angle', 'teeth', 'module',
];

/** 参数表求值：数字原样，算式按引用递归替换后用受限表达式求值。失败返回 null。 */
export function resolveParams(params, depth) {
  const source = params && typeof params === 'object' ? params : {};
  const level = typeof depth === 'number' ? depth : 0;
  const out = {};
  const computing = new Set();
  const resolveOne = (name) => {
    if (Object.prototype.hasOwnProperty.call(out, name)) return out[name];
    if (computing.has(name) || level > 8) return null;
    computing.add(name);
    const raw = source[name];
    let value = null;
    if (typeof raw === 'number' && isFinite(raw)) value = raw;
    else if (typeof raw === 'string') {
      const text = raw.trim();
      if (/^-?\d+(\.\d+)?$/.test(text)) value = Number(text);
      else if (/^[\w\s.+\-*/()]+$/.test(text)) {
        const replaced = text.replace(/[A-Za-z_][\w]*/g, (token) => {
          const nested = resolveOne(token);
          return nested == null ? 'NaN' : String(nested);
        });
        if (!/NaN/.test(replaced) && /^[\d\s.+\-*/()]+$/.test(replaced)) {
          try {
            // 只允许数字与四则运算，表达式来自本机 sw-mcp 记录
            const computed = Function(`"use strict";return (${replaced});`)();
            if (typeof computed === 'number' && isFinite(computed)) value = computed;
          } catch {
            value = null;
          }
        }
      }
    }
    computing.delete(name);
    out[name] = value;
    return value;
  };
  for (const name of Object.keys(source)) resolveOne(name);
  return out;
}

/**
 * 草图的尺寸列表：优先用 bind 里的参数名（D1 那种 SOLIDWORKS 尺寸名 definition 里没有，
 * 只有参数名），保底用图元的字面量字段名。
 * @returns {Array<{name:string,value:number,unit:string}>}
 */
export function sketchDimensions(feature, params) {
  const sketch = feature || {};
  const resolved = params && typeof params === 'object' ? params : {};
  const out = [];
  const seen = new Set();
  const push = (name, value) => {
    if (!name || seen.has(name)) return;
    const n = Number(value);
    if (!isFinite(n)) return;
    seen.add(name);
    out.push({ name, value: round3(n), unit: 'mm' });
  };
  const items = (Array.isArray(sketch.primitives) ? sketch.primitives : [])
    .concat(Array.isArray(sketch.curves) ? sketch.curves : []);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const bind = item.bind && typeof item.bind === 'object' ? item.bind : null;
    if (bind) {
      for (const field of Object.keys(bind)) {
        const paramName = String(bind[field]);
        if (Object.prototype.hasOwnProperty.call(resolved, paramName)) push(paramName, resolved[paramName]);
      }
    }
    for (const field of DIMENSION_FIELDS) {
      if (item[field] == null) continue;
      const bind2 = bind && bind[field] ? String(bind[field]) : '';
      if (bind2 && Object.prototype.hasOwnProperty.call(resolved, bind2)) continue; // 已经用参数名报过了
      push(bind2 || field, item[field]);
    }
    const pr = item.params;
    if (pr && typeof pr === 'object') {
      for (const field of DIMENSION_FIELDS) {
        if (pr[field] == null) continue;
        if (field === 'angle') continue;
        push(field, pr[field]);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* definition → 响应                                                    */
/* ------------------------------------------------------------------ */

/** 草图 → 消费它的特征（extrude/cut/… 的 profile 指着草图 id）。 */
function featuresByProfile(features) {
  const map = {};
  for (const feature of Array.isArray(features) ? features : []) {
    if (!feature || feature.kind === 'sketch') continue;
    const profile = feature.profile;
    if (typeof profile === 'string' && profile) {
      if (!map[profile]) map[profile] = feature;
    }
  }
  return map;
}

function featureLabel(feature) {
  if (!feature) return '';
  const kind = String(feature.kind || '');
  const label = FEATURE_KIND_LABELS[kind] || kind || '特征';
  return label + ' ' + String(feature.id || '?');
}

function bboxOfPolylines(polylines) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const line of polylines || []) {
    for (const point of line.points || []) {
      if (point[0] < minX) minX = point[0];
      if (point[1] < minY) minY = point[1];
      if (point[2] < minZ) minZ = point[2];
      if (point[0] > maxX) maxX = point[0];
      if (point[1] > maxY) maxY = point[1];
      if (point[2] > maxZ) maxZ = point[2];
    }
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(isFinite)) return null;
  return [round3(minX), round3(minY), round3(minZ), round3(maxX), round3(maxY), round3(maxZ)];
}

/** 折线种类统计：`3 条折线（2 直线 1 圆）`。 */
export function polylineStats(polylines) {
  const list = Array.isArray(polylines) ? polylines : [];
  const counts = {};
  for (const line of list) {
    const kind = String((line && line.kind) || 'line');
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const NAMES = { line: '直线', arc: '圆弧', circle: '圆', spline: '样条', polyline: '折线' };
  const detail = Object.keys(counts).map((kind) => `${counts[kind]} ${NAMES[kind] || kind}`).join(' ');
  return { total: list.length, counts, text: `${list.length} 条折线` + (detail ? `（${detail}）` : '') };
}

/**
 * project json（sw-mcp 的 <designId>.json） → /sw3d/sketches 的响应体。
 * 纯函数：不碰磁盘，方便离线断言。
 */
export function buildSketchPayload(project, options) {
  const opts = options || {};
  const record = project && typeof project === 'object' ? project : {};
  const definition = record.definition && typeof record.definition === 'object' ? record.definition : {};
  const features = Array.isArray(definition.features) ? definition.features : [];
  const designId = String(opts.designId || record.designId || definition.designId || '').trim();
  const warnings = [];
  const sketches = [];

  if (!features.length) {
    return {
      ok: false,
      code: 'NO_SKETCH_DATA',
      message: '该设计记录里没有 features（definition.features 为空或缺字段）',
      hint: '让 agent 在 SOLIDWORKS 里重建一次这个设计（build），或改用能读到 definition 的 designId',
    };
  }

  const params = resolveParams(definition.params || {});
  const consumers = featuresByProfile(features);
  let index = 0;
  let constructionSkipped = 0;
  for (const feature of features) {
    if (!feature || feature.kind !== 'sketch') continue;
    index += 1;
    const tessellated = tessellateSketch(feature, params);
    for (const warning of tessellated.warnings) warnings.push(warning);
    constructionSkipped += tessellated.constructionSkipped;
    const consumer = consumers[feature.id] || null;
    sketches.push({
      id: 'sk-' + index,
      name: String(feature.id || 'Sketch' + index),
      feature: featureLabel(consumer),
      plane: planeLabel(feature.plane) || '',
      planeIndex: typeof feature.plane === 'number' ? feature.plane : null,
      unit: 'mm',
      polylines: tessellated.polylines,
      // 构造几何默认不进 polylines，但既不丢数据（constructionPolylines），也不静默（计数 + warning）
      constructionSkipped: tessellated.constructionSkipped,
      constructionPolylines: tessellated.constructionPolylines,
      dimensions: sketchDimensions(feature, params),
      bbox: bboxOfPolylines(tessellated.polylines),
      stats: polylineStats(tessellated.polylines),
    });
  }

  if (!sketches.length) {
    return {
      ok: false,
      code: 'NO_SKETCH_DATA',
      message: '该设计的 features 里没有 kind=sketch 的草图段',
      hint: '让 agent 在 SOLIDWORKS 里 build 一次（草图段才会写进 definition），或提供含草图的 designId',
    };
  }

  const usable = sketches.filter((item) => item.polylines.length > 0);
  if (!usable.length) {
    warnings.push('所有草图都只有参数、没有可用的二维坐标，叠加层无法画线（只出骨架信息）');
  }

  const units = typeof definition.units === 'string' && definition.units ? definition.units : 'mm';
  return {
    ok: true,
    designId,
    designTitle: String(definition.name || record.goal || designId || ''),
    unit: units === 'mm' ? 'mm' : units,
    schemaVersion: typeof definition.schemaVersion === 'number' ? definition.schemaVersion : null,
    featureCount: features.filter((item) => item && item.kind !== 'sketch').length,
    sketches,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 读盘                                                                */
/* ------------------------------------------------------------------ */

/** 按 designId 找 project 记录并读出来（只读；找不到/坏 JSON 都给 null）。 */
export async function readProjectForDesignId(designId) {
  const wanted = String(designId || '').trim();
  if (!wanted) return null;
  const records = await readProjectRecords();
  const candidates = [];
  for (const record of records) {
    if (record.designId === wanted) candidates.push(record.file);
  }
  candidates.push(path.join(projectsDir(), `${wanted}.json`));
  for (const file of candidates) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      return { file, project: parsed };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 模型绝对路径 → 草图响应。
 * 失败一律返回 {ok:false, code, message, hint}（路由回 200，跟 /sw3d/resolve 的约定一致）。
 */
export async function readSketchesForPath(absPath) {
  const requested = typeof absPath === 'string' ? absPath.trim() : '';
  if (!requested) {
    return { ok: false, code: 'BAD_REQUEST', message: '缺少 path 参数', hint: '用 ?path=<encodeURIComponent(绝对路径)> 传进来' };
  }
  if (!isAbsoluteFsPath(requested)) {
    return {
      ok: false,
      code: 'BAD_PATH',
      message: `path 必须是绝对路径：${requested}`,
      hint: '传模型文件的绝对路径，例如 D:\\\\work\\\\bracket-6.STEP',
    };
  }
  let designId = '';
  try {
    designId = await findDesignIdForPath(requested);
  } catch {
    designId = '';
  }
  if (!designId) {
    return {
      ok: false,
      code: 'NO_DESIGN',
      message: '这个模型没有关联的 sw-mcp 设计记录（找不到 designId）',
      hint: '请让 agent 在 SOLIDWORKS 里 build 一次这个设计（sw-mcp 会把 <designId>.json 写进 %LOCALAPPDATA%\\sw-mcp\\projects\\），或直接提供 designId',
    };
  }
  let found = null;
  try {
    found = await readProjectForDesignId(designId);
  } catch {
    found = null;
  }
  if (!found) {
    return {
      ok: false,
      code: 'PROJECT_UNREADABLE',
      message: `找到了 designId=${designId}，但读不出它的设计记录文件`,
      hint: `检查 %LOCALAPPDATA%\\sw-mcp\\projects\\${designId}.json 是否存在且是合法 JSON`,
    };
  }
  const payload = buildSketchPayload(found.project, { designId });
  if (payload.ok) payload.projectFile = found.file;
  return payload;
}
