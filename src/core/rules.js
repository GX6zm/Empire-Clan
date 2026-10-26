/**
 * rules.js —— 游戏规则层
 *
 * 这里是"什么是合法的"和"点下去发生什么"，不涉及任何 DOM。
 * 因此它可以被 Node 直接 import 做单元测试，也可以将来搬到 Worker 里跑。
 */

import { evalTrigger, applyEffects } from './expr.js';
import { nextRandom } from './rng.js';
import { aggregateModifiers } from './modifiers.js';

/** 国策在 UI 上的五种视觉状态 */
export const FOCUS_STATE = {
  COMPLETED: 'completed',
  CURRENT: 'current',
  AVAILABLE: 'available',
  LOCKED: 'locked',   // 前置没完成
  BLOCKED: 'blocked', // 互斥 / 额外条件不满足
};

/* ============================================================
 * 国策可用性
 * ============================================================ */

/** 某个国家的全部国策（每个国家有一棵独立的树） */
export function focusesOf(data, tag) {
  return data.focusesByTag?.[tag] || [];
}

/**
 * 判断一个国家能否"在结构上"解锁某个国策（不考虑当前是否已有国策在做）。
 * @returns {{ ok: boolean, code: string, reason: string, missing?: string[] }}
 */
export function focusAvailability(state, data, country, focus) {
  const done = country.focuses.completed;

  // 别国的国策不属于你这棵树
  if (focus.tag && focus.tag !== country.tag) {
    return { ok: false, code: 'other', reason: '这是其他国家的国策' };
  }

  if (done.includes(focus.id)) {
    return { ok: false, code: 'done', reason: '已完成的国策' };
  }

  const nameOf = (id) => data.focusById[id]?.name || id;

  const missing = (focus.prereqs || []).filter((id) => !done.includes(id));
  if (missing.length) {
    return {
      ok: false,
      code: 'prereq',
      reason: `缺少前置国策：${missing.map(nameOf).join('、')}`,
      missing,
    };
  }

  const anyOf = focus.prereqs_any || [];
  if (anyOf.length && !anyOf.some((id) => done.includes(id))) {
    return {
      ok: false,
      code: 'prereq_any',
      reason: `需要先完成以下任一：${anyOf.map(nameOf).join(' 或 ')}`,
    };
  }

  const excl = (focus.mutually_exclusive || []).filter((id) => done.includes(id));
  if (excl.length) {
    return {
      ok: false,
      code: 'excl',
      reason: `与已完成的「${excl.map(nameOf).join('、')}」互斥`,
    };
  }

  // 正在进行的国策如果与本项互斥，也不能开始
  const cur = country.focuses.current;
  if (cur) {
    const curFocus = data.focusById[cur];
    if (curFocus && (curFocus.mutually_exclusive || []).includes(focus.id)) {
      return {
        ok: false,
        code: 'excl_current',
        reason: `正在进行的「${curFocus.name}」与本项互斥`,
      };
    }
  }

  // 额外条件（可以引用任意触发器）
  if (focus.available) {
    const ctx = makeCtx(state, data, country, focus);
    if (!evalTrigger(focus.available, ctx)) {
      return { ok: false, code: 'cond', reason: '额外条件尚未满足' };
    }
  }

  return { ok: true, code: 'ok', reason: '可以开始' };
}

/** 给 UI 用的视觉状态 */
export function focusState(state, data, country, focus) {
  if (country.focuses.current === focus.id) return FOCUS_STATE.CURRENT;
  if (country.focuses.completed.includes(focus.id)) return FOCUS_STATE.COMPLETED;

  const a = focusAvailability(state, data, country, focus);
  if (a.ok) return FOCUS_STATE.AVAILABLE;
  if (a.code === 'prereq' || a.code === 'prereq_any') return FOCUS_STATE.LOCKED;
  return FOCUS_STATE.BLOCKED;
}

/* ============================================================
 * 开始 / 完成
 * ============================================================ */

export function startFocus(state, data, country, focus) {
  if (country.focuses.current) {
    const cur = data.focusById[country.focuses.current];
    return { ok: false, reason: `已有国策正在进行：${cur?.name || country.focuses.current}` };
  }
  const a = focusAvailability(state, data, country, focus);
  if (!a.ok) return { ok: false, reason: a.reason };

  // 政治点数成本：这是国策树里唯一的"钱"，也是取舍的真正来源之一
  const ppCost = focus.pp_cost || 0;
  if (ppCost > 0 && country.political_power < ppCost) {
    return {
      ok: false,
      reason: `需要 ${ppCost} 政治点数（当前 ${Math.floor(country.political_power)}）`,
    };
  }
  if (ppCost > 0) {
    country.political_power = round2(country.political_power - ppCost);
  }

  country.focuses.current = focus.id;
  country.focuses.progress = 0;
  return { ok: true, reason: '', spent: ppCost };
}

/** 是否付得起这个国策的政治点数成本 */
export function canAfford(country, focus) {
  const need = focus.pp_cost || 0;
  return need <= 0 || country.political_power >= need;
}

/** 立即完成（推进到满进度时调用，也供调试用） */
export function completeFocus(state, data, country, focus) {
  const notes = [];

  country.focuses.completed.push(focus.id);
  country.focuses.current = null;
  country.focuses.progress = 0;

  notes.push(`【${country.name}】完成国策「${focus.name}」`);

  const ctx = makeCtx(state, data, country, focus);
  for (const line of applyEffects(focus.effects, ctx)) {
    notes.push(`  · ${line}`);
  }

  return notes;
}

function makeCtx(state, data, country, focus) {
  const src = data.sources?.[`focuses:${focus.id}`];
  return {
    state,
    country,
    source: src ? `${src}#${focus.id}` : `focuses#${focus.id}`,
  };
}

/* ============================================================
 * 每日推进
 * ============================================================ */

export function dailyPoliticalPower(country, mods = null) {
  const m = mods || {};
  const base = 0.9;
  const fromFactories = country.factories * 0.012;
  const fromStability = (country.stability - 50) / 500;

  let value = base + fromFactories + fromStability + (m.political_power_gain || 0);

  // 战争拖累政治运转：同时在打的敌人越多，内政越推不动。
  // 这条让"和谈"在**赢的时候**也有意义——不然打赢了就该无脑打到底，
  // 谈判桌只是一张给输家用的逃命票。
  const enemies = country.atWarWith?.length || 0;
  if (enemies > 0) value *= 1 - Math.min(0.45, 0.12 * enemies);

  // 内政动荡：稳定度跌破 30，政治产出腰斩
  if (country.stability < 30) value *= 0.55;
  // 民意高涨：战争支持度很高时有额外产出
  if (country.war_support > 70) value += 0.1;

  // 政治点数软上限：存量越高，边际产出越低。
  // 没有这条，"挂机攒够一切成本"会把国策树里的取舍直接抹平。
  if (country.political_power > 400) value *= 0.25;
  else if (country.political_power > 200) value *= 0.5;

  // 兜底：再烂的局面也留一点产出，避免游戏彻底卡死
  return Math.max(0.15, value);
}

export function tickCountry(state, data, country) {
  const notes = [];
  const mods = aggregateModifiers(data, country);

  // 政治点数每日累积
  country.political_power = round2(country.political_power + dailyPoliticalPower(country, mods));

  // 厌战：战争每多打一天，民意就往下掉一点。
  // 掉到低位后 AI 才会真的想上谈判桌（见 peace.js 的 weariness）。
  const enemies = Math.min(3, country.atWarWith?.length || 0);
  if (enemies > 0) {
    country.war_support = Math.min(100, Math.max(0, country.war_support - 0.05 * enemies));
  }

  const curId = country.focuses.current;
  if (curId) {
    const focus = data.focusById[curId];
    if (!focus) {
      country.focuses.current = null;
      country.focuses.progress = 0;
    } else {
      // 国策速度修正：+10% 意味着每天推进 1.1 天
      country.focuses.progress += 1 * (1 + (mods.focus_speed || 0));
      if (country.focuses.progress >= focus.cost) {
        notes.push(...completeFocus(state, data, country, focus));
      }
    }
  } else if (country.tag !== state.playerTag) {
    aiPickFocus(state, data, country);
  }

  return notes;
}

/** AI：在可用且付得起的国策中按 ai_weight 加权随机 */
export function aiPickFocus(state, data, country) {
  const options = [];
  for (const f of focusesOf(data, country.tag)) {
    if (f.ai_weight === 0) continue;
    if (!focusAvailability(state, data, country, f).ok) continue;
    if (!canAfford(country, f)) continue;
    options.push({ f, w: Math.max(0.01, f.ai_weight ?? 10) });
  }
  if (!options.length) return null;

  const total = options.reduce((s, o) => s + o.w, 0);
  let roll = nextRandom(state) * total;
  let pick = options[options.length - 1];
  for (const o of options) {
    roll -= o.w;
    if (roll <= 0) {
      pick = o;
      break;
    }
  }

  country.focuses.current = pick.f.id;
  country.focuses.progress = 0;
  return pick.f.id;
}

/* ============================================================
 * 事件
 * ============================================================ */

/**
 * 检查所有国家是否满足事件触发条件。
 * 只负责"排队"，真正的结算在 resolvePendingEvents 里。
 */
export function checkEvents(state, data) {
  const notes = [];

  for (const country of Object.values(state.countries)) {
    for (const ev of data.events) {
      // manual 事件只能由效果的 fire_event 触发，不参与每日轮询
      if (ev.manual) continue;
      if (state.firedEvents.includes(ev.id)) continue;
      if (ev.for && ev.for !== 'any' && ev.for !== country.tag) continue;
      if (state.pendingEvents.some((p) => p.eventId === ev.id && p.tag === country.tag)) continue;

      const ctx = { state, country, source: `events#${ev.id}` };
      let triggered = false;
      try {
        triggered = evalTrigger(ev.trigger, ctx);
      } catch (err) {
        notes.push(`✗ 事件 ${ev.id} 条件求值失败：${err.message}`);
        continue;
      }
      if (!triggered) continue;

      if (ev.once !== false) state.firedEvents.push(ev.id);
      state.pendingEvents.push({ eventId: ev.id, tag: country.tag });
      notes.push(`【事件】${ev.title}（${country.name}）`);
    }
  }

  return notes;
}

/** 把效果里 fire_event 产生的队列并入待处理事件 */
export function drainEventQueue(state) {
  if (!state.eventQueue.length) return;
  for (const q of state.eventQueue) {
    if (state.pendingEvents.some((p) => p.eventId === q.eventId && p.tag === q.tag)) continue;
    state.pendingEvents.push(q);
  }
  state.eventQueue = [];
}

/**
 * AI 国家的事件自动选择；玩家的留在队列里等 UI 弹窗。
 * 会清空 state.pendingEvents 中已处理的部分。
 */
export function resolvePendingEvents(state, data) {
  const remain = [];

  for (const p of state.pendingEvents) {
    const ev = data.eventById[p.eventId];
    const country = state.countries[p.tag];

    if (!ev || !country) continue;

    if (p.tag === state.playerTag) {
      remain.push(p);
      continue;
    }

    // AI 选项：按 ai_weight 加权
    const opts = (ev.options || []).filter((o) => !o.trigger || safeTrigger(o.trigger, state, country, ev));
    if (!opts.length) continue;

    const total = opts.reduce((s, o) => s + Math.max(0.01, o.ai_weight ?? 1), 0);
    let roll = nextRandom(state) * total;
    let chosen = opts[opts.length - 1];
    for (const o of opts) {
      roll -= Math.max(0.01, o.ai_weight ?? 1);
      if (roll <= 0) {
        chosen = o;
        break;
      }
    }

    applyEffects(chosen.effects, { state, country, source: `events#${ev.id}` });
  }

  state.pendingEvents = remain;
}

function safeTrigger(t, state, country, ev) {
  try {
    return evalTrigger(t, { state, country, source: `events#${ev.id}` });
  } catch {
    return false;
  }
}

/** 玩家做出选择后调用 */
export function applyPlayerChoice(state, data, eventId, optionIndex) {
  const ev = data.eventById[eventId];
  if (!ev) return { ok: false, reason: `未知事件 ${eventId}` };
  const opt = ev.options?.[optionIndex];
  if (!opt) return { ok: false, reason: `未知选项 ${optionIndex}` };

  const pending = state.pendingEvents.find((p) => p.eventId === eventId && p.tag === state.playerTag);
  const country = pending ? state.countries[pending.tag] : state.countries[state.playerTag];

  const notes = applyEffects(opt.effects, {
    state,
    country,
    source: `events#${eventId}`,
  });

  state.pendingEvents = state.pendingEvents.filter(
    (p) => !(p.eventId === eventId && p.tag === state.playerTag)
  );

  return { ok: true, notes, choice: opt.text };
}

/* ============================================================
 * 工具
 * ============================================================ */

export function round2(n) {
  return Math.round(n * 100) / 100;
}
