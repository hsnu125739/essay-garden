// 隨筆花園：動態天候背景主題註冊庫
// 每款主題為自包含物件：{ sky, css?, thumbSvg, mount(scope), onScreenChange?(screen, scope) }
// 新增背景只需在 BG_THEMES 增加一個鍵，並同步更新 catalog.json 與 gas/Code.gs 的 bgThemes。

// =========================================================================
// 1. 可選共用原語函式（純函式 helper，主題可自由決定是否呼叫）
// =========================================================================

/**
 * 飄浮雲朵引擎原語（morning / sunset 共用）：
 * 高斯常態分佈高度 + 3 朵預熱 + 0.5s 負反饋隨機生成 + animationiteration 高度重抽
 */
export function mountCloudDrift(scope, { makeCloudSvg, backdropHtml = '' }) {
  if (backdropHtml) scope.setBackHtml(backdropHtml);

  const activeClouds = new Set();

  const spawnOne = (initialOffsetPercent = null) => {
    const cloudId = scope.uid('c');
    const el = scope.createElement('div', 'absolute pointer-events-none');
    if (!el) return;
    el.id = cloudId;

    const normY = Math.max(14, Math.min(64, scope.normal(38.0, 9.5)));
    const zDist = scope.prng();
    const scale = 0.28 + zDist * 0.16;
    const opacity = 0.70 + zDist * 0.25;
    const isForeground = zDist > 0.72; // 近景蓋過花園島上方
    const duration = 22 + (1.0 - zDist) * 16 + scope.prng() * 4;

    if (el.style) {
      el.style.top = normY + '%';
      el.style.left = '0px';
      el.style.zIndex = isForeground ? '30' : '5';
      el.style.animation = `cloudFloatLeftToRight ${duration}s linear infinite`;
      if (initialOffsetPercent !== null) {
        const startX = -240 + initialOffsetPercent * (450 + 240);
        el.style.transform = `translateX(${startX}px)`;
      }
    }

    el.innerHTML = scope.scopeSvg(makeCloudSvg(scale, opacity));
    if (isForeground) scope.appendFore(el);
    else scope.appendBack(el);
    activeClouds.add(cloudId);

    scope.on(el, 'animationiteration', () => {
      const nextY = Math.max(14, Math.min(64, scope.normal(38.0, 9.5)));
      if (el.style) el.style.top = nextY + '%';
    });
  };

  // 初始預熱 3 朵雲
  spawnOne(0.22);
  spawnOne(0.58);
  spawnOne(0.85);

  // 0.5s 負反饋隨機調度：P = max(0, 20% - 4% * X)
  scope.every(500, () => {
    const prob = Math.max(0, 0.20 - 0.04 * activeClouds.size);
    if (scope.prng() < prob) spawnOne(null);
  });
}

/**
 * 動態隨機閃爍微粒池原語（night 星芒與未來螢火蟲／光點可共用）：
 * 經由 scope.after / scope.on 託管，回呼觸發即移除追蹤，停留再久零記憶體洩漏
 */
export function mountTwinklePool(scope, {
  layer = 'back',
  poolSize = 14,
  staggerMs = 200,
  respawnRange = [100, 500],
  leftRange = [6, 90],
  topRange = [5, 63],
  durRange = [2.4, 5.0],
  nodeClass = 'dynamic-star-node',
  render
}) {
  const append = layer === 'fore' ? (el) => scope.appendFore(el) : (el) => scope.appendBack(el);

  const spawn = () => {
    const el = scope.createElement('div', nodeClass);
    if (!el) return;

    const left = leftRange[0] + scope.prng() * (leftRange[1] - leftRange[0]);
    const top = topRange[0] + scope.prng() * (topRange[1] - topRange[0]);
    const dur = durRange[0] + scope.prng() * (durRange[1] - durRange[0]);

    if (el.style) {
      el.style.left = left + '%';
      el.style.top = top + '%';
      el.style.animationDuration = dur + 's';
    }
    el.innerHTML = scope.scopeSvg(render(scope));

    scope.on(el, 'animationend', () => {
      el.remove?.();
      const delay = respawnRange[0] + scope.prng() * (respawnRange[1] - respawnRange[0]);
      scope.after(delay, spawn);
    });

    append(el);
  };

  for (let i = 0; i < poolSize; i++) {
    scope.after(i * staggerMs, spawn);
  }
}

// =========================================================================
// 2. 各主題專屬 SVG / HTML 生成輔助（ID 由 BgManager.scopeSvgIds 自動隔離）
// =========================================================================

function makeMorningCloudSvg(scale, opacity) {
  return `
    <svg viewBox="0 0 320 180" width="${320 * scale}" height="${180 * scale}" class="overflow-visible" style="opacity: ${opacity}; pointer-events: none;">
      <defs>
        <linearGradient id="cloudGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="65%" stop-color="#f0f6f9"/>
          <stop offset="100%" stop-color="#d4e3eb"/>
        </linearGradient>
        <filter id="cloudFeather" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.8" result="softEdge"/>
          <feDropShadow dx="0" dy="5" stdDeviation="4.5" flood-color="#2a5368" flood-opacity="0.14"/>
        </filter>
      </defs>
      <g filter="url(#cloudFeather)">
        <path d="M 55 135 C 25 135, 12 115, 20 95 C 15 72, 38 52, 62 56 C 78 28, 115 18, 145 28 C 170 10, 212 14, 232 40 C 260 30, 290 52, 295 80 C 318 90, 322 118, 305 135 Z" fill="url(#cloudGrad)"/>
        <circle cx="145" cy="50" r="26" fill="#ffffff" opacity="0.65"/>
        <circle cx="205" cy="54" r="30" fill="#ffffff" opacity="0.6"/>
        <circle cx="85" cy="72" r="20" fill="#ffffff" opacity="0.55"/>
        <ellipse cx="165" cy="115" rx="85" ry="16" fill="#e0ecf2" opacity="0.7"/>
      </g>
    </svg>`;
}

function makeSunsetCloudSvg(scale, opacity) {
  return `
    <svg viewBox="0 0 340 180" width="${340 * scale}" height="${180 * scale}" class="overflow-visible" style="opacity: ${opacity}; pointer-events: none;">
      <defs>
        <linearGradient id="sunsetCloudGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#fed7aa"/>
          <stop offset="25%" stop-color="#fca5a5"/>
          <stop offset="70%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#47265a"/>
        </linearGradient>
        <linearGradient id="goldRim" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fef08a"/>
          <stop offset="50%" stop-color="#f59e0b"/>
          <stop offset="100%" stop-color="#ec4899"/>
        </linearGradient>
        <filter id="sunsetCloudFeather" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.6" result="softEdge"/>
          <feDropShadow dx="0" dy="6" stdDeviation="5.5" flood-color="#180c2e" flood-opacity="0.32"/>
        </filter>
      </defs>
      <g filter="url(#sunsetCloudFeather)">
        <path d="M 60 135 C 30 135, 14 115, 22 95 C 16 70, 42 50, 68 54 C 85 24, 122 15, 155 25 C 182 8, 225 12, 248 38 C 278 28, 308 50, 312 78 C 335 88, 338 116, 320 135 Z"
              fill="url(#sunsetCloudGrad)" stroke="url(#goldRim)" stroke-width="2.5"/>
        <path d="M 65 52 C 85 24, 122 15, 155 25 C 182 8, 225 12, 248 38 C 278 28, 308 50, 312 78"
              fill="none" stroke="#fef08a" stroke-width="3" opacity="0.85"/>
        <circle cx="155" cy="46" r="28" fill="#fed7aa" opacity="0.45"/>
        <circle cx="218" cy="50" r="32" fill="#fb923c" opacity="0.4"/>
        <ellipse cx="175" cy="118" rx="95" ry="16" fill="#6d3d7d" opacity="0.4"/>
      </g>
    </svg>`;
}

function makeMicroCrossStarSvg(size = 18, color = '#ffffff') {
  return `
    <svg viewBox="0 0 48 48" width="${size}" height="${size}" class="overflow-visible" style="pointer-events: none;">
      <defs>
        <filter id="microCrossGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g filter="url(#microCrossGlow)">
        <path d="M 24 2 C 24 16, 18 20, 2 24 C 18 28, 24 32, 24 46 C 24 32, 30 28, 46 24 C 30 20, 24 16, 24 2 Z" fill="${color}"/>
        <path d="M 24 10 C 24 19, 20 21, 10 24 C 20 27, 24 29, 24 38 C 24 29, 28 27, 38 24 C 28 21, 24 19, 24 10 Z" fill="${color}" opacity="0.7" transform="rotate(45 24 24)"/>
        <circle cx="24" cy="24" r="2.8" fill="#ffffff"/>
      </g>
    </svg>`;
}

function makeMeteorSvg({ length = 150, isBolide = false } = {}) {
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
      <path d="M ${headX} ${headY - rDiag} Q ${headX - 0.7} ${headY} ${headX} ${headY + rDiag} Q ${headX + 0.7} ${headY} ${headX - rDiag} ${headY} Z" fill="#ffffff" opacity="0.85"/>
    </g>` : '';

  return `
    <svg viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" class="overflow-visible" style="pointer-events: none;">
      <defs>
        <linearGradient id="tailCore" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="1"/>
          <stop offset="10%" stop-color="#ffffff" stop-opacity="0.95"/>
          <stop offset="28%" stop-color="#38bdf8" stop-opacity="0.9"/>
          <stop offset="60%" stop-color="#2563eb" stop-opacity="0.55"/>
          <stop offset="85%" stop-color="#1e3a8a" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#1e3a8a" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="tailSheath" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.85"/>
          <stop offset="25%" stop-color="#60a5fa" stop-opacity="0.6"/>
          <stop offset="65%" stop-color="#2563eb" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="#1d4ed8" stop-opacity="0"/>
        </linearGradient>
        <filter id="tailGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g>
        <path d="${tailSheathPath}" fill="url(#tailSheath)" opacity="0.75" filter="url(#tailGlow)"/>
        <path d="${tailCorePath}" fill="url(#tailCore)"/>
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 14 : 8}" fill="#2563eb" opacity="0.35" filter="url(#tailGlow)"/>
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 8 : 5}" fill="#38bdf8" opacity="0.75" filter="url(#tailGlow)"/>
        <path d="M ${headX - rHoriz} ${headY} Q ${headX} ${headY - 1} ${headX + rHoriz} ${headY} Q ${headX} ${headY + 1} ${headX - rHoriz} ${headY} Z" fill="#ffffff"/>
        <path d="M ${headX} ${headY - rVert} Q ${headX - 1} ${headY} ${headX} ${headY + rVert} Q ${headX + 1} ${headY} ${headX} ${headY - rVert} Z" fill="#ffffff"/>
        ${diagFlare}
        <circle cx="${headX}" cy="${headY}" r="${isBolide ? 2.8 : 2.0}" fill="#ffffff"/>
      </g>
    </svg>`;
}

function makeExactMathRainbowSvg() {
  const X0 = 200;
  const Y0 = 240;
  const cos15 = 0.9659;
  const sin15 = 0.2588;
  const arcs = [
    { r: 195, color: '#f472b6', opacity: 0.68, width: 16 },
    { r: 187, color: '#fba866', opacity: 0.65, width: 16 },
    { r: 179, color: '#fde047', opacity: 0.68, width: 16 },
    { r: 171, color: '#6ee7b7', opacity: 0.62, width: 16 },
    { r: 163, color: '#38bdf8', opacity: 0.68, width: 16 },
    { r: 155, color: '#818cf8', opacity: 0.60, width: 16 },
    { r: 147, color: '#c084fc', opacity: 0.68, width: 16 }
  ];

  const arcD = (r) => {
    const startX = (X0 - r * cos15).toFixed(2);
    const y = (Y0 - r * sin15).toFixed(2);
    const endX = (X0 + r * cos15).toFixed(2);
    return `M ${startX} ${y} A ${r} ${r} 0 0 1 ${endX} ${y}`;
  };

  const paths = arcs.map((a) =>
    `<path d="${arcD(a.r)}" stroke="${a.color}" stroke-opacity="${a.opacity}" stroke-width="${a.width}" stroke-linecap="round"/>`
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
        <path d="${arcD(171)}" stroke="#ffffff" stroke-width="58" stroke-opacity="0.35" filter="url(#rainbowFeather)"/>
        <g filter="url(#rainbowFeather)">${paths}</g>
        <path d="${arcD(200)}" stroke="#ffffff" stroke-width="3" stroke-opacity="0.55" filter="url(#rainbowFeather)"/>
      </g>
    </svg>`;
}

function makeGodRaysSvg() {
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

function makeMoistureBokehHtml() {
  const particles = [
    { top: '14%', left: '24%', size: 12, dur: '5.2s', del: '0.2s', color: 'bg-white/60', sparkle: true },
    { top: '22%', left: '42%', size: 18, dur: '6.8s', del: '1.5s', color: 'bg-amber-100/50', sparkle: false },
    { top: '16%', left: '68%', size: 14, dur: '5.8s', del: '0.8s', color: 'bg-sky-200/55', sparkle: true },
    { top: '28%', left: '78%', size: 10, dur: '7.2s', del: '2.1s', color: 'bg-pink-200/45', sparkle: false },
    { top: '12%', left: '52%', size: 22, dur: '6.0s', del: '3.0s', color: 'bg-white/65', sparkle: true },
    { top: '30%', left: '32%', size: 13, dur: '5.5s', del: '1.2s', color: 'bg-emerald-100/50', sparkle: false },
    { top: '24%', left: '18%', size: 16, dur: '6.4s', del: '2.5s', color: 'bg-amber-200/40', sparkle: false }
  ];

  return particles.map((p) => {
    const sparkleHtml = p.sparkle
      ? `<svg viewBox="0 0 24 24" class="w-full h-full text-white drop-shadow-[0_0_4px_rgba(255,255,255,0.8)]"><path d="M 12 2 Q 12 12 2 12 Q 12 12 12 22 Q 12 12 22 12 Q 12 12 12 2 Z" fill="#ffffff"/></svg>`
      : '';
    return `
      <div class="anim-bokeh-drift absolute rounded-full ${p.color} blur-[1.5px] pointer-events-none flex items-center justify-center"
           style="top: ${p.top}; left: ${p.left}; width: ${p.size}px; height: ${p.size}px; --b-dur: ${p.dur}; --b-del: ${p.del};">
        ${sparkleHtml}
      </div>`;
  }).join('');
}

function makeRealSoapBubbleSvg(size = 54) {
  return `
    <svg viewBox="0 0 100 100" width="${size}" height="${size}" class="overflow-visible" style="pointer-events: none; filter: drop-shadow(0 6px 16px rgba(56, 189, 248, 0.4)) drop-shadow(0 2px 6px rgba(192, 132, 252, 0.25));">
      <defs>
        <radialGradient id="sphere" cx="36%" cy="32%" r="64%">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.45"/>
          <stop offset="25%" stop-color="#ffffff" stop-opacity="0.08"/>
          <stop offset="65%" stop-color="#38bdf8" stop-opacity="0.12"/>
          <stop offset="85%" stop-color="#c084fc" stop-opacity="0.28"/>
          <stop offset="96%" stop-color="#f472b6" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#0284c7" stop-opacity="0.55"/>
        </radialGradient>
        <linearGradient id="film" x1="12%" y1="15%" x2="88%" y2="85%">
          <stop offset="0%" stop-color="#f472b6" stop-opacity="0.48"/>
          <stop offset="22%" stop-color="#fbbf24" stop-opacity="0.42"/>
          <stop offset="45%" stop-color="#34d399" stop-opacity="0.45"/>
          <stop offset="70%" stop-color="#38bdf8" stop-opacity="0.52"/>
          <stop offset="88%" stop-color="#818cf8" stop-opacity="0.50"/>
          <stop offset="100%" stop-color="#c084fc" stop-opacity="0.58"/>
        </linearGradient>
        <linearGradient id="swirl" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
          <stop offset="48%" stop-color="#4ade80" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#f472b6" stop-opacity="0.75"/>
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="44" fill="url(#sphere)"/>
      <circle cx="50" cy="50" r="44" fill="url(#film)"/>
      <circle cx="50" cy="50" r="44.5" fill="none" stroke="rgba(255,255,255,0.88)" stroke-width="1.6"/>
      <circle cx="50" cy="50" r="43.2" fill="none" stroke="url(#film)" stroke-width="1.8" opacity="0.65"/>
      <path d="M 22 72 A 36 36 0 0 0 78 72" fill="none" stroke="url(#swirl)" stroke-width="3.0" stroke-linecap="round" opacity="0.65" style="filter: blur(0.6px);"/>
      <path d="M 10.5 37.2 A 41.5 41.5 0 0 1 48.6 8.5 A 37 37 0 0 0 14.8 38.6 Q 11.5 38.5 10.5 37.2 Z" fill="#ffffff" opacity="0.96"/>
      <ellipse cx="45" cy="15" rx="3.5" ry="1.8" transform="rotate(-30 45 15)" fill="#ffffff" opacity="0.95"/>
      <circle cx="18" cy="42" r="1.8" fill="#ffffff" opacity="0.9"/>
      <path d="M 67.5 87.6 A 41.5 41.5 0 0 0 90.1 60.7 A 38.5 38.5 0 0 1 69.2 84.8 Z" fill="#ffffff" opacity="0.65"/>
      <path d="M 64 88 A 42 42 0 0 0 89 63" fill="none" stroke="rgba(56, 189, 248, 0.7)" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`;
}

// =========================================================================
// 3. 主題註冊表（BG_THEMES）
// =========================================================================
// ponytail: 單檔同步註冊庫適合 <=12~15 款主題；未來若超過規模或需多人並行，
// 將本檔改為聚合 bg-themes/<id>.js 即可，BgManager 與 Theme 契約不變。

export const BG_THEMES = {
  morning: {
    sky: 'linear-gradient(180deg, #8dc5d8 0%, #b8dddc 42%, #dbeef0 75%, #f4f8f7 100%)',
    css: `
      @keyframes cloudFloatLeftToRight {
        0% { transform: translateX(-240px); }
        100% { transform: translateX(450px); }
      }
    `,
    thumbSvg: `
      <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">
        <defs>
          <linearGradient id="tGradMorning" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8dc5d8"/><stop offset="100%" stop-color="#f4f8f7"/>
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#tGradMorning)"/>
        <circle cx="31" cy="9" r="6" fill="#fde047" opacity="0.9"/>
        <path d="M 10 28 C 6 28 4 24 6 20 C 5 15 11 11 16 12 C 20 6 28 8 30 14 C 35 15 36 21 33 25 C 31 28 27 28 25 28 Z" fill="#ffffff" opacity="0.95"/>
      </svg>`,
    mount(scope) {
      mountCloudDrift(scope, { makeCloudSvg: makeMorningCloudSvg });
    }
  },

  sunset: {
    sky: 'linear-gradient(180deg, #1d1b46 0%, #3e3268 25%, #76476e 50%, #c4645c 74%, #f2b87e 100%)',
    css: `
      @keyframes sunsetSunPulse {
        0%, 100% { transform: scale(1); opacity: 0.85; filter: drop-shadow(0 0 25px rgba(255, 180, 100, 0.6)); }
        50% { transform: scale(1.06); opacity: 0.98; filter: drop-shadow(0 0 35px rgba(255, 140, 60, 0.85)); }
      }
      .anim-sunset-sun { animation: sunsetSunPulse 6.5s ease-in-out infinite; }
    `,
    thumbSvg: `
      <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">
        <defs>
          <linearGradient id="tGradSunset" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3e3268"/><stop offset="60%" stop-color="#c4645c"/><stop offset="100%" stop-color="#f2b87e"/>
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#tGradSunset)"/>
        <circle cx="20" cy="24" r="8" fill="#fed7aa" opacity="0.95"/>
        <path d="M 4 33 C 12 30 28 30 36 33 Z" fill="#47265a" opacity="0.7"/>
        <path d="M 8 26 C 14 20 26 21 32 26 Z" fill="#fed7aa" opacity="0.6"/>
      </svg>`,
    mount(scope) {
      mountCloudDrift(scope, {
        makeCloudSvg: makeSunsetCloudSvg,
        backdropHtml: `
          <div class="anim-sunset-sun absolute top-[22%] left-[45%] w-24 h-24 rounded-full bg-gradient-to-tr from-amber-400 via-orange-300 to-yellow-100 pointer-events-none"></div>
          <div class="absolute top-[28%] left-[10%] w-44 h-44 rounded-full bg-orange-400/20 blur-3xl pointer-events-none"></div>
        `
      });
    }
  },

  night: {
    sky: 'linear-gradient(180deg, #090e1f 0%, #101730 38%, #162440 72%, #22354c 100%)',
    css: `
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
      @keyframes meteorFlyGlide {
        0% { transform: translate(220px, -244px) rotate(-48deg); opacity: 0; }
        4% { opacity: 1; }
        48% { transform: translate(-420px, 466px) rotate(-48deg); opacity: 0; }
        100% { transform: translate(-420px, 466px) rotate(-48deg); opacity: 0; }
      }
      .meteor-track {
        position: absolute;
        opacity: 0;
        transform: translate(220px, -244px) rotate(-48deg);
        animation: meteorFlyGlide var(--meteor-dur, 15s) cubic-bezier(0.15, 0.25, 0.2, 1) infinite var(--meteor-del, 0s) both;
        pointer-events: none;
        will-change: transform, opacity;
      }
    `,
    thumbSvg: `
      <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">
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
        <rect width="40" height="40" fill="url(#tGradNight)"/>
        <path d="M 12 12 Q 12 16 8 16 Q 12 16 12 20 Q 12 16 16 16 Q 12 16 12 12 Z" fill="#ffffff"/>
        <circle cx="28" cy="22" r="1.5" fill="#bae6fd"/>
        <line x1="13" y1="29" x2="33" y2="9" stroke="url(#tGradMeteor)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="13" cy="29" r="2.2" fill="#ffffff"/>
        <circle cx="13" cy="29" r="4.0" fill="#38bdf8" opacity="0.7"/>
      </svg>`,
    mount(scope) {
      const getMeteorDur = (baseDur) => (baseDur / (0.50 + 0.50 * scope.prng())).toFixed(2) + 's';
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
      const renderMeteors = (list) => list.map((m) => `
        <div class="meteor-track" style="top: ${m.top}; right: ${m.right}; --meteor-dur: ${m.dur}; --meteor-del: ${m.del};">
          ${makeMeteorSvg({ length: m.length, isBolide: m.isBolide })}
        </div>`).join('');

      scope.setForeHtml(renderMeteors(foreMeteors));
      scope.setBackHtml(renderMeteors(backMeteors));

      const starColors = ['#ffffff', '#ffffff', '#ffffff', '#e0f2fe', '#fff9d2', '#ffe4e6'];
      mountTwinklePool(scope, {
        layer: 'back',
        poolSize: 14,
        staggerMs: 200,
        respawnRange: [100, 500],
        leftRange: [6, 90],
        topRange: [5, 63],
        durRange: [2.4, 5.0],
        render: (s) => {
          const size = 8 + Math.floor(s.prng() * 7);
          const color = starColors[Math.floor(s.prng() * starColors.length)];
          return makeMicroCrossStarSvg(size, color);
        }
      });
    }
  },

  rain: {
    sky: 'linear-gradient(180deg, #b8e2d9 0%, #d8f0e8 48%, #eef7f1 100%)',
    css: `
      @keyframes rainPhaseControl {
        0%, 38.89% { opacity: 0.95; transform: translateY(0); }
        50% { opacity: 0; transform: translateY(6px); }
        94.43% { opacity: 0; transform: translateY(6px); }
        94.44%, 100% { opacity: 0.95; transform: translateY(0); }
      }
      .anim-rain-weather-cycle { animation: rainPhaseControl 18s ease-in-out infinite; }
      @keyframes rainbowFadeDeep {
        0%, 44.44% { opacity: 0; }
        45% { opacity: 0.15; }
        58% { opacity: 0.95; }
        75% { opacity: 0.95; }
        94.44%, 100% { opacity: 0; }
      }
      @keyframes rainbowClipDeep {
        0%, 44.44% { clip-path: polygon(0 0, 0% 0, 0% 100%, 0 100%); }
        45% { clip-path: polygon(0 0, 5% 0, 5% 100%, 0 100%); }
        58% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
        77.78% { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
        94.44%, 100% { clip-path: polygon(100% 0, 100% 0, 100% 100%, 100% 100%); }
      }
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
      @keyframes godRaysShimmer {
        0%, 100% { opacity: 0.65; transform: scale(1); }
        50% { opacity: 0.95; transform: scale(1.02); }
      }
      .anim-god-rays { animation: godRaysShimmer 7s ease-in-out infinite alternate; pointer-events: none; }
      @keyframes bokehDrift {
        0%, 100% { transform: translateY(0px) scale(0.9); opacity: 0.4; }
        50% { transform: translateY(-12px) scale(1.15); opacity: 0.9; }
      }
      .anim-bokeh-drift { animation: bokehDrift var(--b-dur, 6s) ease-in-out infinite alternate var(--b-del, 0s); pointer-events: none; }
      @keyframes rainLocalGlide {
        0% { transform: translateX(200px); opacity: 0; }
        18% { opacity: 0.45; }
        82% { opacity: 0.45; }
        100% { transform: translateX(-260px); opacity: 0; }
      }
      .rain-track { position: absolute; transform: rotate(-74deg); transform-origin: center center; pointer-events: none; }
      .rain-bar, .rain-bar-fg { width: 44px; height: 2.2px; opacity: 0; border-radius: 9999px; animation: rainLocalGlide 2.2s linear infinite 0s both; }
      .rain-bar { background: linear-gradient(to right, rgba(255, 255, 255, 0.75) 0%, rgba(56, 189, 248, 0.48) 45%, rgba(14, 165, 233, 0.22) 80%, transparent 100%); box-shadow: 0 0 3px rgba(56, 189, 248, 0.25); }
      .rain-bar-fg { background: linear-gradient(to right, rgba(255, 255, 255, 0.8) 0%, rgba(56, 189, 248, 0.52) 45%, rgba(14, 165, 233, 0.25) 80%, transparent 100%); box-shadow: 0 0 3px rgba(56, 189, 248, 0.28); }
    `,
    thumbSvg: `
      <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">
        <defs>
          <linearGradient id="tGradRain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#b8e2d9"/><stop offset="48%" stop-color="#d8f0e8"/><stop offset="100%" stop-color="#eef7f1"/>
          </linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#tGradRain)"/>
        <path d="M 6 30 A 18 18 0 0 1 34 30" fill="none" stroke="#f472b6" stroke-width="2.5" opacity="0.75"/>
        <path d="M 8 30 A 15 15 0 0 1 32 30" fill="none" stroke="#fde047" stroke-width="2.5" opacity="0.75"/>
        <path d="M 10 30 A 12 12 0 0 1 30 30" fill="none" stroke="#38bdf8" stroke-width="2.5" opacity="0.75"/>
        <line x1="30" y1="4" x2="16" y2="28" stroke="#ffffff" stroke-width="1.8" opacity="0.5" stroke-dasharray="2 2"/>
        <line x1="20" y1="12" x2="17" y2="22" stroke="#ffffff" stroke-width="1.2" opacity="0.75"/>
      </svg>`,
    mount(scope) {
      const foreTracks = [
        { top: '48%', left: '38%', dur: '2.0s', del: '2.2s' },
        { top: '54%', left: '50%', dur: '2.2s', del: '2.6s' },
        { top: '62%', left: '42%', dur: '1.9s', del: '3.0s' },
        { top: '66%', left: '58%', dur: '2.3s', del: '3.4s' },
        { top: '56%', left: '66%', dur: '2.1s', del: '2.8s' },
        { top: '64%', left: '32%', dur: '2.0s', del: '3.6s' }
      ];
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
      const renderTracks = (list, isFg) => list.map((t) => `
        <div class="rain-track" style="top: ${t.top}; left: ${t.left};">
          <div class="${isFg ? 'rain-bar-fg' : 'rain-bar'}" style="animation-duration: ${t.dur}; animation-delay: ${t.del};"></div>
        </div>`).join('');

      scope.setForeHtml(`
        <div id="rainbow-stage-container" class="rainbow-stage-wrapper pointer-events-none">
          <div class="anim-rainbow-deep w-full">${makeExactMathRainbowSvg()}</div>
        </div>
        <div class="anim-rain-weather-cycle absolute inset-0 pointer-events-none">${renderTracks(foreTracks, true)}</div>
      `);
      scope.setBackHtml(`
        ${makeGodRaysSvg()}
        ${makeMoistureBokehHtml()}
        <div class="anim-rain-weather-cycle absolute inset-0 pointer-events-none">${renderTracks(backTracks, false)}</div>
        <div class="absolute top-[38%] left-[8%] w-36 h-36 rounded-full bg-white/28 blur-2xl pointer-events-none"></div>
      `);
    }
  },

  bubbles: {
    sky: 'linear-gradient(180deg, #abd9cf 0%, #cfe6eb 48%, #f3ebf2 100%)',
    css: `
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
      @keyframes soapBubbleWobbleInner {
        0% { transform: translateX(-16px) rotate(-3deg) scaleY(0.97) scaleX(1.03); }
        50% { transform: translateX(0px) rotate(2deg) scaleY(1.02) scaleX(0.98); }
        100% { transform: translateX(16px) rotate(-2deg) scaleY(0.96) scaleX(1.04); }
      }
      .bubble-wobbler {
        animation: soapBubbleWobbleInner 4.2s ease-in-out infinite alternate;
        pointer-events: none;
      }
    `,
    thumbSvg: `
      <svg viewBox="0 0 40 40" class="w-full h-full rounded-lg overflow-hidden">
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
        <rect width="40" height="40" fill="url(#tGradBubbles)"/>
        <circle cx="16" cy="22" r="9" fill="url(#tBubbleSphere)" stroke="#ffffff" stroke-width="1.2"/>
        <path d="M 11 18 A 6 6 0 0 1 18 15" fill="none" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
        <circle cx="27" cy="14" r="6" fill="url(#tBubbleSphere)" stroke="#ffffff" stroke-width="1.0" opacity="0.85"/>
      </svg>`,
    mount(scope) {
      const foreBubbles = [
        { left: '36%', dur: '10.5s', del: '-1.5s', size: 41, riseH: '-540px' },
        { left: '48%', dur: '12.5s', del: '-5.2s', size: 46, riseH: '-740px' },
        { left: '60%', dur: '11.0s', del: '-8.8s', size: 39, riseH: '-620px' }
      ];
      const backBubbles = [
        { left: '8%',  dur: '13.5s', del: '-2.0s', size: 23, riseH: '-470px' },
        { left: '18%', dur: '10.0s', del: '-6.5s', size: 31, riseH: '-670px' },
        { left: '26%', dur: '12.5s', del: '-10.0s', size: 25, riseH: '-570px' },
        { left: '74%', dur: '11.5s', del: '-3.5s', size: 22, riseH: '-750px' },
        { left: '82%', dur: '14.0s', del: '-7.5s', size: 33, riseH: '-500px' },
        { left: '92%', dur: '10.5s', del: '-1.0s', size: 24, riseH: '-690px' }
      ];
      const renderBubbles = (list) => list.map((b) => `
        <div class="bubble-riser anim-soap-bubble" style="left: ${b.left}; bottom: -60px; --dur: ${b.dur}; --del: ${b.del}; --rise-h: ${b.riseH};">
          <div class="bubble-wobbler">${makeRealSoapBubbleSvg(b.size)}</div>
        </div>`).join('');

      scope.setForeHtml(renderBubbles(foreBubbles));
      scope.setBackHtml(`
        ${renderBubbles(backBubbles)}
        <div class="absolute top-[32%] right-[12%] w-32 h-32 rounded-full bg-pink-100/30 blur-2xl pointer-events-none"></div>
      `);
    }
  }
};
