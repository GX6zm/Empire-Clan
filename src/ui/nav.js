/**
 * nav.js —— 左侧导航轨
 *
 * 用"档案索引号 + 名称"代替图标：这类游戏的侧栏只有六个固定入口，
 * 画一套识别度不足的线性图标，不如直接编号来得清楚，也更像档案柜。
 */

import { el, clear } from './dom.js';

export const NAV_ITEMS = [
  { id: 'focus', idx: '01', label: '国策', view: 'focus' },
  { id: 'politics', idx: '02', label: '政治', view: 'dossier' },
  { id: 'economy', idx: '03', label: '经济', view: 'dossier' },
  { id: 'diplomacy', idx: '04', label: '外交', view: 'dossier' },
  { id: 'military', idx: '05', label: '军事', view: 'dossier' },
  { id: 'mods', idx: '06', label: 'MOD', view: null },
];

export function buildNav(container, { onSelect, version = '?' }) {
  clear(container);

  const items = new Map();

  for (const item of NAV_ITEMS) {
    const btn = el('button', {
      class: 'nav-item',
      'data-nav': item.id,
      type: 'button',
      onclick: () => onSelect(item),
    }, [
      el('span', { class: 'ni-idx', 'aria-hidden': 'true', text: item.idx }),
      el('span', { class: 'ni-label', text: item.label }),
    ]);
    container.append(btn);
    items.set(item.id, btn);
  }

  container.append(el('div', { class: 'nav-foot' }, [
    el('div', { text: 'FOCUS ENGINE' }),
    el('div', { text: `v${version}` }),
  ]));

  return {
    items,
    setActive(id) {
      for (const [key, btn] of items) {
        const on = key === id;
        btn.classList.toggle('is-active', on);
        if (on) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      }
    },
  };
}
