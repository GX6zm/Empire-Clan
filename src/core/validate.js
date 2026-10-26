/**
 * validate.js —— 加载期校验
 *
 * 目的：让 mod 作者的错误在"进入游戏之前"就被指出来，并且精确到文件。
 * 这是 mod 生态体验的关键——比任何功能都重要。
 */

import {
  TRIGGER_OPS,
  VALUE_OPS,
  EFFECT_OPS,
  COMPARE_OPS,
} from './expr.js';
import { MODIFIER_KEYS } from './modifiers.js';

/**
 * @returns {{level:'error'|'warn', msg:string, src:string}[]}
 */
export function validateData(data) {
  const issues = [];
  const add = (level, msg, src) => issues.push({ level, msg, src: src || '?' });
  const error = (msg, src) => add('error', msg, src);
  const warn = (msg, src) => add('warn', msg, src);

  const srcOf = (coll, id) => data.sources?.[`${coll}:${id}`] || '?';

  /* ---------- 全局配置 ---------- */

  const cfg = data.config || {};

  if (!Array.isArray(cfg.countries) || cfg.countries.length === 0) {
    error('game.json 没有定义任何国家', 'base/game.json');
  }

  const tags = new Set((cfg.countries || []).map((c) => c.tag));

  if (!cfg.playerTag) error('game.json 缺少 playerTag', 'base/game.json');
  else if (!tags.has(cfg.playerTag)) error(`playerTag "${cfg.playerTag}" 不在国家列表里`, 'base/game.json');

  if (!cfg.startDate || !cfg.startDate.year) error('game.json 缺少 startDate', 'base/game.json');

  const seenTags = new Set();
  for (const c of cfg.countries || []) {
    if (!c.tag) { error('国家缺少 tag', 'base/game.json'); continue; }
    if (seenTags.has(c.tag)) error(`国家 tag 重复：${c.tag}`, 'base/game.json');
    seenTags.add(c.tag);
    if (!c.name) warn(`国家 ${c.tag} 缺少 name`, 'base/game.json');
    if (!c.color) warn(`国家 ${c.tag} 缺少 color`, 'base/game.json');
  }

  const tagExists = (t) => tags.has(t);

  /* ---------- 国策 ---------- */

  const occupied = new Map(); // "tag:x,y" -> focus id，用于检查视觉重叠

  for (const f of data.focuses) {
    const src = srcOf('focuses', f.id);

    if (!f.name) error(`国策 ${f.id} 缺少 name`, src);

    // 每个国策必须明确属于哪个国家，否则会被塞进所有人的树里
    if (!f.tag) error(`国策 ${f.id} 缺少 tag（必须指明属于哪个国家）`, src);
    else if (!tagExists(f.tag)) error(`国策 ${f.id} 的 tag "${f.tag}" 不是已定义的国家`, src);

    if (typeof f.cost !== 'number' || f.cost <= 0) {
      error(`国策 ${f.id} 的 cost 必须是正数（当前 ${JSON.stringify(f.cost)}）`, src);
    }
    if (f.pp_cost !== undefined && (typeof f.pp_cost !== 'number' || f.pp_cost < 0)) {
      error(`国策 ${f.id} 的 pp_cost 必须是非负数字`, src);
    }
    if (typeof f.x !== 'number' || typeof f.y !== 'number') {
      error(`国策 ${f.id} 缺少 x / y 网格坐标`, src);
    } else {
      // 只在该国自己那棵树内部检查重叠——不同国家各占一张树，坐标可以复用
      const key = `${f.tag || '?'}:${f.x},${f.y}`;
      if (occupied.has(key)) {
        warn(`国策 ${f.id} 与 ${occupied.get(key)} 在同一棵树里占用同一格 (${f.x},${f.y})，会视觉重叠`, src);
      } else {
        occupied.set(key, f.id);
      }
    }

    for (const p of f.prereqs || []) {
      if (!data.focusById[p]) error(`国策 ${f.id} 的前置 "${p}" 不存在`, src);
    }
    for (const p of f.prereqs_any || []) {
      if (!data.focusById[p]) error(`国策 ${f.id} 的 prereqs_any 项 "${p}" 不存在`, src);
    }
    for (const p of f.mutually_exclusive || []) {
      if (!data.focusById[p]) {
        error(`国策 ${f.id} 的互斥项 "${p}" 不存在`, src);
        continue;
      }
      // 互斥必须是双向的，否则玩家会觉得规则诡异
      const other = data.focusById[p];
      if (!(other.mutually_exclusive || []).includes(f.id)) {
        warn(`互斥关系不对称：${f.id} 排斥 ${p}，但 ${p} 没有排斥 ${f.id}`, src);
      }
    }

    if (f.available) checkTrigger(f.available, src, { error, warn }, data, data.focusById);
    checkEffects(f.effects, src, { error, warn }, data);

    if (f.ai_weight !== undefined && typeof f.ai_weight !== 'number') {
      warn(`国策 ${f.id} 的 ai_weight 不是数字`, src);
    }
  }

  /* ---------- 事件 ---------- */

  for (const ev of data.events) {
    const src = srcOf('events', ev.id);

    if (!ev.title) error(`事件 ${ev.id} 缺少 title`, src);
    if (!Array.isArray(ev.options) || ev.options.length === 0) {
      error(`事件 ${ev.id} 没有任何选项`, src);
    }

    if (ev.for && ev.for !== 'any' && !tagExists(ev.for)) {
      error(`事件 ${ev.id} 的 for 指向不存在的国家 "${ev.for}"`, src);
    }

    if (ev.trigger) checkTrigger(ev.trigger, src, { error, warn }, data, data.focusById);

    (ev.options || []).forEach((opt, i) => {
      if (!opt.text) warn(`事件 ${ev.id} 的选项 #${i} 缺少 text`, src);
      checkEffects(opt.effects, src, { error, warn }, data);
      if (opt.trigger) checkTrigger(opt.trigger, src, { error, warn }, data, data.focusById);
    });
  }

  /* ---------- 国家精神 ---------- */

  for (const idea of data.ideas || []) {
    const src = srcOf('ideas', idea.id);

    if (!idea.name) error(`国家精神 ${idea.id} 缺少 name`, src);

    if (!idea.modifiers || typeof idea.modifiers !== 'object' || !Object.keys(idea.modifiers).length) {
      warn(`国家精神 ${idea.id} 没有任何修正，加进去等于不生效`, src);
      continue;
    }

    for (const [key, value] of Object.entries(idea.modifiers)) {
      if (!MODIFIER_KEYS.includes(key)) {
        error(`国家精神 ${idea.id} 使用了未知修正 "${key}"`, src);
      }
      if (typeof value !== 'number' || Number.isNaN(value)) {
        error(`国家精神 ${idea.id} 的修正 "${key}" 必须是数字`, src);
      }
    }
  }

  /* ---------- 地图 ---------- */

  for (const p of data.provinces) {
    const src = srcOf('provinces', p.id);
    if (!p.name) warn(`省份 ${p.id} 缺少 name`, src);
    if (!tagExists(p.owner)) error(`省份 ${p.id} 的 owner "${p.owner}" 不是已定义的国家`, src);
    if (typeof p.x !== 'number' || typeof p.y !== 'number') error(`省份 ${p.id} 缺少坐标`, src);

    for (const n of p.neighbors || []) {
      if (!data.provinceById[n]) {
        error(`省份 ${p.id} 的邻接 "${n}" 不存在`, src);
        continue;
      }
      // 邻接必须双向，否则地图连线会缺一半
      if (!(data.provinceById[n].neighbors || []).includes(p.id)) {
        warn(`邻接不对称：${p.id} → ${n}，但 ${n} 没有指回 ${p.id}`, src);
      }
    }
  }

  /* ---------- 排序：错误在前 ---------- */

  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));

  return issues;
}

export function hasErrors(issues) {
  return issues.some((i) => i.level === 'error');
}

/* ============================================================
 * 递归检查
 * ============================================================ */

function checkTrigger(node, src, io, data) {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node !== 'object' || Array.isArray(node)) {
    io.error(`触发器必须是对象，收到 ${JSON.stringify(node)}`, src);
    return;
  }

  if (!TRIGGER_OPS.includes(node.op)) {
    io.error(`未知触发器 op "${node.op}"`, src);
    return;
  }

  switch (node.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(node.args) || node.args.length === 0) {
        io.warn(`${node.op} 没有任何子条件（恒为 ${node.op === 'and' ? 'true' : 'false'}）`, src);
        return;
      }
      node.args.forEach((a) => checkTrigger(a, src, io, data));
      break;

    case 'not':
      checkTrigger(node.arg, src, io, data);
      break;

    case 'cmp':
      if (!COMPARE_OPS.includes(node.cmp)) io.error(`未知比较符 "${node.cmp}"`, src);
      checkValue(node.lhs, src, io);
      checkValue(node.rhs, src, io);
      break;

    case 'has_focus':
      if (!node.id) io.error('has_focus 缺少 id', src);
      else if (!data.focusById[node.id]) io.error(`has_focus 引用了不存在的国策 "${node.id}"`, src);
      break;

    case 'at_war':
      if (node.tag && !data.countries.some((c) => c.tag === node.tag)) {
        io.error(`at_war 引用了不存在的国家 "${node.tag}"`, src);
      }
      break;

    case 'exists':
      if (!node.tag) io.error('exists 缺少 tag', src);
      break;

    case 'date_after':
    case 'date_before':
      if (!node.date || typeof node.date.year !== 'number') {
        io.error(`${node.op} 缺少合法的 date`, src);
      }
      break;
  }
}

function checkValue(node, src, io) {
  if (node == null) return;
  if (typeof node === 'number' || typeof node === 'boolean') return;
  if (typeof node !== 'object' || Array.isArray(node)) {
    io.error(`数值节点类型错误：${JSON.stringify(node)}`, src);
    return;
  }

  if (!VALUE_OPS.includes(node.op)) {
    io.error(`未知数值 op "${node.op}"`, src);
    return;
  }

  switch (node.op) {
    case 'var':
      if (typeof node.path !== 'string') io.error('var 缺少字符串 path', src);
      else if (!/^(country|global)\./.test(node.path)) {
        io.warn(`取值路径 "${node.path}" 应以 country. 或 global. 开头`, src);
      }
      break;

    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'min':
    case 'max':
      if (!Array.isArray(node.args)) io.error(`${node.op} 需要 args 数组`, src);
      else node.args.forEach((n) => checkValue(n, src, io));
      break;

    case 'floor':
      checkValue(node.arg, src, io);
      break;
  }
}

function checkEffects(list, src, io, data) {
  if (list == null) return;
  if (!Array.isArray(list)) {
    io.error('effects 必须是数组', src);
    return;
  }

  for (const eff of list) {
    if (!eff || typeof eff !== 'object') {
      io.error('效果不是对象', src);
      continue;
    }
    if (!EFFECT_OPS.includes(eff.op)) {
      io.error(`未知效果 op "${eff.op}"`, src);
      continue;
    }

    switch (eff.op) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'set':
        if (typeof eff.target !== 'string') io.error(`${eff.op} 需要 target`, src);
        else if (!/^(country|global)\./.test(eff.target)) {
          io.warn(`效果目标 "${eff.target}" 应以 country. 或 global. 开头`, src);
        }
        checkValue(eff.value, src, io);
        break;

      case 'flag':
      case 'country_flag':
        if (!eff.flag) io.error(`${eff.op} 需要 flag`, src);
        break;

      case 'declare_war':
      case 'make_peace':
        if (!eff.tag) io.error(`${eff.op} 需要 tag`, src);
        else if (!data.countries.some((c) => c.tag === eff.tag)) {
          io.error(`${eff.op} 引用了不存在的国家 "${eff.tag}"`, src);
        }
        break;

      case 'fire_event':
        if (!eff.id) io.error('fire_event 需要 id', src);
        else if (!data.eventById[eff.id]) io.error(`fire_event 引用了不存在的事件 "${eff.id}"`, src);
        break;

      case 'add_idea':
      case 'remove_idea':
        if (!eff.id) io.error(`${eff.op} 需要 id`, src);
        else if (!data.ideaById?.[eff.id]) {
          io.error(`${eff.op} 引用了不存在的国家精神 "${eff.id}"`, src);
        }
        break;
    }
  }
}
