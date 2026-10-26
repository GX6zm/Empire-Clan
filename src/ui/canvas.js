/**
 * canvas.js —— 国策画布的缩放与拖拽
 *
 * 刻意不用原生滚动条：
 *   - 滚动条会占掉画布宽度，而且缩放后位置会漂
 *   - 用 transform 平移缩放，缩放时能精确锚定鼠标下的那一点
 *
 * 焦点环的粗细也挂在这里：节点是 HTML，会跟着 scale 一起放大，
 * 所以 CSS 里用 calc(2px / var(--zoom)) 把环的视觉宽度拉回恒定。
 */

const MIN_SCALE = 0.4;
const MAX_SCALE = 1.9;
/** 允许内容被拖出视口的余量，避免"拖丢了" */
const OVERPAN = 140;

export function createCanvas({ viewport, tree, zoomLabel, toolsEl, onScale }) {
  let scale = 1;
  let tx = 0;
  let ty = 0;

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let lastPointer = 0;

  function clampAxis(t, contentSize, viewSize) {
    const min = viewSize - contentSize - OVERPAN;
    const max = OVERPAN;
    if (min > max) return (viewSize - contentSize) / 2;
    return Math.min(max, Math.max(min, t));
  }

  /**
   * 内容尺寸取**渲染后**的包围盒再除掉缩放，而不是 offsetWidth。
   * 原因：fit/居中可能在布局还没稳定时被调用（比如详情面板刚收起，
   * 画布宽度还在变），offsetWidth 会读到旧值，算出来的比例是错的。
   */
  function contentBox() {
    const rect = tree.getBoundingClientRect();
    const k = scale || 1;
    return { w: rect.width / k, h: rect.height / k };
  }

  function apply(clamp = true) {
    if (clamp) {
      const { w, h } = contentBox();
      tx = clampAxis(tx, w * scale, viewport.clientWidth);
      ty = clampAxis(ty, h * scale, viewport.clientHeight);
    }
    tree.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    tree.style.setProperty('--zoom', String(scale));
    if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    onScale?.(scale);
  }

  /** 以视口内某点为锚缩放 —— 鼠标指向的节点不会跑掉 */
  function zoomAt(cx, cy, factor) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (Math.abs(next - scale) < 1e-4) return;
    const ratio = next / scale;
    tx = cx - (cx - tx) * ratio;
    ty = cy - (cy - ty) * ratio;
    scale = next;
    apply();
  }

  function zoomBy(factor) {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
  }

  function setScale(next, anchor) {
    const cx = anchor?.x ?? viewport.clientWidth / 2;
    const cy = anchor?.y ?? viewport.clientHeight / 2;
    zoomAt(cx, cy, next / scale);
  }

  /** 让整棵树落进视口（留一点边距） */
  function fit() {
    const { w, h } = contentBox();
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const pad = 72;
    const next = Math.min((vw - pad) / Math.max(1, w), (vh - pad) / Math.max(1, h));
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    tx = (vw - w * scale) / 2;
    ty = (vh - h * scale) / 2;
    apply(false);
  }

  /** 把树坐标系里的一点移到视口中央 */
  function centerOn(x, y, { animate = true } = {}) {
    tx = viewport.clientWidth / 2 - x * scale;
    ty = viewport.clientHeight / 2 - y * scale;
    if (animate) {
      tree.style.transition = 'transform .26s cubic-bezier(.2,.7,.3,1)';
      apply(false);
      window.setTimeout(() => { tree.style.transition = ''; }, 280);
    } else {
      apply(false);
    }
  }

  /* ---------- 指针拖拽 ---------- */

  let captured = false;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    captured = false;
    startX = e.clientX;
    startY = e.clientY;
    lastPointer = e.pointerId;
    // 这里**绝对不能**立刻 setPointerCapture。
    // 一旦捕获，后续的 pointerup 和紧随其后的 click 都会被重定向到 viewport，
    // 节点按钮上的 onclick 永远收不到——表现就是"国策点不上"。
    // 只有在确认"这是拖动"之后才捕获。
  }

  function onPointerMove(e) {
    if (!dragging || e.pointerId !== lastPointer) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      captured = true;
      viewport.setPointerCapture?.(e.pointerId);
      viewport.classList.add('is-panning');
    }

    tx += dx;
    ty += dy;
    startX = e.clientX;
    startY = e.clientY;
    apply();
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    viewport.classList.remove('is-panning');

    if (captured) {
      try { viewport.releasePointerCapture?.(e.pointerId); } catch { /* 已释放 */ }
      captured = false;
    }

    // 拖拽结束时吃掉紧随其后的 click，否则"拖动 = 选中节点"
    if (moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      viewport.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => viewport.removeEventListener('click', swallow, { capture: true }), 0);
    }
    moved = false;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0016);
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
  }

  function onToolClick(e) {
    const btn = e.target.closest?.('[data-zoom]');
    if (!btn) return;
    const act = btn.dataset.zoom;
    if (act === 'in') zoomBy(1.16);
    else if (act === 'out') zoomBy(1 / 1.16);
    else if (act === 'fit') fit();
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  toolsEl?.addEventListener('click', onToolClick);

  apply(false);

  return {
    apply,
    fit,
    centerOn,
    zoomBy,
    setScale,
    getScale: () => scale,
    getTransform: () => ({ scale, tx, ty }),
  };
}
