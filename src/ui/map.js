/**
 * map.js —— 战略地图
 *
 * 现在是"政治地图"而不是"节点图"：
 *   陆地轮廓 → 各省多边形 → **国境线**（相邻且不同归属的那条边加粗）
 *   → 争夺中的省打上斜纹 → 标签
 *
 * 为什么国境线要算而不是画：省份归属会随战争改变，国境线是**结果**，
 * 不是数据。相邻两省在多边形里共享同一条边，所有权一变就重新决定这条边画不画。
 *
 * 省份多边形由 tools/build-map.mjs 生成（Voronoi + 海岸线裁剪），
 * 渲染层只认字段：poly（单环或环数组）、x/y（标签锚点）、neighbors。
 */

import { svgEl, clear } from './dom.js';

/* ============================================================
 * 颜色
 * ============================================================ */

function hexToRgb(h) {
  const s = String(h || '#888888').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return `#${rgb
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** 把国家色往陆地底色里揉，保证整张图是低饱和的 */
export function muted(hex, t = 0.55) {
  const a = hexToRgb(hex);
  const b = hexToRgb('#1b2624');
  return rgbToHex(a.map((v, i) => v * (1 - t) + b[i] * t));
}

/* ============================================================
 * 几何小工具
 * ============================================================ */

const ringsOf = (poly) => (Array.isArray(poly?.[0]?.[0]) ? poly : [poly || []]);

function ringPath(ring) {
  let d = '';
  for (let i = 0; i < ring.length; i += 1) {
    d += `${i ? 'L' : 'M'}${ring[i][0]} ${ring[i][1]}`;
  }
  return `${d}Z`;
}

const pathOf = (poly) => ringsOf(poly).map(ringPath).join('');

const edgeKey = (a, b) => {
  const ka = `${a[0]},${a[1]}`;
  const kb = `${b[0]},${b[1]}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/** 一个省所有边的集合（用于和邻居求交，得到共享的那段边界） */
function edgeSet(poly) {
  const set = new Set();
  for (const ring of ringsOf(poly)) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      set.add(edgeKey(a, b));
    }
  }
  return set;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/* ============================================================
 * 构建
 * ============================================================ */

export function buildMap(root, data, onSelect, { mode = 'compact' } = {}) {
  clear(root);

  const meta = data.mapMeta || {};
  const vb = meta.viewBox || [0, 0, 1000, 700];
  root.setAttribute('viewBox', vb.join(' '));
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', '战略地图');

  // 容器跟着数据的宽高比走，否则会上下留两条空带
  if (root.parentElement) {
    root.parentElement.style.aspectRatio = `${vb[2]} / ${vb[3]}`;
  }

  const land = meta.land || [];

  /* ---------- 图案 ---------- */

  const defs = svgEl('defs', {});
  defs.append(svgEl('pattern', {
    id: 'hatch-contested',
    width: 6,
    height: 6,
    patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)',
  }, [
    svgEl('line', {
      x1: 0, y1: 0, x2: 0, y2: 6,
      stroke: '#cf8b81', 'stroke-width': 1.8, opacity: 0.5,
    }),
  ]));
  root.append(defs);

  const gLand = svgEl('g', { class: 'm-land' });
  const gProv = svgEl('g', { class: 'm-prov' });
  const gCoast = svgEl('g', { class: 'm-coast' });
  const gBorder = svgEl('g', { class: 'm-border' });
  const gHatch = svgEl('g', { class: 'm-hatch' });
  const gPin = svgEl('g', { class: 'm-pin' });
  const gLabel = svgEl('g', { class: 'm-label' });
  root.append(gLand, gProv, gCoast, gBorder, gHatch, gPin, gLabel);

  /* ---------- 陆地 ---------- */

  for (const ring of land) {
    gLand.append(svgEl('path', { d: ringPath(ring), class: 'm-landmass' }));
  }

  /* ---------- 省份 ---------- */

  const nodes = new Map();
  const hatches = new Map();
  const labels = new Map();
  const pins = new Map();

  // 国家名先建：它们要躺在省名下面，不能被省名压住
  const countryLabels = new Map();
  if (mode === 'full') {
    for (const c of data.config.countries || []) {
      const t = svgEl('text', { class: 'm-country-label', text: c.name });
      gLabel.append(t);
      countryLabels.set(c.tag, t);
    }
  }

  /** 标签碰撞：大的省先占位，后面的挤不下就不画，宁可少一个也不叠成一坨 */
  const placed = [];
  const bboxArea = (p) => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const ring of ringsOf(p.poly)) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return Math.max(1, (maxX - minX) * (maxY - minY));
  };
  const labelOrder = mode === 'full'
    ? [...data.provinces].sort((a, b) => bboxArea(b) - bboxArea(a)).map((p) => p.id)
    : [];

  for (const p of data.provinces) {
    const d = pathOf(p.poly);

    if (!d) {
      // 没有多边形数据的老地图：退回一个圆
      const r = 9 + Math.sqrt(p.vp || 1) * 3.4;
      const c = svgEl('circle', { cx: p.x, cy: p.y, r, class: 'm-prov-shape', 'data-id': p.id });
      c.addEventListener('click', () => onSelect(p.id));
      gProv.append(c);
      nodes.set(p.id, c);
      continue;
    }

    const path = svgEl('path', { d, class: 'm-prov-shape', 'data-id': p.id });
    path.addEventListener('click', () => onSelect(p.id));
    gProv.append(path);
    nodes.set(p.id, path);

    const hatch = svgEl('path', { d, class: 'm-contested', fill: 'url(#hatch-contested)' });
    hatch.style.opacity = '0';
    gHatch.append(hatch);
    hatches.set(p.id, hatch);
  }

  if (mode === 'full') {
    for (const id of labelOrder) {
      const p = data.provinceById[id];
      // 太挤就不画：宁可少一个名字，也不要叠成一片
      if (bboxArea(p) < 900) continue;
      const tooClose = placed.some((q) => Math.abs(q.x - p.x) < 44 && Math.abs(q.y - p.y) < 17);
      if (tooClose) continue;
      placed.push({ x: p.x, y: p.y });

      const label = svgEl('text', { class: 'm-prov-label', x: p.x, y: p.y, text: p.name });
      gLabel.append(label);
      labels.set(p.id, label);

      const pin = svgEl('g', { class: 'm-pin-g', transform: `translate(${p.x} ${p.y + 12})` });
      pin.append(svgEl('circle', { r: 6.6, class: 'm-pin-dot' }));
      pin.append(svgEl('text', { class: 'm-pin-text', y: 2.4, text: String(p.vp) }));
      gPin.append(pin);
      pins.set(p.id, pin);
    }
  }

  /* ---------- 海岸线（画在省份之上，才有"墨线勾边"的感觉） ---------- */

  for (const ring of land) {
    gCoast.append(svgEl('path', {
      d: ringPath(ring),
      class: 'm-coastline',
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  /* ---------- 国境线 ---------- */

  const borders = new Map();
  const seen = new Set();

  for (const p of data.provinces) {
    for (const nid of p.neighbors || []) {
      const k = pairKey(p.id, nid);
      if (seen.has(k)) continue;
      seen.add(k);

      const q = data.provinceById[nid];
      if (!q || !q.poly || !p.poly) continue;

      const shared = [];
      const qEdges = edgeSet(q.poly);
      for (const ring of ringsOf(p.poly)) {
        for (let i = 0; i < ring.length; i += 1) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          if (qEdges.has(edgeKey(a, b))) shared.push(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`);
        }
      }
      if (!shared.length) continue;

      const el = svgEl('path', {
        d: shared.join(''),
        class: 'm-border-line',
        'vector-effect': 'non-scaling-stroke',
      });
      gBorder.append(el);
      borders.set(k, { el, a: p.id, b: nid });
    }
  }

  return {
    root,
    nodes,
    labels,
    pins,
    hatches,
    borders,
    countryLabels,
    mode,
    provinceList: data.provinces,
  };
}

/* ============================================================
 * 刷新
 * ============================================================ */

export function refreshMap(refs, state, data) {
  const ownerCache = refs._owner || (refs._owner = new Map());
  const ownerNow = new Map();

  for (const p of refs.provinceList) {
    const ps = state.provinces?.[p.id];
    const ownerTag = ps?.owner ?? p.owner;
    ownerNow.set(p.id, ownerTag);

    const el = refs.nodes.get(p.id);
    if (!el) continue;

    if (ownerCache.get(p.id) !== ownerTag) {
      ownerCache.set(p.id, ownerTag);
      const owner = state.countries[ownerTag];
      el.setAttribute('fill', owner ? muted(owner.color) : '#1b2624');
      el.dataset.owner = ownerTag || '';
    }

    const contested = Boolean(ps?.contestedBy);
    const selected = state.selectedProvince === p.id;

    if (el.classList.contains('is-selected') !== selected) el.classList.toggle('is-selected', selected);
    if (el.classList.contains('is-contested') !== contested) el.classList.toggle('is-contested', contested);

    const hatch = refs.hatches.get(p.id);
    if (hatch) {
      const next = contested
        ? (0.3 + Math.min(0.6, ((ps.contest || 0) / 100) * 0.6)).toFixed(2)
        : '0';
      if (hatch.style.opacity !== next) hatch.style.opacity = next;
    }
  }

  // 国境线：相邻两省归属不同才画
  for (const { el, a, b } of refs.borders.values()) {
    const on = ownerNow.get(a) !== ownerNow.get(b);
    if (el.classList.contains('is-on') !== on) el.classList.toggle('is-on', on);
  }

  // 国家名：只在归属变化时重排
  if (refs.countryLabels.size) {
    const sig = [...ownerNow.values()].join(',');
    if (refs._labelSig !== sig) {
      refs._labelSig = sig;
      positionCountryLabels(refs, state, ownerNow);
    }
  }
}

function positionCountryLabels(refs, state, ownerNow) {
  const acc = new Map();

  for (const p of refs.provinceList) {
    const tag = ownerNow.get(p.id);
    if (!tag) continue;
    const cur = acc.get(tag) || { x: 0, y: 0, n: 0 };
    cur.x += p.x;
    cur.y += p.y;
    cur.n += 1;
    acc.set(tag, cur);
  }

  for (const [tag, el] of refs.countryLabels) {
    const a = acc.get(tag);
    // 只有一块地的国家不画国名：会和省名叠在一起，还容易被误读成省名
    if (!a || a.n < 3) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = '';
    el.setAttribute('x', a.x / a.n);
    el.setAttribute('y', a.y / a.n);
    el.textContent = state.countries[tag]?.name || tag;
  }
}
