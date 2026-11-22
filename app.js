// 隨筆花園：Cozy Forest 設計系統、自製 Duotone SVG 圖標庫與 2.5D 手繪圖素渲染引擎
import {
  addDays,
  countEssayWords,
  getRarityProbabilities,
  isLastDayOfMonth,
  computeNeighborAdjustedScales,
  calcPlantLevel
} from './engine.js?v=20261123b';
import {
  GardenStore,
  DEMO_ESSAY_ID,
  DEMO_CARD_STYLE_KEY,
  DEMO_REACTIONS_KEY,
  getDemoEssayCardStyle,
  saveDemoEssayCardStyle,
  getDemoEssayReactions,
  saveDemoEssayReactions
} from './store.js?v=20261123b';
import { CloudGardenStore } from './cloud-store.js?v=20261123b';
import { SESSION_STORAGE_KEY } from './cloud-client.js?v=20261123b';
import { bgManager } from './bg-manager.js?v=20261123b';

const ASSET_VER = '20261123b';
const TAIL_PULL_THRESHOLD_PX = 52;

const CARD_STYLES = [
  { id: 'card1', name: '雛菊霧藍', bg: '#fbeedf' },
  { id: 'card2', name: '晴空雲朵', bg: '#faf1e5' },
  { id: 'card3', name: '暖棕咖啡', bg: '#fcf3e4' },
  { id: 'card4', name: '抹茶格紋', bg: '#fbf0e0' },
  { id: 'card5', name: '蜂蜜暖黃', bg: '#faefe0' },
  { id: 'card6', name: '櫻花愛心', bg: '#fbefe0' },
  { id: 'card7', name: '星空彎月', bg: '#faf1e4' }
];
const CARD_STYLE_MAP = Object.fromEntries(CARD_STYLES.map(c => [c.id, c]));

function resolveEssayCardStyle(essay) {
  if (essay?.cardStyle && CARD_STYLE_MAP[essay.cardStyle]) {
    return CARD_STYLE_MAP[essay.cardStyle];
  }
  const idStr = String(essay?.id || '');
  let hash = 0;
  for (let i = 0; i < idStr.length; i++) hash += idStr.charCodeAt(i);
  return CARD_STYLES[hash % CARD_STYLES.length];
}

const CARD_STYLE_STORAGE_KEY = 'essay_garden_card_style_v1';

function savePreferredCardStyle(styleId) {
  if (!CARD_STYLE_MAP[styleId]) return;
  localStorage.setItem(CARD_STYLE_STORAGE_KEY, styleId);
}

function getDefaultCardStyle(user) {
  const saved = localStorage.getItem(CARD_STYLE_STORAGE_KEY);
  if (saved && CARD_STYLE_MAP[saved]) return saved;
  if (user?.lastCardStyle && CARD_STYLE_MAP[user.lastCardStyle]) {
    return user.lastCardStyle;
  }
  return CARD_STYLES[0].id;
}

function memoStyleAttr(card) {
  return `--memo-img:url('./assets/card/${card.id}.png?v=${ASSET_VER}');--memo-bg:${card.bg};`;
}

function renderCardPickerHtml(selectedId) {
  const active = CARD_STYLE_MAP[selectedId] || CARD_STYLES[0];
  return `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-xs">
        <span class="font-semibold text-[#5c5046]">便條紙款式</span>
        <span data-card-picker-name class="font-bold text-[#1d4237]">${active.name}</span>
      </div>
      <div class="flex items-center justify-between gap-1.5 px-0.5 py-0.5">
        ${CARD_STYLES.map(st => {
          const isSel = st.id === active.id;
          const ringCls = isSel ? 'ring-2 ring-[#2b5e4e] ring-offset-1 scale-105' : 'opacity-80 hover:opacity-100';
          return `<button type="button" data-pick-card="${st.id}" title="${st.name}" aria-label="${st.name}" aria-pressed="${isSel}"
            class="h-8 flex-1 rounded-lg border border-[#d8cbb8] transition bg-no-repeat ${ringCls}"
            style="background-image:url('./assets/card/${st.id}.png?v=${ASSET_VER}');background-size:100% auto;background-position:top center;background-color:${st.bg}"></button>`;
        }).join('')}
      </div>
    </div>`;
}

function bindCardPicker(rootEl, memoWrapEl, initialId, onChange) {
  const nameEl = rootEl.querySelector('[data-card-picker-name]');
  const buttons = rootEl.querySelectorAll('[data-pick-card]');
  buttons.forEach(btn => {
    btn.onclick = () => {
      const nextId = btn.dataset.pickCard;
      const st = CARD_STYLE_MAP[nextId];
      if (!st) return;
      if (memoWrapEl) {
        memoWrapEl.style.setProperty('--memo-img', `url('./assets/card/${st.id}.png?v=${ASSET_VER}')`);
        memoWrapEl.style.setProperty('--memo-bg', st.bg);
      }
      if (nameEl) nameEl.textContent = st.name;
      buttons.forEach(b => {
        const active = b.dataset.pickCard === nextId;
        b.setAttribute('aria-pressed', String(active));
        b.classList.toggle('ring-2', active);
        b.classList.toggle('ring-[#2b5e4e]', active);
        b.classList.toggle('ring-offset-1', active);
        b.classList.toggle('scale-105', active);
        b.classList.toggle('opacity-80', !active);
      });
      if (onChange) onChange(nextId);
    };
  });
}

let store;
let config;
let catalog;
let lastIslandContext = null;
let speciesRuleMap = {};
let decorRuleMap = {};

const ui = {
  screen: 'home', // 'home' | 'garden' | 'essays'
  viewingGardenId: null,
  viewingRegionId: null,
  viewingEssayMonth: null,
  essaysAnim: null, // null | 'enter' | 'month'
  activeModal: null,
  modalData: null,
  placingMode: null,
  toastMsg: null,
  pan: { x: 0, y: 0 },
  zoom: 1,
  didDrag: false,
  carouselDidDrag: false,
  suppressCardId: null,
  suppressCardClickUntil: 0
};
let essaysTransitionTimer = null;
let pendingWriteLock = false;
const loadingEssayMonths = new Set();

async function runLockedAction(btnEl, loadingLabel, actionFn) {
  if (pendingWriteLock || (btnEl && btnEl.disabled)) return;
  pendingWriteLock = true;
  let origHtml = null;
  if (btnEl) {
    origHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.dataset.loading = 'true';
    if (loadingLabel) btnEl.textContent = loadingLabel;
  }
  try {
    await actionFn();
  } catch (err) {
    showToast(err?.message || '操作失敗，請稍後再試');
  } finally {
    pendingWriteLock = false;
    if (btnEl && btnEl.isConnected) {
      btnEl.disabled = false;
      delete btnEl.dataset.loading;
      if (origHtml !== null) btnEl.innerHTML = origHtml;
    }
  }
}

function resetGardenView() {
  ui.pan = { x: 0, y: 0 };
  ui.zoom = 1;
}

function clearEssaysTransition() {
  clearTimeout(essaysTransitionTimer);
  essaysTransitionTimer = null;
  const homeEl = document.getElementById('screen-home');
  if (homeEl) {
    homeEl.classList.remove('home-fade-out', 'absolute', 'inset-x-0', 'bottom-0', 'z-0');
    homeEl.classList.add('z-10');
    homeEl.style.top = '';
    if (ui.screen !== 'home') homeEl.classList.add('hidden');
  }
  const essaysHeader = document.querySelector('#screen-essays > header');
  if (essaysHeader) essaysHeader.classList.remove('essays-header-in');
}

function goHome() {
  closeReactionTray();
  ui.screen = 'home';
  ui.essaysAnim = null;
  ui.placingMode = null;
  ui.activeModal = null;
  clearEssaysTransition();
  resetGardenView();
  renderApp();
}

function openAllEssaysScreen() {
  closeReactionTray();
  clearEssaysTransition();
  const homeEl = document.getElementById('screen-home');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animateEnter = !reduceMotion && ui.screen === 'home' && homeEl;
  const homeTop = animateEnter ? homeEl.offsetTop : 0;

  ui.screen = 'essays';
  ui.viewingEssayMonth = null;
  ui.essaysAnim = animateEnter ? 'enter' : null;
  ui.activeModal = null;
  renderApp();
  const listEl = document.getElementById('essays-day-list');
  if (listEl) listEl.scrollTop = 0;

  if (animateEnter) {
    homeEl.classList.remove('hidden', 'z-10');
    homeEl.style.top = `${homeTop}px`;
    homeEl.classList.add('absolute', 'inset-x-0', 'bottom-0', 'z-0', 'home-fade-out');
    essaysTransitionTimer = setTimeout(() => {
      clearEssaysTransition();
    }, 230);
  }
}

// ============================================================================
// 1. 自製 24x24 圓角雙色 (Duotone) SVG 圖標系統（零系統 Emoji，符合 Cozy UI 規範）
// ============================================================================
export function icon(name, cls = 'w-4 h-4') {
  const paths = {
    sprout: `
      <path d="M12 21V11" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M12 13C12 8.5 7.5 6 4 7C4 11 7.5 13.5 12 13Z" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 11C12 6.5 16.5 4 20 5C20 9 16.5 11.5 12 11Z" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    quill: `
      <path d="M20.2 3.8C16.5 3.8 11.5 6.5 8.5 11.5L5 19L12.5 15.5C17.5 12.5 20.2 7.5 20.2 3.8Z" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M4 20L10.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    flame: `
      <path d="M12 3C13.5 6.5 18 8.5 18 13.5C18 17.1 15.3 20 12 20C8.7 20 6 17.1 6 13.5C6 10.5 8 8.5 9.5 6.5C9.5 8.5 11 9.5 11 9.5C11 6.5 12 3 12 3Z" fill="#f59e0b" fill-opacity="0.28" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    bolt: `
      <path d="M13 3L5.5 13.5H12L11 21L18.5 10.5H12L13 3Z" fill="#10b981" fill-opacity="0.25" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    pouch: `
      <path d="M8 7H16L18.5 11.5C19.6 13.5 19.2 16.2 17.5 18C16.1 19.4 14.1 20 12 20C9.9 20 7.9 19.4 6.5 18C4.8 16.2 4.4 13.5 5.5 11.5L8 7Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9.5 4L12 7L14.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    shop: `
      <path d="M4 10V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V10" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M3 10L5 4H19L21 10C19.5 11.2 17.5 11.2 16 10C14.5 11.2 12.5 11.2 11 10C9.5 11.2 7.5 11.2 6 10C4.8 11 3.8 10.8 3 10Z" fill="#df8a2b" fill-opacity="0.28" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    book: `
      <path d="M4 6C4 4.9 4.9 4 6 4H11C11.6 4 12 4.4 12 5V19C12 18.4 11.6 18 11 18H6C4.9 18 4 17.1 4 16V6Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M20 6C20 4.9 19.1 4 18 4H13C12.4 4 12 4.4 12 5V19C12 18.4 12.4 18 13 18H18C19.1 18 20 17.1 20 16V6Z" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    album: `
      <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="2"/>
      <circle cx="9" cy="9" r="1.8" fill="currentColor"/>
      <path d="M5 17L10 12.5L13.5 15.5L16.5 13L19 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    users: `
      <circle cx="9" cy="8.5" r="3" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="2"/>
      <path d="M4 19C4 16.2 6.2 14 9 14C11.8 14 14 16.2 14 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16.5" cy="9.5" r="2.3" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.8"/>
      <path d="M15 19C15 16.8 16.6 15 18.8 15C19.6 15 20.3 15.3 20.8 15.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    settings: `
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" fill="currentColor" fill-opacity="0.22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="3" fill="#ffffff" fill-opacity="0.85" stroke="currentColor" stroke-width="1.8"/>`,
    sparkles: `
      <path d="M12 3L14 8.5L19.5 10.5L14 12.5L12 18L10 12.5L4.5 10.5L10 8.5L12 3Z" fill="#f59e0b" fill-opacity="0.3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
    lock: `
      <rect x="5" y="11" width="14" height="9" rx="2.5" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="2"/>
      <path d="M8 11V7.5C8 5.3 9.8 3.5 12 3.5C14.2 3.5 16 5.3 16 7.5V11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    chevLeft: `
      <path d="M15.5 4.5L7.5 12L15.5 19.5" stroke="#ffffff" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
      <path d="M15.5 4.5L7.5 12L15.5 19.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    chevRight: `
      <path d="M8.5 4.5L16.5 12L8.5 19.5" stroke="#ffffff" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
      <path d="M8.5 4.5L16.5 12L8.5 19.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    arrowLeft: `
      <path d="M19 12H5.5M5.5 12L11.5 6M5.5 12L11.5 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    expand: `
      <path d="M14 4H20V10M20 4L13 11M10 20H4V14M4 20L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    heart: `
      <path d="M12 20.2C12 20.2 4.5 15.2 4.5 9.6C4.5 6.9 6.6 4.8 9.2 4.8C10.8 4.8 11.7 5.6 12 6.5C12.3 5.6 13.2 4.8 14.8 4.8C17.4 4.8 19.5 6.9 19.5 9.6C19.5 15.2 12 20.2 12 20.2Z" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>`,
    heartFilled: `
      <path d="M12 20.2C12 20.2 4.5 15.2 4.5 9.6C4.5 6.9 6.6 4.8 9.2 4.8C10.8 4.8 11.7 5.6 12 6.5C12.3 5.6 13.2 4.8 14.8 4.8C17.4 4.8 19.5 6.9 19.5 9.6C19.5 15.2 12 20.2 12 20.2Z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M8.5 8.5C8.5 7.7 9.1 7.1 9.9 7.1" stroke="#fffdf8" stroke-width="1.6" stroke-linecap="round"/>`,
    sunCheer: `
      <circle cx="12" cy="12" r="4.5" fill="currentColor" fill-opacity="0.28" stroke="currentColor" stroke-width="2"/>
      <path d="M12 3V5.2M12 18.8V21M3 12H5.2M18.8 12H21M5.6 5.6L7.2 7.2M16.8 16.8L18.4 18.4M18.4 5.6L16.8 7.2M7.2 16.8L5.6 18.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    hugWarm: `
      <path d="M12 19.5C12 19.5 6 15.4 6 11C6 8.8 7.7 7.2 9.7 7.2C10.9 7.2 11.7 7.8 12 8.6C12.3 7.8 13.1 7.2 14.3 7.2C16.3 7.2 18 8.8 18 11C18 15.4 12 19.5 12 19.5Z" fill="currentColor" fill-opacity="0.28" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M4.2 10.5C3.5 13 4.8 15.8 7.8 17.6M19.8 10.5C20.5 13 19.2 15.8 16.2 17.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
    sproutReact: `
      <path d="M12 20.5V10.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M12 13C12 8.4 7.6 5.8 4.2 6.8C4.2 10.8 7.6 13.4 12 13Z" fill="currentColor" fill-opacity="0.34" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
      <path d="M12 11C12 6.4 16.4 3.8 19.8 4.8C19.8 8.8 16.4 11.4 12 11Z" fill="currentColor" fill-opacity="0.34" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>`,
    sparkleReact: `
      <path d="M12 3.2L14.2 9.2L20.2 11.4L14.2 13.6L12 19.6L9.8 13.6L3.8 11.4L9.8 9.2L12 3.2Z" fill="currentColor" fill-opacity="0.32" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>
      <circle cx="18.2" cy="5.6" r="1.2" fill="currentColor"/>`
  };
  return `<svg viewBox="0 0 24 24" fill="none" class="${cls} shrink-0">${paths[name] || paths.sprout}</svg>`;
}

// ============================================================================
// 1B. 隨筆反應系統（短按愛心＋長按浮現 5 款選項並支援左右滑選）
// ============================================================================
const REACTIONS = [
  { id: 'sparkle', label: '感動', iconName: 'sparkleReact', color: '#8b6cc1', bg: '#f1ecf9' },
  { id: 'sprout', label: '萌芽', iconName: 'sproutReact', color: '#2d8a64', bg: '#e7f6ef' },
  { id: 'hug', label: '抱抱', iconName: 'hugWarm', color: '#d97757', bg: '#fceee8' },
  { id: 'cheer', label: '加油', iconName: 'sunCheer', color: '#e08d1e', bg: '#fef4e3' },
  { id: 'love', label: '喜歡', iconName: 'heartFilled', color: '#e25866', bg: '#fdecef' }
];
const REACTION_MAP = Object.fromEntries(REACTIONS.map(r => [r.id, r]));

const LONG_PRESS_MS = 320;
const MOVE_CANCEL_PX = 10;
const SLIDE_THRESHOLD_PX = 8;

const reactionState = {
  press: null, // { btnEl, essay, pointerId, startX, startY, timer, cancelled, trayOpened, didSlide }
  tray: null   // { btnEl, essay, hoveredId }
};

function getEssayReactionSummary(essay, uid) {
  const map = essay?.reactions || {};
  const entries = Object.entries(map).filter(([, rid]) => REACTION_MAP[rid]);
  const myReaction = map[uid] && REACTION_MAP[map[uid]] ? map[uid] : null;
  const totalCount = entries.length;
  const displayReaction = myReaction || (entries[0]?.[1] || null);
  return { myReaction, totalCount, displayReaction };
}

function renderReactionBtnInner(essay, uid) {
  const { myReaction, totalCount, displayReaction } = getEssayReactionSummary(essay, uid);
  if (!displayReaction) {
    return `<span class="text-[#786b5e]/60 inline-flex items-center">${icon('heart', 'w-5 h-5')}</span>`;
  }
  const r = REACTION_MAP[displayReaction];
  const colorStyle = myReaction ? `color:${r.color}` : `color:${r.color};opacity:0.75`;
  return `<span class="inline-flex items-center gap-0.5" style="${colorStyle}">${icon(r.iconName, 'w-5 h-5')}<span class="text-xs font-bold leading-none">${totalCount}</span></span>`;
}

function getReactionAriaLabel(essay, uid) {
  const { totalCount, displayReaction } = getEssayReactionSummary(essay, uid);
  return displayReaction
    ? `${REACTION_MAP[displayReaction].label}，共 ${totalCount} 個反應（短按切換，長按選擇其他表情）`
    : '喜歡（短按點愛心，長按選擇其他表情）';
}

function updateReactionBtnUI(btnEl, essay, uid, animate = false) {
  const { myReaction } = getEssayReactionSummary(essay, uid);
  btnEl.innerHTML = renderReactionBtnInner(essay, uid);
  btnEl.dataset.activeReaction = myReaction || '';
  btnEl.setAttribute('aria-label', getReactionAriaLabel(essay, uid));
  if (animate) {
    btnEl.classList.remove('react-pop');
    void btnEl.offsetWidth;
    btnEl.classList.add('react-pop');
  }
}

function applyEssayReaction(essay, reactionId, sourceBtnEl = null) {
  const uid = store.state.currentUserId;
  const syncBtns = (animate) => {
    document.querySelectorAll(`[data-react-btn="${essay.id}"]`).forEach(b => {
      const shouldAnimate = animate && !b.closest('#modal-box') && (!sourceBtnEl || b === sourceBtnEl);
      updateReactionBtnUI(b, essay, uid, shouldAnimate);
    });
  };

  const isDemo = essay.id === DEMO_ESSAY_ID || essay.id === 'essay_welcome' || Boolean(essay.isDemo);
  if (isDemo) {
    const demoReactions = getDemoEssayReactions();
    if (demoReactions[uid] === reactionId) {
      delete demoReactions[uid];
    } else {
      demoReactions[uid] = reactionId;
    }
    saveDemoEssayReactions(demoReactions);
    essay.reactions = demoReactions;
    syncBtns(true);
    return;
  }

  let res;
  try {
    res = store.setEssayReaction(essay.id, reactionId, uid, essay.dayKey, essay.authorUid);
  } catch (err) {
    showToast(err?.message || '無法設定反應');
    return;
  }
  syncBtns(true);
  if (res && typeof res.then === 'function') {
    res.then(() => syncBtns(false)).catch((err) => {
      syncBtns(false);
      showToast(err?.message || '無法更新反應');
    });
  }
}

function setTrayHoveredOption(optId) {
  const trayEl = document.getElementById('reaction-tray');
  if (!trayEl || !reactionState.tray) return;
  reactionState.tray.hoveredId = optId || null;
  trayEl.querySelectorAll('[data-reaction-opt]').forEach(opt => {
    const hovered = opt.dataset.reactionOpt === optId;
    opt.dataset.hovered = String(hovered);
  });
}

function openReactionTray(btnEl, essay) {
  const trayEl = document.getElementById('reaction-tray');
  if (!trayEl) return;

  const cardEl = btnEl.closest('.essay-card');
  const isModal = Boolean(btnEl.closest('#modal-box') || btnEl.closest('#modal-overlay'));

  // 1. 托盤尺寸與表情排列順序：
  // 編輯頁面 (isModal): 托盤較大（按鈕 36x36），表情順序由左至右為 [love, cheer, hug, sprout, sparkle]，愛心在最左邊對齊按鈕
  // 首頁隨筆卡片 (!isModal): 托盤適應卡片寬度（按鈕 27x27），表情順序由右至左（最右端為愛心，陣列為 [sparkle, sprout, hug, cheer, love]），愛心在最右邊對齊卡片右下角
  const reactionList = isModal ? [...REACTIONS].reverse() : REACTIONS;
  const optSizeCls = isModal ? 'w-[36px] h-[36px]' : 'w-[27px] h-[27px]';
  const iconCls = isModal ? 'w-6 h-6' : 'w-[18px] h-[18px]';
  const labelCls = isModal ? 'text-xs -top-7' : 'text-[10px] -top-6';

  const trayWidth = isModal ? 236 : (cardEl ? Math.max(150, Math.round(cardEl.getBoundingClientRect().width)) : 160);
  trayEl.style.width = `${trayWidth}px`;

  trayEl.innerHTML = reactionList.map(r => `
    <button type="button" role="menuitem" data-reaction-opt="${r.id}" data-hovered="false" aria-label="${r.label}"
      class="reaction-opt relative ${optSizeCls} rounded-full flex items-center justify-center shrink-0 focus:outline-none"
      style="background:${r.bg};color:${r.color}">
      <span data-opt-label class="pointer-events-none absolute ${labelCls} left-1/2 px-1.5 py-0.5 rounded-full bg-[#1d4237] text-[#fffdf8] font-bold whitespace-nowrap shadow-sm">${r.label}</span>
      ${icon(r.iconName, iconCls)}
    </button>
  `).join('');

  // 先移除動畫取得未縮放精準寬度，再套用入場動畫與預設跳起愛心
  trayEl.classList.remove('hidden', 'reaction-tray-in');

  const btnRect = btnEl.getBoundingClientRect();
  const targetIcon = btnEl.querySelector('svg') || btnEl;
  const targetRect = targetIcon.getBoundingClientRect();
  const targetCenterX = targetRect.left + targetRect.width / 2;

  // 純粹幾何常數對齊：完全不受 CSS scale(1.42) 動態放大影響
  // 編輯頁面 (isModal): 愛心在最左邊，左側 padding 10px + 按鈕半寬 18px = 28px，精準對齊實際顯示之愛心圖標中心
  // 首頁卡片 (!isModal): 愛心在最右邊，trayWidth - 右側 padding 6px - 按鈕半寬 13.5px = trayWidth - 19.5px，精準對齊卡片右下角愛心圖標中心
  const loveCenterOffset = isModal ? 28 : (trayWidth - 19.5);

  const left = Math.max(8, Math.min(window.innerWidth - trayWidth - 8, targetCenterX - loveCenterOffset));
  const top = Math.max(36, btnRect.top - (isModal ? 52 : 38) - 8);
  trayEl.style.left = `${left.toFixed(1)}px`;
  trayEl.style.top = `${top.toFixed(1)}px`;

  void trayEl.offsetWidth;
  trayEl.classList.add('reaction-tray-in');

  reactionState.tray = { btnEl, essay, hoveredId: null };
  setTrayHoveredOption('love');

  trayEl.querySelectorAll('[data-reaction-opt]').forEach(opt => {
    opt.onclick = (ev) => {
      ev.stopPropagation();
      applyEssayReaction(essay, opt.dataset.reactionOpt, btnEl);
      closeReactionTray();
    };
  });
}

function closeReactionTray() {
  const trayEl = document.getElementById('reaction-tray');
  if (trayEl) trayEl.classList.add('hidden');
  reactionState.tray = null;
}

function initReactionTrayHandlers() {
  window.addEventListener('pointermove', (e) => {
    const press = reactionState.press;
    if (!press || e.pointerId !== press.pointerId) return;
    const dist = Math.hypot(e.clientX - press.startX, e.clientY - press.startY);

    if (!press.trayOpened) {
      if (dist > MOVE_CANCEL_PX) {
        clearTimeout(press.timer);
        press.cancelled = true;
      }
      return;
    }

    if (dist < SLIDE_THRESHOLD_PX) return;
    press.didSlide = true;
    const trayEl = document.getElementById('reaction-tray');
    if (!trayEl || trayEl.classList.contains('hidden')) return;

    const trayRect = trayEl.getBoundingClientRect();
    const btnRect = press.btnEl.getBoundingClientRect();
    const inBand =
      e.clientY >= trayRect.top - 56 &&
      e.clientY <= btnRect.bottom + 56 &&
      e.clientX >= trayRect.left - 24 &&
      e.clientX <= trayRect.right + 24;

    if (!inBand) {
      setTrayHoveredOption(null);
      return;
    }

    let closestId = null;
    let bestDist = Infinity;
    trayEl.querySelectorAll('[data-reaction-opt]').forEach(opt => {
      const r = opt.getBoundingClientRect();
      const d = Math.abs(e.clientX - (r.left + r.width / 2));
      if (d < bestDist) {
        bestDist = d;
        closestId = opt.dataset.reactionOpt;
      }
    });
    setTrayHoveredOption(closestId);
  });

  const finishPress = (e) => {
    const press = reactionState.press;
    if (!press || e.pointerId !== press.pointerId) return;
    clearTimeout(press.timer);
    reactionState.press = null;

    if (!press.cancelled) {
      ui.suppressCardId = press.essay.id;
      ui.suppressCardClickUntil = Date.now() + 280;
    }
    if (e.type === 'pointercancel') {
      closeReactionTray();
      return;
    }

    if (!press.trayOpened) {
      if (!press.cancelled) {
        const uid = store.state.currentUserId;
        const cur = press.essay.reactions?.[uid] || null;
        applyEssayReaction(press.essay, cur ? null : 'love', press.btnEl);
      }
      return;
    }

    const chosen = reactionState.tray?.hoveredId || null;
    if (chosen) {
      applyEssayReaction(press.essay, chosen, press.btnEl);
    }
    closeReactionTray();
  };
  window.addEventListener('pointerup', finishPress);
  window.addEventListener('pointercancel', finishPress);

  document.addEventListener('pointerdown', (e) => {
    if (!reactionState.tray || reactionState.press) return;
    if (e.target.closest('#reaction-tray') || e.target.closest('[data-react-btn]')) return;
    closeReactionTray();
  });

  document.addEventListener('selectstart', (e) => {
    if (reactionState.press) e.preventDefault();
  });
}

function bindReactionTrigger(btnEl, essay) {
  btnEl.onpointerdown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (reactionState.press) {
      clearTimeout(reactionState.press.timer);
      reactionState.press = null;
    }
    if (reactionState.tray) {
      const sameBtn = reactionState.tray.btnEl === btnEl;
      closeReactionTray();
      if (sameBtn) {
        ui.suppressCardClickUntil = Date.now() + 280;
        return;
      }
    }
    const press = {
      btnEl,
      essay,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      timer: null,
      cancelled: false,
      trayOpened: false,
      didSlide: false
    };
    press.timer = setTimeout(() => {
      if (reactionState.press !== press || press.cancelled) return;
      press.trayOpened = true;
      navigator.vibrate?.(12);
      openReactionTray(btnEl, essay);
    }, LONG_PRESS_MS);
    reactionState.press = press;
  };
  btnEl.onclick = (e) => {
    e.stopPropagation();
    if (e.detail === 0) {
      const uid = store.state.currentUserId;
      const cur = essay.reactions?.[uid] || null;
      applyEssayReaction(essay, cur ? null : 'love', btnEl);
      closeReactionTray();
    }
  };
  btnEl.oncontextmenu = (e) => e.preventDefault();
}

function showToast(msg) {
  ui.toastMsg = msg;
  const el = document.getElementById('toast-bar');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 3200);
  }
}

// ============================================================================
// 2. 2.5D 手繪圖素映射與等距島嶼渲染引擎（縮放基準與單格寬度皆讀取自 game-config.json spriteScale）
// ============================================================================
const spriteSizeCache = new Map();
let spriteRenderQueued = false;

function getSpriteDims(path, fallbackSize) {
  const cached = spriteSizeCache.get(path);
  if (cached && cached !== 'loading') return cached;
  if (!cached) {
    spriteSizeCache.set(path, 'loading');
    const img = new Image();
    img.onload = () => {
      spriteSizeCache.set(path, {
        w: img.naturalWidth || fallbackSize,
        h: img.naturalHeight || fallbackSize
      });
      if (!spriteRenderQueued) {
        spriteRenderQueued = true;
        requestAnimationFrame(() => {
          spriteRenderQueued = false;
          if (lastIslandContext) renderActiveIslandSvg(lastIslandContext.viewGarden, lastIslandContext.evalData);
        });
      }
    };
    img.onerror = () => {
      spriteSizeCache.set(path, { w: fallbackSize, h: fallbackSize });
    };
    img.src = `${path}?v=${ASSET_VER}`;
  }
  return { w: fallbackSize, h: fallbackSize };
}

function parseSizeRule(ruleStr) {
  const s = String(ruleStr || '').trim().toUpperCase();
  const mode = s[0] === 'W' ? 'width' : (s[0] === 'H' ? 'height' : null);
  const size = Number(s.slice(1));
  if (!mode || !Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid sprite size rule: ${ruleStr}`);
  }
  return { mode, size };
}

function buildSpriteRuleMaps(spriteScale) {
  speciesRuleMap = {};
  for (const cat of Object.values(spriteScale.plantCategories)) {
    const rule = parseSizeRule(cat.rule);
    for (const pid of cat.ids) speciesRuleMap[pid] = rule;
  }
  decorRuleMap = {};
  for (const [did, ruleStr] of Object.entries(spriteScale.decorSizes)) {
    decorRuleMap[did] = parseSizeRule(ruleStr);
  }
}

function getSpriteRenderDims(spec, dims, spriteScaleConfig) {
  const { standardSpriteWidth = 220, tileWidth = 68.8, stageRatios = {} } = spriteScaleConfig || {};
  const uniformScale = tileWidth / standardSpriteWidth;
  const naturalW = dims.w || standardSpriteWidth;
  const naturalH = dims.h || standardSpriteWidth;
  const aspect = naturalW / naturalH;

  let ruleObj;
  let ratio = 1.0;

  if (spec.itemId) {
    ruleObj = decorRuleMap[spec.itemId];
  } else {
    ruleObj = speciesRuleMap[spec.speciesId];
    const sk = spec.stageKey || 'Lv5';
    ratio = stageRatios[sk] != null ? Number(stageRatios[sk]) : 1.0;
  }
  if (!ruleObj) throw new Error(`Missing sprite rule for ${spec.itemId || spec.speciesId}`);

  let renderW, renderH;
  if (ruleObj.mode === 'height') {
    renderH = ruleObj.size * ratio * uniformScale;
    renderW = renderH * aspect;
  } else {
    renderW = ruleObj.size * ratio * uniformScale;
    renderH = renderW / aspect;
  }

  return { renderW, renderH };
}

function getPlantSpriteSpec(sp, pState) {
  const st = pState.evalState || {};
  const stage = st.stage; // 'growing' | 'grown' | 'withering' | 'dead'
  const fileName = `${sp.id}_${sp.name}.png`;

  if (stage === 'grown') {
    const dir = st.isPerfect ? 'perfect' : 'Lv5';
    return { path: `./assets/plants/${dir}/${fileName}`, stageKey: dir, speciesId: sp.id };
  }

  const rawLv = st.level || calcPlantLevel(st.progress || 0, pState.requiredDays || sp.requiredDays);
  const lv = Math.min(4, Math.max(1, rawLv));

  if (stage === 'dead') {
    return { path: `./assets/plants/Lv${lv}_dead/${fileName}`, stageKey: `Lv${lv}_dead`, speciesId: sp.id };
  }
  if (stage === 'withering') {
    return { path: `./assets/plants/Lv${lv}_wilt/${fileName}`, stageKey: `Lv${lv}_wilt`, speciesId: sp.id };
  }
  return { path: `./assets/plants/Lv${lv}/${fileName}`, stageKey: `Lv${lv}`, speciesId: sp.id };
}

function getDecorSpriteSpec(itemId) {
  const fallback = { id: 'dec_lantern', name: '青苔石燈籠' };
  const dc = (store && store.decorMap && store.decorMap[itemId]) || fallback;
  return { path: `./assets/decor/${dc.id}_${dc.name}.png`, itemId: dc.id };
}

// 渲染單株植物預覽（用於彈窗詳情、開種子畫面與圖鑑卡片）
function renderPlantPreviewHTML(sp, fakePlantState) {
  const spec = getPlantSpriteSpec(sp, fakePlantState);
  return `<img src="${spec.path}?v=${ASSET_VER}" alt="${escapeHtml(sp.name)}" class="w-full h-full object-contain drop-shadow-sm"/>`;
}

// 計算立體浮空島上表面格子 (x, y) 對應到 SVG 舞台的座標
const BASE_GRID_N = 5;
const FIXED_CELL_W = 172 / BASE_GRID_N; // 34.4px
const FIXED_CELL_H = 91 / BASE_GRID_N;  // 18.2px

function gridCellToIslandCoord(x, y, N) {
  const islandScale = N / BASE_GRID_N;
  const u = (x + 0.5) / N;
  const v = (y + 0.5) / N;
  const halfW = 172 * islandScale;
  const halfH = 91 * islandScale;
  const centerY = -64 * islandScale;
  return {
    x: (u - v) * halfW,
    y: centerY + (u + v - 1.0) * halfH,
    cellW: FIXED_CELL_W,
    cellH: FIXED_CELL_H
  };
}

function getIslandTransform(pan, zoom) {
  const p = pan || { x: 0, y: 0 };
  const z = zoom || 1;
  return `translate(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) scale(${z.toFixed(3)})`;
}

const ISLAND_X_EDGE_PAD_PX = 20;
const ISLAND_BOT_PAD_PX = 84;
const ISLAND_FULL_TOP_PAD_PX = 44; // 最高樹冠（(0,0) 完美神木）距全螢幕上方橫幅留白

function clampIslandPan(containerEl, svgEl, px, py, z, { topPadPx = ISLAND_FULL_TOP_PAD_PX } = {}) {
  const cr = containerEl.getBoundingClientRect();
  const sr = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox.baseVal;
  if (!cr.width || !cr.height || !sr.width || !sr.height || !vb.width || !vb.height) {
    return { x: px, y: py };
  }

  const scale = Math.min(sr.width / vb.width, sr.height / vb.height);
  const vbCx = vb.x + vb.width / 2;
  const vbCy = vb.y + vb.height / 2;
  const halfStageW = (cr.width / 2) / scale;
  const halfStageH = (cr.height / 2) / scale;
  const stageTop = vbCy - halfStageH;
  const stageBottom = vbCy + halfStageH;

  const regionSize = lastIslandContext?.evalData?.region?.size || BASE_GRID_N;
  const islandScale = regionSize / BASE_GRID_N;
  const landHalfW = 210 * islandScale;
  const islandTop = -155 * islandScale - 62.3;
  const grassBottom = 27 * islandScale;

  // c & d：土地寬度 <= 視口寬度時一律水平置中；寬於視口時左右端點距螢幕邊界最多 ISLAND_X_EDGE_PAD_PX（過渡平滑無跳動）
  const overflowX = z * landHalfW - halfStageW;
  const maxPanX = overflowX <= 0 ? 0 : overflowX + Math.min(ISLAND_X_EDGE_PAD_PX / scale, overflowX);
  const rawX = Math.max(vbCx - maxPanX, Math.min(vbCx + maxPanX, px));
  const x = rawX === 0 ? 0 : rawX;

  // a：往下移動限制維持現狀 220 * max(1, z)
  const maxPy = 220 * Math.max(1, z);
  // b：往上移動不可碰到上方橫幅或隨筆區並保持恰當距離（若深度放大導致草地本身高於視口，允許上移至底部草地恰好進入視口）
  const minPyTop = (stageTop + topPadPx / scale) - z * islandTop;
  const minPyBot = (stageBottom - ISLAND_BOT_PAD_PX / scale) - z * grassBottom;
  const minPy = Math.min(0, Math.min(maxPy, Math.min(minPyTop, minPyBot)));
  const rawY = Math.max(minPy, Math.min(maxPy, py));
  const y = rawY === 0 ? 0 : rawY;

  return { x, y };
}

const HOME_VB_X = -215;
const HOME_VB_W = 430;
const HOME_VB_H = 450;

function alignHomeIslandViewBox(regionSize) {
  const homeCard = document.getElementById('home-garden-card');
  const homeSvg = document.getElementById('home-island-svg');
  const carousel = document.getElementById('essay-carousel');
  const pill = document.querySelector('#home-floating-info .sky-pill');
  if (!homeCard || !homeSvg || !carousel || !pill) return;

  const cr = homeCard.getBoundingClientRect();
  const sr = homeSvg.getBoundingClientRect();
  if (!cr.width || !cr.height || !sr.width || !sr.height) return;

  const scale = Math.min(sr.width / HOME_VB_W, sr.height / HOME_VB_H);
  const padBot = parseFloat(getComputedStyle(carousel).paddingBottom) || 0;
  const zoneTop = carousel.getBoundingClientRect().bottom - padBot;
  const zoneBottom = pill.getBoundingClientRect().top;
  const targetScreenY = (zoneTop + zoneBottom) / 2;
  const svgBaseCenterY = cr.top + cr.height / 2;

  const islandScale = (regionSize || BASE_GRID_N) / BASE_GRID_N;
  const islW = 420 * islandScale;
  const centerLocalY = -175 * islandScale + 0.3 * islW;

  const vbCy = centerLocalY - (targetScreenY - svgBaseCenterY) / scale;
  const vbY = vbCy - HOME_VB_H / 2;
  homeSvg.setAttribute('viewBox', `${HOME_VB_X} ${vbY.toFixed(1)} ${HOME_VB_W} ${HOME_VB_H}`);
}

const FULL_VB_X = -300;
const FULL_VB_W = 600;
const FULL_VB_H = 580;

// 5x5~9x9 島嶼底座已實體裁切去除底部無意義純透明空白
// 此處對應各尺寸在 SVG 幾何空間中的真實寬高
const ISLAND_DIMS = {
  5: { w: 420, h: 410 },
  6: { w: 504, h: 462 },
  7: { w: 588, h: 524 },
  8: { w: 672, h: 584 },
  9: { w: 756, h: 645 }
};

function alignFullIslandViewBox(regionSize) {
  const fullSvg = document.getElementById('full-island-svg');
  if (!fullSvg) return;
  const sr = fullSvg.getBoundingClientRect();
  if (!sr.width || !sr.height) return;

  const scale = Math.min(sr.width / FULL_VB_W, sr.height / FULL_VB_H);
  const winH = window.innerHeight;
  const navEl = document.getElementById('garden-bottom-nav');
  const navTop = navEl ? navEl.getBoundingClientRect().top : winH - 65;

  const N = Math.min(9, Math.max(5, regionSize || BASE_GRID_N));
  const dims = ISLAND_DIMS[N] || { w: 420 * (N / BASE_GRID_N), h: 410 * (N / BASE_GRID_N) };
  const islY = -175 * (N / BASE_GRID_N);
  const islH = dims.h;
  const bottomY = islY + islH;
  const centerY = islY + islH / 2;

  // 目標中心：對齊至視窗中心下方 50px（使用者原則：中心高度 = 視窗中心高度 + 50px）；底線：泥土尖端絕不插入最下方選單
  const targetScreenY = winH / 2 + 50;
  const svgBaseCenterY = sr.top + sr.height / 2;
  const vbCyTarget = centerY - (targetScreenY - svgBaseCenterY) / scale;
  const vbCyMin = bottomY - ((navTop - 12) - svgBaseCenterY) / scale;
  const vbCy = Math.max(vbCyTarget, vbCyMin);
  const vbY = vbCy - FULL_VB_H / 2;
  fullSvg.setAttribute('viewBox', `${FULL_VB_X} ${vbY.toFixed(1)} ${FULL_VB_W} ${FULL_VB_H}`);
}

function renderIsometricIsland(evalData, options = {}) {
  const { region, plantsWithState, decorList } = evalData;
  const N = region.size;
  const theme = region.theme || 'flowerbed';
  const isPlacing = Boolean(options.placingMode);
  const pan = options.pan || { x: 0, y: 0 };
  const zoom = options.zoom || 1;

  // 依當前尺寸 N 取得已裁切底座之幾何尺寸（寬度依照 N / 5 等比放大，高度為素材真實高度）
  const clampedN = Math.min(9, Math.max(5, N));
  const dims = ISLAND_DIMS[clampedN] || { w: 420 * (clampedN / BASE_GRID_N), h: 410 * (clampedN / BASE_GRID_N) };
  const islW = dims.w;
  const islH = dims.h;
  const islX = -islW / 2;
  const islY = -175 * (clampedN / BASE_GRID_N);

  // 1. 底層：載入已實體裁切之 2.5D 立體浮空島底座圖
  const svg = `
    <image href="./assets/islands/${theme}_${clampedN}x${clampedN}.png?v=${ASSET_VER}" x="${islX.toFixed(1)}" y="${islY.toFixed(1)}" width="${islW.toFixed(1)}" height="${islH.toFixed(1)}" preserveAspectRatio="none"/>`;

  // 2. 依設定檔 spriteScale 規格與等距網格動態換算渲染大小，再交由 computeNeighborAdjustedScales 處理相鄰等比縮小
  const { standardSpriteWidth, tileWidth, maxAdjacentTiles } = config.spriteScale;
  const maxAdjacentWidth = tileWidth * maxAdjacentTiles;

  const byCoord = new Map();
  const scaleInputs = [];
  const registerEntry = (x, y, spec) => {
    const key = `${Number(x)},${Number(y)}`;
    if (byCoord.has(key)) return;
    const dims = getSpriteDims(spec.path, standardSpriteWidth);
    const { renderW, renderH } = getSpriteRenderDims(spec, dims, config.spriteScale);
    byCoord.set(key, { spec, dims, width: renderW, height: renderH });
    scaleInputs.push({ key, x: Number(x), y: Number(y), width: renderW });
  };

  for (const p of plantsWithState) {
    const sp = store.speciesMap[p.speciesId] || catalog.species[0];
    registerEntry(p.x, p.y, getPlantSpriteSpec(sp, p));
  }
  for (const d of decorList) {
    registerEntry(d.x, d.y, getDecorSpriteSpec(d.itemId));
  }

  const effectiveWidths = computeNeighborAdjustedScales(scaleInputs, maxAdjacentWidth);

  // 3. 依畫家演算法 (x + y 由小到大) 排序繪製每格植物與裝飾
  const coords = [];
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) coords.push({ x, y });
  }
  coords.sort((a, b) => (a.x + a.y) - (b.x + b.y) || (a.x - a.y) - (b.x - b.y));

  let spritesLayer = '';
  let hitAndSlotsLayer = '';

  for (const { x, y } of coords) {
    const c = gridCellToIslandCoord(x, y, N);
    const key = `${x},${y}`;
    const entry = byCoord.get(key);
    const isOccupied = Boolean(entry);

    if (entry) {
      const w = effectiveWidths.get(key) || entry.width;
      const h = w * (entry.height / entry.width);
      const sx = c.x - w / 2;
      const sy = c.y - h * 0.80;
      spritesLayer += `<image href="${entry.spec.path}?v=${ASSET_VER}" x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" ${isPlacing ? 'opacity="0.38"' : ''} style="pointer-events:none;"/>`;
    }

    // 頂層（Top Layer）：空位光圈與菱形點擊感應區畫在所有植物的最上方，絕不被前排植物圖案遮擋！
    if (isPlacing && !isOccupied) {
      hitAndSlotsLayer += `
        <ellipse cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" rx="${(c.cellW * 0.58).toFixed(1)}" ry="${(c.cellH * 0.58).toFixed(1)}"
          fill="rgba(255,253,248,0.85)" stroke="#1d4237" stroke-width="1.8" stroke-dasharray="3 2" class="slot-pulse" style="pointer-events:none;"/>`;
    }

    if (options.interactive) {
      const hitScale = isPlacing ? 1.12 : 0.98;
      const pts = [
        `${c.x.toFixed(1)},${(c.y - c.cellH * hitScale).toFixed(1)}`,
        `${(c.x + c.cellW * hitScale).toFixed(1)},${c.y.toFixed(1)}`,
        `${c.x.toFixed(1)},${(c.y + c.cellH * hitScale).toFixed(1)}`,
        `${(c.x - c.cellW * hitScale).toFixed(1)},${c.y.toFixed(1)}`
      ].join(' ');
      hitAndSlotsLayer += `<polygon points="${pts}" fill="transparent" class="cursor-pointer hover:fill-white/30 transition" data-cell-x="${x}" data-cell-y="${y}"/>`;
    }
  }

  return `<g class="island-pan-layer" transform="${getIslandTransform(pan, zoom)}">${svg}${spritesLayer}${hitAndSlotsLayer}</g>`;
}

// ============================================================================
// 3. 主畫面與全螢幕花園渲染
// ============================================================================
function initStaticIcons() {
  document.getElementById('brand-logo-icon').innerHTML = icon('sprout', 'w-4 h-4');
  document.getElementById('btn-home-settings').innerHTML = icon('settings', 'w-4 h-4 text-[#2b5e4e]');
  document.getElementById('home-prev-month').innerHTML = icon('chevLeft', 'w-7 h-7');
  document.getElementById('home-next-month').innerHTML = icon('chevRight', 'w-7 h-7');
  document.getElementById('btn-enter-fullscreen-garden').innerHTML = `${icon('expand', 'w-3 h-3 text-[#2b5e4e]')}<span>佈置</span>`;

  document.getElementById('btn-back-home').innerHTML = `${icon('chevLeft', 'w-4 h-4')}<span>返回首頁</span>`;
  document.getElementById('btn-essays-back-home').innerHTML = icon('arrowLeft', 'w-4 h-4');
  document.getElementById('essays-prev-month').innerHTML = icon('chevLeft', 'w-4 h-4');
  document.getElementById('essays-next-month').innerHTML = icon('chevRight', 'w-4 h-4');
  document.getElementById('btn-garden-settings').innerHTML = icon('settings', 'w-4 h-4');
  document.getElementById('full-prev-month').innerHTML = icon('chevLeft', 'w-8 h-8');
  document.getElementById('full-next-month').innerHTML = icon('chevRight', 'w-8 h-8');

  document.getElementById('nav-btn-shop').innerHTML = `${icon('shop', 'w-5 h-5 text-[#c87119]')}<span>商店/擴地</span>`;
  document.getElementById('nav-btn-bag').innerHTML = `${icon('pouch', 'w-5 h-5 text-[#2b5e4e]')}<span>種子袋</span>`;
  document.getElementById('nav-btn-dex').innerHTML = `${icon('book', 'w-5 h-5 text-[#2b5e4e]')}<span>圖鑑</span>`;
  document.getElementById('nav-btn-album').innerHTML = `${icon('album', 'w-5 h-5 text-[#2b5e4e]')}<span>相簿</span>`;
  document.getElementById('nav-btn-group').innerHTML = `${icon('users', 'w-5 h-5 text-[#2b5e4e]')}<span>團體</span>`;
}

function formatEssayTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderEssayCardHtml(e, idx, { uid, user, todayKey, isGroup, compact = false }) {
  const isDemo = e.id === DEMO_ESSAY_ID || e.id === 'essay_welcome' || Boolean(e.isDemo);
  const isMine = !isDemo && e.authorUid === uid;
  const isToday = e.dayKey === todayKey;
  const isYesterday = e.dayKey === addDays(todayKey, -1);
  const subLabel = compact ? formatEssayTime(e.createdAt) : (isToday ? '今天' : (isYesterday ? '昨天' : e.dayKey.slice(5)));
  const resolvedAuthor = isDemo ? (e.authorName || '美地嚮導') : ((typeof store.getMemberDisplayName === 'function' && store.getMemberDisplayName(e.authorUid)) || e.authorName || '旅人');
  const authorLabel = isMine ? '我' : resolvedAuthor;
  const avatarChar = isDemo ? '美' : (Array.from((isMine ? user.displayName : resolvedAuthor) || authorLabel)[0] || '我');
  const avatarCls = isDemo
    ? 'bg-[#2b5e4e] text-[#fffdf8]'
    : (isMine ? 'bg-[#2b5e4e] text-[#fffdf8]' : 'bg-[#df8a2b]/20 text-[#9a5210] border border-[#df8a2b]/35');
  const { myReaction } = getEssayReactionSummary(e, uid);
  const footerRight = (isGroup && e.private)
    ? `<span class="text-[#786b5e]/80 shrink-0" title="私密隨筆">${icon('lock', 'w-3.5 h-3.5')}</span>`
    : `<button type="button" data-react-btn="${e.id}" data-active-reaction="${myReaction || ''}" aria-label="${escapeHtml(getReactionAriaLabel(e, uid))}" class="inline-flex items-center gap-0.5 shrink-0 py-0.5 -my-0.5 rounded-full transition">${renderReactionBtnInner(e, uid)}</button>`;
  const card = resolveEssayCardStyle(e);
  const sizeCls = compact
    ? 'w-[42%] min-w-[150px] h-[clamp(152px,23vh,198px)] pt-11 pb-2.5 px-[17px]'
    : 'w-[45%] h-[clamp(196px,31vh,264px)] card-float pt-12 pb-3.5 px-[17px]';
  const textCls = compact
    ? 'memo-text-compact text-xs text-[#382e26] leading-snug whitespace-pre-wrap break-words text-justify [text-align-last:left]'
    : 'memo-text text-[13px] text-[#382e26] leading-[1.48] whitespace-pre-wrap break-words text-justify [text-align-last:left]';
  const floatStyle = compact ? '' : `animation-delay:${(idx % 3) * 1.1}s`;

  return `
    <div role="button" tabindex="0" data-essay-id="${e.id}" style="${memoStyleAttr(card)}${floatStyle}" class="essay-card shrink-0 ${sizeCls} memo-note flex flex-col justify-between cursor-pointer active:scale-[0.98] transition">
      <div class="essay-text-wrap flex-1 w-full overflow-hidden min-h-0"><div class="${textCls}">${escapeHtml(e.content)}</div></div>
      <span class="flex items-center justify-between gap-1 w-full pt-1.5 mt-1 border-t border-[#d8cbb8]/55 text-xs">
        <span class="flex items-center gap-1 min-w-0">
          <span class="w-5 h-5 rounded-full ${avatarCls} text-xs font-bold flex items-center justify-center shrink-0">${escapeHtml(avatarChar)}</span>
          <span class="font-bold text-[11px] leading-tight ${!compact && isToday ? 'text-[#2b5e4e]' : 'text-[#382e26]'} truncate">${escapeHtml(authorLabel)}・${subLabel}</span>
        </span>
        ${footerRight}
      </span>
    </div>`;
}

function updateEssayCardLineClamps(containerEl = document) {
  const cards = containerEl?.querySelectorAll ? containerEl.querySelectorAll('.essay-card') : [];
  if (!cards || !cards.length) return;

  cards.forEach(cardEl => {
    const wrapEl = cardEl.querySelector('.essay-text-wrap');
    const textEl = cardEl.querySelector('.memo-text, .memo-text-compact');
    if (!wrapEl || !textEl) return;

    const textArea_h = wrapEl.clientHeight || wrapEl.getBoundingClientRect().height;
    if (textArea_h <= 0) return;

    const computedStyle = window.getComputedStyle(textEl);
    let line_h = parseFloat(computedStyle.lineHeight);
    if (!line_h || isNaN(line_h)) {
      const fontSize = parseFloat(computedStyle.fontSize) || 13;
      line_h = fontSize * 1.48;
    }

    // 隨筆卡文字區域高度 (textArea_h) 與行高 (line_h) 相除取高斯 (Math.floor)
    const lines = Math.floor(textArea_h / line_h);
    const maxLines = Math.max(1, lines);

    textEl.style.webkitLineClamp = String(maxLines);
    textEl.style.setProperty('-webkit-line-clamp', String(maxLines));
  });
}

function bindEssayCards(containerEl, essayById) {
  updateEssayCardLineClamps(containerEl);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => updateEssayCardLineClamps(containerEl));
  }
  if (typeof ResizeObserver !== 'undefined' && containerEl && !containerEl.__clampObserver) {
    containerEl.__clampObserver = new ResizeObserver(() => {
      updateEssayCardLineClamps(containerEl);
    });
    containerEl.__clampObserver.observe(containerEl);
  }

  containerEl.querySelectorAll('.essay-card').forEach(cardEl => {
    const target = essayById.get(cardEl.dataset.essayId);
    const reactBtn = cardEl.querySelector('[data-react-btn]');
    if (reactBtn && target) bindReactionTrigger(reactBtn, target);

    const openCardModal = () => {
      if (!target) return;
      closeReactionTray();
      ui.activeModal = 'read_essay';
      ui.modalData = target;
      renderModal();
    };
    cardEl.onclick = (ev) => {
      if (
        ui.carouselDidDrag ||
        (Date.now() < ui.suppressCardClickUntil && ui.suppressCardId === cardEl.dataset.essayId) ||
        ev.target.closest('[data-react-btn]')
      ) return;
      openCardModal();
    };
    cardEl.onkeydown = (ev) => {
      if (ev.target !== cardEl) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openCardModal();
      }
    };
  });
}

function renderApp() {
  const uid = store.state.currentUserId;
  const user = store.state.users[uid];
  const activeGarden = store.currentGarden();

  // 檢查換月與團體投票
  const monthTransition = store.checkMonthTransition();
  if (monthTransition?.needsPersonalThemePick && ui.activeModal !== 'theme_picker') {
    ui.activeModal = 'theme_picker';
    ui.modalData = { month: monthTransition.month, mode: 'new_month' };
  } else if (monthTransition?.autoResolvedGroupTheme) {
    const tName = catalog.themes[monthTransition.autoResolvedGroupTheme]?.name;
    showToast(`新月份開始！團體區域已定案為「${tName}」`);
  }

  // 取得依時間排序的所有月份區域清單，供左右箭頭切換
  const orderedRegions = store.getOrderedRegionsList();
  let curIdx = orderedRegions.findIndex(
    x => x.gardenId === (ui.viewingGardenId || activeGarden.id) &&
         x.region.id === (ui.viewingRegionId || activeGarden.activeRegionId)
  );
  if (curIdx === -1) curIdx = orderedRegions.length - 1;

  const currentViewItem = orderedRegions[curIdx] || {
    gardenId: activeGarden.id,
    gardenName: activeGarden.name,
    ...store.getEvaluatedRegion(activeGarden.id, activeGarden.activeRegionId)
  };
  const viewGarden = store.state.gardens[currentViewItem.gardenId] || activeGarden;
  const evalData = currentViewItem;

  const hasPrevMonth = curIdx > 0;
  const hasNextMonth = curIdx < orderedRegions.length - 1;
  const stepMonth = (delta) => {
    const target = orderedRegions[curIdx + delta];
    if (!target) return;
    closeReactionTray();
    ui.viewingGardenId = target.gardenId;
    ui.viewingRegionId = target.region.id;
    ui.placingMode = null;
    resetGardenView();
    renderApp();
  };

  const todayKey = store.currentDayKey(activeGarden);
  const gardenDay = activeGarden.days[todayKey] || { seedsGiven: 0, writers: {} };
  const bagCount = Object.values(user.seeds).reduce((a, b) => a + b, 0);
  const mult = store.getCurrentUserMultiplier();

  const themeInfo = catalog.themes[evalData.region.theme] || catalog.themes.flowerbed;
  document.body.dataset.theme = evalData.region.theme || 'flowerbed';
  const grownCount = evalData.plantsWithState.filter(p => p.evalState.stage === 'grown').length;
  const growingCount = evalData.plantsWithState.filter(p => p.evalState.stage === 'growing').length;
  const isArchived = evalData.region.status === 'archived' || evalData.region.status === 'snapshot';
  const statusBadge = isArchived ? '已封存' : '經營中';

  // 1. 優先提示條
  const banner = store.getPriorityBanner();
  const bannerEl = document.getElementById('priority-banner');
  if (banner) {
    bannerEl.classList.remove('hidden');
    bannerEl.textContent = banner.text;
    bannerEl.onclick = () => {
      if (banner.action === 'makeup') handleMakeUpClick();
      else if (banner.action === 'open_group') {
        ui.screen = 'garden';
        ui.activeModal = 'group';
        renderApp();
      } else {
        openEditorModal();
      }
    };
  } else {
    bannerEl.classList.add('hidden');
  }

  // 2. 切換首頁、所有隨筆頁與全螢幕花園
  const isGroup = activeGarden.type === 'group';
  document.getElementById('screen-home').classList.toggle('hidden', ui.screen !== 'home');
  document.getElementById('screen-essays').classList.toggle('hidden', ui.screen !== 'essays');
  document.getElementById('screen-garden').classList.toggle('hidden', ui.screen !== 'garden');

  const appContainer = document.getElementById('app-container');
  if (appContainer) appContainer.setAttribute('data-screen', ui.screen);
  document.body.setAttribute('data-screen', ui.screen);
  if (bgManager && typeof bgManager.setScreen === 'function') {
    bgManager.setScreen(ui.screen);
  }

  if (ui.screen === 'home') {
    const seedsGiven = gardenDay.seedsGiven || 0;
    const seedsLeft = Math.max(0, config.dailySeedCap - seedsGiven);
    const composerPrompt = seedsLeft > 0
      ? (isGroup ? `寫給團體隨筆⋯滿 ${config.minWords} 字抽種子` : `寫下今日隨筆⋯滿 ${config.minWords} 字抽種子`)
      : '種子已滿，再寫仍可轉為能量⋯';
    const composerBadgeCls = seedsLeft > 0
      ? 'bg-[#2b5e4e]/10 text-[#1d4237]'
      : 'bg-amber-50 text-[#c87119] border border-amber-200/80';

    const composerBtn = document.getElementById('btn-write-composer');
    composerBtn.innerHTML = `
      <span class="w-8 h-8 rounded-full bg-[#2b5e4e] text-[#fde68a] flex items-center justify-center shrink-0 shadow-sm">
        ${icon('quill', 'w-4 h-4')}
      </span>
      <span class="flex-1 min-w-0 rounded-full bg-[#f6f0e4] border border-[#e5dec9] px-3 py-1.5 text-xs text-[#786b5e] truncate">
        ${composerPrompt}
      </span>
      <span class="shrink-0 text-xs font-bold px-2.5 py-1 rounded-full ${composerBadgeCls}">
        ${isGroup ? '團體' : '個人'} ${seedsGiven}/${config.dailySeedCap}
      </span>`;
    composerBtn.onclick = () => openEditorModal();

    const carousel = document.getElementById('essay-carousel');
    const allEssays = store.getCarouselEssays();
    const homeEssays = allEssays.slice(0, config.homeEssayLimit);
    const essayById = new Map(homeEssays.map(e => [e.id, e]));

    let cardsHtml = '';
    if (allEssays.length === 0) {
      cardsHtml = `
        <button type="button" data-empty-write="1" class="w-full h-[clamp(196px,31vh,264px)] rounded-2xl sky-card border-dashed border-[#628b78]/50 px-4 flex flex-col items-center justify-center gap-1.5 text-center hover:bg-[#fffdf8]/95 transition">
          ${icon('sprout', 'w-5 h-5 text-[#2b5e4e]')}
          <span class="text-xs font-bold text-[#1d4237]">還沒有隨筆紀錄</span>
          <span class="text-xs text-[#786b5e]">點擊上方輸入框寫下今天的第一篇隨筆吧</span>
        </button>`;
    } else {
      cardsHtml = homeEssays.map((e, idx) => renderEssayCardHtml(e, idx, { uid, user, todayKey, isGroup, compact: false })).join('');
      if (allEssays.length > config.homeEssayLimit) {
        cardsHtml += `
          <button type="button" id="btn-all-essays-tail" data-all-essays-tail="1" class="shrink-0 w-[34%] h-[clamp(196px,31vh,264px)] sky-card rounded-2xl border-dashed border-[#2b5e4e]/45 px-2.5 flex flex-col items-center justify-center gap-2 text-center hover:bg-[#fffdf8]/95 cursor-pointer">
            <span data-tail-arrow class="w-9 h-9 rounded-full bg-[#2b5e4e]/12 text-[#2b5e4e] flex items-center justify-center transition-colors">${icon('arrowLeft', 'w-4 h-4')}</span>
            <span data-tail-label class="text-xs font-bold text-[#1d4237] leading-snug">向左滑動<br/>查看全部</span>
            <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#f6f0e4] text-[#5c5046] border border-[#e5dec9]">共 ${allEssays.length} 則</span>
          </button>`;
      }
    }
    carousel.innerHTML = cardsHtml;

    const emptyWriteBtn = carousel.querySelector('[data-empty-write]');
    if (emptyWriteBtn) emptyWriteBtn.onclick = () => openEditorModal();
    const tailBtn = carousel.querySelector('[data-all-essays-tail]');
    if (tailBtn) {
      tailBtn.onclick = () => {
        if (ui.carouselDidDrag) return;
        openAllEssaysScreen();
      };
    }
    bindEssayCards(carousel, essayById);

    // 頂部精簡狀態膠囊（自製 SVG 圖標）
    const streakEl = document.getElementById('home-stat-streak');
    const energyEl = document.getElementById('home-stat-energy');
    const bagEl = document.getElementById('home-stat-bag');
    streakEl.innerHTML = `${icon('flame', 'w-3.5 h-3.5')}<span>${user.streak.count}天${mult > 1 ? `×${mult}` : ''}</span>`;
    streakEl.title = `連續 ${user.streak.count} 天 (×${mult})`;
    energyEl.innerHTML = `${icon('bolt', 'w-3.5 h-3.5')}<span>${user.energy}</span>`;
    energyEl.title = `能量 ${user.energy}`;
    bagEl.innerHTML = `${icon('pouch', 'w-3.5 h-3.5')}<span>${bagCount}/${config.seedBagCap}</span>`;
    bagEl.title = `種子袋 ${bagCount}/${config.seedBagCap}`;

    // 左右月份切換與下方資訊
    const homePrevBtn = document.getElementById('home-prev-month');
    const homeNextBtn = document.getElementById('home-next-month');
    homePrevBtn.disabled = !hasPrevMonth;
    homeNextBtn.disabled = !hasNextMonth;
    homePrevBtn.onclick = () => stepMonth(-1);
    homeNextBtn.onclick = () => stepMonth(1);

    document.getElementById('home-region-month-title').textContent = `${evalData.region.month} ・ ${themeInfo.name}`;
    document.getElementById('home-region-status-tag').textContent = statusBadge;
    document.getElementById('home-region-subinfo').innerHTML = `
      <span class="inline-flex items-center gap-1">${icon('sparkles', 'w-3.5 h-3.5 text-[#df8a2b]')}美觀度 ${evalData.beauty}</span>
      <span>・</span>
      <span>長成 ${grownCount}</span>
      <span>・</span>
      <span>成長中 ${growingCount}</span>`;

    renderActiveIslandSvg(viewGarden, evalData);
  } else if (ui.screen === 'essays') {
    const animMode = ui.essaysAnim;
    ui.essaysAnim = null;
    const essaysHeader = document.querySelector('#screen-essays > header');
    essaysHeader.classList.remove('essays-header-in');
    if (animMode === 'enter') {
      void essaysHeader.offsetWidth;
      essaysHeader.classList.add('essays-header-in');
    }

    const allEssays = store.getCarouselEssays();
    const todayMonth = todayKey.slice(0, 7);
    const regionMonths = store.getOrderedRegionsList().map(r => r.region?.month).filter(Boolean);
    const knownMonths = [...allEssays.map(e => e.dayKey.slice(0, 7)), ...regionMonths];
    if (ui.viewingEssayMonth) knownMonths.push(ui.viewingEssayMonth);
    knownMonths.sort();
    let minMonth = knownMonths.length > 0 && knownMonths[0] < todayMonth ? knownMonths[0] : todayMonth;
    if (store.isCloud && store.state.hasMoreEssayHistory) {
      const [my, mm] = minMonth.split('-').map(Number);
      const prevM = mm === 1 ? `${my - 1}-12` : `${my}-${String(mm - 1).padStart(2, '0')}`;
      if (prevM < minMonth) minMonth = prevM;
    }
    const maxMonth = knownMonths.length > 0 && knownMonths[knownMonths.length - 1] > todayMonth ? knownMonths[knownMonths.length - 1] : todayMonth;
    const months = [];
    let [cy, cm] = minMonth.split('-').map(Number);
    const [ey, em] = maxMonth.split('-').map(Number);
    while (cy < ey || (cy === ey && cm <= em)) {
      months.push(`${cy}-${String(cm).padStart(2, '0')}`);
      cm++;
      if (cm > 12) { cm = 1; cy++; }
    }
    let monthIdx = ui.viewingEssayMonth ? months.indexOf(ui.viewingEssayMonth) : -1;
    if (monthIdx === -1) monthIdx = months.length - 1;
    const activeMonth = months[monthIdx];
    ui.viewingEssayMonth = activeMonth;

    if (
      store.isCloud &&
      typeof store.ensureEssayMonthLoaded === 'function' &&
      !store.state.loadedEssayMonths?.[activeMonth] &&
      !loadingEssayMonths.has(activeMonth)
    ) {
      loadingEssayMonths.add(activeMonth);
      store.ensureEssayMonthLoaded(activeMonth)
        .then(() => {
          loadingEssayMonths.delete(activeMonth);
          if (ui.screen === 'essays') renderApp();
        })
        .catch((err) => {
          loadingEssayMonths.delete(activeMonth);
          showToast(err?.message || '載入歷史月份隨筆失敗');
        });
    }

    const [yearStr, monthStr] = activeMonth.split('-');
    document.getElementById('essays-month-title').textContent = `${yearStr}年${monthStr}月 所有隨筆`;

    const listEl = document.getElementById('essays-day-list');
    const prevBtn = document.getElementById('essays-prev-month');
    const nextBtn = document.getElementById('essays-next-month');
    prevBtn.disabled = monthIdx <= 0;
    nextBtn.disabled = monthIdx >= months.length - 1;
    const stepEssayMonth = (delta) => {
      const target = months[monthIdx + delta];
      if (!target) return;
      closeReactionTray();
      clearEssaysTransition();
      ui.viewingEssayMonth = target;
      ui.essaysAnim = 'month';
      renderApp();
      listEl.scrollTop = 0;
    };
    prevBtn.onclick = () => stepEssayMonth(-1);
    nextBtn.onclick = () => stepEssayMonth(1);

    const monthEssays = allEssays.filter(e => e.dayKey.slice(0, 7) === activeMonth);
    const essayById = new Map(monthEssays.map(e => [e.id, e]));
    const byDay = new Map();
    for (const e of monthEssays) {
      if (!byDay.has(e.dayKey)) byDay.set(e.dayKey, []);
      byDay.get(e.dayKey).push(e);
    }
    const dayGroups = Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    const yesterdayKey = addDays(todayKey, -1);

    document.getElementById('essays-total-subtitle').textContent = `共 ${monthEssays.length} 則・${dayGroups.length} 天`;
    const prevScroll = listEl.scrollTop;

    if (dayGroups.length === 0) {
      listEl.innerHTML = `<div class="py-16 flex justify-center"><span class="sky-pill rounded-full px-4 py-1.5 text-xs font-bold text-[#1d4237]">本月沒有隨筆紀錄</span></div>`;
    } else {
      const shouldFly = animMode === 'enter' || animMode === 'month';
      listEl.innerHTML = dayGroups.map(([dayKey, items], rowIdx) => {
        items.sort((a, b) => b.createdAt - a.createdAt);
        const dayTitle = dayKey === todayKey
          ? `今天・${dayKey.slice(5)}`
          : (dayKey === yesterdayKey ? `昨天・${dayKey.slice(5)}` : dayKey);
        const flyCls = shouldFly ? ' essay-row-fly-in' : '';
        const k = Math.min(rowIdx, 4);
        const flyStyle = shouldFly ? ` style="--row-delay:${40 * k + 24 * k * k}ms"` : '';
        return `
          <section data-essay-day-row="${dayKey}"${flyStyle} class="space-y-1.5${flyCls}">
            <div class="flex items-center justify-between text-xs px-0.5">
              <span class="font-extrabold text-[#1d4237] sky-pill rounded-full px-2.5 py-0.5">${dayTitle}</span>
              <span class="font-semibold text-[#5c5046]">${items.length} 則</span>
            </div>
            <div class="essay-scroll-row essay-day-row flex items-stretch gap-2.5 overflow-x-auto no-scrollbar -mx-4 px-4 py-1 cursor-grab">
              ${items.map((e, idx) => renderEssayCardHtml(e, idx, { uid, user, todayKey, isGroup, compact: true })).join('')}
            </div>
          </section>`;
      }).join('');
      bindEssayCards(listEl, essayById);
    }
    listEl.scrollTop = prevScroll;
  } else {
    // 渲染全螢幕花園
    document.getElementById('garden-header-title').textContent = viewGarden.name;
    document.getElementById('garden-header-energy').innerHTML = `${icon('bolt', 'w-3.5 h-3.5')}<span>${user.energy}</span>`;
    document.getElementById('garden-header-bag').innerHTML = `${icon('pouch', 'w-3.5 h-3.5')}<span>種子袋 ${bagCount}/${config.seedBagCap}</span>`;

    const fullPrevBtn = document.getElementById('full-prev-month');
    const fullNextBtn = document.getElementById('full-next-month');
    fullPrevBtn.disabled = !hasPrevMonth;
    fullNextBtn.disabled = !hasNextMonth;
    fullPrevBtn.onclick = () => stepMonth(-1);
    fullNextBtn.onclick = () => stepMonth(1);

    document.getElementById('full-region-month-title').textContent = `${evalData.region.month} ・ ${themeInfo.name}`;
    const fullBadgeEl = document.getElementById('full-region-badge');
    if (fullBadgeEl) {
      fullBadgeEl.textContent = statusBadge;
      fullBadgeEl.className = `absolute right-0 top-1/2 -translate-y-1/2 text-xs px-2 py-0.5 rounded-full font-semibold ${isArchived ? 'bg-[#2b5e4e]/15 text-[#1d4237]' : 'bg-[#2b5e4e] text-[#fffdf8]'}`;
    }
    const fullTipEl = document.getElementById('full-region-tip');
    if (fullTipEl) {
      fullTipEl.classList.toggle('hidden', isArchived);
    }
    document.getElementById('full-region-subinfo').innerHTML = `
      <span class="inline-flex items-center gap-1 shrink-0 whitespace-nowrap">${icon('sparkles', 'w-3.5 h-3.5 text-[#df8a2b]')}美觀度 ${evalData.beauty}</span>
      <span class="text-[#a89f91] shrink-0">・</span>
      <span class="shrink-0 whitespace-nowrap">${evalData.region.size}×${evalData.region.size} 格</span>
      <span class="text-[#a89f91] shrink-0">・</span>
      <span class="shrink-0 whitespace-nowrap">已長成 ${grownCount} 株 / 成長中 ${growingCount} 株</span>`;

    const placeBar = document.getElementById('placing-banner');
    if (ui.placingMode) {
      placeBar.classList.remove('hidden');
      document.getElementById('placing-text').textContent = ui.placingMode.label;
    } else {
      placeBar.classList.add('hidden');
    }

    renderGardenBgSelectorBar();

    renderActiveIslandSvg(viewGarden, evalData);
  }

  renderModal();
}

function renderGardenBgSelectorBar() {
  const bar = document.getElementById('garden-bg-selector-bar');
  if (!bar) return;
  if (ui.screen !== 'garden') {
    bar.classList.add('hidden');
    return;
  }

  const unlocked = store.getUnlockedBgThemes ? store.getUnlockedBgThemes() : ['morning'];
  if (!unlocked || unlocked.length <= 1) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  const catalog = bgManager.getThemeCatalog();
  const currentActive = store.getActiveBgTheme ? store.getActiveBgTheme() : 'morning';

  bar.innerHTML = unlocked.map(tid => {
    const item = catalog.find(t => t.id === tid);
    if (!item) return '';
    const isActive = item.id === currentActive;
    return `
      <button type="button" data-switch-bg="${item.id}"
              class="relative flex items-center gap-1.5 px-2.5 py-1 rounded-2xl transition-all ${
                isActive
                  ? 'bg-white/95 text-[#1d4237] shadow-md ring-2 ring-[#2b5e4e] scale-105 font-extrabold'
                  : 'bg-white/60 hover:bg-white/85 text-[#5c5046] font-semibold'
              } backdrop-blur">
        <div class="w-6 h-6 rounded-lg overflow-hidden shrink-0 shadow-sm border border-white/40">
          ${item.thumbSvg}
        </div>
        <span class="text-xs whitespace-nowrap">${item.name}</span>
        ${isActive ? '<span class="w-1.5 h-1.5 rounded-full bg-[#2b5e4e]"></span>' : ''}
      </button>
    `;
  }).join('');

  bar.querySelectorAll('[data-switch-bg]').forEach(btn => {
    btn.onclick = () => {
      const tid = btn.dataset.switchBg;
      if (store.setBgTheme) store.setBgTheme(tid);
      else bgManager.setTheme(tid);
      renderGardenBgSelectorBar();
    };
  });
}

function renderActiveIslandSvg(viewGarden, evalData) {
  lastIslandContext = { viewGarden, evalData };
  if (ui.screen === 'home') {
    const homeSvg = document.getElementById('home-island-svg');
    alignHomeIslandViewBox(evalData.region.size);
    homeSvg.innerHTML = renderIsometricIsland(evalData, { interactive: false, placingMode: false, pan: { x: 0, y: 0 }, zoom: 1 });
    requestAnimationFrame(() => {
      if (ui.screen === 'home' && lastIslandContext) {
        alignHomeIslandViewBox(lastIslandContext.evalData.region.size);
      }
    });
    return;
  }
  const fullVp = document.getElementById('full-garden-viewport');
  const fullSvg = document.getElementById('full-island-svg');
  alignFullIslandViewBox(evalData.region.size);
  ui.pan = clampIslandPan(fullVp, fullSvg, ui.pan.x, ui.pan.y, ui.zoom, { topPadPx: ISLAND_FULL_TOP_PAD_PX });
  fullSvg.innerHTML = renderIsometricIsland(evalData, { interactive: true, placingMode: Boolean(ui.placingMode), pan: ui.pan, zoom: ui.zoom });
  requestAnimationFrame(() => {
    if (ui.screen === 'garden' && lastIslandContext) {
      alignFullIslandViewBox(lastIslandContext.evalData.region.size);
    }
  });
}

function handleGardenCellClick(gardenId, evalData, x, y) {
  const { region, plantsWithState, decorList } = evalData;

  if (ui.placingMode) {
    const mode = ui.placingMode;
    runLockedAction(null, null, async () => {
      if (mode.type === 'seed' || mode.type === 'limited') {
        await store.plantSeed(mode.id, x, y, mode.type === 'limited');
        showToast('成功種下幼苗！寫隨筆即可推進成長天數');
      } else if (mode.type === 'decor') {
        await store.buyAndPlaceDecor(gardenId, region.id, mode.id, x, y);
        showToast('裝飾擺放完成！');
      } else if (mode.type === 'move') {
        await store.moveGridItem(gardenId, region.id, mode.kind, mode.id, x, y);
        showToast('已移動至新位置');
      }
      ui.placingMode = null;
      renderApp();
    });
    return;
  }

  const plant = plantsWithState.find(p => p.x === x && p.y === y);
  if (plant) {
    ui.activeModal = 'plant_detail';
    ui.modalData = { gardenId, regionId: region.id, regionStatus: region.status, plant };
    renderModal();
    return;
  }

  const dec = decorList.find(d => d.x === x && d.y === y);
  if (dec) {
    ui.activeModal = 'decor_detail';
    ui.modalData = { gardenId, regionId: region.id, regionStatus: region.status, decor: dec };
    renderModal();
    return;
  }

  if (region.status === 'snapshot') {
    showToast('唯讀快照無法修改');
    return;
  }
  ui.activeModal = 'cell_picker';
  ui.modalData = { gardenId, regionId: region.id, regionStatus: region.status, x, y };
  renderModal();
}

function openEditorModal() {
  if (store && typeof store.ping === 'function') {
    store.ping();
  }
  ui.activeModal = 'editor';
  ui.modalData = null;
  renderModal();
}

function handleMakeUpClick(e) {
  const btnEl = e && e.currentTarget ? e.currentTarget : null;
  runLockedAction(btnEl, '補寫中...', async () => {
    const newStreak = await store.makeUpYesterday();
    showToast(`已花 ${config.makeUpCost} 能量補簽昨天！連續天數恢復為 ${newStreak.count} 天`);
    renderApp();
  });
}

// ============================================================================
// 4. 彈窗（Modal）渲染器
// ============================================================================
function renderModal() {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  if (!ui.activeModal) {
    closeReactionTray();
    overlay.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  overlay.classList.remove('hidden');

  const uid = store.state.currentUserId;
  const user = store.state.users[uid];
  const garden = store.currentGarden();

  // 0. 雲端單一帳密登入／自動建帳彈窗（無獨立註冊頁，重複帳號視為登入）
  if (ui.activeModal === 'auth') {
    box.innerHTML = `
      <form id="auth-form" class="space-y-3.5 text-xs">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl bg-[#2b5e4e] text-[#fffdf8] flex items-center justify-center shadow-sm">${icon('sprout', 'w-4 h-4')}</div>
          <div>
            <h3 class="font-extrabold text-base text-[#1d4237]">進入隨筆花園</h3>
            <p class="text-[#786b5e]">首次輸入新帳號即自動建立花園；輸入既有帳號則直接登入並永久保持登入狀態</p>
          </div>
        </div>

        <div class="space-y-2.5 bg-[#f6f0e4] p-3.5 rounded-2xl border border-[#e5dec9]">
          <div class="space-y-1">
            <label for="inp-auth-username" class="font-bold text-[#1d4237] block">帳號（2～24 字元，不可含空白）</label>
            <input id="inp-auth-username" type="text" autocomplete="username" placeholder="輸入你的帳號名稱" class="w-full rounded-xl border border-[#e5dec9] bg-white px-3 py-2 text-xs text-[#382e26] focus:outline-none focus:border-[#2b5e4e]"/>
          </div>
          <div class="space-y-1">
            <label for="inp-auth-password" class="font-bold text-[#1d4237] block">密碼（至少 4 字元）</label>
            <input id="inp-auth-password" type="password" autocomplete="current-password" placeholder="輸入密碼" class="w-full rounded-xl border border-[#e5dec9] bg-white px-3 py-2 text-xs text-[#382e26] focus:outline-none focus:border-[#2b5e4e]"/>
          </div>
          <div id="auth-error-msg" class="hidden text-rose-700 font-semibold pt-0.5"></div>
        </div>

        <button type="submit" id="btn-auth-submit" class="w-full py-2.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] text-sm font-bold shadow-sm hover:bg-[#1d4237] transition">進入花園</button>
      </form>`;

    const formEl = document.getElementById('auth-form');
    const userInp = document.getElementById('inp-auth-username');
    const passInp = document.getElementById('inp-auth-password');
    const errEl = document.getElementById('auth-error-msg');
    const submitBtn = document.getElementById('btn-auth-submit');

    formEl.onsubmit = async (ev) => {
      ev.preventDefault();
      const uname = userInp.value.trim();
      const pw = passInp.value;
      if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
      }
      if (pendingWriteLock || submitBtn.disabled) return;
      pendingWriteLock = true;
      const origHtml = submitBtn.innerHTML;
      submitBtn.disabled = true;
      submitBtn.textContent = '連線進入中...';
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
        const res = await store.authenticate(uname, pw, tz);
        ui.activeModal = null;
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.viewingEssayMonth = null;
        showToast(res.isNewUser ? `歡迎來到隨筆花園，${store.currentUser().displayName}！` : `歡迎回來，${store.currentUser().displayName}！`);
        renderApp();
      } catch (err) {
        const msg = err?.message || '帳號或密碼驗證失敗';
        if (errEl) {
          errEl.textContent = msg;
          errEl.classList.remove('hidden');
        }
        showToast(msg);
      } finally {
        pendingWriteLock = false;
        if (submitBtn && submitBtn.isConnected) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = origHtml;
        }
      }
    };
    return;
  }

  // 1. 全螢幕寫作編輯器
  if (ui.activeModal === 'editor') {
    const isGroup = garden.type === 'group';
    const makeUp = store.canMakeUpYesterday();
    let selectedCardId = getDefaultCardStyle(user);
    const initCard = CARD_STYLE_MAP[selectedCardId];
    box.innerHTML = `
      <div class="space-y-3 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <h3 class="font-bold text-base text-[#1d4237] flex items-center gap-1.5">${icon('quill', 'w-4 h-4')}<span>撰寫今日隨筆</span></h3>
          <button type="button" id="modal-close" class="text-[#786b5e] hover:text-[#382e26] text-xs font-semibold px-2 py-1">關閉</button>
        </div>
        ${makeUp.available ? `
          <div class="p-2.5 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-between text-xs text-amber-900">
            <span>昨天尚未寫隨筆！建議先補寫昨天以保住連續倍率與植物</span>
            <button type="button" id="btn-editor-makeup" class="px-3 py-1 rounded-xl bg-[#df8a2b] text-white font-semibold shrink-0 ml-2">補寫 (${makeUp.cost} 能量)</button>
          </div>` : ''}
        ${renderCardPickerHtml(selectedCardId)}
        <div id="editor-memo-wrap" class="memo-note w-full pt-[26%] pb-[11%] px-[17px]" style="${memoStyleAttr(initCard)}">
          <textarea id="essay-input" rows="4" placeholder="寫下今天的隨筆想法（至少 10 字即可獲得種子，字數越多稀有度越高）..." class="w-full bg-transparent text-sm text-[#382e26] leading-relaxed resize-none focus:outline-none select-text text-justify [text-align-last:left]"></textarea>
        </div>

        <div class="bg-[#f6f0e4] rounded-2xl p-3 space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span id="live-word-count" class="font-bold text-[#1d4237]">目前字數：0 字（需滿 10 字）</span>
            <span class="text-[#786b5e]">保底累積：${user.pity} / ${config.pityThreshold}</span>
          </div>
          <div class="w-full h-2.5 rounded-full overflow-hidden flex bg-[#e5dec9]" id="prob-bar">
            <div class="bg-stone-400 h-full" style="width:80%"></div>
            <div class="bg-sky-500 h-full" style="width:17%"></div>
            <div class="bg-purple-500 h-full" style="width:3%"></div>
            <div class="bg-amber-400 h-full" style="width:0%"></div>
          </div>
          <div class="grid grid-cols-4 gap-1 text-center text-[#5c5046]" id="prob-labels">
            <span>普通 80.0%</span>
            <span class="text-sky-700">稀有 17.0%</span>
            <span class="text-purple-700">史詩 3.0%</span>
            <span class="text-amber-700">傳說 0.0%</span>
          </div>
        </div>

        <div class="flex items-center ${isGroup ? 'justify-between' : 'justify-end'} pt-1">
          ${isGroup ? `
            <label class="flex items-center gap-2 text-xs text-[#5c5046] cursor-pointer select-none">
              <input type="checkbox" id="essay-private" class="rounded text-[#2b5e4e]"/>
              <span class="inline-flex items-center gap-1">${icon('lock', 'w-3.5 h-3.5')}設為私密隨筆（僅自己可見）</span>
            </label>` : ''}
          <button type="button" id="btn-submit-essay" class="px-5 py-2 rounded-xl bg-[#2b5e4e] text-[#fffdf8] text-sm font-bold shadow-sm hover:bg-[#1d4237] transition">完成結算</button>
        </div>
      </div>`;

    bindCardPicker(box, document.getElementById('editor-memo-wrap'), selectedCardId, (id) => {
      selectedCardId = id;
      savePreferredCardStyle(id);
    });

    const input = document.getElementById('essay-input');
    input.addEventListener('input', () => {
      const w = countEssayWords(input.value);
      document.getElementById('live-word-count').textContent = w < config.minWords
        ? `目前字數：${w} 字（還差 ${config.minWords - w} 字）`
        : `目前字數：${w} 字（可獲得種子！）`;
      const probs = getRarityProbabilities(Math.max(w, config.minWords), config);
      document.getElementById('prob-bar').innerHTML = `
        <div class="bg-stone-400 h-full transition-all" style="width:${probs.common.toFixed(1)}%"></div>
        <div class="bg-sky-500 h-full transition-all" style="width:${probs.rare.toFixed(1)}%"></div>
        <div class="bg-purple-500 h-full transition-all" style="width:${probs.epic.toFixed(1)}%"></div>
        <div class="bg-amber-400 h-full transition-all" style="width:${probs.legendary.toFixed(1)}%"></div>`;
      document.getElementById('prob-labels').innerHTML = `
        <span>普通 ${probs.common.toFixed(1)}%</span>
        <span class="text-sky-700 font-semibold">稀有 ${probs.rare.toFixed(1)}%</span>
        <span class="text-purple-700 font-semibold">史詩 ${probs.epic.toFixed(1)}%</span>
        <span class="text-amber-700 font-bold">傳說 ${probs.legendary.toFixed(1)}%</span>`;
    });

    const makeUpBtn = document.getElementById('btn-editor-makeup');
    if (makeUpBtn) makeUpBtn.onclick = handleMakeUpClick;

    const submitBtn = document.getElementById('btn-submit-essay');
    submitBtn.onclick = () => {
      const priv = isGroup ? document.getElementById('essay-private').checked : true;
      savePreferredCardStyle(selectedCardId);
      runLockedAction(submitBtn, '結算中...', async () => {
        const { result } = await store.submitEssay(input.value, priv, uid, selectedCardId);
        ui.activeModal = 'reward';
        ui.modalData = result;
        renderApp();
      });
    };
    bindCloseModal();
    return;
  }

  // 2. 完成隨筆後的開種子與能量結算畫面
  if (ui.activeModal === 'reward') {
    const r = ui.modalData;
    const sp = r.seedSpeciesId ? store.speciesMap[r.seedSpeciesId] : null;
    const rarityBadge = {
      common: { label: '普通', cls: 'bg-stone-100 text-stone-800 border-stone-300' },
      rare: { label: '稀有', cls: 'bg-sky-50 text-sky-900 border-sky-300' },
      epic: { label: '史詩', cls: 'bg-purple-50 text-purple-900 border-purple-300' },
      legendary: { label: '傳說', cls: 'bg-amber-50 text-amber-900 border-amber-400' }
    }[r.seedRarity || 'common'];

    box.innerHTML = `
      <div class="text-center space-y-4 py-1">
        <div class="text-xs font-bold text-[#2b5e4e]">隨筆完成結算（${r.wordCount} 字）</div>
        ${sp ? `
          <div class="p-4 rounded-2xl border-2 ${rarityBadge.cls} space-y-2">
            ${r.isPity ? `<div class="text-xs font-bold text-purple-700">保底觸發！（第 11 顆必出史詩以上）</div>` : ''}
            <div class="w-28 h-28 mx-auto flex items-center justify-center">
              ${renderPlantPreviewHTML(sp, { requiredDays: sp.requiredDays, evalState: { stage: 'grown', progress: sp.requiredDays, miss: 0, isPerfect: true, hadWilt: false } })}
            </div>
            <div class="inline-block px-2.5 py-0.5 rounded-full text-xs font-bold border ${rarityBadge.cls}">${rarityBadge.label}種子</div>
            <div class="text-lg font-extrabold text-[#1d4237]">${sp.name}</div>
            <div class="text-xs text-[#786b5e]">基礎成長需求：${sp.requiredDays} 天</div>
            ${r.rewardType === 'seed_decomposed' ? `<div class="text-xs text-amber-700 font-semibold">（種子袋已滿 30 顆，自動分解為 +${r.decomposedEnergy} 能量）</div>` : ''}
          </div>` : `
          <div class="p-4 rounded-2xl bg-[#f6f0e4] border border-[#e5dec9] space-y-1">
            <div class="font-bold text-[#1d4237]">今日 3 顆種子名額已滿</div>
            <div class="text-xs text-[#5c5046]">本篇字數轉換能量：+${r.overflowEnergy} 能量</div>
          </div>`}

        <div class="bg-[#f6f0e4] rounded-2xl p-3 text-xs space-y-1 text-left">
          <div class="flex justify-between"><span>連續寫作天數</span><span class="font-bold">${r.streakCount} 天 (倍率 ×${r.streakMultiplier})</span></div>
          ${r.dailyBaseEnergy > 0 ? `<div class="flex justify-between text-[#2b5e4e]"><span>今日首篇基礎能量</span><span class="font-bold">+${r.dailyBaseEnergy}</span></div>` : ''}
          <div class="flex justify-between text-[#5c5046]"><span>成長中植物推進</span><span class="font-bold">今日已貢獻 +1 天</span></div>
          ${r.milestoneUnlocked ? `<div class="flex justify-between text-[#c87119] font-bold pt-1 border-t border-[#e5dec9]"><span>達成里程碑限定植物</span><span>獲得「${r.milestoneUnlocked.name}」！</span></div>` : ''}
        </div>

        <div class="grid grid-cols-2 gap-2 pt-1">
          ${r.rewardType === 'seed' ? `
            <button id="btn-reward-plant-now" class="py-2.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] text-xs font-bold shadow-sm">馬上種下</button>
            <button id="btn-reward-bag" class="py-2.5 rounded-xl bg-[#f6f0e4] text-[#382e26] text-xs font-semibold">放進種子袋</button>
          ` : `
            <button id="btn-reward-bag" class="col-span-2 py-2.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] text-xs font-bold">返回花園</button>
          `}
        </div>
      </div>`;

    const plantNowBtn = document.getElementById('btn-reward-plant-now');
    if (plantNowBtn) {
      plantNowBtn.onclick = () => {
        ui.activeModal = null;
        ui.screen = 'garden';
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.placingMode = { type: 'seed', id: r.seedSpeciesId, label: `正在種植「${sp.name}」：請點選花園上的空位光圈` };
        renderApp();
      };
    }
    document.getElementById('btn-reward-bag').onclick = () => {
      ui.activeModal = null;
      renderApp();
    };
    return;
  }

  // 3. 閱讀／編輯隨筆
  if (ui.activeModal === 'read_essay') {
    const e = ui.modalData;
    const isDemo = e.id === DEMO_ESSAY_ID || e.id === 'essay_welcome' || Boolean(e.isDemo);
    const isMine = (Boolean(e.authorUid) && e.authorUid === uid) || isDemo;
    const isGroup = !isDemo && garden.type === 'group';
    const showPrivateLock = isGroup && e.private;
    let selectedCardId = resolveEssayCardStyle(e).id;
    const initCard = CARD_STYLE_MAP[selectedCardId];
    const { myReaction } = getEssayReactionSummary(e, uid);
    const modalReactBtnHtml = showPrivateLock
      ? ''
      : `<button type="button" data-react-btn="${e.id}" data-active-reaction="${myReaction || ''}" aria-label="${escapeHtml(getReactionAriaLabel(e, uid))}" class="inline-flex items-center justify-center gap-1 min-w-[52px] px-2.5 py-1 rounded-full bg-[#f6f0e4] border border-[#e5dec9] transition">${renderReactionBtnInner(e, uid)}</button>`;
    const authorDisplayName = isDemo
      ? '美地嚮導'
      : ((typeof store.getMemberDisplayName === 'function' && store.getMemberDisplayName(e.authorUid)) || e.authorName || '旅人');

    box.innerHTML = `
      <div class="space-y-3 max-h-[85vh] overflow-y-auto no-scrollbar">
        <div class="flex items-center justify-between">
          <div class="text-xs text-[#786b5e]">${e.dayKey} ・ 作者：<span class="font-bold text-[#382e26]">${escapeHtml(authorDisplayName)}</span> (<span id="edit-word-count">${countEssayWords(e.content)}</span> 字)</div>
          <button type="button" id="modal-close" class="text-[#786b5e] text-xs font-semibold px-2 py-1">關閉</button>
        </div>
        ${isDemo ? `
          ${renderCardPickerHtml(selectedCardId)}
          <div id="edit-memo-wrap" class="memo-note w-full pt-[26%] pb-[11%] px-[17px]" style="${memoStyleAttr(initCard)}">
            <div class="whitespace-pre-wrap leading-relaxed select-text text-sm text-[#382e26] min-h-[96px] text-justify [text-align-last:left]">${escapeHtml(e.content)}</div>
          </div>
          <div class="flex items-center justify-between gap-2 text-xs pt-1">
            <div class="flex items-center gap-2">
              ${modalReactBtnHtml}
              <span class="text-xs text-[#786b5e] select-none">← 長按可以選擇不同回應</span>
            </div>
          </div>
        ` : (isMine ? `
          ${renderCardPickerHtml(selectedCardId)}
          <div id="edit-memo-wrap" class="memo-note w-full pt-[26%] pb-[11%] px-[17px]" style="${memoStyleAttr(initCard)}">
            <textarea id="edit-essay-text" rows="5" class="w-full bg-transparent text-sm text-[#382e26] leading-relaxed resize-none focus:outline-none select-text text-justify [text-align-last:left]">${escapeHtml(e.content)}</textarea>
          </div>
          <div class="flex items-center justify-between gap-2 text-xs pt-1">
            <div class="flex items-center gap-2">
              ${isGroup ? `
                <label class="flex items-center gap-1.5 text-[#5c5046] cursor-pointer select-none">
                  <input type="checkbox" id="edit-essay-priv" ${e.private ? 'checked' : ''}/>
                  <span>私密隨筆</span>
                </label>` : ''}
              ${modalReactBtnHtml}
              <span class="text-xs text-[#786b5e] select-none">← 長按可以選擇不同回應</span>
            </div>
            <button type="button" id="btn-save-essay" class="px-4 py-2 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-semibold">儲存修改（不重算獎勵）</button>
          </div>
        ` : `
          <div class="memo-note w-full pt-[26%] pb-[12%] px-[17px] text-sm text-[#382e26]" style="${memoStyleAttr(initCard)}"><p class="whitespace-pre-wrap leading-relaxed select-text text-justify [text-align-last:left]">${escapeHtml(e.content)}</p></div>
          ${!showPrivateLock ? `<div class="flex items-center justify-between text-xs text-[#5c5046] pt-1"><span class="select-none">給予心情反應（長按可選更多）</span>${modalReactBtnHtml}</div>` : ''}
        `)}
      </div>`;
    const modalReactBtn = box.querySelector('[data-react-btn]');
    if (modalReactBtn) bindReactionTrigger(modalReactBtn, e);
    if (isDemo) {
      bindCardPicker(box, document.getElementById('edit-memo-wrap'), selectedCardId, (id) => {
        selectedCardId = id;
        saveDemoEssayCardStyle(id);
        e.cardStyle = id;
        const homeCardEl = document.querySelector(`.essay-card[data-essay-id="${e.id}"]`);
        if (homeCardEl) {
          const c = CARD_STYLE_MAP[id];
          if (c) {
            homeCardEl.style.setProperty('--memo-bg', c.bg);
            homeCardEl.style.setProperty('--memo-img', `url("./assets/card/${c.id}.png?v=${ASSET_VER}")`);
          }
        }
      });
    } else if (isMine) {
      bindCardPicker(box, document.getElementById('edit-memo-wrap'), selectedCardId, (id) => {
        selectedCardId = id;
        savePreferredCardStyle(id);
      });
      const editInput = document.getElementById('edit-essay-text');
      const wordCountEl = document.getElementById('edit-word-count');
      if (editInput && wordCountEl) {
        editInput.addEventListener('input', () => {
          wordCountEl.textContent = String(countEssayWords(editInput.value));
        });
      }
    }
    const saveBtn = document.getElementById('btn-save-essay');
    if (saveBtn) {
      saveBtn.onclick = () => {
        const txt = document.getElementById('edit-essay-text').value;
        const priv = isGroup ? document.getElementById('edit-essay-priv').checked : Boolean(e.private);
        runLockedAction(saveBtn, '儲存中...', async () => {
          await store.updateEssayContent(e.id, txt, priv, selectedCardId, e.dayKey, e.authorUid);
          savePreferredCardStyle(selectedCardId);
          ui.activeModal = null;
          showToast('已更新隨筆內容');
          renderApp();
        });
      };
    }
    bindCloseModal();
    return;
  }

  // 4. 點選植物詳情卡（隨寫隨筆的日子自然長大，無能量升級）
  if (ui.activeModal === 'plant_detail') {
    const { gardenId, regionId, regionStatus, plant } = ui.modalData;
    const sp = store.speciesMap[plant.speciesId];
    const st = plant.evalState;
    const isMine = plant.plantedBy === uid;
    const planterName =
      (typeof store.getMemberDisplayName === 'function' && store.getMemberDisplayName(plant.plantedBy)) ||
      store.state.gardens[gardenId]?.members?.[plant.plantedBy]?.displayName ||
      '旅人';

    const stageLabel = {
      growing: `成長中 Lv${st.level}（已累積 ${st.progress} / ${plant.requiredDays} 天）`,
      grown: st.isPerfect ? `已完美長成（全程無枯萎 Perfect・永久安全）` : `已完全長成（永久安全，不會枯萎）`,
      withering: `枯萎中（枯萎前 Lv${st.level}，今天寫隨筆即可恢復，否則明天死亡！）`,
      dead: `已乾枯死亡 Lv${st.level}（可花 ${config.clearWitheredCost} 能量清除）`
    }[st.stage];

    box.innerHTML = `
      <div class="space-y-3 text-xs">
        <div class="flex items-center justify-between">
          <div>
            <span class="font-extrabold text-base text-[#1d4237]">${sp.name}</span>
            <span class="ml-1.5 px-2 py-0.5 rounded-full bg-[#2b5e4e]/12 text-[#1d4237] font-bold">${sp.rarity.toUpperCase()}</span>
          </div>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        <div class="w-36 h-36 mx-auto flex items-center justify-center bg-[#f6f0e4] rounded-2xl border border-[#e5dec9] p-2">
          ${renderPlantPreviewHTML(sp, plant)}
        </div>

        <div class="bg-[#f6f0e4] rounded-2xl p-3 space-y-1.5 text-[#5c5046]">
          <div>狀態：<span class="font-bold text-[#1d4237]">${stageLabel}</span></div>
          ${st.stage === 'growing' ? `
            <div class="w-full h-2 rounded-full bg-[#e5dec9] overflow-hidden">
              <div class="h-full bg-[#2b5e4e] transition-all" style="width:${Math.min(100, Math.round((st.progress / plant.requiredDays) * 100))}%"></div>
            </div>
            <div class="text-[#628b78]">剛種下為 Lv1，隔天起每日寫隨筆累積進度成長；全程無枯萎可長成 Perfect</div>
          ` : ''}
          <div>種植者：${escapeHtml(planterName)} ・ 種下日期：${plant.plantedDay}</div>
        </div>

        ${regionStatus !== 'snapshot' ? `
          <div class="flex flex-wrap gap-2 pt-1">
            ${st.stage === 'withering' ? `
              <button id="btn-plant-write-rescue" class="flex-1 py-2.5 rounded-xl bg-[#2b5e4e] text-white font-bold">立即寫隨筆恢復</button>
              ${store.canMakeUpYesterday().available ? `<button id="btn-plant-makeup" class="flex-1 py-2.5 rounded-xl bg-[#df8a2b] text-white font-bold">補寫昨天保 Perfect (${config.makeUpCost} 能量)</button>` : ''}
            ` : ''}
            ${st.stage === 'dead' ? `
              ${store.canRescuePlantByMakeUp(gardenId, plant) ? `<button id="btn-plant-makeup" class="flex-1 py-2.5 rounded-xl bg-[#df8a2b] text-white font-bold">補寫昨天救活 (${config.makeUpCost} 能量)</button>` : ''}
              <button id="btn-plant-clear" class="flex-1 py-2.5 rounded-xl bg-rose-700 text-white font-bold">清除枯枝 (${config.clearWitheredCost} 能量)</button>
            ` : ''}
            ${isMine ? `
              <button id="btn-plant-move" class="flex-1 py-2.5 px-3.5 rounded-xl bg-[#f6f0e4] text-[#382e26] font-semibold border border-[#e5dec9]">移動位置</button>
            ` : ''}
          </div>
        ` : `<div class="text-center text-[#786b5e]">（唯讀快照區域）</div>`}
      </div>`;

    const writeRescueBtn = document.getElementById('btn-plant-write-rescue');
    if (writeRescueBtn) writeRescueBtn.onclick = () => { ui.activeModal = null; openEditorModal(); };

    const mkBtn = document.getElementById('btn-plant-makeup');
    if (mkBtn) mkBtn.onclick = () => { ui.activeModal = null; handleMakeUpClick(); };

    const clrBtn = document.getElementById('btn-plant-clear');
    if (clrBtn) {
      clrBtn.onclick = () => {
        runLockedAction(clrBtn, '清除中...', async () => {
          await store.clearDeadPlant(gardenId, regionId, plant.id);
          showToast('已清除枯枝');
          ui.activeModal = null;
          renderApp();
        });
      };
    }
    const mvBtn = document.getElementById('btn-plant-move');
    if (mvBtn) {
      mvBtn.onclick = () => {
        ui.activeModal = null;
        ui.placingMode = { type: 'move', kind: 'plant', id: plant.id, label: `正在移動「${sp.name}」：請點選目標空位光圈` };
        renderApp();
      };
    }
    bindCloseModal();
    return;
  }

  // 5. 點選裝飾詳情卡
  if (ui.activeModal === 'decor_detail') {
    const { gardenId, regionId, regionStatus, decor } = ui.modalData;
    const item = store.decorMap[decor.itemId];
    const isMine = decor.placedBy === uid;
    const spec = getDecorSpriteSpec(decor.itemId);
    box.innerHTML = `
      <div class="space-y-3 text-xs">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237]">${item.name}</span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>
        <div class="w-28 h-28 mx-auto flex items-center justify-center bg-[#f6f0e4] rounded-2xl border border-[#e5dec9] p-2">
          <img src="${spec.path}?v=${ASSET_VER}" class="w-full h-full object-contain"/>
        </div>
        <div class="text-[#5c5046] text-center">美觀度加成：+${store.getDecorBeautyBonus(item.id)}</div>
        ${regionStatus !== 'snapshot' && isMine ? `
          <div class="flex gap-2 pt-1">
            <button id="btn-decor-move" class="flex-1 py-2.5 rounded-xl bg-[#f6f0e4] text-[#382e26] font-semibold border border-[#e5dec9]">移動位置</button>
            <button id="btn-decor-remove" class="flex-1 py-2.5 rounded-xl bg-rose-100 text-rose-800 font-semibold">拆除（不退能量）</button>
          </div>
        ` : `<div class="text-[#786b5e] text-center">僅擺放者本人可移動或拆除</div>`}
      </div>`;
    const mv = document.getElementById('btn-decor-move');
    if (mv) {
      mv.onclick = () => {
        ui.activeModal = null;
        ui.placingMode = { type: 'move', kind: 'decor', id: decor.id, label: `正在移動「${item.name}」：請點選空位光圈` };
        renderApp();
      };
    }
    const rm = document.getElementById('btn-decor-remove');
    if (rm) {
      rm.onclick = () => {
        runLockedAction(rm, '拆除中...', async () => {
          await store.removeDecor(gardenId, regionId, decor.id);
          showToast('已拆除裝飾');
          ui.activeModal = null;
          renderApp();
        });
      };
    }
    bindCloseModal();
    return;
  }

  // 6. 點選空格快速選單
  if (ui.activeModal === 'cell_picker') {
    const { gardenId, regionId, regionStatus, x, y } = ui.modalData;
    const seedEntries = Object.entries(user.seeds).filter(([, c]) => c > 0);
    const limEntries = Object.entries(user.limitedSeeds || {}).filter(([, c]) => c > 0);

    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[75vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-sm text-[#1d4237]">位置 (${x}, ${y})：選擇種植或佈置</span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        ${regionStatus === 'active' ? `
          <div class="space-y-1.5">
            <div class="font-bold text-[#382e26]">從種子袋種下</div>
            ${seedEntries.length === 0 && limEntries.length === 0 ? `<div class="text-[#786b5e] py-2">種子袋目前是空的，寫一篇隨筆來獲得種子吧！</div>` : ''}
            <div class="grid grid-cols-2 gap-1.5">
              ${limEntries.map(([sid, cnt]) => {
                const sp = store.speciesMap[sid];
                return `<button data-plant-lim="${sid}" class="p-2.5 rounded-xl border border-amber-300 bg-amber-50 text-left flex justify-between items-center font-semibold">
                  <span>${sp.name}</span><span class="font-bold">x${cnt}</span>
                </button>`;
              }).join('')}
              ${seedEntries.map(([sid, cnt]) => {
                const sp = store.speciesMap[sid];
                return `<button data-plant-seed="${sid}" class="p-2.5 rounded-xl border border-[#e5dec9] bg-white hover:border-[#2b5e4e] text-left flex justify-between items-center">
                  <span class="font-medium">${sp.name} (${sp.requiredDays}天)</span><span class="font-bold text-[#2b5e4e]">x${cnt}</span>
                </button>`;
              }).join('')}
            </div>
          </div>
        ` : `<div class="text-amber-800 bg-amber-50 p-2.5 rounded-xl">封存區域不可種植新植物，但仍可購買擺放裝飾品</div>`}

        <div class="space-y-1.5 pt-2 border-t border-[#e5dec9]">
          <div class="font-bold text-[#382e26]">直接購買裝飾擺放（持有能量：${user.energy}）</div>
          <div class="grid grid-cols-2 gap-1.5">
            ${catalog.decor.map(d => `
              <button data-buy-decor="${d.id}" class="p-2.5 rounded-xl border border-[#e5dec9] bg-white hover:border-[#2b5e4e] text-left flex justify-between items-center">
                <span class="font-medium">${d.name}</span><span class="text-[#c87119] font-bold">${d.cost} 能量</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>`;

    box.querySelectorAll('[data-plant-seed]').forEach(b => {
      b.onclick = () => {
        runLockedAction(b, '種植中...', async () => {
          await store.plantSeed(b.dataset.plantSeed, x, y, false);
          ui.activeModal = null;
          showToast('已種下種子！');
          renderApp();
        });
      };
    });
    box.querySelectorAll('[data-plant-lim]').forEach(b => {
      b.onclick = () => {
        runLockedAction(b, '種植中...', async () => {
          await store.plantSeed(b.dataset.plantLim, x, y, true);
          ui.activeModal = null;
          showToast('已種下里程碑限定植物！');
          renderApp();
        });
      };
    });
    box.querySelectorAll('[data-buy-decor]').forEach(b => {
      b.onclick = () => {
        runLockedAction(b, '購買中...', async () => {
          await store.buyAndPlaceDecor(gardenId, regionId, b.dataset.buyDecor, x, y);
          ui.activeModal = null;
          showToast('已購買並擺放裝飾！');
          renderApp();
        });
      };
    });
    bindCloseModal();
    return;
  }

  // 7. 種子袋
  if (ui.activeModal === 'bag') {
    const seedEntries = Object.entries(user.seeds).filter(([, c]) => c > 0);
    const limEntries = Object.entries(user.limitedSeeds || {}).filter(([, c]) => c > 0);
    const total = seedEntries.reduce((acc, [, c]) => acc + c, 0);

    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[75vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('pouch', 'w-4 h-4')}<span>種子袋 (${total} / ${config.seedBagCap})</span></span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>
        <p class="text-[#786b5e]">可跨月保留，但只能種在當月活動區域；滿袋時新種子自動分解為能量。</p>

        ${limEntries.length > 0 ? `
          <div class="space-y-1">
            <div class="font-bold text-[#c87119]">里程碑限定植物（不占上限、直接長成）</div>
            ${limEntries.map(([sid, cnt]) => {
              const sp = store.speciesMap[sid];
              return `<div class="p-2.5 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-between">
                <div class="font-bold">${sp.name} x${cnt}</div>
                <button data-bag-plant-lim="${sid}" class="px-3 py-1 rounded-xl bg-[#df8a2b] text-white font-semibold">種下</button>
              </div>`;
            }).join('')}
          </div>` : ''}

        <div class="space-y-1.5">
          ${seedEntries.length === 0 ? `<div class="text-center py-6 text-[#786b5e]">種子袋空空如也</div>` : ''}
          ${seedEntries.map(([sid, cnt]) => {
            const sp = store.speciesMap[sid];
            const decomp = config.decomposeEnergy[sp.rarity] || 2;
            return `
              <div class="p-2.5 rounded-2xl bg-white border border-[#e5dec9] flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <div class="w-10 h-10 rounded-xl bg-[#f6f0e4] p-1 shrink-0">
                    ${renderPlantPreviewHTML(sp, { requiredDays: sp.requiredDays, evalState: { stage: 'grown', progress: sp.requiredDays, miss: 0, isPerfect: true, hadWilt: false } })}
                  </div>
                  <div>
                    <div class="font-bold text-[#1d4237]">${sp.name} x${cnt}</div>
                    <div class="text-[#786b5e]">${sp.rarity.toUpperCase()} ・ 需求 ${sp.requiredDays} 天</div>
                  </div>
                </div>
                <div class="flex gap-1.5 shrink-0">
                  <button data-bag-decomp="${sid}" class="px-2.5 py-1.5 rounded-xl bg-[#f6f0e4] text-[#5c5046] font-semibold">分解 (+${decomp})</button>
                  <button data-bag-plant="${sid}" class="px-3 py-1.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-semibold">種下</button>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;

    box.querySelectorAll('[data-bag-plant]').forEach(b => {
      b.onclick = () => {
        const sp = store.speciesMap[b.dataset.bagPlant];
        ui.activeModal = null;
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.placingMode = { type: 'seed', id: sp.id, label: `正在種植「${sp.name}」：請點選花園上的空位光圈` };
        renderApp();
      };
    });
    box.querySelectorAll('[data-bag-plant-lim]').forEach(b => {
      b.onclick = () => {
        const sp = store.speciesMap[b.dataset.bagPlantLim];
        ui.activeModal = null;
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.placingMode = { type: 'limited', id: sp.id, label: `正在種植限定「${sp.name}」：請點選花園上的空位光圈` };
        renderApp();
      };
    });
    box.querySelectorAll('[data-bag-decomp]').forEach(b => {
      b.onclick = () => {
        runLockedAction(b, '分解中...', async () => {
          const gain = await store.decomposeSeed(b.dataset.bagDecomp, 1);
          showToast(`已分解種子獲得 +${gain} 能量`);
          renderApp();
        });
      };
    });
    bindCloseModal();
    return;
  }

  // 8. 商店（裝飾購買 + 擴充地塊 + 天候動態背景）
  if (ui.activeModal === 'shop') {
    const activeReg = garden.regions[garden.activeRegionId];
    const expCost = config.expansionCosts[activeReg.expansions];
    const bgThemes = bgManager.getThemeCatalog();
    const unlockedBgList = store.getUnlockedBgThemes ? store.getUnlockedBgThemes() : ['morning'];
    const activeBg = store.getActiveBgTheme ? store.getActiveBgTheme() : 'morning';

    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[75vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('shop', 'w-4 h-4')}<span>花園商店（持有能量：${user.energy}）</span></span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        <div class="p-3 rounded-2xl bg-[#f6f0e4] border border-[#e5dec9] flex items-center justify-between">
          <div>
            <div class="font-bold text-[#1d4237]">擴充當月區域地塊（目前 ${activeReg.size}×${activeReg.size}，上限 9×9）</div>
            <div class="text-[#786b5e]">已擴充 ${activeReg.expansions} 次（每次切換至更大尺寸專屬地貌島嶼）</div>
          </div>
          ${activeReg.size < 9 && expCost ? `
            <button id="btn-shop-expand" class="px-3.5 py-2 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-bold shrink-0">擴地 (${expCost} 能量)</button>
          ` : `<span class="text-[#2b5e4e] font-bold">已達最大 (9×9)</span>`}
        </div>

        <div class="space-y-1.5">
          <div class="font-bold text-[#382e26] flex items-center justify-between">
            <span>天候與動態背景（為花園更換獨特天空景致）</span>
            <span class="text-[11px] text-[#786b5e]">已解鎖 ${unlockedBgList.length}/5</span>
          </div>
          <div class="space-y-2">
            ${bgThemes.map(t => {
              const isOwned = unlockedBgList.includes(t.id);
              const isActive = activeBg === t.id;
              return `
                <div class="p-2.5 rounded-2xl bg-white border border-[#e5dec9] flex items-center justify-between gap-3 shadow-sm">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-11 h-11 rounded-xl overflow-hidden shrink-0 border border-[#e5dec9]">
                      ${t.thumbSvg}
                    </div>
                    <div class="min-w-0">
                      <div class="font-bold text-[#1d4237] flex items-center gap-1.5">
                        <span>${t.name}</span>
                        ${t.cost === 0 ? '<span class="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800 font-semibold">預設擁有</span>' : ''}
                      </div>
                      <div class="text-[11px] text-[#786b5e] truncate">${t.desc}</div>
                    </div>
                  </div>
                  <div class="shrink-0">
                    ${isActive ? `
                      <span class="px-3 py-1.5 rounded-xl bg-[#2b5e4e] text-white text-xs font-bold shadow-sm">使用中</span>
                    ` : isOwned ? `
                      <button data-apply-bg="${t.id}" class="px-3 py-1.5 rounded-xl bg-white border border-[#2b5e4e] text-[#2b5e4e] text-xs font-bold hover:bg-[#2b5e4e]/10 transition">套用</button>
                    ` : `
                      <button data-buy-bg="${t.id}" data-cost="${t.cost}" class="px-3 py-1.5 rounded-xl bg-[#df8a2b] text-white text-xs font-bold hover:brightness-105 transition">購買 (${t.cost} 能量)</button>
                    `}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="font-bold text-[#382e26]">庭園裝飾品（購買後點選空位光圈直接擺放）</div>
          <div class="grid grid-cols-2 gap-2">
            ${catalog.decor.map(d => {
              const spec = getDecorSpriteSpec(d.id);
              return `
                <div class="p-2.5 rounded-2xl bg-white border border-[#e5dec9] flex flex-col justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <div class="w-11 h-11 rounded-xl bg-[#f6f0e4] p-1 shrink-0">
                      <img src="${spec.path}?v=${ASSET_VER}" class="w-full h-full object-contain"/>
                    </div>
                    <div>
                      <div class="font-bold text-[#1d4237]">${d.name}</div>
                      <div class="text-[#786b5e]">美觀度 +${store.getDecorBeautyBonus(d.id)}</div>
                    </div>
                  </div>
                  <button data-shop-decor="${d.id}" class="w-full py-1.5 rounded-xl bg-[#df8a2b] text-white font-bold">購買擺放 (${d.cost} 能量)</button>
                </div>`;
            }).join('')}
          </div>
        </div>
      </div>`;

    const expBtn = document.getElementById('btn-shop-expand');
    if (expBtn) {
      expBtn.onclick = () => {
        runLockedAction(expBtn, '擴地中...', async () => {
          const r = await store.expandActiveRegion();
          showToast(`擴地成功！花園已擴大為 ${r.size}×${r.size}`);
          renderApp();
        });
      };
    }
    box.querySelectorAll('[data-shop-decor]').forEach(b => {
      b.onclick = () => {
        const item = store.decorMap[b.dataset.shopDecor];
        if (user.energy < item.cost) {
          showToast(`能量不足（需要 ${item.cost} 能量，目前僅有 ${user.energy} 能量）`);
          return;
        }
        ui.activeModal = null;
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.placingMode = { type: 'decor', id: item.id, label: `正在擺放「${item.name}」(${item.cost} 能量)：請點選空位光圈` };
        renderApp();
      };
    });

    box.querySelectorAll('[data-apply-bg]').forEach(b => {
      b.onclick = () => {
        const tid = b.dataset.applyBg;
        if (store.setBgTheme) store.setBgTheme(tid);
        else bgManager.setTheme(tid);
        showToast('已套用天候背景景致');
        renderApp();
      };
    });

    box.querySelectorAll('[data-buy-bg]').forEach(b => {
      b.onclick = () => {
        const tid = b.dataset.buyBg;
        runLockedAction(b, '購買中...', async () => {
          const res = await store.buyBgTheme(tid);
          if (res.success) {
            showToast('購買成功！已解鎖並套用新天候背景');
            renderApp();
          } else {
            showToast(res.reason || '購買失敗');
          }
        });
      };
    });

    bindCloseModal();
    return;
  }

  // 9. 圖鑑
  if (ui.activeModal === 'dex') {
    const collectedCount = Object.keys(user.dex || {}).length;
    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('book', 'w-4 h-4')}<span>植物圖鑑 (${collectedCount} / ${catalog.species.length})</span></span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        <div class="grid grid-cols-3 gap-2">
          ${catalog.species.map(sp => {
            const unlocked = Boolean(user.dex[sp.id]);
            return `
              <div class="p-2.5 rounded-2xl border ${unlocked ? 'border-[#e5dec9] bg-white' : 'border-[#e5dec9] bg-[#f6f0e4]/60 opacity-65'} text-center space-y-1">
                <div class="w-16 h-16 mx-auto flex items-center justify-center ${unlocked ? '' : 'brightness-0 opacity-25'}">
                  ${renderPlantPreviewHTML(sp, { requiredDays: sp.requiredDays, evalState: { stage: 'grown', progress: sp.requiredDays, miss: 0, isPerfect: true, hadWilt: false } })}
                </div>
                <div class="font-bold text-[#1d4237] truncate">${unlocked ? sp.name : '？？？'}</div>
                <div class="text-[#786b5e]">${sp.rarity.toUpperCase()}</div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
    bindCloseModal();
    return;
  }

  // 10. 月份相簿
  if (ui.activeModal === 'album') {
    const allRegions = store.getOrderedRegionsList().slice().reverse();
    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[75vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('album', 'w-4 h-4')}<span>月份相簿（所有區域一覽）</span></span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        <div class="space-y-2">
          ${allRegions.map(item => `
            <div class="p-3 rounded-2xl bg-white border border-[#e5dec9] flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <img src="./assets/islands/${item.region.theme}_${Math.min(9, Math.max(5, item.region.size || 5))}x${Math.min(9, Math.max(5, item.region.size || 5))}.png?v=${ASSET_VER}" class="w-12 h-12 object-contain"/>
                <div>
                  <div class="font-bold text-[#1d4237]">${item.region.month} ・ ${catalog.themes[item.region.theme]?.name}</div>
                  <div class="text-[#786b5e]">${item.region.status === 'snapshot' ? '退出團體唯讀快照' : (item.region.status === 'archived' ? '封存月份' : '當月活動中')} ・ 美觀度 ${item.beauty}</div>
                </div>
              </div>
              <button data-view-gid="${item.gardenId}" data-view-rid="${item.region.id}" class="px-3 py-1.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-semibold shrink-0">切換檢視</button>
            </div>
          `).join('')}
        </div>
      </div>`;

    box.querySelectorAll('[data-view-rid]').forEach(b => {
      b.onclick = () => {
        ui.viewingGardenId = b.dataset.viewGid;
        ui.viewingRegionId = b.dataset.viewRid;
        ui.activeModal = null;
        resetGardenView();
        renderApp();
      };
    });
    bindCloseModal();
    return;
  }

  // 11. 小圈子多人經營
  if (ui.activeModal === 'group') {
    const todayKey = store.currentDayKey(garden);
    const gDay = garden.days[todayKey] || { seedsGiven: 0, writers: {} };

    if (garden.type === 'personal') {
      box.innerHTML = `
        <div class="space-y-4 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('users', 'w-4 h-4')}<span>小圈子多人共同經營</span></span>
            <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
          </div>
          <p class="text-[#5c5046] leading-relaxed">開團或加入時，你目前的個人區域會自動封存至相簿，並切換為 6×6 的多人共用花園（每日共用 3 顆種子名額，每位成員每天寫作各貢獻 +1 成長天數）。</p>

          <div class="p-3.5 rounded-2xl bg-[#f6f0e4] border border-[#e5dec9] space-y-2.5">
            <div class="font-bold text-[#1d4237]">建立新的多人花園</div>
            <input id="inp-group-name" type="text" placeholder="輸入小圈子名稱（例：晨光共筆團）" class="w-full rounded-xl border border-[#e5dec9] bg-white p-2 text-xs"/>
            <select id="sel-group-theme" class="w-full rounded-xl border border-[#e5dec9] bg-white p-2 text-xs">
              <option value="flowerbed">春櫻花圃</option>
              <option value="forest">迷霧森林</option>
              <option value="oasis">沙漠綠洲</option>
            </select>
            <button id="btn-create-group" class="w-full py-2.5 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-bold">封存個人區並開團</button>
          </div>

          <div class="p-3.5 rounded-2xl bg-white border border-[#e5dec9] space-y-2">
            <div class="font-bold text-[#1d4237]">輸入邀請碼加入圈友花園</div>
            <div class="flex gap-2">
              <input id="inp-invite-code" type="text" placeholder="6 碼邀請碼" class="flex-1 rounded-xl border border-[#e5dec9] p-2 text-xs uppercase"/>
              <button id="btn-join-group" class="px-4 py-2 rounded-xl bg-[#382e26] text-white font-semibold">加入</button>
            </div>
          </div>
        </div>`;

      const createGrpBtn = document.getElementById('btn-create-group');
      createGrpBtn.onclick = () => {
        const name = document.getElementById('inp-group-name').value.trim() || '晨光共筆花園';
        const th = document.getElementById('sel-group-theme').value;
        runLockedAction(createGrpBtn, '開團中...', async () => {
          const { inviteCode } = await store.createGroupGarden(name, th);
          ui.viewingGardenId = null;
          ui.viewingRegionId = null;
          showToast(`已建立多人花園！邀請碼：${inviteCode}`);
          renderApp();
        });
      };
      const joinGrpBtn = document.getElementById('btn-join-group');
      joinGrpBtn.onclick = () => {
        const code = document.getElementById('inp-invite-code').value;
        runLockedAction(joinGrpBtn, '加入中...', async () => {
          await store.joinGroupByCode(code);
          ui.viewingGardenId = null;
          ui.viewingRegionId = null;
          showToast('成功加入多人花園！');
          renderApp();
        });
      };
    } else {
      const mult = store.getGroupGrowthMultiplier(garden.memberUids.length);
      box.innerHTML = `
        <div class="space-y-3 text-xs max-h-[80vh] overflow-y-auto">
          <div class="flex items-center justify-between">
            <div>
              <span class="font-extrabold text-base text-[#1d4237]">${escapeHtml(garden.name)}</span>
              <span class="ml-1 text-[#786b5e]">(${garden.memberUids.length}/5 人・需求倍率 ×${mult})</span>
            </div>
            <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
          </div>

          <div class="p-2.5 rounded-2xl bg-[#f6f0e4] border border-[#e5dec9] flex items-center justify-between">
            <span>邀請碼：<strong class="text-sm tracking-wider text-[#1d4237]">${garden.inviteCode || 'GROUP6'}</strong></span>
            <span class="text-[#5c5046]">時區：${garden.timezone}</span>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="font-bold text-[#382e26]">成員今日狀態（今日種子：${gDay.seedsGiven || 0}/3）</span>
              ${!store.isCloud ? `<button id="btn-sim-teammate" class="px-2.5 py-1 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-semibold">模擬圈友寫一篇</button>` : ''}
            </div>
            ${garden.memberUids.map(mUid => {
              const m = garden.members[mUid] || { displayName: mUid, streakCount: 0 };
              const wroteToday = Boolean(gDay.writers && gDay.writers[mUid]);
              return `
                <div class="p-2.5 rounded-2xl bg-white border border-[#e5dec9] flex items-center justify-between">
                  <div>
                    <div class="font-bold text-[#1d4237]">${escapeHtml(m.displayName)} ${mUid === uid ? '(我)' : ''}</div>
                    <div class="text-[#786b5e]">連續寫作 ${m.streakCount || 0} 天</div>
                  </div>
                  <span class="px-2.5 py-1 rounded-full font-bold ${wroteToday ? 'bg-[#2b5e4e]/15 text-[#1d4237]' : 'bg-[#f6f0e4] text-[#786b5e]'}">
                    ${wroteToday ? '今日已貢獻 +1天' : '尚未寫作'}
                  </span>
                </div>`;
            }).join('')}
          </div>

          <div class="p-3 rounded-2xl bg-amber-50 border border-amber-200 space-y-2">
            <div class="font-bold text-amber-900">下個月主題區域投票（每月最後一天開放）</div>
            ${garden.themeVote ? `
              <div class="grid grid-cols-3 gap-1.5">
                ${['flowerbed', 'forest', 'oasis'].map(th => {
                  const myVote = garden.themeVote.votes[uid] === th;
                  const cnt = Object.values(garden.themeVote.votes).filter(v => v === th).length;
                  return `<button data-vote-theme="${th}" class="py-2 px-1 rounded-xl border ${myVote ? 'bg-[#df8a2b] text-white border-[#c87119]' : 'bg-white text-[#382e26] border-amber-300'} font-semibold">
                    ${catalog.themes[th].name} (${cnt}票)
                  </button>`;
                }).join('')}
              </div>
            ` : `<div class="text-amber-800">${store.isCloud ? '目前非每月最後一天（將於每月最後一天開放投票）' : '目前非每月最後一天（可在「設定 → 時間測試」跳至月底最後一天體驗投票）'}</div>`}
          </div>

          <div class="pt-2 border-t border-[#e5dec9] space-y-2">
            <div class="text-[#786b5e]">退出團體時，會在相簿保留當下共用區域的唯讀快照，並選擇新的個人區域主題：</div>
            <div class="flex gap-2">
              <select id="sel-leave-theme" class="flex-1 rounded-xl border border-[#e5dec9] bg-white p-2">
                <option value="flowerbed">新個人區：春櫻花圃</option>
                <option value="forest">新個人區：迷霧森林</option>
                <option value="oasis">新個人區：沙漠綠洲</option>
              </select>
              <button id="btn-leave-group" class="px-3.5 py-2 rounded-xl bg-rose-100 text-rose-800 font-bold">退出團體</button>
            </div>
          </div>
        </div>`;

      const simBtn = document.getElementById('btn-sim-teammate');
      if (simBtn) {
        simBtn.onclick = () => {
          try {
            store.simulateTeammateWrite();
            showToast('圈友「小沐」完成了一篇隨筆！成長中植物 +1 天');
            renderApp();
          } catch (err) { showToast(err.message); }
        };
      }
      box.querySelectorAll('[data-vote-theme]').forEach(b => {
        b.onclick = () => {
          runLockedAction(b, '投票中...', async () => {
            await store.castGroupThemeVote(b.dataset.voteTheme);
            showToast('已更新你的主題投票！');
            renderApp();
          });
        };
      });
      const leaveBtn = document.getElementById('btn-leave-group');
      leaveBtn.onclick = () => {
        const newTh = document.getElementById('sel-leave-theme').value;
        runLockedAction(leaveBtn, '退出中...', async () => {
          await store.leaveGroupGarden(newTh);
          ui.viewingGardenId = null;
          ui.viewingRegionId = null;
          ui.activeModal = null;
          showToast('已保存團體快照至相簿，並切換回新個人花園');
          renderApp();
        });
      };
    }
    bindCloseModal();
    return;
  }

  // 12. 強制換月選主題彈窗
  if (ui.activeModal === 'theme_picker') {
    const { month } = ui.modalData;
    box.innerHTML = `
      <div class="space-y-3 text-xs">
        <div class="font-extrabold text-base text-[#1d4237]">迎接新月份 (${month})：請選擇本月花園主題</div>
        <p class="text-[#5c5046]">上個月的區域已封存至相簿（可透過花園島左右箭頭隨時翻閱）。主題決定本月的種子池：</p>
        <div class="space-y-2">
          ${Object.values(catalog.themes).map(t => `
            <button data-pick-month-theme="${t.id}" class="w-full p-3 rounded-2xl bg-white border border-[#e5dec9] hover:border-[#2b5e4e] flex items-center gap-3 text-left transition">
              <img src="./assets/islands/${t.id}_5x5.png?v=${ASSET_VER}" class="w-14 h-14 object-contain shrink-0"/>
              <div>
                <div class="font-bold text-sm text-[#1d4237]">${t.name}</div>
                <div class="text-[#786b5e] mt-0.5">${t.desc}</div>
              </div>
            </button>
          `).join('')}
        </div>
      </div>`;
    box.querySelectorAll('[data-pick-month-theme]').forEach(b => {
      b.onclick = () => {
        runLockedAction(b, '建立中...', async () => {
          await store.startNewMonthRegion(b.dataset.pickMonthTheme, month);
          ui.viewingGardenId = null;
          ui.viewingRegionId = null;
          ui.activeModal = null;
          showToast(`已建立 ${month} 主題區域！`);
          renderApp();
        });
      };
    });
    return;
  }

  // 13. 設定面板（雲端模式自動隱藏本機時間推進／+200能量／重置示範資料，提供登出帳號；支援雙軌一鍵切換）
  if (ui.activeModal === 'settings') {
    const todayKey = store.currentDayKey(garden);
    box.innerHTML = `
      <div class="space-y-3 text-xs max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <span class="font-extrabold text-base text-[#1d4237] flex items-center gap-1.5">${icon('settings', 'w-4 h-4')}<span>${store.isCloud ? '個人與花園設定' : '設定 ＆ 管理者測試面板'}</span></span>
          <button id="modal-close" class="text-[#786b5e] font-semibold px-2 py-1">關閉</button>
        </div>

        <div class="p-3 rounded-2xl bg-[#f6f0e4] border border-[#e5dec9] space-y-2">
          <div class="font-bold text-[#1d4237]">個人資料與時區</div>
          <div class="flex gap-2">
            <input id="inp-user-name" type="text" value="${escapeHtml(user.displayName)}" class="flex-1 rounded-xl border border-[#e5dec9] bg-white p-2"/>
            <button id="btn-save-name" class="px-3.5 py-2 rounded-xl bg-[#2b5e4e] text-[#fffdf8] font-semibold">儲存名稱</button>
          </div>
          <div class="text-[#786b5e]">換日分界：凌晨 04:00 ・ 目前花園遊戲日：<strong>${todayKey}</strong></div>
        </div>

        ${!store.isCloud ? `
          <div class="p-3 rounded-2xl bg-amber-50 border border-amber-200 space-y-2">
            <div class="flex items-center justify-between">
              <div class="font-bold text-amber-900">管理者測試面板（時間推進與能量模擬）</div>
              <span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-semibold">本機測試</span>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <button id="btn-sim-nextday" class="py-2 px-2 rounded-xl bg-[#df8a2b] text-white font-bold">+1 天（進入明天）</button>
              <button id="btn-sim-skip2" class="py-2 px-2 rounded-xl bg-rose-700 text-white font-bold">+2 天（測試斷簽枯萎）</button>
              <button id="btn-sim-month-end" class="py-2 px-2 rounded-xl bg-[#2b5e4e] text-white font-bold">跳至本月最後一天</button>
              <button id="btn-sim-add-energy" class="py-2 px-2 rounded-xl bg-[#382e26] text-white font-bold">+200 測試能量</button>
            </div>
          </div>

          <div class="pt-2 border-t border-[#e5dec9] flex justify-between items-center">
            <button id="btn-reset-all" class="px-3 py-1.5 rounded-xl bg-rose-100 text-rose-800 font-semibold">重置初始示範資料</button>
            <button id="btn-switch-mode" class="px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 font-semibold">切換為雲端多人版</button>
          </div>
        ` : `
          <div class="pt-2 border-t border-[#e5dec9] flex justify-between items-center">
            <span class="text-[#786b5e]">目前登入 ID：<strong>${escapeHtml(user.uid)}</strong></span>
            <div class="flex gap-2">
              <button id="btn-switch-mode" class="px-3 py-1.5 rounded-xl bg-amber-100 text-amber-800 font-bold">切換為管理者測試版</button>
              <button id="btn-logout" class="px-3.5 py-1.5 rounded-xl bg-rose-100 text-rose-800 font-bold">登出帳號</button>
            </div>
          </div>
        `}
      </div>`;

    const saveNameBtn = document.getElementById('btn-save-name');
    saveNameBtn.onclick = () => {
      const val = document.getElementById('inp-user-name').value.trim();
      if (!val) {
        showToast('顯示名稱不可為空白');
        return;
      }
      runLockedAction(saveNameBtn, '儲存中...', async () => {
        await store.updateDisplayName(val);
        showToast('已更新名稱');
        renderApp();
      });
    };

    const switchModeBtn = document.getElementById('btn-switch-mode');
    if (switchModeBtn) {
      switchModeBtn.onclick = () => {
        const targetMode = store.isCloud ? 'local' : 'cloud';
        const u = new URL(window.location.href);
        u.searchParams.set('mode', targetMode);
        window.location.href = u.toString();
      };
    }

    if (!store.isCloud) {
      document.getElementById('btn-sim-nextday').onclick = () => {
        const nextKey = store.advanceSimulationDays(1);
        showToast(`已進入下一天（${nextKey}）`);
        renderApp();
      };
      document.getElementById('btn-sim-skip2').onclick = () => {
        const nextKey = store.advanceSimulationDays(2);
        showToast(`已快轉 2 天（${nextKey}）`);
        renderApp();
      };
      document.getElementById('btn-sim-month-end').onclick = () => {
        const nextKey = store.advanceToMonthEnd();
        showToast(`已跳至本月最後一天（${nextKey}）`);
        renderApp();
      };
      document.getElementById('btn-sim-add-energy').onclick = () => {
        store.grantDebugEnergy(200);
        showToast('已增加 200 測試能量');
        renderApp();
      };
      document.getElementById('btn-reset-all').onclick = () => {
        localStorage.removeItem(CARD_STYLE_STORAGE_KEY);
        store.resetAllData();
        ui.viewingGardenId = null;
        ui.viewingRegionId = null;
        ui.viewingEssayMonth = null;
        ui.essaysAnim = null;
        showToast('已重置為初始示範狀態');
        goHome();
      };
    } else {
      const logoutBtn = document.getElementById('btn-logout');
      logoutBtn.onclick = () => {
        runLockedAction(logoutBtn, '登出中...', async () => {
          await store.logout();
          ui.viewingGardenId = null;
          ui.viewingRegionId = null;
          ui.viewingEssayMonth = null;
          ui.activeModal = 'auth';
          showToast('已登出帳號');
          renderApp();
        });
      };
    }
    bindCloseModal();
  }
}

function bindCloseModal() {
  const btn = document.getElementById('modal-close');
  if (btn) {
    btn.onclick = () => {
      ui.activeModal = null;
      renderModal();
    };
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 3.0;

function resolveRunMode(cloudConfig) {
  const params = new URLSearchParams(window.location.search || '');
  const urlMode = (params.get('mode') || '').trim().toLowerCase();
  if (urlMode === 'local') return 'local';
  if (urlMode === 'cloud') return 'cloud';

  // 若 localStorage 預置了純本機 GardenStore 狀態（user_me 且無雲端 session），自動以 local 模式載入以維持既有 L0 契約
  try {
    const rawState = localStorage.getItem('essay_garden_state_v4');
    const hasSession = Boolean(localStorage.getItem(SESSION_STORAGE_KEY));
    if (rawState && !hasSession) {
      const parsed = JSON.parse(rawState);
      if (parsed && parsed.currentUserId === 'user_me' && !parsed.cloudCacheVersion) {
        return 'local';
      }
    }
  } catch (_err) {
    // ignore
  }

  if (cloudConfig && cloudConfig.mode === 'cloud' && cloudConfig.gasWebAppUrl) {
    return 'cloud';
  }
  return 'local';
}

// ============================================================================
// 5. 啟動初始化
// ============================================================================
async function boot() {
  initStaticIcons();
  const [cfgRes, catRes, cloudCfg] = await Promise.all([
    fetch(`./game-config.json?v=${ASSET_VER}`),
    fetch(`./catalog.json?v=${ASSET_VER}`),
    fetch(`./cloud-config.json?v=${ASSET_VER}`).then(r => (r.ok ? r.json() : { mode: 'local' })).catch(() => ({ mode: 'local' }))
  ]);
  config = await cfgRes.json();
  catalog = await catRes.json();
  buildSpriteRuleMaps(config.spriteScale);

  const runMode = resolveRunMode(cloudCfg);
  if (runMode === 'cloud' && cloudCfg.gasWebAppUrl) {
    store = new CloudGardenStore(config, catalog, {
      gasWebAppUrl: cloudCfg.gasWebAppUrl,
      onAuthInvalid: () => {
        ui.activeModal = 'auth';
        renderApp();
        showToast('登入憑證已失效，請重新輸入帳號密碼');
      }
    });
    if (!store.isAuthenticated()) {
      ui.activeModal = 'auth';
    }
  } else {
    store = new GardenStore(config, catalog);
  }

  const enterFullGarden = () => {
    clearEssaysTransition();
    resetGardenView();
    ui.screen = 'garden';
    renderApp();
  };
  document.getElementById('home-garden-card').onclick = enterFullGarden;
  document.getElementById('btn-enter-fullscreen-garden').onclick = enterFullGarden;

  // 防止花園頁雙指手勢觸發瀏覽器整頁放大（連同上下操作列），確保只有花園舞台區域縮放
  const gardenScreen = document.getElementById('screen-garden');
  const preventNativeMultiTouchZoom = (e) => {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  };
  gardenScreen.addEventListener('touchstart', preventNativeMultiTouchZoom, { passive: false });
  gardenScreen.addEventListener('touchmove', preventNativeMultiTouchZoom, { passive: false });
  const preventSafariGesture = (e) => {
    if (ui.screen === 'garden') e.preventDefault();
  };
  document.addEventListener('gesturestart', preventSafariGesture, { passive: false });
  document.addEventListener('gesturechange', preventSafariGesture, { passive: false });

  // 綁定花園島嶼的拖移與雙指縮放檢視（支援雙指捏合只放大花園島，並依土地大小與 zoom 調整拖移邊界）
  const bindIslandViewport = (containerEl, svgEl, { allowZoom = false, topPadPx = ISLAND_FULL_TOP_PAD_PX } = {}) => {
    const activePointers = new Map();
    let panStart = null;
    let pinchStart = null;

    const applyTransform = () => {
      const g = svgEl.querySelector('.island-pan-layer');
      if (g) g.setAttribute('transform', getIslandTransform(ui.pan, ui.zoom));
    };

    const clampPan = (px, py, z) => clampIslandPan(containerEl, svgEl, px, py, z, { topPadPx });

    const applyZoomFrom = (targetZoom, anchorVb, origZoom, origPanX, origPanY, origVb = anchorVb) => {
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
      const ratio = newZoom / origZoom;
      ui.zoom = newZoom;
      ui.pan = clampPan(
        anchorVb.x - (origVb.x - origPanX) * ratio,
        anchorVb.y - (origVb.y - origPanY) * ratio,
        newZoom
      );
      applyTransform();
    };

    const screenToVb = (clientX, clientY) => {
      const rect = svgEl.getBoundingClientRect();
      const vb = svgEl.viewBox.baseVal;
      const scale = Math.min(rect.width / vb.width, rect.height / vb.height) || 1;
      return {
        x: vb.x + vb.width / 2 + (clientX - (rect.left + rect.width / 2)) / scale,
        y: vb.y + vb.height / 2 + (clientY - (rect.top + rect.height / 2)) / scale,
        pxToVb: 1 / scale
      };
    };

    const startPinch = () => {
      const [p1, p2] = [...activePointers.values()];
      const dist = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
      const midVb = screenToVb((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      pinchStart = { dist, midVbX: midVb.x, midVbY: midVb.y, zoom: ui.zoom, panX: ui.pan.x, panY: ui.pan.y };
      panStart = null;
      ui.didDrag = true;
    };

    containerEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.pointerType === 'mouse') activePointers.clear();
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (allowZoom && activePointers.size === 2) {
        startPinch();
      } else if (activePointers.size === 1) {
        pinchStart = null;
        panStart = { ptrId: e.pointerId, clientX: e.clientX, clientY: e.clientY, panX: ui.pan.x, panY: ui.pan.y };
        ui.didDrag = false;
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (allowZoom && activePointers.size === 2 && pinchStart) {
        const [p1, p2] = [...activePointers.values()];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const newMidVb = screenToVb((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
        applyZoomFrom(pinchStart.zoom * (dist / pinchStart.dist), newMidVb, pinchStart.zoom, pinchStart.panX, pinchStart.panY, { x: pinchStart.midVbX, y: pinchStart.midVbY });
        return;
      }

      if (activePointers.size === 1 && panStart && panStart.ptrId === e.pointerId) {
        const dx = e.clientX - panStart.clientX;
        const dy = e.clientY - panStart.clientY;
        if (Math.hypot(dx, dy) > 6) ui.didDrag = true;
        if (ui.didDrag) {
          const { pxToVb } = screenToVb(e.clientX, e.clientY);
          ui.pan = clampPan(panStart.panX + dx * pxToVb, panStart.panY + dy * pxToVb, ui.zoom);
          applyTransform();
        }
      }
    });

    const endPtr = (e) => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.delete(e.pointerId);
      if (activePointers.size === 1) {
        const [remainId, pos] = [...activePointers.entries()][0];
        pinchStart = null;
        panStart = { ptrId: remainId, clientX: pos.x, clientY: pos.y, panX: ui.pan.x, panY: ui.pan.y };
      } else if (activePointers.size === 0) {
        pinchStart = null;
        panStart = null;
        setTimeout(() => { ui.didDrag = false; }, 30);
      }
    };
    window.addEventListener('pointerup', endPtr);
    window.addEventListener('pointercancel', endPtr);

    if (allowZoom) {
      containerEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const midVb = screenToVb(e.clientX, e.clientY);
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        applyZoomFrom(ui.zoom * factor, midVb, ui.zoom, ui.pan.x, ui.pan.y);
      }, { passive: false });
    }
  };

  bindIslandViewport(document.getElementById('full-garden-viewport'), document.getElementById('full-island-svg'), { allowZoom: true, topPadPx: ISLAND_FULL_TOP_PAD_PX });
  window.addEventListener('resize', () => {
    if (ui.screen === 'home' && lastIslandContext) {
      alignHomeIslandViewBox(lastIslandContext.evalData.region.size);
    } else if (ui.screen === 'garden' && lastIslandContext) {
      alignFullIslandViewBox(lastIslandContext.evalData.region.size);
    }
    updateEssayCardLineClamps();
  });

  const updateTailPullFeedback = (rowEl, pullPx) => {
    const tail = rowEl?.querySelector('[data-all-essays-tail]');
    if (!tail) return;
    const ready = pullPx >= TAIL_PULL_THRESHOLD_PX;
    const shift = pullPx > 0 ? Math.min(28, pullPx * 0.35) : 0;
    tail.style.transition = pullPx > 0 ? 'none' : 'transform 180ms ease';
    tail.style.transform = shift ? `translateX(-${shift.toFixed(1)}px)` : '';
    const arrow = tail.querySelector('[data-tail-arrow]');
    const label = tail.querySelector('[data-tail-label]');
    if (arrow) {
      arrow.classList.toggle('bg-[#2b5e4e]', ready);
      arrow.classList.toggle('text-[#fffdf8]', ready);
      arrow.classList.toggle('bg-[#2b5e4e]/12', !ready);
      arrow.classList.toggle('text-[#2b5e4e]', !ready);
    }
    if (label) {
      label.innerHTML = ready ? '放開即可<br/>查看全部' : '向左滑動<br/>查看全部';
    }
  };

  const bindEssayRowDrag = (rootEl, { enableTailPull = false } = {}) => {
    if (!rootEl) return;
    let drag = null;
    let resetTimer = null;

    rootEl.addEventListener('selectstart', (e) => {
      if (e.target.closest('.essay-scroll-row')) e.preventDefault();
    });
    rootEl.addEventListener('dragstart', (e) => {
      if (e.target.closest('.essay-scroll-row')) e.preventDefault();
    });

    rootEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if (e.target.closest('[data-react-btn]') || e.target.closest('[data-empty-write]')) return;
      const rowEl = e.target.closest('.essay-scroll-row');
      if (!rowEl) return;
      e.preventDefault();
      clearTimeout(resetTimer);
      ui.carouselDidDrag = false;
      drag = {
        rowEl,
        pointerId: e.pointerId,
        startX: e.clientX,
        startScrollLeft: rowEl.scrollLeft,
        dragged: false,
        overscroll: 0
      };
    });

    window.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (!drag.dragged && Math.abs(dx) > 5) {
        drag.dragged = true;
        ui.carouselDidDrag = true;
        closeReactionTray();
        drag.rowEl.classList.add('is-dragging');
      }
      if (drag.dragged) {
        const maxScroll = Math.max(0, drag.rowEl.scrollWidth - drag.rowEl.clientWidth);
        const targetScroll = drag.startScrollLeft - dx;
        drag.rowEl.scrollLeft = Math.max(0, Math.min(maxScroll, targetScroll));
        if (enableTailPull && drag.rowEl.querySelector('[data-all-essays-tail]')) {
          drag.overscroll = Math.max(0, targetScroll - maxScroll);
          updateTailPullFeedback(drag.rowEl, drag.overscroll);
        }
      }
    });

    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const { rowEl, dragged: wasDragged, overscroll } = drag;
      drag = null;
      rowEl.classList.remove('is-dragging');
      if (enableTailPull) updateTailPullFeedback(rowEl, 0);
      if (wasDragged) {
        resetTimer = setTimeout(() => { ui.carouselDidDrag = false; }, 50);
      }
      if (enableTailPull && e.type === 'pointerup' && overscroll >= TAIL_PULL_THRESHOLD_PX) {
        openAllEssaysScreen();
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    if (enableTailPull) {
      let touchPull = null;
      rootEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || e.target.closest('[data-react-btn]')) return;
        touchPull = {
          startX: e.touches[0].clientX,
          startY: e.touches[0].clientY,
          startScrollLeft: rootEl.scrollLeft,
          overscroll: 0
        };
      }, { passive: true });
      rootEl.addEventListener('touchmove', (e) => {
        if (!touchPull || e.touches.length !== 1 || !rootEl.querySelector('[data-all-essays-tail]')) return;
        const dx = touchPull.startX - e.touches[0].clientX;
        const dy = Math.abs(touchPull.startY - e.touches[0].clientY);
        const maxScroll = Math.max(0, rootEl.scrollWidth - rootEl.clientWidth);
        if (Math.abs(dx) > dy && rootEl.scrollLeft >= maxScroll - 2) {
          touchPull.overscroll = Math.max(0, dx - Math.max(0, maxScroll - touchPull.startScrollLeft));
          updateTailPullFeedback(rootEl, touchPull.overscroll);
        }
      }, { passive: true });
      const endTouch = (e) => {
        if (!touchPull) return;
        const pulled = touchPull.overscroll;
        touchPull = null;
        updateTailPullFeedback(rootEl, 0);
        if (e.type === 'touchend' && pulled >= TAIL_PULL_THRESHOLD_PX) {
          openAllEssaysScreen();
        }
      };
      rootEl.addEventListener('touchend', endTouch);
      rootEl.addEventListener('touchcancel', endTouch);
    }
  };
  bindEssayRowDrag(document.getElementById('essay-carousel'), { enableTailPull: true });
  bindEssayRowDrag(document.getElementById('essays-day-list'), { enableTailPull: false });

  document.getElementById('full-island-svg').onclick = (e) => {
    if (ui.didDrag || !lastIslandContext) return;
    const poly = e.target.closest('[data-cell-x]');
    if (!poly) return;
    const x = parseInt(poly.dataset.cellX, 10);
    const y = parseInt(poly.dataset.cellY, 10);
    handleGardenCellClick(lastIslandContext.viewGarden.id, lastIslandContext.evalData, x, y);
  };

  const closeDismissibleModal = () => {
    if (reactionState.tray) {
      closeReactionTray();
      return;
    }
    if (ui.activeModal && ui.activeModal !== 'theme_picker' && ui.activeModal !== 'auth') {
      ui.activeModal = null;
      renderModal();
    }
  };
  document.getElementById('modal-overlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeDismissibleModal();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDismissibleModal();
  });

  initReactionTrayHandlers();

  document.getElementById('btn-back-home').onclick = goHome;
  document.getElementById('btn-essays-back-home').onclick = goHome;

  document.getElementById('btn-cancel-placing').onclick = () => {
    ui.placingMode = null;
    renderApp();
  };

  document.querySelectorAll('[data-open-modal]').forEach(btn => {
    btn.onclick = () => {
      if (store.isCloud && !store.isAuthenticated()) {
        ui.activeModal = 'auth';
        renderModal();
        return;
      }
      ui.activeModal = btn.dataset.openModal;
      renderModal();
    };
  });

  // 初始化動態天候與背景深模組（綁定 Store 狀態訂閱接縫）
  bgManager.init({
    stageId: 'app-container',
    backLayerId: 'dynamic-bg-layer',
    foreLayerId: 'dynamic-fg-layer',
    store
  });

  window.__store = store;
  window.__bgManager = bgManager;
  window.__renderApp = renderApp;

  // 首屏立即渲染（若有 localStorage 快取則 < 300ms 秒開首繪，無須等待 GAS 回應）
  renderApp();

  // 背景同步雲端最新狀態（Stale-While-Revalidate）
  if (store.isCloud && store.isAuthenticated()) {
    store.initSession()
      .then(() => {
        renderApp();
      })
      .catch((err) => {
        if (err?.code === 'AUTH_INVALID') {
          ui.activeModal = 'auth';
          renderApp();
        } else {
          showToast(err?.message || '目前為離線模式，顯示本機快取資料');
        }
      });
  }
}

boot();
