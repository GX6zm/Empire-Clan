/**
 * run.mjs —— 核心层单元测试 + 数据集成测试
 *
 * 全部跑在 Node 里，不依赖浏览器、不依赖任何 npm 包。
 *   node tests/run.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evalTrigger, evalValue, applyEffects } from '../src/core/expr.js';
import {
  focusAvailability,
  startFocus,
  completeFocus,
  aiPickFocus,
  canAfford,
} from '../src/core/rules.js';
import { createState, advanceDay, SAVE_VERSION } from '../src/core/state.js';
import { loadGameData, orderMods, satisfies } from '../src/core/load.js';
import { validateData, hasErrors } from '../src/core/validate.js';
import { migrate, serialize, reconcileWithData } from '../src/core/save.js';
import { aggregateModifiers, modifierEntries, formatModifier } from '../src/core/modifiers.js';
import { declareWar, makePeace, atWar, armyPower, frontPower, provincesOf, findWar, truceDaysLeft, TRUCE_DAYS } from '../src/core/war.js';
import {
  warScore,
  heldValue,
  dealValue,
  aiVerdict,
  applyPeace,
  emptyTerms,
  sides,
  peaceTick,
  weariness,
  loserTolerance,
  winnerAppetite,
  CLAUSES,
  findOffer,
  dropOffer,
} from '../src/core/peace.js';
import { describeEffect } from '../src/core/describe.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ============================================================
 * 迷你断言框架
 * ============================================================ */

let passed = 0;
let failed = 0;
const failures = [];

function report(name, err) {
  if (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
  } else {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  }
}

function test(name, fn) {
  try {
    fn();
    report(name, null);
  } catch (err) {
    report(name, err);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    report(name, null);
  } catch (err) {
    report(name, err);
  }
}

function group(name) {
  console.log(`\n\x1b[36m▸ ${name}\x1b[0m`);
}

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}期望 ${b}，实际 ${a}`);
}

function ok(v, msg = '断言失败') {
  if (!v) throw new Error(msg);
}

function throws(fn, msg = '应当抛出异常') {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

/* ============================================================
 * 测试夹具
 * ============================================================ */

function makeMiniData() {
  const focuses = [
    { id: 'A', tag: 'GER', name: '甲', cost: 5, x: 0, y: 0, effects: [{ op: 'add', target: 'country.political_power', value: { op: 'num', value: 10 } }] },
    { id: 'B', tag: 'GER', name: '乙', cost: 5, x: 1, y: 1, prereqs: ['A'], mutually_exclusive: ['C'], effects: [{ op: 'add', target: 'country.factories', value: { op: 'num', value: 2 } }] },
    { id: 'C', tag: 'GER', name: '丙', cost: 5, x: 2, y: 1, prereqs: ['A'], mutually_exclusive: ['B'], effects: [] },
    { id: 'D', tag: 'GER', name: '丁', cost: 5, x: 1, y: 2, prereqs_any: ['B', 'C'], effects: [] },
    { id: 'E', tag: 'GER', name: '戊', cost: 5, x: 4, y: 4, available: { op: 'cmp', cmp: 'gte', lhs: { op: 'var', path: 'country.factories' }, rhs: { op: 'num', value: 99 } }, effects: [] },
    { id: 'F', tag: 'FRA', name: '己', cost: 5, x: 0, y: 0, effects: [] },
    { id: 'G', tag: 'GER', name: '庚', cost: 5, x: 5, y: 5, pp_cost: 40, effects: [] },
  ];

  const ideas = [
    { id: 'test_idea', name: '测试精神', icon: '★', modifiers: { factory_output: 0.2, political_power_gain: -0.1 } },
    { id: 'speed_idea', name: '加速', icon: '⚡', modifiers: { focus_speed: 0.5 } },
    { id: 'stable_idea', name: '稳固', icon: '▲', modifiers: { stability_drift: 0.5 } },
  ];

  const byTag = {};
  for (const f of focuses) {
    if (!byTag[f.tag]) byTag[f.tag] = [];
    byTag[f.tag].push(f);
  }

  return {
    config: {
      version: '1.0.0',
      playerTag: 'GER',
      startDate: { year: 1936, month: 1, day: 1 },
      speeds: [0, 100, 50, 20, 10, 5],
      countries: [
        { tag: 'GER', name: '德国', color: '#888', stats: { factories: 5, political_power: 0 } },
        { tag: 'FRA', name: '法国', color: '#445', stats: { factories: 3 } },
      ],
    },
    focuses,
    focusesByTag: byTag,
    focusById: Object.fromEntries(focuses.map((f) => [f.id, f])),
    ideas,
    ideaById: Object.fromEntries(ideas.map((i) => [i.id, i])),
    events: [],
    eventById: {},
    provinces: [],
    provinceById: {},
    sources: {},
  };
}

function runDays(state, data, n) {
  for (let i = 0; i < n; i++) advanceDay(state, data);
}

/* ---------- 战争夹具 ---------- */

function makeWarData() {
  const provinces = [
    { id: 'g1', name: '甲地', owner: 'GER', x: 0, y: 0, vp: 5, neighbors: ['g2'] },
    { id: 'g2', name: '乙地', owner: 'GER', x: 1, y: 0, vp: 5, neighbors: ['g1', 'f1'] },
    { id: 'f1', name: '丙地', owner: 'FRA', x: 2, y: 0, vp: 5, neighbors: ['g2'] },
  ];

  const ideas = [
    { id: 'strong', name: '强军', modifiers: { army_strength: 0.5 } },
  ];

  return {
    config: {
      version: '1.0.0',
      playerTag: 'GER',
      startDate: { year: 1936, month: 1, day: 1 },
      speeds: [0, 100, 50, 20, 10, 5],
      countries: [
        { tag: 'GER', name: '德国', color: '#888', stats: { divisions: 12, factories: 5, political_power: 0 } },
        { tag: 'FRA', name: '法国', color: '#445', stats: { divisions: 2, factories: 3, political_power: 0 } },
      ],
    },
    focuses: [],
    focusesByTag: {},
    focusById: {},
    ideas,
    ideaById: Object.fromEntries(ideas.map((i) => [i.id, i])),
    events: [],
    eventById: {},
    provinces,
    provinceById: Object.fromEntries(provinces.map((p) => [p.id, p])),
    sources: {},
  };
}

/* ---------- 和谈夹具 ---------- */

function makePeaceData() {
  const provinces = [
    { id: 'g1', name: '甲', owner: 'GER', x: 0, y: 0, vp: 5, neighbors: ['g2'] },
    { id: 'g2', name: '乙', owner: 'GER', x: 1, y: 0, vp: 5, neighbors: ['g1', 'g3'] },
    { id: 'g3', name: '丙', owner: 'GER', x: 2, y: 0, vp: 5, neighbors: ['g2', 'f1'] },
    { id: 'f1', name: '丁', owner: 'FRA', x: 3, y: 0, vp: 5, neighbors: ['g3', 'f2'] },
    { id: 'f2', name: '戊', owner: 'FRA', x: 4, y: 0, vp: 5, neighbors: ['f1', 'f3'] },
    { id: 'f3', name: '己', owner: 'FRA', x: 5, y: 0, vp: 5, neighbors: ['f2'] },
  ];

  return {
    config: {
      version: '1.0.0',
      playerTag: 'GER',
      startDate: { year: 1936, month: 1, day: 1 },
      speeds: [0, 100, 50, 20, 10, 5],
      countries: [
        {
          tag: 'GER', name: '德国', color: '#888',
          stats: { divisions: 12, factories: 5, political_power: 0, stability: 60, war_support: 60 },
        },
        {
          tag: 'FRA', name: '法国', color: '#445',
          stats: { divisions: 3, factories: 5, political_power: 40, stability: 60, war_support: 60 },
        },
      ],
    },
    focuses: [],
    focusesByTag: {},
    focusById: {},
    ideas: [],
    ideaById: {},
    events: [],
    eventById: {},
    provinces,
    provinceById: Object.fromEntries(provinces.map((p) => [p.id, p])),
    sources: {},
  };
}

/** 手动模拟"某块地已经被占了"，避免测试里跑几十天战斗 */
function occupy(state, provinceId, tag) {
  state.provinces[provinceId].owner = tag;
}

/* ============================================================
 * 1. 表达式求值器
 * ============================================================ */

group('表达式求值器（expr.js）');

{
  const data = makeMiniData();
  const state = createState(data, { seed: 1 });
  const country = state.countries.GER;
  const ctx = { state, country };

  test('数值：加法 / 乘法 / 取值', () => {
    eq(evalValue({ op: 'add', args: [{ op: 'num', value: 3 }, { op: 'num', value: 4 }] }, ctx), 7);
    eq(evalValue({ op: 'mul', args: [{ op: 'num', value: 3 }, { op: 'num', value: 4 }] }, ctx), 12);
    eq(evalValue({ op: 'var', path: 'country.factories' }, ctx), 5);
    eq(evalValue({ op: 'var', path: 'country.not_exist' }, ctx), 0, '缺失字段应回退为 0：');
  });

  test('触发器：比较 / and / or / not', () => {
    const factories = { op: 'var', path: 'country.factories' };
    eq(evalTrigger({ op: 'cmp', cmp: 'gte', lhs: factories, rhs: { op: 'num', value: 5 } }, ctx), true);
    eq(evalTrigger({ op: 'cmp', cmp: 'lt', lhs: factories, rhs: { op: 'num', value: 5 } }, ctx), false);
    eq(evalTrigger({ op: 'and', args: [true, true] }, ctx), true);
    eq(evalTrigger({ op: 'or', args: [false, true] }, ctx), true);
    eq(evalTrigger({ op: 'not', arg: true }, ctx), false);
    eq(evalTrigger(null, ctx), true, 'null 触发器应为 true：');
  });

  test('触发器：日期比较', () => {
    eq(evalTrigger({ op: 'date_after', date: { year: 1935, month: 12, day: 31 } }, ctx), true);
    eq(evalTrigger({ op: 'date_after', date: { year: 1936, month: 1, day: 1 } }, ctx), false);
    eq(evalTrigger({ op: 'date_before', date: { year: 1937, month: 1, day: 1 } }, ctx), true);
  });

  test('效果：add / set / flag', () => {
    applyEffects([
      { op: 'add', target: 'country.political_power', value: { op: 'num', value: 10 } },
      { op: 'set', target: 'country.stability', value: { op: 'num', value: 80 } },
      { op: 'flag', flag: 'foo' },
    ], ctx);

    eq(country.political_power, 10);
    eq(country.stability, 80);
    eq(state.globals.foo, true);
  });

  test('效果：宣战是双向的', () => {
    applyEffects([{ op: 'declare_war', tag: 'FRA' }], ctx);
    ok(country.atWarWith.includes('FRA'));
    ok(state.countries.FRA.atWarWith.includes('GER'));
  });

  test('未知操作符会抛错（而不是静默失败）', () => {
    throws(() => evalTrigger({ op: 'nonsense' }, ctx));
    throws(() => evalValue({ op: 'nonsense' }, ctx));
    throws(() => applyEffects([{ op: 'nonsense' }], ctx));
  });
}

/* ============================================================
 * 2. 国策规则
 * ============================================================ */

group('国策规则（rules.js）');

{
  const data = makeMiniData();
  const state = createState(data, { seed: 42 });
  const ger = state.countries.GER;

  test('别的国家的国策不会被误当成可解锁', () => {
    const r = focusAvailability(state, data, ger, data.focusById.F);
    eq(r.ok, false);
    eq(r.code, 'other');
  });

  test('无前置的国策可解锁', () => {
    ok(focusAvailability(state, data, ger, data.focusById.A).ok);
  });

  test('缺前置时不可解锁，并给出可读原因', () => {
    const r = focusAvailability(state, data, ger, data.focusById.B);
    eq(r.ok, false);
    ok(r.reason.includes('缺少前置'), `原因应提到前置：${r.reason}`);
  });

  test('开始国策需要消耗天数', () => {
    const r = startFocus(state, data, ger, data.focusById.A);
    ok(r.ok);
    eq(ger.focuses.current, 'A');
    runDays(state, data, 4);
    eq(ger.focuses.completed.length, 0, '4 天还不够：');
    runDays(state, data, 1);
    eq(ger.focuses.completed, ['A']);
    eq(ger.focuses.current, null);
  });

  test('完成国策会施加效果', () => {
    ok(ger.political_power >= 10, `政治点数应 ≥10，实际 ${ger.political_power}`);
  });

  test('互斥：进行中的国策会封锁互斥项，完成后永久锁死', () => {
    const r = startFocus(state, data, ger, data.focusById.B);
    ok(r.ok, `应能开始 B：${r.reason}`);

    const during = focusAvailability(state, data, ger, data.focusById.C);
    eq(during.ok, false);
    eq(during.code, 'excl_current');

    completeFocus(state, data, ger, data.focusById.B);

    const after = focusAvailability(state, data, ger, data.focusById.C);
    eq(after.ok, false);
    eq(after.code, 'excl');
    ok(after.reason.includes('互斥'), after.reason);
  });

  test('prereqs_any：任一满足即可', () => {
    ok(focusAvailability(state, data, ger, data.focusById.D).ok);
  });

  test('available 条件不满足时不可解锁', () => {
    const r = focusAvailability(state, data, ger, data.focusById.E);
    eq(r.code, 'cond');
  });

  test('同一时间只能进行一个国策', () => {
    const d2 = makeMiniData();
    const s2 = createState(d2, { seed: 1 });
    const g = s2.countries.GER;

    ok(startFocus(s2, d2, g, d2.focusById.A).ok, 'A 应能开始');

    const r = startFocus(s2, d2, g, d2.focusById.B);
    eq(r.ok, false);
    ok(r.reason.includes('正在进行'), r.reason);
  });

  test('政治点数不足时无法启动国策', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    g.political_power = 10;

    const r = startFocus(s, d, g, d.focusById.G);
    eq(r.ok, false);
    ok(r.reason.includes('政治点数'), r.reason);
    eq(g.focuses.current, null);
    eq(canAfford(g, d.focusById.G), false);
  });

  test('启动国策会真的扣掉政治点数', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    g.political_power = 100;

    const r = startFocus(s, d, g, d.focusById.G);
    ok(r.ok, r.reason);
    eq(g.political_power, 60);
    eq(r.spent, 40);
  });

  test('AI 不会选付不起的国策', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    g.political_power = 0;
    for (const f of d.focusesByTag.GER) f.pp_cost = 999;
    aiPickFocus(s, d, g);
    eq(g.focuses.current, null);
  });

  test('AI 选国策是确定性的（同种子同结果）', () => {
    const mk = () => {
      const s = createState(makeMiniData(), { seed: 777 });
      aiPickFocus(s, makeMiniData(), s.countries.FRA);
      return s.countries.FRA.focuses.current;
    };
    eq(mk(), mk());
  });
}

/* ============================================================
 * 3. 国家修正
 * ============================================================ */

group('国家修正（modifiers.js）');

{
  test('国家精神会被记入国家', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    applyEffects([{ op: 'add_idea', id: 'test_idea' }], { state: s, country: s.countries.GER });
    ok(s.countries.GER.ideas.includes('test_idea'));
  });

  test('修正按加法聚合', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    const ctx = { state: s, country: g };
    applyEffects([{ op: 'add_idea', id: 'test_idea' }], ctx);
    applyEffects([{ op: 'add_idea', id: 'speed_idea' }], ctx);

    const mods = aggregateModifiers(d, g);
    eq(mods.factory_output, 0.2);
    eq(mods.political_power_gain, -0.1);
    eq(mods.focus_speed, 0.5);
    eq(mods.stability_drift, 0, '没有提供的修正应为 0：');
  });

  test('未定义的国家精神被忽略而不是崩溃', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    applyEffects([{ op: 'add_idea', id: 'test_idea' }], { state: s, country: g });
    g.ideas.push('ghost_idea');
    eq(aggregateModifiers(d, g).factory_output, 0.2);
  });

  test('UI 只列出非零修正并按绝对值排序', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    applyEffects([{ op: 'add_idea', id: 'test_idea' }], { state: s, country: g });
    const entries = modifierEntries(aggregateModifiers(d, g));
    eq(entries.map((e) => e.key), ['factory_output', 'political_power_gain']);
    eq(formatModifier('factory_output', 0.2), '+20%');
    eq(formatModifier('political_power_gain', -0.1), '-0.1/天');
  });

  test('focus_speed 会加快国策推进', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;
    applyEffects([{ op: 'add_idea', id: 'speed_idea' }], { state: s, country: g });

    startFocus(s, d, g, d.focusById.A); // cost 5
    for (let i = 0; i < 4; i++) advanceDay(s, d); // 4 天 × 1.5 = 6 天进度
    ok(g.focuses.completed.includes('A'), '4 天应完成 5 天的国策（+50% 速度）');
  });

  test('月度经济：工厂产出修正让工厂长更快', () => {
    const run = (withIdea) => {
      const d = makeMiniData();
      const s = createState(d, { seed: 1 });
      const g = s.countries.GER;
      if (withIdea) applyEffects([{ op: 'add_idea', id: 'test_idea' }], { state: s, country: g });
      const before = g.factories;
      s.date = { year: 1936, month: 1, day: 31 };
      advanceDay(s, d); // 进入 2 月 1 日 → 月度结算
      return g.factories - before;
    };

    const base = run(false);
    const boosted = run(true);
    ok(base > 0, '工厂应自然增长');
    ok(boosted > base, `有 +20% 产出时应更快：${boosted} vs ${base}`);
  });

  test('稳定度被夹在 0..100，不会跑成负数', () => {
    const d = makeMiniData();
    const s = createState(d, { seed: 1 });
    const g = s.countries.GER;

    applyEffects([{ op: 'add', target: 'country.stability', value: { op: 'num', value: -999 } }], { state: s, country: g });
    eq(g.stability, 0);

    applyEffects([{ op: 'add', target: 'country.stability', value: { op: 'num', value: 999 } }], { state: s, country: g });
    eq(g.stability, 100);
  });

  test('政治点数有软上限：存量越高产出越低（防止挂机攒钱）', () => {
    const gainAt = (pp) => {
      const d = makeMiniData();
      const s = createState(d, { seed: 1 });
      s.countries.GER.political_power = pp;
      const before = s.countries.GER.political_power;
      advanceDay(s, d);
      return s.countries.GER.political_power - before;
    };

    const low = gainAt(50);
    const mid = gainAt(250);
    const high = gainAt(450);

    ok(low > mid, `250 点时产出应低于 50 点：${mid} vs ${low}`);
    ok(mid > high, `450 点时产出应更低：${high} vs ${mid}`);
    ok(high >= 0.15, '兜底产出不应低于 0.15');
  });
}

/* ============================================================
 * 4. 时间推进
 * ============================================================ */

group('时间推进（state.js）');

{
  const data = makeMiniData();
  const state = createState(data, { seed: 1 });

  test('一天推进一格', () => {
    advanceDay(state, data);
    eq(state.date, { year: 1936, month: 1, day: 2 });
  });

  test('月末进位', () => {
    runDays(state, data, 30);
    eq(state.date.month, 2);
    eq(state.date.day, 1);
  });

  test('年末进位', () => {
    const s2 = createState(data, { seed: 1 });
    s2.date = { year: 1936, month: 12, day: 31 };
    advanceDay(s2, data);
    eq(s2.date, { year: 1937, month: 1, day: 1 });
  });

  test('政治点数会自然增长', () => {
    const s3 = createState(data, { seed: 1 });
    const before = s3.countries.GER.political_power;
    runDays(s3, data, 10);
    ok(s3.countries.GER.political_power > before, '10 天后政治点数应增加');
  });

  test('AI 国家会自己推进国策', () => {
    const s4 = createState(data, { seed: 1 });
    runDays(s4, data, 40);
    ok(s4.countries.FRA.focuses.completed.length > 0, '法国 AI 应至少完成一个国策');
  });
}

/* ============================================================
 * 5. 数据加载 / mod 合并 / patch
 * ============================================================ */

group('数据加载与 mod（load.js）');

const nodeFetchJson = async (url) => {
  const text = await readFile(path.join(ROOT, url), 'utf8');
  return JSON.parse(text);
};

{
  await testAsync('基础数据可加载', async () => {
    const d = await loadGameData({ baseUrl: 'data/', enabledMods: [], fetchJson: nodeFetchJson });
    eq(d.errors, []);
    ok(d.focuses.length >= 20, `国策数量 ${d.focuses.length}`);
    ok(d.ideas.length >= 10, `国家精神数量 ${d.ideas.length}`);
    ok(d.provinces.length >= 24, `省份数量 ${d.provinces.length}`);
    ok(d.mapMeta?.land?.length > 0, '基础地图应有陆地轮廓');
    ok(d.mapMeta?.viewBox?.length === 4, '基础地图应有 viewBox');
    ok(d.provinces.every((p) => Array.isArray(p.poly)), '每个省都应有多边形');
  });

  await testAsync('patch 能改数值而不替换整条定义', async () => {
    const base = await loadGameData({ baseUrl: 'data/', enabledMods: [], fetchJson: nodeFetchJson });
    const modded = await loadGameData({ baseUrl: 'data/', enabledMods: ['imperial-twilight'], fetchJson: nodeFetchJson });

    eq(base.focusById.GER_root.cost, 35, '基础 cost：');
    eq(modded.focusById.GER_root.cost, 20, 'patch 后 cost：');
    eq(modded.focusById.GER_root.name, base.focusById.GER_root.name, 'name 应保持不变：');
    ok(modded.focusById.GER_shadow, 'patch 新增的国策应存在');
    ok(modded.eventById.ev_shadow, 'patch 新增的事件应存在');
  });

  await testAsync('覆盖机制能整条替换定义', async () => {
    const d = await loadGameData({ baseUrl: 'data/', enabledMods: ['hard-mode'], fetchJson: nodeFetchJson });
    eq(d.focusById.GER_eco_autarky.cost, 90);
    ok(d.focusById.GER_eco_autarky.name.includes('铁血'), d.focusById.GER_eco_autarky.name);
  });

  await testAsync('两个 mod 叠加时各自生效', async () => {
    const d = await loadGameData({
      baseUrl: 'data/',
      enabledMods: ['imperial-twilight', 'hard-mode'],
      fetchJson: nodeFetchJson,
    });
    eq(d.errors, []);
    eq(d.focusById.GER_root.cost, 20, 'patch 生效：');
    ok(d.focusById.GER_eco_autarky.name.includes('铁血'), '覆盖生效：');
  });

  await testAsync('加载后的数据通过校验（无 error）', async () => {
    const d = await loadGameData({ baseUrl: 'data/', enabledMods: ['imperial-twilight'], fetchJson: nodeFetchJson });
    const issues = validateData(d);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw new Error(`校验失败：\n${errors.map((e) => `  - ${e.msg} (${e.src})`).join('\n')}`);
    }
    ok(!hasErrors(issues));
  });

  test('mod 加载顺序按 loadAfter 拓扑排序', () => {
    const idx = [
      { id: 'core-ui', loadAfter: ['base'] },
      { id: 'base' },
      { id: 'extra', loadAfter: ['core-ui'] },
    ];
    const order = orderMods(idx, ['core-ui', 'base', 'extra']).map((m) => m.id);
    eq(order, ['base', 'core-ui', 'extra']);
  });

  test('semver 范围判断', () => {
    eq(satisfies('0.1.0', '>=0.1.0'), true);
    eq(satisfies('0.1.0', '>=1.0.0'), false);
    eq(satisfies('1.2.3', '^1.0.0'), true);
    eq(satisfies('2.0.0', '^1.0.0'), false);
  });
}

/* ============================================================
 * 6. 校验器
 * ============================================================ */

group('校验器（validate.js）');

{
  test('能发现悬空的前置引用', () => {
    const d = makeMiniData();
    d.focuses[1].prereqs = ['NOT_EXIST'];
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'error' && i.msg.includes('NOT_EXIST')), '应报错缺少前置');
  });

  test('能发现未知的效果操作符', () => {
    const d = makeMiniData();
    d.focuses[0].effects = [{ op: 'explode_everything' }];
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'error' && i.msg.includes('explode_everything')));
  });

  test('能警告不对称的互斥关系', () => {
    const d = makeMiniData();
    d.focuses[1].mutually_exclusive = ['C'];
    d.focuses[2].mutually_exclusive = [];
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'warn' && i.msg.includes('不对称')));
  });

  test('能发现 fire_event 指向不存在的事件', () => {
    const d = makeMiniData();
    d.focuses[0].effects = [{ op: 'fire_event', id: 'nope' }];
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'error' && i.msg.includes('nope')));
  });

  test('能发现 add_idea 指向不存在的国家精神', () => {
    const d = makeMiniData();
    d.focuses[0].effects = [{ op: 'add_idea', id: 'no_such_idea' }];
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'error' && i.msg.includes('no_such_idea')));
  });

  test('能发现未定义的修正器名', () => {
    const d = makeMiniData();
    const bad = { id: 'bad', name: '坏', modifiers: { bogus_modifier: 1 } };
    d.ideas.push(bad);
    d.ideaById.bad = bad;
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'error' && i.msg.includes('bogus_modifier')));
  });

  test('能发现 grid 坐标重叠', () => {
    const d = makeMiniData();
    d.focuses[2].x = 1;
    d.focuses[2].y = 1;
    const issues = validateData(d);
    ok(issues.some((i) => i.level === 'warn' && i.msg.includes('同一格')));
  });
}

/* ============================================================
 * 7. 存档与迁移
 * ============================================================ */

group('存档与迁移（save.js）');

{
  const data = makeMiniData();

  test('序列化 → 迁移 可往返', () => {
    const state = createState(data, { seed: 5 });
    runDays(state, data, 12);
    const snap = serialize(state);
    const { state: restored } = migrate(JSON.parse(JSON.stringify(snap)));
    eq(restored.date, state.date);
    eq(restored.countries.GER.political_power, state.countries.GER.political_power);
    eq(restored.saveVersion, SAVE_VERSION);
  });

  test('v0 存档可迁移到最新版本（pp → political_power, player → playerTag）', () => {
    const v0 = {
      saveVersion: 0,
      player: 'GER',
      date: { year: 1936, month: 1, day: 1 },
      countries: {
        GER: {
          tag: 'GER', name: '德国', pp: 12,
          focuses: { completed: [], current: null, progress: 0 },
        },
      },
      globals: {}, pendingEvents: [], eventQueue: [], firedEvents: [], log: [], speed: 3,
    };

    const { state, notes } = migrate(v0);
    eq(state.saveVersion, SAVE_VERSION);
    eq(state.playerTag, 'GER');
    eq(state.countries.GER.political_power, 12);
    ok(Array.isArray(state.countries.GER.ideas), 'ideas 应被补齐');
    eq(state.speed, 0, '读档后应暂停：');
    ok(notes.length >= 2);
  });

  test('未来版本的存档会被拒绝，而不是静默损坏', () => {
    throws(
      () => migrate({ saveVersion: 99, playerTag: 'GER', date: { year: 1940, month: 1, day: 1 }, countries: { GER: {} } }),
      '应当拒绝过新版本'
    );
  });

  test('损坏的存档会抛错', () => {
    throws(() => migrate({ saveVersion: 2, countries: {} }));
    throws(() => migrate(null));
  });

  test('reconcile 会清理 mod 变更导致的悬空引用', () => {
    const state = createState(data, { seed: 1 });
    state.countries.GER.focuses.completed = ['A', 'GHOST_FOCUS'];
    state.countries.GER.focuses.current = 'GHOST_FOCUS_2';
    state.countries.GER.ideas = ['test_idea', 'GHOST_IDEA'];
    state.pendingEvents = [{ eventId: 'GHOST_EVENT', tag: 'GER' }];

    const notes = reconcileWithData(state, data);
    eq(state.countries.GER.focuses.completed, ['A']);
    eq(state.countries.GER.focuses.current, null);
    eq(state.countries.GER.ideas, ['test_idea']);
    eq(state.pendingEvents, []);
    ok(notes.length >= 3);
  });
}

/* ============================================================
 * 8. 效果描述
 * ============================================================ */

group('效果描述（describe.js）');

{
  test('正负效果能被正确分类', () => {
    eq(describeEffect({ op: 'add', target: 'country.political_power', value: { op: 'num', value: 25 } }),
      { text: '政治点数 +25', tone: 'pos' });
    eq(describeEffect({ op: 'add', target: 'country.stability', value: { op: 'num', value: -5 } }),
      { text: '稳定度 -5', tone: 'neg' });
    eq(describeEffect({ op: 'add_idea', id: 'X' }), { text: '获得国家精神「X」', tone: 'pos' });
  });
}

/* ============================================================
 * 9. 端到端
 * ============================================================ */

group('端到端 · 军事线（真实数据，1936-1937）');

{
  const data = await loadGameData({ baseUrl: 'data/', enabledMods: ['imperial-twilight'], fetchJson: nodeFetchJson });
  const state = createState(data, { mods: ['imperial-twilight'], seed: 20250101 });
  const ger = state.countries.GER;

  test('默认国策树里有可开始项', () => {
    ok(data.focuses.filter((f) => focusAvailability(state, data, ger, f).ok).length >= 1);
  });

  test('模拟玩家选择：陆军路线', () => {
    const chosen = ['GER_root', 'GER_army', 'GER_doctrine', 'GER_blitz'];
    for (const id of chosen) {
      const r = startFocus(state, data, ger, data.focusById[id]);
      ok(r.ok, `无法开始 ${id}：${r.reason}`);
      let guard = 0;
      while (ger.focuses.current === id && guard++ < 500) advanceDay(state, data);
      ok(ger.focuses.completed.includes(id), `${id} 未完成`);
    }
  });

  test('陆军路线会带来国家精神', () => {
    ok(ger.ideas.includes('army_reform'), '应有陆军改革精神');
    ok(ger.ideas.includes('blitz_doctrine'), '应有闪击战条令精神');
    const mods = aggregateModifiers(data, ger);
    ok(mods.focus_speed > 0, `应有国策速度加成，实际 ${mods.focus_speed}`);
  });

  test('两年后日期正确推进', () => {
    let guard = 0;
    while (guard++ < 2000 && state.date.year < 1938) advanceDay(state, data);
    ok(state.date.year >= 1937, `日期 ${JSON.stringify(state.date)}`);
  });

  test('事件会被触发并排队给玩家', () => {
    ok(state.firedEvents.includes('ev_rhineland'), '莱茵兰事件应已触发');
  });

  test('AI 国家在此期间也推进了国策', () => {
    ok(state.countries.FRA.focuses.completed.length > 0, '法国应完成过国策');
    ok(state.countries.SOV.focuses.completed.length > 0, '苏联应完成过国策');
  });

  test('存档在这一刻仍然可以往返', () => {
    const { state: restored } = migrate(JSON.parse(JSON.stringify(serialize(state))));
    eq(restored.date, state.date);
    eq(restored.countries.GER.focuses.completed, state.countries.GER.focuses.completed);
  });
}

group('端到端 · 经济线（自给路线，10 节点分支）');

{
  const data = await loadGameData({ baseUrl: 'data/', enabledMods: ['imperial-twilight'], fetchJson: nodeFetchJson });
  const state = createState(data, { mods: ['imperial-twilight'], seed: 7 });
  const ger = state.countries.GER;

  const runFocus = (id) => {
    const f = data.focusById[id];
    const r = startFocus(state, data, ger, f);
    ok(r.ok, `无法开始 ${id}：${r.reason}`);
    let guard = 0;
    while (ger.focuses.current === id && guard++ < 500) advanceDay(state, data);
    ok(ger.focuses.completed.includes(id), `${id} 未完成`);
  };

  test('走通 重建国防军 → 四年计划 → 原料自给', () => {
    runFocus('GER_root');
    runFocus('GER_eco_plan');
    runFocus('GER_eco_autarky');
  });

  test('国策授予的国家精神进入国家，且修正被正确加总', () => {
    ok(ger.ideas.includes('four_year_plan'), '应有「四年计划」');
    ok(ger.ideas.includes('autarky'), '应有「自给自足」');

    const mods = aggregateModifiers(data, ger);
    // four_year_plan: +8% 产出 / -0.10 政治点数
    // autarky:        +18% 产出 / -0.25 政治点数
    eq(mods.factory_output, 0.26);
    eq(mods.political_power_gain, -0.35);
  });

  test('自给路线的代价真实存在：稳定度下降', () => {
    ok(ger.stability < 60, `稳定度应因「原料自给」下降，实际 ${ger.stability}`);
  });

  test('互斥路线（对外贸易）被彻底锁死', () => {
    const a = focusAvailability(state, data, ger, data.focusById.GER_eco_trade);
    eq(a.ok, false);
    eq(a.code, 'excl');
  });

  test('政治点数不足时无法启动需要 PP 的国策', () => {
    ger.political_power = 10;
    const r = startFocus(state, data, ger, data.focusById.GER_eco_synfuel); // pp_cost 50
    eq(r.ok, false);
    ok(r.reason.includes('政治点数'), r.reason);
  });

  test('政治点数足够时可以启动，并扣掉 50 点', () => {
    ger.political_power = 200;
    const r = startFocus(state, data, ger, data.focusById.GER_eco_synfuel);
    ok(r.ok, r.reason);
    eq(ger.political_power, 150);
  });

  test('合成燃料完成后，自给路线的工业优势体现出来', () => {
    let guard = 0;
    while (ger.focuses.current === 'GER_eco_synfuel' && guard++ < 500) advanceDay(state, data);
    ok(ger.focuses.completed.includes('GER_eco_synfuel'));
    ok(ger.ideas.includes('synfuel'));

    const mods = aggregateModifiers(data, ger);
    ok(mods.factory_output >= 0.38, `工厂产出修正应叠加到 ≥38%，实际 ${mods.factory_output}`);
    ok(ger.factories > 14, `工厂应已超过 14，实际 ${ger.factories}`);
  });

  test('战争经济必须走到路线尽头才能解锁', () => {
    const before = focusAvailability(state, data, ger, data.focusById.GER_eco_war);
    eq(before.ok, false, '还没走完合成橡胶时不该解锁战争经济');

    runFocus('GER_eco_synrubber');

    const after = focusAvailability(state, data, ger, data.focusById.GER_eco_war);
    ok(after.ok, `走完自给路线后战争经济应解锁：${after.reason}`);
  });
}

group('战争闭环（war.js）');

{
  test('宣战是双向的，并进入战争状态', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });

    const r = declareWar(s, d, 'GER', 'FRA');
    ok(r.ok, r.reason);
    eq(s.countries.GER.atWarWith, ['FRA']);
    eq(s.countries.FRA.atWarWith, ['GER']);
    ok(atWar(s, 'GER', 'FRA'));
  });

  test('没有战争时地块不会凭空易手', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });
    runDays(s, d, 60);
    eq(s.provinces.f1.owner, 'FRA');
    eq(s.provinces.g2.owner, 'GER');
    eq(s.countries.FRA.defeated, false);
  });

  test('强的一方会推进、占领，弱的一方崩盘', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');

    let guard = 0;
    while (s.provinces.f1.owner === 'FRA' && guard++ < 200) advanceDay(s, d);

    eq(s.provinces.f1.owner, 'GER', '法国唯一的地块应被攻占');
    ok(s.countries.FRA.defeated, '失去全部领土应崩盘');
    eq(s.countries.GER.atWarWith, [], '崩盘后战争应结束');
    eq(s.countries.FRA.atWarWith, []);
  });

  test('崩盘的国家不能再被宣战', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    let guard = 0;
    while (!s.countries.FRA.defeated && guard++ < 200) advanceDay(s, d);

    const r = declareWar(s, d, 'GER', 'FRA');
    eq(r.ok, false);
  });

  test('军队战力修正会加快推进', () => {
    const daysToCapture = (withIdea) => {
      const d = makeWarData();
      const s = createState(d, { seed: 42 });
      if (withIdea) {
        applyEffects([{ op: 'add_idea', id: 'strong' }], { state: s, country: s.countries.GER });
      }
      declareWar(s, d, 'GER', 'FRA');
      let n = 0;
      while (s.provinces.f1.owner === 'FRA' && n < 300) {
        advanceDay(s, d);
        n += 1;
      }
      return n;
    };

    const base = daysToCapture(false);
    const boosted = daysToCapture(true);
    ok(boosted < base, `有 +50% 战力时应更快：${boosted} 天 vs ${base} 天`);
  });

  test('停战会清空争夺状态并结束战争', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    runDays(s, d, 1);

    const r = makePeace(s, 'GER', 'FRA');
    ok(r.ok);
    eq(s.countries.GER.atWarWith, []);
    eq(s.provinces.f1.contest, 0);
    eq(s.provinces.f1.contestedBy, null);
  });

  test('战力与战线数量的关系是单调的', () => {
    const d = makeWarData();
    const s = createState(d, { seed: 1 });
    const power = armyPower(s, d, s.countries.GER);
    eq(power, 12);
    // 只有一条战线，所以战线力量 = 全军力量
    eq(frontPower(s, d, 'GER'), 12);
    eq(provincesOf(s, 'GER').length, 2);
  });
}

group('和谈（peace.js）');

{
  test('宣战会建立战争档案，分数从 0 开始', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');

    const war = findWar(s, 'GER', 'FRA');
    ok(war, '应有一份战争档案');
    eq(war.start.GER, ['g1', 'g2', 'g3']);
    eq(war.start.FRA, ['f1', 'f2', 'f3']);
    eq(war.vp.GER, 15);
    eq(war.vp.FRA, 15);
    eq(warScore(s, d, war, 'GER'), 0);
    eq(warScore(s, d, war, 'FRA'), 0);
  });

  test('占下的国土按价值换算成分数，双方互为相反数', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    // 法国开局 3 块 × 5 价值 = 15，占下 1 块 = 33%
    eq(Math.round(heldValue(s, d, war, 'GER')), 33);
    eq(warScore(s, d, war, 'GER'), 33);
    eq(warScore(s, d, war, 'FRA'), -33);
  });

  test('分数按区域价值加权，打大城市比打荒地值钱', () => {
    const d = makePeaceData();
    d.provinceById.f2.vp = 15; // 法国总价值变成 25
    d.provinces.find((p) => p.id === 'f2').vp = 15;

    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');
    const war = findWar(s, 'GER', 'FRA');
    const cheap = warScore(s, d, war, 'GER');

    occupy(s, 'f1', 'FRA');
    const d2 = makePeaceData();
    d2.provinceById.f2.vp = 15;
    d2.provinces.find((p) => p.id === 'f2').vp = 15;
    const s2 = createState(d2, { seed: 1 });
    declareWar(s2, d2, 'GER', 'FRA');
    occupy(s2, 'f2', 'GER');
    const rich = warScore(s2, d2, findWar(s2, 'GER', 'FRA'), 'GER');

    ok(rich > cheap, `高价值区域应带来更高分数：${rich} vs ${cheap}`);
  });

  test('白和平把边界恢复原状，并留下停战期', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const r = makePeace(s, 'GER', 'FRA');
    ok(r.ok);
    eq(s.provinces.f1.owner, 'FRA', '白和平要吐回占来的地');
    eq(findWar(s, 'GER', 'FRA'), null, '战争档案应被清掉');
    ok(s.countries.GER.atWarWith.length === 0);
    ok(truceDaysLeft(s, 'GER', 'FRA') > 0, '应有停战期');
  });

  test('停战期之内不能再宣战', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    applyPeace(s, d, findWar(s, 'GER', 'FRA'), { land: 'restore', clauses: {} });

    const r = declareWar(s, d, 'GER', 'FRA');
    eq(r.ok, false);
    ok(r.reason.includes('停战'), r.reason);
    eq(truceDaysLeft(s, 'GER', 'FRA'), TRUCE_DAYS);

    // 停战期满后可以再打
    s.elapsedDays += TRUCE_DAYS + 1;
    eq(truceDaysLeft(s, 'GER', 'FRA'), 0);
    ok(declareWar(s, d, 'GER', 'FRA').ok);
  });

  test('保持占领的和约：地不还，对方也不会白给', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const terms = { land: 'keep', clauses: { humiliate: true } };

    const v = aiVerdict(s, d, war, 'FRA', terms);
    ok(v.accept, `法国丢了 33% 国土，应接受一个 10 价值的条款：${v.reason} gap=${v.gap}`);

    const r = applyPeace(s, d, war, terms);
    ok(r.ok);
    eq(s.provinces.f1.owner, 'GER', '保持占领，地不该还回去');
    eq(s.provinces.f1.contest, 0);
    eq(s.provinces.f1.contestedBy, null);
    ok(s.countries.FRA.stability < 60, '政治羞辱应压低对方稳定度');
  });

  test('索要过头会被拒绝，并且明确差多少', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    // 33 分只够换 10 价值，一口气要 45 价值必然被拒
    const greedy = { land: 'keep', clauses: { humiliate: true, reparations: true, disarm: true } };
    const v = aiVerdict(s, d, war, 'FRA', greedy);

    eq(v.accept, false);
    ok(v.gap > 0, `应给出还差的额度，实际 ${v.gap}`);
  });

  test('反复谈能把对方磨下来（每次被拒，接受线都更松）', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const greedy = { land: 'keep', clauses: { humiliate: true, reparations: true, disarm: true } };

    const before = aiVerdict(s, d, war, 'FRA', greedy);
    war.rejected += 10;
    const after = aiVerdict(s, d, war, 'FRA', greedy);

    ok(Math.abs(after.required) > Math.abs(before.required),
      `被拒后接受线应更松：${before.required} → ${after.required}`);
    ok(after.gap < before.gap, `差距应缩小：${before.gap} → ${after.gap}`);
  });

  test('战争赔款会转移工厂与政治点数', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');
    occupy(s, 'f2', 'GER'); // 占 67%，才谈得起赔款

    const war = findWar(s, 'GER', 'FRA');
    const terms = { land: 'keep', clauses: { reparations: true } };
    const v = aiVerdict(s, d, war, 'FRA', terms);
    ok(v.accept, `占 67% 时 15 价值的赔款应被接受：gap=${v.gap}`);

    applyPeace(s, d, war, terms);
    eq(s.countries.GER.factories, 7);
    eq(s.countries.FRA.factories, 3);
    eq(s.countries.GER.political_power, 25);
    eq(s.countries.FRA.political_power, 15);
  });

  test('解除武装会削减败方的师数', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');
    occupy(s, 'f2', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const terms = { land: 'keep', clauses: { disarm: true } };
    ok(aiVerdict(s, d, war, 'FRA', terms).accept);

    applyPeace(s, d, war, terms);
    eq(s.countries.FRA.divisions, 1.95);
  });

  test('恢复战前边界对赢家是让步，价值低于保持占领', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const keep = dealValue(s, d, war, 'GER', { land: 'keep', clauses: {} });
    const restore = dealValue(s, d, war, 'GER', { land: 'restore', clauses: {} });

    ok(keep > restore, `保持占领应比恢复边界更有利：${keep} vs ${restore}`);
    eq(restore, 0, '恢复边界后，相对开战前的领土变化应为 0');
  });

  test('条款价值是可加的，赢家输家的价值互为相反数', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const terms = { land: 'keep', clauses: { humiliate: true, reparations: true } };

    const mine = dealValue(s, d, war, 'GER', terms);
    const theirs = dealValue(s, d, war, 'FRA', terms);

    eq(Math.round((mine + theirs) * 10) / 10, 0, '纯转移条款应当是零和的');
    eq(Math.round(mine * 10) / 10, 58.3, '33.3 的领土 + 10 + 15 的条款 = 58.3');
  });

  test('赢家的胃口随厌战下降（打得越久越容易打发）', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const fresh = winnerAppetite(s, war, s.countries.FRA);

    s.countries.FRA.stability = 20;
    s.countries.FRA.war_support = 20;
    war.rejected = 6;
    const tired = winnerAppetite(s, war, s.countries.FRA);

    ok(tired < fresh, `厌战后胃口应下降：${fresh} → ${tired}`);
    ok(weariness(s, war, s.countries.FRA) > 0);
  });

  test('输家愿意接受的损失大于它已经丢掉的（止损）', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const score = warScore(s, d, war, 'FRA'); // -33
    const tol = loserTolerance(s, war, s.countries.FRA);

    ok(tol > 1, `容忍系数应大于 1，实际 ${tol}`);
    ok(Math.abs(score * tol) > Math.abs(score), '输家能承受的比已经丢的更多');
  });

  test('AI 撑不住时会主动求和，条件在它自己的容忍范围内', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 3 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    s.elapsedDays = 200;
    s.countries.FRA.stability = 20;
    s.countries.FRA.war_support = 20;

    let guard = 0;
    while (!findOffer(s, 'GER', 'FRA') && guard++ < 800) peaceTick(s, d);

    const offer = findOffer(s, 'GER', 'FRA');
    ok(offer, '法国崩到 20 稳定度，应该会来求和');
    eq(offer.from, 'FRA');

    const tol = loserTolerance(s, war, s.countries.FRA);
    const budget = Math.abs(warScore(s, d, war, 'FRA')) * (tol - 1);
    const offered = CLAUSES.filter((c) => offer.terms.clauses[c.id]).reduce((n, c) => n + c.value, 0);

    ok(offered <= budget + 0.01, `开价 ${offered} 不该超过它能承受的 ${budget.toFixed(1)}`);
    ok(dealValue(s, d, war, 'GER', offer.terms) > 0, '对玩家来说这份和约应当是赚的');
  });

  test('接受 AI 的提议：战争结束，但打下来的地留住', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 3 });
    declareWar(s, d, 'GER', 'FRA');
    occupy(s, 'f1', 'GER');

    const war = findWar(s, 'GER', 'FRA');
    const terms = { land: 'keep', clauses: { humiliate: true } };
    const r = applyPeace(s, d, war, terms);

    ok(r.ok);
    eq(s.provinces.f1.owner, 'GER');
    eq(findWar(s, 'GER', 'FRA'), null);
    eq(s.countries.GER.atWarWith, []);
  });

  test('和约结束后，双方都不再处于交战状态，其余战线不受影响', () => {
    const d = makePeaceData();
    d.config.countries.push({ tag: 'SOV', name: '苏联', color: '#a33', stats: { divisions: 4 } });
    d.provinces.push({ id: 'r1', name: '苏地', owner: 'SOV', x: 6, y: 0, vp: 5, neighbors: ['f3'] });
    d.provinceById.r1 = d.provinces[d.provinces.length - 1];

    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    declareWar(s, d, 'GER', 'SOV');
    occupy(s, 'f1', 'GER');

    applyPeace(s, d, findWar(s, 'GER', 'FRA'), { land: 'keep', clauses: {} });

    eq(s.countries.GER.atWarWith, ['SOV'], '和法国停战不该影响对苏战争');
    ok(findWar(s, 'GER', 'SOV'), '对苏战争档案应保留');
    eq(s.wars.length, 1);
  });

  test('v3 老存档读入后补建战争档案，分数从 0 重算', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });

    // 手工造一个 v3 存档：只有 atWarWith，没有 wars
    const v3 = JSON.parse(JSON.stringify(s));
    v3.saveVersion = 3;
    delete v3.wars;
    delete v3.truces;
    delete v3.peaceOffers;
    delete v3.elapsedDays;
    v3.countries.GER.atWarWith = ['FRA'];
    v3.countries.FRA.atWarWith = ['GER'];
    v3.provinces.f1.owner = 'GER'; // 打到一半的老存档

    const { state } = migrate(v3);
    const notes = reconcileWithData(state, d);

    ok(notes.some((n) => n.includes('补建档案')), `应提示补建：${notes.join(' / ')}`);

    const war = findWar(state, 'GER', 'FRA');
    ok(war, '应补出一份战争档案');
    eq(warScore(state, d, war, 'GER'), 0, '老存档没有开战边界，只能从 0 开始算');
  });

  test('读档会丢掉指向已结束战争的求和提议', () => {
    const d = makePeaceData();
    const s = createState(d, { seed: 1 });
    declareWar(s, d, 'GER', 'FRA');
    s.peaceOffers.push({ a: 'GER', b: 'FRA', from: 'FRA', terms: { land: 'keep', clauses: {} } });

    // 战争在存档前就结束了，但提议没清
    makePeace(s, 'GER', 'FRA');
    s.peaceOffers.push({ a: 'GER', b: 'FRA', from: 'FRA', terms: { land: 'keep', clauses: {} } });

    const notes = reconcileWithData(s, d);
    eq(s.peaceOffers.length, 0);
    ok(notes.some((n) => n.includes('求和提议')));
  });
}

group('端到端 · 完全替换 mod（德意志 → 东亚）');

{
  const data = await loadGameData({ baseUrl: 'data/', enabledMods: ['celestial-revival'], fetchJson: nodeFetchJson });

  await testAsync('加载不报错，且通过校验', async () => {
    eq(data.errors, []);
    const issues = validateData(data);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      throw new Error(`校验失败：\n${errors.map((e) => `  - ${e.msg} (${e.src})`).join('\n')}`);
    }
  });

  test('玩家国家、地图、国策树全部换成了新的', () => {
    eq(data.config.playerTag, 'CHN');
    eq(data.config.countries.length, 4);
    ok(data.provinceById.beiping, '应有东亚地图');
    ok(data.focusById.CHN_root, '应有中华国策树');
    ok(data.provinces.length >= 36, `东亚地图应覆盖整个东亚，实际 ${data.provinces.length} 个省`);
    ok(data.provinceById.jiuzhou && data.provinceById.guangdong && data.provinceById.menggu,
      '应覆盖日本、华南、蒙古');
  });

  test('基础游戏内容完全不存在（没有被混进来）', () => {
    eq(data.focusById.GER_root, undefined);
    eq(data.provinceById.berlin, undefined);
    eq(data.ideaById.autarky, undefined);
    eq(data.eventById.ev_rhineland, undefined);
  });

  await testAsync('与其他 mod 同时启用时，完全替换型独占加载', async () => {
    const d = await loadGameData({
      baseUrl: 'data/',
      enabledMods: ['celestial-revival', 'imperial-twilight'],
      fetchJson: nodeFetchJson,
    });
    eq(d.errors, [], '不应因为 patch 找不到 GER_root 而报错');
    eq(d.focusById.GER_root, undefined);
    ok(d.logs.some((l) => l.includes('独占加载')), '日志里应说明独占加载');
  });

  const state = createState(data, { seed: 3 });
  const chn = state.countries.CHN;

  test('运行时状态用的是新地图', () => {
    eq(state.playerTag, 'CHN');
    eq(state.provinces.beiping.owner, 'CHN');
    eq(state.provinces.jiuzhou.owner, 'JPN');
    eq(state.countries.CHN.divisions, 6);
  });

  test('走完整条抗战国策线并主动宣战', () => {
    const path = ['CHN_root', 'CHN_army', 'CHN_industry', 'CHN_rail', 'CHN_arsenal', 'CHN_total', 'CHN_mobile', 'CHN_resist'];
    for (const id of path) {
      chn.political_power = Math.max(chn.political_power, 200);
      chn.focuses.current = null;
      const r = startFocus(state, data, chn, data.focusById[id]);
      ok(r.ok, `无法开始 ${id}：${r.reason}`);
      let guard = 0;
      while (chn.focuses.current === id && guard++ < 800) advanceDay(state, data);
      ok(chn.focuses.completed.includes(id), `${id} 未完成`);
    }

    ok(state.countries.CHN.atWarWith.includes('JPN'), '抗战国策应真的对日宣战');
    ok(state.countries.JPN.atWarWith.includes('CHN'));
  });

  test('战争在东亚地图上真的推进了', () => {
    let guard = 0;
    while (state.provinces.chaoxian.owner === 'JPN' && guard++ < 400) advanceDay(state, data);
    eq(state.provinces.chaoxian.owner, 'CHN', '日军应丢掉朝鲜');
  });

  test('这个 mod 的存档同样可以往返', () => {
    const { state: restored } = migrate(JSON.parse(JSON.stringify(serialize(state))));
    eq(restored.playerTag, 'CHN');
    eq(restored.provinces.chaoxian.owner, state.provinces.chaoxian.owner);
  });
}

/* ============================================================
 * 汇总
 * ============================================================ */

console.log('\n' + '─'.repeat(56));
console.log(`  通过 ${passed}　失败 ${failed}`);
console.log('─'.repeat(56));

if (failed > 0) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`  · ${f.name}\n    ${f.err.stack?.split('\n')[0] || f.err.message}`);
  }
  process.exit(1);
}
