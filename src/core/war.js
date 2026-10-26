/**
 * war.js —— 战争的最小闭环
 *
 * 模型（刻意做得很小，但每一步都能解释）：
 *
 *   师(divisions) × 军队战力修正  = 全军的攻击力
 *   攻击力 / √接壤省份数          = 每条战线能投入的力量
 *   防守方在同一块地上有地形/价值加成
 *
 *   每天，每一块地被最强的那条相邻敌军战线推一把：
 *     net = 进攻方战线力量 − 防守方在该地的力量
 *     该地"争夺值" += net × 系数
 *   争夺值满 100 → 这块地易手。
 *
 *   一个国家失去全部省份 → 崩盘，退出所有战争。
 *
 * 为什么不做得更细：一旦引入补给、地形、编制、装备，就要三个月起步。
 * 现在的版本已经能回答"我 42 座工厂到底换来了什么"。
 */

import { aggregateModifiers } from './modifiers.js';
import { nextRandom } from './rng.js';

/** 争夺值达到这个数，地块易手 */
export const CAPTURE_THRESHOLD = 100;
/** 每天争夺值的放大系数 */
const CONTEST_RATE = 1.5;
/** 和约签订后的停战期：这段时间内双方不能再宣战（18 个月） */
export const TRUCE_DAYS = 540;

/* ============================================================
 * 查询
 * ============================================================ */

export function atWar(state, a, b) {
  return Boolean(state.countries[a]?.atWarWith.includes(b));
}

export function provincesOf(state, tag) {
  const out = [];
  for (const p of Object.values(state.provinces)) {
    if (p.owner === tag) out.push(p.id);
  }
  return out;
}

/** 全军攻击力 = 师数 ×(1 + 军队战力修正) */
export function armyPower(state, data, country) {
  if (!country) return 0;
  const mods = aggregateModifiers(data, country);
  const raw = (country.divisions || 0) * (1 + (mods.army_strength || 0));
  return Math.max(0, raw);
}

/** 与敌国接壤的省份数量 —— 战线越多，每条战线摊到的兵力越少 */
export function frontCount(state, data, tag) {
  let n = 0;
  for (const p of Object.values(state.provinces)) {
    if (p.owner !== tag) continue;
    const neighbors = data.provinceById[p.id]?.neighbors || [];
    for (const nid of neighbors) {
      const q = state.provinces[nid];
      if (q && q.owner !== tag && atWar(state, tag, q.owner)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/** 单条战线能投入的力量 */
export function frontPower(state, data, tag) {
  const fronts = Math.max(1, frontCount(state, data, tag));
  // 用 0.35 次方而不是开平方：战线越多，每条战线摊到的兵力越少，
  // 但不要少到"占的地越多反而越弱"那种雪崩。
  return armyPower(state, data, state.countries[tag]) / Math.pow(fronts, 0.35);
}

/** 防守方在某块地上的力量（价值越高的地方防备越充分） */
export function defensePower(state, data, tag, provinceId) {
  const vp = data.provinceById[provinceId]?.vp || 1;
  return frontPower(state, data, tag) * (1 + vp * 0.025);
}

/** 供 UI：正在打的仗 */
export function activeWars(state) {
  const seen = new Set();
  const out = [];
  for (const c of Object.values(state.countries)) {
    for (const other of c.atWarWith) {
      const key = [c.tag, other].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a: c.tag, b: other });
    }
  }
  return out;
}

/* ============================================================
 * 战争档案
 *
 * atWarWith 只回答"谁和谁在打"；和谈还需要知道"这场仗从哪儿开始"，
 * 否则没法算"我占了他多少国土"。所以每场仗都有一份档案：
 *
 *   start   开战当天双方各持有哪些省份（用来判"打回来多少"）
 *   vp      开战当天双方国土的总价值（用来把占领量换成 0..100 的分数）
 *   startDay / lastOfferDay / rejected  和谈相关的计时
 *
 * 档案和 atWarWith 由同一批函数维护（openWar / closeWar），
 * 读档后由 reconcileWithData 兜底修复。
 * ============================================================ */

export function vpOf(data, provinceId) {
  return data.provinceById?.[provinceId]?.vp || 1;
}

export function vpSum(data, ids) {
  let n = 0;
  for (const id of ids) n += vpOf(data, id);
  return n;
}

export function findWar(state, a, b) {
  return (state.wars || []).find(
    (w) => (w.a === a && w.b === b) || (w.a === b && w.b === a)
  ) || null;
}

/** 开战：给这场仗建一份档案 */
export function openWar(state, data, aTag, bTag) {
  state.wars = state.wars || [];

  const start = {
    [aTag]: provincesOf(state, aTag),
    [bTag]: provincesOf(state, bTag),
  };

  const war = {
    a: aTag,
    b: bTag,
    startDay: state.elapsedDays || 0,
    lastOfferDay: -9999,
    rejected: 0,
    start,
    vp: { [aTag]: vpSum(data, start[aTag]), [bTag]: vpSum(data, start[bTag]) },
  };

  state.wars.push(war);
  return war;
}

/** 结束一场仗：清掉档案、双向解除战争状态、清空这块地上的争夺值 */
export function closeWar(state, aTag, bTag) {
  const a = state.countries[aTag];
  const b = state.countries[bTag];
  if (!a || !b) return;

  a.atWarWith = a.atWarWith.filter((t) => t !== bTag);
  b.atWarWith = b.atWarWith.filter((t) => t !== aTag);

  for (const p of Object.values(state.provinces || {})) {
    if (p.contestedBy === aTag || p.contestedBy === bTag) {
      p.contest = 0;
      p.contestedBy = null;
    }
  }

  state.wars = (state.wars || []).filter(
    (w) => !((w.a === aTag && w.b === bTag) || (w.a === bTag && w.b === aTag))
  );
}

/* ---------- 停战协议 ---------- */

function truceKey(a, b) {
  return [a, b].sort().join('|');
}

/** 返回停战期还剩多少天；0 表示没有停战协议或已过期 */
export function truceDaysLeft(state, a, b) {
  const until = state.truces?.[truceKey(a, b)];
  if (!until) return 0;
  return Math.max(0, until - (state.elapsedDays || 0));
}

export function addTruce(state, a, b, days = TRUCE_DAYS) {
  state.truces = state.truces || {};
  state.truces[truceKey(a, b)] = (state.elapsedDays || 0) + days;
}

/** 把过期的停战协议清掉，避免存档里无限堆积 */
export function sweepTruces(state) {
  const now = state.elapsedDays || 0;
  for (const k of Object.keys(state.truces || {})) {
    if (state.truces[k] <= now) delete state.truces[k];
  }
}

/* ============================================================
 * 每日结算
 * ============================================================ */

/**
 * @returns {string[]} 日志行（只在发生有意义的事时产生，避免刷屏）
 */
export function warTick(state, data) {
  const notes = [];

  const anyWar = Object.values(state.countries).some((c) => c.atWarWith.length > 0);
  if (!anyWar) return notes;

  // 先快照一遍战线力量，避免同一天里"越打越强/越弱"的顺序偏差
  const powerCache = new Map();
  const powerOf = (tag) => {
    if (!powerCache.has(tag)) powerCache.set(tag, frontPower(state, data, tag));
    return powerCache.get(tag);
  };

  for (const province of Object.values(state.provinces)) {
    const defenderTag = province.owner;
    const defender = state.countries[defenderTag];
    if (!defender) continue;

    const neighbors = data.provinceById[province.id]?.neighbors || [];
    let best = null;

    for (const nid of neighbors) {
      const q = state.provinces[nid];
      if (!q || q.owner === defenderTag) continue;
      if (!atWar(state, defenderTag, q.owner)) continue;
      if (!state.countries[q.owner]) continue;

      // 进攻方有主动权（1.1 ~ 1.4 倍），每天有一点随机性，
      // 避免所有战线整整齐齐地同时崩溃
      const attack = powerOf(q.owner) * (1.1 + nextRandom(state) * 0.3);
      const defend = defensePower(state, data, defenderTag, province.id);
      const net = attack - defend;

      if (!best || net > best.net) best = { net, by: q.owner, from: nid };
    }

    if (!best) {
      // 没有敌人接壤，争夺值慢慢归零
      if (province.contest || province.contestedBy) {
        province.contest = 0;
        province.contestedBy = null;
      }
      continue;
    }

    if (province.contestedBy !== best.by) {
      province.contestedBy = best.by;
      province.contest = 0;
    }

    province.contest += best.net * CONTEST_RATE;

    if (province.contest <= 0) {
      province.contest = 0;
      continue;
    }

    if (province.contest >= CAPTURE_THRESHOLD) {
      const from = state.countries[defenderTag];
      const to = state.countries[best.by];

      province.owner = best.by;
      province.contest = 0;
      province.contestedBy = null;

      const place = data.provinceById[province.id];
      notes.push(`【战报】${to.name} 攻占 ${place?.name || province.id}（原属 ${from.name}）`);

      // 崩盘判定
      const remaining = provincesOf(state, defenderTag);
      if (remaining.length === 0) {
        capitulate(state, data, from, notes);
      }
    }
  }

  return notes;
}

/* ============================================================
 * 崩盘
 * ============================================================ */

function capitulate(state, data, country, notes) {
  if (!country || country.defeated) return;

  country.defeated = true;

  // 逐个收尾：每一场仗都要清档案，否则 state.wars 里会留下指向崩盘国家的幽灵记录
  for (const enemyTag of [...country.atWarWith]) {
    closeWar(state, country.tag, enemyTag);

    const enemy = state.countries[enemyTag];
    if (enemy) {
      // 打赢的人拿一点政治资本
      enemy.political_power = Math.round((enemy.political_power + 50) * 100) / 100;
      enemy.stability = Math.min(100, enemy.stability + 5);
      enemy.atWarWith = enemy.atWarWith.filter((t) => t !== country.tag);
    }
  }

  country.atWarWith = [];

  // 把还在争夺中的、原本属于败者的地块清干净
  for (const p of Object.values(state.provinces)) {
    if (p.contestedBy === country.tag || p.owner === country.tag) {
      p.contestedBy = null;
      p.contest = 0;
    }
  }

  notes.push(`【停战】${country.name} 已失去全部领土，战争结束`);
}

/* ============================================================
 * 操作
 * ============================================================ */

export function declareWar(state, data, aggressorTag, targetTag) {
  const a = state.countries[aggressorTag];
  const b = state.countries[targetTag];
  if (!a || !b || a.tag === b.tag) return { ok: false, reason: '目标无效' };
  if (a.atWarWith.includes(b.tag)) return { ok: false, reason: `已经在与 ${b.name} 交战` };
  if (a.defeated || b.defeated) return { ok: false, reason: '对方已崩盘' };

  // 刚签完和约就翻脸，和约就没有意义了
  const truce = truceDaysLeft(state, a.tag, b.tag);
  if (truce > 0) {
    return { ok: false, reason: `与 ${b.name} 的停战协议还有 ${truce} 天` };
  }

  a.atWarWith.push(b.tag);
  b.atWarWith.push(a.tag);
  openWar(state, data, a.tag, b.tag);

  return { ok: true, reason: '', line: `【宣战】${a.name} 向 ${b.name} 宣战` };
}

/**
 * 白和平：停火，并且把边界恢复到开战前的状态。
 * 这是"什么都没谈成"的结局——所以它把占来的地全吐出去。
 * 带条款的和约走 peace.js 的 applyPeace。
 */
export function makePeace(state, aTag, bTag) {
  const a = state.countries[aTag];
  const b = state.countries[bTag];
  if (!a || !b) return { ok: false };

  const war = findWar(state, aTag, bTag);
  if (war) {
    for (const tag of [war.a, war.b]) {
      for (const id of war.start[tag] || []) {
        const p = state.provinces[id];
        if (p && p.owner !== tag) p.owner = tag;
      }
    }
  }

  closeWar(state, aTag, bTag);
  if (war) addTruce(state, aTag, bTag);

  return { ok: true, line: `【停战】${a.name} 与 ${b.name} 停火，边界恢复原状` };
}
