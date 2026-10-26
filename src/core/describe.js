/**
 * describe.js —— 把数据里的 AST 翻译成人类可读的中文
 * UI 用它来显示效果说明，校验器用它来报错。
 */

export const STAT_LABELS = {
  'country.political_power': '政治点数',
  'country.stability': '稳定度',
  'country.war_support': '战争支持度',
  'country.factories': '工厂',
  'country.manpower': '人力',
};

export const DEFAULT_STATS = {
  political_power: 0,
  stability: 50,
  war_support: 20,
  factories: 5,
  manpower: 30,
  divisions: 4,
};

export function labelOf(path) {
  return STAT_LABELS[path] || path;
}

function n(v) {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/**
 * 单条效果的描述
 * @param {object} eff 效果节点
 * @param {object} [data] 可选。传入后可把国家精神 id 解析成中文名。
 * @returns {{ text: string, tone: 'pos'|'neg'|'neutral' }}
 */
export function describeEffect(eff, data = null) {
  if (!eff || typeof eff !== 'object') return { text: '（无效效果）', tone: 'neutral' };

  const ideaName = (id) => data?.ideaById?.[id]?.name || id;

  switch (eff.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'set': {
      const label = labelOf(eff.target);
      const raw = eff.op === 'set' ? null : literalOf(eff.value);
      if (eff.op === 'set') {
        return { text: `${label} 设为 ${literalOf(eff.value) ?? '…'}`, tone: 'neutral' };
      }
      if (raw === null) {
        return { text: `${label} ${eff.op === 'sub' ? '-' : '+'}（动态值）`, tone: 'neutral' };
      }
      if (eff.op === 'mul') {
        return { text: `${label} ×${n(raw)}`, tone: raw >= 1 ? 'pos' : 'neg' };
      }
      const d = eff.op === 'sub' ? -raw : raw;
      return { text: `${label} ${d >= 0 ? '+' : ''}${n(d)}`, tone: d > 0 ? 'pos' : d < 0 ? 'neg' : 'neutral' };
    }

    case 'flag':
      return { text: `全局标记「${eff.flag}」`, tone: 'neutral' };

    case 'country_flag':
      return { text: `国家标记「${eff.flag}」`, tone: 'neutral' };

    case 'add_idea':
      return { text: `获得国家精神「${ideaName(eff.id)}」`, tone: 'pos' };

    case 'remove_idea':
      return { text: `移除国家精神「${ideaName(eff.id)}」`, tone: 'neg' };

    case 'declare_war':
      return { text: `向 ${eff.tag} 宣战`, tone: 'neg' };

    case 'make_peace':
      return { text: `与 ${eff.tag} 停战`, tone: 'pos' };

    case 'fire_event':
      return { text: `触发事件「${eff.id}」`, tone: 'neutral' };

    case 'log':
      return { text: String(eff.text ?? ''), tone: 'neutral' };

    default:
      return { text: `未知效果 ${eff.op}`, tone: 'neutral' };
  }
}

/** 如果数值节点是常量，返回数字；否则返回 null */
function literalOf(node) {
  if (typeof node === 'number') return node;
  if (!node || typeof node !== 'object') return null;
  if (node.op === 'num') return Number(node.value ?? 0);
  if (node.op === 'bool') return node.value ? 1 : 0;
  return null;
}

/** 触发器的可读描述（用于详情面板） */
export function describeTrigger(t) {
  if (!t || typeof t !== 'object') return '无条件';
  switch (t.op) {
    case 'always':
      return '无条件';
    case 'and':
      return (t.args || []).map(describeTrigger).join(' 且 ');
    case 'or':
      return (t.args || []).map(describeTrigger).join(' 或 ');
    case 'not':
      return `非（${describeTrigger(t.arg)}）`;
    case 'cmp': {
      const map = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=', neq: '≠' };
      return `${describeValue(t.lhs)} ${map[t.cmp] || t.cmp} ${describeValue(t.rhs)}`;
    }
    case 'has_focus':
      return `已完成国策 ${t.id}`;
    case 'has_flag':
      return `全局标记 ${t.flag}`;
    case 'country_flag':
      return `国家标记 ${t.flag}`;
    case 'at_war':
      return t.tag ? `与 ${t.tag} 交战中` : '处于战争状态';
    case 'exists':
      return `存在国家 ${t.tag}`;
    case 'date_after':
      return `${dateStr(t.date)} 之后`;
    case 'date_before':
      return `${dateStr(t.date)} 之前`;
    default:
      return `未知条件 ${t.op}`;
  }
}

function describeValue(v) {
  if (typeof v === 'number') return String(v);
  if (!v || typeof v !== 'object') return String(v);
  if (v.op === 'num') return String(v.value ?? 0);
  if (v.op === 'var') return labelOf(v.path);
  return '（计算值）';
}

export function dateStr(d) {
  if (!d) return '???';
  return `${d.year}.${String(d.month).padStart(2, '0')}.${String(d.day).padStart(2, '0')}`;
}

export function monthName(m) {
  return ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'][m - 1] || `${m}月`;
}
