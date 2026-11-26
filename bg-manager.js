// 隨筆花園：動態天候與背景管理深模組 (Deep Module)
// 職責：圖層契約、CSS 單次注入、SVG <defs> ID 作用域隔離、StageScope 生命週期回收、Store 單向訂閱
// 主題實作定義於 bg-themes.js；新增背景時無須修改本檔。

import { BG_THEMES } from './bg-themes.js?v=20261127a';

const BG_STYLE_ID = 'essay-garden-dynamic-bg-styles';
const DEFAULT_THEME_ID = 'morning';

// 共用圖層層疊契約：後景在小島(z-10)之下，前景在小島(z-10)之上且低於隨筆與懸浮導覽 UI
// 加上 contain 隔離排版／重繪範圍，並於瀏覽器分頁切至背景不可見時自動暫停動畫
const BASE_LAYER_CSS = `
  #dynamic-bg-layer { z-index: 0 !important; pointer-events: none !important; contain: layout style paint; }
  #dynamic-fg-layer { z-index: 25 !important; pointer-events: none !important; contain: layout style paint; }
  #app-container[data-bg-paused="true"] #dynamic-bg-layer *,
  #app-container[data-bg-paused="true"] #dynamic-fg-layer * {
    animation-play-state: paused !important;
  }
`;

// =========================================================================
// 1. 數學亂數與 SVG ID 作用域工具
// =========================================================================
const PRNG_A = 1664525;
const PRNG_C = 1013904223;
const PRNG_M = 4294967296;
let prngSeed = 987654321;

export function nextPrng() {
  prngSeed = (PRNG_A * prngSeed + PRNG_C) % PRNG_M;
  return prngSeed / PRNG_M;
}

export function sampleBoxMullerNormal(mean, stdev) {
  let u1 = nextPrng();
  const u2 = nextPrng();
  while (u1 <= 1e-7) u1 = nextPrng();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdev;
}

let uidSeq = 0;
function nextUid(prefix = 'bg') {
  return `${prefix}_${++uidSeq}`;
}

const SVG_BLOCK_RE = /<svg\b[\s\S]*?<\/svg>/g;
const SVG_ID_DECL_RE = /\bid="([^"]+)"/g;
const SVG_ID_REF_RE = /\bid="([^"]+)"|url\(#([^)]+)\)|(xlink:)?href="#([^"]+)"/g;

/**
 * 單趟重寫 <svg>...</svg> 內部定義的 id 與對應 url(#...) / href="#..."，
 * 避免多處同時渲染縮圖或動態元件時發生 <defs> ID 碰撞，同時保留外層 HTML 節點 ID。
 */
function scopeSvgIds(html, prefix = 's') {
  if (!html || !html.includes('<svg')) return html;
  return html.replace(SVG_BLOCK_RE, (svg) => {
    const ids = new Set();
    let m;
    SVG_ID_DECL_RE.lastIndex = 0;
    while ((m = SVG_ID_DECL_RE.exec(svg)) !== null) ids.add(m[1]);
    if (ids.size === 0) return svg;
    const p = `${prefix}${++uidSeq}_`;
    return svg.replace(SVG_ID_REF_RE, (full, declId, urlId, xlinkPrefix, hrefId) => {
      if (declId && ids.has(declId)) return `id="${p}${declId}"`;
      if (urlId && ids.has(urlId)) return `url(#${p}${urlId})`;
      if (hrefId && ids.has(hrefId)) return `${xlinkPrefix || ''}href="#${p}${hrefId}"`;
      return full;
    });
  });
}

// =========================================================================
// 2. 平台接縫適配器 (Platform Stage Adapters)
// =========================================================================

/** 瀏覽器真實 DOM 適配器（生產環境） */
export class DOMAdapter {
  constructor({ stageId = 'app-container', backLayerId = 'dynamic-bg-layer', foreLayerId = 'dynamic-fg-layer' } = {}) {
    this.stageId = stageId;
    this.backLayerId = backLayerId;
    this.foreLayerId = foreLayerId;
    this._stage = null;
    this._back = null;
    this._fore = null;
    this._visBound = false;
  }

  init() {
    if (typeof document !== 'undefined') {
      this._stage = document.getElementById(this.stageId);
      this._back = document.getElementById(this.backLayerId);
      this._fore = document.getElementById(this.foreLayerId);
      if (!this._visBound) {
        this._visBound = true;
        const syncVis = () => {
          if (!this._stage) return;
          if (document.hidden) this._stage.dataset.bgPaused = 'true';
          else delete this._stage.dataset.bgPaused;
        };
        document.addEventListener('visibilitychange', syncVis);
        syncVis();
      }
    }
  }

  injectStyles(styleId, cssText) {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(styleId);
    if (!el) {
      el = document.createElement('style');
      el.id = styleId;
      document.head.appendChild(el);
    }
    el.textContent = cssText;
  }

  setStageClass(className, removeClasses = []) {
    if (!this._stage) return;
    removeClasses.forEach((c) => this._stage.classList.remove(c));
    this._stage.classList.add(className);
  }

  setStageScreen(screenName) {
    if (!this._stage) return;
    if (screenName) this._stage.dataset.screen = screenName;
    else delete this._stage.dataset.screen;
  }

  clearLayers() {
    if (this._back) this._back.innerHTML = '';
    if (this._fore) this._fore.innerHTML = '';
  }

  appendBack(el) { if (this._back && el) this._back.appendChild(el); }
  appendFore(el) { if (this._fore && el) this._fore.appendChild(el); }
  setBackHtml(html) { if (this._back) this._back.innerHTML = html; }
  setForeHtml(html) { if (this._fore) this._fore.innerHTML = html; }

  createElement(tag, className = '', innerHTML = '') {
    if (typeof document === 'undefined') return null;
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  }

  setInterval(fn, ms) { return globalThis.setInterval ? globalThis.setInterval(fn, ms) : null; }
  clearInterval(id) { if (globalThis.clearInterval && id) globalThis.clearInterval(id); }
  setTimeout(fn, ms) { return globalThis.setTimeout ? globalThis.setTimeout(fn, ms) : null; }
  clearTimeout(id) { if (globalThis.clearTimeout && id) globalThis.clearTimeout(id); }
}

/** 記憶體虛擬適配器（單元測試環境，零 DOM 依賴） */
export class VirtualAdapter {
  constructor() {
    this.currentStageClass = '';
    this.currentScreen = '';
    this.injectedCss = '';
    this.backNodes = [];
    this.foreNodes = [];
    this.intervals = new Map();
    this.timeouts = new Map();
    this._nextId = 1;
  }

  init() {}
  injectStyles(_id, cssText) { this.injectedCss = cssText; }
  setStageClass(className) { this.currentStageClass = className; }
  setStageScreen(screenName) { this.currentScreen = screenName; }
  clearLayers() { this.backNodes = []; this.foreNodes = []; }
  appendBack(el) { this.backNodes.push(el); }
  appendFore(el) { this.foreNodes.push(el); }
  setBackHtml(html) { this.backNodes = [{ tag: 'div', innerHTML: html, style: {}, className: '' }]; }
  setForeHtml(html) { this.foreNodes = [{ tag: 'div', innerHTML: html, style: {}, className: '' }]; }

  createElement(tag, className = '', innerHTML = '') {
    const listeners = new Map();
    const el = {
      tag,
      className,
      innerHTML,
      style: {},
      addEventListener(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
      },
      removeEventListener(evt, fn) {
        listeners.get(evt)?.delete(fn);
      },
      emit(evt) {
        for (const fn of Array.from(listeners.get(evt) || [])) fn();
      },
      remove: () => {
        this.backNodes = this.backNodes.filter((n) => n !== el);
        this.foreNodes = this.foreNodes.filter((n) => n !== el);
      }
    };
    return el;
  }

  setInterval(fn, ms) {
    const id = this._nextId++;
    this.intervals.set(id, { fn, ms });
    return id;
  }

  clearInterval(id) { this.intervals.delete(id); }

  setTimeout(fn, ms) {
    const id = this._nextId++;
    this.timeouts.set(id, { fn, ms });
    return id;
  }

  clearTimeout(id) { this.timeouts.delete(id); }

  /** 測試推進：觸發當前所有待執行 timeout 一次 */
  flushTimeouts() {
    const pending = Array.from(this.timeouts.entries());
    for (const [id, entry] of pending) {
      this.timeouts.delete(id);
      entry.fn();
    }
  }
}

// =========================================================================
// 3. 單次掛載隔離作用域 (StageScope)
// =========================================================================
class StageScope {
  constructor(adapter) {
    this._adapter = adapter;
    this._alive = true;
    this._intervals = new Set();
    this._timeouts = new Set();
    this._cleanups = [];
  }

  prng() { return nextPrng(); }
  normal(mean, stdev) { return sampleBoxMullerNormal(mean, stdev); }
  uid(prefix = 'bg') { return nextUid(prefix); }
  scopeSvg(html) { return scopeSvgIds(html); }

  setBackHtml(html) { if (this._alive) this._adapter.setBackHtml(scopeSvgIds(html)); }
  setForeHtml(html) { if (this._alive) this._adapter.setForeHtml(scopeSvgIds(html)); }
  appendBack(el) { if (this._alive) this._adapter.appendBack(el); }
  appendFore(el) { if (this._alive) this._adapter.appendFore(el); }

  createElement(tag, className = '', innerHTML = '') {
    if (!this._alive) return null;
    return this._adapter.createElement(tag, className, scopeSvgIds(innerHTML));
  }

  /** 單次延遲執行：回呼觸發當下立刻移出追蹤集合，避免長駐迴圈洩漏 */
  after(ms, fn) {
    if (!this._alive) return null;
    const id = this._adapter.setTimeout(() => {
      this._timeouts.delete(id);
      if (this._alive) fn();
    }, ms);
    if (id != null) this._timeouts.add(id);
    return id;
  }

  every(ms, fn) {
    if (!this._alive) return null;
    const id = this._adapter.setInterval(() => {
      if (this._alive) fn();
    }, ms);
    if (id != null) this._intervals.add(id);
    return id;
  }

  on(el, event, fn) {
    if (!this._alive || !el || typeof el.addEventListener !== 'function') return;
    const wrapped = (...args) => { if (this._alive) fn(...args); };
    el.addEventListener(event, wrapped);
    this._cleanups.push(() => el.removeEventListener?.(event, wrapped));
  }

  onCleanup(fn) {
    if (this._alive && typeof fn === 'function') this._cleanups.push(fn);
  }

  dispose() {
    if (!this._alive) return;
    this._alive = false;
    for (const id of this._intervals) this._adapter.clearInterval(id);
    for (const id of this._timeouts) this._adapter.clearTimeout(id);
    this._intervals.clear();
    this._timeouts.clear();
    for (const fn of this._cleanups) fn();
    this._cleanups = [];
    this._adapter.clearLayers();
  }
}

// =========================================================================
// 4. 背景管理深模組核心實作 (BgManager)
// =========================================================================
export class BgManager {
  constructor({ adapter = null, themes = BG_THEMES } = {}) {
    this.adapter = adapter || new DOMAdapter();
    this.themes = themes;
    this.store = null;
    this.unsubscribeStore = null;
    this.currentThemeId = DEFAULT_THEME_ID;
    this._scope = null;
  }

  init({
    stageId = 'app-container',
    backLayerId = 'dynamic-bg-layer',
    foreLayerId = 'dynamic-fg-layer',
    defaultTheme = DEFAULT_THEME_ID,
    adapter = null,
    store = null
  } = {}) {
    if (adapter) {
      this.adapter = adapter;
    } else if (this.adapter instanceof DOMAdapter) {
      this.adapter.stageId = stageId;
      this.adapter.backLayerId = backLayerId;
      this.adapter.foreLayerId = foreLayerId;
    }
    this.adapter.init();
    this.adapter.injectStyles(BG_STYLE_ID, this._compileCss());

    if (store) this.bindStore(store);
    else this.setTheme(defaultTheme);
  }

  bindStore(store) {
    if (!store) return;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this.store = store;

    if (typeof store.subscribe === 'function') {
      this.unsubscribeStore = store.subscribe(() => {
        const active = store.getActiveBgTheme ? store.getActiveBgTheme() : DEFAULT_THEME_ID;
        if (active && active !== this.currentThemeId) this.setTheme(active);
      });
    }

    const initial = store.getActiveBgTheme ? store.getActiveBgTheme() : DEFAULT_THEME_ID;
    this.setTheme(initial);
  }

  getThemeCatalog() {
    const source = this.store?.catalog?.bgThemes
      || Object.keys(this.themes).map((id) => ({ id, name: id, cost: 0, desc: '' }));

    return source.map((t) => ({
      ...t,
      bgClass: `bg-theme-${t.id}`,
      thumbSvg: scopeSvgIds(this.themes[t.id]?.thumbSvg || '', 'th')
    }));
  }

  setScreen(screenName) {
    this.adapter.setStageScreen(screenName);
    this.themes[this.currentThemeId]?.onScreenChange?.(screenName, this._scope);
  }

  getCurrentTheme() {
    return this.currentThemeId;
  }

  setTheme(themeId) {
    const themeIds = Object.keys(this.themes);
    const resolvedId = this.themes[themeId]
      ? themeId
      : (this.themes[DEFAULT_THEME_ID] ? DEFAULT_THEME_ID : themeIds[0]);
    this.currentThemeId = resolvedId;

    this.adapter.setStageClass(
      `bg-theme-${resolvedId}`,
      themeIds.map((id) => `bg-theme-${id}`)
    );

    this._scope?.dispose();
    this._scope = new StageScope(this.adapter);
    this.themes[resolvedId].mount(this._scope);
  }

  destroy() {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this._scope?.dispose();
    this._scope = null;
    this.adapter.clearLayers();
  }

  _compileCss() {
    const parts = [BASE_LAYER_CSS];
    for (const [id, theme] of Object.entries(this.themes)) {
      if (theme.sky) parts.push(`.bg-theme-${id} { background: ${theme.sky} !important; }`);
      if (theme.css) parts.push(theme.css);
    }
    return parts.join('\n');
  }
}

export const bgManager = new BgManager();
