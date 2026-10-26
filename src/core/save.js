/**
 * save.js —— 存档序列化与版本迁移
 *
 * 这类游戏最容易被忽视、也最容易让玩家骂人的地方就在这里：
 * 你更新了 v1.1，玩家第 20 小时的存档打不开了。
 *
 * 所以从第一行代码开始：
 *   - 存档里永远写死 saveVersion
 *   - 每次破坏兼容就 +1，并且 MUST 在 MIGRATIONS 里补一个迁移函数
 *   - 迁移函数只做"补字段/改字段名"，不做玩法逻辑
 */

import { SAVE_VERSION } from './state.js';
import { findWar, provincesOf, vpSum } from './war.js';

export { SAVE_VERSION };

export const SAVE_FORMAT = 'focus-engine-save';
export const LOCAL_KEY = 'focus-engine.save';

/* ============================================================
 * 写出
 * ============================================================ */

export function serialize(state) {
  return {
    format: SAVE_FORMAT,
    saveVersion: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    state: JSON.parse(JSON.stringify(state)),
  };
}

/* ============================================================
 * 迁移
 * ============================================================ */

/**
 * 每个迁移只负责 "from → from+1"。
 * 新增版本时：把 SAVE_VERSION +1，然后往这里 push 一条。
 */
const MIGRATIONS = [
  { from: 0, to: 1, run: migrate_0_1 },
  { from: 1, to: 2, run: migrate_1_2 },
  { from: 2, to: 3, run: migrate_2_3 },
  { from: 3, to: 4, run: migrate_3_4 },
];

/**
 * 把任意历史版本的存档升级到当前版本。
 * @returns {{ state: object, notes: string[] }}
 */
export function migrate(raw) {
  const notes = [];

  if (!raw || typeof raw !== 'object') {
    throw new Error('存档内容不是合法 JSON 对象');
  }

  let save = raw;

  // 解包外层信封
  if (save.format === SAVE_FORMAT && save.state) {
    notes.push(`存档格式 ${save.format} v${save.saveVersion ?? '?'}`);
    save = save.state;
  } else if (save.state && save.state.countries) {
    notes.push('存档为旧版信封格式');
    save = save.state;
  }

  let v = Number(save.saveVersion ?? 0);
  notes.push(`原始存档版本 v${v}`);

  for (const m of MIGRATIONS) {
    if (v === m.from) {
      save = m.run(save);
      notes.push(`✓ 迁移 v${m.from} → v${m.to}`);
      v = m.to;
    }
  }

  if (v > SAVE_VERSION) {
    throw new Error(`存档版本 v${v} 高于游戏支持的 v${SAVE_VERSION}，请更新游戏`);
  }
  if (v !== SAVE_VERSION) {
    throw new Error(`无法把存档从 v${v} 迁移到 v${SAVE_VERSION}`);
  }

  save.saveVersion = SAVE_VERSION;
  assertShape(save);

  // 读档后一律暂停，避免玩家一打开存档就被推着跑
  save.speed = 0;

  notes.push('✓ 存档结构校验通过');
  return { state: save, notes };
}

/* ---------- 具体迁移 ---------- */

/** v0：史前格式。国家用 pp 表示政治点数，玩家用 player 表示，没有 ideas。 */
function migrate_0_1(s) {
  if (s.player === undefined && s.playerTag === undefined) {
    throw new Error('v0 存档缺少 player / playerTag');
  }
  s.playerTag = s.playerTag || s.player;
  delete s.player;

  for (const c of Object.values(s.countries || {})) {
    if (c.political_power === undefined && c.pp !== undefined) c.political_power = c.pp;
    delete c.pp;
    if (!Array.isArray(c.ideas)) c.ideas = [];
  }

  s.saveVersion = 1;
  return s;
}

/** v1 → v2：补齐 v2 新增的全局字段与每国字段。 */
function migrate_1_2(s) {
  s.globals = s.globals || {};
  s.eventQueue = s.eventQueue || [];
  s.pendingEvents = s.pendingEvents || [];
  s.firedEvents = s.firedEvents || [];
  s.log = s.log || [];
  s.rng = s.rng ?? 19360101;
  s.selectedProvince = s.selectedProvince ?? null;

  for (const c of Object.values(s.countries || {})) {
    c.flags = c.flags || {};
    c.ideas = c.ideas || [];
    c.atWarWith = c.atWarWith || [];
    if (!c.focuses || typeof c.focuses !== 'object') {
      c.focuses = { completed: [], current: null, progress: 0 };
    }
    c.focuses.completed = c.focuses.completed || [];
    c.focuses.current = c.focuses.current ?? null;
    c.focuses.progress = c.focuses.progress ?? 0;
  }

  s.saveVersion = 2;
  return s;
}

/** v2 → v3：加入战争系统（师、崩盘标记、省份运行时状态）。 */
function migrate_2_3(s) {
  for (const c of Object.values(s.countries || {})) {
    c.divisions = c.divisions ?? 4;
    c.defeated = c.defeated ?? false;
  }
  // 旧存档没有省份运行时状态，交给 reconcileWithData 依据当前数据重建
  s.provinces = s.provinces || null;
  s.saveVersion = 3;
  return s;
}

/** v3 → v4：加入和谈（战争档案、停战协议、AI 求和提议、天数计数）。 */
function migrate_3_4(s) {
  s.elapsedDays = Number(s.elapsedDays) || 0;
  s.truces = s.truces && typeof s.truces === 'object' ? s.truces : {};
  s.peaceOffers = [];

  // v3 的战争只有 atWarWith，没有边界快照。这里不能凭空造——
  // 交给 reconcileWithData 用"当前边界"补基准（它才拿得到地图数据）。
  s.wars = [];

  s.saveVersion = 4;
  return s;
}

function assertShape(s) {
  if (!s.countries || typeof s.countries !== 'object') throw new Error('存档缺少 countries');
  if (!s.playerTag) throw new Error('存档缺少 playerTag');
  if (!s.countries[s.playerTag]) throw new Error(`存档中的玩家国家 ${s.playerTag} 不存在`);
  if (!s.date || typeof s.date.year !== 'number') throw new Error('存档缺少合法日期');
}

/* ============================================================
 * 与 mod 变更的兼容处理
 * ============================================================ */

/**
 * 读档后，如果 mod 变了（国策被删除 / 事件被删除），
 * 把状态里悬空的引用清理掉，而不是让游戏崩掉。
 */
export function reconcileWithData(state, data) {
  const notes = [];

  for (const c of Object.values(state.countries)) {
    const before = c.focuses.completed.length;
    c.focuses.completed = c.focuses.completed.filter((id) => Boolean(data.focusById[id]));
    if (before !== c.focuses.completed.length) {
      notes.push(`${c.name}：移除 ${before - c.focuses.completed.length} 个已不存在的国策记录`);
    }

    if (c.focuses.current && !data.focusById[c.focuses.current]) {
      notes.push(`${c.name}：正在进行的国策 ${c.focuses.current} 已不存在，已取消`);
      c.focuses.current = null;
      c.focuses.progress = 0;
    }

    const beforeIdeas = c.ideas.length;
    c.ideas = c.ideas.filter((id) => Boolean(data.ideaById?.[id]));
    if (beforeIdeas !== c.ideas.length) {
      notes.push(`${c.name}：移除 ${beforeIdeas - c.ideas.length} 个已不存在的国家精神`);
    }

    c.atWarWith = c.atWarWith.filter((t) => state.countries[t]);
  }

  /* ---------- 省份归属 ---------- */

  if (!state.provinces || typeof state.provinces !== 'object') {
    state.provinces = {};
    notes.push('重建省份状态（旧存档或地图数据已变更）');
  }

  const validProvinceIds = new Set();

  for (const p of data.provinces) {
    validProvinceIds.add(p.id);
    const ps = state.provinces[p.id];

    if (!ps) {
      state.provinces[p.id] = { id: p.id, owner: p.owner, contest: 0, contestedBy: null };
      continue;
    }

    // 归属国已经不存在（换了 mod）→ 还给地图定义的初始归属
    if (!state.countries[ps.owner]) {
      notes.push(`省份 ${p.id} 的归属国已不存在，恢复初始归属 ${p.owner}`);
      ps.owner = p.owner;
    }
    ps.contest = ps.contest || 0;
    ps.contestedBy = ps.contestedBy || null;

    // 已经停战的，清掉残留的争夺状态
    if (ps.contestedBy && !state.countries[ps.owner]?.atWarWith.includes(ps.contestedBy)) {
      ps.contest = 0;
      ps.contestedBy = null;
    }
  }

  for (const id of Object.keys(state.provinces)) {
    if (!validProvinceIds.has(id)) delete state.provinces[id];
  }

  // 没有任何省份的国家直接判为崩盘，避免它继续出现在战争列表里
  if (data.provinces.length > 0) {
    for (const c of Object.values(state.countries)) {
      const own = Object.values(state.provinces).filter((p) => p.owner === c.tag).length;
      if (own === 0 && !c.defeated) {
        c.defeated = true;
        c.atWarWith = [];
        notes.push(`${c.name} 没有任何领土，标记为崩盘`);
      }
    }
  }

  const before = state.pendingEvents.length;
  state.pendingEvents = state.pendingEvents.filter((p) => data.eventById[p.eventId]);
  if (before !== state.pendingEvents.length) {
    notes.push(`丢弃 ${before - state.pendingEvents.length} 个失效待处理事件`);
  }

  notes.push(...reconcileWars(state, data));

  return notes;
}

/**
 * 战争档案的兜底修复。
 *
 * 三种情况：
 *   1. 档案指向已不存在的国家        → 丢掉
 *   2. 双方其实已经不在交战（崩盘）  → 丢掉
 *   3. 在交战但没有档案（v3 老存档） → 以**当前边界**为基准补一份
 *
 * 第 3 条要特别注意：不能用开战前的边界，那个信息在旧存档里已经丢了。
 * 用当前边界意味着分数从 0 开始算——一个打到一半的老存档读进来，
 * 分数归零，而不是凭空获得一笔战果。
 */
function reconcileWars(state, data) {
  const notes = [];

  state.elapsedDays = Number(state.elapsedDays) || 0;
  state.wars = Array.isArray(state.wars) ? state.wars : [];
  state.truces = state.truces && typeof state.truces === 'object' ? state.truces : {};
  state.peaceOffers = Array.isArray(state.peaceOffers) ? state.peaceOffers : [];

  const beforeWars = state.wars.length;
  state.wars = state.wars.filter((w) => state.countries[w.a] && state.countries[w.b]);
  if (beforeWars !== state.wars.length) {
    notes.push(`丢弃 ${beforeWars - state.wars.length} 份失效的战争档案（参战国已不存在）`);
  }

  state.wars = state.wars.filter(
    (w) =>
      state.countries[w.a].atWarWith.includes(w.b) &&
      state.countries[w.b].atWarWith.includes(w.a)
  );

  // 交战中却没有档案 → 补一份
  let patched = 0;
  for (const a of Object.values(state.countries)) {
    for (const bTag of [...a.atWarWith]) {
      if (a.tag > bTag) continue; // 每对只建一份
      if (!state.countries[bTag]) continue;
      if (findWar(state, a.tag, bTag)) continue;

      const start = { [a.tag]: provincesOf(state, a.tag), [bTag]: provincesOf(state, bTag) };
      state.wars.push({
        a: a.tag,
        b: bTag,
        startDay: state.elapsedDays,
        lastOfferDay: state.elapsedDays,
        rejected: 0,
        start,
        vp: { [a.tag]: vpSum(data, start[a.tag]), [bTag]: vpSum(data, start[bTag]) },
      });
      patched += 1;
    }
  }
  if (patched) {
    notes.push(`为 ${patched} 场进行中的战争补建档案（战争分数从 0 重新计算）`);
  }

  // 补齐单份档案里缺失的字段（手改存档 / 未来版本回填）
  for (const w of state.wars) {
    if (!w.start || typeof w.start !== 'object') {
      w.start = { [w.a]: provincesOf(state, w.a), [w.b]: provincesOf(state, w.b) };
    }
    w.start[w.a] = w.start[w.a] || [];
    w.start[w.b] = w.start[w.b] || [];
    if (!w.vp || typeof w.vp[w.a] !== 'number' || typeof w.vp[w.b] !== 'number') {
      w.vp = { [w.a]: vpSum(data, w.start[w.a]), [w.b]: vpSum(data, w.start[w.b]) };
    }
    w.rejected = Number(w.rejected) || 0;
    w.startDay = Number(w.startDay) || 0;
    w.lastOfferDay = Number(w.lastOfferDay) || 0;
  }

  // 指向已结束战争的求和提议要清掉，否则读档后会弹一个不存在的谈判
  const beforeOffers = state.peaceOffers.length;
  state.peaceOffers = state.peaceOffers.filter((o) => findWar(state, o.a, o.b));
  if (beforeOffers !== state.peaceOffers.length) {
    notes.push(`丢弃 ${beforeOffers - state.peaceOffers.length} 份失效的求和提议`);
  }

  return notes;
}

/* ============================================================
 * localStorage 封装（非浏览器环境自动降级）
 * ============================================================ */

export function saveToLocal(state) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(serialize(state)));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function loadFromLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hasLocalSave() {
  try {
    return Boolean(localStorage.getItem(LOCAL_KEY));
  } catch {
    return false;
  }
}

export function clearLocalSave() {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* 忽略 */
  }
}
