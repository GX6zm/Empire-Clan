/**
 * plot-map.mjs —— 在地图 JSON 上打一张 ASCII 预览
 *
 * 为什么需要它：手写海岸线的错误（自相交、半岛折反、坐标算错）在浏览器里
 * 只表现为"几块莫名其妙的大三角"，很难判断是哪一段写错了。
 * 在终端里打一张 90×36 的字符图，十秒钟就能看出形状对不对。
 *
 *   node tools/plot-map.mjs            # 两张都画
 *   node tools/plot-map.mjs eastasia
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MAPS = {
  europe: 'data/base/map.json',
  eastasia: 'data/mods/celestial-revival/map.json',
};

const W = 96;
const H = 40;

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

async function plot(key, file) {
  const map = JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
  const [vx, vy, vw, vh] = map.viewBox;

  const grid = Array.from({ length: H }, () => Array(W).fill(' '));

  // 陆地
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const x = vx + ((c + 0.5) / W) * vw;
      const y = vy + ((r + 0.5) / H) * vh;
      if (map.land.some((poly) => inPoly(x, y, poly))) grid[r][c] = '·';
    }
  }

  // 省份：用它的首字母占位，顺带检查种子落点是否在陆地上
  const outside = [];
  for (const d of map.defs) {
    const c = Math.floor(((d.x - vx) / vw) * W);
    const r = Math.floor(((d.y - vy) / vh) * H);
    if (r < 0 || r >= H || c < 0 || c >= W) continue;
    if (grid[r][c] === ' ') outside.push(d.name);
    grid[r][c] = '█';
  }

  console.log(`\n── ${key} ── ${map.defs.length} 省`);
  console.log(grid.map((row) => row.join('')).join('\n'));
  if (outside.length) console.log(`⚠ 落在陆地图之外的省会：${outside.join('、')}`);
}

const only = process.argv[2];
for (const [key, file] of Object.entries(MAPS)) {
  if (only && only !== key) continue;
  await plot(key, file);
}
