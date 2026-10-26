/**
 * state.js —— 游戏状态：创建与每日推进
 *
 * 状态是纯数据（可 JSON 序列化），所有逻辑都在 rules.js。
 * 这样存档就是 JSON.stringify(state)，读档就是 JSON.parse + 迁移。
 */

import { DEFAULT_STATS } from './describe.js';
import { aggregateModifiers } from './modifiers.js';
import { warTick, sweepTruces } from './war.js';
import { peaceTick } from './peace.js';
import {
  tickCountry,
  checkEvents,
  drainEventQueue,
  resolvePendingEvents,
} from './rules.js';

/** 存档格式版本。任何破坏兼容的改动都必须 +1 并在 save.js 里加迁移。 */
export const SAVE_VERSION = 4;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* ============================================================
 * 创建
 * ============================================================ */

export function createState(data, { seed = 19360101, mods = [] } = {}) {
  const cfg = data.config;

  const state = {
    saveVersion: SAVE_VERSION,
    meta: {
      gameVersion: cfg.version,
      mods: [...mods],
      createdAt: new Date().toISOString(),
    },
    date: { ...cfg.startDate },
    playerTag: cfg.playerTag,
    speed: 0,
    rng: seed,

    // 从开局算起的天数。日期会跨月跨年，算"这仗打了多久""停战还有几天"
    // 都需要一个单调递增的计数器，不然每次都要做日历减法。
    elapsedDays: 0,

    globals: {},
    countries: {},

    pendingEvents: [],
    eventQueue: [],
    firedEvents: [],

    provinces: {},

    // 战争档案（每场仗一份，含开战时的边界快照）、停战协议、AI 的求和提议
    wars: [],
    truces: {},
    peaceOffers: [],

    log: [],
    selectedProvince: null,
  };

  // 省份归属是**运行时状态**，不是静态数据。
  // 这样战争把地块打来打去不会污染 data/，重载数据也不会带着上一局的战果。
  for (const p of data.provinces) {
    state.provinces[p.id] = { id: p.id, owner: p.owner, contest: 0, contestedBy: null };
  }

  for (const def of cfg.countries) {
    const s = def.stats || {};
    state.countries[def.tag] = {
      tag: def.tag,
      name: def.name,
      color: def.color,
      flags: {},

      political_power: s.political_power ?? DEFAULT_STATS.political_power,
      stability: s.stability ?? DEFAULT_STATS.stability,
      war_support: s.war_support ?? DEFAULT_STATS.war_support,
      factories: s.factories ?? DEFAULT_STATS.factories,
      manpower: s.manpower ?? DEFAULT_STATS.manpower,
      divisions: s.divisions ?? DEFAULT_STATS.divisions,

      focuses: { completed: [], current: null, progress: 0 },
      ideas: [],
      atWarWith: [],
      defeated: false,
    };
  }

  return state;
}

/* ============================================================
 * 推进
 * ============================================================ */

/**
 * 推进一天。
 * @returns {string[]} 本日产生的日志行
 */
export function advanceDay(state, data) {
  const notes = [];

  advanceDate(state);
  state.elapsedDays = (state.elapsedDays || 0) + 1;

  for (const country of Object.values(state.countries)) {
    notes.push(...tickCountry(state, data, country));
  }

  // 先打完仗，再检查事件——这样事件可以引用当天的战果
  notes.push(...warTick(state, data));

  // 战场结算之后才轮到谈判桌：今天刚吃下的地，今天就能算进筹码
  notes.push(...peaceTick(state, data));

  notes.push(...checkEvents(state, data));
  drainEventQueue(state);
  resolvePendingEvents(state, data);

  // 每月结算
  if (state.date.day === 1) {
    for (const country of Object.values(state.countries)) {
      applyMonthlyEconomy(data, country);
    }
    sweepTruces(state);
  }

  return notes;
}

/**
 * 月度经济结算。
 * 这里是国家精神真正开始生效的地方——自给路线靠工厂产出堆量，
 * 但稳定度趋势为负，会一点点把政治产出吃回去。
 */
export function applyMonthlyEconomy(data, country) {
  const mods = aggregateModifiers(data, country);

  // 工厂建设：每月固定投入，乘工厂产出修正。
  // 刻意压得很慢——不然不点经济线、纯挂机也能堆出工厂，国策的取舍就没意义了。
  country.factories = round2(country.factories + 0.22 * (1 + (mods.factory_output || 0)));

  // 稳定度 / 战争支持度按月漂移（国家精神的主要代价在这里体现）
  country.stability = clamp(country.stability + (mods.stability_drift || 0), 0, 100);
  country.war_support = clamp(country.war_support + (mods.war_support_drift || 0), 0, 100);

  // 人力增长
  const manpowerGain = (1 + country.factories * 0.12) * (1 + (mods.manpower_gain || 0));
  country.manpower = round2(Math.max(0, country.manpower + manpowerGain));

  // 工厂转化为兵员：工厂越多，每月能拉起的师越多
  country.divisions = round2(Math.max(0, (country.divisions || 0) + 0.06 * country.factories));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function advanceDate(state) {
  const d = state.date;
  d.day += 1;

  const maxDay = MONTH_DAYS[d.month - 1] || 30;
  if (d.day > maxDay) {
    d.day = 1;
    d.month += 1;
    if (d.month > 12) {
      d.month = 1;
      d.year += 1;
    }
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ============================================================
 * 只读辅助
 * ============================================================ */

export function playerCountry(state) {
  return state.countries[state.playerTag];
}

export function provincesOf(state, tag) {
  const out = [];
  for (const p of Object.values(state.provinces)) {
    if (p.owner === tag) out.push(p.id);
  }
  return out;
}

export function countryWarCount(country) {
  return country.atWarWith.length;
}
