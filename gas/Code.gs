// 隨筆花園（Essay Garden）：Google Apps Script 權威後端（V8 + Sheets API v4）
// 對齊 database-spec.md & verification-spec.md（22 個 Action、13 個標準錯誤碼）

const SPREADSHEET_ID = '1UBt7fuHru0fJv1QLStpvaIr2YxIg2vO9sM8yrd-cTAE';
const BACKUP_FOLDER_NAME = '隨筆花園-自動備份';
const MAX_ESSAY_CELL_CHARS = 49000;
const PASSWORD_ROUNDS = 400;

const GAME_CONFIG = {
  dayBoundaryHour: 4,
  minWords: 10,
  dailySeedCap: 3,
  seedBagCap: 30,
  homeEssayLimit: 10,
  rarityFormula: { cap: 100, offset: 10 },
  pityThreshold: 10,
  decomposeEnergy: { common: 2, rare: 5, epic: 10, legendary: 20 },
  dailyBaseEnergy: 10,
  streakMultipliers: [[1, 1], [7, 1.5], [30, 2]],
  overflowWordsPerEnergy: 10,
  milestones: [7, 30, 100, 365],
  clearWitheredCost: 5,
  makeUpCost: 30,
  regionSize: { personal: 5, group: 6 },
  expansionCosts: [100, 250, 500, 800],
  groupGrowthMultiplier: { '1': 1, '2': 1.5, '3': 2, '4': 2.5, '5': 3 },
  maxGroupMembers: 5,
  beauty: {
    rarityWeight: { common: 1, rare: 2, epic: 4, legendary: 8 },
    decorDivisor: 10,
    witheredPenalty: 2
  }
};

const CATALOG = {
  themes: {
    flowerbed: { id: 'flowerbed', name: '春櫻花圃' },
    forest: { id: 'forest', name: '迷霧森林' },
    oasis: { id: 'oasis', name: '沙漠綠洲' }
  },
  species: [
    ['fb_c1', '紫薰衣草', 'flowerbed', 'common', 1],
    ['fb_c2', '白雛菊叢', 'flowerbed', 'common', 1],
    ['fb_c3', '暖陽向日葵', 'flowerbed', 'common', 2],
    ['fb_c4', '粉鬱金香', 'flowerbed', 'common', 2],
    ['fb_c5', '藍風信子', 'flowerbed', 'common', 2],
    ['fb_r1', '緋紅玫瑰叢', 'flowerbed', 'rare', 2],
    ['fb_r2', '晨露繡球花', 'flowerbed', 'rare', 3],
    ['fb_r3', '香檳山茶花', 'flowerbed', 'rare', 3],
    ['fb_r4', '紫藤花架', 'flowerbed', 'rare', 3],
    ['fb_e1', '黃金桂花樹', 'flowerbed', 'epic', 3],
    ['fb_e2', '霓虹藍花楹', 'flowerbed', 'epic', 4],
    ['fb_l1', '千本櫻神木', 'flowerbed', 'legendary', 5],
    ['fo_c1', '翠玉蕨叢', 'forest', 'common', 1],
    ['fo_c2', '紅傘小蘑菇', 'forest', 'common', 1],
    ['fo_c3', '青苔橡木苗', 'forest', 'common', 2],
    ['fo_c4', '白樺幼樹', 'forest', 'common', 2],
    ['fo_c5', '森之鈴蘭', 'forest', 'common', 2],
    ['fo_r1', '星光螢菇', 'forest', 'rare', 2],
    ['fo_r2', '秋霞紅楓樹', 'forest', 'rare', 3],
    ['fo_r3', '金扇銀杏樹', 'forest', 'rare', 3],
    ['fo_r4', '幽谷翠竹', 'forest', 'rare', 3],
    ['fo_e1', '蒼翠盆景古松', 'forest', 'epic', 3],
    ['fo_e2', '幻紫靈芝叢', 'forest', 'epic', 4],
    ['fo_l1', '螢火世界樹', 'forest', 'legendary', 5],
    ['oa_c1', '玉露多肉', 'oasis', 'common', 1],
    ['oa_c2', '沙漠蘆薈', 'oasis', 'common', 1],
    ['oa_c3', '團扇仙人掌', 'oasis', 'common', 2],
    ['oa_c4', '石蓮花座', 'oasis', 'common', 2],
    ['oa_c5', '沙洲蘆葦叢', 'oasis', 'common', 2],
    ['oa_r1', '金冠仙人掌', 'oasis', 'rare', 2],
    ['oa_r2', '沙漠玫瑰木', 'oasis', 'rare', 3],
    ['oa_r3', '綠洲睡蓮', 'oasis', 'rare', 3],
    ['oa_r4', '龍血小樹', 'oasis', 'rare', 3],
    ['oa_e1', '綠洲椰棗樹', 'oasis', 'epic', 3],
    ['oa_e2', '猴麵包巨木', 'oasis', 'epic', 4],
    ['oa_l1', '海市蜃樓神木', 'oasis', 'legendary', 5],
    ['cm_c1', '幸運四葉草', 'common', 'common', 1],
    ['cm_c2', '甜美草莓叢', 'common', 'common', 2],
    ['cm_r1', '陽光小柑橘', 'common', 'rare', 2],
    ['cm_r2', '藍莓果樹叢', 'common', 'rare', 3],
    ['cm_e1', '月光銀樺樹', 'common', 'epic', 4],
    ['cm_l1', '彩虹祈願樹', 'common', 'legendary', 5],
    ['lim_7', '七日初心盆栽', 'limited', 'legendary', 1, 7],
    ['lim_30', '滿月桂冠神木', 'limited', 'legendary', 1, 30],
    ['lim_100', '百日星河櫻', 'limited', 'legendary', 1, 100],
    ['lim_365', '永恆時光古松', 'limited', 'legendary', 1, 365]
  ].map(function (r) {
    var obj = { id: r[0], name: r[1], theme: r[2], rarity: r[3], requiredDays: r[4] };
    if (r[5] !== undefined) obj.milestone = r[5];
    return obj;
  }),
  decor: [
    { id: 'dec_lantern', name: '青苔石燈籠', cost: 30 },
    { id: 'dec_bench', name: '暖木小長椅', cost: 50 },
    { id: 'dec_pond', name: '竹筧流泉缽', cost: 80 },
    { id: 'dec_rock', name: '山水景觀石', cost: 40 },
    { id: 'dec_torii', name: '朱紅小鳥居', cost: 120 },
    { id: 'dec_arch', name: '繁花拱門架', cost: 200 }
  ]
};

const SPECIES_MAP = Object.fromEntries(CATALOG.species.map(function (s) { return [s.id, s]; }));
const DECOR_MAP = Object.fromEntries(CATALOG.decor.map(function (d) { return [d.id, d]; }));

const VALID_THEMES = { flowerbed: true, forest: true, oasis: true };
const VALID_CARD_STYLES = {
  card1: true, card2: true, card3: true, card4: true, card5: true, card6: true, card7: true
};
const VALID_REACTIONS = { sparkle: true, sprout: true, hug: true, cheer: true, love: true };

const HEADERS = {
  users: [
    'uid', 'username', 'password_hash', 'session_hashes_json', 'display_name',
    'timezone', 'active_group_id', 'energy', 'pity', 'streak_count',
    'streak_last_day', 'streak_prev_count', 'streak_prev_last_day',
    'seeds_json', 'limited_seeds_json', 'milestones_json', 'dex_json',
    'last_card_style', 'makeup_days_json', 'created_at', 'updated_at'
  ],
  groups: [
    'group_id', 'name', 'owner_uid', 'status', 'invite_code',
    'member_uids_json', 'former_member_uids_json', 'timezone',
    'theme_vote_month', 'theme_votes_json', 'makeup_days_json',
    'created_at', 'updated_at'
  ],
  gardens: [
    'garden_id', 'owner_type', 'owner_id', 'month', 'theme',
    'status', 'snapshot_name', 'size', 'expansions', 'items_json',
    'created_at', 'updated_at'
  ]
};

const USERNAME_RE = /^[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AFA-Za-z0-9_.-]{2,24}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ----------------------------------------------------------------------------
// 1. 可注入環境接縫（GAS 執行期自動繫結原生全域服務；Node 測試可替換）
// ----------------------------------------------------------------------------
function createDefaultEnv() {
  return {
    spreadsheetId: SPREADSHEET_ID,
    nowMs: function () { return Date.now(); },
    rng: function () { return Math.random(); },
    getUuid: function () { return Utilities.getUuid(); },
    sha256Bytes: function (input) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
    },
    LockService: typeof LockService !== 'undefined' ? LockService : null,
    SpreadsheetApp: typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp : null,
    Sheets: typeof Sheets !== 'undefined' ? Sheets : null,
    ContentService: typeof ContentService !== 'undefined' ? ContentService : null,
    DriveApp: typeof DriveApp !== 'undefined' ? DriveApp : null
  };
}

let ENV = createDefaultEnv();

function __setGasEnv(overrides) {
  ENV = Object.assign(createDefaultEnv(), overrides || {});
}

function appError(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

// ----------------------------------------------------------------------------
// 2. 核心規則純函式（與 engine.js 100% 同源）
// ----------------------------------------------------------------------------
function getGameDayKey(dateOrMs, timeZone, boundaryHour) {
  var ms = dateOrMs === undefined ? ENV.nowMs() : (typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime());
  var tz = timeZone || 'Asia/Taipei';
  var bh = boundaryHour === undefined ? 4 : boundaryHour;
  var shifted = new Date(ms - bh * 3600 * 1000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(shifted);
  var y = parts.find(function (p) { return p.type === 'year'; }).value;
  var m = parts.find(function (p) { return p.type === 'month'; }).value;
  var day = parts.find(function (p) { return p.type === 'day'; }).value;
  return y + '-' + m + '-' + day;
}

function addDays(dayKey, delta) {
  var parts = dayKey.split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + delta));
  return dt.toISOString().slice(0, 10);
}

function isLastDayOfMonth(dayKey) {
  return addDays(dayKey, 1).slice(0, 7) !== dayKey.slice(0, 7);
}

function countEssayWords(text) {
  if (!text) return 0;
  var cjk = text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || [];
  var nonCjk = text.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ');
  var words = nonCjk.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return cjk.length + words.length;
}

function getRarityProbabilities(wordCount, config) {
  if (wordCount < config.minWords) return { common: 0, rare: 0, epic: 0, legendary: 0 };
  var x = Math.min(Math.max(0, wordCount - config.rarityFormula.offset), config.rarityFormula.cap);
  var d = 100 + 10 * x;
  return {
    common: Math.max(0, 80 - (880 * x) / d),
    rare: 17 + (400 * x) / d,
    epic: 3 + (280 * x) / d,
    legendary: (200 * x) / d
  };
}

function rollSeed(wordCount, currentPity, theme, catalogSpecies, config, rng) {
  var rand = rng || ENV.rng;
  var probs = getRarityProbabilities(wordCount, config);
  var isPity = currentPity >= config.pityThreshold;
  var rarity;

  if (isPity) {
    var highSum = probs.epic + probs.legendary;
    if (probs.legendary <= 0 || highSum <= 0) {
      rarity = 'epic';
    } else {
      rarity = rand() * highSum < probs.epic ? 'epic' : 'legendary';
    }
  } else {
    var r = rand() * 100;
    if (r < probs.common) rarity = 'common';
    else if (r < probs.common + probs.rare) rarity = 'rare';
    else if (r < probs.common + probs.rare + probs.epic) rarity = 'epic';
    else rarity = 'legendary';
  }

  var nextPity = (rarity === 'epic' || rarity === 'legendary') ? 0 : currentPity + 1;
  var pool = catalogSpecies.filter(function (s) {
    return (s.theme === theme || s.theme === 'common') && s.rarity === rarity;
  });
  var chosen = pool[Math.floor(rand() * pool.length)] || catalogSpecies[0];
  return { speciesId: chosen.id, rarity: rarity, isPity: isPity, nextPity: nextPity };
}

function getStreakMultiplier(streakCount, config) {
  var mult = 1;
  for (var i = 0; i < config.streakMultipliers.length; i++) {
    var pair = config.streakMultipliers[i];
    if (streakCount >= pair[0]) mult = pair[1];
  }
  return mult;
}

function advanceStreakOnWrite(streak, todayKey) {
  var yesterday = addDays(todayKey, -1);
  if (streak.lastDay === todayKey) return Object.assign({}, streak);
  if (streak.lastDay === yesterday) {
    return {
      count: streak.count + 1,
      lastDay: todayKey,
      prevCount: streak.count,
      prevLastDay: streak.lastDay
    };
  }
  return {
    count: 1,
    lastDay: todayKey,
    prevCount: streak.count || 0,
    prevLastDay: streak.lastDay || null
  };
}

function repairStreakOnMakeUp(streak, todayKey) {
  var yesterday = addDays(todayKey, -1);
  var dayBefore = addDays(todayKey, -2);
  if (streak.lastDay === todayKey) {
    if (streak.prevLastDay === dayBefore) {
      return Object.assign({}, streak, { count: (streak.prevCount || 0) + 2 });
    }
    return Object.assign({}, streak, { count: Math.max(streak.count, 2) });
  }
  if (streak.lastDay === dayBefore) {
    return Object.assign({}, streak, { count: (streak.count || 0) + 1, lastDay: yesterday });
  }
  return Object.assign({}, streak, { count: 1, lastDay: yesterday });
}

function calcRequiredDays(baseDays, memberCount, config) {
  var key = String(Math.min(5, Math.max(1, memberCount)));
  var mult = config.groupGrowthMultiplier[key] || 1;
  return Math.ceil(baseDays * mult);
}

function calcPlantLevel(progress, requiredDays) {
  var req = Math.max(1, Number(requiredDays) || 1);
  var prog = Math.max(0, Number(progress) || 0);
  if (prog >= req) return 5;
  return Math.min(4, Math.floor((4 * prog) / req) + 1);
}

function evaluatePlantState(plant, daysMap, todayKey, gardenType) {
  var gType = gardenType || 'personal';
  if (plant.limited || plant.finalStage === 'grown') {
    var hadW = Boolean(plant.hadWilt);
    return {
      stage: 'grown',
      progress: plant.requiredDays,
      level: 5,
      miss: 0,
      hadWilt: hadW,
      isPerfect: !hadW,
      finalStage: 'grown'
    };
  }
  if (plant.finalStage === 'dead') {
    return {
      stage: 'dead',
      progress: 0,
      level: plant.finalLevel !== undefined && plant.finalLevel !== null ? plant.finalLevel : 1,
      miss: 2,
      hadWilt: true,
      isPerfect: false,
      finalStage: 'dead'
    };
  }
  if (plant.frozen) {
    return Object.assign({}, plant.frozen, { miss: 0, finalStage: null });
  }

  function contribOnDay(dk) {
    var rec = daysMap[dk];
    if (!rec) return 0;
    if (gType === 'personal') return (rec.essays || 0) > 0 ? 1 : 0;
    return Object.keys(rec.writers || {}).length;
  }

  function isMadeUp(dk) {
    return Boolean(daysMap[dk] && daysMap[dk].madeUp);
  }

  if (plant.plantedDay >= todayKey) {
    return { stage: 'growing', progress: 0, level: 1, miss: 0, hadWilt: false, isPerfect: false, finalStage: null };
  }

  var progress = 0;
  var miss = 0;
  var hadWilt = false;
  var yesterdayKey = addDays(todayKey, -1);
  var curDay = addDays(plant.plantedDay, 1);

  while (curDay <= yesterdayKey) {
    var c = contribOnDay(curDay);
    if (c > 0) {
      if (miss === 1) miss = 0;
      else progress += c;
    } else if (isMadeUp(curDay)) {
      miss = 0;
    } else {
      miss += 1;
      if (miss === 1) hadWilt = true;
      if (miss >= 2) {
        return {
          stage: 'dead',
          progress: progress,
          level: calcPlantLevel(progress, plant.requiredDays),
          miss: miss,
          hadWilt: true,
          isPerfect: false,
          finalStage: 'dead'
        };
      }
    }

    if (progress >= plant.requiredDays) {
      return { stage: 'grown', progress: plant.requiredDays, level: 5, miss: 0, hadWilt: hadW, isPerfect: !hadW, finalStage: 'grown' };
    }
    curDay = addDays(curDay, 1);
  }

  var todayContrib = contribOnDay(todayKey);
  var preMatureLevel = calcPlantLevel(progress, plant.requiredDays);
  if (miss === 1) {
    if (todayContrib > 0) {
      return { stage: 'growing', progress: progress, level: preMatureLevel, miss: 0, hadWilt: true, isPerfect: false, finalStage: null };
    }
    return { stage: 'withering', progress: progress, level: preMatureLevel, miss: 1, hadWilt: true, isPerfect: false, finalStage: null };
  }

  if (todayContrib > 0) {
    progress += todayContrib;
    if (progress >= plant.requiredDays) {
      return { stage: 'grown', progress: plant.requiredDays, level: 5, miss: 0, hadWilt: hadWilt, isPerfect: !hadWilt, finalStage: 'grown' };
    }
  }

  return {
    stage: 'growing',
    progress: progress,
    level: calcPlantLevel(progress, plant.requiredDays),
    miss: 0,
    hadWilt: hadWilt,
    isPerfect: false,
    finalStage: null
  };
}

function calculateBeauty(plantsWithState, decorList, catalog, config) {
  var spMap = catalog === CATALOG ? SPECIES_MAP : Object.fromEntries(catalog.species.map(function (s) { return [s.id, s]; }));
  var dcMap = catalog === CATALOG ? DECOR_MAP : Object.fromEntries(catalog.decor.map(function (d) { return [d.id, d]; }));
  var score = 0;

  for (var i = 0; i < plantsWithState.length; i++) {
    var p = plantsWithState[i];
    if (p.evalState.stage === 'grown') {
      var sp = spMap[p.speciesId];
      var rarity = p.limited ? 'legendary' : ((sp && sp.rarity) || 'common');
      score += (config.beauty.rarityWeight[rarity] || 1) * 3;
    } else if (p.evalState.stage === 'dead') {
      score -= config.beauty.witheredPenalty;
    }
  }
  for (var j = 0; j < decorList.length; j++) {
    var item = dcMap[decorList[j].itemId];
    if (item) score += Math.floor(item.cost / config.beauty.decorDivisor);
  }
  return score;
}

function resolveGroupThemeVote(gardenId, monthKey, votesMap, allThemes) {
  var themes = allThemes || ['flowerbed', 'forest', 'oasis'];
  var counts = {};
  for (var i = 0; i < themes.length; i++) counts[themes[i]] = 0;
  var vals = Object.values(votesMap || {});
  for (var j = 0; j < vals.length; j++) {
    if (counts[vals[j]] !== undefined) counts[vals[j]] += 1;
  }
  var maxVotes = Math.max.apply(null, Object.values(counts));
  var candidates = maxVotes === 0 ? themes : themes.filter(function (t) { return counts[t] === maxVotes; });
  if (candidates.length === 1) return candidates[0];

  var seedStr = gardenId + ':' + monthKey;
  var h = 2166136261;
  for (var k = 0; k < seedStr.length; k++) {
    h ^= seedStr.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return candidates[(h >>> 0) % candidates.length];
}

// ----------------------------------------------------------------------------
// 3. 密碼與 Session 雜湊（單向加鹽 SHA-256 + 常數時間比對）
// ----------------------------------------------------------------------------
function bytesToHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function sha256Hex(str) {
  return bytesToHex(ENV.sha256Bytes(String(str)));
}

function timingSafeEqualStr(a, b) {
  var sa = String(a);
  var sb = String(b);
  var diff = sa.length ^ sb.length;
  var len = Math.max(sa.length, sb.length);
  for (var i = 0; i < len; i++) {
    var ca = i < sa.length ? sa.charCodeAt(i) : 0;
    var cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function randomHex256() {
  return (ENV.getUuid() + ENV.getUuid()).replace(/-/g, '');
}

function hashPassword(password, fixedSalt) {
  var salt = fixedSalt || sha256Hex(ENV.getUuid() + ':' + ENV.nowMs() + ':' + ENV.rng()).slice(0, 32);
  var acc = salt + ':' + password;
  for (var i = 0; i < PASSWORD_ROUNDS; i++) {
    acc = sha256Hex(acc + ':' + salt + ':' + password);
  }
  return 's256$' + salt + '$' + acc;
}

function verifyPassword(password, storedHash) {
  var parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's256') return false;
  var expected = hashPassword(password, parts[1]);
  return timingSafeEqualStr(expected, storedHash);
}

// ----------------------------------------------------------------------------
// 4. Google Sheets 批次讀寫與序列化工具（全走 RAW 模式）
// ----------------------------------------------------------------------------
function colToLetter(col1) {
  var s = '';
  var n = col1;
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseJsonSafe(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  return JSON.parse(String(raw));
}

function randId4() {
  return Math.floor(ENV.rng() * 0x10000).toString(36).padStart(4, '0').slice(0, 4);
}

function randomTokenHex() {
  return randomHex256();
}

function makeId(prefix, nowMs) {
  return prefix + nowMs + '_' + randId4();
}

function normalizeTimeZone(tz) {
  var s = String(tz || '').trim() || 'Asia/Taipei';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: s });
    return s;
  } catch (err) {
    throw appError('VALIDATION_ERROR', '無效的時區設定');
  }
}

function isTestUid(uid) {
  return String(uid || '').indexOf('u_test_') === 0;
}

function valuesBatchGet(ranges) {
  if (!ranges.length) return [];
  var res = ENV.Sheets.Spreadsheets.Values.batchGet(ENV.spreadsheetId, {
    ranges: ranges,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return res.valueRanges || [];
}

function valuesBatchWrite(dataItems) {
  if (!dataItems.length) return;
  ENV.Sheets.Spreadsheets.Values.batchUpdate(
    { valueInputOption: 'RAW', data: dataItems },
    ENV.spreadsheetId
  );
}

function ensureSheetCapacity(sheetName, neededRow, neededCol) {
  var ss = ENV.SpreadsheetApp.openById(ENV.spreadsheetId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw appError('NOT_FOUND', '找不到工作表：' + sheetName);

  var mutated = false;
  var maxRows = sheet.getMaxRows();
  if (neededRow > maxRows) {
    var addRows = Math.max(100, neededRow - maxRows);
    sheet.insertRowsAfter(maxRows, addRows);
    if (sheetName === 'essays') {
      sheet.getRange(maxRows + 1, 1, addRows, sheet.getMaxColumns()).setNumberFormat('@');
    }
    mutated = true;
  }
  var maxCols = sheet.getMaxColumns();
  if (neededCol > maxCols) {
    var addCols = neededCol - maxCols;
    sheet.insertColumnsAfter(maxCols, addCols);
    if (sheetName === 'essays') {
      sheet.getRange(1, maxCols + 1, sheet.getMaxRows(), addCols).setNumberFormat('@');
    }
    mutated = true;
  }
  if (mutated && ENV.SpreadsheetApp && typeof ENV.SpreadsheetApp.flush === 'function') {
    ENV.SpreadsheetApp.flush();
  }
  return sheet;
}

function formatEssaysColumnText(col1) {
  var ss = ENV.SpreadsheetApp.openById(ENV.spreadsheetId);
  var sheet = ss.getSheetByName('essays');
  if (!sheet) throw appError('NOT_FOUND', '找不到工作表：essays');
  if (col1 > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), col1 - sheet.getMaxColumns());
  }
  sheet.getRange(1, col1, sheet.getMaxRows(), 1).setNumberFormat('@');
  if (ENV.SpreadsheetApp && typeof ENV.SpreadsheetApp.flush === 'function') {
    ENV.SpreadsheetApp.flush();
  }
}

function rowArrayToUser(row, rowIdx) {
  return {
    rowIdx: rowIdx,
    uid: String(row[0] || ''),
    username: String(row[1] || ''),
    passwordHash: String(row[2] || ''),
    sessionHashes: parseJsonSafe(row[3], []),
    displayName: String(row[4] || ''),
    timezone: String(row[5] || 'Asia/Taipei'),
    activeGroupId: String(row[6] || ''),
    energy: Number(row[7] || 0),
    pity: Number(row[8] || 0),
    streakCount: Number(row[9] || 0),
    streakLastDay: String(row[10] || ''),
    streakPrevCount: Number(row[11] || 0),
    streakPrevLastDay: String(row[12] || ''),
    seeds: parseJsonSafe(row[13], {}),
    limitedSeeds: parseJsonSafe(row[14], {}),
    milestones: parseJsonSafe(row[15], []),
    dex: parseJsonSafe(row[16], []),
    lastCardStyle: String(row[17] || 'card1'),
    makeupDays: parseJsonSafe(row[18], []),
    createdAt: Number(row[19] || 0),
    updatedAt: Number(row[20] || 0)
  };
}

function userToRowArray(u) {
  return [
    u.uid,
    u.username,
    u.passwordHash,
    JSON.stringify(u.sessionHashes || []),
    u.displayName,
    u.timezone,
    u.activeGroupId || '',
    Number(u.energy || 0),
    Number(u.pity || 0),
    Number(u.streakCount || 0),
    u.streakLastDay || '',
    Number(u.streakPrevCount || 0),
    u.streakPrevLastDay || '',
    JSON.stringify(u.seeds || {}),
    JSON.stringify(u.limitedSeeds || {}),
    JSON.stringify(u.milestones || []),
    JSON.stringify(u.dex || []),
    u.lastCardStyle || 'card1',
    JSON.stringify(u.makeupDays || []),
    Number(u.createdAt || 0),
    Number(u.updatedAt || 0)
  ];
}

function rowArrayToGroup(row, rowIdx) {
  return {
    rowIdx: rowIdx,
    groupId: String(row[0] || ''),
    name: String(row[1] || ''),
    ownerUid: String(row[2] || ''),
    status: String(row[3] || 'active'),
    inviteCode: String(row[4] || ''),
    memberUids: parseJsonSafe(row[5], []),
    formerMemberUids: parseJsonSafe(row[6], []),
    timezone: String(row[7] || 'Asia/Taipei'),
    themeVoteMonth: String(row[8] || ''),
    themeVotes: parseJsonSafe(row[9], {}),
    makeupDays: parseJsonSafe(row[10], []),
    createdAt: Number(row[11] || 0),
    updatedAt: Number(row[12] || 0)
  };
}

function groupToRowArray(g) {
  return [
    g.groupId,
    g.name,
    g.ownerUid,
    g.status || 'active',
    g.inviteCode || '',
    JSON.stringify(g.memberUids || []),
    JSON.stringify(g.formerMemberUids || []),
    g.timezone || 'Asia/Taipei',
    g.themeVoteMonth || '',
    JSON.stringify(g.themeVotes || {}),
    JSON.stringify(g.makeupDays || []),
    Number(g.createdAt || 0),
    Number(g.updatedAt || 0)
  ];
}

function rowArrayToGarden(row, rowIdx) {
  var items = parseJsonSafe(row[9], { plants: {}, decor: {} });
  if (!items.plants) items.plants = {};
  if (!items.decor) items.decor = {};
  return {
    rowIdx: rowIdx,
    gardenId: String(row[0] || ''),
    ownerType: String(row[1] || 'personal'),
    ownerId: String(row[2] || ''),
    month: String(row[3] || ''),
    theme: String(row[4] || 'flowerbed'),
    status: String(row[5] || 'active'),
    snapshotName: String(row[6] || ''),
    size: Number(row[7] || 5),
    expansions: Number(row[8] || 0),
    items: items,
    createdAt: Number(row[10] || 0),
    updatedAt: Number(row[11] || 0)
  };
}

function gardenToRowArray(g) {
  return [
    g.gardenId,
    g.ownerType,
    g.ownerId,
    g.month,
    g.theme,
    g.status,
    g.snapshotName || '',
    Number(g.size),
    Number(g.expansions || 0),
    JSON.stringify(g.items || { plants: {}, decor: {} }),
    Number(g.createdAt || 0),
    Number(g.updatedAt || 0)
  ];
}

function loadCoreTables() {
  var vRanges = valuesBatchGet(['users!A1:U', 'groups!A1:M', 'gardens!A1:L']);
  var userVals = (vRanges[0] && vRanges[0].values) || [];
  var groupVals = (vRanges[1] && vRanges[1].values) || [];
  var gardenVals = (vRanges[2] && vRanges[2].values) || [];

  var users = [];
  var userByUid = {};
  var userByName = {};
  for (var i = 1; i < userVals.length; i++) {
    if (!userVals[i][0]) continue;
    var u = rowArrayToUser(userVals[i], i + 1);
    users.push(u);
    userByUid[u.uid] = u;
    userByName[u.username.trim().toLowerCase()] = u;
  }

  var groups = [];
  var groupById = {};
  for (var j = 1; j < groupVals.length; j++) {
    if (!groupVals[j][0]) continue;
    var grp = rowArrayToGroup(groupVals[j], j + 1);
    groups.push(grp);
    groupById[grp.groupId] = grp;
  }

  var gardens = [];
  var gardenById = {};
  for (var k = 1; k < gardenVals.length; k++) {
    if (!gardenVals[k][0]) continue;
    var gd = rowArrayToGarden(gardenVals[k], k + 1);
    gardens.push(gd);
    gardenById[gd.gardenId] = gd;
  }

  return {
    users: users,
    userByUid: userByUid,
    userByName: userByName,
    nextUserRow: Math.max(2, userVals.length + 1),
    groups: groups,
    groupById: groupById,
    nextGroupRow: Math.max(2, groupVals.length + 1),
    gardens: gardens,
    gardenById: gardenById,
    nextGardenRow: Math.max(2, gardenVals.length + 1)
  };
}

function writeRowUpdates(tabName, rowEntries, endColLetter) {
  var items = [];
  var maxRow = 0;
  for (var i = 0; i < rowEntries.length; i++) {
    var entry = rowEntries[i];
    if (entry.rowIdx > maxRow) maxRow = entry.rowIdx;
    items.push({
      range: tabName + '!A' + entry.rowIdx + ':' + endColLetter + entry.rowIdx,
      values: [entry.values]
    });
  }
  if (maxRow > 0) ensureSheetCapacity(tabName, maxRow, 1);
  valuesBatchWrite(items);
}

// ----------------------------------------------------------------------------
// 5. 隨筆矩陣讀取與彙算（batchGet + 視窗收斂）
// ----------------------------------------------------------------------------
function loadEssaysIndex() {
  var vRanges = valuesBatchGet(['essays!1:1', 'essays!A2:A']);
  var hdrRow = (vRanges[0] && vRanges[0].values && vRanges[0].values[0]) || [];
  var dayRows = (vRanges[1] && vRanges[1].values) || [];

  var uidToCol = {};
  for (var c = 1; c < hdrRow.length; c++) {
    var uid = String(hdrRow[c] || '').trim();
    if (uid) uidToCol[uid] = c + 1;
  }

  var dayToRow = {};
  var rowEntries = [];
  for (var r = 0; r < dayRows.length; r++) {
    var dk = String((dayRows[r] && dayRows[r][0]) || '').trim();
    if (dk) {
      dayToRow[dk] = r + 2;
      rowEntries.push({ rowIdx: r + 2, dayKey: dk });
    }
  }

  return {
    uidToCol: uidToCol,
    nextCol1: Math.max(2, hdrRow.length + 1),
    dayToRow: dayToRow,
    rowEntries: rowEntries,
    nextRowIdx: Math.max(2, dayRows.length + 2)
  };
}

function buildRowSegments(rowIndices) {
  if (!rowIndices.length) return [];
  var sorted = rowIndices.slice().sort(function (a, b) { return a - b; });
  var segs = [[sorted[0], sorted[0]]];
  for (var i = 1; i < sorted.length; i++) {
    var last = segs[segs.length - 1];
    if (sorted[i] === last[1] + 1) last[1] = sorted[i];
    else segs.push([sorted[i], sorted[i]]);
  }
  return segs;
}

function fetchEssaysMatrixSlice(index, targetUids, rowFilterFn) {
  var matchingRows = index.rowEntries.filter(function (e) { return rowFilterFn(e.dayKey); });
  if (!matchingRows.length) return {};

  var rowToDay = {};
  var rowNums = [];
  for (var i = 0; i < matchingRows.length; i++) {
    rowToDay[matchingRows[i].rowIdx] = matchingRows[i].dayKey;
    rowNums.push(matchingRows[i].rowIdx);
  }
  var segs = buildRowSegments(rowNums);

  var validUids = [];
  var ranges = [];
  var rangeMeta = [];
  for (var u = 0; u < targetUids.length; u++) {
    var uid = targetUids[u];
    var col1 = index.uidToCol[uid];
    if (!col1) continue;
    validUids.push(uid);
    var colLtr = colToLetter(col1);
    for (var s = 0; s < segs.length; s++) {
      ranges.push('essays!' + colLtr + segs[s][0] + ':' + colLtr + segs[s][1]);
      rangeMeta.push({ uid: uid, startRow: segs[s][0] });
    }
  }
  if (!ranges.length) return {};

  var vRanges = valuesBatchGet(ranges);
  var out = {};
  for (var v = 0; v < vRanges.length; v++) {
    var meta = rangeMeta[v];
    var colVals = (vRanges[v] && vRanges[v].values) || [];
    if (!out[meta.uid]) out[meta.uid] = {};
    for (var r = 0; r < colVals.length; r++) {
      var rawCell = colVals[r] && colVals[r][0];
      if (!rawCell) continue;
      var dk = rowToDay[meta.startRow + r];
      if (!dk) continue;
      out[meta.uid][dk] = parseJsonSafe(rawCell, []);
    }
  }
  return out;
}

function readSingleEssayCell(index, dayKey, uid) {
  var col1 = index.uidToCol[uid];
  var rowIdx = index.dayToRow[dayKey];
  if (!col1 || !rowIdx) return { rowIdx: rowIdx || 0, col1: col1 || 0, list: [] };
  var colLtr = colToLetter(col1);
  var vRanges = valuesBatchGet(['essays!' + colLtr + rowIdx]);
  var vals = vRanges[0] && vRanges[0].values;
  var raw = vals && vals[0] && vals[0][0];
  return { rowIdx: rowIdx, col1: col1, list: raw ? parseJsonSafe(raw, []) : [] };
}

function computeUserAndGroupDays(user, group, matrixByUid) {
  var userDays = {};
  var myCells = matrixByUid[user.uid] || {};
  var myDaysKeys = Object.keys(myCells);
  for (var i = 0; i < myDaysKeys.length; i++) {
    var dk = myDaysKeys[i];
    var arr = myCells[dk] || [];
    var words = 0;
    var lastAt = 0;
    var seedsGiven = 0;
    for (var j = 0; j < arr.length; j++) {
      words += Number(arr[j].wordCount || 0);
      if (Number(arr[j].createdAt || 0) > lastAt) lastAt = Number(arr[j].createdAt || 0);
      if (!arr[j].groupId && arr[j].reward && arr[j].reward.type === 'seed') {
        seedsGiven += 1;
      }
    }
    userDays[dk] = { essays: arr.length, words: words, lastEssayAt: lastAt, madeUp: false, seedsGiven: seedsGiven };
  }
  for (var m = 0; m < user.makeupDays.length; m++) {
    var mdk = user.makeupDays[m];
    if (!userDays[mdk]) userDays[mdk] = { essays: 0, words: 0, lastEssayAt: 0, madeUp: true, seedsGiven: 0 };
    else userDays[mdk].madeUp = true;
  }

  var groupDays = {};
  if (group) {
    var allMemberUids = Array.from(new Set(group.memberUids.concat(group.formerMemberUids)));
    for (var u = 0; u < allMemberUids.length; u++) {
      var mUid = allMemberUids[u];
      var cells = matrixByUid[mUid] || {};
      var dks = Object.keys(cells);
      for (var d = 0; d < dks.length; d++) {
        var gdk = dks[d];
        var list = cells[gdk] || [];
        for (var e = 0; e < list.length; e++) {
          var item = list[e];
          if (item.groupId !== group.groupId) continue;
          if (!groupDays[gdk]) groupDays[gdk] = { seedsGiven: 0, writers: {}, madeUp: false };
          if (item.reward && item.reward.type === 'seed') groupDays[gdk].seedsGiven += 1;
          var prevTs = groupDays[gdk].writers[mUid] || 0;
          if (Number(item.createdAt || 0) > prevTs) groupDays[gdk].writers[mUid] = Number(item.createdAt || 0);
        }
      }
    }
    for (var gm = 0; gm < group.makeupDays.length; gm++) {
      var gmdk = group.makeupDays[gm];
      if (!groupDays[gmdk]) groupDays[gmdk] = { seedsGiven: 0, writers: {}, madeUp: true };
      else groupDays[gmdk].madeUp = true;
    }
  }

  return { userDays: userDays, groupDays: groupDays };
}

function buildEssayDto(rawEssay, authorUid, dayKey, userByUid) {
  var author = userByUid[authorUid];
  return {
    id: rawEssay.id,
    gardenId: rawEssay.gardenId,
    groupId: rawEssay.groupId || '',
    authorUid: authorUid,
    authorName: author ? author.displayName : authorUid,
    dayKey: dayKey,
    content: rawEssay.content,
    wordCount: rawEssay.wordCount,
    private: Boolean(rawEssay.private),
    cardStyle: rawEssay.cardStyle || null,
    reward: rawEssay.reward,
    reactions: rawEssay.reactions || {},
    createdAt: rawEssay.createdAt,
    updatedAt: rawEssay.updatedAt
  };
}

// ----------------------------------------------------------------------------
// 6. DTO 序列化（嚴格過濾敏感欄位與私密隨筆）
// ----------------------------------------------------------------------------
function toUserDto(u) {
  return {
    uid: u.uid,
    username: u.username,
    displayName: u.displayName,
    timezone: u.timezone,
    activeGroupId: u.activeGroupId || '',
    energy: u.energy,
    pity: u.pity,
    streak: {
      count: u.streakCount,
      lastDay: u.streakLastDay || null,
      prevCount: u.streakPrevCount,
      prevLastDay: u.streakPrevLastDay || null
    },
    seeds: u.seeds,
    limitedSeeds: u.limitedSeeds,
    milestones: u.milestones,
    dex: u.dex,
    lastCardStyle: u.lastCardStyle,
    makeupDays: u.makeupDays
  };
}

function toGroupDto(grp) {
  if (!grp) return null;
  return {
    groupId: grp.groupId,
    name: grp.name,
    ownerUid: grp.ownerUid,
    status: grp.status,
    inviteCode: grp.inviteCode,
    memberUids: grp.memberUids,
    formerMemberUids: grp.formerMemberUids,
    timezone: grp.timezone,
    themeVoteMonth: grp.themeVoteMonth || '',
    themeVotes: grp.themeVotes || {},
    makeupDays: grp.makeupDays || []
  };
}

function toGardenDto(g) {
  return {
    gardenId: g.gardenId,
    ownerType: g.ownerType,
    ownerId: g.ownerId,
    month: g.month,
    theme: g.theme,
    status: g.status,
    snapshotName: g.snapshotName || '',
    size: g.size,
    expansions: g.expansions,
    items: g.items,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt
  };
}

function buildMemberDirectoryAndSummaries(user, group, gardens, essays, userByUid) {
  var dir = {};
  dir[user.uid] = user.displayName;
  var summaries = [];

  if (group) {
    var allUids = group.memberUids.concat(group.formerMemberUids);
    for (var i = 0; i < allUids.length; i++) {
      var u = userByUid[allUids[i]];
      if (u) dir[u.uid] = u.displayName;
    }
    for (var j = 0; j < group.memberUids.length; j++) {
      var mu = userByUid[group.memberUids[j]];
      if (mu) {
        summaries.push({
          uid: mu.uid,
          displayName: mu.displayName,
          streakCount: mu.streakCount,
          streakLastDay: mu.streakLastDay || null
        });
      }
    }
  }

  for (var g = 0; g < gardens.length; g++) {
    var plants = Object.values((gardens[g].items && gardens[g].items.plants) || {});
    for (var p = 0; p < plants.length; p++) {
      var pu = userByUid[plants[p].plantedBy];
      if (pu) dir[pu.uid] = pu.displayName;
    }
    var decors = Object.values((gardens[g].items && gardens[g].items.decor) || {});
    for (var d = 0; d < decors.length; d++) {
      var du = userByUid[decors[d].placedBy];
      if (du) dir[du.uid] = du.displayName;
    }
  }

  for (var e = 0; e < essays.length; e++) {
    var eu = userByUid[essays[e].authorUid];
    if (eu) dir[eu.uid] = eu.displayName;
  }

  return { memberDirectory: dir, groupMemberSummaries: summaries };
}

// ----------------------------------------------------------------------------
// 7. 換月檢查、植物懶回寫與 Bootstrap 共用引擎
// ----------------------------------------------------------------------------
function getRecentMonthsSet(todayKey, limit) {
  var rawNum = limit === undefined || limit === null || limit === '' ? 2 : parseStrictInt(limit);
  var count = Math.min(60, Math.max(1, rawNum === null ? 2 : rawNum));
  var months = [];
  var ym = todayKey.slice(0, 7).split('-').map(Number);
  var y = ym[0];
  var m = ym[1];
  for (var i = 0; i < count; i++) {
    months.push(y + '-' + String(m).padStart(2, '0'));
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return { set: Object.fromEntries(months.map(function (k) { return [k, true]; })), oldestMonth: months[months.length - 1] };
}

function getRelevantGardensForUser(tables, user, group) {
  var out = [];
  for (var i = 0; i < tables.gardens.length; i++) {
    var g = tables.gardens[i];
    if (g.ownerType === 'personal' && g.ownerId === user.uid) out.push(g);
    else if (group && g.ownerType === 'group' && g.ownerId === group.groupId) out.push(g);
  }
  return out;
}

function findMinEvalDayKey(gardens, todayKey) {
  var minDay = addDays(todayKey, -7);
  for (var i = 0; i < gardens.length; i++) {
    if (gardens[i].status === 'snapshot') continue;
    var plants = Object.values((gardens[i].items && gardens[i].items.plants) || {});
    for (var p = 0; p < plants.length; p++) {
      var pl = plants[p];
      if (!pl.finalStage && pl.plantedDay && pl.plantedDay < minDay) {
        minDay = pl.plantedDay;
      }
    }
  }
  return minDay;
}

function collectVisibleEssays(matrixByUid, user, group, allowedMonthsSet, userByUid) {
  var essays = [];
  var uids = [user.uid];
  if (group) {
    for (var i = 0; i < group.memberUids.length; i++) {
      if (group.memberUids[i] !== user.uid) uids.push(group.memberUids[i]);
    }
  }

  for (var u = 0; u < uids.length; u++) {
    var aUid = uids[u];
    var cells = matrixByUid[aUid] || {};
    var dks = Object.keys(cells);
    for (var d = 0; d < dks.length; d++) {
      var dk = dks[d];
      if (allowedMonthsSet && !allowedMonthsSet[dk.slice(0, 7)]) continue;
      var arr = cells[dk] || [];
      for (var k = 0; k < arr.length; k++) {
        var raw = arr[k];
        if (aUid === user.uid) {
          essays.push(buildEssayDto(raw, aUid, dk, userByUid));
        } else if (group && raw.groupId === group.groupId && !raw.private) {
          essays.push(buildEssayDto(raw, aUid, dk, userByUid));
        }
      }
    }
  }
  essays.sort(function (a, b) { return Number(b.createdAt || 0) - Number(a.createdAt || 0); });
  return essays;
}

function computeBootstrapState(tables, essayIndex, user, essayMonthsLimit, nowMs) {
  var group = user.activeGroupId ? tables.groupById[user.activeGroupId] : null;
  var gardens = getRelevantGardensForUser(tables, user, group);
  var activeTz = group ? group.timezone : user.timezone;
  var todayKey = getGameDayKey(nowMs, activeTz, GAME_CONFIG.dayBoundaryHour);
  var recent = getRecentMonthsSet(todayKey, essayMonthsLimit || 2);
  var minEvalDay = findMinEvalDayKey(gardens, todayKey);

  var targetUids = [user.uid];
  if (group) {
    targetUids = Array.from(new Set(targetUids.concat(group.memberUids, group.formerMemberUids)));
  }

  var matrixByUid = fetchEssaysMatrixSlice(essayIndex, targetUids, function (dk) {
    return dk >= minEvalDay || Boolean(recent.set[dk.slice(0, 7)]);
  });

  var days = computeUserAndGroupDays(user, group, matrixByUid);

  // 以 essays!A2:A 日期列做 O(1) 近似判斷，省去跨欄全掃成本（僅影響歷史月份展開按鈕顯示）
  var hasMoreEssayHistory = essayIndex.rowEntries.some(function (e) {
    return e.dayKey.slice(0, 7) < recent.oldestMonth;
  });

  // 檢查是否需要寫回（團體開票／跨月自動開島／植物成熟或連缺>=3天死亡懶回寫）
  var needsGroupVoteOpen = false;
  var needsGroupMonthTransition = false;
  var currentGroupMonth = null;
  var nextVoteMonth = null;
  var activeGroupGarden = null;

  if (group) {
    var gToday = getGameDayKey(nowMs, group.timezone, GAME_CONFIG.dayBoundaryHour);
    currentGroupMonth = gToday.slice(0, 7);
    if (isLastDayOfMonth(gToday)) {
      nextVoteMonth = addDays(gToday, 1).slice(0, 7);
      if (group.themeVoteMonth !== nextVoteMonth) needsGroupVoteOpen = true;
    }
    for (var g = 0; g < gardens.length; g++) {
      if (gardens[g].ownerType === 'group' && gardens[g].status === 'active') {
        activeGroupGarden = gardens[g];
        break;
      }
    }
    if (activeGroupGarden && activeGroupGarden.month !== currentGroupMonth) {
      needsGroupMonthTransition = true;
    }
  }

  var plantMutations = [];
  for (var gi = 0; gi < gardens.length; gi++) {
    var gd = gardens[gi];
    if (gd.status === 'snapshot') continue;
    var gTz = gd.ownerType === 'group' && group ? group.timezone : user.timezone;
    var gdToday = getGameDayKey(nowMs, gTz, GAME_CONFIG.dayBoundaryHour);
    var gdYesterday = addDays(gdToday, -1);
    var srcDays = gd.ownerType === 'group' ? days.groupDays : days.userDays;

    var plants = Object.values(gd.items.plants || {});
    var changed = false;
    for (var pi = 0; pi < plants.length; pi++) {
      var pl = plants[pi];
      if (pl.finalStage) continue;
      var ev = evaluatePlantState(pl, srcDays, gdToday, gd.ownerType);
      if (ev.stage === 'grown') {
        pl.finalStage = 'grown';
        pl.hadWilt = Boolean(ev.hadWilt);
        pl.finalLevel = 5;
        changed = true;
      } else if (ev.stage === 'dead') {
        // 僅在連缺 >= 3 天（模擬補寫昨天仍為 dead）時才永久寫回 finalStage='dead'
        var simDays = Object.assign({}, srcDays);
        simDays[gdYesterday] = Object.assign({}, srcDays[gdYesterday] || {}, { madeUp: true });
        var simEv = evaluatePlantState(pl, simDays, gdToday, gd.ownerType);
        if (simEv.stage === 'dead') {
          pl.finalStage = 'dead';
          pl.hadWilt = true;
          pl.finalLevel = ev.level;
          changed = true;
        }
      }
    }
    if (changed) plantMutations.push(gd);
  }

  return {
    group: group,
    gardens: gardens,
    matrixByUid: matrixByUid,
    userDays: days.userDays,
    groupDays: days.groupDays,
    recent: recent,
    hasMoreEssayHistory: hasMoreEssayHistory,
    needsWriteback: needsGroupVoteOpen || needsGroupMonthTransition || plantMutations.length > 0,
    needsGroupVoteOpen: needsGroupVoteOpen,
    nextVoteMonth: nextVoteMonth,
    needsGroupMonthTransition: needsGroupMonthTransition,
    currentGroupMonth: currentGroupMonth,
    activeGroupGarden: activeGroupGarden,
    plantMutations: plantMutations
  };
}

function buildGardenRecord(tables, opts) {
  var prefix = opts.prefix || (isTestUid(opts.prefixUid || opts.ownerId) ? 'g_test_' : 'g_');
  var garden = {
    rowIdx: tables.nextGardenRow,
    gardenId: makeId(prefix, opts.nowMs),
    ownerType: opts.ownerType,
    ownerId: opts.ownerId,
    month: opts.month,
    theme: opts.theme,
    status: opts.status || 'active',
    snapshotName: opts.snapshotName || '',
    size: opts.size || GAME_CONFIG.regionSize[opts.ownerType],
    expansions: opts.expansions || 0,
    items: opts.items || { plants: {}, decor: {} },
    createdAt: opts.nowMs,
    updatedAt: opts.nowMs
  };
  tables.nextGardenRow += 1;
  tables.gardens.push(garden);
  tables.gardenById[garden.gardenId] = garden;
  return garden;
}

function archiveActivePersonalGardens(tables, uid, nowMs, rejectSameMonth) {
  var updates = [];
  for (var i = 0; i < tables.gardens.length; i++) {
    var gd = tables.gardens[i];
    if (gd.ownerType === 'personal' && gd.ownerId === uid && gd.status === 'active') {
      if (rejectSameMonth && gd.month === rejectSameMonth) {
        throw appError('VALIDATION_ERROR', '本月已經建立個人活動花園');
      }
      gd.status = 'archived';
      gd.updatedAt = nowMs;
      updates.push({ rowIdx: gd.rowIdx, values: gardenToRowArray(gd) });
    }
  }
  return updates;
}

function applyBootstrapWritebacksLocked(tables, state, nowMs) {
  var groupUpdates = [];
  var gardenUpdates = [];

  if (state.needsGroupMonthTransition && state.group && state.activeGroupGarden) {
    var votes = state.group.themeVoteMonth === state.currentGroupMonth ? state.group.themeVotes : {};
    var winTheme = resolveGroupThemeVote(state.group.groupId, state.currentGroupMonth, votes);
    state.activeGroupGarden.status = 'archived';
    state.activeGroupGarden.updatedAt = nowMs;
    gardenUpdates.push({ rowIdx: state.activeGroupGarden.rowIdx, values: gardenToRowArray(state.activeGroupGarden) });

    var newGarden = buildGardenRecord(tables, {
      prefixUid: state.group.ownerUid,
      ownerType: 'group',
      ownerId: state.group.groupId,
      month: state.currentGroupMonth,
      theme: winTheme,
      nowMs: nowMs
    });
    state.gardens.push(newGarden);
    gardenUpdates.push({ rowIdx: newGarden.rowIdx, values: gardenToRowArray(newGarden) });

    state.group.themeVoteMonth = '';
    state.group.themeVotes = {};
    state.group.updatedAt = nowMs;
  }

  if (state.needsGroupVoteOpen && state.group) {
    state.group.themeVoteMonth = state.nextVoteMonth;
    state.group.themeVotes = {};
    state.group.updatedAt = nowMs;
  }

  if ((state.needsGroupVoteOpen || state.needsGroupMonthTransition) && state.group) {
    groupUpdates.push({ rowIdx: state.group.rowIdx, values: groupToRowArray(state.group) });
  }

  for (var i = 0; i < state.plantMutations.length; i++) {
    var gd = state.plantMutations[i];
    if (state.activeGroupGarden && gd.gardenId === state.activeGroupGarden.gardenId && state.needsGroupMonthTransition) {
      continue; // already queued above
    }
    gd.updatedAt = nowMs;
    gardenUpdates.push({ rowIdx: gd.rowIdx, values: gardenToRowArray(gd) });
  }

  if (groupUpdates.length) writeRowUpdates('groups', groupUpdates, 'M');
  if (gardenUpdates.length) writeRowUpdates('gardens', gardenUpdates, 'L');
}

function finalizeBootstrapResponse(tables, user, state) {
  var essays = collectVisibleEssays(state.matrixByUid, user, state.group, state.recent.set, tables.userByUid);
  var dirInfo = buildMemberDirectoryAndSummaries(user, state.group, state.gardens, essays, tables.userByUid);

  return {
    user: toUserDto(user),
    group: toGroupDto(state.group),
    gardens: state.gardens.map(toGardenDto),
    essays: essays,
    userDays: state.userDays,
    groupDays: state.groupDays,
    memberDirectory: dirInfo.memberDirectory,
    groupMemberSummaries: dirInfo.groupMemberSummaries,
    hasMoreEssayHistory: state.hasMoreEssayHistory
  };
}

// ----------------------------------------------------------------------------
// 8. 共用驗證與鎖工具
// ----------------------------------------------------------------------------
function withScriptLock(fn) {
  var lock = ENV.LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw appError('LOCK_TIMEOUT', '伺服器忙碌中，請稍後再試');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function authenticateSession(tables, authToken) {
  var token = String(authToken || '').trim();
  if (!token) throw appError('AUTH_INVALID', '尚未登入或登入憑證無效');
  var tokenHash = sha256Hex(token);

  for (var i = 0; i < tables.users.length; i++) {
    var u = tables.users[i];
    var hashes = u.sessionHashes || [];
    for (var h = 0; h < hashes.length; h++) {
      if (timingSafeEqualStr(hashes[h], tokenHash)) {
        return { user: u, tokenHash: tokenHash };
      }
    }
  }
  throw appError('AUTH_INVALID', '登入憑證無效或已登出，請重新輸入帳號密碼');
}

function getActiveTargetGarden(tables, user) {
  var group = user.activeGroupId ? tables.groupById[user.activeGroupId] : null;
  var ownerType = group ? 'group' : 'personal';
  var ownerId = group ? group.groupId : user.uid;
  var tz = group ? group.timezone : user.timezone;
  var todayKey = getGameDayKey(ENV.nowMs(), tz, GAME_CONFIG.dayBoundaryHour);

  var activeGarden = null;
  for (var i = 0; i < tables.gardens.length; i++) {
    var g = tables.gardens[i];
    if (g.ownerType === ownerType && g.ownerId === ownerId && g.status === 'active') {
      activeGarden = g;
      break;
    }
  }
  return { group: group, garden: activeGarden, tz: tz, todayKey: todayKey };
}

function assertGardenAccess(tables, user, gardenId) {
  var garden = tables.gardenById[gardenId];
  if (!garden) throw appError('NOT_FOUND', '找不到指定花園區域');
  if (garden.ownerType === 'personal') {
    if (garden.ownerId !== user.uid) throw appError('FORBIDDEN', '無權限操作他人的花園');
  } else if (garden.ownerType === 'group') {
    if (!user.activeGroupId || garden.ownerId !== user.activeGroupId) {
      throw appError('FORBIDDEN', '無權限操作非所屬團體花園');
    }
  } else {
    throw appError('FORBIDDEN', '未知的花園權限類型');
  }
  return garden;
}

function isCellOccupied(garden, x, y, ignoreId) {
  var nx = Number(x);
  var ny = Number(y);
  var plants = Object.values((garden.items && garden.items.plants) || {});
  for (var i = 0; i < plants.length; i++) {
    if (plants[i].id !== ignoreId && Number(plants[i].x) === nx && Number(plants[i].y) === ny) return true;
  }
  var decor = Object.values((garden.items && garden.items.decor) || {});
  for (var j = 0; j < decor.length; j++) {
    if (decor[j].id !== ignoreId && Number(decor[j].x) === nx && Number(decor[j].y) === ny) return true;
  }
  return false;
}

function parseStrictInt(val) {
  if (val === null || val === undefined || typeof val === 'boolean') return null;
  if (typeof val === 'string') {
    var s = val.trim();
    if (!s || !/^-?\d+$/.test(s)) return null;
    var parsed = Number(s);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) ? val : null;
  }
  return null;
}

function assertValidCoords(garden, x, y) {
  var nx = parseStrictInt(x);
  var ny = parseStrictInt(y);
  if (nx === null || ny === null || nx < 0 || ny < 0 || nx >= garden.size || ny >= garden.size) {
    throw appError('OUT_OF_BOUNDS', '座標超出花園格子範圍');
  }
  return { nx: nx, ny: ny };
}

function generateUniqueInviteCode(tables) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var used = {};
  for (var i = 0; i < tables.groups.length; i++) {
    if (tables.groups[i].status === 'active' && tables.groups[i].inviteCode) {
      used[tables.groups[i].inviteCode] = true;
    }
  }
  for (var attempt = 0; attempt < 50; attempt++) {
    var code = '';
    for (var c = 0; c < 6; c++) {
      code += chars[Math.floor(ENV.rng() * chars.length)];
    }
    if (!used[code]) return code;
  }
  throw appError('LOCK_TIMEOUT', '無法產生唯一邀請碼，請再試一次');
}

function writeEssayCell(essayIndex, dayKey, uid, dayList) {
  var serialized = JSON.stringify(dayList);
  if (serialized.length > MAX_ESSAY_CELL_CHARS) {
    throw appError('CELL_LIMIT_EXCEEDED', '單日隨筆儲存容量已達上限，請拆分至其他日期或精簡內容');
  }
  if (serialized.length >= 40000 && typeof console !== 'undefined' && console.warn) {
    console.warn('writeEssayCell approaching 50k limit: dayKey=' + dayKey + ' uid=' + uid + ' len=' + serialized.length);
  }
  var col1 = essayIndex.uidToCol[uid];
  if (!col1) throw appError('NOT_FOUND', '找不到使用者隨筆欄位');

  var rowIdx = essayIndex.dayToRow[dayKey];
  var writes = [];
  if (!rowIdx) {
    rowIdx = essayIndex.nextRowIdx;
    essayIndex.nextRowIdx += 1;
    essayIndex.dayToRow[dayKey] = rowIdx;
    essayIndex.rowEntries.push({ rowIdx: rowIdx, dayKey: dayKey });
    ensureSheetCapacity('essays', rowIdx, col1);
    writes.push({ range: 'essays!A' + rowIdx, values: [[dayKey]] });
  } else {
    ensureSheetCapacity('essays', rowIdx, col1);
  }
  writes.push({ range: 'essays!' + colToLetter(col1) + rowIdx, values: [[serialized]] });
  valuesBatchWrite(writes);
}

// ----------------------------------------------------------------------------
// 9. 22 個 Action 處理器
// ----------------------------------------------------------------------------
function handlePing() {
  return { pong: true };
}

function handleAuth(payload) {
  var rawUsername = String((payload && payload.username) || '').trim();
  var password = payload && typeof payload.password === 'string' ? payload.password : '';
  if (!USERNAME_RE.test(rawUsername)) {
    throw appError('VALIDATION_ERROR', '帳號須為 2～24 字元（僅限中英文、數字或 _ - .，不可含空白）');
  }
  if (password.length < 4 || password.length > 128) {
    throw appError('VALIDATION_ERROR', '密碼長度須為 4～128 字元');
  }
  var normUsername = rawUsername.toLowerCase();
  var tz = normalizeTimeZone(payload && payload.timezone);

  var tables = loadCoreTables();
  var essayIndex = loadEssaysIndex();
  var now = ENV.nowMs();
  var existing = tables.userByName[normUsername];
  var sessionToken = randomTokenHex();
  var sessionHash = sha256Hex(sessionToken);
  var isNewUser = false;
  var user;

  if (existing) {
    if (!verifyPassword(password, existing.passwordHash)) {
      throw appError('AUTH_INVALID', '此帳號已存在，但密碼不正確；若要建立新帳號請換一個帳號');
    }
    user = existing;
    if (!user.sessionHashes.includes(sessionHash)) user.sessionHashes.push(sessionHash);
    user.updatedAt = now;
    writeRowUpdates('users', [{ rowIdx: user.rowIdx, values: userToRowArray(user) }], 'U');
  } else {
    isNewUser = true;
    var uid = normUsername.indexOf('u_test_') === 0 ? normUsername : makeId('u_', now);
    // 若非測試帳號碰巧撞 uid，補一次隨機
    while (tables.userByUid[uid]) {
      uid = makeId('u_', now);
    }

    user = {
      rowIdx: tables.nextUserRow,
      uid: uid,
      username: normUsername,
      passwordHash: hashPassword(password),
      sessionHashes: [sessionHash],
      displayName: rawUsername,
      timezone: tz,
      activeGroupId: '',
      energy: 65,
      pity: 0,
      streakCount: 0,
      streakLastDay: '',
      streakPrevCount: 0,
      streakPrevLastDay: '',
      seeds: {},
      limitedSeeds: {},
      milestones: [],
      dex: [],
      lastCardStyle: 'card1',
      makeupDays: [],
      createdAt: now,
      updatedAt: now
    };
    tables.nextUserRow += 1;
    tables.users.push(user);
    tables.userByUid[user.uid] = user;
    tables.userByName[user.username] = user;

    var todayKey = getGameDayKey(now, tz, GAME_CONFIG.dayBoundaryHour);
    var initGarden = buildGardenRecord(tables, {
      ownerType: 'personal',
      ownerId: uid,
      month: todayKey.slice(0, 7),
      theme: 'flowerbed',
      nowMs: now
    });

    // 在 essays 第 1 列最右側新增 uid 欄並顯式設為純文字 @ 格式
    var newCol1 = essayIndex.nextCol1;
    essayIndex.nextCol1 += 1;
    essayIndex.uidToCol[uid] = newCol1;
    formatEssaysColumnText(newCol1);
    valuesBatchWrite([{ range: 'essays!' + colToLetter(newCol1) + '1', values: [[uid]] }]);

    writeRowUpdates('users', [{ rowIdx: user.rowIdx, values: userToRowArray(user) }], 'U');
    writeRowUpdates('gardens', [{ rowIdx: initGarden.rowIdx, values: gardenToRowArray(initGarden) }], 'L');
  }

  var state = computeBootstrapState(tables, essayIndex, user, 2, now);
  if (state.needsWriteback) {
    applyBootstrapWritebacksLocked(tables, state, now);
  }
  return {
    sessionToken: sessionToken,
    isNewUser: isNewUser,
    bootstrap: finalizeBootstrapResponse(tables, user, state)
  };
}

function handleLogout(payload, ctx) {
  var u = ctx.user;
  u.sessionHashes = (u.sessionHashes || []).filter(function (h) {
    return !timingSafeEqualStr(h, ctx.tokenHash);
  });
  u.updatedAt = ENV.nowMs();
  writeRowUpdates('users', [{ rowIdx: u.rowIdx, values: userToRowArray(u) }], 'U');
  return { loggedOut: true };
}

function handleBootstrap(payload, ctx) {
  var limit = payload && payload.essayMonthsLimit;
  var now = ENV.nowMs();
  var essayIndex = loadEssaysIndex();
  var state = computeBootstrapState(ctx.tables, essayIndex, ctx.user, limit, now);

  if (!state.needsWriteback) {
    return finalizeBootstrapResponse(ctx.tables, ctx.user, state);
  }

  // 若偵測到需自動寫回（開票／跨月建島／植物定案），進鎖重讀以防競態（TC-R07）
  return withScriptLock(function () {
    var freshTables = loadCoreTables();
    var freshAuth = authenticateSession(freshTables, ctx.authToken);
    var freshIndex = loadEssaysIndex();
    var freshNow = ENV.nowMs();
    var freshState = computeBootstrapState(freshTables, freshIndex, freshAuth.user, limit, freshNow);
    if (freshState.needsWriteback) {
      applyBootstrapWritebacksLocked(freshTables, freshState, freshNow);
    }
    return finalizeBootstrapResponse(freshTables, freshAuth.user, freshState);
  });
}

function handleGetEssaysByMonth(payload, ctx) {
  var month = String((payload && payload.month) || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw appError('VALIDATION_ERROR', '月份格式須為 YYYY-MM');

  var user = ctx.user;
  var group = user.activeGroupId ? ctx.tables.groupById[user.activeGroupId] : null;
  var essayIndex = loadEssaysIndex();
  var targetUids = [user.uid];
  if (group) {
    for (var i = 0; i < group.memberUids.length; i++) {
      if (group.memberUids[i] !== user.uid) targetUids.push(group.memberUids[i]);
    }
  }
  var matrix = fetchEssaysMatrixSlice(essayIndex, targetUids, function (dk) {
    return dk.slice(0, 7) === month;
  });
  var allowed = {};
  allowed[month] = true;
  var essays = collectVisibleEssays(matrix, user, group, allowed, ctx.tables.userByUid);
  var dir = {};
  dir[user.uid] = user.displayName;
  for (var e = 0; e < essays.length; e++) {
    var eu = ctx.tables.userByUid[essays[e].authorUid];
    if (eu) dir[eu.uid] = eu.displayName;
  }
  return { month: month, essays: essays, memberDirectory: dir };
}

function handleUpdateDisplayName(payload, ctx) {
  var name = String((payload && payload.displayName) || '').trim();
  if (!name || name.length > 30) {
    throw appError('VALIDATION_ERROR', '暱稱長度須為 1～30 字元');
  }
  var now = ENV.nowMs();
  ctx.user.displayName = name;
  ctx.user.updatedAt = now;
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');
  return { displayName: name, updatedAt: now };
}

function handleSubmitEssay(payload, ctx) {
  var content = payload && typeof payload.content === 'string' ? payload.content : '';
  var wordCount = countEssayWords(content);
  if (wordCount < GAME_CONFIG.minWords) {
    throw appError('VALIDATION_ERROR', '字數需至少 ' + GAME_CONFIG.minWords + ' 字（目前 ' + wordCount + ' 字）');
  }

  var cardStyle = payload && payload.cardStyle ? String(payload.cardStyle).trim() : null;
  if (cardStyle && !VALID_CARD_STYLES[cardStyle]) {
    throw appError('VALIDATION_ERROR', '無效的便條紙款式');
  }

  var user = ctx.user;
  var target = getActiveTargetGarden(ctx.tables, user);
  if (!target.garden) {
    throw appError('READ_ONLY_GARDEN', '尚未建立本月活動花園，請先選擇本月主題');
  }

  var now = ENV.nowMs();
  var dayKey = target.todayKey;
  var essayIndex = loadEssaysIndex();

  // 讀取今日所需統計：本人當日列 + 若在團體則同團全部成員當日列
  var queryUids = target.group
    ? Array.from(new Set([user.uid].concat(target.group.memberUids, target.group.formerMemberUids)))
    : [user.uid];
  var todayMatrix = fetchEssaysMatrixSlice(essayIndex, queryUids, function (dk) { return dk === dayKey; });
  var myTodayList = (todayMatrix[user.uid] && todayMatrix[user.uid][dayKey]) || [];

  // 個人與團體種子額度依各自花園獨立計算（TC-A11）
  var seedsGivenToday = 0;
  if (target.group) {
    for (var i = 0; i < queryUids.length; i++) {
      var list = (todayMatrix[queryUids[i]] && todayMatrix[queryUids[i]][dayKey]) || [];
      for (var k = 0; k < list.length; k++) {
        if (list[k].groupId === target.group.groupId && list[k].reward && list[k].reward.type === 'seed') {
          seedsGivenToday += 1;
        }
      }
    }
  } else {
    for (var j = 0; j < myTodayList.length; j++) {
      if (!myTodayList[j].groupId && myTodayList[j].reward && myTodayList[j].reward.type === 'seed') {
        seedsGivenToday += 1;
      }
    }
  }

  var result = {
    wordCount: wordCount,
    rewardType: null,
    seedSpeciesId: null,
    seedRarity: null,
    isPity: false,
    decomposedEnergy: 0,
    overflowEnergy: 0,
    dailyBaseEnergy: 0,
    streakCount: user.streakCount,
    streakMultiplier: 1,
    milestoneUnlocked: null
  };

  if (seedsGivenToday < GAME_CONFIG.dailySeedCap) {
    var roll = rollSeed(wordCount, user.pity, target.garden.theme, CATALOG.species, GAME_CONFIG);
    user.pity = roll.nextPity;
    if (!user.dex.includes(roll.speciesId)) user.dex.push(roll.speciesId);

    var bagTotal = Object.values(user.seeds).reduce(function (a, b) { return a + b; }, 0);
    if (bagTotal < GAME_CONFIG.seedBagCap) {
      user.seeds[roll.speciesId] = (user.seeds[roll.speciesId] || 0) + 1;
      result.rewardType = 'seed';
    } else {
      var decomp = GAME_CONFIG.decomposeEnergy[roll.rarity] || 2;
      user.energy += decomp;
      result.rewardType = 'seed_decomposed';
      result.decomposedEnergy = decomp;
    }
    result.seedSpeciesId = roll.speciesId;
    result.seedRarity = roll.rarity;
    result.isPity = roll.isPity;
  } else {
    var overflow = Math.floor(wordCount / GAME_CONFIG.overflowWordsPerEnergy);
    user.energy += overflow;
    result.rewardType = 'energy';
    result.overflowEnergy = overflow;
  }

  if (myTodayList.length === 0) {
    var nextStreak = advanceStreakOnWrite({
      count: user.streakCount,
      lastDay: user.streakLastDay || null,
      prevCount: user.streakPrevCount,
      prevLastDay: user.streakPrevLastDay || null
    }, dayKey);
    user.streakCount = nextStreak.count;
    user.streakLastDay = nextStreak.lastDay || '';
    user.streakPrevCount = nextStreak.prevCount || 0;
    user.streakPrevLastDay = nextStreak.prevLastDay || '';

    var mult = getStreakMultiplier(user.streakCount, GAME_CONFIG);
    var baseE = Math.round(GAME_CONFIG.dailyBaseEnergy * mult);
    user.energy += baseE;
    result.dailyBaseEnergy = baseE;
    result.streakCount = user.streakCount;
    result.streakMultiplier = mult;

    for (var m = 0; m < GAME_CONFIG.milestones.length; m++) {
      var ms = GAME_CONFIG.milestones[m];
      if (user.streakCount >= ms && !user.milestones.includes(ms)) {
        user.milestones.push(ms);
        var limSp = CATALOG.species.find(function (s) { return s.theme === 'limited' && s.milestone === ms; });
        if (limSp) {
          user.limitedSeeds[limSp.id] = (user.limitedSeeds[limSp.id] || 0) + 1;
          if (!user.dex.includes(limSp.id)) user.dex.push(limSp.id);
          result.milestoneUnlocked = limSp;
        }
      }
    }
  } else {
    result.streakCount = user.streakCount;
    result.streakMultiplier = getStreakMultiplier(user.streakCount, GAME_CONFIG);
  }

  if (cardStyle) user.lastCardStyle = cardStyle;
  user.updatedAt = now;

  var isPrivate = (payload && payload.isPrivate !== undefined && payload.isPrivate !== null)
    ? Boolean(payload.isPrivate)
    : !target.group;

  var rawEssay = {
    id: 'e_' + dayKey.replace(/-/g, '') + '_' + now + '_' + randId4(),
    gardenId: target.garden.gardenId,
    groupId: target.group ? target.group.groupId : '',
    content: content,
    wordCount: wordCount,
    private: isPrivate,
    cardStyle: cardStyle,
    reward: result.rewardType === 'energy'
      ? { type: 'energy', energy: result.overflowEnergy }
      : { type: 'seed', speciesId: result.seedSpeciesId },
    reactions: {},
    createdAt: now,
    updatedAt: now
  };

  var updatedDayList = myTodayList.concat([rawEssay]);
  // 先寫隨筆儲存格（內含 49,000 字元上限檢查，超限時不寫使用者列）
  writeEssayCell(essayIndex, dayKey, user.uid, updatedDayList);
  writeRowUpdates('users', [{ rowIdx: user.rowIdx, values: userToRowArray(user) }], 'U');

  var days = computeUserAndGroupDays(user, target.group, Object.assign({}, todayMatrix, {
    [user.uid]: Object.assign({}, todayMatrix[user.uid] || {}, { [dayKey]: updatedDayList })
  }));

  return {
    essay: buildEssayDto(rawEssay, user.uid, dayKey, ctx.tables.userByUid),
    result: result,
    user: toUserDto(user),
    userDaysDay: days.userDays[dayKey],
    groupDaysDay: target.group ? days.groupDays[dayKey] : null
  };
}

function handleUpdateEssay(payload, ctx) {
  var essayId = String((payload && payload.essayId) || '').trim();
  var dayKey = String((payload && payload.dayKey) || '').trim();
  var authorUid = String((payload && payload.authorUid) || '').trim();
  var content = payload && typeof payload.content === 'string' ? payload.content : '';

  if (!essayId || !DAY_KEY_RE.test(dayKey) || !authorUid) {
    throw appError('VALIDATION_ERROR', '缺少隨筆定位資訊（essayId / dayKey / authorUid）');
  }
  if (authorUid !== ctx.user.uid) {
    throw appError('FORBIDDEN', '只有作者本人可以編輯自己的隨筆');
  }
  var wordCount = countEssayWords(content);
  if (wordCount === 0) {
    throw appError('VALIDATION_ERROR', '隨筆內容不可為空');
  }

  var cardStyle = payload.cardStyle;
  if (cardStyle !== undefined && cardStyle !== null && cardStyle !== '') {
    cardStyle = String(cardStyle).trim();
    if (!VALID_CARD_STYLES[cardStyle]) throw appError('VALIDATION_ERROR', '無效的便條紙款式');
  }

  var essayIndex = loadEssaysIndex();
  var cell = readSingleEssayCell(essayIndex, dayKey, authorUid);
  var targetIdx = cell.list.findIndex(function (e) { return e.id === essayId; });
  if (targetIdx === -1) throw appError('NOT_FOUND', '找不到可編輯的隨筆');

  var now = ENV.nowMs();
  var target = cell.list[targetIdx];
  target.content = content;
  target.wordCount = wordCount;
  if (payload.isPrivate !== undefined) target.private = Boolean(payload.isPrivate);
  if (cardStyle !== undefined) {
    target.cardStyle = cardStyle || null;
    if (cardStyle) {
      ctx.user.lastCardStyle = cardStyle;
      ctx.user.updatedAt = now;
    }
  }
  target.updatedAt = now;

  writeEssayCell(essayIndex, dayKey, authorUid, cell.list);
  if (cardStyle) {
    writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');
  }

  var words = 0;
  var lastAt = 0;
  var seedsGiven = 0;
  for (var i = 0; i < cell.list.length; i++) {
    words += Number(cell.list[i].wordCount || 0);
    if (Number(cell.list[i].createdAt || 0) > lastAt) lastAt = Number(cell.list[i].createdAt || 0);
    if (!cell.list[i].groupId && cell.list[i].reward && cell.list[i].reward.type === 'seed') {
      seedsGiven += 1;
    }
  }
  return {
    essay: buildEssayDto(target, authorUid, dayKey, ctx.tables.userByUid),
    userDaysDay: {
      essays: cell.list.length,
      words: words,
      lastEssayAt: lastAt,
      madeUp: ctx.user.makeupDays.includes(dayKey),
      seedsGiven: seedsGiven
    }
  };
}

function handleSetReaction(payload, ctx) {
  var essayId = String((payload && payload.essayId) || '').trim();
  var dayKey = String((payload && payload.dayKey) || '').trim();
  var authorUid = String((payload && payload.authorUid) || '').trim();
  var reactionId = payload && payload.reactionId ? String(payload.reactionId).trim() : null;

  if (!essayId || !DAY_KEY_RE.test(dayKey) || !authorUid) {
    throw appError('VALIDATION_ERROR', '缺少隨筆定位資訊（essayId / dayKey / authorUid）');
  }
  if (reactionId && !VALID_REACTIONS[reactionId]) {
    throw appError('VALIDATION_ERROR', '無效的表情反應類型');
  }

  var essayIndex = loadEssaysIndex();
  var cell = readSingleEssayCell(essayIndex, dayKey, authorUid);
  var target = cell.list.find(function (e) { return e.id === essayId; });
  if (!target) throw appError('NOT_FOUND', '找不到該篇隨筆');

  var isMine = authorUid === ctx.user.uid;
  var inSameGroup = Boolean(target.groupId && ctx.user.activeGroupId && target.groupId === ctx.user.activeGroupId);
  if (!isMine && (!inSameGroup || target.private)) {
    throw appError('FORBIDDEN', '無權限對此隨筆進行反應');
  }
  if (target.groupId && target.private) {
    throw appError('FORBIDDEN', '團體私密隨筆不開放表情反應');
  }

  if (!target.reactions || typeof target.reactions !== 'object') target.reactions = {};
  if (!reactionId) delete target.reactions[ctx.user.uid];
  else target.reactions[ctx.user.uid] = reactionId;

  writeEssayCell(essayIndex, dayKey, authorUid, cell.list);
  return { essayId: essayId, reactions: target.reactions };
}

function handleMakeUpYesterday(payload, ctx) {
  var user = ctx.user;
  var group = user.activeGroupId ? ctx.tables.groupById[user.activeGroupId] : null;
  var tz = group ? group.timezone : user.timezone;
  var now = ENV.nowMs();
  var todayKey = getGameDayKey(now, tz, GAME_CONFIG.dayBoundaryHour);
  var yesterdayKey = addDays(todayKey, -1);

  if (user.makeupDays.includes(yesterdayKey)) {
    throw appError('VALIDATION_ERROR', '昨天已補簽過');
  }

  var essayIndex = loadEssaysIndex();
  var cell = readSingleEssayCell(essayIndex, yesterdayKey, user.uid);
  if (cell.list.length > 0) {
    throw appError('VALIDATION_ERROR', '昨天已有隨筆紀錄，無須補簽');
  }
  if (user.energy < GAME_CONFIG.makeUpCost) {
    throw appError('INSUFFICIENT_ENERGY', '能量不足（需 ' + GAME_CONFIG.makeUpCost + ' 能量）');
  }

  user.energy -= GAME_CONFIG.makeUpCost;
  user.makeupDays.push(yesterdayKey);
  var repaired = repairStreakOnMakeUp({
    count: user.streakCount,
    lastDay: user.streakLastDay || null,
    prevCount: user.streakPrevCount,
    prevLastDay: user.streakPrevLastDay || null
  }, todayKey);
  user.streakCount = repaired.count;
  user.streakLastDay = repaired.lastDay || '';
  user.streakPrevCount = repaired.prevCount || 0;
  user.streakPrevLastDay = repaired.prevLastDay || '';
  user.updatedAt = now;

  writeRowUpdates('users', [{ rowIdx: user.rowIdx, values: userToRowArray(user) }], 'U');

  if (group && !group.makeupDays.includes(yesterdayKey)) {
    group.makeupDays.push(yesterdayKey);
    group.updatedAt = now;
    writeRowUpdates('groups', [{ rowIdx: group.rowIdx, values: groupToRowArray(group) }], 'M');
  }

  return { user: toUserDto(user), streak: toUserDto(user).streak, yesterdayKey: yesterdayKey };
}

function handlePlantSeed(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var speciesId = String((payload && payload.speciesId) || '').trim();
  var isLimited = Boolean(payload && payload.isLimited);
  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);

  if (garden.status !== 'active') throw appError('READ_ONLY_GARDEN', '封存或快照區域無法種植新植物');
  var coords = assertValidCoords(garden, payload && payload.x, payload && payload.y);
  if (isCellOccupied(garden, coords.nx, coords.ny)) {
    throw appError('CELL_OCCUPIED', '此位置已經有植物或裝飾，不能重疊擺放');
  }

  var sp = SPECIES_MAP[speciesId];
  if (!sp) throw appError('SEED_NOT_FOUND', '找不到該植物品種');
  var bag = isLimited ? ctx.user.limitedSeeds : ctx.user.seeds;
  if (!bag[speciesId] || bag[speciesId] <= 0) {
    throw appError('SEED_NOT_FOUND', '沒有該品種的種子');
  }

  bag[speciesId] -= 1;
  if (bag[speciesId] <= 0) delete bag[speciesId];

  var group = garden.ownerType === 'group' ? ctx.tables.groupById[garden.ownerId] : null;
  var memberCount = group ? group.memberUids.length : 1;
  var reqDays = isLimited ? 1 : calcRequiredDays(sp.requiredDays, memberCount, GAME_CONFIG);
  var now = ENV.nowMs();
  var tz = group ? group.timezone : ctx.user.timezone;
  var pid = makeId('plant_', now);

  var plant = {
    id: pid,
    speciesId: speciesId,
    x: coords.nx,
    y: coords.ny,
    plantedBy: ctx.user.uid,
    plantedDay: getGameDayKey(now, tz, GAME_CONFIG.dayBoundaryHour),
    plantedAt: now,
    requiredDays: reqDays,
    limited: isLimited,
    finalStage: isLimited ? 'grown' : null,
    hadWilt: false,
    finalLevel: isLimited ? 5 : null,
    frozen: null
  };

  garden.items.plants[pid] = plant;
  garden.updatedAt = now;
  ctx.user.updatedAt = now;

  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return { plant: plant, user: toUserDto(ctx.user) };
}

function handleClearDeadPlant(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var plantId = String((payload && payload.plantId) || '').trim();
  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);

  if (garden.status === 'snapshot') throw appError('READ_ONLY_GARDEN', '唯讀快照無法修改');
  var plant = garden.items.plants[plantId];
  if (!plant) throw appError('NOT_FOUND', '找不到該株植物');

  var group = garden.ownerType === 'group' ? ctx.tables.groupById[garden.ownerId] : null;
  var tz = group ? group.timezone : ctx.user.timezone;
  var now = ENV.nowMs();
  var todayKey = getGameDayKey(now, tz, GAME_CONFIG.dayBoundaryHour);

  var evalState;
  if (plant.finalStage) {
    evalState = evaluatePlantState(plant, {}, todayKey, garden.ownerType);
  } else {
    var essayIndex = loadEssaysIndex();
    var targetUids = group ? Array.from(new Set(group.memberUids.concat(group.formerMemberUids))) : [ctx.user.uid];
    var matrix = fetchEssaysMatrixSlice(essayIndex, targetUids, function (dk) { return dk >= plant.plantedDay; });
    var days = computeUserAndGroupDays(ctx.user, group, matrix);
    evalState = evaluatePlantState(plant, garden.ownerType === 'group' ? days.groupDays : days.userDays, todayKey, garden.ownerType);
  }

  if (evalState.stage !== 'dead') throw appError('VALIDATION_ERROR', '只有已死亡的枯枝可以清除');
  if (ctx.user.energy < GAME_CONFIG.clearWitheredCost) {
    throw appError('INSUFFICIENT_ENERGY', '能量不足（需要 ' + GAME_CONFIG.clearWitheredCost + ' 能量）');
  }

  ctx.user.energy -= GAME_CONFIG.clearWitheredCost;
  ctx.user.updatedAt = now;
  delete garden.items.plants[plantId];
  garden.updatedAt = now;

  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return { plantId: plantId, energy: ctx.user.energy };
}

function handleBuyAndPlaceDecor(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var itemId = String((payload && payload.itemId) || '').trim();
  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);

  if (garden.status === 'snapshot') throw appError('READ_ONLY_GARDEN', '唯讀快照無法佈置');
  var coords = assertValidCoords(garden, payload && payload.x, payload && payload.y);
  var item = DECOR_MAP[itemId];
  if (!item) throw appError('NOT_FOUND', '找不到該裝飾商品');
  if (ctx.user.energy < item.cost) {
    throw appError('INSUFFICIENT_ENERGY', '能量不足（需要 ' + item.cost + ' 能量）');
  }
  if (isCellOccupied(garden, coords.nx, coords.ny)) {
    throw appError('CELL_OCCUPIED', '此位置已經有植物或裝飾，不能重疊擺放');
  }

  var now = ENV.nowMs();
  var did = makeId('decor_', now);
  var decor = { id: did, itemId: itemId, x: coords.nx, y: coords.ny, placedBy: ctx.user.uid, placedAt: now };

  ctx.user.energy -= item.cost;
  ctx.user.updatedAt = now;
  garden.items.decor[did] = decor;
  garden.updatedAt = now;

  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return { decor: decor, energy: ctx.user.energy };
}

function handleRemoveDecor(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var decorId = String((payload && payload.decorId) || '').trim();
  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);

  if (garden.status === 'snapshot') throw appError('READ_ONLY_GARDEN', '唯讀快照無法修改');
  var dec = garden.items.decor[decorId];
  if (!dec) throw appError('NOT_FOUND', '找不到該裝飾');
  if (dec.placedBy !== ctx.user.uid) throw appError('FORBIDDEN', '只能拆除自己擺放的裝飾');

  delete garden.items.decor[decorId];
  garden.updatedAt = ENV.nowMs();
  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');

  return { decorId: decorId };
}

function handleMoveGridItem(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var kind = String((payload && payload.kind) || '').trim();
  var itemId = String((payload && payload.itemId) || '').trim();
  if (kind !== 'plant' && kind !== 'decor') throw appError('VALIDATION_ERROR', '無效的物件類型');

  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);
  if (garden.status === 'snapshot') throw appError('READ_ONLY_GARDEN', '唯讀快照無法移動');

  var bucket = kind === 'plant' ? garden.items.plants : garden.items.decor;
  var obj = bucket[itemId];
  if (!obj) throw appError('NOT_FOUND', '找不到要移動的物件');
  var ownerField = kind === 'plant' ? 'plantedBy' : 'placedBy';
  if (obj[ownerField] !== ctx.user.uid) {
    throw appError('FORBIDDEN', kind === 'plant' ? '只能移動自己種植的植物' : '只能移動自己擺放的裝飾');
  }

  var coords = assertValidCoords(garden, payload && payload.newX, payload && payload.newY);
  if (isCellOccupied(garden, coords.nx, coords.ny, itemId)) {
    throw appError('CELL_OCCUPIED', '目標位置已經有植物或裝飾，不能重疊擺放');
  }

  obj.x = coords.nx;
  obj.y = coords.ny;
  garden.updatedAt = ENV.nowMs();
  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');

  return { kind: kind, itemId: itemId, x: coords.nx, y: coords.ny };
}

function handleDecomposeSeed(payload, ctx) {
  var speciesId = String((payload && payload.speciesId) || '').trim();
  var rawCount = payload && payload.count !== undefined ? payload.count : 1;
  var count = parseStrictInt(rawCount);
  if (count === null || count < 1) throw appError('VALIDATION_ERROR', '分解數量必須為正整數');

  var sp = SPECIES_MAP[speciesId];
  if (!sp) throw appError('SEED_NOT_FOUND', '找不到該植物品種');
  var owned = ctx.user.seeds[speciesId] || 0;
  if (owned < count) throw appError('SEED_NOT_FOUND', '種子數量不足');

  var gain = (GAME_CONFIG.decomposeEnergy[sp.rarity] || 2) * count;
  ctx.user.seeds[speciesId] = owned - count;
  if (ctx.user.seeds[speciesId] <= 0) delete ctx.user.seeds[speciesId];
  ctx.user.energy += gain;
  ctx.user.updatedAt = ENV.nowMs();

  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');
  return { energy: ctx.user.energy, seeds: ctx.user.seeds };
}

function handleExpandGarden(payload, ctx) {
  var gardenId = String((payload && payload.gardenId) || '').trim();
  var garden = assertGardenAccess(ctx.tables, ctx.user, gardenId);

  if (garden.status !== 'active') throw appError('READ_ONLY_GARDEN', '只有當月活動區域可以擴地');
  if (garden.size >= 9 || garden.expansions >= GAME_CONFIG.expansionCosts.length) {
    throw appError('VALIDATION_ERROR', '已達最大土地尺寸（9×9）');
  }
  var cost = GAME_CONFIG.expansionCosts[garden.expansions];
  if (ctx.user.energy < cost) {
    throw appError('INSUFFICIENT_ENERGY', '能量不足（需要 ' + cost + ' 能量）');
  }

  var now = ENV.nowMs();
  ctx.user.energy -= cost;
  ctx.user.updatedAt = now;
  garden.expansions += 1;
  garden.size += 1;
  garden.updatedAt = now;

  writeRowUpdates('gardens', [{ rowIdx: garden.rowIdx, values: gardenToRowArray(garden) }], 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return { garden: toGardenDto(garden), energy: ctx.user.energy };
}

function handleCreateGroup(payload, ctx) {
  if (ctx.user.activeGroupId) {
    throw appError('VALIDATION_ERROR', '你已經在團體花園中，請先退出再建團');
  }
  var theme = String((payload && payload.theme) || 'forest').trim();
  if (!VALID_THEMES[theme]) throw appError('VALIDATION_ERROR', '無效的花園主題');
  var name = String((payload && payload.name) || '').trim() || '晨光共筆花園';
  if (name.length > 30) throw appError('VALIDATION_ERROR', '團體名稱不可超過 30 字元');

  var now = ENV.nowMs();
  var tz = ctx.user.timezone || 'Asia/Taipei';
  var todayKey = getGameDayKey(now, tz, GAME_CONFIG.dayBoundaryHour);
  var gardenUpdates = archiveActivePersonalGardens(ctx.tables, ctx.user.uid, now);

  var isTest = isTestUid(ctx.user.uid);
  var grpId = makeId(isTest ? 'grp_test_' : 'grp_', now);
  var code = generateUniqueInviteCode(ctx.tables);
  var newGroup = {
    rowIdx: ctx.tables.nextGroupRow,
    groupId: grpId,
    name: name,
    ownerUid: ctx.user.uid,
    status: 'active',
    inviteCode: code,
    memberUids: [ctx.user.uid],
    formerMemberUids: [],
    timezone: tz,
    themeVoteMonth: '',
    themeVotes: {},
    makeupDays: [],
    createdAt: now,
    updatedAt: now
  };
  ctx.tables.nextGroupRow += 1;

  var newGarden = buildGardenRecord(ctx.tables, {
    ownerType: 'group',
    ownerId: grpId,
    prefixUid: ctx.user.uid,
    month: todayKey.slice(0, 7),
    theme: theme,
    nowMs: now
  });
  gardenUpdates.push({ rowIdx: newGarden.rowIdx, values: gardenToRowArray(newGarden) });

  ctx.user.activeGroupId = grpId;
  ctx.user.updatedAt = now;

  writeRowUpdates('groups', [{ rowIdx: newGroup.rowIdx, values: groupToRowArray(newGroup) }], 'M');
  writeRowUpdates('gardens', gardenUpdates, 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return {
    group: toGroupDto(newGroup),
    garden: toGardenDto(newGarden),
    archivedPersonalGardenId: gardenUpdates.length > 1 ? gardenUpdates[0].values[0] : null
  };
}

function handleJoinGroup(payload, ctx) {
  if (ctx.user.activeGroupId) {
    throw appError('VALIDATION_ERROR', '你已經在團體花園中，請先退出後再加入其他團體');
  }
  var code = String((payload && payload.inviteCode) || '').trim().toUpperCase();
  if (!code) throw appError('INVITE_NOT_FOUND', '請輸入邀請碼');

  var group = ctx.tables.groups.find(function (g) {
    return g.status === 'active' && g.inviteCode === code;
  });
  if (!group) throw appError('INVITE_NOT_FOUND', '找不到此邀請碼或團體已解散');

  var alreadyIn = group.memberUids.includes(ctx.user.uid);
  if (!alreadyIn && group.memberUids.length >= GAME_CONFIG.maxGroupMembers) {
    throw appError('GROUP_FULL', '該團體人數已滿（上限 ' + GAME_CONFIG.maxGroupMembers + ' 人）');
  }

  var now = ENV.nowMs();
  var gardenUpdates = archiveActivePersonalGardens(ctx.tables, ctx.user.uid, now);

  if (!alreadyIn) group.memberUids.push(ctx.user.uid);
  group.formerMemberUids = group.formerMemberUids.filter(function (id) { return id !== ctx.user.uid; });
  group.updatedAt = now;
  ctx.user.activeGroupId = group.groupId;
  ctx.user.updatedAt = now;

  writeRowUpdates('groups', [{ rowIdx: group.rowIdx, values: groupToRowArray(group) }], 'M');
  if (gardenUpdates.length) writeRowUpdates('gardens', gardenUpdates, 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  var essayIndex = loadEssaysIndex();
  var state = computeBootstrapState(ctx.tables, essayIndex, ctx.user, 2, now);
  if (state.needsWriteback) applyBootstrapWritebacksLocked(ctx.tables, state, now);
  var res = finalizeBootstrapResponse(ctx.tables, ctx.user, state);

  return {
    group: res.group,
    gardens: res.gardens,
    groupDays: res.groupDays,
    memberDirectory: res.memberDirectory,
    groupMemberSummaries: res.groupMemberSummaries
  };
}

function handleLeaveGroup(payload, ctx) {
  if (!ctx.user.activeGroupId) throw appError('VALIDATION_ERROR', '目前不在團體花園中');
  var newTheme = String((payload && payload.newPersonalTheme) || 'flowerbed').trim();
  if (!VALID_THEMES[newTheme]) throw appError('VALIDATION_ERROR', '無效的花園主題');

  var group = ctx.tables.groupById[ctx.user.activeGroupId];
  if (!group) throw appError('NOT_FOUND', '找不到目前所屬團體');

  var now = ENV.nowMs();
  var activeGroupGarden = ctx.tables.gardens.find(function (g) {
    return g.ownerType === 'group' && g.ownerId === group.groupId && g.status === 'active';
  });

  var isTest = isTestUid(ctx.user.uid);
  var gardenUpdates = [];
  var snapshotGarden = null;

  if (activeGroupGarden) {
    var essayIndex = loadEssaysIndex();
    var allUids = Array.from(new Set(group.memberUids.concat(group.formerMemberUids)));
    var gToday = getGameDayKey(now, group.timezone, GAME_CONFIG.dayBoundaryHour);
    var minDay = findMinEvalDayKey([activeGroupGarden], gToday);
    var matrix = fetchEssaysMatrixSlice(essayIndex, allUids, function (dk) { return dk >= minDay; });
    var days = computeUserAndGroupDays(ctx.user, group, matrix);

    var frozenPlants = {};
    var plantsList = Object.values(activeGroupGarden.items.plants || {});
    for (var i = 0; i < plantsList.length; i++) {
      var p = plantsList[i];
      var ev = evaluatePlantState(p, days.groupDays, gToday, 'group');
      frozenPlants[p.id] = Object.assign({}, p, {
        frozen: {
          stage: ev.stage,
          progress: ev.progress,
          level: ev.level,
          hadWilt: Boolean(ev.hadWilt),
          isPerfect: Boolean(ev.isPerfect)
        }
      });
    }

    snapshotGarden = buildGardenRecord(ctx.tables, {
      prefix: isTest ? 'snap_test_' : 'snap_',
      ownerType: 'personal',
      ownerId: ctx.user.uid,
      month: activeGroupGarden.month,
      theme: activeGroupGarden.theme,
      status: 'snapshot',
      snapshotName: group.name + '（快照）',
      size: activeGroupGarden.size,
      expansions: activeGroupGarden.expansions,
      items: {
        plants: frozenPlants,
        decor: JSON.parse(JSON.stringify(activeGroupGarden.items.decor || {}))
      },
      nowMs: now
    });
    gardenUpdates.push({ rowIdx: snapshotGarden.rowIdx, values: gardenToRowArray(snapshotGarden) });
  }

  group.memberUids = group.memberUids.filter(function (id) { return id !== ctx.user.uid; });
  if (!group.formerMemberUids.includes(ctx.user.uid)) {
    group.formerMemberUids.push(ctx.user.uid);
  }
  if (group.memberUids.length === 0) {
    group.status = 'archived';
    group.inviteCode = '';
  }
  group.updatedAt = now;

  var pToday = getGameDayKey(now, ctx.user.timezone, GAME_CONFIG.dayBoundaryHour);
  var newPersonalGarden = buildGardenRecord(ctx.tables, {
    ownerType: 'personal',
    ownerId: ctx.user.uid,
    month: pToday.slice(0, 7),
    theme: newTheme,
    nowMs: now
  });
  gardenUpdates.push({ rowIdx: newPersonalGarden.rowIdx, values: gardenToRowArray(newPersonalGarden) });

  ctx.user.activeGroupId = '';
  ctx.user.updatedAt = now;

  writeRowUpdates('groups', [{ rowIdx: group.rowIdx, values: groupToRowArray(group) }], 'M');
  writeRowUpdates('gardens', gardenUpdates, 'L');
  writeRowUpdates('users', [{ rowIdx: ctx.user.rowIdx, values: userToRowArray(ctx.user) }], 'U');

  return {
    snapshotGarden: snapshotGarden ? toGardenDto(snapshotGarden) : null,
    newPersonalGarden: toGardenDto(newPersonalGarden),
    user: toUserDto(ctx.user)
  };
}

function handleCastThemeVote(payload, ctx) {
  var groupId = String((payload && payload.groupId) || '').trim();
  var theme = String((payload && payload.theme) || '').trim();
  if (!VALID_THEMES[theme]) throw appError('VALIDATION_ERROR', '無效的花園主題');
  var group = ctx.tables.groupById[groupId];
  if (!group) throw appError('NOT_FOUND', '找不到指定團體');
  if (!ctx.user.activeGroupId || group.groupId !== ctx.user.activeGroupId || !group.memberUids.includes(ctx.user.uid)) {
    throw appError('FORBIDDEN', '非該團體現任成員無法投票');
  }

  var now = ENV.nowMs();
  var gToday = getGameDayKey(now, group.timezone, GAME_CONFIG.dayBoundaryHour);
  if (!isLastDayOfMonth(gToday)) {
    throw appError('VALIDATION_ERROR', '僅於每月最後一天開放下個月主題投票');
  }

  var nextMonth = addDays(gToday, 1).slice(0, 7);
  if (group.themeVoteMonth !== nextMonth) {
    group.themeVoteMonth = nextMonth;
    group.themeVotes = {};
  }
  group.themeVotes[ctx.user.uid] = theme;
  group.updatedAt = now;

  writeRowUpdates('groups', [{ rowIdx: group.rowIdx, values: groupToRowArray(group) }], 'M');
  return { themeVoteMonth: group.themeVoteMonth, themeVotes: group.themeVotes };
}

function handleStartNewMonthGarden(payload, ctx) {
  if (ctx.user.activeGroupId) {
    throw appError('VALIDATION_ERROR', '團體花園換月會依投票自動定案，不可手動建立個人區域');
  }
  var theme = String((payload && payload.theme) || '').trim();
  if (!VALID_THEMES[theme]) throw appError('VALIDATION_ERROR', '無效的花園主題');

  var now = ENV.nowMs();
  var todayKey = getGameDayKey(now, ctx.user.timezone, GAME_CONFIG.dayBoundaryHour);
  var currentMonth = todayKey.slice(0, 7);
  var gardenUpdates = archiveActivePersonalGardens(ctx.tables, ctx.user.uid, now, currentMonth);

  var newGarden = buildGardenRecord(ctx.tables, {
    ownerType: 'personal',
    ownerId: ctx.user.uid,
    month: currentMonth,
    theme: theme,
    nowMs: now
  });
  gardenUpdates.push({ rowIdx: newGarden.rowIdx, values: gardenToRowArray(newGarden) });

  writeRowUpdates('gardens', gardenUpdates, 'L');
  return { garden: toGardenDto(newGarden) };
}

// ----------------------------------------------------------------------------
// 10. 統一路由入口（doGet / doPost）與每日自動備份
// ----------------------------------------------------------------------------
const ACTION_HANDLERS = {
  ping: { lock: false, auth: false, fn: handlePing },
  auth: { lock: true, auth: false, fn: handleAuth },
  logout: { lock: true, auth: true, fn: handleLogout },
  bootstrap: { lock: false, auth: true, fn: handleBootstrap },
  getEssaysByMonth: { lock: false, auth: true, fn: handleGetEssaysByMonth },
  updateDisplayName: { lock: true, auth: true, fn: handleUpdateDisplayName },
  submitEssay: { lock: true, auth: true, fn: handleSubmitEssay },
  updateEssay: { lock: true, auth: true, fn: handleUpdateEssay },
  setReaction: { lock: true, auth: true, fn: handleSetReaction },
  makeUpYesterday: { lock: true, auth: true, fn: handleMakeUpYesterday },
  plantSeed: { lock: true, auth: true, fn: handlePlantSeed },
  clearDeadPlant: { lock: true, auth: true, fn: handleClearDeadPlant },
  buyAndPlaceDecor: { lock: true, auth: true, fn: handleBuyAndPlaceDecor },
  removeDecor: { lock: true, auth: true, fn: handleRemoveDecor },
  moveGridItem: { lock: true, auth: true, fn: handleMoveGridItem },
  decomposeSeed: { lock: true, auth: true, fn: handleDecomposeSeed },
  expandGarden: { lock: true, auth: true, fn: handleExpandGarden },
  createGroup: { lock: true, auth: true, fn: handleCreateGroup },
  joinGroup: { lock: true, auth: true, fn: handleJoinGroup },
  leaveGroup: { lock: true, auth: true, fn: handleLeaveGroup },
  castThemeVote: { lock: true, auth: true, fn: handleCastThemeVote },
  startNewMonthGarden: { lock: true, auth: true, fn: handleStartNewMonthGarden }
};

function dispatchRequest(req) {
  var action = req && req.action ? String(req.action).trim() : '';
  var spec = ACTION_HANDLERS[action];
  if (!spec) throw appError('VALIDATION_ERROR', '不支援的操作類型：' + action);

  var payload = (req && req.payload && typeof req.payload === 'object') ? req.payload : {};
  var authToken = req && req.authToken ? String(req.authToken) : '';

  var run = function () {
    if (!spec.auth) return spec.fn(payload);
    var tables = loadCoreTables();
    var authInfo = authenticateSession(tables, authToken);
    return spec.fn(payload, {
      tables: tables,
      user: authInfo.user,
      tokenHash: authInfo.tokenHash,
      authToken: authToken
    });
  };

  return spec.lock ? withScriptLock(run) : run();
}

function jsonOut(obj) {
  var text = JSON.stringify(obj);
  if (!ENV.ContentService) return text;
  return ENV.ContentService.createTextOutput(text).setMimeType(ENV.ContentService.MimeType.JSON);
}

function doGet() {
  return jsonOut({ ok: true, serverTimeMs: ENV.nowMs(), data: { status: 'ready' } });
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw) throw appError('VALIDATION_ERROR', '缺少請求內容');
    var req = JSON.parse(raw);
    var data = dispatchRequest(req);
    return jsonOut({ ok: true, serverTimeMs: ENV.nowMs(), data: data });
  } catch (err) {
    var code = (err && err.code) || 'VALIDATION_ERROR';
    var msg = (err && err.message) || '系統發生未預期錯誤';
    return jsonOut({ ok: false, serverTimeMs: ENV.nowMs(), code: code, message: msg });
  }
}

function runDailyBackup() {
  var now = ENV.nowMs();
  var dayKey = getGameDayKey(now, 'Asia/Taipei', GAME_CONFIG.dayBoundaryHour);
  var folders = ENV.DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : ENV.DriveApp.createFolder(BACKUP_FOLDER_NAME);
  var prefix = 'backup_';
  var name = prefix + dayKey;
  ENV.DriveApp.getFileById(ENV.spreadsheetId).makeCopy(name, folder);

  // 保留最近 14 份每日備份 + 每月 1 號永久快照
  var cutoffDay = addDays(dayKey, -14);
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var fn = f.getName();
    if (fn.indexOf(prefix) !== 0) continue;
    var fDay = fn.slice(prefix.length);
    if (!DAY_KEY_RE.test(fDay)) continue;
    if (fDay < cutoffDay && fDay.slice(8, 10) !== '01') {
      f.setTrashed(true);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SPREADSHEET_ID: SPREADSHEET_ID,
    GAME_CONFIG: GAME_CONFIG,
    CATALOG: CATALOG,
    HEADERS: HEADERS,
    __setGasEnv: __setGasEnv,
    dispatchRequest: dispatchRequest,
    doGet: doGet,
    doPost: doPost,
    runDailyBackup: runDailyBackup,
    getGameDayKey: getGameDayKey,
    addDays: addDays,
    isLastDayOfMonth: isLastDayOfMonth,
    countEssayWords: countEssayWords,
    getRarityProbabilities: getRarityProbabilities,
    rollSeed: rollSeed,
    getStreakMultiplier: getStreakMultiplier,
    advanceStreakOnWrite: advanceStreakOnWrite,
    repairStreakOnMakeUp: repairStreakOnMakeUp,
    calcRequiredDays: calcRequiredDays,
    calcPlantLevel: calcPlantLevel,
    evaluatePlantState: evaluatePlantState,
    calculateBeauty: calculateBeauty,
    resolveGroupThemeVote: resolveGroupThemeVote
  };
}
