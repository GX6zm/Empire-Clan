/**
 * peace.js —— 和谈
 *
 * 战争只能回答"谁在推进"，回答不了"什么时候停"。
 * 这个模块把战场上的推进换算成**谈判筹码**，让"打到一半割地求和"
 * 变成一个真实的选择，而不是只能打到亡国为止。
 *
 * 三个概念：
 *
 *   1. 战争分数 (war score)
 *      我占了他开战国土的百分之多少，减掉他占了我开战国土的百分之多少。
 *      双方各用**对手**的总量做分母，所以两边的分数正好互为相反数：
 *      +50 对我就是 -50 对他，谈判桌上那条左右对称的条子才画得出来。
 *      （用价值 vp 加权，所以打下一座大城市比打下三块荒地值钱。）
 *
 *   2. 条款价值 (deal value)
 *      一个和约由「领土怎么算」+ 若干附加条款组成。
 *      所有价值都以"对手国土总价值的百分比"为单位，也就是同一个 0..100 的尺子。
 *      这样"割 3 块地"和"赔 2 座工厂"可以直接放在天平两端比较。
 *
 *   3. 接受线 (acceptance threshold)
 *      AI 拿这份和约跟"继续打下去"比较：
 *        赢家愿意少拿一点（厌战），所以接受线 = 分数 × 胃口(<1.25)
 *        输家愿意多付一点（止损），所以接受线 = 分数 × 容忍(>1)
 *      被拒绝一次、战争多拖一年、国内越不稳，接受线就越松。
 *      所以"反复谈"是真的能把对方磨下来的——但每次被拒都掉政治点数。
 *
 * 领土的处理刻意选了最简单也最有说服力的一条：
 *   地是打下来的，谁拿着算谁的；要让对方吐出来，只能选「恢复战前边界」。
 */

import { nextRandom } from './rng.js';
import {
  findWar,
  closeWar,
  addTruce,
  provincesOf,
  vpOf,
  vpSum,
} from './war.js';

/* ============================================================
 * 条款
 * ============================================================ */

/**
 * 附加条款。value 是"对手国土总价值的百分比"，
 * 和战争分数用同一把尺子，才能直接相加。
 */
export const CLAUSES = [
  {
    id: 'humiliate',
    name: '政治羞辱',
    value: 10,
    pays: '稳定度 -10、战争支持 -12',
    takes: '政治点数 +20、战争支持 +6',
  },
  {
    id: 'reparations',
    name: '战争赔款',
    value: 15,
    pays: '工厂 -2、政治点数 -25',
    takes: '工厂 +2、政治点数 +25',
  },
  {
    id: 'disarm',
    name: '解除武装',
    value: 20,
    pays: '师数 -35%',
    takes: '边境压力减轻',
  },
];

export const CLAUSE_BY_ID = Object.fromEntries(CLAUSES.map((c) => [c.id, c]));

/** 领土条款的两种处理方式 */
export const LAND_MODES = {
  keep: { id: 'keep', name: '保持占领现状', hint: '打下来的地不还' },
  restore: { id: 'restore', name: '恢复战前边界', hint: '各自退回开战前的界线' },
};

/* ============================================================
 * 分数
 * ============================================================ */

/** 我占着对方多少地 —— 按对方开战时的国土总值归一，0..100 */
export function heldValue(state, data, war, tag) {
  const other = tag === war.a ? war.b : war.a;
  const theirs = war.start[other] || [];
  const base = Math.max(10, war.vp[other] || 10);

  let vp = 0;
  for (const id of theirs) {
    if (state.provinces[id]?.owner === tag) vp += vpOf(data, id);
  }
  return (100 * vp) / base;
}

/** 战争分数：我占了他多少，减掉他占了我多少。各用各的分母。 */
export function warScore(state, data, war, tag) {
  const other = tag === war.a ? war.b : war.a;
  const gained = heldValue(state, data, war, tag);
  const lost = heldValue(state, data, war, other);
  return clamp(Math.round(gained - lost), -100, 100);
}

/** 这场仗的双方态势 */
export function sides(state, data, war) {
  const aScore = warScore(state, data, war, war.a);
  const bScore = warScore(state, data, war, war.b);
  const winner = aScore >= bScore ? war.a : war.b;
  return { aScore, bScore, winner, loser: winner === war.a ? war.b : war.a };
}

/* ============================================================
 * 条款价值
 * ============================================================ */

export function emptyTerms() {
  return { land: 'keep', clauses: {} };
}

/**
 * 这份和约对某一方的净价值（相对开战前的边界）。
 *
 *   land=keep     领土按现状：我占着他的 +，他占着我的 −
 *   land=restore  双方归零
 *   附加条款      收方 +value，付方 −value
 */
export function dealValue(state, data, war, tag, terms) {
  const other = tag === war.a ? war.b : war.a;

  let v = 0;

  if ((terms.land || 'keep') === 'keep') {
    v += heldValue(state, data, war, tag) - heldValue(state, data, war, other);
  }

  const s = sides(state, data, war);
  for (const c of CLAUSES) {
    if (!terms.clauses?.[c.id]) continue;
    v += s.winner === tag ? c.value : -c.value;
  }

  return round1(v);
}

/** 条款包对"赢家"的净收益（正数，用来判断够不够） */
export function packageValue(state, data, war, terms) {
  const s = sides(state, data, war);
  return dealValue(state, data, war, s.winner, terms);
}

/** 这份和约里，付方要付出多少附加价值 */
export function clauseTotal(terms) {
  let n = 0;
  for (const c of CLAUSES) {
    if (terms.clauses?.[c.id]) n += c.value;
  }
  return n;
}

/* ============================================================
 * AI 的接受线
 * ============================================================ */

/** 厌战度 0..~0.6：打得越久、国内越乱、越被拒，越急着收场 */
export function weariness(state, war, country) {
  if (!country) return 0;

  const days = (state.elapsedDays || 0) - (war.startDay || 0);
  let w = 0;

  if (days > 180) w += Math.min(0.15, (days - 180) / 1200);
  if (country.stability < 50) w += 0.15;
  if (country.war_support < 40) w += 0.15;
  w += Math.min(0.24, (war.rejected || 0) * 0.04);

  return w;
}

/** 赢家想拿多少：分数 × 胃口。胃口 >1 表示"我们在赢，血不能白流" */
export function winnerAppetite(state, war, country) {
  return clamp(1.25 - weariness(state, war, country), 0.5, 1.35);
}

/** 输家愿意亏多少：分数 × 容忍。容忍 >1 表示"再打下去只会更糟" */
export function loserTolerance(state, war, country) {
  return 1.35 + weariness(state, war, country);
}

/**
 * AI 对一份和约的判定。
 * @returns {{accept:boolean, value:number, required:number, gap:number, score:number, reason:string}}
 */
export function aiVerdict(state, data, war, aiTag, terms) {
  const s = sides(state, data, war);
  const score = aiTag === war.a ? s.aScore : s.bScore;
  const country = state.countries[aiTag];
  const value = dealValue(state, data, war, aiTag, terms);

  let required;
  if (score > 0) {
    required = score * winnerAppetite(state, war, country);
  } else if (score < 0) {
    required = score * loserTolerance(state, war, country);
  } else {
    required = 0;
  }

  required = round1(required);
  const gap = round1(required - value);
  const accept = gap <= 0.05;

  return {
    accept,
    value,
    required,
    gap: Math.max(0, gap),
    score,
    reason: accept ? '对方愿意签' : gap > 0 ? '对方觉得还不够' : '',
  };
}

/* ============================================================
 * 和约生效
 * ============================================================ */

/**
 * 执行一份和约。
 * @returns {{ok:boolean, lines:string[], reason?:string}}
 */
export function applyPeace(state, data, war, terms) {
  if (!war) return { ok: false, lines: [], reason: '没有进行中的战争' };

  const a = state.countries[war.a];
  const b = state.countries[war.b];
  if (!a || !b) return { ok: false, lines: [], reason: '参战国不存在' };

  const s = sides(state, data, war);
  const winner = state.countries[s.winner];
  const loser = state.countries[s.loser];
  const lines = [];

  /* ---------- 1. 领土 ---------- */
  let returned = 0;

  if ((terms.land || 'keep') === 'restore') {
    for (const tag of [war.a, war.b]) {
      for (const id of war.start[tag] || []) {
        const p = state.provinces[id];
        if (p && p.owner !== tag) {
          p.owner = tag;
          returned += 1;
        }
      }
    }
  }

  // 停战了，这块地上就不该再有争夺
  for (const p of Object.values(state.provinces)) {
    if (p.owner === war.a || p.owner === war.b ||
        p.contestedBy === war.a || p.contestedBy === war.b) {
      p.contest = 0;
      p.contestedBy = null;
    }
  }

  /* ---------- 2. 附加条款 ---------- */
  const got = [];
  const paid = [];

  if (terms.clauses?.reparations) {
    loser.factories = round2(Math.max(0, loser.factories - 2));
    winner.factories = round2(winner.factories + 2);
    loser.political_power = round2(Math.max(0, loser.political_power - 25));
    winner.political_power = round2(winner.political_power + 25);
    got.push('工厂 +2、政治点数 +25');
    paid.push('工厂 -2、政治点数 -25');
  }

  if (terms.clauses?.disarm) {
    loser.divisions = round2(Math.max(0, (loser.divisions || 0) * 0.65));
    got.push('对方师数 -35%');
    paid.push('师数 -35%');
  }

  if (terms.clauses?.humiliate) {
    loser.stability = clamp(loser.stability - 10, 0, 100);
    loser.war_support = clamp(loser.war_support - 12, 0, 100);
    winner.political_power = round2(winner.political_power + 20);
    winner.war_support = clamp(winner.war_support + 6, 0, 100);
    got.push('政治点数 +20、战争支持 +6');
    paid.push('稳定度 -10、战争支持 -12');
  }

  /* ---------- 3. 收尾 ---------- */
  closeWar(state, war.a, war.b);
  addTruce(state, war.a, war.b);

  // 领土归还后，可能有人又变回"没有国土"，需要重新判定
  if (data.provinces.length > 0) {
    for (const c of [a, b]) {
      if (c.defeated) continue;
      if (provincesOf(state, c.tag).length === 0) {
        c.defeated = true;
        c.atWarWith = [];
        lines.push(`【停战】${c.name} 已无国土，政府流亡`);
      }
    }
  }

  if ((terms.land || 'keep') === 'restore') {
    lines.push(`【和约】${a.name} 与 ${b.name} 恢复战前边界（${returned} 块区域易手）`);
  } else {
    const keep = heldValue(state, data, war, s.winner);
    lines.push(`【和约】${a.name} 与 ${b.name} 停火，${winner.name} 保持占领（战争分数 ${Math.max(s.aScore, s.bScore)}）`);
    if (keep > 0) lines.push(`  · ${loser.name} 割让了约 ${Math.round(keep)}% 的国土价值`);
  }

  if (got.length) lines.push(`  · ${winner.name}：${got.join('；')}`);
  if (paid.length) lines.push(`  · ${loser.name}：${paid.join('；')}`);

  lines.push(`  · 停战协议生效，540 天内双方不能再宣战`);

  return { ok: true, lines, returned, winner: winner.tag, loser: loser.tag };
}

/* ============================================================
 * AI 主动求和
 * ============================================================ */

/** AI 认输时愿意端出来的条件：先保住已经丢掉的，再在容忍范围内加码 */
export function buildAiOffer(state, data, war, aiTag) {
  const s = sides(state, data, war);
  const score = aiTag === war.a ? s.aScore : s.bScore;
  const country = state.countries[aiTag];
  const budget = Math.abs(score) * Math.max(0, loserTolerance(state, war, country) - 1);

  const clauses = {};
  let spent = 0;
  for (const c of [...CLAUSES].sort((x, y) => x.value - y.value)) {
    if (spent + c.value <= budget) {
      clauses[c.id] = true;
      spent += c.value;
    }
  }

  return { land: 'keep', clauses };
}

/**
 * 每天检查：有没有 AI 撑不住想谈了。
 * 只在"输得够惨 + 打得够久 + 国内快散架"时才提，而且不是天天提。
 */
export function peaceTick(state, data) {
  const notes = [];
  state.peaceOffers = state.peaceOffers || [];

  for (const war of state.wars || []) {
    if (state.peaceOffers.some((o) => samePair(o, war))) continue;

    const aiTag = [war.a, war.b].find((t) => t !== state.playerTag);
    if (!aiTag) continue;

    const country = state.countries[aiTag];
    if (!country || country.defeated) continue;

    const s = sides(state, data, war);
    const score = aiTag === war.a ? s.aScore : s.bScore;
    const days = (state.elapsedDays || 0) - (war.startDay || 0);

    if (score > -30) continue;                     // 还没输够，不谈
    if (days < 40) continue;                        // 开战太短，不认输
    if (days - (war.lastOfferDay ?? -9999) < 120) continue;  // 别天天烦人
    if (country.war_support > 55 && country.stability > 60) continue;  // 还撑得住
    if (nextRandom(state) > 0.08) continue;         // 平均 12 天提一次

    const terms = buildAiOffer(state, data, war, aiTag);
    war.lastOfferDay = days;

    state.peaceOffers.push({ a: war.a, b: war.b, from: aiTag, terms });
    notes.push(`【和谈】${country.name} 提出停战，愿意在谈判桌上让步`);
  }

  return notes;
}

export function findOffer(state, a, b) {
  return (state.peaceOffers || []).find(
    (o) => (o.a === a && o.b === b) || (o.a === b && o.b === a)
  ) || null;
}

export function dropOffer(state, a, b) {
  state.peaceOffers = (state.peaceOffers || []).filter(
    (o) => !((o.a === a && o.b === b) || (o.a === b && o.b === a))
  );
}

function samePair(o, war) {
  return (o.a === war.a && o.b === war.b) || (o.a === war.b && o.b === war.a);
}

/* ============================================================
 * 供 UI 的摘要
 * ============================================================ */

/** 一句话说清"现在谈得成什么样" */
export function verdictLine(verdict) {
  if (verdict.accept) return `对方愿意签（评估 ${fmtV(verdict.value)}，接受线 ${fmtV(verdict.required)}）`;
  return `对方拒绝：还差 ${fmtV(verdict.gap)}（评估 ${fmtV(verdict.value)}，接受线 ${fmtV(verdict.required)}）`;
}

export function fmtV(n) {
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : ''}${r}`;
}

/** 把条款包翻成人话列表 */
export function describeTerms(state, data, war, terms) {
  const s = sides(state, data, war);
  const winner = state.countries[s.winner];
  const loser = state.countries[s.loser];

  const out = [{ text: LAND_MODES[terms.land || 'keep'].hint, tone: 'neutral' }];

  for (const c of CLAUSES) {
    if (!terms.clauses?.[c.id]) continue;
    out.push({ text: `${c.name}：${loser.name} ${c.pays}；${winner.name} ${c.takes}`, tone: 'neg' });
  }
  return out;
}

/* ============================================================
 * 小工具
 * ============================================================ */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export { findWar, vpSum };
