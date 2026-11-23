// 隨筆花園：動態天候與背景管理深模組 (Deep Module)
// 封裝 5 款動態背景（晴空白雲、黃昏暮霞、靜謐星河、雨後彩虹、夢幻泡泡）
// 支援 DOMAdapter（瀏覽器生產環境）與 VirtualAdapter（無 DOM 記憶體單元測試環境）
// 支援 bindStore(store) 狀態訂閱接縫，由 Store 狀態變更單向驅動

const BG_STYLE_ID = 'essay-garden-dynamic-bg-styles';

// =========================================================================
// 1. 動態 CSS 樣式定義（只在 DOMAdapter init 時注入一次）
// =========================================================================
const CSS_RULES = `
  /* 強制圖層層疊上下文契約：後景在小島(z-10)之下，前景在小島(z-10)之上且低於隨筆與懸浮導覽 UI */
  #dynamic-bg-layer { z-index: 0 !important; pointer-events: none !important; }
  #dynamic-fg-layer { z-index: 25 !important; pointer-events: none !important; }

  /* 背景主題漸層 */
  .bg-theme-morning {
    background: linear-gradient(180deg, #8dc5d8 0%, #b8dddc 42%, #dbeef0 75%, #f4f8f7 100%) !important;
  }
  .bg-theme-sunset {
    background: linear-gradient(180deg, #1d1b46 0%, #3e3268 25%, #76476e 50%, #c4645c 74%, #f2b87e 100%) !important;
  }
  .bg-theme-night {
    background: linear-gradient(180deg, #090e1f 0%, #101730 38%, #162440 72%, #22354c 100%) !important;
  }
  .bg-theme-rain {
    background: linear-gradient(180deg, #b8e2d9 0%, #d8f0e8 48%, #eef7f1 100%) !important;
  }
  .bg-theme-bubbles {
    background: linear-gradient(180deg, #abd9cf 0%, #cfe6eb 48%, #f3ebf2 100%) !important;
  }

  /* 雲朵橫向飄動 */
  @keyframes cloudFloatLeftToRight {
    0% { transform: translateX(-240px); }
    100% { transform: translateX(450px); }
  }

  /* 落日呼吸 */
  @keyframes sunsetSunPulse {
    0%, 100% { transform: scale(1); opacity: 0.85; filter: drop-shadow(0 0 25px rgba(255, 180, 100, 0.6)); }
    50% { transform: scale(1.06); opacity: 0.98; filter: drop-shadow(0 0 35px rgba(255, 140, 60, 0.85)); }
  }
  .anim-sunset-sun { animation: sunsetSunPulse 6.5s ease-in-out infinite; }

  /* 動態隨機星光週期 */
  @keyframes dynamicStarCycle {
    0% { transform: scale(0.2) rotate(0deg); opacity: 0; }
    20% { transform: scale(1.05) rotate(5deg); opacity: 0.95; }
    50% { transform: scale(1.25) rotate(10deg); opacity: 1; filter: drop-shadow(0 0 7px white); }
    80% { transform: scale(0.85) rotate(5deg); opacity: 0.7; }
    100% { transform: scale(0.2) rotate(0deg); opacity: 0; }
  }
  .dynamic-star-node {
    position: absolute;
    pointer-events: none;
    animation: dynamicStarCycle ease-in-out forwards;
  }

  /* 流星軌跡：同向平行傾角 -48deg，自右上向左下優雅劃破天際（時長翻倍，前 48% 悠長滑行） */
  @keyframes meteorFlyGlide {
    0% {
      transform: translate(220px, -244px) rotate(-48deg);
      opacity: 0;
    }
    4% { opacity: 1; }
    48% {
      transform: translate(-420px, 466px) rotate(-48deg);
      opacity: 0;
    }
    100% {
      transform: translate(-420px, 466px) rotate(-48deg);
      opacity: 0;
    }
  }
  .meteor-track {
    position: absolute;
    opacity: 0;
    transform: translate(220px, -244px) rotate(-48deg);
    animation: meteorFlyGlide var(--meteor-dur, 15s) cubic-bezier(0.15, 0.25, 0.2, 1) infinite var(--meteor-del, 0s) both;
    pointer-events: none;
    will-change: transform, opacity;
  }

  /* 雨後彩虹 18秒天氣循環 */
  @keyframes rainPhaseControl {
    0%, 38.89% {
      opacity: 0.95;
      transform: translateY(0);
    }
    50% {
      opacity: 0;
      transform: translateY(6px);
    }
    94.43% {
      opacity: 0;
      transform: translateY(6px);
    }
    94.44%, 100% {
      opacity: 0.95;
      transform: translateY(0);
    }
  }
  .anim-rain-weather-cycle { animation: rainPhaseControl 18s ease-in-out infinite; }

  /* 彩虹展開與結束動畫：疊合雙動畫（Opacity 淡出 13.5s~17.0s，Clip-path 收合消失 14.0s~17.0s），無停頓感 */
  @keyframes rainbowFadeDeep {
    0%, 44.44% {
      opacity: 0;
    }
    45% {
      opacity: 0.15;
    }
    58% {
      opacity: 0.95;
    }
    75% {
      opacity: 0.95;
    }
    94.44%, 100% {
      opacity: 0;
    }
  }

  @keyframes rainbowClipDeep {
    0%, 44.44% {
      clip-path: polygon(0 0, 0% 0, 0% 100%, 0 100%);
    }
    45% {
      clip-path: polygon(0 0, 5% 0, 5% 100%, 0 100%);
    }
    58% {
      clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
    }
    77.78% {
      clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
    }
    94.44%, 100% {
      clip-path: polygon(100% 0, 100% 0, 100% 100%, 100% 100%);
    }
  }
  /* 彩虹自適應定位舞台：預設（全螢幕模式）維持在頂部大跨度天際 (top: 8%)；首頁模式縮小並下移剛好出現在島上 (top: 48%, scale: 0.68) */
  .rainbow-stage-wrapper {
    position: absolute;
    top: 8%;
    left: 50%;
    transform: translateX(-50%) scale(1);
    transform-origin: center top;
    width: 94%;
    max-width: 430px;
    pointer-events: none;
    will-change: top, transform;
  }
  #app-container[data-screen="home"] .rainbow-stage-wrapper {
    top: calc(48% - 30px) !important;
    transform: translateX(-50%) scale(0.80) !important;
  }

  .anim-rainbow-deep {
    animation:
      rainbowFadeDeep 18s cubic-bezier(0.35, 0, 0.25, 1) infinite,
      rainbowClipDeep 18s cubic-bezier(0.35, 0, 0.25, 1) infinite;
  }

  /* 雲隙斜光束（God Rays）溫潤微光呼吸 */
  @keyframes godRaysShimmer {
    0%, 100% { opacity: 0.65; transform: scale(1); }
    50% { opacity: 0.95; transform: scale(1.02); }
  }
  .anim-god-rays {
    animation: godRaysShimmer 7s ease-in-out infinite alternate;
    pointer-events: none;
  }

  /* 陽光水氣光斑漂浮 */
  @keyframes bokehDrift {
    0%, 100% { transform: translateY(0px) scale(0.9); opacity: 0.4; }
    50% { transform: translateY(-12px) scale(1.15); opacity: 0.9; }
  }
  .anim-bokeh-drift {
    animation: bokehDrift var(--b-dur, 6s) ease-in-out infinite alternate var(--b-del, 0s);
    pointer-events: none;
  }

  /* 自然微斜雨絲：傾角約 16°（rotate(-74deg)），飄落 (↙)，更透明輕盈 */
  @keyframes rainLocalGlide {
    0% {
      transform: translateX(200px);
      opacity: 0;
    }
    18% { opacity: 0.45; }
    82% { opacity: 0.45; }
    100% {
      transform: translateX(-260px);
      opacity: 0;
    }
  }
  .rain-track {
    position: absolute;
    transform: rotate(-74deg);
    transform-origin: center center;
    pointer-events: none;
  }
  /* 前景與後景統一粗細 (2.2px)，長度 44px，預設 opacity: 0 與 animation both 徹底杜絕切換停滯 */
  .rain-bar, .rain-bar-fg {
    width: 44px;
    height: 2.2px;
    opacity: 0;
    border-radius: 9999px;
    animation: rainLocalGlide 2.2s linear infinite 0s both;
  }
  .rain-bar {
    background: linear-gradient(to right, rgba(255, 255, 255, 0.75) 0%, rgba(56, 189, 248, 0.48) 45%, rgba(14, 165, 233, 0.22) 80%, transparent 100%);
    box-shadow: 0 0 3px rgba(56, 189, 248, 0.25);
  }
  .rain-bar-fg {
    background: linear-gradient(to right, rgba(255, 255, 255, 0.8) 0%, rgba(56, 189, 248, 0.52) 45%, rgba(14, 165, 233, 0.25) 80%, transparent 100%);
    box-shadow: 0 0 3px rgba(56, 189, 248, 0.28);
  }

  /* 肥皂泡漂浮外層容器：專責 Y 軸緩緩升騰（在隨機高度：島中心點高度 -460px ~ 標題區塊下緣 -760px 自然破裂淡出） */
  @keyframes soapBubbleRiseUp {
    0% { transform: translateY(0); opacity: 0; }
    8% { opacity: 0.95; }
    82% { opacity: 0.95; }
    94% { opacity: 0; transform: translateY(calc(var(--rise-h, -620px) * 0.95)); }
    100% { opacity: 0; transform: translateY(var(--rise-h, -620px)); }
  }
  .bubble-riser {
    position: absolute;
    animation: soapBubbleRiseUp var(--dur, 11s) linear infinite var(--del, 0s);
    pointer-events: none;
    will-change: transform;
  }

  /* 肥皂泡微擺內層容器：專責 X 軸隨風微擺與表面張力微彈性 */
  @keyframes soapBubbleWobbleInner {
    0% { transform: translateX(-16px) rotate(-3deg) scaleY(0.97) scaleX(1.03); }
    50% { transform: translateX(0px) rotate(2deg) scaleY(1.02) scaleX(0.98); }
    100% { transform: translateX(16px) rotate(-2deg) scaleY(0.96) scaleX(1.04); }
  }
  .bubble-wobbler {
    animation: soapBubbleWobbleInner 4.2s ease-in-out infinite alternate;
    pointer-events: none;
  }
`;

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(BG_STYLE_ID)) return;
  const styleEl = document.createElement('style');
  styleEl.id = BG_STYLE_ID;
  styleEl.textContent = CSS_RULES;
  document.head.appendChild(styleEl);
}

// =========================================================================
// 2. 幾何演算法與 SVG 生成器
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
  let u2 = nextPrng();
  while (u1 <= 1e-7) u1 = nextPrng();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdev;
}

export function makeMorningCloudSvg(scale, opacity, id) {
  return `
    <svg viewBox="0 0 320 180" width="${320 * scale}" height="${180 * scale}" class="overflow-visible" style="opacity: ${opacity}; pointer-events: none;">
      <defs>
        <linearGradient id="cloudGrad_${id}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="65%" stop-color="#f0f6f9"/>
          <stop offset="100%" stop-color="#d4e3eb"/>
        </linearGradient>
        <filter id="cloudFeather_${id}" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.8" result="softEdge"/>
          <feDropShadow dx="0" dy="5" stdDeviation="4.5" flood-color="#2a5368" flood-opacity="0.14"/>
        </filter>
      </defs>
      <g filter="url(#cloudFeather_${id})">
        <path d="M 55 135 C 25 135, 12 115, 20 95 C 15 72, 38 52, 62 56 C 78 28, 115 18, 145 28 C 170 10, 212 14, 232 40 C 260 30, 290 52, 295 80 C 318 90, 322 118, 305 135 Z" fill="url(#cloudGrad_${id})"/>
        <circle cx="145" cy="50" r="26" fill="#ffffff" opacity="0.65"/>
        <circle cx="205" cy="54" r="30" fill="#ffffff" opacity="0.6"/>
        <circle cx="85" cy="72" r="20" fill="#ffffff" opacity="0.55"/>
        <ellipse cx="165" cy="115" rx="85" ry="16" fill="#e0ecf2" opacity="0.7"/>
      </g>
    </svg>`;
}

export function makeSunsetCloudSvg(scale, opacity, id) {
  return `
    <svg viewBox="0 0 340 180" width="${340 * scale}" height="${180 * scale}" class="overflow-visible" style="opacity: ${opacity}; pointer-events: none;">
      <defs>
        <linearGradient id="sunsetCloudGrad_${id}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#fed7aa"/>
          <stop offset="25%" stop-color="#fca5a5"/>
          <stop offset="70%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#47265a"/>
        </linearGradient>
        <linearGradient id="goldRim_${id}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fef08a"/>
          <stop offset="50%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#ec4899"/>
        </linearGradient>
        <filter id="sunsetCloudFeather_${id}" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.6" result="softEdge"/>
          <feDropShadow dx="0" dy="6" stdDeviation="5.5" flood-color="#180c2e" flood-opacity="0.32"/>
        </filter>
      </defs>
      <g filter="url(#sunsetCloudFeather_${id})">
        <path d="M 60 135 C 30 135, 14 115, 22 95 C 16 70, 42 50, 68 54 C 85 24, 122 15, 155 25 C 182 8, 225 12, 248 38 C 278 28, 308 50, 312 78 C 335 88, 338 116, 320 135 Z"
              fill="url(#sunsetCloudGrad_${id})" stroke="url(#goldRim_${id})" stroke-width="2.5"/>
        <path d="M 65 52 C 85 24, 122 15, 155 25 C 182 8, 225 12, 248 38 C 278 28, 308 50, 312 78"
              fill="none" stroke="#fef08a" stroke-width="3" opacity="0.85"/>
        <circle cx="155" cy="46" r="28" fill="#fed7aa" opacity="0.45"/>
        <circle cx="218" cy="50" r="32" fill="#fb923c" opacity="0.4"/>
        <ellipse cx="175" cy="118" rx="95" ry="16" fill="#6d3d7d" opacity="0.4"/>
      </g>
    </svg>`;
}

export function makeMicroCrossStarSvg(size = 18, color = '#ffffff') {
  const uid = Math.random().toString(36).slice(2, 6);
  return `
    <svg viewBox="0 0 48 48" width="${size}" height="${size}" class="overflow-visible" style="pointer-events: none;">
      <defs>
        <filter id="microCrossGlow_${uid}" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g filter="url(#microCrossGlow_${uid})">
        <!-- 主四向鑽石星芒 -->
        <path d="M 24 2 C 24 16, 18 20, 2 24 C 18 28, 24 32, 24 46 C 24 32, 30 28, 46 24 C 30 20, 24 16, 24 2 Z" fill="${color}"/>
        <!-- 45度微細輔助星芒 -->
        <path d="M 24 10 C 24 19, 20 21, 10 24 C 20 27, 24 29, 24 38 C 24 29, 28 27, 38 24 C 28 21, 24 19, 24 10 Z" fill="${color}" opacity="0.7" transform="rotate(45 24 24)"/>
        <!-- 核心耀白聚焦點 -->
        <circle cx="24" cy="24" r="2.8" fill="#ffffff"/>
      </g>
    </svg>`;
}

/**
 * 頂級璀璨流星 SVG 生成器：
 * - 前端耀眼鑽石星芒（純白熾心 + 青藍外暈 + 菱形星芒光針）
 * - 尾端錐形漸隱光軌（白 -> 電光青藍 -> 寶藍 -> 透明深空）
 */
export function makeMeteorSvg({ length = 150, isBolide = false, uid = null } = {}) {
  const id = uid || Math.random().toString(36).slice(2, 7);
  const headX = 14;
  const headY = 14;
  const totalW = length + 24;
  const totalH = 28;

  const rHoriz = isBolide ? 16 : 10;
  const rVert = isBolide ? 16 : 10;
  const rDiag = isBolide ? 8 : 5;
  const coreThick = isBolide ? 3.4 : 2.2;
  const sheathThick = isBolide ? 8.5 : 5.0;

  const tailCorePath = `M ${headX} ${headY - coreThick / 2} L ${totalW} ${headY - 0.4} L ${totalW} ${headY + 0.4} L ${headX} ${headY + coreThick / 2} Z`;
  const tailSheathPath = `M ${headX} ${headY - sheathThick / 2} L ${totalW} ${headY - 0.8} L ${totalW} ${headY + 0.8} L ${headX} ${headY + sheathThick / 2} Z`;

  const diagFlare = isBolide ? `
    <g transform="rotate(45 ${headX} ${headY})">
      <path d="M ${headX - rDiag} ${headY} Q ${headX} ${headY - 0.7} ${headX + rDiag} ${headY} Q ${headX} ${headY + 0.7} ${headX - rDiag} ${headY} Z" fill="#ffffff" opacity="0.85"/>
      <path d="M ${headX} ${headY - rDiag} Q ${headX - 0.7} ${headY} ${headX} ${headY + rDiag} Q ${headX + 0.7} ${headY} ${headX - rDiag} Z" fill="#ffffff" opacity="0.85"/>
    </g>` : '';

  return `
    <svg viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" class="overflow-visible" style="pointer-events: none;">
      <defs>
        <!-- 錐形光軌漸層：熾白熱核 -> 電光青藍 -> 寶藍 -> 深空隱曜 -->
        <linearGradient id="tailCore_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="10%" stop-color="#ffffff" stop-opacity="0.95"/>
          <stop offset="28%" stop-color="#38bdf8" stop-opacity="0.9"/>
          <stop offset="60%" stop-color="#2563eb" stop-opacity="0.55"/>
          <stop offset="85%" stop-color="#1e3a8a" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#1e3a8a" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="tailSheath_${id}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.85"/>
          <stop offset="25%" stop-color="#60a5fa" stop-opacity="0.6"/>
          <stop offset="65%" stop-color="#2563eb" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/>
        </linearGradient>
        <filter id="tailGlow_${id}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g>
        <!-- 外圍電光電漿護鞘 -->
        <path d="${tailSheathPath}" fill="url(#tailSheath_${id})" opacity="0.75" filter="url(#tailGlow_${id})"/>
        <!-- 內部高溫熾白光芯 -->
        <path d="${tailCorePath}" fill="url(#tailCore_${id})"/>
        <!-- 前端耀眼鑽石星芒：青藍外暈 + 寶藍散光 + 菱形星芒 + 熾白中心點 -->
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 14 : 8}" fill="#2563eb" opacity="0.35" filter="url(#tailGlow_${id})"/>
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 8 : 5}" fill="#38bdf8" opacity="0.75" filter="url(#tailGlow_${id})"/>
        <!-- 水平與垂直主星芒光針 -->
        <path d="M ${headX - rHoriz} ${headY} Q ${headX} ${headY - 1} ${headX + rHoriz} ${headY} Q ${headX} ${headY + 1} ${headX - rHoriz} ${headY} Z" fill="#ffffff"/>
        <path d="M ${headX} ${headY - rVert} Q ${headX - 1} ${headY} ${headX} ${headY + rVert} Q ${headX + 1} ${headY} ${headX} ${headY - rVert} Z" fill="#ffffff"/>
        ${diagFlare}
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 2.8 : 2.0}" fill="#ffffff"/>
      </g>
    </svg>`;
}

/**
 * 琳大花風格夢幻柔焦彩虹弧 SVG：
 * - 寬闊柔和馬卡龍水彩漸層（粉紅珊紅、杏桃、晨曦暖金、春芽嫩綠、天青水藍、溫柔鳶尾、夢幻粉紫）
 * - 高斯柔焦（feGaussianBlur stdDeviation 5.5）實現無邊界融合
 * - 兩側平滑羽化遮罩，優雅融入天際
 */
export function makeExactMathRainbowSvg() {
  const X0 = 200;
  const Y0 = 240;
  const cos15 = 0.9659;
  const sin15 = 0.2588;

  const arcs = [
    { r: 195, color: '#f472b6', opacity: 0.68, width: 16 }, // 柔粉珊紅
    { r: 187, color: '#fba866', opacity: 0.65, width: 16 }, // 溫暖杏桃
    { r: 179, color: '#fde047', opacity: 0.68, width: 16 }, // 晨曦暖金
    { r: 171, color: '#6ee7b7', opacity: 0.62, width: 16 }, // 嫩綠春芽
    { r: 163, color: '#38bdf8', opacity: 0.68, width: 16 }, // 天青水藍
    { r: 155, color: '#818cf8', opacity: 0.60, width: 16 }, // 溫柔鳶尾
    { r: 147, color: '#c084fc', opacity: 0.68, width: 16 }  // 夢幻粉紫
  ];

  const arcD = (r) => {
    const startX = (X0 - r * cos15).toFixed(2);
    const y = (Y0 - r * sin15).toFixed(2);
    const endX = (X0 + r * cos15).toFixed(2);
    return `M ${startX} ${y} A ${r} ${r} 0 0 1 ${endX} ${y}`;
  };

  const paths = arcs.map(arc =>
    `<path d="${arcD(arc.r)}" stroke="${arc.color}" stroke-opacity="${arc.opacity}" stroke-width="${arc.width}" stroke-linecap="round"/>`
  ).join('\n');

  return `
    <svg viewBox="0 0 400 250" class="w-full h-auto overflow-visible" style="pointer-events: none;">
      <defs>
        <linearGradient id="rainbowFade" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
          <stop offset="12%" stop-color="#ffffff" stop-opacity="0.95"/>
          <stop offset="88%" stop-color="#ffffff" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
        </linearGradient>
        <filter id="rainbowFeather" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="5.5" result="softBlur"/>
        </filter>
        <mask id="rainbowMask">
          <rect x="0" y="0" width="400" height="250" fill="url(#rainbowFade)"/>
        </mask>
      </defs>
      <g mask="url(#rainbowMask)" fill="none">
        <!-- 柔白光暈背襯（提升彩虹通透呼吸感） -->
        <path d="${arcD(171)}" stroke="#ffffff" stroke-width="58" stroke-opacity="0.35" filter="url(#rainbowFeather)"/>
        <!-- 七彩高斯柔焦色彩環 -->
        <g filter="url(#rainbowFeather)">
          ${paths}
        </g>
        <!-- 頂緣微光輪廓 -->
        <path d="${arcD(200)}" stroke="#ffffff" stroke-width="3" stroke-opacity="0.55" filter="url(#rainbowFeather)"/>
      </g>
    </svg>`;
}

/**
 * 雲隙斜光束（God Rays / Crepuscular Rays）：
 * 自天幕右上斜向穿透雲層，灑下溫暖晨曦金光
 */
export function makeGodRaysSvg() {
  return `
    <svg viewBox="0 0 400 400" preserveAspectRatio="none" class="anim-god-rays absolute inset-0 w-full h-full pointer-events-none">
      <defs>
        <linearGradient id="ray1" x1="80%" y1="0%" x2="20%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
          <stop offset="35%" stop-color="#fef08a" stop-opacity="0.32"/>
          <stop offset="75%" stop-color="#bae6fd" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="ray2" x1="90%" y1="0%" x2="35%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.6"/>
          <stop offset="40%" stop-color="#fde047" stop-opacity="0.35"/>
          <stop offset="85%" stop-color="#fbcfe8" stop-opacity="0.1"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="ray3" x1="65%" y1="0%" x2="5%" y2="100%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
          <stop offset="45%" stop-color="#fef08a" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </linearGradient>
        <filter id="rayGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="8.5"/>
        </filter>
      </defs>
      <g filter="url(#rayGlow)">
        <polygon points="260,-20 340,-20 120,420 40,420" fill="url(#ray1)"/>
        <polygon points="350,-20 420,-20 230,420 150,420" fill="url(#ray2)"/>
        <polygon points="180,-20 230,-20 30,420 -30,420" fill="url(#ray3)"/>
      </g>
    </svg>`;
}

/**
 * 發光水氣光斑（Sunlit Moisture Bokeh）：
 * 停雨時懸浮於空中的晶瑩水珠反射陽光星芒
 */
export function makeMoistureBokehHtml() {
  const particles = [
    { top: '14%', left: '24%', size: 12, dur: '5.2s', del: '0.2s', color: 'bg-white/60', sparkle: true },
    { top: '22%', left: '42%', size: 18, dur: '6.8s', del: '1.5s', color: 'bg-amber-100/50', sparkle: false },
    { top: '16%', left: '68%', size: 14, dur: '5.8s', del: '0.8s', color: 'bg-sky-200/55', sparkle: true },
    { top: '28%', left: '78%', size: 10, dur: '7.2s', del: '2.1s', color: 'bg-pink-200/45', sparkle: false },
    { top: '12%', left: '52%', size: 22, dur: '6.0s', del: '3.0s', color: 'bg-white/65', sparkle: true },
    { top: '30%', left: '32%', size: 13, dur: '5.5s', del: '1.2s', color: 'bg-emerald-100/50', sparkle: false },
    { top: '24%', left: '18%', size: 16, dur: '6.4s', del: '2.5s', color: 'bg-amber-200/40', sparkle: false }
  ];

  return particles.map(p => {
    const sparkleHtml = p.sparkle
      ? `<svg viewBox="0 0 24 24" class="w-full h-full text-white drop-shadow-[0_0_4px_rgba(255,255,255,0.8)]"><path d="M 12 2 Q 12 12 2 12 Q 12 12 12 22 Q 12 12 22 12 Q 12 12 12 2 Z" fill="#ffffff"/></svg>`
      : '';
    return `
      <div class="anim-bokeh-drift absolute rounded-full ${p.color} blur-[1.5px] pointer-events-none flex items-center justify-center"
           style="top: ${p.top}; left: ${p.left}; width: ${p.size}px; height: ${p.size}px; --b-dur: ${p.dur}; --b-del: ${p.del};">
        ${sparkleHtml}
      </div>
    `;
  }).join('');
}

/**
 * 立體肥皂泡晶球 SVG：
 * - 晶瑩通透 3D 球體（透光核心 + 彩暈邊緣）
 * - 細緻彩色薄膜干涉漸層
 * - 雙重亮白新月反光弧（左上約 10 點鐘主光源新月弧 + 右下約 4 點鐘次級環境反光弧）
 * - 外緣立體折射高光雙環
 */
export function makeRealSoapBubbleSvg(size = 54) {
  const uid = Math.random().toString(36).slice(2, 7);
  return `
    <svg viewBox="0 0 100 100" width="${size}" height="${size}" class="overflow-visible" style="pointer-events: none; filter: drop-shadow(0 6px 16px rgba(56, 189, 248, 0.4)) drop-shadow(0 2px 6px rgba(192, 132, 252, 0.25));">
      <defs>
        <!-- 晶球立體微光漸層（透光核心 + 彩暈邊緣） -->
        <radialGradient id="sphere_${uid}" cx="36%" cy="32%" r="64%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
          <stop offset="25%" stop-color="#ffffff" stop-opacity="0.08"/>
          <stop offset="65%" stop-color="#38bdf8" stop-opacity="0.12"/>
          <stop offset="85%" stop-color="#c084fc" stop-opacity="0.28"/>
          <stop offset="96%" stop-color="#f472b6" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#0284c7" stop-opacity="0.55"/>
        </radialGradient>
        <!-- 細緻彩色薄膜干涉漸層 -->
        <linearGradient id="film_${uid}" x1="12%" y1="15%" x2="88%" y2="85%">
          <stop offset="0%" stop-color="#f472b6" stop-opacity="0.48"/>
          <stop offset="22%" stop-color="#fbbf24" stop-opacity="0.42"/>
          <stop offset="45%" stop-color="#34d399" stop-opacity="0.45"/>
          <stop offset="70%" stop-color="#38bdf8" stop-opacity="0.52"/>
          <stop offset="88%" stop-color="#818cf8" stop-opacity="0.50"/>
          <stop offset="100%" stop-color="#c084fc" stop-opacity="0.58"/>
        </linearGradient>
        <!-- 下緣次級薄膜干涉彩虹弧漸層 -->
        <linearGradient id="swirl_${uid}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
          <stop offset="48%" stop-color="#4ade80" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#f472b6" stop-opacity="0.75"/>
        </linearGradient>
      </defs>
      <!-- 主泡泡球體與七彩薄膜干涉層 -->
      <circle cx="50" cy="50" r="44" fill="url(#sphere_${uid})"/>
      <circle cx="50" cy="50" r="44" fill="url(#film_${uid})"/>
      <!-- 外緣立體折射高光雙環 -->
      <circle cx="50" cy="50" r="44.5" fill="none" stroke="rgba(255,255,255,0.88)" stroke-width="1.6"/>
      <circle cx="50" cy="50" r="43.2" fill="none" stroke="url(#film_${uid})" stroke-width="1.8" opacity="0.65"/>
      <!-- 下緣彩虹色干涉反光弧線 -->
      <path d="M 22 72 A 36 36 0 0 0 78 72" fill="none" stroke="url(#swirl_${uid})" stroke-width="3.0" stroke-linecap="round" opacity="0.65" style="filter: blur(0.6px);"/>
      <!-- 主亮白新月反光弧（左上方約 10 點鐘方向，捕捉主光源） -->
      <path d="M 10.5 37.2 A 41.5 41.5 0 0 1 48.6 8.5 A 37 37 0 0 0 14.8 38.6 Q 11.5 38.5 10.5 37.2 Z" fill="#ffffff" opacity="0.96"/>
      <!-- 主反光高光聚焦點與伴星微點 -->
      <ellipse cx="45" cy="15" rx="3.5" ry="1.8" transform="rotate(-30 45 15)" fill="#ffffff" opacity="0.95"/>
      <circle cx="18" cy="42" r="1.8" fill="#ffffff" opacity="0.9"/>
      <!-- 次級亮白新月反光弧（右下方約 4 點鐘方向，捕捉環境反光） -->
      <path d="M 67.5 87.6 A 41.5 41.5 0 0 0 90.1 60.7 A 38.5 38.5 0 0 1 69.2 84.8 Z" fill="#ffffff" opacity="0.65"/>
      <path d="M 64 88 A 42 42 0 0 0 89 63" fill="none" stroke="rgba(56, 189, 248, 0.7)" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
}

// =========================================================================
// 3. 5 款代表圖 SVG（用於全螢幕頂部背景卡框與商店清單）
// =========================================================================
export function makeThumbnailSvg(themeId) {
  const inner = (() => {
    switch (themeId) {
      case 'morning':
        return `
          <rect width="40" height="40" fill="url(#tGradMorning)"/>
          <defs>
            <linearGradient id="tGradMorning" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#8dc5d8"/><stop offset="100%" stop-color="#f4f8f7"/>
            </linearGradient>
          </defs>
          <circle cx="31" cy="9" r="6" fill="#fde047" opacity="0.9"/>
          <path d="M 10 28 C 6 28 4 24 6 20 C 5 15 11 11 16 12 C 20 6 28 8 30 14 C 35 15 36 21 33 25 C 31 28 27 28 25 28 Z" fill="#ffffff" opacity="0.95"/>`;
      case 'sunset':
        return `
          <rect width="40" height="40" fill="url(#tGradSunset)"/>
          <defs>
            <linearGradient id="tGradSunset" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#3e3268"/><stop offset="60%" stop-color="#c4645c"/><stop offset="100%" stop-color="#f2b87e"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="24" r="8" fill="#fed7aa" opacity="0.95"/>
          <path d="M 4 33 C 12 30 28 30 36 33 Z" fill="#47265a" opacity="0.7"/>
          <path d="M 8 26 C 14 20 26 21 32 26 Z" fill="#fed7aa" opacity="0.6"/>`;
      case 'night':
        return `
          <rect width="40" height="40" fill="url(#tGradNight)"/>
          <defs>
            <linearGradient id="tGradNight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#090e1f"/><stop offset="100%" stop-color="#22354c"/>
            </linearGradient>
            <linearGradient id="tGradMeteor" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ffffff"/>
              <stop offset="35%" stop-color="#38bdf8"/>
              <stop offset="80%" stop-color="#2563eb"/>
              <stop offset="100%" stop-color="transparent"/>
            </linearGradient>
          </defs>
          <path d="M 12 12 Q 12 16 8 16 Q 12 16 12 20 Q 12 16 16 16 Q 12 16 12 12 Z" fill="#ffffff"/>
          <circle cx="28" cy="22" r="1.5" fill="#bae6fd"/>
          <!-- 傾斜 -48° 璀璨流星（前端白熾星芒，尾端寶藍漸隱） -->
          <line x1="13" y1="29" x2="33" y2="9" stroke="url(#tGradMeteor)" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="13" cy="29" r="2.2" fill="#ffffff"/>
          <circle cx="13" cy="29" r="4.0" fill="#38bdf8" opacity="0.7"/>`;
      case 'rain':
        return `
          <rect width="40" height="40" fill="url(#tGradRain)"/>
          <defs>
            <linearGradient id="tGradRain" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#b8e2d9"/><stop offset="48%" stop-color="#d8f0e8"/><stop offset="100%" stop-color="#eef7f1"/>
            </linearGradient>
          </defs>
          <!-- 琳大花柔美馬卡龍彩虹弧 -->
          <path d="M 6 30 A 18 18 0 0 1 34 30" fill="none" stroke="#f472b6" stroke-width="2.5" opacity="0.75"/>
          <path d="M 8 30 A 15 15 0 0 1 32 30" fill="none" stroke="#fde047" stroke-width="2.5" opacity="0.75"/>
          <path d="M 10 30 A 12 12 0 0 1 30 30" fill="none" stroke="#38bdf8" stroke-width="2.5" opacity="0.75"/>
          <!-- 雲隙斜光束 -->
          <line x1="30" y1="4" x2="16" y2="28" stroke="#ffffff" stroke-width="1.8" opacity="0.5" stroke-dasharray="2 2"/>
          <line x1="20" y1="12" x2="17" y2="22" stroke="#ffffff" stroke-width="1.2" opacity="0.75"/>`;
      case 'bubbles':
        return `
          <rect width="40" height="40" fill="url(#tGradBubbles)"/>
          <defs>
            <linearGradient id="tGradBubbles" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#abd9cf"/><stop offset="100%" stop-color="#f3ebf2"/>
            </linearGradient>
            <radialGradient id="tBubbleSphere" cx="35%" cy="32%" r="65%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.6"/>
              <stop offset="60%" stop-color="#38bdf8" stop-opacity="0.2"/>
              <stop offset="100%" stop-color="#c084fc" stop-opacity="0.5"/>
            </radialGradient>
          </defs>
          <!-- 立體泡泡晶球 -->
          <circle cx="16" cy="22" r="9" fill="url(#tBubbleSphere)" stroke="#ffffff" stroke-width="1.2"/>
          <path d="M 11 18 A 6 6 0 0 1 18 15" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="27" cy="14" r="6" fill="url(#tBubbleSphere)" stroke="#ffffff" stroke-width="1.0" opacity="0.85"/>`;
      default:
        return '';
    }
  })();
  if (!inner) return '';
  return `
        <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">${inner}
        </svg>`;
}

// 預設主題型錄（若 Store 尚未載入 catalog 則作為 fallback）
const DEFAULT_THEME_CATALOG = [
  { id: 'morning', name: '晴空白雲', cost: 0, desc: '高斯常態分佈高度與負反饋生成，近景雲朵緩緩掠過花園島上方。' },
  { id: 'sunset', name: '黃昏暮霞', cost: 50, desc: '吉卜力金邊晚霞、暖光暮日呼吸與深邃漸層天幕。' },
  { id: 'night', name: '靜謐星河', cost: 60, desc: '漫天璀璨鑽石星芒，向左下方劃落的 -48° 耀眼流星雨與深邃星河。' },
  { id: 'rain', name: '雨後彩虹', cost: 80, desc: '琳大花風格夢幻柔焦彩虹弧、雲隙斜光束與微風舒緩細雨。' },
  { id: 'bubbles', name: '夢幻泡泡', cost: 80, desc: '立體肥皂泡晶球、細緻彩色薄膜干涉、雙重亮白新月反光與隨風微擺。' }
];

// =========================================================================
// 4. 適配器接縫定義 (Adapter Seams)
// =========================================================================

/**
 * 瀏覽器真實 DOM 適配器（生產環境）
 */
export class DOMAdapter {
  constructor({ stageId = 'app-container', backLayerId = 'dynamic-bg-layer', foreLayerId = 'dynamic-fg-layer' } = {}) {
    this.stageId = stageId;
    this.backLayerId = backLayerId;
    this.foreLayerId = foreLayerId;
    this._stage = null;
    this._back = null;
    this._fore = null;
  }

  init() {
    injectStyles();
    if (typeof document !== 'undefined') {
      this._stage = document.getElementById(this.stageId);
      this._back = document.getElementById(this.backLayerId);
      this._fore = document.getElementById(this.foreLayerId);
    }
  }

  setStageClass(className, removeClasses = []) {
    if (this._stage) {
      removeClasses.forEach(c => this._stage.classList.remove(c));
      this._stage.classList.add(className);
    }
  }

  setStageScreen(screenName) {
    if (!this._stage) return;
    if (screenName) {
      this._stage.dataset.screen = screenName;
    } else {
      delete this._stage.dataset.screen;
    }
  }

  clearLayers() {
    if (this._back) this._back.innerHTML = '';
    if (this._fore) this._fore.innerHTML = '';
  }

  appendBack(el) {
    if (this._back && el) this._back.appendChild(el);
  }

  appendFore(el) {
    if (this._fore && el) this._fore.appendChild(el);
  }

  setBackHtml(html) {
    if (this._back) this._back.innerHTML = html;
  }

  setForeHtml(html) {
    if (this._fore) this._fore.innerHTML = html;
  }

  createElement(tag, className = '', innerHTML = '') {
    if (typeof document === 'undefined') return null;
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
  }

  setInterval(fn, ms) {
    return globalThis.setInterval ? globalThis.setInterval(fn, ms) : null;
  }

  clearInterval(id) {
    if (globalThis.clearInterval && id) globalThis.clearInterval(id);
  }

  setTimeout(fn, ms) {
    return globalThis.setTimeout ? globalThis.setTimeout(fn, ms) : null;
  }

  clearTimeout(id) {
    if (globalThis.clearTimeout && id) globalThis.clearTimeout(id);
  }
}

/**
 * 記憶體虛擬適配器（Node.js 純單元測試環境，零 DOM 依賴）
 */
export class VirtualAdapter {
  constructor() {
    this.currentStageClass = '';
    this.currentScreen = '';
    this.backNodes = [];
    this.foreNodes = [];
    this.intervals = new Map();
    this.timeouts = new Map();
    this._nextId = 1;
  }

  init() {}

  setStageClass(className, removeClasses = []) {
    this.currentStageClass = className;
  }

  setStageScreen(screenName) {
    this.currentScreen = screenName;
  }

  clearLayers() {
    this.backNodes = [];
    this.foreNodes = [];
  }

  appendBack(el) {
    this.backNodes.push(el);
  }

  appendFore(el) {
    this.foreNodes.push(el);
  }

  setBackHtml(html) {
    this.backNodes = [{ tag: 'div', innerHTML: html, style: {}, className: '' }];
  }

  setForeHtml(html) {
    this.foreNodes = [{ tag: 'div', innerHTML: html, style: {}, className: '' }];
  }

  createElement(tag, className = '', innerHTML = '') {
    return {
      tag,
      className,
      innerHTML,
      style: {},
      addEventListener: () => {},
      remove: () => {}
    };
  }

  setInterval(fn, ms) {
    const id = this._nextId++;
    this.intervals.set(id, { fn, ms });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }

  setTimeout(fn, ms) {
    const id = this._nextId++;
    this.timeouts.set(id, { fn, ms });
    return id;
  }

  clearTimeout(id) {
    this.timeouts.delete(id);
  }
}

// =========================================================================
// 5. 背景管理深模組核心實作 (BgManager Class)
// =========================================================================
export class BgManager {
  constructor({ adapter = null } = {}) {
    this.adapter = adapter || new DOMAdapter();
    this.store = null;
    this.unsubscribeStore = null;
    this.currentThemeId = 'morning';

    // 引擎生命週期管理
    this.cloudTimer = null;
    this.activeClouds = new Set();
    this.starTimeouts = [];
  }

  /**
   * 初始化
   */
  init({
    stageId = 'app-container',
    backLayerId = 'dynamic-bg-layer',
    foreLayerId = 'dynamic-fg-layer',
    defaultTheme = 'morning',
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

    if (store) {
      this.bindStore(store);
    } else {
      this.setTheme(defaultTheme);
    }
  }

  /**
   * 狀態訂閱接縫：綁定 Store，自動響應 activeBgTheme 變更
   */
  bindStore(store) {
    if (!store) return;
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this.store = store;

    if (typeof store.subscribe === 'function') {
      this.unsubscribeStore = store.subscribe(() => {
        const active = store.getActiveBgTheme ? store.getActiveBgTheme() : 'morning';
        if (active && active !== this.currentThemeId) {
          this.setTheme(active);
        }
      });
    }

    const initial = store.getActiveBgTheme ? store.getActiveBgTheme() : 'morning';
    this.setTheme(initial);
  }

  /**
   * 取得型錄主題列表（結合 catalog SSOT 與代表圖 SVG）
   */
  getThemeCatalog() {
    const source = (this.store && this.store.catalog && this.store.catalog.bgThemes)
      ? this.store.catalog.bgThemes
      : DEFAULT_THEME_CATALOG;

    return source.map(t => ({
      ...t,
      bgClass: `bg-theme-${t.id}`,
      thumbSvg: makeThumbnailSvg(t.id)
    }));
  }

  /**
   * 通知目前畫面（首頁 'home' 或全螢幕 'garden' 等），用於彩虹等自適應幾何瞬間切換
   */
  setScreen(screenName) {
    this.adapter.setStageScreen(screenName);
  }

  /**
   * 取得目前啟用之主題 ID
   */
  getCurrentTheme() {
    return this.currentThemeId;
  }

  /**
   * 單一進入點：切換主題
   */
  setTheme(themeId) {
    const catalog = this.getThemeCatalog();
    const target = catalog.find(t => t.id === themeId) || catalog[0];
    this.currentThemeId = target.id;

    // 更新外層 Stage class
    const allBgClasses = catalog.map(t => t.bgClass);
    this.adapter.setStageClass(target.bgClass, allBgClasses);

    // 清理舊引擎生命週期
    this._stopAllEngines();

    // 啟動對應主題引擎
    switch (target.id) {
      case 'sunset':
        this._startCloudEngine(true);
        break;
      case 'night':
        this._renderNight();
        break;
      case 'rain':
        this._renderRain();
        break;
      case 'bubbles':
        this._renderBubbles();
        break;
      default:
        this._startCloudEngine(false);
    }
  }

  /**
   * 銷毀與卸載
   */
  destroy() {
    if (this.unsubscribeStore) {
      this.unsubscribeStore();
      this.unsubscribeStore = null;
    }
    this._stopAllEngines();
    this.adapter.clearLayers();
  }

  // -----------------------------------------------------------------------
  // 內部引擎生命週期管理
  // -----------------------------------------------------------------------
  _stopAllEngines() {
    if (this.cloudTimer) {
      this.adapter.clearInterval(this.cloudTimer);
      this.cloudTimer = null;
    }
    this.activeClouds.clear();

    this.starTimeouts.forEach(t => this.adapter.clearTimeout(t));
    this.starTimeouts = [];

    this.adapter.clearLayers();
  }

  _spawnOneCloud(isSunset, initialOffsetPercent = null) {
    const cloudId = 'c_' + Math.random().toString(36).slice(2, 9);
    const cloudEl = this.adapter.createElement('div', 'absolute pointer-events-none');
    if (!cloudEl) return;

    cloudEl.id = cloudId;

    // 1. 常態分佈高度：N(38%, 9.5%)
    let normY = sampleBoxMullerNormal(38.0, 9.5);
    normY = Math.max(14, Math.min(64, normY));

    // 2. 隨機大小與遠近距離 (Z 軸)
    const zDist = nextPrng();
    const scale = 0.28 + zDist * 0.16;
    const opacity = 0.70 + zDist * 0.25;
    const isForeground = zDist > 0.72; // 近景蓋過花園島上方

    // 3. 飄動時間
    const duration = 22 + (1.0 - zDist) * 16 + nextPrng() * 4;

    if (cloudEl.style) {
      cloudEl.style.top = normY + '%';
      cloudEl.style.left = '0px';
      cloudEl.style.zIndex = isForeground ? '30' : '5';
      cloudEl.style.animation = `cloudFloatLeftToRight ${duration}s linear infinite`;

      if (initialOffsetPercent !== null) {
        const startX = -240 + initialOffsetPercent * (450 + 240);
        cloudEl.style.transform = `translateX(${startX}px)`;
      }
    }

    cloudEl.innerHTML = isSunset
      ? makeSunsetCloudSvg(scale, opacity, cloudId)
      : makeMorningCloudSvg(scale, opacity, cloudId);

    if (isForeground) {
      this.adapter.appendFore(cloudEl);
    } else {
      this.adapter.appendBack(cloudEl);
    }
    this.activeClouds.add(cloudId);

    if (typeof cloudEl.addEventListener === 'function') {
      cloudEl.addEventListener('animationiteration', () => {
        let nextY = sampleBoxMullerNormal(38.0, 9.5);
        nextY = Math.max(14, Math.min(64, nextY));
        if (cloudEl.style) cloudEl.style.top = nextY + '%';
      });
    }
  }

  _startCloudEngine(isSunset = false) {
    if (isSunset) {
      const sun = this.adapter.createElement(
        'div',
        'anim-sunset-sun absolute top-[22%] left-[45%] w-24 h-24 rounded-full bg-gradient-to-tr from-amber-400 via-orange-300 to-yellow-100 pointer-events-none'
      );
      this.adapter.appendBack(sun);

      const bokeh = this.adapter.createElement(
        'div',
        'absolute top-[28%] left-[10%] w-44 h-44 rounded-full bg-orange-400/20 blur-3xl pointer-events-none'
      );
      this.adapter.appendBack(bokeh);
    }

    // 初始預熱 3 朵雲
    this._spawnOneCloud(isSunset, 0.22);
    this._spawnOneCloud(isSunset, 0.58);
    this._spawnOneCloud(isSunset, 0.85);

    // 0.5s 負反饋隨機調度：P = max(0, 20% - 4% * X)
    this.cloudTimer = this.adapter.setInterval(() => {
      const currentCount = this.activeClouds.size;
      const prob = Math.max(0, 0.20 - 0.04 * currentCount);
      if (nextPrng() < prob) {
        this._spawnOneCloud(isSunset, null);
      }
    }, 500);
  }

  _renderNight() {
    // 總共 6 條流星，嚴格 1:2 分層：
    // 1/3（2 條）在前景層（#dynamic-fg-layer），劃過島嶼草皮與櫻花樹上方
    // 2/3（4 條）在後景層（#dynamic-bg-layer），劃過高空夜幕天際
    // 大小不受前後景影響：前後景皆包含大流星 (Bolide, length 190~210)、中流星 (140~145)、細流星 (85~90)
    // 速度：時長翻倍（大流星 13.6s、中流星 10.0s、細流星 7.6s），在 50%~100% 速度範圍內隨機
    const getMeteorDur = (baseDur) => {
      const speedFactor = 0.50 + 0.50 * nextPrng(); // 50% ~ 100% 隨機速度
      return (baseDur / speedFactor).toFixed(2) + 's';
    };

    const foreMeteors = [
      { top: '45%', right: '12%', length: 190, isBolide: true,  dur: getMeteorDur(13.6), del: '1.2s' },
      { top: '56%', right: '28%', length: 135, isBolide: false, dur: getMeteorDur(10.0), del: '6.8s' }
    ];

    const backMeteors = [
      { top: '8%',  right: '8%',  length: 210, isBolide: true,  dur: getMeteorDur(13.6), del: '2.4s' },
      { top: '18%', right: '40%', length: 145, isBolide: false, dur: getMeteorDur(10.0), del: '5.0s' },
      { top: '28%', right: '14%', length: 90,  isBolide: false, dur: getMeteorDur(7.6),  del: '8.4s' },
      { top: '14%', right: '68%', length: 85,  isBolide: false, dur: getMeteorDur(7.6),  del: '0.6s' }
    ];

    const renderMeteorsHtml = (meteors) => meteors.map(m => `
      <div class="meteor-track" style="top: ${m.top}; right: ${m.right}; --meteor-dur: ${m.dur}; --meteor-del: ${m.del};">
        ${makeMeteorSvg({ length: m.length, isBolide: m.isBolide })}
      </div>
    `).join('');

    // 前景層 (z-25)：隨機 1/3 (2 條) 流星劃過島嶼前方，大小不受前後景影響
    this.adapter.setForeHtml(renderMeteorsHtml(foreMeteors));

    // 後景層 (z-0)：2/3 (4 條) 流星在深邃天幕奔馳
    this.adapter.setBackHtml(renderMeteorsHtml(backMeteors));

    const starColors = ['#ffffff', '#ffffff', '#ffffff', '#e0f2fe', '#fff9d2', '#ffe4e6'];

    const spawnStar = () => {
      if (this.currentThemeId !== 'night') return;

      const el = this.adapter.createElement('div', 'dynamic-star-node');
      if (!el) return;

      const left = 6 + Math.random() * 84;
      const top = 5 + Math.random() * 58;
      // 星星尺寸 8~14px
      const size = 8 + Math.floor(Math.random() * 7);
      const color = starColors[Math.floor(Math.random() * starColors.length)];
      const dur = 2.4 + Math.random() * 2.6;

      if (el.style) {
        el.style.left = left + '%';
        el.style.top = top + '%';
        el.style.animationDuration = dur + 's';
      }
      el.innerHTML = makeMicroCrossStarSvg(size, color);

      if (typeof el.addEventListener === 'function') {
        el.addEventListener('animationend', () => {
          if (typeof el.remove === 'function') el.remove();
          const nextTimer = this.adapter.setTimeout(spawnStar, 100 + Math.random() * 400);
          if (nextTimer) this.starTimeouts.push(nextTimer);
        });
      }

      this.adapter.appendBack(el);
    };

    // 初始在天幕各處隨機誕生 14 顆星
    for (let i = 0; i < 14; i++) {
      const t = this.adapter.setTimeout(spawnStar, i * 200);
      if (t) this.starTimeouts.push(t);
    }
  }

  _renderRain() {
    // 總共 18 條雨絲，嚴格 1:2 分層：
    // 1/3（6 條）在前景層（#dynamic-fg-layer），座標劃過花園島中央（top: 48%~68%, left: 32%~66%）
    // 前景雨絲改為與後景相同粗細 (2.2px)，且整體透明度更通透，絕不蓋到底下的文字框與選單
    // 剛切換至雨後彩虹時：前 2.2 秒無雨，雨絲均加入 2.2s 初始延遲且預設 opacity: 0 (both fill-mode)，杜絕停滯不動的雨絲
    const foreTracks = [
      { top: '48%', left: '38%', dur: '2.0s', del: '2.2s' },
      { top: '54%', left: '50%', dur: '2.2s', del: '2.6s' },
      { top: '62%', left: '42%', dur: '1.9s', del: '3.0s' },
      { top: '66%', left: '58%', dur: '2.3s', del: '3.4s' },
      { top: '56%', left: '66%', dur: '2.1s', del: '2.8s' },
      { top: '64%', left: '32%', dur: '2.0s', del: '3.6s' }
    ];

    // 2/3（12 條）在後景層（#dynamic-bg-layer），分佈在天幕四周與高空
    const backTracks = [
      { top: '6%',  left: '16%', dur: '2.1s', del: '2.3s' },
      { top: '10%', left: '68%', dur: '2.4s', del: '2.7s' },
      { top: '14%', left: '84%', dur: '1.95s', del: '3.1s' },
      { top: '18%', left: '42%', dur: '2.3s', del: '3.5s' },
      { top: '24%', left: '12%', dur: '2.05s', del: '2.9s' },
      { top: '28%', left: '76%', dur: '2.5s', del: '3.8s' },
      { top: '34%', left: '18%', dur: '2.2s', del: '3.2s' },
      { top: '38%', left: '86%', dur: '2.6s', del: '2.5s' },
      { top: '44%', left: '14%', dur: '2.15s', del: '3.3s' },
      { top: '78%', left: '86%', dur: '2.35s', del: '3.9s' },
      { top: '82%', left: '18%', dur: '2.0s', del: '2.6s' },
      { top: '86%', left: '82%', dur: '2.5s', del: '3.7s' }
    ];

    const renderTracksHtml = (tracks, isForeground = false) => tracks.map(t => `
      <div class="rain-track" style="top: ${t.top}; left: ${t.left};">
        <div class="${isForeground ? 'rain-bar-fg' : 'rain-bar'}" style="animation-duration: ${t.dur}; animation-delay: ${t.del};"></div>
      </div>
    `).join('');

    // 前景層 (z-25)：琳大花風格夢幻柔焦彩虹弧（移至前景層，飄過浮空島前方） + 1/3 (6 條) 細緻雨絲
    this.adapter.setForeHtml(`
      <!-- 琳大花風格夢幻柔焦彩虹弧（移至前景層 z-25，飄過小島前方） -->
      <div id="rainbow-stage-container" class="rainbow-stage-wrapper pointer-events-none">
        <div class="anim-rainbow-deep w-full">
          ${makeExactMathRainbowSvg()}
        </div>
      </div>

      <div class="anim-rain-weather-cycle absolute inset-0 pointer-events-none">
        ${renderTracksHtml(foreTracks, true)}
      </div>
    `);

    // 後景層 (z-0)：雲隙斜光束 + 水氣光斑 + 2/3 (12 條) 細緻雨絲
    this.adapter.setBackHtml(`
      <!-- 琳大花風格雲隙斜光束 (God Rays) -->
      ${makeGodRaysSvg()}

      <!-- 發光水氣光斑 (Sunlit Moisture Bokeh) -->
      ${makeMoistureBokehHtml()}

      <!-- 自然微斜雨絲（後景層 2/3） -->
      <div class="anim-rain-weather-cycle absolute inset-0 pointer-events-none">
        ${renderTracksHtml(backTracks)}
      </div>

      <div class="absolute top-[38%] left-[8%] w-36 h-36 rounded-full bg-white/28 blur-2xl pointer-events-none"></div>
    `);
  }

  _renderBubbles() {
    // 總共 9 顆泡泡，嚴格 1:2 分層，且所有尺寸等比縮小 50%：
    // 1/3（3 顆）在前景層（#dynamic-fg-layer），尺寸 39~46px
    // 破裂高度隨機分佈在限制範圍：島中心點高度（約 -460px）~ 標題區塊下緣（約 -760px）
    const foreBubbles = [
      { left: '36%', dur: '10.5s', del: '-1.5s', size: 41, riseH: '-540px' },
      { left: '48%', dur: '12.5s', del: '-5.2s', size: 46, riseH: '-740px' },
      { left: '60%', dur: '11.0s', del: '-8.8s', size: 39, riseH: '-620px' }
    ];

    // 2/3（6 顆）在後景層（#dynamic-bg-layer），尺寸 22~33px
    const backBubbles = [
      { left: '8%',  dur: '13.5s', del: '-2.0s', size: 23, riseH: '-470px' },
      { left: '18%', dur: '10.0s', del: '-6.5s', size: 31, riseH: '-670px' },
      { left: '26%', dur: '12.5s', del: '-10.0s', size: 25, riseH: '-570px' },
      { left: '74%', dur: '11.5s', del: '-3.5s', size: 22, riseH: '-750px' },
      { left: '82%', dur: '14.0s', del: '-7.5s', size: 33, riseH: '-500px' },
      { left: '92%', dur: '10.5s', del: '-1.0s', size: 24, riseH: '-690px' }
    ];

    const renderBubbleHtml = (bubbles) => bubbles.map(b => `
      <div class="bubble-riser anim-soap-bubble" style="left: ${b.left}; bottom: -60px; --dur: ${b.dur}; --del: ${b.del}; --rise-h: ${b.riseH};">
        <div class="bubble-wobbler">
          ${makeRealSoapBubbleSvg(b.size)}
        </div>
      </div>
    `).join('');

    // 前景層 (z-25)：1/3 精緻小巧晶瑩泡泡飄過島嶼草皮與櫻花樹上方，上升至標題下方破裂淡出
    this.adapter.setForeHtml(renderBubbleHtml(foreBubbles));

    // 後景層 (z-0)：2/3 迷你泡泡漫遊在背後天空
    this.adapter.setBackHtml(`
      ${renderBubbleHtml(backBubbles)}
      <div class="absolute top-[32%] right-[12%] w-32 h-32 rounded-full bg-pink-100/30 blur-2xl pointer-events-none"></div>
    `);
  }
}

// 匯出全域單例深模組
export const bgManager = new BgManager();
