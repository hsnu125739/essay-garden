// 隨筆花園：資料狀態管理與儲存層（支援本機持久化 + Firebase 雲端同步）
import {
  getGameDayKey,
  addDays,
  isLastDayOfMonth,
  countEssayWords,
  rollSeed,
  getStreakMultiplier,
  advanceStreakOnWrite,
  repairStreakOnMakeUp,
  calcRequiredDays,
  evaluatePlantState,
  calculateBeauty,
  resolveGroupThemeVote
} from './engine.js?v=20261123a';

export const DEMO_ESSAY_ID = 'essay_demo_welcome';
export const DEMO_CARD_STYLE_KEY = 'essay_garden_demo_card_style_v1';
export const DEMO_REACTIONS_KEY = 'essay_garden_demo_reactions_v1';

export function getDemoEssayCardStyle() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(DEMO_CARD_STYLE_KEY) || 'card2';
    }
  } catch (e) {}
  return 'card2';
}

export function saveDemoEssayCardStyle(styleId) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEMO_CARD_STYLE_KEY, styleId);
    }
  } catch (e) {}
}

export function getDemoEssayReactions() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(DEMO_REACTIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    }
  } catch (e) {}
  return {};
}

export function saveDemoEssayReactions(reactions) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEMO_REACTIONS_KEY, JSON.stringify(reactions || {}));
    }
  } catch (e) {}
}

export function buildDemoWelcomeEssay(uid, displayName, todayKey, regionId = '') {
  const yesterdayKey = addDays(todayKey, -1);
  const welcomeContent = '歡迎來到美地隨筆！\n每則寫滿 10 字以上即可抽種子；將種子栽種在島上陪你一同成長！\n累積能量還能解鎖裝飾、新背景以及擴建島嶼，開始一起記錄生活微光、經營美地吧！';
  const createdAt = new Date(`${yesterdayKey}T20:00:00`).getTime() || (Date.now() - 86400000);
  return {
    id: DEMO_ESSAY_ID,
    isDemo: true,
    authorUid: 'guide_meidi',
    authorName: '美地嚮導',
    regionId: regionId || '',
    dayKey: yesterdayKey,
    content: welcomeContent,
    wordCount: countEssayWords(welcomeContent),
    private: false,
    cardStyle: getDemoEssayCardStyle(),
    reactions: getDemoEssayReactions(),
    createdAt,
    updatedAt: createdAt
  };
}

const STORAGE_KEY = 'essay_garden_state_v4';

export function createMemoryStorage() {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  };
}

export class GardenStore {
  constructor(config, catalog, storage = globalThis.localStorage || createMemoryStorage()) {
    this.config = config;
    this.catalog = catalog;
    this.storage = storage;
    this.speciesMap = Object.fromEntries(catalog.species.map(s => [s.id, s]));
    this.decorMap = Object.fromEntries(catalog.decor.map(d => [d.id, d]));
    this.bgThemeMap = Object.fromEntries((catalog.bgThemes || []).map(b => [b.id, b]));
    this.subscribers = new Set();
    this.state = this.loadState();
  }

  subscribe(listener) {
    if (typeof listener === 'function') {
      this.subscribers.add(listener);
      return () => this.subscribers.delete(listener);
    }
    return () => {};
  }

  notify() {
    this.saveState();
    for (const fn of this.subscribers) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('Store subscriber error:', err);
      }
    }
  }

  // 目前模擬時間（支援在設定中推進天數測試換日／斷簽／換月）
  nowMs() {
    return Date.now() + (this.state.timeOffsetDays || 0) * 86400 * 1000;
  }

  currentGarden() {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    return this.state.gardens[user.activeGardenId];
  }

  currentDayKey(garden = this.currentGarden()) {
    const tz = garden?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return getGameDayKey(this.nowMs(), tz, this.config.dayBoundaryHour);
  }

  loadState() {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.users && parsed.gardens && parsed.currentUserId && parsed.users[parsed.currentUserId]) {
          for (const g of Object.values(parsed.gardens || {})) {
            if (Array.isArray(g.essays)) {
              g.essays = g.essays.filter(e => !String(e.id || '').startsWith('essay_demo') && e.id !== 'essay_welcome');
            }
          }
          return parsed;
        }
        console.error('[GardenStore] Stored state schema invalid; backing up and resetting.');
      } catch (err) {
        console.error('[GardenStore] Stored state JSON corrupted; backing up and resetting:', err);
      }
      this.storage.setItem(`${STORAGE_KEY}_corrupted_backup`, raw);
    }
    return this.createInitialState();
  }

  saveState() {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  resetAllData() {
    this.storage.removeItem(STORAGE_KEY);
    this.state = this.createInitialState();
    this.notify();
  }

  currentUser() {
    return this.state.users[this.state.currentUserId];
  }

  getCurrentUserMultiplier() {
    return getStreakMultiplier(this.currentUser().streak.count, this.config);
  }

  getDecorBeautyBonus(itemId) {
    const item = this.decorMap[itemId];
    return item ? Math.floor(item.cost / this.config.beauty.decorDivisor) : 0;
  }

  getGroupGrowthMultiplier(memberCount) {
    return this.config.groupGrowthMultiplier[String(memberCount)] || 1;
  }

  updateDisplayName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return;
    const uid = this.state.currentUserId;
    const user = this.currentUser();
    user.displayName = trimmed;
    const garden = this.currentGarden();
    if (garden?.members?.[uid]) {
      garden.members[uid].displayName = trimmed;
    }
    this.notify();
  }

  advanceSimulationDays(deltaDays) {
    this.state.timeOffsetDays = (this.state.timeOffsetDays || 0) + Number(deltaDays);
    this.notify();
    return this.currentDayKey();
  }

  advanceToMonthEnd() {
    let guard = 0;
    while (!isLastDayOfMonth(this.currentDayKey()) && guard < 35) {
      this.state.timeOffsetDays = (this.state.timeOffsetDays || 0) + 1;
      guard++;
    }
    this.notify();
    return this.currentDayKey();
  }

  grantDebugEnergy(amount) {
    this.currentUser().energy += Number(amount);
    this.notify();
    return this.currentUser().energy;
  }

  createInitialState() {
    const uid = 'user_me';
    const gid = 'garden_personal_me';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayKey = getGameDayKey(Date.now(), tz, this.config.dayBoundaryHour);
    const monthKey = todayKey.slice(0, 7);
    const prevMonthKey = addDays(`${monthKey}-01`, -2).slice(0, 7);
    const prevRid = `reg_${prevMonthKey}_0`;
    const rid = `reg_${monthKey}_1`;

    return {
      timeOffsetDays: 0,
      currentUserId: uid,
      users: {
        [uid]: {
          uid,
          displayName: '旅人作家',
          personalGardenId: gid,
          activeGardenId: gid,
          energy: 65,
          seeds: { fb_c1: 1, fb_r1: 1, fo_r2: 1 },
          limitedSeeds: {},
          pity: 0,
          streak: { count: 1, lastDay: addDays(todayKey, -1), prevCount: 0, prevLastDay: null },
          milestones: [],
          unlockedBgThemes: ['morning'],
          activeBgTheme: 'morning',
          dex: { fb_c1: true, fb_r1: true, fo_r2: true, fb_l1: true, fo_e1: true },
          days: {
            [addDays(todayKey, -1)]: { essays: 1, words: 45, lastEssayAt: Date.now() - 86400000, madeUp: false }
          }
        }
      },
      gardens: {
        [gid]: {
          id: gid,
          type: 'personal',
          name: '我的隨筆花園',
          memberUids: [uid],
          members: {
            [uid]: { displayName: '旅人作家', streakCount: 1, lastDay: addDays(todayKey, -1) }
          },
          timezone: tz,
          activeRegionId: rid,
          themeVote: null,
          days: {
            [addDays(todayKey, -1)]: { seedsGiven: 1, writers: { [uid]: Date.now() - 86400000 }, madeUp: false }
          },
          regions: {
            [prevRid]: {
              id: prevRid,
              theme: 'forest',
              month: prevMonthKey,
              status: 'archived',
              size: this.config.regionSize.personal,
              expansions: 0,
              createdAt: Date.now() - 35 * 86400000,
              plants: {
                p_prev1: {
                  id: 'p_prev1',
                  speciesId: 'fo_e1',
                  x: 2,
                  y: 2,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -38),
                  plantedAt: Date.now() - 38 * 86400000,
                  requiredDays: 3,
                  limited: false,
                  level: 5,
                  finalStage: 'grown',
                  frozen: null
                },
                p_prev2: {
                  id: 'p_prev2',
                  speciesId: 'fo_r2',
                  x: 1,
                  y: 2,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -34),
                  plantedAt: Date.now() - 34 * 86400000,
                  requiredDays: 3,
                  limited: false,
                  level: 3,
                  finalStage: 'grown',
                  frozen: null
                },
                p_prev3: {
                  id: 'p_prev3',
                  speciesId: 'fo_r1',
                  x: 3,
                  y: 3,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -32),
                  plantedAt: Date.now() - 32 * 86400000,
                  requiredDays: 2,
                  limited: false,
                  level: 4,
                  finalStage: 'grown',
                  frozen: null
                }
              },
              decor: {
                d_prev1: { id: 'd_prev1', itemId: 'dec_torii', x: 2, y: 0, placedBy: uid }
              }
            },
            [rid]: {
              id: rid,
              theme: 'flowerbed',
              month: monthKey,
              status: 'active',
              size: this.config.regionSize.personal,
              expansions: 0,
              createdAt: Date.now() - 3 * 86400000,
              plants: {
                p_demo1: {
                  id: 'p_demo1',
                  speciesId: 'fb_l1',
                  x: 1,
                  y: 1,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -6),
                  plantedAt: Date.now() - 6 * 86400000,
                  requiredDays: 5,
                  limited: false,
                  level: 4,
                  finalStage: 'grown',
                  frozen: null
                },
                p_demo2: {
                  id: 'p_demo2',
                  speciesId: 'fo_e1',
                  x: 3,
                  y: 1,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -4),
                  plantedAt: Date.now() - 4 * 86400000,
                  requiredDays: 3,
                  limited: false,
                  level: 2,
                  finalStage: 'grown',
                  frozen: null
                },
                p_demo3: {
                  id: 'p_demo3',
                  speciesId: 'fb_r1',
                  x: 2,
                  y: 3,
                  plantedBy: uid,
                  plantedDay: addDays(todayKey, -1),
                  plantedAt: Date.now() - 86000000,
                  requiredDays: 2,
                  limited: false,
                  level: 1,
                  finalStage: null,
                  frozen: null
                }
              },
              decor: {
                d_demo1: { id: 'd_demo1', itemId: 'dec_lantern', x: 1, y: 3, placedBy: uid }
              }
            }
          },
          essays: []
        }
      },
      invites: {}
    };
  }

  // 取得區域內所有植物的即時純推算結果（唯讀查詢，不改寫植物狀態）
  getEvaluatedRegion(gardenId, regionId) {
    const garden = this.state.gardens[gardenId];
    if (!garden) return null;
    const region = garden.regions[regionId];
    if (!region) return null;

    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const todayKey = this.currentDayKey(garden);
    const daysSource = garden.type === 'personal' ? user.days : garden.days;

    const plantsWithState = Object.values(region.plants || {}).map(p => {
      const evalState = region.status === 'snapshot' && p.frozen
        ? { ...p.frozen, miss: 0, finalStage: null }
        : evaluatePlantState(p, daysSource, todayKey, garden.type);
      return { ...p, evalState };
    });

    const decorList = Object.values(region.decor || {});
    const beauty = calculateBeauty(plantsWithState, decorList, this.catalog, this.config);

    return { region, plantsWithState, decorList, beauty, todayKey };
  }

  // 檢查換月與團體最後一天開票（data-model.md §6.4）
  checkMonthTransition() {
    const garden = this.currentGarden();
    if (!garden || !garden.activeRegionId) return null;
    const activeRegion = garden.regions[garden.activeRegionId];
    const todayKey = this.currentDayKey(garden);
    const currentMonth = todayKey.slice(0, 7);

    // 團體：每月最後一天開啟下個月投票
    if (garden.type === 'group' && isLastDayOfMonth(todayKey)) {
      const nextMonth = addDays(todayKey, 1).slice(0, 7);
      if (!garden.themeVote || garden.themeVote.month !== nextMonth) {
        garden.themeVote = { month: nextMonth, votes: {} };
        this.saveState();
      }
    }

    // 若已經換月
    if (activeRegion && activeRegion.month !== currentMonth) {
      if (garden.type === 'group') {
        // 團體換月自動依投票結果定案
        const votes = garden.themeVote?.month === currentMonth ? garden.themeVote.votes : {};
        const winningTheme = resolveGroupThemeVote(garden.id, currentMonth, votes);
        this.startNewMonthRegion(winningTheme, currentMonth);
        garden.themeVote = null;
        this.notify();
        return { autoResolvedGroupTheme: winningTheme, month: currentMonth };
      } else {
        // 個人花園強制跳出選主題
        return { needsPersonalThemePick: true, month: currentMonth };
      }
    }
    return null;
  }

  startNewMonthRegion(theme, monthKey = this.currentDayKey().slice(0, 7), targetGarden = this.currentGarden()) {
    if (targetGarden.activeRegionId && targetGarden.regions[targetGarden.activeRegionId]) {
      targetGarden.regions[targetGarden.activeRegionId].status = 'archived';
    }
    const rid = `reg_${monthKey}_${Math.random().toString(36).slice(2, 6)}`;
    const initSize = targetGarden.type === 'group'
      ? this.config.regionSize.group
      : this.config.regionSize.personal;

    targetGarden.regions[rid] = {
      id: rid,
      theme,
      month: monthKey,
      status: 'active',
      size: initSize,
      expansions: 0,
      createdAt: this.nowMs(),
      plants: {},
      decor: {}
    };
    targetGarden.activeRegionId = rid;
    this.notify();
    return rid;
  }

  castGroupThemeVote(theme) {
    const garden = this.currentGarden();
    if (!garden || garden.type !== 'group' || !garden.themeVote) return;
    garden.themeVote.votes[this.state.currentUserId] = theme;
    this.notify();
  }

  // 取得首頁隨筆輪播（跨花園自己的所有隨筆 + 目前團體公開隨筆，依時間新到舊）
  getCarouselEssays() {
    const uid = this.state.currentUserId;
    const activeGid = this.state.users[uid]?.activeGardenId;
    const merged = new Map();

    for (const g of Object.values(this.state.gardens)) {
      for (const e of (g.essays || [])) {
        if (e.id === DEMO_ESSAY_ID || e.id === 'essay_welcome') continue;
        if (e.authorUid === uid) {
          merged.set(e.id, e);
        } else if (g.id === activeGid && !e.private) {
          merged.set(e.id, e);
        }
      }
    }

    // 示範隨筆寫死在前端，後端無資料；日期為昨天
    if (!uid || !uid.startsWith('u_test_')) {
      const garden = this.state.gardens[activeGid] || Object.values(this.state.gardens)[0];
      const todayKey = this.currentDayKey(garden);
      const user = this.state.users[uid];
      const demoEssay = buildDemoWelcomeEssay(uid, user?.displayName, todayKey, garden?.activeRegionId);
      merged.set(demoEssay.id, demoEssay);
    }

    return Array.from(merged.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // 完成一篇隨筆（data-model.md §6.1）
  submitEssay(content, isPrivate = undefined, writerUid = this.state.currentUserId, cardStyle = null) {
    const wordCount = countEssayWords(content);
    if (wordCount < this.config.minWords) {
      throw new Error(`字數需至少 ${this.config.minWords} 字（目前 ${wordCount} 字）`);
    }

    const user = this.state.users[writerUid];
    const garden = this.state.gardens[user.activeGardenId];
    const activeRegion = garden.regions[garden.activeRegionId];
    const dayKey = this.currentDayKey(garden);
    const now = this.nowMs();

    if (!user.days[dayKey]) {
      user.days[dayKey] = { essays: 0, words: 0, lastEssayAt: 0, madeUp: false };
    }
    if (!garden.days[dayKey]) {
      garden.days[dayKey] = { seedsGiven: 0, writers: {}, madeUp: false };
    }

    const userDay = user.days[dayKey];
    const gardenDay = garden.days[dayKey];

    const result = {
      wordCount,
      rewardType: null,
      seedSpeciesId: null,
      seedRarity: null,
      isPity: false,
      decomposedEnergy: 0,
      overflowEnergy: 0,
      dailyBaseEnergy: 0,
      streakCount: user.streak.count,
      streakMultiplier: 1,
      milestoneUnlocked: null
    };

    // 1. 判斷種子名額（全花園共用每天前 3 篇）
    if (gardenDay.seedsGiven < this.config.dailySeedCap) {
      const roll = rollSeed(wordCount, user.pity, activeRegion.theme, this.catalog.species, this.config);
      user.pity = roll.nextPity;
      user.dex[roll.speciesId] = true;
      gardenDay.seedsGiven += 1;

      const bagTotal = Object.values(user.seeds).reduce((a, b) => a + b, 0);
      if (bagTotal < this.config.seedBagCap) {
        user.seeds[roll.speciesId] = (user.seeds[roll.speciesId] || 0) + 1;
        result.rewardType = 'seed';
      } else {
        const decomp = this.config.decomposeEnergy[roll.rarity] || 2;
        user.energy += decomp;
        result.rewardType = 'seed_decomposed';
        result.decomposedEnergy = decomp;
      }
      result.seedSpeciesId = roll.speciesId;
      result.seedRarity = roll.rarity;
      result.isPity = roll.isPity;
    } else {
      const overflow = Math.floor(wordCount / this.config.overflowWordsPerEnergy);
      user.energy += overflow;
      result.rewardType = 'energy';
      result.overflowEnergy = overflow;
    }

    // 2. 若是個人當天第一篇：更新連續天數、發放基礎能量與里程碑限定植物
    if (userDay.essays === 0) {
      user.streak = advanceStreakOnWrite(user.streak, dayKey);
      const mult = getStreakMultiplier(user.streak.count, this.config);
      const baseE = Math.round(this.config.dailyBaseEnergy * mult);
      user.energy += baseE;
      result.dailyBaseEnergy = baseE;
      result.streakCount = user.streak.count;
      result.streakMultiplier = mult;

      for (const m of this.config.milestones) {
        if (user.streak.count >= m && !user.milestones.includes(m)) {
          user.milestones.push(m);
          const limSp = this.catalog.species.find(s => s.theme === 'limited' && s.milestone === m);
          if (limSp) {
            user.limitedSeeds[limSp.id] = (user.limitedSeeds[limSp.id] || 0) + 1;
            user.dex[limSp.id] = true;
            result.milestoneUnlocked = limSp;
          }
        }
      }
    } else {
      result.streakCount = user.streak.count;
      result.streakMultiplier = getStreakMultiplier(user.streak.count, this.config);
    }

    // 3. 更新每日紀錄與團體成員冗余資訊
    userDay.essays += 1;
    userDay.words += wordCount;
    userDay.lastEssayAt = now;
    gardenDay.writers[writerUid] = now;

    if (garden.members[writerUid]) {
      garden.members[writerUid].streakCount = user.streak.count;
      garden.members[writerUid].lastDay = user.streak.lastDay;
    }

    const validCardStyle = typeof cardStyle === 'string' && cardStyle.trim() ? cardStyle.trim() : null;
    if (validCardStyle) user.lastCardStyle = validCardStyle;
    const resolvedPrivate = isPrivate === undefined ? garden.type !== 'group' : Boolean(isPrivate);

    // 4. 建立隨筆文件
    const essay = {
      id: `essay_${now}_${Math.random().toString(36).slice(2, 6)}`,
      authorUid: writerUid,
      authorName: user.displayName,
      regionId: activeRegion.id,
      dayKey,
      content,
      wordCount,
      private: resolvedPrivate,
      cardStyle: validCardStyle,
      reward: result.rewardType === 'energy'
        ? { type: 'energy', energy: result.overflowEnergy }
        : { type: 'seed', speciesId: result.seedSpeciesId },
      createdAt: now,
      updatedAt: now
    };
    garden.essays.unshift(essay);

    this.notify();
    return { essay, result };
  }

  // 編輯既有隨筆（僅作者本人，更新字數但不重算獎勵）
  updateEssayContent(essayId, newContent, isPrivate, cardStyle) {
    const uid = this.state.currentUserId;
    const user = this.currentUser();
    for (const g of Object.values(this.state.gardens)) {
      const target = (g.essays || []).find(e => e.id === essayId);
      if (!target) continue;
      if (!target.authorUid || target.authorUid !== uid) {
        throw new Error('只有作者本人可以編輯自己的隨筆');
      }
      const wordCount = countEssayWords(newContent);
      if (wordCount === 0) {
        throw new Error('隨筆內容不可為空');
      }
      const prevWords = Number(target.wordCount || 0);
      const userDay = user?.days?.[target.dayKey];
      if (userDay) {
        userDay.words = Math.max(0, (userDay.words || 0) - prevWords + wordCount);
      }
      target.content = newContent;
      target.wordCount = wordCount;
      target.private = Boolean(isPrivate);
      if (cardStyle !== undefined) {
        target.cardStyle = cardStyle;
        if (typeof cardStyle === 'string' && cardStyle.trim()) {
          user.lastCardStyle = cardStyle.trim();
        }
      }
      target.updatedAt = this.nowMs();
      this.notify();
      return target;
    }
    throw new Error('找不到可編輯的隨筆');
  }

  // 設定或取消隨筆反應（短按愛心／長按滑選其他反應，多人團體中的私密隨筆不開放反應）
  setEssayReaction(essayId, reactionId, actorUid = this.state.currentUserId) {
    for (const g of Object.values(this.state.gardens)) {
      const target = (g.essays || []).find(e => e.id === essayId);
      if (target) {
        if (target.private && this.currentGarden()?.type === 'group') return null;
        if (!target.reactions || typeof target.reactions !== 'object') {
          target.reactions = {};
        }
        if (!reactionId) {
          delete target.reactions[actorUid];
        } else {
          target.reactions[actorUid] = reactionId;
        }
        this.notify();
        return target.reactions[actorUid] || null;
      }
    }
    throw new Error('找不到該篇隨筆');
  }

  // 檢查昨天是否可補寫（個人昨天 essays == 0 且尚未 madeUp）
  canMakeUpYesterday() {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const garden = this.currentGarden();
    const todayKey = this.currentDayKey(garden);
    const yesterdayKey = addDays(todayKey, -1);
    const yRec = user.days[yesterdayKey];
    const notWritten = !yRec || (yRec.essays || 0) === 0;
    const notMadeUp = !yRec || !yRec.madeUp;
    return {
      available: notWritten && notMadeUp,
      canAfford: user.energy >= this.config.makeUpCost,
      yesterdayKey,
      cost: this.config.makeUpCost
    };
  }

  hasStreakBrokenYesterday() {
    const user = this.currentUser();
    const todayKey = this.currentDayKey();
    const dayBefore = addDays(todayKey, -2);
    const s = user.streak;
    if (s.lastDay === todayKey) return s.prevLastDay === dayBefore && (s.prevCount || 0) > 0;
    return s.lastDay === dayBefore && (s.count || 0) > 0;
  }

  canRescuePlantByMakeUp(gardenId, plant) {
    if (!this.canMakeUpYesterday().available) return false;
    const garden = this.state.gardens[gardenId];
    if (!garden) return false;
    const todayKey = this.currentDayKey(garden);
    const yesterdayKey = addDays(todayKey, -1);
    const baseDays = garden.type === 'personal' ? this.currentUser().days : garden.days;
    const simulatedDays = {
      ...baseDays,
      [yesterdayKey]: { ...(baseDays[yesterdayKey] || {}), madeUp: true }
    };
    return evaluatePlantState(plant, simulatedDays, todayKey, garden.type).stage !== 'dead';
  }

  // 執行補寫昨天（data-model.md §6.2）
  makeUpYesterday() {
    const status = this.canMakeUpYesterday();
    if (!status.available) throw new Error('昨天已有紀錄或已補簽過');
    if (!status.canAfford) throw new Error(`能量不足（需 ${this.config.makeUpCost} 能量）`);

    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const garden = this.currentGarden();
    const todayKey = this.currentDayKey(garden);
    const yesterdayKey = status.yesterdayKey;

    user.energy -= this.config.makeUpCost;
    if (!user.days[yesterdayKey]) {
      user.days[yesterdayKey] = { essays: 0, words: 0, lastEssayAt: 0, madeUp: true };
    } else {
      user.days[yesterdayKey].madeUp = true;
    }

    if (garden.type === 'group') {
      if (!garden.days[yesterdayKey]) {
        garden.days[yesterdayKey] = { seedsGiven: 0, writers: {}, madeUp: true };
      } else {
        garden.days[yesterdayKey].madeUp = true;
      }
    }

    user.streak = repairStreakOnMakeUp(user.streak, todayKey);
    if (garden.members[uid]) {
      garden.members[uid].streakCount = user.streak.count;
      garden.members[uid].lastDay = user.streak.lastDay;
    }

    this.notify();
    return user.streak;
  }

  // 嚴格檢查目標格子 (x, y) 是否已被任何植物或裝飾占用（同一位置絕對不可擺兩樣東西）
  isCellOccupied(region, x, y, ignoreItemId = null) {
    const nx = Number(x);
    const ny = Number(y);
    const hasPlant = Object.values(region.plants || {}).some(
      p => p.id !== ignoreItemId && Number(p.x) === nx && Number(p.y) === ny
    );
    const hasDecor = Object.values(region.decor || {}).some(
      d => d.id !== ignoreItemId && Number(d.x) === nx && Number(d.y) === ny
    );
    return hasPlant || hasDecor;
  }

  // 種下種子或限定植物（data-model.md §6.3）
  plantSeed(speciesId, x, y, isLimited = false) {
    const nx = Number(x);
    const ny = Number(y);
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const garden = this.currentGarden();
    const region = garden.regions[garden.activeRegionId];

    if (region.status !== 'active') throw new Error('封存區域無法種植新植物');
    if (nx < 0 || ny < 0 || nx >= region.size || ny >= region.size) throw new Error('超出花園格子範圍');
    if (this.isCellOccupied(region, nx, ny)) throw new Error('此位置已經有植物或裝飾，不能重疊擺放');

    const bag = isLimited ? user.limitedSeeds : user.seeds;
    if (!bag[speciesId] || bag[speciesId] <= 0) throw new Error('沒有該品種的種子');

    const sp = this.speciesMap[speciesId];
    bag[speciesId] -= 1;
    if (bag[speciesId] <= 0) delete bag[speciesId];

    const memberCount = garden.memberUids.length;
    const reqDays = isLimited ? 1 : calcRequiredDays(sp.requiredDays, memberCount, this.config);
    const pid = `plant_${this.nowMs()}_${Math.random().toString(36).slice(2, 6)}`;

    region.plants[pid] = {
      id: pid,
      speciesId,
      x: nx,
      y: ny,
      plantedBy: uid,
      plantedDay: this.currentDayKey(garden),
      plantedAt: this.nowMs(),
      requiredDays: reqDays,
      limited: Boolean(isLimited),
      finalStage: isLimited ? 'grown' : null,
      frozen: null
    };

    this.notify();
    return region.plants[pid];
  }

  // 清除枯枝（花 5 能量）
  clearDeadPlant(gardenId, regionId, plantId) {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const evalData = this.getEvaluatedRegion(gardenId, regionId);
    if (!evalData || evalData.region.status === 'snapshot') throw new Error('唯讀快照無法修改');

    const pState = evalData.plantsWithState.find(p => p.id === plantId);
    if (!pState || pState.evalState.stage !== 'dead') throw new Error('只有已死掉的枯枝可以清除');
    if (user.energy < this.config.clearWitheredCost) {
      throw new Error(`能量不足（需要 ${this.config.clearWitheredCost} 能量）`);
    }

    user.energy -= this.config.clearWitheredCost;
    delete this.state.gardens[gardenId].regions[regionId].plants[plantId];
    this.notify();
  }

  // 購買並直接擺放裝飾（無背包）
  buyAndPlaceDecor(gardenId, regionId, itemId, x, y) {
    const nx = Number(x);
    const ny = Number(y);
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const garden = this.state.gardens[gardenId];
    const region = garden.regions[regionId];
    if (region.status === 'snapshot') throw new Error('唯讀快照無法佈置');
    if (nx < 0 || ny < 0 || nx >= region.size || ny >= region.size) throw new Error('超出花園格子範圍');

    const item = this.decorMap[itemId];
    if (!item) throw new Error('找不到該裝飾商品');
    if (user.energy < item.cost) throw new Error(`能量不足（需要 ${item.cost} 能量）`);
    if (this.isCellOccupied(region, nx, ny)) throw new Error('此位置已經有植物或裝飾，不能重疊擺放');

    user.energy -= item.cost;
    const did = `decor_${this.nowMs()}_${Math.random().toString(36).slice(2, 6)}`;
    region.decor[did] = { id: did, itemId, x: nx, y: ny, placedBy: uid };
    this.notify();
    return region.decor[did];
  }

  // 拆除自己的裝飾（不退能量）
  removeDecor(gardenId, regionId, decorId) {
    const uid = this.state.currentUserId;
    const region = this.state.gardens[gardenId]?.regions[regionId];
    if (!region || region.status === 'snapshot') throw new Error('無法修改此區域');
    const dec = region.decor[decorId];
    if (!dec) throw new Error('找不到該裝飾');
    if (dec.placedBy !== uid) throw new Error('只能拆除自己擺放的裝飾');
    delete region.decor[decorId];
    this.notify();
  }

  // 移動植物或裝飾（僅種植／擺放者本人可移動）
  moveGridItem(gardenId, regionId, kind, itemId, newX, newY) {
    const nx = Number(newX);
    const ny = Number(newY);
    const uid = this.state.currentUserId;
    const region = this.state.gardens[gardenId]?.regions[regionId];
    if (!region || region.status === 'snapshot') throw new Error('唯讀快照無法移動');
    if (nx < 0 || ny < 0 || nx >= region.size || ny >= region.size) throw new Error('超出邊界');
    if (this.isCellOccupied(region, nx, ny, itemId)) throw new Error('目標位置已經有植物或裝飾，不能重疊擺放');

    if (kind === 'plant') {
      const p = region.plants[itemId];
      if (!p || p.plantedBy !== uid) throw new Error('只能移動自己種植的植物');
      p.x = nx;
      p.y = ny;
    } else {
      const d = region.decor[itemId];
      if (!d || d.placedBy !== uid) throw new Error('只能移動自己擺放的裝飾');
      d.x = nx;
      d.y = ny;
    }
    this.notify();
  }

  // 手動分解種子換取能量
  decomposeSeed(speciesId, count = 1) {
    const user = this.state.users[this.state.currentUserId];
    const owned = user.seeds[speciesId] || 0;
    if (owned < count) throw new Error('種子數量不足');
    const sp = this.speciesMap[speciesId];
    const gain = (this.config.decomposeEnergy[sp.rarity] || 2) * count;
    user.seeds[speciesId] -= count;
    if (user.seeds[speciesId] <= 0) delete user.seeds[speciesId];
    user.energy += gain;
    this.notify();
    return gain;
  }

  // 擴充當月區域（上限 9x9：100 / 250 / 500 / 800）
  expandActiveRegion() {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const garden = this.currentGarden();
    const region = garden.regions[garden.activeRegionId];
    if (region.status !== 'active') throw new Error('只有當月活動區域可以擴地');
    if (region.size >= 9 || region.expansions >= this.config.expansionCosts.length) {
      throw new Error('已達最大土地尺寸（9×9）');
    }

    const cost = this.config.expansionCosts[region.expansions];
    if (user.energy < cost) throw new Error(`能量不足（需要 ${cost} 能量）`);

    user.energy -= cost;
    region.expansions += 1;
    region.size += 1;
    this.notify();
    return region;
  }

  // 取得已解鎖之天候動態背景
  getUnlockedBgThemes() {
    const user = this.currentUser();
    if (!user.unlockedBgThemes || !Array.isArray(user.unlockedBgThemes)) {
      user.unlockedBgThemes = ['morning'];
    }
    if (!user.unlockedBgThemes.includes('morning')) {
      user.unlockedBgThemes.unshift('morning');
    }
    return user.unlockedBgThemes;
  }

  // 取得目前啟用之背景
  getActiveBgTheme() {
    const user = this.currentUser();
    return user.activeBgTheme || 'morning';
  }

  // 切換啟用背景
  setBgTheme(themeId) {
    const user = this.currentUser();
    const unlocked = this.getUnlockedBgThemes();
    if (!unlocked.includes(themeId)) return false;
    user.activeBgTheme = themeId;
    this.notify();
    return true;
  }

  // 商店花費能量購買解鎖背景（若無指定 cost 則自動自 catalog SSOT 查詢）
  buyBgTheme(themeId, cost) {
    const user = this.currentUser();
    const unlocked = this.getUnlockedBgThemes();
    if (unlocked.includes(themeId)) {
      return { success: true, alreadyOwned: true };
    }
    const theme = this.bgThemeMap ? this.bgThemeMap[themeId] : null;
    const actualCost = cost !== undefined ? Number(cost) : (theme ? theme.cost : 0);
    if (user.energy < actualCost) {
      return { success: false, reason: `能量不足（需要 ${actualCost} 能量，目前持有 ${user.energy} 能量）` };
    }
    user.energy -= actualCost;
    user.unlockedBgThemes.push(themeId);
    user.activeBgTheme = themeId;
    this.notify();
    return { success: true, alreadyOwned: false };
  }

  // 開團：封存個人區域，建立 6x6 團體共用花園與邀請碼（data-model.md §6.5）
  createGroupGarden(groupName, theme) {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const personalGarden = this.state.gardens[user.personalGardenId];

    // 1. 封存目前個人區域
    if (personalGarden.activeRegionId && personalGarden.regions[personalGarden.activeRegionId]) {
      personalGarden.regions[personalGarden.activeRegionId].status = 'archived';
      personalGarden.activeRegionId = null;
    }

    // 2. 建立團體花園（附上 1 位示範小圈子好友方便立即體驗多人功能，亦可讓其他人用邀請碼加入）
    const gid = `garden_group_${Math.random().toString(36).slice(2, 7)}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayKey = getGameDayKey(this.nowMs(), tz, this.config.dayBoundaryHour);
    const monthKey = todayKey.slice(0, 7);
    const rid = `reg_${monthKey}_g1`;
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    const friendUid = 'user_friend_1';
    if (!this.state.users[friendUid]) {
      this.state.users[friendUid] = {
        uid: friendUid,
        displayName: '小沐(圈友)',
        personalGardenId: 'garden_personal_f1',
        activeGardenId: gid,
        energy: 80,
        seeds: {},
        limitedSeeds: {},
        pity: 0,
        streak: { count: 5, lastDay: addDays(todayKey, -1), prevCount: 4, prevLastDay: null },
        milestones: [],
        dex: {},
        days: {}
      };
    }

    this.state.gardens[gid] = {
      id: gid,
      type: 'group',
      name: groupName || '晨光共筆花園',
      inviteCode: code,
      memberUids: [uid, friendUid],
      members: {
        [uid]: { displayName: user.displayName, streakCount: user.streak.count, lastDay: user.streak.lastDay },
        [friendUid]: { displayName: '小沐(圈友)', streakCount: 5, lastDay: addDays(todayKey, -1) }
      },
      timezone: tz,
      activeRegionId: rid,
      themeVote: null,
      days: {},
      regions: {
        [rid]: {
          id: rid,
          theme: theme || 'forest',
          month: monthKey,
          status: 'active',
          size: this.config.regionSize.group,
          expansions: 0,
          createdAt: this.nowMs(),
          plants: {},
          decor: {}
        }
      },
      essays: []
    };

    this.state.invites[code] = { gardenId: gid, createdBy: uid };
    user.activeGardenId = gid;
    this.notify();
    return { gardenId: gid, inviteCode: code };
  }

  // 透過邀請碼加入團體
  joinGroupByCode(rawCode) {
    const code = (rawCode || '').trim().toUpperCase();
    const inv = this.state.invites[code];
    if (!inv) throw new Error('找不到此邀請碼（請先建立團體或確認代碼）');

    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const groupGarden = this.state.gardens[inv.gardenId];
    if (!groupGarden) throw new Error('團體花園不存在');
    if (groupGarden.memberUids.length >= this.config.maxGroupMembers && !groupGarden.memberUids.includes(uid)) {
      throw new Error('該團體人數已滿（上限 5 人）');
    }

    const personalGarden = this.state.gardens[user.personalGardenId];
    if (personalGarden.activeRegionId && personalGarden.regions[personalGarden.activeRegionId]) {
      personalGarden.regions[personalGarden.activeRegionId].status = 'archived';
      personalGarden.activeRegionId = null;
    }

    if (!groupGarden.memberUids.includes(uid)) {
      groupGarden.memberUids.push(uid);
    }
    groupGarden.members[uid] = {
      displayName: user.displayName,
      streakCount: user.streak.count,
      lastDay: user.streak.lastDay
    };
    user.activeGardenId = groupGarden.id;
    this.notify();
    return groupGarden;
  }

  // 退出團體：保留當下共用區域唯讀快照（snapshot）到個人相簿，並開新個人主題區域（data-model.md §6.5）
  leaveGroupGarden(newPersonalTheme = 'flowerbed') {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const groupGarden = this.currentGarden();
    if (!groupGarden || groupGarden.type !== 'group') throw new Error('目前不在團體花園中');

    const personalGarden = this.state.gardens[user.personalGardenId];
    const evalActive = this.getEvaluatedRegion(groupGarden.id, groupGarden.activeRegionId);

    if (evalActive) {
      const snapId = `snap_${evalActive.region.month}_${Math.random().toString(36).slice(2, 6)}`;
      const frozenPlants = {};
      for (const p of evalActive.plantsWithState) {
        frozenPlants[p.id] = {
          ...p,
          frozen: {
            stage: p.evalState.stage,
            progress: p.evalState.progress,
            level: p.evalState.level,
            hadWilt: Boolean(p.evalState.hadWilt),
            isPerfect: Boolean(p.evalState.isPerfect)
          }
        };
        delete frozenPlants[p.id].evalState;
      }
      personalGarden.regions[snapId] = {
        ...JSON.parse(JSON.stringify(evalActive.region)),
        id: snapId,
        name: `${groupGarden.name}（快照）`,
        status: 'snapshot',
        plants: frozenPlants
      };
    }

    groupGarden.memberUids = groupGarden.memberUids.filter(id => id !== uid);
    delete groupGarden.members[uid];

    user.activeGardenId = personalGarden.id;
    const monthKey = this.currentDayKey(personalGarden).slice(0, 7);
    this.startNewMonthRegion(newPersonalTheme, monthKey, personalGarden);
    this.notify();
  }

  // 模擬圈友寫一篇公開隨筆（方便測試多人共用每日 3 顆種子上限、多人成長天數 +1 與輪播混排）
  simulateTeammateWrite() {
    const garden = this.currentGarden();
    if (!garden || garden.type !== 'group') throw new Error('請先在「團體」頁面建立或加入多人花園');
    const friendUid = garden.memberUids.find(id => id !== this.state.currentUserId) || 'user_friend_1';
    const samples = [
      '今天在回家的路上看到晚霞把整片天空染成橘粉色，心情也跟著亮了起來，決定記下這一刻。',
      '讀完了一本擱置很久的小說，裡面的結局讓人很有共鳴，我們都在慢慢長成自己喜歡的模樣。',
      '早晨沖了一杯手沖咖啡，聽著窗外的鳥鳴寫下今天的隨筆，希望我們的小島快快長出新花朵！'
    ];
    const text = samples[Math.floor(Math.random() * samples.length)];
    return this.submitEssay(text, false, friendUid);
  }

  // 取得依時間由舊到新排序的所有區域清單（供花園島左右箭頭 ◀ ▶ 切換月份檢視）
  getOrderedRegionsList() {
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    const activeGarden = this.currentGarden();
    const list = [];

    const collect = (g) => {
      if (!g) return;
      for (const r of Object.values(g.regions || {})) {
        const ev = this.getEvaluatedRegion(g.id, r.id);
        if (ev) list.push({ gardenId: g.id, gardenName: g.name, ...ev });
      }
    };

    collect(this.state.gardens[user.personalGardenId]);
    if (user.activeGardenId !== user.personalGardenId) {
      collect(activeGarden);
    }

    // 依 createdAt 由舊到新排序，且讓目前 active 區域排在最後一個（最新）
    list.sort((a, b) => {
      const aActive = a.region.id === activeGarden.activeRegionId ? 1 : 0;
      const bActive = b.region.id === activeGarden.activeRegionId ? 1 : 0;
      if (aActive !== bActive) return aActive - bActive;
      return (a.region.createdAt || 0) - (b.region.createdAt || 0);
    });
    return list;
  }

  // 取得頂部優先提示條（screens.md §2.3）
  getPriorityBanner() {
    const uid = this.state.currentUserId;
    const garden = this.currentGarden();
    if (!garden || !garden.activeRegionId) return null;

    const evalActive = this.getEvaluatedRegion(garden.id, garden.activeRegionId);

    // 1. 團體最後一天投票提醒
    if (garden.type === 'group' && garden.themeVote && !garden.themeVote.votes[uid]) {
      return {
        type: 'vote',
        text: `明天換月！點此投票選擇 ${garden.themeVote.month} 的團體主題區域`,
        action: 'open_group'
      };
    }

    // 2. 枯萎中植物搶救提醒（day_1 沒寫 -> day_2 枯萎；當天有寫隨筆即可恢復原等級，否則 day_3 死亡）
    const witheringCount = evalActive.plantsWithState.filter(p => p.evalState.stage === 'withering').length;
    if (witheringCount > 0) {
      return {
        type: 'wither_urgent',
        text: `有 ${witheringCount} 株植物正在枯萎中！今天寫隨筆即可恢復原等級，否則明天將死亡`,
        action: 'write'
      };
    }

    // 3. 昨天沒寫可補寫提醒（含連勝中斷或剛跨入第 2 缺日枯死的可救活植物）
    const makeUpInfo = this.canMakeUpYesterday();
    const rescuableDead = makeUpInfo.available
      ? evalActive.plantsWithState.filter(p => p.evalState.stage === 'dead' && this.canRescuePlantByMakeUp(garden.id, p)).length
      : 0;
    if (makeUpInfo.available && (this.hasStreakBrokenYesterday() || rescuableDead > 0)) {
      return {
        type: 'makeup',
        text: rescuableDead > 0
          ? `有 ${rescuableDead} 株植物剛枯死！今天可花 ${makeUpInfo.cost} 能量補寫昨天立即救活`
          : `昨天沒寫隨筆！可花 ${makeUpInfo.cost} 能量補寫昨天，保住連續天數與植物成長進度`,
        action: 'makeup'
      };
    }

    return null;
  }
}
