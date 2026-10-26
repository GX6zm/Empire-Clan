/**
 * expr.js —— 表达式树求值器
 *
 * 设计原则：数据里的一切逻辑都是 JSON AST，绝不使用 eval / new Function。
 * 因此 mod 作者可以任意编写逻辑，但永远无法执行任意 JavaScript。
 * 这也是 P 社 Clausewitz 脚本的思路：内容与代码分离。
 *
 * 三种节点：
 *   触发器 TRIGGER —— 求值为 boolean
 *   数值   VALUE   —— 求值为 number
 *   效果   EFFECT  —— 产生副作用（修改 state）
 *
 * 求值上下文 ctx = { state, country, source }
 *   state   : 全局游戏状态
 *   country : 当前作用的国家对象
 *   source  : 出错时用于定位的数据来源（如 "focuses.json#GER_root"）
 */

import { labelOf } from './describe.js';

/* ============================================================
 * 错误类型
 * ============================================================ */

export class ExprError extends Error {
  constructor(message, node) {
    super(message);
    this.name = 'ExprError';
    this.node = node;
  }
}

/* ============================================================
 * 操作符清单（校验器与求值器共用同一份，避免两处失配）
 * ============================================================ */

export const TRIGGER_OPS = [
  'always',
  'and', 'or', 'not',
  'cmp',
  'has_focus', 'has_flag', 'country_flag',
  'at_war', 'exists',
  'date_after', 'date_before',
];

export const VALUE_OPS = ['num', 'bool', 'var', 'add', 'sub', 'mul', 'div', 'min', 'max', 'floor'];

export const EFFECT_OPS = [
  'add', 'sub', 'mul', 'set',
  'flag', 'country_flag',
  'add_idea', 'remove_idea',
  'declare_war', 'make_peace',
  'fire_event',
  'log',
];

export const COMPARE_OPS = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq'];

const COMPARE = {
  gte: (a, b) => a >= b,
  gt: (a, b) => a > b,
  lte: (a, b) => a <= b,
  lt: (a, b) => a < b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

/* ============================================================
 * 内部工具
 * ============================================================ */

function fail(msg, node) {
  throw new ExprError(msg, node);
}

/** 有界的数值字段。超出范围的写入会被夹住，而不是让状态跑飞。 */
const CLAMPS = {
  'country.stability': [0, 100],
  'country.war_support': [0, 100],
  'country.factories': [0, Infinity],
  'country.manpower': [0, Infinity],
  'country.political_power': [0, Infinity],
};

export function clampForTarget(target, value) {
  const range = CLAMPS[target];
  if (!range) return value;
  return Math.min(range[1], Math.max(range[0], value));
}

function asCountry(tag, ctx) {
  if (!tag) return ctx.country;
  const c = ctx.state.countries[tag];
  if (!c) fail(`引用了不存在的国家 ${tag}`, tag);
  return c;
}

/**
 * 解析取值路径，如 "country.political_power" / "global.some_flag"
 * 只允许 country 与 global 两个作用域，防止 mod 触达任意对象。
 */
function resolvePath(path, ctx) {
  if (typeof path !== 'string') fail('var 需要字符串形式的 path', path);
  const parts = path.split('.');
  const scope = parts.shift();

  let cur;
  if (scope === 'country') cur = ctx.country;
  else if (scope === 'global') cur = ctx.state.globals;
  else fail(`未知取值域 "${scope}"（只支持 country / global）`, path);

  for (const key of parts) {
    if (cur == null) return 0;
    cur = cur[key];
  }
  return cur === undefined ? 0 : cur;
}

function resolveTarget(path, ctx) {
  if (typeof path !== 'string') fail('效果需要字符串形式的 target', path);
  const parts = path.split('.');
  const scope = parts.shift();

  let obj;
  if (scope === 'country') obj = ctx.country;
  else if (scope === 'global') obj = ctx.state.globals;
  else fail(`未知目标域 "${scope}"（只支持 country / global）`, path);

  const key = parts.pop();
  for (const k of parts) {
    if (obj[k] == null) obj[k] = {};
    obj = obj[k];
  }
  return { obj, key };
}

/* ============================================================
 * 数值求值
 * ============================================================ */

export function evalValue(node, ctx) {
  if (typeof node === 'number') return node;
  if (typeof node === 'boolean') return node ? 1 : 0;
  if (node == null) return 0;
  if (typeof node !== 'object' || Array.isArray(node)) {
    fail(`数值节点必须是对象或数字，收到 ${JSON.stringify(node)}`, node);
  }

  switch (node.op) {
    case 'num':
      return Number(node.value ?? 0);

    case 'bool':
      return node.value ? 1 : 0;

    case 'var':
      return Number(resolvePath(node.path, ctx) ?? 0);

    case 'add':
      return (node.args || []).reduce((sum, n) => sum + evalValue(n, ctx), 0);

    case 'sub': {
      const vals = (node.args || []).map((n) => evalValue(n, ctx));
      if (vals.length === 0) return 0;
      return vals.slice(1).reduce((a, b) => a - b, vals[0]);
    }

    case 'mul':
      return (node.args || []).reduce((prod, n) => prod * evalValue(n, ctx), 1);

    case 'div': {
      const [a = 0, b = 1] = (node.args || []).map((n) => evalValue(n, ctx));
      return b === 0 ? 0 : a / b;
    }

    case 'min':
      return Math.min(...(node.args || []).map((n) => evalValue(n, ctx)));

    case 'max':
      return Math.max(...(node.args || []).map((n) => evalValue(n, ctx)));

    case 'floor':
      return Math.floor(evalValue(node.arg, ctx));

    default:
      fail(`未知数值操作 ${node.op}`, node);
  }
}

/* ============================================================
 * 触发器求值
 * ============================================================ */

export function evalTrigger(node, ctx) {
  if (node == null) return true;
  if (typeof node === 'boolean') return node;
  if (typeof node !== 'object' || Array.isArray(node)) {
    fail(`触发器必须是对象，收到 ${JSON.stringify(node)}`, node);
  }

  switch (node.op) {
    case 'always':
      return true;

    case 'and':
      return (node.args || []).every((n) => evalTrigger(n, ctx));

    case 'or':
      return (node.args || []).some((n) => evalTrigger(n, ctx));

    case 'not':
      return !evalTrigger(node.arg, ctx);

    case 'cmp': {
      const fn = COMPARE[node.cmp];
      if (!fn) fail(`未知比较符 "${node.cmp}"`, node);
      return fn(evalValue(node.lhs, ctx), evalValue(node.rhs, ctx));
    }

    case 'has_focus': {
      const c = asCountry(node.tag, ctx);
      return c.focuses.completed.includes(node.id);
    }

    case 'has_flag':
      return Boolean(ctx.state.globals[node.flag]);

    case 'country_flag':
      return Boolean(ctx.country.flags?.[node.flag]);

    case 'at_war': {
      const c = asCountry(node.tag, ctx);
      return c.atWarWith.length > 0;
    }

    case 'exists':
      return Boolean(ctx.state.countries[node.tag]);

    case 'date_after':
      return compareDate(ctx.state.date, node.date) > 0;

    case 'date_before':
      return compareDate(ctx.state.date, node.date) < 0;

    default:
      fail(`未知触发器 "${node.op}"`, node);
  }
}

/** 把日期转成可比较的整数 yyyymmdd */
export function dateKey(d) {
  return d.year * 10000 + d.month * 100 + d.day;
}

export function compareDate(a, b) {
  return Math.sign(dateKey(a) - dateKey(b));
}

/* ============================================================
 * 效果执行
 * ============================================================ */

/**
 * 执行一组效果。
 * @returns {string[]} 人类可读的变更说明（用于日志）
 */
export function applyEffects(effects, ctx) {
  const notes = [];
  for (const eff of effects || []) {
    applyEffect(eff, ctx, notes);
  }
  return notes;
}

function applyEffect(eff, ctx, notes) {
  if (!eff || typeof eff !== 'object') fail('效果必须是对象', eff);

  switch (eff.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'set': {
      const { obj, key } = resolveTarget(eff.target, ctx);
      const prev = Number(obj[key] ?? 0);
      const val = evalValue(eff.value, ctx);
      let next;
      if (eff.op === 'add') next = prev + val;
      else if (eff.op === 'sub') next = prev - val;
      else if (eff.op === 'mul') next = prev * val;
      else next = val;

      // 百分比类数值必须有上下界，否则一个 -25 就能让稳定度变成负数
      const range = CLAMPS[eff.target];
      if (range) next = Math.min(range[1], Math.max(range[0], next));

      obj[key] = next;
      if (eff.silent !== true) {
        const d = next - prev;
        const sign = d >= 0 ? '+' : '';
        const label = labelOf(eff.target);
        notes.push(`${label} ${eff.op === 'set' ? '=' : sign}${fmt(eff.op === 'set' ? next : d)}`);
      }
      break;
    }

    case 'flag':
      ctx.state.globals[eff.flag] = eff.value === undefined ? true : eff.value;
      notes.push(`全局标记 ${eff.flag} = ${ctx.state.globals[eff.flag]}`);
      break;

    case 'country_flag':
      ctx.country.flags = ctx.country.flags || {};
      ctx.country.flags[eff.flag] = eff.value === undefined ? true : eff.value;
      notes.push(`标记 ${eff.flag} 已设置`);
      break;

    case 'add_idea':
      if (!ctx.country.ideas.includes(eff.id)) ctx.country.ideas.push(eff.id);
      notes.push(`获得国家精神「${eff.id}」`);
      break;

    case 'remove_idea': {
      const i = ctx.country.ideas.indexOf(eff.id);
      if (i >= 0) ctx.country.ideas.splice(i, 1);
      notes.push(`移除国家精神「${eff.id}」`);
      break;
    }

    case 'declare_war': {
      const other = asCountry(eff.tag, ctx);
      if (other.tag !== ctx.country.tag) {
        if (!ctx.country.atWarWith.includes(other.tag)) ctx.country.atWarWith.push(other.tag);
        if (!other.atWarWith.includes(ctx.country.tag)) other.atWarWith.push(ctx.country.tag);
        notes.push(`向 ${other.name} 宣战`);
      }
      break;
    }

    case 'make_peace': {
      const other = asCountry(eff.tag, ctx);
      ctx.country.atWarWith = ctx.country.atWarWith.filter((t) => t !== other.tag);
      other.atWarWith = other.atWarWith.filter((t) => t !== ctx.country.tag);
      notes.push(`与 ${other.name} 停战`);
      break;
    }

    case 'fire_event':
      ctx.state.eventQueue.push({ eventId: eff.id, tag: ctx.country.tag });
      notes.push(`触发事件「${eff.id}」`);
      break;

    case 'log':
      notes.push(String(eff.text ?? ''));
      break;

    default:
      fail(`未知效果 "${eff.op}"`, eff);
  }
}

function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/* ============================================================
 * 遍历器（供校验器使用）
 * ============================================================ */

/** 深度遍历一个触发器树，对每个节点调用 visit(node) */
export function walkTrigger(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.args)) node.args.forEach((n) => walkTrigger(n, visit));
  if (node.arg) walkTrigger(node.arg, visit);
  if (node.lhs !== undefined) walkValue(node.lhs, visit);
  if (node.rhs !== undefined) walkValue(node.rhs, visit);
}

/** 深度遍历一个数值树 */
export function walkValue(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.args)) node.args.forEach((n) => walkValue(n, visit));
  if (node.arg) walkValue(node.arg, visit);
}

/** 遍历效果列表，同时遍历其中的数值子节点 */
export function walkEffects(effects, visit) {
  for (const eff of effects || []) {
    if (!eff || typeof eff !== 'object') continue;
    visit(eff);
    if (eff.value !== undefined) walkValue(eff.value, visit);
  }
}
