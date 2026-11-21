// 隨筆花園：核心規則與惰性結算引擎（無外部依賴，瀏覽器與 Node 皆可直接 import）

// 1. 遊戲日計算（凌晨 dayBoundaryHour 點換日，回傳 YYYY-MM-DD）
export function getGameDayKey(dateOrMs = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, boundaryHour = 4) {
  const d = new Date(typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime());
  const shifted = new Date(d.getTime() - boundaryHour * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(shifted);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

export function addDays(dayKey, delta) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function isLastDayOfMonth(dayKey) {
  const nextDay = addDays(dayKey, 1);
  return nextDay.slice(0, 7) !== dayKey.slice(0, 7);
}

// 2. 字數計算：不算空白與標點；CJK 字元 1 字算 1，英文／數字連續單字算 1
export function countEssayWords(text) {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || [];
  const nonCjk = text.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g, ' ');
  const wordMatches = nonCjk.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return cjkMatches.length + wordMatches.length;
}

// 3. 稀有度機率公式（design.md §4.2）
export function getRarityProbabilities(wordCount, config) {
  const minW = config.minWords;
  if (wordCount < minW) return { common: 0, rare: 0, epic: 0, legendary: 0 };
  const x = Math.min(Math.max(0, wordCount - config.rarityFormula.offset), config.rarityFormula.cap);
  const d = 100 + 10 * x;
  const common = Math.max(0, 80 - (880 * x) / d);
  const rare = 17 + (400 * x) / d;
  const epic = 3 + (280 * x) / d;
  const legendary = (200 * x) / d;
  return { common, rare, epic, legendary };
}

// 抽種子稀有度與品種（含 10 顆保底：第 11 顆必出史詩以上，依史詩:傳說比例分配；剛好 10 字固定史詩）
export function rollSeed(wordCount, currentPity, theme, catalogSpecies, config, rng = Math.random) {
  const probs = getRarityProbabilities(wordCount, config);
  const isPity = currentPity >= config.pityThreshold;
  let rarity;

  if (isPity) {
    const highSum = probs.epic + probs.legendary;
    if (probs.legendary <= 0 || highSum <= 0) {
      rarity = 'epic';
    } else {
      rarity = rng() * highSum < probs.epic ? 'epic' : 'legendary';
    }
  } else {
    const r = rng() * 100;
    if (r < probs.common) rarity = 'common';
    else if (r < probs.common + probs.rare) rarity = 'rare';
    else if (r < probs.common + probs.rare + probs.epic) rarity = 'epic';
    else rarity = 'legendary';
  }

  const nextPity = (rarity === 'epic' || rarity === 'legendary') ? 0 : currentPity + 1;
  // 種子池：當月主題 + 通用植物，同稀有度等機率抽取
  const pool = catalogSpecies.filter(
    s => (s.theme === theme || s.theme === 'common') && s.rarity === rarity
  );
  const chosen = pool[Math.floor(rng() * pool.length)] || catalogSpecies[0];
  return { speciesId: chosen.id, rarity, isPity, nextPity };
}

// 4. 連續天數倍率（design.md §6）
export function getStreakMultiplier(streakCount, config) {
  let mult = 1;
  for (const [days, m] of config.streakMultipliers) {
    if (streakCount >= days) mult = m;
  }
  return mult;
}

// 更新連續天數（當天第一篇寫作時呼叫）
export function advanceStreakOnWrite(streak, todayKey) {
  const yesterday = addDays(todayKey, -1);
  if (streak.lastDay === todayKey) return { ...streak };
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

// 補寫昨天時修補連續天數（data-model.md §6.2）
export function repairStreakOnMakeUp(streak, todayKey) {
  const yesterday = addDays(todayKey, -1);
  const dayBefore = addDays(todayKey, -2);
  if (streak.lastDay === todayKey) {
    // 今天已經寫過（剛剛被歸 1）
    if (streak.prevLastDay === dayBefore) {
      return { ...streak, count: (streak.prevCount || 0) + 2 };
    }
    return { ...streak, count: Math.max(streak.count, 2) };
  }
  // 今天還沒寫
  if (streak.lastDay === dayBefore) {
    return { ...streak, count: (streak.count || 0) + 1, lastDay: yesterday };
  }
  return { ...streak, count: 1, lastDay: yesterday };
}

// 5. 種下時計算需求天數（含多人倍率無條件進位）
export function calcRequiredDays(baseDays, memberCount, config) {
  const mult = config.groupGrowthMultiplier[String(Math.min(5, Math.max(1, memberCount)))] || 1;
  return Math.ceil(baseDays * mult);
}

// 依進度計算植物外觀等級：n = requiredDays + 1 天成熟的第 i = progress + 1 天為 floor(4/(n-1)*(i-1)) + 1
export function calcPlantLevel(progress, requiredDays) {
  const req = Math.max(1, Number(requiredDays) || 1);
  const prog = Math.max(0, Number(progress) || 0);
  if (prog >= req) return 5;
  return Math.min(4, Math.floor((4 * prog) / req) + 1);
}

// 6. 惰性結算單株植物狀態（Lv1 剛種下 -> 每日撰寫推進進度至 requiredDays 滿級 Lv5；缺寫 day_1 -> day_2 wilt -> day_3 dead；枯萎當天寫作可恢復原級，但無緣 perfect）
// daysMap: { [dayKey]: { essays, lastEssayAt, writers: { [uid]: ts }, madeUp } }
// gardenType: 'personal' | 'group'
// 回傳 { stage: 'growing'|'grown'|'withering'|'dead', progress, level, miss, hadWilt, isPerfect, finalStage }
export function evaluatePlantState(plant, daysMap, todayKey, gardenType = 'personal') {
  if (plant.limited || plant.finalStage === 'grown') {
    const hadWilt = Boolean(plant.hadWilt);
    return {
      stage: 'grown',
      progress: plant.requiredDays,
      level: 5,
      miss: 0,
      hadWilt,
      isPerfect: !hadWilt,
      finalStage: 'grown'
    };
  }
  if (plant.finalStage === 'dead') {
    return { stage: 'dead', progress: 0, level: plant.finalLevel ?? 1, miss: 2, hadWilt: true, isPerfect: false, finalStage: 'dead' };
  }
  if (plant.frozen) {
    return { ...plant.frozen, miss: 0, finalStage: null };
  }

  const contribOnDay = (dayKey) => {
    const rec = daysMap[dayKey];
    if (!rec) return 0;
    if (gardenType === 'personal') {
      return (rec.essays || 0) > 0 ? 1 : 0;
    }
    return Object.keys(rec.writers || {}).length;
  };

  const isMadeUp = (dayKey) => Boolean(daysMap[dayKey]?.madeUp);

  // 種下當天固定顯示 Lv1，隔天起有寫至少一篇才逐步成長
  if (plant.plantedDay >= todayKey) {
    return { stage: 'growing', progress: 0, level: 1, miss: 0, hadWilt: false, isPerfect: false, finalStage: null };
  }

  let progress = 0;
  let miss = 0;
  let hadWilt = false;

  const yesterdayKey = addDays(todayKey, -1);
  let curDay = addDays(plant.plantedDay, 1);

  while (curDay <= yesterdayKey) {
    const c = contribOnDay(curDay);
    if (c > 0) {
      // 枯萎狀態當天有寫：恢復至枯萎前的 Level（不額外進級，但留下枯萎紀錄）
      if (miss === 1) {
        miss = 0;
      } else {
        progress += c;
      }
    } else if (isMadeUp(curDay)) {
      miss = 0;
    } else {
      miss += 1;
      if (miss === 1) hadWilt = true;
      if (miss >= 2) {
        return { stage: 'dead', progress, level: calcPlantLevel(progress, plant.requiredDays), miss, hadWilt: true, isPerfect: false, finalStage: 'dead' };
      }
    }

    if (progress >= plant.requiredDays) {
      return { stage: 'grown', progress: plant.requiredDays, level: 5, miss: 0, hadWilt, isPerfect: !hadWilt, finalStage: 'grown' };
    }
    curDay = addDays(curDay, 1);
  }

  const todayContrib = contribOnDay(todayKey);
  const preMatureLevel = calcPlantLevel(progress, plant.requiredDays);
  if (miss === 1) {
    if (todayContrib > 0) {
      return { stage: 'growing', progress, level: preMatureLevel, miss: 0, hadWilt: true, isPerfect: false, finalStage: null };
    }
    return { stage: 'withering', progress, level: preMatureLevel, miss: 1, hadWilt: true, isPerfect: false, finalStage: null };
  }

  if (todayContrib > 0) {
    progress += todayContrib;
    if (progress >= plant.requiredDays) {
      return { stage: 'grown', progress: plant.requiredDays, level: 5, miss: 0, hadWilt, isPerfect: !hadWilt, finalStage: 'grown' };
    }
  }

  return { stage: 'growing', progress, level: calcPlantLevel(progress, plant.requiredDays), miss: 0, hadWilt, isPerfect: false, finalStage: null };
}

// 7. 花園美觀度計算（design.md §6.1）
export function calculateBeauty(plantsWithState, decorList, catalog, config) {
  const speciesMap = Object.fromEntries(catalog.species.map(s => [s.id, s]));
  const decorMap = Object.fromEntries(catalog.decor.map(d => [d.id, d]));
  let score = 0;

  for (const p of plantsWithState) {
    if (p.evalState.stage === 'grown') {
      const sp = speciesMap[p.speciesId];
      const rarity = p.limited ? 'legendary' : (sp?.rarity || 'common');
      const w = config.beauty.rarityWeight[rarity] || 1;
      score += w * 3;
    } else if (p.evalState.stage === 'dead') {
      score -= config.beauty.witheredPenalty;
    }
  }

  for (const d of decorList) {
    const item = decorMap[d.itemId];
    if (item) score += Math.floor(item.cost / config.beauty.decorDivisor);
  }

  return score;
}

// 8. 計算花園格子物件的動態縮放寬度（若相鄰兩物件轉換後寬度相加 > maxTotalWidth，則按兩者寬度等比縮小）
// items: [{ key: "x,y", x, y, width }] -> 回傳 Map<key, effectiveWidth>
export function computeNeighborAdjustedScales(items, maxTotalWidth) {
  const byCoord = new Map(items.map(it => [`${Number(it.x)},${Number(it.y)}`, it]));
  const result = new Map();

  for (const it of items) {
    const x = Number(it.x);
    const y = Number(it.y);
    const wA = it.width;
    let minFactor = 1.0;

    // 檢查上下左右 4 個相鄰格子
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nb = byCoord.get(`${x + dx},${y + dy}`);
      if (nb) {
        const wB = nb.width;
        if (wA + wB > maxTotalWidth) {
          const factor = maxTotalWidth / (wA + wB);
          if (factor < minFactor) minFactor = factor;
        }
      }
    }
    result.set(`${x},${y}`, wA * minFactor);
  }
  return result;
}

// 9. 團體換月主題投票定案（design.md §8 & data-model.md §6.4：唯一最高票勝出；平票從平票選項隨機；無人投從全部隨機，以 hash(gid+month) 決定）
export function resolveGroupThemeVote(gardenId, monthKey, votesMap = {}, allThemes = ['flowerbed', 'forest', 'oasis']) {
  const counts = {};
  for (const t of allThemes) counts[t] = 0;
  for (const choice of Object.values(votesMap || {})) {
    if (counts[choice] !== undefined) counts[choice] += 1;
  }
  const maxVotes = Math.max(...Object.values(counts));
  const candidates = maxVotes === 0
    ? allThemes
    : allThemes.filter(t => counts[t] === maxVotes);

  if (candidates.length === 1) return candidates[0];

  // Deterministic hash(gardenId + monthKey)
  const seedStr = `${gardenId}:${monthKey}`;
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = (h >>> 0) % candidates.length;
  return candidates[idx];
}
