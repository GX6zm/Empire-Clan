/**
 * load.js —— 数据加载、mod 合并、patch 应用
 *
 * 数据流：
 *   data/base/*.json           基础游戏内容
 *        ↓
 *   data/mods/<id>/mod.json    模组清单（loadOrder / files / gameVersion）
 *        ↓
 *   data/mods/<id>/*.json      覆盖（同 id 替换）或 patch 操作
 *        ↓
 *   合并后的内存数据 + 每个定义的来源追踪（用于校验报错定位）
 *
 * 两种 mod 能力：
 *   1. 覆盖（override）—— 数据文件里同 id 的定义直接替换基础版本。
 *      适合"我想换掉整个国策"。
 *   2. 补丁（patch）—— 声明 action: modify / add / remove。
 *      适合"我只想改一个数字"，且不会因为基础版本重写而失效。
 */

const BASE_FILES = ['game', 'map', 'focuses', 'events', 'ideas'];

const COLLECTION_BY_TYPE = {
  focuses: 'focuses',
  events: 'events',
  map: 'provinces',
  ideas: 'ideas',
};

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl='data/']
 * @param {string[]} [opts.enabledMods]
 * @param {(url:string)=>Promise<any>} [opts.fetchJson] 可注入（测试用）
 */
export async function loadGameData({
  baseUrl = 'data/',
  enabledMods = [],
  fetchJson = defaultFetchJson,
} = {}) {
  const collections = {
    focuses: new Map(),
    events: new Map(),
    provinces: new Map(),
    ideas: new Map(),
  };
  const sources = {};
  const logs = [];
  const errors = [];
  let config = {};
  /** 地图的非省份数据：viewBox 与陆地轮廓。地图文件顶层多出来的字段落在这里 */
  let mapMeta = null;

  const setMapMeta = (m) => {
    mapMeta = { ...(mapMeta || {}), ...m };
  };

  const put = (coll, def, origin) => {
    if (!def || typeof def !== 'object') {
      errors.push({ msg: `${origin} 中有无效定义（不是对象）`, src: origin });
      return;
    }
    if (!def.id) {
      errors.push({ msg: `${origin} 中有定义缺少 id`, src: origin });
      return;
    }
    if (collections[coll].has(def.id)) {
      logs.push(`覆盖 ${coll}/${def.id}  ← ${origin}`);
    }
    collections[coll].set(def.id, def);
    sources[`${coll}:${def.id}`] = origin;
  };

  /* ---------- 1. mod 列表与清单 ---------- */
  //
  // 必须先读清单再决定要不要加载 data/base：
  // "完全替换型"模组（replacesBase: true）意味着它带着自己的地图、国家、国策，
  // 基础和它混在一起只会互相打架。

  const modIndex = await readModIndex(baseUrl, fetchJson, logs, errors);
  const ordered = orderMods(modIndex, enabledMods);
  const loadedMods = [];

  for (const meta of ordered) {
    if (!enabledMods.includes(meta.id)) continue;

    const dir = `mods/${meta.id}/`;
    try {
      const manifest = await fetchJson(`${baseUrl}${dir}mod.json`);
      loadedMods.push({ ...manifest, id: manifest.id || meta.id, enabled: true, dir });
    } catch (err) {
      errors.push({ msg: `无法加载模组 ${meta.id} 的 mod.json：${err.message}`, src: `${dir}mod.json` });
    }
  }

  const replacesBase = loadedMods.some((m) => m.replacesBase === true);

  /* ---------- 2. 基础数据 ---------- */

  if (replacesBase) {
    const who = loadedMods.filter((m) => m.replacesBase).map((m) => m.name || m.id).join('、');
    logs.push(`检测到完全替换型模组（${who}），已跳过 data/base`);
  } else {
    for (const name of BASE_FILES) {
      const url = `${baseUrl}base/${name}.json`;
      let file;
      try {
        file = await fetchJson(url);
      } catch (err) {
        errors.push({ msg: `无法加载基础数据 ${url}：${err.message}`, src: url });
        continue;
      }
      applyFile(file, `base/${name}.json`, {
        put, collections, sources, logs, errors, setMapMeta,
        setConfig: (c) => { config = { ...config, ...c }; },
      });
    }
  }

  /* ---------- 3. 按顺序应用 mod 文件 ---------- */

  // 完全替换型模组独占加载：它定义了整套游戏，再叠别的 mod 只会互相拆台
  const totalMod = loadedMods.find((m) => m.replacesBase === true);
  const activeMods = totalMod ? [totalMod] : loadedMods;

  if (totalMod && loadedMods.length > 1) {
    const skipped = loadedMods.filter((m) => m !== totalMod).map((m) => m.name || m.id);
    logs.push(`⚑ 完全替换型模组独占加载，已忽略：${skipped.join('、')}`);
  }

  for (const manifest of activeMods) {
    // 版本检查（软失败：只警告）
    if (manifest.gameVersion && config.version) {
      if (!satisfies(config.version, manifest.gameVersion)) {
        logs.push(`⚠ 模组「${manifest.name || manifest.id}」要求游戏版本 ${manifest.gameVersion}，当前 ${config.version}`);
      }
    }

    for (const file of manifest.files || []) {
      const url = `${baseUrl}${manifest.dir}${file}`;
      let data;
      try {
        data = await fetchJson(url);
      } catch (err) {
        errors.push({ msg: `模组 ${manifest.id} 的文件 ${file} 加载失败：${err.message}`, src: url });
        continue;
      }
      applyFile(data, `${manifest.id}/${file}`, {
        put,
        collections,
        sources,
        logs,
        errors,
        setMapMeta,
        setMapMeta,
        setConfig: (c) => { config = { ...config, ...c }; },
      });
    }
  }

  /* ---------- 4. 汇总 ---------- */

  const focuses = [...collections.focuses.values()].sort(
    (a, b) => (a.tag || '').localeCompare(b.tag || '') || (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0)
  );
  const events = [...collections.events.values()];
  const provinces = [...collections.provinces.values()];
  const ideas = [...collections.ideas.values()];

  // 每个国家一棵独立的国策树
  const focusesByTag = {};
  for (const f of focuses) {
    const tag = f.tag || '';
    (focusesByTag[tag] = focusesByTag[tag] || []).push(f);
  }

  return {
    baseUrl,
    config,
    countries: config.countries || [],
    focuses,
    focusesByTag,
    focusById: indexBy(focuses),
    events,
    eventById: indexBy(events),
    provinces,
    provinceById: indexBy(provinces),
    mapMeta,
    mapMeta,
    ideas,
    ideaById: indexBy(ideas),
    sources,
    logs,
    errors,
    modIndex,
    loadedMods,
  };
}

/* ============================================================
 * 单个数据文件的分发
 * ============================================================ */

function applyFile(file, origin, io) {
  if (!file || typeof file !== 'object') {
    io.errors.push({ msg: `${origin} 内容不是对象`, src: origin });
    return;
  }

  const type = file.type;

  if (type === 'game') {
    io.setConfig(file.config || {});
    io.logs.push(`载入游戏配置 ← ${origin}`);
    return;
  }

  if (type === 'patch') {
    applyPatch(file.ops || [], origin, io);
    return;
  }

  const coll = COLLECTION_BY_TYPE[type];
  if (!coll) {
    io.errors.push({ msg: `${origin} 的 type "${type}" 无法识别`, src: origin });
    return;
  }

  // 地图文件顶层除了 defs，还可能带 viewBox / land —— 那是画图要用的，不是省份
  if (file.viewBox || file.land) {
    io.setMapMeta?.({ viewBox: file.viewBox, land: file.land });
  }

  const defs = file.defs || [];
  for (const def of defs) io.put(coll, def, origin);
  io.logs.push(`载入 ${coll} ×${defs.length} ← ${origin}`);
}

/* ============================================================
 * patch
 * ============================================================ */

function applyPatch(ops, origin, io) {
  for (const op of ops) {
    const coll = COLLECTION_BY_TYPE[op.collection] || op.collection;

    if (!io.collections[coll]) {
      io.errors.push({ msg: `${origin}：patch 指向未知集合 "${op.collection}"`, src: origin });
      continue;
    }

    if (op.action === 'modify') {
      const cur = io.collections[coll].get(op.id);
      if (!cur) {
        io.errors.push({ msg: `${origin}：patch modify 目标不存在 ${coll}/${op.id}`, src: origin });
        continue;
      }
      if (op.set) Object.assign(cur, structuredClone(op.set));
      if (op.unset) for (const k of op.unset) delete cur[k];
      io.sources[`${coll}:${op.id}`] = origin;
      io.logs.push(`patch 修改 ${coll}/${op.id} ← ${origin}`);

    } else if (op.action === 'add') {
      io.put(coll, structuredClone(op.value), origin);

    } else if (op.action === 'remove') {
      if (!io.collections[coll].has(op.id)) {
        io.errors.push({ msg: `${origin}：patch remove 目标不存在 ${coll}/${op.id}`, src: origin });
        continue;
      }
      io.collections[coll].delete(op.id);
      delete io.sources[`${coll}:${op.id}`];
      io.logs.push(`patch 删除 ${coll}/${op.id} ← ${origin}`);

    } else {
      io.errors.push({ msg: `${origin}：未知 patch action "${op.action}"`, src: origin });
    }
  }
}

/* ============================================================
 * mod 索引与加载顺序
 * ============================================================ */

async function readModIndex(baseUrl, fetchJson, logs, errors) {
  const url = `${baseUrl}mods/index.json`;
  try {
    const idx = await fetchJson(url);
    const mods = (idx.mods || []).map((m) => (typeof m === 'string' ? { id: m } : m));
    logs.push(`发现 ${mods.length} 个可选模组`);
    return mods;
  } catch (err) {
    errors.push({ msg: `无法加载模组索引 ${url}：${err.message}`, src: url });
    return [];
  }
}

/**
 * 按 loadAfter / loadBefore 做一次稳定的拓扑排序。
 */
export function orderMods(modIndex, enabledMods) {
  const list = modIndex.filter((m) => enabledMods.includes(m.id));
  const byId = new Map(list.map((m) => [m.id, m]));
  const out = [];
  const visiting = new Set();
  const done = new Set();

  const visit = (m, chain = []) => {
    if (!m || done.has(m.id)) return;
    if (visiting.has(m.id)) {
      // 循环依赖：按链尾处理，不让加载崩掉
      return;
    }
    visiting.add(m.id);
    for (const dep of m.loadAfter || []) {
      if (byId.has(dep)) visit(byId.get(dep), [...chain, m.id]);
    }
    visiting.delete(m.id);
    done.add(m.id);
    out.push(m);
  };

  for (const m of list) visit(m);
  return out;
}

/* ============================================================
 * 工具
 * ============================================================ */

function indexBy(arr) {
  const map = {};
  for (const item of arr) map[item.id] = item;
  return map;
}

export async function defaultFetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 极简 semver 范围判断，只支持 ">=", ">", "<=", "<", "=", "^", "~" 前缀 */
export function satisfies(version, range) {
  if (!range) return true;
  const parts = String(range).trim().split(/\s+/);
  return parts.every((part) => {
    const m = part.match(/^(>=|<=|>|<|=|\^|~)?\s*(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return true;
    const [, op = '=', ma, mi, pa] = m;
    const cmp = compareSemver(version, [Number(ma), Number(mi), Number(pa)]);
    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '=': return cmp === 0;
      case '^': return cmp >= 0 && Number(ma) === Number(String(version).split('.')[0]);
      case '~': return cmp >= 0 && Number(mi) === Number(String(version).split('.')[1]);
      default: return true;
    }
  });
}

export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = Array.isArray(b) ? b : String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return Math.sign(x - y);
  }
  return 0;
}
