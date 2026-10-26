/**
 * tree.js —— 国策树渲染
 *
 * 只构建一次 DOM，之后每帧只改 class / data-state 与进度条宽度。
 *
 * 节点状态不靠"变色"区分，每种状态都有独立的**形状线索**：
 *   locked     虚线边框 + 锁形图标 + 最低对比
 *   available  纸面 + 铜线边框 + 左上角 L 形角标（唯一的"现在可以做"信号）
 *   current    纸面 + 铜线 + 底部暗红进度条
 *   completed  发暗的纸面 + 右上角倾斜的暗红印章
 *   selected   实线铜环；键盘焦点是虚线铜环 —— 环的形状不同，不会混淆
 */

import { el, svgEl, clear } from './dom.js';
import { focusState, focusAvailability, FOCUS_STATE } from '../core/rules.js';

export const TREE_GEOM = {
  CELL_W: 176,
  CELL_H: 126,
  NODE_W: 148,
  NODE_H: 88,
  PAD_X: 64,
  PAD_Y: 52,
};

const LOCK_SVG =
  '<svg viewBox="0 0 12 13" aria-hidden="true">' +
  '<rect x="2" y="5.8" width="8" height="6.2" rx="1"/>' +
  '<path d="M4 5.8V4a2 2 0 0 1 4 0v1.8"/>' +
  '</svg>';

const STAMP_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
  '<path d="M6.8 12.6l3.4 3.4 7-7.2" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const STATE_LABEL = {
  [FOCUS_STATE.COMPLETED]: '已完成',
  [FOCUS_STATE.CURRENT]: '进行中',
  [FOCUS_STATE.AVAILABLE]: '可开始',
  [FOCUS_STATE.LOCKED]: '未解锁',
  [FOCUS_STATE.BLOCKED]: '受阻',
};

export function buildTree(container, data, { tag, onSelect }) {
  clear(container);

  const list = data.focusesByTag?.[tag] || data.focuses.filter((f) => f.tag === tag);
  const { CELL_W, CELL_H, NODE_W, NODE_H, PAD_X, PAD_Y } = TREE_GEOM;

  const maxX = Math.max(...list.map((f) => f.x ?? 0), 0);
  const maxY = Math.max(...list.map((f) => f.y ?? 0), 0);

  const width = PAD_X * 2 + (maxX + 1) * CELL_W;
  const height = PAD_Y * 2 + (maxY + 1) * CELL_H;

  container.style.width = `${width}px`;
  container.style.height = `${height}px`;

  const linksSvg = svgEl('svg', { class: 'links', width, height, viewBox: `0 0 ${width} ${height}` });
  container.append(linksSvg);

  const posOf = (f) => ({
    left: PAD_X + (f.x ?? 0) * CELL_W,
    top: PAD_Y + (f.y ?? 0) * CELL_H,
  });

  /* ---------- 连线 ---------- */

  const links = new Map();

  for (const f of list) {
    const to = posOf(f);
    const x2 = to.left + NODE_W / 2;
    const y2 = to.top;

    const drawFrom = (fromId, anyOf) => {
      const from = data.focusById[fromId];
      if (!from) return;
      const p = posOf(from);
      const x1 = p.left + NODE_W / 2;
      const y1 = p.top + NODE_H;

      let d;
      if (Math.abs(x1 - x2) < 1) {
        d = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else {
        const ym = y1 + Math.max(20, (y2 - y1) * 0.5);
        d = `M ${x1} ${y1} L ${x1} ${ym} L ${x2} ${ym} L ${x2} ${y2}`;
      }

      const path = svgEl('path', {
        d,
        class: anyOf ? 'any' : '',
        // 线条不跟着缩放变粗/变细，缩小时也保持清晰
        'vector-effect': 'non-scaling-stroke',
      });
      linksSvg.append(path);
      links.set(`${fromId}->${f.id}`, path);
    };

    for (const p of f.prereqs || []) drawFrom(p, false);
    for (const p of f.prereqs_any || []) drawFrom(p, true);
  }

  /* ---------- 节点 ---------- */

  const nodes = new Map();

  for (const f of list) {
    const { left, top } = posOf(f);

    const btn = el('button', {
      class: 'focus',
      'data-id': f.id,
      'data-state': FOCUS_STATE.LOCKED,
      style: { left: `${left}px`, top: `${top}px` },
      title: f.name,
      'aria-label': f.name,
      onclick: () => onSelect(f.id),
    }, [
      el('span', { class: 'focus-icon', 'aria-hidden': 'true', text: f.icon || '◆' }),
      el('span', { class: 'focus-name', text: f.name }),
      el('span', { class: 'focus-meta', 'aria-hidden': 'true', text: `${f.cost} 天` }),
      el('span', { class: 'focus-lock', html: LOCK_SVG }),
      el('span', { class: 'focus-stamp', html: STAMP_SVG }),
      el('span', { class: 'focus-bar', 'aria-hidden': 'true' }, [el('i')]),
    ]);

    container.append(btn);
    nodes.set(f.id, btn);
  }

  return { nodes, links, focuses: list, width, height };
}

/** 只更新状态，不重建 DOM */
export function refreshTree(refs, state, data, selectedId = null) {
  const country = state.countries[state.playerTag];
  if (!country) return;

  const list = refs.focuses || [];
  const states = new Map();

  for (const f of list) {
    states.set(f.id, focusState(state, data, country, f));
  }

  for (const f of list) {
    const node = refs.nodes.get(f.id);
    if (!node) continue;

    const st = states.get(f.id);

    if (node.dataset.state !== st) {
      node.dataset.state = st;

      // 状态变化时才去算"为什么锁着"，避免每帧都跑一遍求值
      const label = STATE_LABEL[st] || st;
      let hint = '';
      if (st === FOCUS_STATE.LOCKED || st === FOCUS_STATE.BLOCKED) {
        hint = focusAvailability(state, data, country, f).reason || '';
      }
      node.title = hint ? `${f.name} · ${label}\n${hint}` : `${f.name} · ${label}`;
      node.setAttribute('aria-label', `${f.name}，${label}，需 ${f.cost} 天`);
      node.setAttribute('aria-pressed', st === FOCUS_STATE.COMPLETED ? 'true' : 'false');

      const meta = node.querySelector('.focus-meta');
      if (meta) {
        meta.textContent = st === FOCUS_STATE.CURRENT
          ? `${Math.floor(country.focuses.progress)}/${f.cost} 天`
          : `${f.cost} 天`;
      }
    }

    if (node.classList.contains('is-selected') !== (f.id === selectedId)) {
      node.classList.toggle('is-selected', f.id === selectedId);
    }

    if (st === FOCUS_STATE.CURRENT) {
      const bar = node.querySelector('.focus-bar > i');
      if (bar) {
        const p = Math.min(1, country.focuses.progress / Math.max(1, f.cost));
        bar.style.width = `${(p * 100).toFixed(1)}%`;
      }
      const meta = node.querySelector('.focus-meta');
      if (meta) meta.textContent = `${Math.floor(country.focuses.progress)}/${f.cost} 天`;
    }
  }

  for (const [key, path] of refs.links) {
    const [fromId, toId] = key.split('->');
    const fromState = states.get(fromId);
    const toState = states.get(toId);
    const done = fromState === FOCUS_STATE.COMPLETED && toState === FOCUS_STATE.COMPLETED;
    const avail =
      fromState === FOCUS_STATE.COMPLETED &&
      (toState === FOCUS_STATE.AVAILABLE || toState === FOCUS_STATE.CURRENT);

    if (path.classList.contains('done') !== done) path.classList.toggle('done', done);
    if (path.classList.contains('avail') !== avail) path.classList.toggle('avail', avail);
  }
}

/** 节点在树坐标系里的中心点，供画布居中 */
export function nodeCenter(refs, focusId) {
  const node = refs.nodes.get(focusId);
  if (!node) return null;
  return {
    x: node.offsetLeft + TREE_GEOM.NODE_W / 2,
    y: node.offsetTop + TREE_GEOM.NODE_H / 2,
  };
}

/** 兼容旧调用：现在由画布负责居中 */
export function scrollToFocus(refs, focusId, canvas) {
  const c = nodeCenter(refs, focusId);
  if (c && canvas) canvas.centerOn(c.x, c.y);
}
