/**
 * build-map.mjs —— 从「海岸线 + 省会种子点」生成地图数据
 *
 * 手画 40 个省的多边形是不现实的，但手画一条海岸线是现实的。
 * 所以这里做两件事：
 *
 *   1. 种子点之间做 Voronoi 划分，得到每块地"离谁最近"
 *   2. 用陆地多边形把每一格裁出来（凹多边形 + 凸半平面裁剪，Sutherland–Hodgman）
 *
 * 输出的相邻关系是**算出来的**，不是手写的——共享两个以上顶点就算接壤，
 * 比手写邻居表准，也不会写出不对称的邻接。
 *
 * 用法：
 *   node tools/build-map.mjs            # 生成两张地图
 *   node tools/build-map.mjs europe     # 只生成其中一张
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import europe from './map-spec-europe.mjs';
import eastasia from './map-spec-eastasia.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SPECS = { europe, eastasia };

/* ============================================================
 * 几何
 * ============================================================ */

/** 保留 nx*x + ny*y <= c 的一侧（凸半平面） */
function clipHalfPlane(poly, nx, ny, c) {
  const out = [];
  const n = poly.length;

  for (let i = 0; i < n; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const d1 = nx * x1 + ny * y1 - c;
    const d2 = nx * x2 + ny * y2 - c;

    if (d1 <= 0) out.push([x1, y1]);
    if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) {
      const t = d1 / (d1 - d2);
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }

  return out;
}

function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function centroid(poly) {  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * 海岸线自相交检测。
 *
 * 为什么值得专门写：手写多边形很容易在某一段折返一下（我画希腊的时候就把
 * 伯罗奔尼撒折成了一个 X）。自相交不会报错，但会让半平面裁剪算错——
 * 结果是画面上出现几块莫名其妙的大三角，而且看面积还是"对"的。
 */
function selfIntersections(poly) {
  const side = (p, q, r) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const cross = (a, b, c, d) => side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);

  const hits = [];
  for (let a = 0; a < poly.length; a += 1) {
    for (let b = a + 2; b < poly.length; b += 1) {
      if (a === 0 && b === poly.length - 1) continue;
      if (cross(poly[a], poly[(a + 1) % poly.length], poly[b], poly[(b + 1) % poly.length])) {
        hits.push([a, b]);
      }
    }
  }
  return hits;
}

/** 去掉相邻重复点（裁剪后经常出现） */
function tidy(poly, minArea = 3) {
  const pts = [];
  for (const p of poly) {
    const q = [round1(p[0]), round1(p[1])];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
  }
  while (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
    else break;
  }
  if (pts.length < 3 || area(pts) < minArea) return null;
  return pts;
}

/* ============================================================
 * 生成
 * ============================================================ */

/** Chaikin 角切割：把折线海岸变成曲线。两轮就够，再多会把半岛削平 */
function chaikin(poly, iterations = 1) {
  let pts = poly;
  for (let it = 0; it < iterations; it += 1) {
    const out = [];
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push([a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25]);
      out.push([a[0] + (b[0] - a[0]) * 0.75, a[1] + (b[1] - a[1]) * 0.75]);
    }
    pts = out;
  }
  return pts;
}

/** 给定一组种子点，算出各自被陆地裁出来的单元 */
function cellsFor(points, land) {
  return points.map((p, i) => {
    const pieces = [];

    for (const landPoly of land) {
      let cell = landPoly;

      for (let j = 0; j < points.length; j += 1) {
        if (j === i) continue;
        const q = points[j];
        const nx = 2 * (q[0] - p[0]);
        const ny = 2 * (q[1] - p[1]);
        const c = q[0] ** 2 + q[1] ** 2 - (p[0] ** 2 + p[1] ** 2);
        cell = clipHalfPlane(cell, nx, ny, c);
        if (cell.length < 3) break;
      }

      const t = cell.length >= 3 ? tidy(cell, 0.5) : null;
      if (t) pieces.push(t);
    }

    return pieces;
  });
}

function largest(pieces) {
  let best = pieces[0];
  for (const p of pieces) if (area(p) > area(best)) best = p;
  return best;
}

const totalArea = (pieces) => pieces.reduce((n, p) => n + area(p), 0);

/** 松弛轮数：4 轮之后格子大小已经比较接近，再多会变得过于规则 */
const LLOYD_ITERATIONS = 5;
/** 海岸线平滑轮数 */
const COAST_SMOOTHING = 2;

function build(spec) {
  const seeds = spec.seeds.map((s) => ({ ...s, at: [s.at[0], s.at[1]] }));

  // 先体检：海岸线自相交会让后面的裁剪静默出错
  for (const [i, poly] of spec.land.entries()) {
    const hits = selfIntersections(poly);
    if (hits.length) {
      const [a, b] = hits[0];
      throw new Error(
        `${spec.id} 的第 ${i} 块陆地自相交：段 ${a}（${poly[a]}→${poly[(a + 1) % poly.length]}）` +
        ` 与段 ${b}（${poly[b]}→${poly[(b + 1) % poly.length]}）`
      );
    }
  }

  // 先把海岸线磨圆，再在它上面切省界——不然省界会跟着锯齿一起折
  const land = spec.land.map((poly) => tidy(chaikin(poly, COAST_SMOOTHING), 0) || poly);

  /* ---------- Lloyd 松弛 ----------
   *
   * 直接拿手放的种子点做 Voronoi，单元面积能差出几十倍：
   * 西伯利亚一格盖过整个法国，而低地国家挤成几条缝。
   * 反复把种子挪到自己单元的形心，格子会逐渐变得等大，
   * 整张图才像地图，而不是一堆大小不一的碎片。
   */
  let pts = seeds.map((s) => [s.at[0], s.at[1]]);

  for (let it = 0; it < LLOYD_ITERATIONS; it += 1) {
    const round = cellsFor(pts, land);
    pts = pts.map((p, i) => (round[i].length ? centroid(largest(round[i])) : p));
  }

  const computed = cellsFor(pts, land);
  const cells = new Map();

  seeds.forEach((s, i) => {
    if (!computed[i].length) {
      throw new Error(`种子 ${s.id} 落在所有陆地之外（${s.at}）`);
    }
    cells.set(s.id, computed[i]);
  });

  /* ---------- 相邻关系：共享 >= 2 个顶点 ---------- */

  const vertexSets = new Map();
  for (const [id, pieces] of cells) {
    const set = new Set();
    for (const piece of pieces) {
      for (const [x, y] of piece) set.add(`${x},${y}`);
    }
    vertexSets.set(id, set);
  }

  const neighbors = new Map(seeds.map((s) => [s.id, new Set()]));
  const ids = seeds.map((s) => s.id);

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = vertexSets.get(ids[i]);
      const b = vertexSets.get(ids[j]);
      let shared = 0;
      for (const v of a) {
        if (b.has(v)) {
          shared += 1;
          if (shared >= 2) break;
        }
      }
      if (shared >= 2) {
        neighbors.get(ids[i]).add(ids[j]);
        neighbors.get(ids[j]).add(ids[i]);
      }
    }
  }

  // 海峡两岸之类无法由几何推出来的邻接，由 spec 手动补
  for (const [a, b] of spec.extraAdjacency || []) {
    if (!neighbors.has(a) || !neighbors.has(b)) {
      throw new Error(`extraAdjacency 指向不存在的省：${a} / ${b}`);
    }
    neighbors.get(a).add(b);
    neighbors.get(b).add(a);
  }

  /* ---------- 输出 ---------- */

  const defs = seeds.map((s) => {
    const pieces = cells.get(s.id);

    // 标签锚点取"面积最大的那一块"的形心：群岛国家才不会被拖到海里
    let biggest = pieces[0];
    for (const p of pieces) if (area(p) > area(biggest)) biggest = p;
    const [cx, cy] = centroid(biggest);

    const nb = [...neighbors.get(s.id)];
    if (!nb.length) throw new Error(`${s.name}（${s.id}）没有任何邻接，会被困死`);

    const out = {
      id: s.id,
      name: s.name,
      owner: s.owner,
      x: round1(cx),
      y: round1(cy),
      vp: s.vp,
      neighbors: nb,
    };

    out.poly = pieces.length === 1 ? pieces[0] : pieces;
    return out;
  });

  return {
    type: 'map',
    viewBox: spec.viewBox,
    // 输出的是磨圆后的海岸线，渲染层直接画它
    land,
    defs,
  };
}

/* ============================================================
 * 入口
 * ============================================================ */

const only = process.argv[2];

for (const [key, spec] of Object.entries(SPECS)) {
  if (only && only !== key) continue;

  const map = build(spec);
  const outPath = path.join(ROOT, spec.out);
  await writeFile(outPath, `${JSON.stringify(map, null, 1)}\n`, 'utf8');

  const verts = map.defs.reduce(
    (n, d) => n + (Array.isArray(d.poly[0][0]) ? d.poly.reduce((m, p) => m + p.length, 0) : d.poly.length),
    0
  );
  const edges = map.defs.reduce((n, d) => n + d.neighbors.length, 0) / 2;

  // 面积离散度：Lloyd 松弛有没有把格子拉匀，看这一个数就知道
  const areasArr = map.defs
    .map((d) => (Array.isArray(d.poly[0][0]) ? d.poly : [d.poly]).reduce((n, r) => n + area(r), 0))
    .sort((a, b) => a - b);
  const med = areasArr[Math.floor(areasArr.length / 2)];

  console.log(
    `${key.padEnd(9)} → ${spec.out}  ${map.defs.length} 个省 / ${edges} 条接壤 / ${verts} 个顶点` +
    `　面积 最小 ${(areasArr[0] / med).toFixed(2)}× 中位 ${med.toFixed(0)} 最大 ${(areasArr[areasArr.length - 1] / med).toFixed(2)}×`
  );
}
