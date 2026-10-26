/**
 * hud.js —— 顶栏、战略态势面板、国家档案、日志
 *
 * 这一层只做"把状态翻译成可读的东西"，不判断规则。
 */

import { el, clear, fmt, fmtInt } from './dom.js';
import { dateStr } from '../core/describe.js';
import { aggregateModifiers, modifierEntries, formatModifier } from '../core/modifiers.js';
import { armyPower, truceDaysLeft, frontCount } from '../core/war.js';
import { findWar, warScore } from '../core/peace.js';

/* ============================================================
 * 顶部状态栏
 * ============================================================ */

export function buildHud({ hudEl, toolbarEl, handlers }) {
  clear(hudEl);
  clear(toolbarEl);

  const date = el('div', { class: 'hud-date', text: '1936.01.01' });
  hudEl.append(date);

  const mk = (key, cls = '') => {
    const v = el('span', { class: `v ${cls}`.trim(), text: '—' });
    hudEl.append(el('div', { class: 'hud-item' }, [
      el('span', { class: 'k', text: key }),
      v,
    ]));
    return v;
  };

  const refs = {
    date,
    pp: mk('政治点数', 'gold'),
    industry: mk('工业产能'),
    stability: mk('稳定度'),
    war: mk('战争支持'),
    divisions: mk('师'),
  };

  /* ---------- 速度 ---------- */
  const speedLabels = ['Ⅱ', '1', '2', '3', '4', '5'];
  const speedBtns = [];
  const group = el('div', { class: 'speed-group', role: 'group', 'aria-label': '时间速度' });

  speedLabels.forEach((label, i) => {
    const b = el('button', {
      class: 'speed-btn',
      type: 'button',
      title: i === 0 ? '暂停' : `速度 ${i}`,
      'aria-pressed': i === 0 ? 'true' : 'false',
      text: label,
      onclick: () => handlers.onSpeed(i),
    });
    speedBtns.push(b);
    group.append(b);
  });
  toolbarEl.append(group);

  toolbarEl.append(el('span', { class: 'sep', 'aria-hidden': 'true' }));

  const sys = (text, short, title, fn) =>
    el('button', { class: 'sys-btn', type: 'button', title, 'data-short': short, text, onclick: fn });

  toolbarEl.append(sys('存档', '存', '写入浏览器本地存档', handlers.onSave));
  toolbarEl.append(sys('读档', '读', '从本地存档读取', handlers.onLoad));
  toolbarEl.append(sys('导出', '出', '下载存档 JSON', handlers.onExport));
  toolbarEl.append(sys('导入', '入', '从 JSON 文件读取存档', handlers.onImport));

  Object.assign(refs, { speedBtns });
  return refs;
}

export function refreshHud(refs, state, data) {
  const c = state.countries[state.playerTag];
  if (!c) return;

  const nation = document.getElementById('nation');
  const flag = document.getElementById('nation-flag');
  const nameEl = document.getElementById('nation-name');
  const tagEl = document.getElementById('nation-tag');

  if (nation && nameEl && nameEl.textContent !== c.name) {
    nameEl.textContent = c.name;
    tagEl.textContent = c.tag;
    flag.style.background = c.color;
    nation.title = `${c.name}（${c.tag}）`;
  }

  refs.date.textContent = dateStr(state.date);
  refs.pp.textContent = fmt(c.political_power, 1);
  refs.industry.textContent = fmtInt(c.factories);
  refs.stability.textContent = `${Math.round(c.stability)}%`;
  refs.war.textContent = `${Math.round(c.war_support)}%`;
  refs.divisions.textContent = fmt(c.divisions || 0, 1);

  refs.stability.classList.toggle('danger', c.stability < 30);
  refs.war.classList.toggle('danger', c.war_support < 15);

  refs.speedBtns.forEach((b, i) => {
    const on = i === state.speed;
    if (b.getAttribute('aria-pressed') !== String(on)) {
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  });
}

/* ============================================================
 * 战略态势面板（画布内浮层）
 * ============================================================ */

export function renderSituation(container, state, data) {
  clear(container);

  const province = state.selectedProvince ? data.provinceById[state.selectedProvince] : null;
  const tag = province
    ? (state.provinces?.[province.id]?.owner ?? province.owner)
    : state.playerTag;
  const c = state.countries[tag];
  if (!c) return;

  const isPlayer = tag === state.playerTag;
  const player = state.countries[state.playerTag];

  /* ---------- 国名行 ---------- */
  container.append(el('div', { class: 'sit-nation' }, [
    el('span', { class: 'sit-flag', style: { background: c.color }, 'aria-hidden': 'true' }),
    el('span', { class: 'sit-name', text: c.name }),
    el('span', { class: 'sit-tag', text: `${c.tag} · ${isPlayer ? '你' : 'AI'}` }),
  ]));

  if (province) {
    container.append(el('div', { class: 'sit-kv', style: { marginBottom: '7px' } }, [
      el('span', { class: 'k', text: `已选区域：${province.name}` }),
      el('button', {
        class: 'btn',
        type: 'button',
        style: { padding: '1px 7px', fontSize: '10px' },
        'data-act': 'clear-province',
        text: '取消',
      }),
    ]));
  }

  /* ---------- 四个数 ---------- */
  const kv = (k, v) => el('div', { class: 'sit-kv' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v }),
  ]);

  container.append(el('div', { class: 'sit-grid' }, [
    kv('领土', `${provincesOwned(state, tag)} 块`),
    kv('师', fmt(c.divisions || 0, 1)),
    kv('工厂', fmtInt(c.factories)),
    kv('稳定', `${Math.round(c.stability)}%`),
  ]));

  /* ---------- 关系 ---------- */
  if (c.defeated) {
    container.append(el('div', { class: 'sit-note', text: isPlayer ? '本国已崩盘' : '该国已崩盘' }));
    return;
  }

  if (isPlayer) {
    if (c.atWarWith.length) {
      const names = c.atWarWith.map((t) => state.countries[t]?.name || t).join('、');
      container.append(el('div', { class: 'sit-note', text: `交战中：${names}` }));
    } else {
      container.append(el('div', { class: 'sit-note', text: '当前没有战事' }));
    }
    return;
  }

  container.append(buildRelation(c, state, data, player));
}

function buildRelation(country, state, data, player) {
  const box = el('div', { class: 'sit-actions' });
  const atWar = player.atWarWith.includes(country.tag);

  // 注意：按钮只带 data-act，事件委托挂在不会被重建的容器上。
  // 这个面板每 180ms 重建一次，绑在按钮上的 onclick 会被换掉。
  if (atWar) {
    const war = findWar(state, state.playerTag, country.tag);
    const score = war ? warScore(state, data, war, state.playerTag) : 0;
    const other = war ? warScore(state, data, war, country.tag) : 0;

    box.append(el('div', { class: 'war-score' }, [
      el('span', { class: 'ws-k', text: '战争分数' }),
      el('span', { class: 'ws-v' }, [
        el('b', { class: score >= 0 ? 'pos' : 'neg', text: signed(score) }),
        document.createTextNode(' / '),
        el('b', { class: other >= 0 ? 'pos' : 'neg', text: signed(other) }),
      ]),
    ]));

    box.append(el('div', { class: 'ws-track' }, [
      el('div', { class: 'ws-mid' }),
      el('div', {
        class: `ws-fill ${score >= 0 ? 'pos' : 'neg'}`,
        style: score >= 0
          ? { left: '50%', width: `${Math.min(50, Math.abs(score) / 2)}%` }
          : { right: '50%', width: `${Math.min(50, Math.abs(score) / 2)}%` },
      }),
    ]));

    box.append(el('button', {
      class: 'btn is-primary',
      type: 'button',
      'data-act': 'negotiate',
      'data-tag': country.tag,
      text: `与 ${country.name} 和谈`,
    }));

    return box;
  }

  const mine = armyPower(state, data, player);
  const theirs = armyPower(state, data, country);
  box.append(el('div', { class: 'sit-note', text: `战力 ${mine.toFixed(1)} : ${theirs.toFixed(1)}` }));

  const truce = truceDaysLeft(state, state.playerTag, country.tag);
  if (truce > 0) {
    box.append(el('div', { class: 'sit-note', text: `停战协议还剩 ${truce} 天` }));
  } else if (!player.defeated) {
    box.append(el('button', {
      class: 'btn danger',
      type: 'button',
      'data-act': 'war',
      'data-tag': country.tag,
      text: `向 ${country.name} 宣战`,
    }));
  }

  return box;
}

/* ============================================================
 * 国家档案（政治 / 经济 / 外交 / 军事）
 * ============================================================ */

export function renderDossier(container, state, data, section = 'politics') {
  clear(container);

  const c = state.countries[state.playerTag];
  if (!c) return;

  const head = el('div', { class: 'dossier-head' }, [
    el('span', { class: 'idx', text: sectionIdx(section) }),
    el('span', { class: 'dossier-title', text: c.name }),
    el('span', { class: 'dossier-sub', text: `${c.tag} · ${dateStr(state.date)}` }),
  ]);
  container.append(head);

  const block = (id, title, tail, body) => {
    const b = el('div', {
      class: `dossier-block${id === section ? ' is-highlight' : ''}`,
    }, [
      el('div', { class: 'sec' }, [
        el('span', { class: 'sec-title', text: title }),
        tail ? el('span', { class: 'sec-tail', text: tail }) : null,
      ]),
      body,
    ]);
    return b;
  };

  /* ---------- 政治 ---------- */
  const mods = aggregateModifiers(data, c);
  const modEntries = modifierEntries(mods);

  container.append(block('politics', '政治概况', `${Math.round(c.political_power)} 点`,
    el('div', {}, [
      el('div', { class: 'stat-grid' }, [
        stat('政治点数', fmt(c.political_power, 1)),
        stat('稳定度', `${Math.round(c.stability)}%`),
        stat('战争支持', `${Math.round(c.war_support)}%`),
        stat('交战对手', `${c.atWarWith.length}`),
      ]),
      modEntries.length
        ? el('div', { style: { marginTop: '12px' } }, [
          el('div', { class: 'dt-section', text: '修正合计' }),
          el('div', { class: 'idea-mods' }, modEntries.map((m) =>
            el('span', {
              class: m.value > 0 ? 'mod-pos' : 'mod-neg',
              text: `${m.label} ${formatModifier(m.key, m.value)}`,
            })
          )),
        ])
        : null,
    ])
  ));

  /* ---------- 经济 ---------- */
  const growth = 0.22 * (1 + (mods.factory_output || 0));
  const manpower = (1 + c.factories * 0.12) * (1 + (mods.manpower_gain || 0));

  container.append(block('economy', '经济概况', `${fmtInt(c.factories)} 工厂`,
    el('div', {}, [
      el('div', { class: 'stat-grid' }, [
        stat('工厂', fmtInt(c.factories)),
        stat('人力', fmt(c.manpower, 1)),
        stat('月增工厂', `+${growth.toFixed(2)}`),
        stat('月增人力', `+${manpower.toFixed(1)}`),
      ]),
      el('div', { class: 'bar' }, [
        el('div', { class: 'bar-head' }, [
          el('span', { text: c.focuses.current ? `当前国策：${data.focusById[c.focuses.current]?.name || c.focuses.current}` : '当前国策：空闲' }),
          el('span', { text: c.focuses.current ? `${Math.floor(c.focuses.progress)}/${data.focusById[c.focuses.current]?.cost ?? '?'} 天` : '' }),
        ]),
        el('div', { class: 'bar-track' }, [
          el('div', {
            class: 'bar-fill',
            style: { width: progressPct(c, data) },
          }),
        ]),
      ]),
    ])
  ));

  /* ---------- 外交 ---------- */
  const wars = c.atWarWith.slice();

  const dipBody = el('div');
  if (!wars.length) {
    dipBody.append(el('div', { class: 'sit-note', text: '没有正在进行中的战争' }));
  } else {
    const table = el('table', { class: 'dtable' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '对手' }),
        el('th', { text: '战争分数' }),
        el('th', { text: '领土' }),
        el('th', { text: '' }),
      ])]),
    ]);
    const tbody = el('tbody');
    for (const tag of wars) {
      const other = state.countries[tag];
      if (!other) continue;
      const war = findWar(state, c.tag, tag);
      const score = war ? warScore(state, data, war, c.tag) : 0;
      tbody.append(el('tr', {}, [
        el('td', { class: 'name', text: other.name }),
        el('td', { class: 'num ' + (score >= 0 ? 'pos' : 'neg'), text: signed(score) }),
        el('td', { class: 'num', text: `${provincesOwned(state, tag)} 块` }),
        el('td', {}, [
          el('button', {
            class: 'btn',
            type: 'button',
            style: { padding: '2px 8px', fontSize: '11px' },
            'data-act': 'negotiate',
            'data-tag': tag,
            text: '和谈',
          }),
        ]),
      ]));
    }
    table.append(tbody);
    dipBody.append(table);
  }

  const truces = Object.entries(state.truces || {})
    .map(([key, until]) => {
      const left = until - (state.elapsedDays || 0);
      return left > 0 ? `停战 ${key.replace('|', ' / ')}：还有 ${left} 天` : null;
    })
    .filter(Boolean);

  if (truces.length) {
    dipBody.append(el('div', { class: 'sit-note', style: { marginTop: '9px' }, text: truces.join('　·　') }));
  }

  container.append(block('diplomacy', '外交态势', wars.length ? `${wars.length} 场战争` : '和平', dipBody));

  /* ---------- 军事 ---------- */
  const power = armyPower(state, data, c);
  const fronts = frontCount(state, data, c.tag);

  container.append(block('military', '军事概况', `${fmt(c.divisions || 0, 1)} 师`,
    el('div', { class: 'stat-grid' }, [
      stat('全军战力', power.toFixed(1)),
      stat('战线数', String(fronts)),
      stat('战力 / 战线', (power / Math.pow(Math.max(1, fronts), 0.35)).toFixed(1)),
      stat('陆军修正', formatModifier('army_strength', mods.army_strength || 0)),
    ])
  ));

  /* ---------- 国家精神（整宽） ---------- */
  container.append(el('div', { class: 'dossier-block span2' }, [buildIdeaBlock(data, c)]));
}

function stat(k, v) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v }),
  ]);
}

function sectionIdx(section) {
  return { politics: '02', economy: '03', diplomacy: '04', military: '05' }[section] || '02';
}

function progressPct(c, data) {
  const id = c.focuses.current;
  if (!id) return '0%';
  const f = data.focusById[id];
  if (!f) return '0%';
  return `${Math.min(100, (c.focuses.progress / Math.max(1, f.cost)) * 100).toFixed(1)}%`;
}

function provincesOwned(state, tag) {
  let n = 0;
  for (const p of Object.values(state.provinces || {})) if (p.owner === tag) n += 1;
  return n;
}

function signed(n) {
  return `${n > 0 ? '+' : ''}${n}`;
}

/* ============================================================
 * 国家精神
 * ============================================================ */

export function buildIdeaBlock(data, country) {
  const box = el('div', { class: 'ideas' });

  box.append(el('div', { class: 'ideas-head' }, [
    el('span', { text: '国家精神' }),
    el('span', { class: 'ideas-count', text: String(country.ideas.length) }),
  ]));

  if (!country.ideas.length) {
    box.append(el('div', { class: 'ideas-empty', text: '暂无（完成国策可获得）' }));
    return box;
  }

  for (const id of country.ideas) {
    const idea = data.ideaById?.[id];
    if (!idea) {
      box.append(el('div', { class: 'idea' }, [
        el('span', { class: 'idea-icon', 'aria-hidden': 'true', text: '!' }),
        el('span', { class: 'idea-name', text: `${id}（未定义）` }),
      ]));
      continue;
    }

    const mods = modifierEntries(idea.modifiers || {});
    const modLine = el('div', { class: 'idea-mods' });
    for (const m of mods) {
      modLine.append(el('span', {
        class: m.value > 0 ? 'mod-pos' : 'mod-neg',
        text: `${m.label} ${formatModifier(m.key, m.value)}`,
      }));
    }

    box.append(el('div', { class: 'idea', title: idea.desc || '' }, [
      el('div', { class: 'idea-top' }, [
        el('span', { class: 'idea-icon', 'aria-hidden': 'true', text: idea.icon || '◆' }),
        el('span', { class: 'idea-name', text: idea.name || id }),
      ]),
      modLine,
    ]));
  }

  const total = aggregateModifiers(data, country);
  const totalEntries = modifierEntries(total);
  if (totalEntries.length) {
    const sum = el('div', { class: 'ideas-total' });
    sum.append(el('span', { class: 'k', text: '合计' }));
    for (const m of totalEntries) {
      sum.append(el('span', {
        class: m.value > 0 ? 'mod-pos' : 'mod-neg',
        text: `${m.label} ${formatModifier(m.key, m.value)}`,
      }));
    }
    box.append(sum);
  }

  return box;
}

/* ============================================================
 * 日志
 * ============================================================ */

const MAX_LOG = 260;

export function pushLog(logEl, lines, date, baseTone = '') {
  if (!lines || !lines.length) return;

  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;

  for (const raw of lines) {
    const text = String(raw ?? '');
    let tone = baseTone;
    if (text.startsWith('【事件】')) tone = 'gold';
    else if (text.startsWith('【') && text.includes('完成国策')) tone = 'green';
    else if (text.startsWith('  ·')) tone = 'dim';
    else if (text.startsWith('✓')) tone = 'green';
    else if (text.startsWith('✗') || text.startsWith('⚠')) tone = 'red';

    logEl.append(el('div', { class: `row ${tone}`.trim() }, [
      el('span', { class: 't', text: dateStr(date) }),
      document.createTextNode(text),
    ]));
  }

  while (logEl.childElementCount > MAX_LOG) logEl.firstElementChild.remove();

  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

export function clearLog(logEl) {
  clear(logEl);
}
