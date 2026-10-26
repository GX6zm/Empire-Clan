/**
 * app.js —— 把核心层和 UI 层接起来
 *
 * 这是唯一同时了解"游戏规则"和"DOM"的地方。
 * 如果将来换 React / Svelte，只需要重写这一层。
 */

import { loadGameData } from '../core/load.js';
import { validateData, hasErrors } from '../core/validate.js';
import { createState, advanceDay } from '../core/state.js';
import { applyPlayerChoice, startFocus as startFocusSafe } from '../core/rules.js';
import { declareWar, makePeace } from '../core/war.js';
import {
  findWar,
  warScore,
  applyPeace,
  dropOffer,
} from '../core/peace.js';
import {
  serialize,
  migrate,
  reconcileWithData,
  saveToLocal,
  loadFromLocal,
} from '../core/save.js';
import { dateStr } from '../core/describe.js';

import { buildMap, refreshMap } from './map.js';
import { buildTree, refreshTree, nodeCenter } from './tree.js';
import { createCanvas } from './canvas.js';
import { buildNav } from './nav.js';
import {
  buildHud,
  refreshHud,
  renderSituation,
  renderDossier,
  pushLog,
  clearLog,
} from './hud.js';
import {
  showEventModal,
  showModManager,
  showMapModal,
  showPeaceDialog,
  showPeaceOfferModal,
  renderFocusDetail,
  syncFocusDetailLive,
  toast,
} from './dialogs.js';
import { el } from './dom.js';

const MODS_KEY = 'focus-engine.mods';

export class App {
  constructor(dom) {
    this.d = dom;
    this.data = null;
    this.state = null;
    this.refs = {};
    this.mods = [];

    this.selectedFocusId = null;
    this.modalOpen = false;
    this.speedBeforeEvent = 0;

    /** 当前视图：focus | dossier；section 记录是哪一页档案 */
    this.view = 'focus';
    this.section = 'focus';

    this.running = false;
    this.acc = 0;
    this.last = 0;

    this._lastCardAt = 0;
    this._lastDossierAt = 0;
    this._lastProvince = null;
    this._detailSig = '';
    this._cardSig = '';
    this._dossierSig = '';

    this.bindKeys();
    this.bindActions();
  }

  /* ==========================================================
   * 启动
   * ========================================================== */

  async boot() {
    try {
      const mods = await this.resolveInitialMods();
      const ok = await this.load(mods);

      if (!ok) {
        this.showIssuesView({ fatal: true });
        return;
      }

      this.d.boot.hidden = true;
      this.d.app.hidden = false;

      this.buildAll();
      this.newGame();
      this.startLoop();

      const warns = this.issues.filter((i) => i.level === 'warn');
      if (warns.length) {
        pushLog(this.d.log, [`⚠ 数据校验有 ${warns.length} 条警告，点击「模组」→ 重新加载可查看`], this.state.date, 'red');
      }
    } catch (err) {
      this.fatal(err);
    }
  }

  async resolveInitialMods() {
    // 支持用 URL 直接指定模组，方便分享 / 一键试玩：
    //   ?mods=celestial-revival        只启用这一个
    //   ?mods=imperial-twilight,hard-mode
    //   ?mods=                         不带任何模组
    const fromUrl = new URLSearchParams(location.search).get('mods');
    if (fromUrl !== null) {
      const list = fromUrl.split(',').map((s) => s.trim()).filter(Boolean);
      writeStored(MODS_KEY, list);
      return list;
    }

    let idx = { mods: [] };
    try {
      const res = await fetch('data/mods/index.json', { cache: 'no-store' });
      if (res.ok) idx = await res.json();
    } catch {
      /* 没有 mod 索引也能继续 */
    }

    const stored = readStored(MODS_KEY);
    if (stored) return stored;

    return (idx.mods || [])
      .filter((m) => (typeof m === 'string' ? false : m.default))
      .map((m) => (typeof m === 'string' ? m : m.id));
  }

  async load(mods) {
    this.d.bootMsg.textContent = '正在加载游戏数据…';
    this.d.bootDetail.textContent = '';

    this.data = await loadGameData({ baseUrl: 'data/', enabledMods: mods });
    this.mods = mods;
    writeStored(MODS_KEY, mods);

    this.issues = validateData(this.data);

    const fatal = this.data.errors.length > 0 || hasErrors(this.issues);
    return !fatal;
  }

  /* ==========================================================
   * 构建 UI
   * ========================================================== */

  buildAll() {
    this.refs.hud = buildHud({
      hudEl: this.d.hud,
      toolbarEl: this.d.toolbar,
      handlers: {
        onSpeed: (i) => {
          this.state.speed = i;
          this.acc = 0;
        },
        onSave: () => this.onSave(),
        onLoad: () => this.onLoad(),
        onExport: () => this.onExport(),
        onImport: () => this.onImport(),
      },
    });

    this.refs.nav = buildNav(this.d.nav, {
      version: this.data.config.version || '?',
      onSelect: (item) => this.onNav(item),
    });

    this.refs.map = buildMap(this.d.map, this.data, (provinceId) => {
      this.state.selectedProvince =
        this.state.selectedProvince === provinceId ? null : provinceId;
      this._lastProvince = null;
    }, { mode: 'compact' });

    this.refs.tree = buildTree(this.d.tree, this.data, {
      tag: this.data.config.playerTag,
      onSelect: (id) => this.selectFocus(id),
    });

    this.refs.canvas = createCanvas({
      viewport: this.d.viewport,
      tree: this.d.tree,
      zoomLabel: this.d.zoomLabel,
      toolsEl: this.d.canvasTools,
    });

    if (!this._resizeBound) {
      this._resizeBound = true;
      let t = 0;
      window.addEventListener('resize', () => {
        window.clearTimeout(t);
        t = window.setTimeout(() => this.refs.canvas?.apply(false), 120);
      });
    }
  }

  /* ==========================================================
   * 视图切换
   * ========================================================== */

  onNav(item) {
    if (item.id === 'mods') {
      this.onMods();
      return;
    }
    this.setView(item.view, item.id);
  }

  setView(view, section) {
    this.view = view;
    this.section = section || view;

    this.refs.nav?.setActive(this.section);

    if (this.d.viewFocus) this.d.viewFocus.hidden = view !== 'focus';
    if (this.d.viewDossier) this.d.viewDossier.hidden = view !== 'dossier';

    if (view === 'focus') {
      // 从隐藏状态切回来时，画布尺寸可能变了，重算一次平移
      requestAnimationFrame(() => {
        this.refs.canvas?.apply(false);
        if (this.state && this.selectedFocusId) this.refreshDetail(true);
      });
    } else {
      // 详情面板是"国策的档案"，离开国策页就该收起来，别占着 340px
      this.d.detail.hidden = true;
      if (this.state) this.renderDossierNow();
    }
  }

  renderDossierNow() {
    if (!this.state) return;
    const scroll = this.d.dossier.scrollTop;
    renderDossier(this.d.dossier, this.state, this.data, this.section);
    this.d.dossier.scrollTop = scroll;
    this._dossierSig = this.dossierSignature();
  }

  newGame() {
    this.stopLoop();

    this.state = createState(this.data, { mods: this.mods });
    this.selectedFocusId = null;
    this.d.detail.hidden = true;
    clearLog(this.d.log);

    const c = this.state.countries[this.state.playerTag];
    pushLog(this.d.log, [
      `=== ${c.name} · ${dateStr(this.state.date)} ===`,
      `游戏版本 ${this.data.config.version || '?'}｜已启用模组：${this.mods.length ? this.mods.join('、') : '无'}`,
      `已加载 ${this.data.focuses.length} 个国策 / ${this.data.events.length} 个事件 / ${this.data.provinces.length} 个区域`,
      '滚轮缩放画布，按住空白处拖动；点击国策节点查看详情',
    ], this.state.date);

    this.setView('focus', 'focus');
    this.refreshDetail(true);
    this.scrollToRoot();
    this.startLoop();
  }

  scrollToRoot() {
    const tag = this.state.playerTag;
    // 不要靠 id 前缀猜归属——换了 mod 之后国策 id 未必带国家前缀
    const root =
      this.data.focuses.find((f) => f.tag === tag && (f.y ?? 0) === 0) ||
      this.data.focuses.find((f) => f.tag === tag && !(f.prereqs || []).length);
    if (!root) return;

    // 等一帧再居中：树刚插进 DOM 时尺寸还没算出来
    requestAnimationFrame(() => {
      const c = nodeCenter(this.refs.tree, root.id);
      // 往下偏一点，让根节点在视口偏上，下面的树枝才有地方展开
      if (c) this.refs.canvas.centerOn(c.x, c.y + 80, { animate: false });
    });
  }

  /* ==========================================================
   * 主循环
   * ========================================================== */

  startLoop() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();

    const frame = (now) => {
      if (!this.running) return;
      const dt = Math.min(400, now - this.last);
      this.last = now;
      this.step(dt, now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stopLoop() {
    this.running = false;
  }

  step(dt, now) {
    if (!this.state) return;

    if (this.state.speed > 0 && !this.modalOpen) {
      const per = this.data.config.speeds[this.state.speed] || 100;
      this.acc += dt;

      let guard = 0;
      while (this.acc >= per && guard < 16 && this.state.speed > 0 && !this.modalOpen) {
        this.tick();
        this.acc -= per;
        guard += 1;
      }
      if (this.acc > per * 4) this.acc = 0;
    } else {
      this.acc = 0;
    }

    this.render(now);
  }

  tick() {
    const lines = advanceDay(this.state, this.data);
    if (lines.length) pushLog(this.d.log, lines, this.state.date);
    this.maybeShowEvent();
    this.maybeShowPeaceOffer();
  }

  render(now) {
    if (!this.state) return;

    refreshHud(this.refs.hud, this.state, this.data);
    refreshTree(this.refs.tree, this.state, this.data, this.selectedFocusId);

    // 战争会改变省份归属，所以地图每帧都刷（地块数量不多，代价可以接受）
    refreshMap(this.refs.map, this.state, this.data);

    if (now - this._lastCardAt > 180 || this._lastProvince !== this.state.selectedProvince) {
      this._lastCardAt = now;

      const sig = this.situationSignature();
      if (sig !== this._cardSig || this._lastProvince !== this.state.selectedProvince) {
        this._cardSig = sig;
        this._lastProvince = this.state.selectedProvince;
        renderSituation(this.d.situationBody, this.state, this.data);
        this.refreshDetail();
      }
    }

    // 档案页不用逐帧重建（会打断滚动与悬停），只在数字真的变了的时候刷
    if (this.view === 'dossier' && now - this._lastDossierAt > 700) {
      this._lastDossierAt = now;
      if (this.dossierSignature() !== this._dossierSig) this.renderDossierNow();
    }
  }

  /** 用来避免"什么都没变也重建一遍" */
  situationSignature() {
    const s = this.state;
    const prov = s.selectedProvince ? this.data.provinceById[s.selectedProvince] : null;
    const tag = prov ? (s.provinces?.[prov.id]?.owner ?? prov.owner) : s.playerTag;
    const c = s.countries[tag];
    if (!c) return '';

    const owned = Object.values(s.provinces).filter((p) => p.owner === tag).length;

    // 战争分数会随战线每天变化，不放进签名里卡片就会停在旧数字上
    const scoreSig = c.atWarWith
      .map((t) => {
        const w = findWar(s, tag, t);
        return w ? warScore(s, this.data, w, tag) : '-';
      })
      .join(',');

    return [
      tag,
      Math.floor(c.political_power),
      Math.round(c.stability),
      Math.round(c.war_support),
      c.factories.toFixed(1),
      c.manpower.toFixed(0),
      (c.divisions || 0).toFixed(1),
      c.focuses.completed.length,
      c.focuses.current || '-',
      Math.floor(c.focuses.progress),
      c.atWarWith.join('+'),
      scoreSig,
      c.defeated ? 'D' : '',
      c.ideas.join('+'),
      owned,
    ].join('|');
  }

  /** 档案页的签名：只有这几个数变了才值得重建 */
  dossierSignature() {
    const s = this.state;
    const c = s.countries[s.playerTag];
    if (!c) return '';
    return [
      this.section,
      Math.floor(c.political_power),
      Math.round(c.stability),
      Math.round(c.war_support),
      c.factories.toFixed(1),
      (c.divisions || 0).toFixed(1),
      c.ideas.join('+'),
      c.atWarWith.join('+'),
      c.focuses.current || '-',
      Math.floor(c.focuses.progress),
      c.manpower.toFixed(0),
      Object.keys(s.truces || {}).length,
    ].join('|');
  }

  /**
   * 事件委托：态势面板每 180ms 重建一次，按钮节点会被替换。
   * 如果 mousedown 与 mouseup 落在两次重建之间，绑定在按钮上的 onclick 根本不会触发。
   * 把监听挂在不会被替换的容器上，才能保证"宣战"这类按钮一点就灵。
   * 档案页会随数字变化重建，同理。
   */
  bindActions() {
    const handler = (e) => {
      const btn = e.target.closest?.('[data-act]');
      if (!btn || !this.state) return;

      const act = btn.dataset.act;
      const tag = btn.dataset.tag;

      if (act === 'clear-province') {
        this.state.selectedProvince = null;
        this._lastProvince = null;
        return;
      }

      if (!tag) return;

      let line = null;

      if (act === 'war') {
        const r = declareWar(this.state, this.data, this.state.playerTag, tag);
        if (!r.ok) toast(this.d.modalRoot, r.reason, 2400);
        else line = r.line;
      } else if (act === 'negotiate') {
        this.openPeaceTalks(tag);
        return;
      } else if (act === 'peace') {
        const r = makePeace(this.state, this.state.playerTag, tag);
        if (r.ok) line = r.line;
      }

      if (line) pushLog(this.d.log, [line], this.state.date, 'gold');
      this._cardSig = '';
      this._lastCardAt = 0;
      this._dossierSig = '';
    };

    this.d.situation?.addEventListener('click', handler);
    this.d.dossier?.addEventListener('click', handler);

    this.d.sitToggle?.addEventListener('click', () => {
      const collapsed = this.d.situation.classList.toggle('is-collapsed');
      this.d.sitToggle.textContent = collapsed ? '展' : '收';
      this.d.sitToggle.setAttribute('aria-expanded', String(!collapsed));
    });

    this.d.sitExpand?.addEventListener('click', () => this.openMap());
  }

  /** 大地图：给地图一个能看清的尺寸，小浮层只用来扫一眼 */
  openMap() {
    if (!this.state) return;

    this.modalOpen = true;
    const paused = this.state.speed;
    if (paused !== 0) {
      this.speedBeforeEvent = paused;
      this.state.speed = 0;
    }

    try {
      showMapModal(this.d.modalRoot, {
        state: this.state,
        data: this.data,
        onSelect: (provinceId) => {
          this.state.selectedProvince = provinceId;
          this._lastProvince = null;
        },
        onClose: () => {
          this.modalOpen = false;
          if (this.speedBeforeEvent) {
            this.state.speed = this.speedBeforeEvent;
            this.speedBeforeEvent = 0;
          }
          this._cardSig = '';
          this._lastCardAt = 0;
          this.maybeShowEvent();
        },
      });
    } catch (err) {
      // 大地图是"可选视图"，不能因为它挂了就让人以为按钮坏了
      this.modalOpen = false;
      toast(this.d.modalRoot, `地图打不开：${err.message}`, 4000);
      pushLog(this.d.log, [`✗ 打开战略地图失败：${err.message}`], this.state.date, 'red');
    }
  }

  /* ==========================================================
   * 和谈
   * ========================================================== */

  openPeaceTalks(otherTag) {
    if (!findWar(this.state, this.state.playerTag, otherTag)) return;

    // 谈判期间停表，否则条款还没勾完，战争分数已经变了
    this.modalOpen = true;

    showPeaceDialog(this.d.modalRoot, {
      state: this.state,
      data: this.data,
      otherTag,
      onApplied: (res) => {
        if (res?.lines?.length) {
          pushLog(this.d.log, res.lines, this.state.date, res.ok ? 'gold' : 'red');
        }
      },
      onClose: () => {
        this.modalOpen = false;
        this._cardSig = '';
        this._lastCardAt = 0;
        this.maybeShowEvent();
      },
    });
  }

  /** AI 撑不住时会主动递话。玩家可以选择收下，也可以继续打。 */
  maybeShowPeaceOffer() {
    if (this.modalOpen || !this.state) return;

    const offer = (this.state.peaceOffers || [])[0];
    if (!offer) return;

    const war = findWar(this.state, offer.a, offer.b);
    if (!war) {
      dropOffer(this.state, offer.a, offer.b);
      return;
    }

    const from = this.state.countries[offer.from];
    if (!from) {
      dropOffer(this.state, offer.a, offer.b);
      return;
    }

    this.modalOpen = true;
    if (this.state.speed !== 0) {
      this.speedBeforeEvent = this.state.speed;
      this.state.speed = 0;
    }

    showPeaceOfferModal(this.d.modalRoot, {
      state: this.state,
      data: this.data,
      offer,
      onChoose: (accept) => {
        this.modalOpen = false;
        dropOffer(this.state, offer.a, offer.b);

        if (accept) {
          const res = applyPeace(this.state, this.data, war, offer.terms);
          if (res.ok) pushLog(this.d.log, res.lines, this.state.date, 'gold');
        } else {
          // 拒绝也会让对方更厌战——但你要多流一次血
          war.rejected = (war.rejected || 0) + 1;
          pushLog(this.d.log, [
            `【和谈】拒绝了 ${from.name} 的停战提议`,
            '  · 对方更厌战了，下次开出的条件会更低',
          ], this.state.date, 'red');
        }

        if (this.speedBeforeEvent) {
          this.state.speed = this.speedBeforeEvent;
          this.speedBeforeEvent = 0;
        }

        this._cardSig = '';
        this._lastCardAt = 0;
        this.maybeShowEvent();
        this.maybeShowPeaceOffer();
      },
    });
  }

  /* ==========================================================
   * 国策详情
   * ========================================================== */

  selectFocus(id) {
    this.selectedFocusId = id;
    this.refreshDetail(true);
  }

  refreshDetail(force = false) {
    if (!this.selectedFocusId) {
      this.d.detail.hidden = true;
      return;
    }

    const c = this.state.countries[this.state.playerTag];
    const sig = `${this.selectedFocusId}|${c.focuses.current}|${Math.floor(c.focuses.progress)}|${c.focuses.completed.length}`;
    if (!force && sig === this._detailSig) {
      // 政治点数每天在涨：只同步按钮可用性，不重建面板
      syncFocusDetailLive(this.d.detail, { state: this.state, data: this.data });
      return;
    }
    this._detailSig = sig;

    renderFocusDetail(this.d.detail, {
      data: this.data,
      state: this.state,
      focusId: this.selectedFocusId,
      onClose: () => {
        this.selectedFocusId = null;
        this.d.detail.hidden = true;
      },
      onStart: (fid) => this.startFocus(fid),
    });
  }

  startFocus(focusId) {
    const c = this.state.countries[this.state.playerTag];
    const focus = this.data.focusById[focusId];
    const res = startFocusSafe(this.state, this.data, c, focus);

    if (!res.ok) {
      toast(this.d.modalRoot, res.reason, 2200);
      return;
    }

    pushLog(this.d.log, [`开始国策「${focus.name}」（${focus.cost} 天）`], this.state.date, 'gold');
    this._detailSig = '';
    this.refreshDetail(true);
  }

  /* ==========================================================
   * 事件
   * ========================================================== */

  maybeShowEvent() {
    if (this.modalOpen) return;

    const pending = this.state.pendingEvents.find((p) => p.tag === this.state.playerTag);
    if (!pending) {
      if (this.speedBeforeEvent) {
        this.state.speed = this.speedBeforeEvent;
        this.speedBeforeEvent = 0;
      }
      return;
    }

    const ev = this.data.eventById[pending.eventId];
    if (!ev) {
      this.state.pendingEvents = this.state.pendingEvents.filter((p) => p !== pending);
      return;
    }

    if (this.state.speed !== 0) {
      this.speedBeforeEvent = this.state.speed;
      this.state.speed = 0;
    }

    this.modalOpen = true;
    this._detailSig = '';

    showEventModal(this.d.modalRoot, ev, (index) => {
      this.modalOpen = false;

      const res = applyPlayerChoice(this.state, this.data, pending.eventId, index);
      if (res.ok) {
        pushLog(this.d.log, [`事件「${ev.title}」→ 选择：${res.choice}`], this.state.date, 'gold');
        if (res.notes?.length) pushLog(this.d.log, res.notes.map((n) => `  · ${n}`), this.state.date);
      }

      const stillPending = this.state.pendingEvents.some((p) => p.tag === this.state.playerTag);
      if (!stillPending && this.speedBeforeEvent) {
        this.state.speed = this.speedBeforeEvent;
        this.speedBeforeEvent = 0;
      }

      refreshHud(this.refs.hud, this.state, this.data);
      this.maybeShowEvent();
    }, this.data);
  }

  /* ==========================================================
   * 存档
   * ========================================================== */

  onSave() {
    const r = saveToLocal(this.state);
    if (r.ok) {
      toast(this.d.modalRoot, `已保存 · ${dateStr(this.state.date)}`);
      pushLog(this.d.log, ['✓ 已写入浏览器本地存档'], this.state.date, 'green');
    } else {
      toast(this.d.modalRoot, `保存失败：${r.reason}`, 2600);
    }
  }

  onLoad() {
    const raw = loadFromLocal();
    if (!raw) {
      toast(this.d.modalRoot, '没有找到本地存档');
      return;
    }

    try {
      const { state, notes } = migrate(raw);
      const fixes = reconcileWithData(state, this.data);

      this.state = state;
      this.state.speed = 0;
      this.state.selectedProvince = null;
      this.selectedFocusId = null;
      this.d.detail.hidden = true;
      this._lastProvince = null;
      this._detailSig = '';
      this._dossierSig = '';
      this.setView('focus', 'focus');
      this.scrollToRoot();

      clearLog(this.d.log);
      pushLog(this.d.log, [...notes, ...fixes], state.date, 'green');
      pushLog(this.d.log, [`=== 读档成功 · ${dateStr(state.date)} ===`], state.date, 'gold');

      toast(this.d.modalRoot, '读档成功');
    } catch (err) {
      toast(this.d.modalRoot, `读档失败：${err.message}`, 3200);
      pushLog(this.d.log, [`✗ 读档失败：${err.message}`], this.state.date, 'red');
    }
  }

  onExport() {
    const payload = JSON.stringify(serialize(this.state), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `focus-save-${dateStr(this.state.date).replace(/\./g, '')}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(this.d.modalRoot, '存档已导出');
  }

  onImport() {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const { state, notes } = migrate(JSON.parse(text));
        const fixes = reconcileWithData(state, this.data);

        this.state = state;
        this.state.speed = 0;
        this.state.selectedProvince = null;
        this.selectedFocusId = null;
        this.d.detail.hidden = true;
        this._lastProvince = null;
        this._detailSig = '';
        this._dossierSig = '';
        this.setView('focus', 'focus');
        this.scrollToRoot();

        clearLog(this.d.log);
        pushLog(this.d.log, [...notes, ...fixes], state.date, 'green');
        pushLog(this.d.log, [`=== 导入存档成功 · ${dateStr(state.date)} ===`], state.date, 'gold');
        toast(this.d.modalRoot, '导入成功');
      } catch (err) {
        toast(this.d.modalRoot, `导入失败：${err.message}`, 3200);
      }
    });
    input.click();
  }

  /* ==========================================================
   * 模组
   * ========================================================== */

  onMods() {
    const prevSpeed = this.state.speed;
    this.state.speed = 0;

    const modMeta = [];

    const open = async () => {
      // 逐个读取 mod.json 以获得名称/描述
      for (const m of this.data.modIndex) {
        if (typeof m === 'string') {
          modMeta.push({ id: m, name: m, version: '?', description: '' });
          continue;
        }
        try {
          const res = await fetch(`data/mods/${m.id}/mod.json`, { cache: 'no-store' });
          modMeta.push(res.ok ? await res.json() : { ...m, version: '?', description: '（mod.json 读取失败）' });
        } catch {
          modMeta.push({ ...m, version: '?', description: '（mod.json 读取失败）' });
        }
      }

      showModManager(this.d.modalRoot, {
        modIndex: modMeta,
        enabled: this.mods,
        onApply: (next) => this.applyMods(next),
      });
    };

    open().catch(() => {
      this.state.speed = prevSpeed;
    });
  }

  async applyMods(next) {
    this.d.boot.hidden = false;
    this.d.bootMsg.textContent = '正在重新加载数据…';
    this.d.bootDetail.textContent = '';
    this.d.app.hidden = true;

    try {
      const same = [...next].sort().join(',') === [...this.mods].sort().join(',');

      if (same) {
        this.d.boot.hidden = true;
        this.d.app.hidden = false;
        toast(this.d.modalRoot, '模组未变更');
        this.startLoop();
        return;
      }

      const ok = await this.load(next);
      if (!ok) {
        this.showIssuesView({ fatal: true });
        return;
      }

      this.d.boot.hidden = true;
      this.d.app.hidden = false;

      this.buildAll();
      this.newGame();
    } catch (err) {
      this.d.boot.hidden = true;
      this.d.app.hidden = false;
      toast(this.d.modalRoot, `重载失败：${err.message}`, 3200);
      this.startLoop();
    }
  }

  /* ==========================================================
   * 失败与报告
   * ========================================================== */

  showIssuesView({ fatal = false } = {}) {
    this.d.bootMsg.textContent = fatal ? '数据加载失败，无法开始游戏' : '数据加载完成（有警告）';

    const errs = this.data?.errors || [];
    const detail = this.d.bootDetail;
    detail.textContent = '';

    for (const e of errs) {
      const row = el('div', { class: 'err', text: `ERROR  ${e.msg}` });
      const src = el('div', { text: `       ${e.src || ''}` });
      detail.append(row, src);
    }

    for (const it of this.issues || []) {
      const cls = it.level === 'error' ? 'err' : 'warn';
      const tag = it.level === 'error' ? 'ERROR' : 'WARN ';
      detail.append(el('div', { class: cls, text: `${tag}  ${it.msg}` }));
      if (it.src) detail.append(el('div', { text: `       ${it.src}` }));
    }

    if (!detail.childElementCount) {
      detail.append(el('div', { class: 'ok', text: '未发现问题。' }));
    }

    if (fatal) {
      detail.append(el('div', { class: 'warn', text: '\n请修复以上错误后刷新页面。' }));
      this.d.bootDetail.scrollTop = 0;
    }
  }

  fatal(err) {
    this.d.bootMsg.textContent = '启动失败';
    this.d.bootDetail.textContent =
      `${err?.stack || err?.message || err}\n\n` +
      '常见原因：\n' +
      '  1. 直接双击 index.html 打开 —— 浏览器会阻止 file:// 下的 fetch 请求。\n' +
      '     请改用本地服务器：python serve.py\n' +
      '  2. data/ 目录缺失或被移动。\n' +
      '  3. 某个 JSON 文件语法错误（可打开浏览器控制台查看具体文件）。';
  }

  /* ==========================================================
   * 键盘
   * ========================================================== */

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.state) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.state.speed = this.state.speed === 0 ? (this.speedBeforeEvent || 3) : 0;
        this.acc = 0;
      } else if (e.key >= '1' && e.key <= '5') {
        this.state.speed = Number(e.key);
        this.acc = 0;
      } else if (e.key === '0') {
        // 0 原本是"暂停"，现在空格负责暂停；0 让整棵树落回视口
        this.refs.canvas?.fit();
      } else if (e.key === '+' || e.key === '=') {
        this.refs.canvas?.zoomBy(1.16);
      } else if (e.key === '-' || e.key === '_') {
        this.refs.canvas?.zoomBy(1 / 1.16);
      } else if (e.key === 'Escape') {
        if (this.selectedFocusId) {
          this.selectedFocusId = null;
          this.d.detail.hidden = true;
        }
      }
    });
  }
}

/* ============================================================
 * 小工具
 * ============================================================ */

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}
