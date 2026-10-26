/**
 * dialogs.js —— 弹窗 / 抽屉 / 提示
 */

import { el, clear } from './dom.js';
import { describeEffect, describeTrigger } from '../core/describe.js';
import { focusAvailability, focusState, FOCUS_STATE } from '../core/rules.js';
import {
  findWar,
  sides,
  warScore,
  dealValue,
  aiVerdict,
  emptyTerms,
  applyPeace,
  CLAUSES,
  LAND_MODES,
  fmtV,
  describeTerms,
} from '../core/peace.js';
import { TRUCE_DAYS } from '../core/war.js';
import { buildMap, refreshMap, muted as mapColor } from './map.js';

/* ============================================================
 * 通用弹窗
 * ============================================================ */

let maskCount = 0;

export function openModal(root, { title, body, foot, closable = true, onClose, wide = false }) {
  const mask = el('div', { class: 'mask' });
  const modal = el('div', { class: 'modal', style: wide ? { width: 'min(760px, 94vw)' } : null });

  const close = () => {
    if (!mask.isConnected) return;
    mask.remove();
    maskCount = Math.max(0, maskCount - 1);
    if (maskCount === 0) document.body.style.overflow = '';
    onClose?.();
  };

  const closeBtn = closable
    ? el('button', { class: 'close', text: '✕', onclick: close, title: '关闭' })
    : null;

  modal.append(
    el('div', { class: 'modal-head' }, [document.createTextNode(title), closeBtn].filter(Boolean)),
    el('div', { class: 'modal-body' }, [].concat(body || [])),
  );

  if (foot && foot.length) {
    modal.append(el('div', { class: 'modal-foot' }, foot));
  }

  mask.append(modal);
  if (closable) {
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close();
    });
  }

  root.append(mask);
  maskCount += 1;
  document.body.style.overflow = 'hidden';

  return close;
}

export function toast(root, text, ms = 1800) {
  const t = el('div', { class: 'toast', text });
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

/* ============================================================
 * 事件弹窗
 * ============================================================ */

/**
 * @param {object} ev 事件定义
 * @param {(index:number)=>void} onChoose
 */
export function showEventModal(root, ev, onChoose, data = null) {
  const body = [
    el('p', { class: 'flavor', text: ev.flavor || '' }),
    el('p', { text: ev.desc || '' }),
  ];

  const close = openModal(root, {
    title: ev.title,
    body,
    closable: false,
    wide: false,
  });

  const optWrap = el('div', { style: { marginTop: '6px' } });

  (ev.options || []).forEach((opt, i) => {
    const effectLines = (opt.effects || []).map((eff) => describeEffect(eff, data).text);

    optWrap.append(el('button', {
      class: 'opt',
      onclick: () => {
        close();
        onChoose(i);
      },
    }, [
      el('span', { class: 'ot', text: opt.text || `选项 ${i + 1}` }),
      el('span', { class: 'oe', text: opt.tooltip || effectLines.join(' · ') || '无附加效果' }),
    ]));
  });

  // 把选项塞进 body 后面
  const modalBody = root.querySelector('.modal:last-of-type .modal-body');
  if (modalBody) modalBody.append(optWrap);
}

/* ============================================================
 * 和谈
 * ============================================================ */

/**
 * 谈判桌。
 *
 * 这里的核心不是 UI，而是把"对方的接受线"直接亮给玩家看：
 * 你可以一边勾条款一边看到对方的评估值怎么变、还差多少。
 * 赌命式的黑箱外交在这个规模的原型里只会让人烦躁，不会让人紧张。
 */
export function showPeaceDialog(root, { state, data, otherTag, onApplied, onClose }) {
  const playerTag = state.playerTag;
  const war = findWar(state, playerTag, otherTag);
  const other = state.countries[otherTag];

  if (!war || !other) {
    toast(root, '这场战争已经结束了');
    onClose?.();
    return;
  }

  const terms = emptyTerms();
  const body = el('div', { class: 'peace' });

  const submitBtn = el('button', { class: 'btn active', text: '提出和约' });
  const cancelBtn = el('button', { class: 'btn', text: '取消' });

  const close = openModal(root, {
    title: `与 ${other.name} 和谈`,
    body: [body],
    wide: true,
    foot: [cancelBtn, submitBtn],
    onClose,
  });

  cancelBtn.addEventListener('click', () => close());

  function submit() {
    const verdict = aiVerdict(state, data, war, otherTag, terms);

    if (!verdict.accept) {
      // 被拒的代价：对方更厌战，但你的政府在国内挂了彩。
      // 这条让"反复谈"成为一种可以磨的战术，而不是免费的重掷骰子。
      war.rejected = (war.rejected || 0) + 1;
      const me = state.countries[playerTag];
      me.political_power = Math.max(0, Math.round((me.political_power - 10) * 100) / 100);

      close();
      onApplied?.({
        ok: false,
        lines: [
          `【和谈】${other.name} 拒绝了条件（还差 ${fmtV(verdict.gap)}）`,
          '  · 外交受挫：政治点数 -10；对方也更能接受下一轮条件',
        ],
      });
      return;
    }

    const res = applyPeace(state, data, war, terms);
    close();
    onApplied?.(res);
  }

  submitBtn.addEventListener('click', submit);

  function render() {
    clear(body);
    body.append(...buildPeaceBody({ state, data, war, otherTag, terms, onChange: render }));

    const verdict = aiVerdict(state, data, war, otherTag, terms);
    submitBtn.textContent = verdict.accept ? '提出和约' : '提出和约（对方会拒）';
    submitBtn.className = `btn ${verdict.accept ? 'active' : 'danger'}`;
  }

  render();
}

function buildPeaceBody({ state, data, war, otherTag, terms, onChange }) {
  const playerTag = state.playerTag;
  const other = state.countries[otherTag];
  const me = state.countries[playerTag];
  const s = sides(state, data, war);

  const mine = warScore(state, data, war, playerTag);
  const theirs = warScore(state, data, war, otherTag);
  const iWin = s.winner === playerTag;

  const out = [];

  /* ---------- 分数条 ---------- */
  const pctWidth = Math.min(50, Math.abs(mine) / 2);
  out.push(el('div', { class: 'peace-score' }, [
    el('div', { class: 'ps-row' }, [
      el('span', { class: 'ps-k', text: '战争分数' }),
      el('span', { class: 'ps-num' }, [
        document.createTextNode(`${me.name} `),
        el('b', { class: mine >= 0 ? 'mod-pos' : 'mod-neg', text: fmtV(mine) }),
        document.createTextNode(`　${other.name} `),
        el('b', { class: theirs >= 0 ? 'mod-pos' : 'mod-neg', text: fmtV(theirs) }),
      ]),
    ]),
    el('div', { class: 'ps-track' }, [
      el('div', { class: 'ps-mid' }),
      el('div', {
        class: `ps-fill ${mine >= 0 ? 'pos' : 'neg'}`,
        style: mine >= 0
          ? { left: '50%', width: `${pctWidth}%` }
          : { right: '50%', width: `${pctWidth}%` },
      }),
    ]),
    el('div', {
      class: 'ps-hint',
      text: mine === 0
        ? '双方都没占到对方的地——只能谈白和平'
        : iWin
          ? `你占着对方 ${Math.round(Math.max(0, mine))}% 的国土价值，主动权在你手上`
          : `对方占着你 ${Math.round(Math.abs(mine))}% 的国土价值，条件由不得你`,
    }),
  ]));

  /* ---------- 领土 ---------- */
  out.push(el('div', { class: 'dt-section', text: '领土' }));
  const landRow = el('div', { class: 'peace-lands' });

  for (const mode of Object.values(LAND_MODES)) {
    const active = (terms.land || 'keep') === mode.id;
    const btn = el('button', {
      class: `peace-land${active ? ' on' : ''}`,
      onclick: () => {
        terms.land = mode.id;
        onChange();
      },
    }, [
      el('span', { class: 'pl-name', text: mode.name }),
      el('span', { class: 'pl-hint', text: mode.hint }),
    ]);
    landRow.append(btn);
  }
  out.push(landRow);

  /* ---------- 附加条款 ---------- */
  out.push(el('div', { class: 'dt-section', text: iWin ? '向对方索要' : '向对方让步' }));

  const list = el('div', { class: 'peace-clauses' });

  for (const c of CLAUSES) {
    const on = Boolean(terms.clauses[c.id]);
    const box = el('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', () => {
      terms.clauses[c.id] = box.checked;
      onChange();
    });

    list.append(el('label', { class: `peace-clause${on ? ' on' : ''}` }, [
      box,
      el('div', { class: 'pc-main' }, [
        el('div', { class: 'pc-top' }, [
          el('span', { class: 'pc-name', text: c.name }),
          el('span', { class: 'pc-val', text: `价值 ${c.value}` }),
        ]),
        el('div', {
          class: 'pc-desc',
          text: iWin ? `${other.name} ${c.pays}；${me.name} ${c.takes}` : `${me.name} ${c.pays}；${other.name} ${c.takes}`,
        }),
      ]),
    ]));
  }

  out.push(list);

  /* ---------- 判定 ---------- */
  const verdict = aiVerdict(state, data, war, otherTag, terms);
  const gapTxt = String(Math.round(verdict.gap * 10) / 10);

  out.push(el('div', { class: `peace-verdict ${verdict.accept ? 'good' : 'bad'}` }, [
    el('div', { class: 'pv-head' }, [
      el('span', { text: verdict.accept ? '对方的答复：可以签' : '对方的答复：还不够' }),
      el('span', {
        class: 'pv-num',
        text: `对方评估 ${fmtV(verdict.value)} / 接受线 ${fmtV(verdict.required)}`,
      }),
    ]),
    el('div', {
      class: 'pv-hint',
      text: verdict.accept
        ? '签下去这场仗今天结束，条款立即生效。'
        : iWin
          ? `对方觉得条件太苛刻——还得再少要 ${gapTxt} 点价值。战争拖得越久、被拒得越多，对方的胃口就越低。`
          : `对方还没满足——还得再多让出 ${gapTxt} 点价值。多拒一次、多拖一年，对方的接受线都会再松一点。`,
    }),
  ]));

  out.push(el('div', { class: 'tips' }, [
    el('div', { text: `和约一旦签订，双方 ${TRUCE_DAYS} 天内不能再宣战。` }),
    el('div', { text: '条件被拒：政治点数 -10，但对方会更能接受下一轮条件。' }),
  ]));

  return out;
}

/* ============================================================
 * AI 求和
 * ============================================================ */

export function showPeaceOfferModal(root, { state, data, offer, onChoose }) {
  const from = state.countries[offer.from];
  const war = findWar(state, offer.a, offer.b);
  if (!war || !from) {
    onChoose?.(false);
    return;
  }

  const s = sides(state, data, war);
  const mine = warScore(state, data, war, state.playerTag);
  const theirs = warScore(state, data, war, offer.from);

  const body = [
    el('p', { class: 'flavor', text: `${from.name} 的使节在深夜抵达。他们撑不住了。` }),
    el('p', {
      text: `战争分数：我们 ${fmtV(mine)}，对方 ${fmtV(theirs)}。`
        + (s.winner === state.playerTag
          ? '战场在我们这一边，签不签由我们决定。'
          : '对方并未处于劣势，他们只是在止损。'),
    }),
  ];

  const list = el('ul', { class: 'dt-list' });
  for (const t of describeTerms(state, data, war, offer.terms)) {
    list.append(el('li', { class: t.tone === 'neg' ? 'neg' : '', text: t.text }));
  }

  body.push(el('div', { class: 'dt-section', text: '对方提出的条件' }));
  body.push(list);

  const keep = dealValue(state, data, war, state.playerTag, offer.terms);
  body.push(el('div', {
    class: keep >= 0 ? 'dt-reason ok' : 'dt-reason',
    text: `这份和约对我们净 ${fmtV(keep)}（同一把尺子：对方国土价值的百分比）`,
  }));

  const close = openModal(root, {
    title: `${from.name} 请求停战`,
    body,
    closable: false,
  });

  const optWrap = el('div', { style: { marginTop: '6px' } });

  optWrap.append(el('button', {
    class: 'opt',
    onclick: () => {
      close();
      onChoose?.(true);
    },
  }, [
    el('span', { class: 'ot', text: '接受和约' }),
    el('span', { class: 'oe', text: '立即停火，领土与条款按上面执行' }),
  ]));

  optWrap.append(el('button', {
    class: 'opt',
    onclick: () => {
      close();
      onChoose?.(false);
    },
  }, [
    el('span', { class: 'ot', text: '拒绝，继续打' }),
    el('span', { class: 'oe', text: '对方会更厌战，下一次开价会更低；但战争也要多流血' }),
  ]));

  const modalBody = root.querySelector('.modal:last-of-type .modal-body');
  if (modalBody) modalBody.append(optWrap);
}

/* ============================================================
 * 战略地图（大图）
 * ============================================================ */

export function showMapModal(root, { state, data, onSelect, onClose }) {
  const holder = el('div');
  const wrap = el('div', { class: 'map-full' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrap.append(svg);
  holder.append(wrap);

  const legend = el('div', { class: 'map-legend' });
  for (const c of data.config.countries || []) {
    legend.append(el('span', {}, [
      el('i', { style: { background: mapColor(c.color) } }),
      document.createTextNode(c.name),
    ]));
  }
  holder.append(legend);
  holder.append(el('div', { class: 'tips', style: { marginTop: '8px' }, text: '点击区域可以选中它，关掉这张图后右侧态势面板会跟着切过去。' }));

  const close = openModal(root, {
    title: '战略地图',
    body: [holder],
    wide: true,
    onClose,
  });

  const refs = buildMap(svg, data, (id) => {
    onSelect?.(id);
    refreshMap(refs, state, data);
  }, { mode: 'full' });

  refreshMap(refs, state, data);
  return close;
}

/* ============================================================
 * 模组管理器
 * ============================================================ */

export function showModManager(root, { modIndex, enabled, onApply }) {
  const state = new Set(enabled);
  const body = [
    el('p', {
      style: { color: '#7d8794' },
      text: '模组在加载时合并进基础数据。启用/关闭后需要重新载入数据，当前对局会被重置。',
    }),
  ];

  const list = el('div');

  for (const m of modIndex) {
    const checked = state.has(m.id);
    const box = el('input', { type: 'checkbox' });
    box.checked = checked;
    box.addEventListener('change', () => {
      if (box.checked) state.add(m.id);
      else state.delete(m.id);
    });

    list.append(el('label', { class: 'mod-row' }, [
      box,
      el('div', {}, [
        el('div', {}, [
          el('span', { class: 'mn', text: m.name || m.id }),
          el('span', { class: 'mv', text: `v${m.version || '?'}` }),
          el('span', { class: `badge${checked ? ' on' : ''}`, text: checked ? '启用中' : '未启用' }),
          m.replacesBase
            ? el('span', { class: 'badge total', text: '完全替换' })
            : null,
        ]),
        el('div', { class: 'md', text: m.description || '（无描述）' }),
      ]),
    ]));
  }

  body.push(list);

  const close = openModal(root, {
    title: '模组管理',
    body,
    wide: true,
    foot: [
      el('button', { class: 'btn', text: '取消', onclick: () => close() }),
      el('button', {
        class: 'btn active',
        text: '应用并重载',
        onclick: () => {
          close();
          onApply([...state]);
        },
      }),
    ],
  });
}

/* ============================================================
 * 校验结果
 * ============================================================ */

export function showIssues(root, { issues, errors, logs, onRetry }) {
  const body = [
    el('p', { style: { color: '#7d8794' }, text: '加载过程中发现问题。错误必须修复，警告可以忽略。' }),
  ];

  if (errors && errors.length) {
    body.push(el('div', { class: 'dt-section', text: '加载错误' }));
    for (const e of errors) {
      body.push(el('div', { class: 'issue error' }, [
        el('span', { class: 'lvl', text: 'ERROR' }),
        document.createTextNode(e.msg),
        el('div', { class: 'src', text: e.src || '' }),
      ]));
    }
  }

  if (issues && issues.length) {
    body.push(el('div', { class: 'dt-section', text: `校验结果（${issues.length}）` }));
    for (const it of issues) {
      body.push(el('div', { class: `issue ${it.level}` }, [
        el('span', { class: 'lvl', text: it.level === 'error' ? 'ERROR' : 'WARN' }),
        document.createTextNode(it.msg),
        el('div', { class: 'src', text: it.src || '' }),
      ]));
    }
  }

  const close = openModal(root, {
    title: '数据加载报告',
    body,
    wide: true,
    foot: [
      el('button', { class: 'btn', text: '关闭', onclick: () => close() }),
      el('button', {
        class: 'btn active',
        text: '重新加载',
        onclick: () => {
          close();
          onRetry?.();
        },
      }),
    ],
  });
}

/* ============================================================
 * 国策详情抽屉
 * ============================================================ */

export function renderFocusDetail(container, { data, state, focusId, onStart, onClose }) {
  const f = data.focusById[focusId];

  if (!f) {
    container.hidden = true;
    clear(container);
    return;
  }

  clear(container);
  container.hidden = false;

  const country = state.countries[state.playerTag];
  const st = focusState(state, data, country, f);
  const avail = focusAvailability(state, data, country, f);

  const ppNeed = f.pp_cost || 0;
  const affordable = ppNeed <= 0 || country.political_power >= ppNeed;

  const stateLabel = {
    [FOCUS_STATE.COMPLETED]: '已完成',
    [FOCUS_STATE.CURRENT]: '进行中',
    [FOCUS_STATE.AVAILABLE]: '可开始',
    [FOCUS_STATE.LOCKED]: '未解锁',
    [FOCUS_STATE.BLOCKED]: '受阻',
  }[st] || st;

  container.append(
    el('div', { class: 'dt-head' }, [
      el('span', { class: 'dt-icon', 'aria-hidden': 'true', text: f.icon || '◆' }),
      el('div', {}, [
        el('div', { class: 'dt-title', text: f.name }),
        el('div', { class: 'dt-sub', text: `${f.cost} 天 · ${stateLabel}${ppNeed ? ` · ${ppNeed} 政治点数` : ''}` }),
      ]),
      el('button', {
        class: 'close',
        text: '✕',
        title: '关闭（Esc）',
        onclick: onClose,
      }),
    ])
  );

  // 面板分三段：标题固定 / 正文滚动 / 按钮固定。
  // 这里把 container 换成 body —— 后面所有 append 都落到可滚动区，
  // 于是"开始国策"永远在拇指/视线能及的地方。
  const rootEl = container;
  const panelBody = el('div', { class: 'detail-body' });
  const panelFoot = el('div', { class: 'detail-foot' });
  container.append(panelBody, panelFoot);
  container = panelBody;

  if (f.desc) container.append(el('div', { class: 'dt-desc', text: f.desc }));

  // 政治点数成本：国策树里唯一的"钱"
  let ppNode = null;
  if (ppNeed > 0 && st !== FOCUS_STATE.COMPLETED) {
    container.append(el('div', { class: 'dt-section', text: '启动成本' }));
    ppNode = el('span', {
      style: { color: 'var(--text-faint)', marginLeft: '8px' },
      text: `（当前 ${Math.floor(country.political_power)}）`,
    });
    container.append(el('div', { class: 'dt-list' }, [
      el('li', {}, [
        el('span', { class: 'neg', text: `政治点数 -${ppNeed}` }),
        ppNode,
      ]),
    ]));
  }

  // 前置
  const prereqs = [...(f.prereqs || []), ...(f.prereqs_any || [])];
  if (prereqs.length) {
    container.append(el('div', { class: 'dt-section', text: f.prereqs_any?.length ? '前置（任选其一）' : '前置' }));
    const ul = el('ul', { class: 'dt-list' });
    for (const id of prereqs) {
      const done = country.focuses.completed.includes(id);
      const name = data.focusById[id]?.name || id;
      ul.append(el('li', {
        style: { color: done ? 'var(--olive)' : 'var(--text-dim)' },
        text: `${done ? '✓' : '○'} ${name}`,
      }));
    }
    container.append(ul);
  }

  // 互斥
  if (f.mutually_exclusive?.length) {
    container.append(el('div', { class: 'dt-section', text: '互斥' }));
    const ul = el('ul', { class: 'dt-list' });
    for (const id of f.mutually_exclusive) {
      ul.append(el('li', {
        style: { color: 'var(--seal-lt)' },
        text: `✕ ${data.focusById[id]?.name || id}`,
      }));
    }
    container.append(ul);
  }

  // 额外条件
  if (f.available) {
    container.append(el('div', { class: 'dt-section', text: '额外条件' }));
    container.append(el('div', { class: 'dt-desc', text: describeTrigger(f.available) }));
  }

  // 效果
  if (f.effects?.length) {
    container.append(el('div', { class: 'dt-section', text: '效果' }));
    const ul = el('ul', { class: 'dt-list' });
    for (const eff of f.effects) {
      const d = describeEffect(eff, data);
      ul.append(el('li', {}, [
        el('span', { class: d.tone === 'pos' ? 'pos' : d.tone === 'neg' ? 'neg' : '', text: d.text }),
      ]));
    }
    container.append(ul);
  }

  // 状态说明
  let reasonNode = null;

  if (st === FOCUS_STATE.CURRENT) {
    reasonNode = el('div', {
      class: 'dt-reason ok',
      text: `正在推进中：${Math.floor(country.focuses.progress)} / ${f.cost} 天`,
    });
    container.append(reasonNode);
  } else if (st !== FOCUS_STATE.COMPLETED) {
    const isOk = st === FOCUS_STATE.AVAILABLE;
    const blockedByCurrent = Boolean(country.focuses.current);

    let reasonText;
    let okStyle = false;

    if (!isOk) {
      reasonText = avail.reason;
    } else if (blockedByCurrent) {
      reasonText = '当前已有国策在进行，完成后可选择此项';
    } else if (!affordable) {
      reasonText = `需要 ${ppNeed} 政治点数，当前只有 ${Math.floor(country.political_power)}`;
    } else {
      reasonText = '点击下方按钮开始';
      okStyle = true;
    }

    reasonNode = el('div', {
      class: `dt-reason${okStyle ? ' ok' : ''}`,
      text: reasonText,
    });
    container.append(reasonNode);
  }

  // 操作
  const stOk = st === FOCUS_STATE.AVAILABLE && !country.focuses.current;

  const btnNode = el('button', {
    class: 'btn-primary',
    text: st === FOCUS_STATE.CURRENT ? '进行中…' : '开始国策',
    disabled: !(stOk && affordable),
    onclick: () => stOk && affordable && onStart(f.id),
  });

  panelFoot.append(el('div', { class: 'dt-actions' }, [btnNode]));

  // 供每帧轻量同步（政治点数在涨，按钮该及时亮起来，但整块重建会打断阅读）
  rootEl._live = { focusId: f.id, ppNode, reasonNode, btnNode, ppNeed, stOk };
}

/**
 * 只更新会随每帧变化的部分，不重建整个面板。
 */
export function syncFocusDetailLive(container, { state, data }) {
  const live = container._live;
  if (!live || container.hidden) return;

  const country = state.countries[state.playerTag];
  if (!country) return;

  const pp = Math.floor(country.political_power);
  const affordable = live.ppNeed <= 0 || country.political_power >= live.ppNeed;

  if (live.ppNode) live.ppNode.textContent = `（当前 ${pp}）`;

  if (live.btnNode) live.btnNode.disabled = !(live.stOk && affordable);

  if (live.reasonNode && live.stOk) {
    if (live.ppNeed > 0 && !affordable) {
      live.reasonNode.textContent = `需要 ${live.ppNeed} 政治点数，当前只有 ${pp}`;
      live.reasonNode.classList.remove('ok');
    } else {
      live.reasonNode.textContent = '点击下方按钮开始';
      live.reasonNode.classList.add('ok');
    }
  }
}
