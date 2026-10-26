/**
 * modifiers.js —— 国家修正（来自国家精神 / National Spirits）
 *
 * 这是让国策树产生"真实取舍"的关键：
 * 如果一个国策只是"工厂 +3"，那它只有机会成本（时间）。
 * 只有当它给你一个**长期的、可能是负面的**国家修正时，
 * 玩家才真正在做战略选择而不是在收菜。
 *
 * 修正器是纯加法聚合的：
 *   总修正 = Σ(每个国家精神的同名字段)
 * 正负自然抵消，不做乘法叠加，便于玩家心算。
 */

/**
 * 允许的修正器键。
 * unit 决定 UI 怎么显示，也决定它在哪一层生效。
 */
export const MODIFIERS = {
  factory_output: { label: '工厂产出', unit: 'pct', desc: '每月新增工厂的产出修正' },
  political_power_gain: { label: '政治点数', unit: 'per_day', desc: '每日政治点数增减' },
  stability_drift: { label: '稳定度趋势', unit: 'per_month', desc: '每月稳定度增减' },
  war_support_drift: { label: '战争支持趋势', unit: 'per_month', desc: '每月战争支持度增减' },
  manpower_gain: { label: '人力增长', unit: 'pct', desc: '每月人力增长修正' },
  focus_speed: { label: '国策速度', unit: 'pct', desc: '国策推进速度修正' },
  army_strength: { label: '陆军战力', unit: 'pct', desc: '师的作战效能修正' },
};

export const MODIFIER_KEYS = Object.keys(MODIFIERS);

export function emptyModifiers() {
  const m = {};
  for (const k of MODIFIER_KEYS) m[k] = 0;
  return m;
}

/**
 * 把一个国家所有国家精神的修正加总。
 * @returns {Record<string, number>}
 */
export function aggregateModifiers(data, country) {
  const total = emptyModifiers();

  for (const id of country.ideas || []) {
    const idea = data.ideaById?.[id];
    if (!idea || !idea.modifiers) continue;
    for (const [key, value] of Object.entries(idea.modifiers)) {
      if (total[key] === undefined) total[key] = 0;
      total[key] += Number(value) || 0;
    }
  }

  return total;
}

/**
 * 用于 UI：只返回非零项，按绝对值从大到小排。
 */
export function modifierEntries(mods) {
  const out = [];
  for (const key of MODIFIER_KEYS) {
    const value = mods[key] || 0;
    if (Math.abs(value) < 1e-9) continue;
    out.push({ key, value, ...MODIFIERS[key] });
  }
  return out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/** 把单个修正格式化成 "+18%" / "-0.25/天" 这种 */
export function formatModifier(key, value) {
  const meta = MODIFIERS[key];
  const sign = value >= 0 ? '+' : '';

  if (!meta) return `${sign}${round(value)}`;

  switch (meta.unit) {
    case 'pct':
      return `${sign}${Math.round(value * 100)}%`;
    case 'per_day':
      return `${sign}${round(value)}/天`;
    case 'per_month':
      return `${sign}${round(value)}/月`;
    default:
      return `${sign}${round(value)}`;
  }
}

function round(n) {
  const r = Math.round(n * 100) / 100;
  return String(Number(r.toFixed(2)));
}
