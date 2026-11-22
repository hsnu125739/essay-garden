// 隨筆花園：雲端狀態管理深模組（對外提供與 GardenStore 一致的同步查詢介面 + 非同步雲端寫入、秒開快取與樂觀更新回滾）
import {
  getGameDayKey,
  addDays,
  isLastDayOfMonth,
  countEssayWords,
  getStreakMultiplier,
  evaluatePlantState,
  calculateBeauty
} from './engine.js?v=20261122u';
import { createMemoryStorage, DEMO_ESSAY_ID, buildDemoWelcomeEssay } from './store.js?v=20261122u';
import { CloudClient, SESSION_STORAGE_KEY } from './cloud-client.js?v=20261122u';

export const CLOUD_STATE_STORAGE_KEY = 'essay_garden_state_v4';
export const CARD_STYLE_STORAGE_KEY = 'essay_garden_card_style_v1';

export class CloudGardenStore {
  constructor(
    config,
    catalog,
    {
      client = null,
      gasWebAppUrl = '',
      storage = globalThis.localStorage || createMemoryStorage(),
      fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
      onAuthInvalid = null,
      onStateChange = null
    } = {}
  ) {
    this.isCloud = true;
    this.config = config;
    this.catalog = catalog;
    this.storage = storage;
    this.onStateChange = onStateChange;
    this.subscribers = new Set();
    this.speciesMap = Object.fromEntries(catalog.species.map((s) => [s.id, s]));
    this.decorMap = Object.fromEntries(catalog.decor.map((d) => [d.id, d]));
    this.bgThemeMap = Object.fromEntries((catalog.bgThemes || []).map((b) => [b.id, b]));
    this.serverTimeOffsetMs = 0;
    this.pendingGroupTransitionToast = null;

    this.client =
      client ||
      new CloudClient({
        gasWebAppUrl,
        storage,
        fetchImpl,
        onAuthInvalid: (err) => {
          if (typeof onAuthInvalid === 'function') onAuthInvalid(err);
        },
        onServerTime: (serverTimeMs) => {
          this.updateServerTime(serverTimeMs);
        }
      });

    if (client) {
      if (!client.onServerTime) {
        client.onServerTime = (serverTimeMs) => this.updateServerTime(serverTimeMs);
      }
      if (onAuthInvalid && !client.onAuthInvalid) {
        client.onAuthInvalid = onAuthInvalid;
      }
    }

    const cached = this._loadCachedState();
    if (cached) {
      this.state = cached;
      this.hasHydratedCache = true;
    } else {
      this.state = this._createPlaceholderState();
      this.hasHydratedCache = false;
    }
  }

  updateServerTime(serverTimeMs) {
    if (typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs)) {
      this.serverTimeOffsetMs = serverTimeMs - Date.now();
    }
  }

  isAuthenticated() {
    return this.client.hasSession();
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
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
    for (const fn of this.subscribers) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('CloudGardenStore subscriber error:', err);
      }
    }
  }

  nowMs() {
    return Date.now() + (this.serverTimeOffsetMs || 0);
  }

  currentUser() {
    return this.state.users[this.state.currentUserId];
  }

  currentGarden() {
    const user = this.currentUser();
    return this.state.gardens[user.activeGardenId];
  }

  currentDayKey(garden = this.currentGarden()) {
    const user = this.currentUser();
    const tz = garden?.timezone || user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
    return getGameDayKey(this.nowMs(), tz, this.config.dayBoundaryHour);
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

  getMemberDisplayName(uid) {
    if (!uid) return '旅人';
    if (this.state.memberDirectory && this.state.memberDirectory[uid]) {
      return this.state.memberDirectory[uid];
    }
    const garden = this.currentGarden();
    if (garden?.members?.[uid]?.displayName) {
      return garden.members[uid].displayName;
    }
    if (this.state.users?.[uid]?.displayName) {
      return this.state.users[uid].displayName;
    }
    return '旅人';
  }

  _loadCachedState() {
    if (!this.storage) return null;
    const raw = this.storage.getItem(CLOUD_STATE_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.cloudCacheVersion === 1 &&
        parsed.currentUserId &&
        parsed.users &&
        parsed.users[parsed.currentUserId] &&
        parsed.gardens
      ) {
        return parsed;
      }
    } catch (_err) {
      // ignore invalid cache and fall back to placeholder
    }
    return null;
  }

  saveState() {
    if (!this.storage || !this.state || this.state.isPlaceholder) return;
    this.storage.setItem(CLOUD_STATE_STORAGE_KEY, JSON.stringify(this.state));
  }

  _createPlaceholderState() {
    const uid = 'guest';
    const gid = 'garden_personal_guest';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
    const todayKey = getGameDayKey(this.nowMs(), tz, this.config.dayBoundaryHour);
    const monthKey = todayKey.slice(0, 7);
    const rid = `reg_${monthKey}_placeholder`;

    return {
      cloudCacheVersion: 1,
      isPlaceholder: true,
      currentUserId: uid,
      memberDirectory: { [uid]: '旅人' },
      hasMoreEssayHistory: false,
      loadedEssayMonths: { [monthKey]: true },
      users: {
        [uid]: {
          uid,
          displayName: '旅人',
          timezone: tz,
          personalGardenId: gid,
          activeGardenId: gid,
          activeGroupId: '',
          energy: 65,
          seeds: {},
          limitedSeeds: {},
          pity: 0,
          streak: { count: 0, lastDay: null, prevCount: 0, prevLastDay: null },
          milestones: [],
          dex: {},
          lastCardStyle: 'card1',
          makeupDays: [],
          days: {}
        }
      },
      gardens: {
        [gid]: {
          id: gid,
          type: 'personal',
          name: '我的隨筆花園',
          memberUids: [uid],
          formerMemberUids: [],
          members: {
            [uid]: { displayName: '旅人', streakCount: 0, lastDay: null }
          },
          timezone: tz,
          activeRegionId: rid,
          themeVote: null,
          days: {},
          regions: {
            [rid]: {
              id: rid,
              theme: 'flowerbed',
              month: monthKey,
              status: 'active',
              name: '',
              size: this.config.regionSize.personal,
              expansions: 0,
              createdAt: this.nowMs(),
              plants: {},
              decor: {}
            }
          },
          essays: []
        }
      }
    };
  }

  _dexToMap(dexInput) {
    if (!dexInput) return {};
    if (Array.isArray(dexInput)) {
      return Object.fromEntries(dexInput.map((id) => [id, true]));
    }
    if (typeof dexInput === 'object') {
      return { ...dexInput };
    }
    return {};
  }

  _normalizeEssay(rawEssay, memberDirectory) {
    const authorUid = rawEssay.authorUid;
    return {
      ...rawEssay,
      regionId: rawEssay.regionId || rawEssay.gardenId || '',
      gardenId: rawEssay.gardenId || rawEssay.regionId || '',
      authorName: rawEssay.authorName || (memberDirectory && memberDirectory[authorUid]) || '旅人',
      private: Boolean(rawEssay.private),
      reactions: rawEssay.reactions && typeof rawEssay.reactions === 'object' ? { ...rawEssay.reactions } : {}
    };
  }

  _projectGardenRowToRegion(g) {
    const items = g.items || {};
    return {
      id: g.gardenId,
      theme: g.theme || 'flowerbed',
      month: g.month,
      status: g.status || 'active',
      name: g.snapshotName || g.name || '',
      size: Number(g.size || this.config.regionSize[g.ownerType] || 5),
      expansions: Number(g.expansions || 0),
      createdAt: Number(g.createdAt || 0),
      plants: JSON.parse(JSON.stringify(items.plants || {})),
      decor: JSON.parse(JSON.stringify(items.decor || {}))
    };
  }

  _buildMembersMap(userDto, memberDirectory, groupMemberSummaries) {
    const members = {};
    for (const [mUid, dName] of Object.entries(memberDirectory || {})) {
      members[mUid] = {
        displayName: dName || '旅人',
        streakCount: 0,
        lastDay: null
      };
    }
    for (const s of groupMemberSummaries || []) {
      if (!s || !s.uid) continue;
      members[s.uid] = {
        displayName: s.displayName || members[s.uid]?.displayName || '旅人',
        streakCount: Number(s.streakCount || 0),
        lastDay: s.streakLastDay || null
      };
    }
    if (userDto && userDto.uid) {
      members[userDto.uid] = {
        displayName: userDto.displayName || '旅人',
        streakCount: Number(userDto.streak?.count || 0),
        lastDay: userDto.streak?.lastDay || null
      };
    }
    return members;
  }

  _applyBootstrapPayload(data) {
    const userDto = data.user;
    const groupDto = data.group || null;
    const uid = userDto.uid;
    const personalGid = `garden_personal_${uid}`;
    const tz = userDto.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
    const memberDirectory = { ...(data.memberDirectory || {}), [uid]: userDto.displayName || '旅人' };
    const membersMap = this._buildMembersMap(userDto, memberDirectory, data.groupMemberSummaries);

    const personalRegions = {};
    const groupRegions = {};
    let activePersonalRid = null;
    let latestPersonalRid = null;
    let latestPersonalCreatedAt = -1;
    let activeGroupRid = null;
    let latestGroupRid = null;
    let latestGroupCreatedAt = -1;

    for (const g of data.gardens || []) {
      const reg = this._projectGardenRowToRegion(g);
      if (g.ownerType === 'personal') {
        personalRegions[reg.id] = reg;
        if (reg.status === 'active') {
          activePersonalRid = reg.id;
        }
        if (reg.status !== 'snapshot' && reg.createdAt >= latestPersonalCreatedAt) {
          latestPersonalCreatedAt = reg.createdAt;
          latestPersonalRid = reg.id;
        }
      } else if (g.ownerType === 'group' && groupDto && g.ownerId === groupDto.groupId) {
        groupRegions[reg.id] = reg;
        if (reg.status === 'active') {
          activeGroupRid = reg.id;
        }
        if (reg.createdAt >= latestGroupCreatedAt) {
          latestGroupCreatedAt = reg.createdAt;
          latestGroupRid = reg.id;
        }
      }
    }

    if (!activePersonalRid && latestPersonalRid) {
      activePersonalRid = latestPersonalRid;
    }
    if (!activePersonalRid) {
      const todayKey = getGameDayKey(this.nowMs(), tz, this.config.dayBoundaryHour);
      const monthKey = todayKey.slice(0, 7);
      const fallbackId = `g_fallback_${uid}_${monthKey}`;
      personalRegions[fallbackId] = {
        id: fallbackId,
        theme: 'flowerbed',
        month: monthKey,
        status: 'archived',
        name: '',
        size: this.config.regionSize.personal,
        expansions: 0,
        createdAt: 0,
        plants: {},
        decor: {}
      };
      activePersonalRid = fallbackId;
    }

    const normalizedEssays = (data.essays || []).map((e) => this._normalizeEssay(e, memberDirectory));
    const personalEssays = [];
    const groupEssays = [];
    const loadedEssayMonths = { ...(this.state?.loadedEssayMonths || {}) };
    const activeTz = (groupDto && groupDto.timezone) || tz;
    const bootTodayKey = getGameDayKey(this.nowMs(), activeTz, this.config.dayBoundaryHour);
    let [by, bm] = bootTodayKey.slice(0, 7).split('-').map(Number);
    const monthsCount = Math.min(60, Math.max(1, Number(data._essayMonthsLimit) || 2));
    for (let i = 0; i < monthsCount; i++) {
      loadedEssayMonths[`${by}-${String(bm).padStart(2, '0')}`] = true;
      bm -= 1;
      if (bm < 1) {
        bm = 12;
        by -= 1;
      }
    }

    for (const e of normalizedEssays) {
      if (e.dayKey && e.dayKey.length >= 7) {
        loadedEssayMonths[e.dayKey.slice(0, 7)] = true;
      }
      if (groupDto && e.groupId === groupDto.groupId) {
        groupEssays.push(e);
      } else {
        personalEssays.push(e);
      }
    }

    const userDays = JSON.parse(JSON.stringify(data.userDays || {}));
    const groupDays = JSON.parse(JSON.stringify(data.groupDays || {}));

    const gardensMap = {
      [personalGid]: {
        id: personalGid,
        type: 'personal',
        name: '我的隨筆花園',
        memberUids: [uid],
        formerMemberUids: [],
        members: { ...membersMap },
        timezone: tz,
        activeRegionId: activePersonalRid,
        themeVote: null,
        days: userDays,
        regions: personalRegions,
        essays: personalEssays
      }
    };

    let activeGardenId = personalGid;
    if (groupDto && userDto.activeGroupId === groupDto.groupId) {
      const grpId = groupDto.groupId;
      activeGardenId = grpId;
      const resolvedGroupRid = activeGroupRid || latestGroupRid;
      gardensMap[grpId] = {
        id: grpId,
        type: 'group',
        name: groupDto.name || '晨光共筆花園',
        ownerUid: groupDto.ownerUid,
        status: groupDto.status || 'active',
        inviteCode: groupDto.inviteCode || '',
        memberUids: [...(groupDto.memberUids || [uid])],
        formerMemberUids: [...(groupDto.formerMemberUids || [])],
        members: { ...membersMap },
        timezone: groupDto.timezone || tz,
        activeRegionId: resolvedGroupRid,
        themeVote: groupDto.themeVoteMonth
          ? { month: groupDto.themeVoteMonth, votes: { ...(groupDto.themeVotes || {}) } }
          : null,
        days: groupDays,
        regions: groupRegions,
        essays: groupEssays
      };
    }

    const prevState = this.state && !this.state.isPlaceholder ? this.state : null;
    if (prevState && groupDto && activeGardenId === groupDto.groupId) {
      const prevGrp = prevState.gardens?.[groupDto.groupId];
      const curGrp = gardensMap[groupDto.groupId];
      const prevReg = prevGrp?.regions?.[prevGrp.activeRegionId];
      const curReg = curGrp?.regions?.[curGrp.activeRegionId];
      if (prevReg && curReg && prevReg.month && curReg.month && prevReg.month !== curReg.month) {
        this.pendingGroupTransitionToast = {
          autoResolvedGroupTheme: curReg.theme,
          month: curReg.month
        };
      }
    }

    if (userDto.lastCardStyle && this.storage) {
      this.storage.setItem(CARD_STYLE_STORAGE_KEY, userDto.lastCardStyle);
    }

    this.state = {
      cloudCacheVersion: 1,
      isPlaceholder: false,
      currentUserId: uid,
      memberDirectory,
      groupMemberSummaries: data.groupMemberSummaries || [],
      hasMoreEssayHistory: Boolean(data.hasMoreEssayHistory),
      loadedEssayMonths,
      users: {
        [uid]: {
          uid,
          displayName: userDto.displayName || '旅人',
          timezone: tz,
          personalGardenId: personalGid,
          activeGardenId,
          activeGroupId: userDto.activeGroupId || '',
          energy: Number(userDto.energy || 0),
          seeds: { ...(userDto.seeds || {}) },
          limitedSeeds: { ...(userDto.limitedSeeds || {}) },
          pity: Number(userDto.pity || 0),
          streak: {
            count: Number(userDto.streak?.count || 0),
            lastDay: userDto.streak?.lastDay || null,
            prevCount: Number(userDto.streak?.prevCount || 0),
            prevLastDay: userDto.streak?.prevLastDay || null
          },
          milestones: [...(userDto.milestones || [])],
          dex: this._dexToMap(userDto.dex),
          lastCardStyle: userDto.lastCardStyle || 'card1',
          makeupDays: [...(userDto.makeupDays || [])],
          days: userDays
        }
      },
      gardens: gardensMap
    };

    this.hasHydratedCache = true;
    this._recomputePersonalSeedsGiven();
    this.notify();
    return this.state;
  }

  // 個人每日種子額度：伺服器 userDays 不含 seedsGiven，改由個人隨筆 reward 推算，供 app.js 讀取 garden.days[今日].seedsGiven
  _recomputePersonalSeedsGiven() {
    const user = this.currentUser();
    const personal = this.state.gardens[user.personalGardenId];
    if (!personal) return;
    personal.days = user.days;
    const counts = {};
    for (const e of personal.essays || []) {
      if (!e.groupId && e.authorUid === user.uid && e.reward && e.reward.type === 'seed') {
        counts[e.dayKey] = (counts[e.dayKey] || 0) + 1;
      }
    }
    for (const dk of Object.keys(user.days || {})) {
      user.days[dk].seedsGiven = counts[dk] || 0;
    }
    for (const [dk, n] of Object.entries(counts)) {
      if (!user.days[dk]) user.days[dk] = { essays: 0, words: 0, lastEssayAt: 0, madeUp: false, seedsGiven: n };
    }
  }

  _updateUserFromDto(userDto) {
    if (!userDto) return;
    const uid = this.state.currentUserId;
    const user = this.state.users[uid];
    if (!user) return;
    user.displayName = userDto.displayName ?? user.displayName;
    user.timezone = userDto.timezone ?? user.timezone;
    user.activeGroupId = userDto.activeGroupId ?? user.activeGroupId;
    user.energy = Number(userDto.energy ?? user.energy);
    user.pity = Number(userDto.pity ?? user.pity);
    if (userDto.seeds) user.seeds = { ...userDto.seeds };
    if (userDto.limitedSeeds) user.limitedSeeds = { ...userDto.limitedSeeds };
    if (userDto.streak) {
      user.streak = {
        count: Number(userDto.streak.count || 0),
        lastDay: userDto.streak.lastDay || null,
        prevCount: Number(userDto.streak.prevCount || 0),
        prevLastDay: userDto.streak.prevLastDay || null
      };
    }
    if (userDto.milestones) user.milestones = [...userDto.milestones];
    if (userDto.dex) user.dex = this._dexToMap(userDto.dex);
    if (userDto.lastCardStyle) {
      user.lastCardStyle = userDto.lastCardStyle;
      if (this.storage) this.storage.setItem(CARD_STYLE_STORAGE_KEY, userDto.lastCardStyle);
    }
    if (userDto.makeupDays) user.makeupDays = [...userDto.makeupDays];

    this.state.memberDirectory[uid] = user.displayName;
    for (const g of Object.values(this.state.gardens)) {
      if (g.members && g.members[uid]) {
        g.members[uid].displayName = user.displayName;
        g.members[uid].streakCount = user.streak.count;
        g.members[uid].lastDay = user.streak.lastDay;
      }
    }
  }

  _resolveRegionTarget(gardenId, regionId) {
    const directContainer = this.state.gardens[gardenId];
    if (directContainer && regionId && directContainer.regions?.[regionId]) {
      return { garden: directContainer, region: directContainer.regions[regionId] };
    }
    const targetRid = regionId || gardenId;
    for (const g of Object.values(this.state.gardens)) {
      if (g.regions && g.regions[targetRid]) {
        return { garden: g, region: g.regions[targetRid] };
      }
    }
    const activeG = this.currentGarden();
    const activeR = activeG?.regions?.[activeG.activeRegionId];
    return { garden: activeG, region: activeR };
  }

  _findEssayById(essayId) {
    for (const g of Object.values(this.state.gardens)) {
      const found = (g.essays || []).find((e) => e.id === essayId);
      if (found) return { garden: g, essay: found };
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // 唯讀同步方法（與 GardenStore 100% 相容）
  // --------------------------------------------------------------------------
  getEvaluatedRegion(gardenId, regionId) {
    const { garden, region } = this._resolveRegionTarget(gardenId, regionId);
    if (!garden || !region) return null;

    const user = this.currentUser();
    const todayKey = this.currentDayKey(garden);
    const daysSource = garden.type === 'personal' ? user.days : garden.days;

    const plantsWithState = Object.values(region.plants || {}).map((p) => {
      const evalState =
        region.status === 'snapshot' && p.frozen
          ? { ...p.frozen, miss: 0, finalStage: null }
          : evaluatePlantState(p, daysSource, todayKey, garden.type);
      return { ...p, evalState };
    });

    const decorList = Object.values(region.decor || {});
    const beauty = calculateBeauty(plantsWithState, decorList, this.catalog, this.config);

    return { region, plantsWithState, decorList, beauty, todayKey };
  }

  checkMonthTransition() {
    if (this.state.isPlaceholder) return null;
    if (this.pendingGroupTransitionToast) {
      const toastInfo = this.pendingGroupTransitionToast;
      this.pendingGroupTransitionToast = null;
      return toastInfo;
    }

    const garden = this.currentGarden();
    if (!garden) return null;

    const todayKey = this.currentDayKey(garden);
    if (garden.type === 'group') {
      if (isLastDayOfMonth(todayKey)) {
        const nextMonth = addDays(todayKey, 1).slice(0, 7);
        if (!garden.themeVote || garden.themeVote.month !== nextMonth) {
          garden.themeVote = { month: nextMonth, votes: {} };
          this.saveState();
        }
      }
      return null;
    }

    const currentMonth = todayKey.slice(0, 7);
    const activeRegion = garden.regions[garden.activeRegionId];

    if (!activeRegion || activeRegion.status !== 'active' || activeRegion.month !== currentMonth) {
      return { needsPersonalThemePick: true, month: currentMonth };
    }
    return null;
  }

  getCarouselEssays() {
    const uid = this.state.currentUserId;
    const activeGid = this.currentUser()?.activeGardenId;
    const merged = new Map();

    for (const g of Object.values(this.state.gardens)) {
      for (const e of g.essays || []) {
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
      const garden = this.currentGarden();
      const todayKey = this.currentDayKey(garden);
      const user = this.currentUser();
      const demoEssay = buildDemoWelcomeEssay(uid, user?.displayName, todayKey, garden?.activeRegionId);
      merged.set(demoEssay.id, demoEssay);
    }

    return Array.from(merged.values()).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  canMakeUpYesterday() {
    const user = this.currentUser();
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
    const garden = this.state.gardens[gardenId] || this.currentGarden();
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

  isCellOccupied(region, x, y, ignoreItemId = null) {
    const nx = Number(x);
    const ny = Number(y);
    const hasPlant = Object.values(region.plants || {}).some(
      (p) => p.id !== ignoreItemId && Number(p.x) === nx && Number(p.y) === ny
    );
    const hasDecor = Object.values(region.decor || {}).some(
      (d) => d.id !== ignoreItemId && Number(d.x) === nx && Number(d.y) === ny
    );
    return hasPlant || hasDecor;
  }

  getOrderedRegionsList() {
    const user = this.currentUser();
    const activeGarden = this.currentGarden();
    const list = [];

    const collect = (g) => {
      if (!g) return;
      for (const r of Object.values(g.regions || {})) {
        const ev = this.getEvaluatedRegion(g.id, r.id);
        if (ev) list.push({ gardenId: g.id, gardenName: r.name || g.name, ...ev });
      }
    };

    collect(this.state.gardens[user.personalGardenId]);
    if (user.activeGardenId !== user.personalGardenId) {
      collect(activeGarden);
    }

    list.sort((a, b) => {
      const aActive = a.region.id === activeGarden.activeRegionId && a.region.status === 'active' ? 1 : 0;
      const bActive = b.region.id === activeGarden.activeRegionId && b.region.status === 'active' ? 1 : 0;
      if (aActive !== bActive) return aActive - bActive;
      return (a.region.createdAt || 0) - (b.region.createdAt || 0);
    });
    return list;
  }

  getPriorityBanner() {
    if (this.state.isPlaceholder) return null;
    const uid = this.state.currentUserId;
    const garden = this.currentGarden();
    if (!garden || !garden.activeRegionId) return null;

    const evalActive = this.getEvaluatedRegion(garden.id, garden.activeRegionId);
    if (!evalActive) return null;

    if (garden.type === 'group' && garden.themeVote && !garden.themeVote.votes[uid]) {
      return {
        type: 'vote',
        text: `明天換月！點此投票選擇 ${garden.themeVote.month} 的團體主題區域`,
        action: 'open_group'
      };
    }

    const witheringCount = evalActive.plantsWithState.filter((p) => p.evalState.stage === 'withering').length;
    if (witheringCount > 0) {
      return {
        type: 'wither_urgent',
        text: `有 ${witheringCount} 株植物正在枯萎中！今天寫隨筆即可恢復原等級，否則明天將死亡`,
        action: 'write'
      };
    }

    const makeUpInfo = this.canMakeUpYesterday();
    const rescuableDead = makeUpInfo.available
      ? evalActive.plantsWithState.filter((p) => p.evalState.stage === 'dead' && this.canRescuePlantByMakeUp(garden.id, p)).length
      : 0;
    if (makeUpInfo.available && (this.hasStreakBrokenYesterday() || rescuableDead > 0)) {
      return {
        type: 'makeup',
        text:
          rescuableDead > 0
            ? `有 ${rescuableDead} 株植物剛枯死！今天可花 ${makeUpInfo.cost} 能量補寫昨天立即救活`
            : `昨天沒寫隨筆！可花 ${makeUpInfo.cost} 能量補寫昨天，保住連續天數與植物成長進度`,
        action: 'makeup'
      };
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // 非同步雲端連線、認證與狀態變更方法
  // --------------------------------------------------------------------------
  async ping() {
    return this.client.ping();
  }

  async authenticate(username, password, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei') {
    const res = await this.client.request(
      'auth',
      { username, password, timezone },
      { authToken: '' }
    );
    this.client.setSessionToken(res.sessionToken);
    this._applyBootstrapPayload(res.bootstrap);
    return res;
  }

  async syncBootstrap({ essayMonthsLimit = 2 } = {}) {
    const data = await this.client.request('bootstrap', { essayMonthsLimit });
    return this._applyBootstrapPayload({ ...data, _essayMonthsLimit: essayMonthsLimit });
  }

  async initSession({ essayMonthsLimit = 2 } = {}) {
    if (!this.client.hasSession()) {
      return { authenticated: false, state: this.state };
    }
    const state = await this.syncBootstrap({ essayMonthsLimit });
    return { authenticated: true, state };
  }

  async logout() {
    try {
      if (this.client.hasSession()) {
        await this.client.request('logout', {});
      }
    } catch (_err) {
      // 即使遠端 token 已失效，仍強制清除本機 Session 與快取
    } finally {
      this.client.clearSessionToken();
      if (this.storage) {
        this.storage.removeItem(CLOUD_STATE_STORAGE_KEY);
      }
      this.state = this._createPlaceholderState();
      this.hasHydratedCache = false;
      if (typeof this.onStateChange === 'function') {
        this.onStateChange(this.state);
      }
    }
    return { loggedOut: true };
  }

  async ensureEssayMonthLoaded(month) {
    const ym = String(month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      throw new Error('月份格式須為 YYYY-MM');
    }
    if (this.state.loadedEssayMonths && this.state.loadedEssayMonths[ym]) {
      return this.getCarouselEssays().filter((e) => (e.dayKey || '').slice(0, 7) === ym);
    }

    const res = await this.client.request('getEssaysByMonth', { month: ym });
    if (res.memberDirectory) {
      Object.assign(this.state.memberDirectory, res.memberDirectory);
      for (const g of Object.values(this.state.gardens)) {
        for (const [mUid, dName] of Object.entries(res.memberDirectory)) {
          if (!g.members[mUid]) {
            g.members[mUid] = { displayName: dName || '旅人', streakCount: 0, lastDay: null };
          } else {
            g.members[mUid].displayName = dName || g.members[mUid].displayName;
          }
        }
      }
    }

    const user = this.currentUser();
    const personalGarden = this.state.gardens[user.personalGardenId];
    const activeGarden = this.currentGarden();

    for (const raw of res.essays || []) {
      const norm = this._normalizeEssay(raw, this.state.memberDirectory);
      const targetGarden =
        activeGarden.type === 'group' && norm.groupId === activeGarden.id ? activeGarden : personalGarden;
      if (!targetGarden.essays.some((x) => x.id === norm.id)) {
        targetGarden.essays.push(norm);
      }
    }

    this.state.loadedEssayMonths[ym] = true;
    this._recomputePersonalSeedsGiven();
    this.notify();
    return this.getCarouselEssays().filter((e) => (e.dayKey || '').slice(0, 7) === ym);
  }

  async updateDisplayName(name) {
    const trimmed = String(name || '').trim();
    const res = await this.client.request('updateDisplayName', { displayName: trimmed });
    const uid = this.state.currentUserId;
    const user = this.currentUser();
    user.displayName = res.displayName;
    this.state.memberDirectory[uid] = res.displayName;
    for (const g of Object.values(this.state.gardens)) {
      if (g.members && g.members[uid]) {
        g.members[uid].displayName = res.displayName;
      }
      for (const e of g.essays || []) {
        if (e.authorUid === uid) {
          e.authorName = res.displayName;
        }
      }
    }
    this.notify();
    return res.displayName;
  }

  async submitEssay(content, isPrivate = undefined, _writerUid = this.state.currentUserId, cardStyle = null) {
    const garden = this.currentGarden();
    const resolvedPrivate = isPrivate === undefined ? garden.type !== 'group' : Boolean(isPrivate);
    const res = await this.client.request('submitEssay', {
      content,
      isPrivate: resolvedPrivate,
      cardStyle
    });

    this._updateUserFromDto(res.user);
    const user = this.currentUser();
    const essay = this._normalizeEssay(res.essay, this.state.memberDirectory);
    const dayKey = essay.dayKey;

    user.days[dayKey] = { ...res.userDaysDay };
    garden.essays = [essay, ...(garden.essays || []).filter((x) => x.id !== essay.id)];
    this._recomputePersonalSeedsGiven();
    if (garden.type === 'group' && res.groupDaysDay) {
      garden.days[dayKey] = {
        ...res.groupDaysDay,
        writers: { ...(res.groupDaysDay.writers || {}) }
      };
    }

    garden.essays = [essay, ...(garden.essays || []).filter((x) => x.id !== essay.id)];
    this.state.loadedEssayMonths[dayKey.slice(0, 7)] = true;
    this.notify();
    return { essay, result: res.result };
  }

  async updateEssayContent(essayId, newContent, isPrivate, cardStyle, dayKey = null, authorUid = null) {
    const found = this._findEssayById(essayId);
    const resolvedDayKey = dayKey || found?.essay?.dayKey || this.currentDayKey();
    const resolvedAuthorUid = authorUid || found?.essay?.authorUid || this.state.currentUserId;

    const res = await this.client.request('updateEssay', {
      essayId,
      dayKey: resolvedDayKey,
      authorUid: resolvedAuthorUid,
      content: newContent,
      isPrivate,
      cardStyle
    });

    const updated = this._normalizeEssay(res.essay, this.state.memberDirectory);
    const user = this.currentUser();
    if (found) {
      Object.assign(found.essay, updated);
    }
    user.days[updated.dayKey] = { ...res.userDaysDay };
    this._recomputePersonalSeedsGiven();
    if (cardStyle && typeof cardStyle === 'string' && cardStyle.trim()) {
      user.lastCardStyle = cardStyle.trim();
      if (this.storage) this.storage.setItem(CARD_STYLE_STORAGE_KEY, user.lastCardStyle);
    }
    this.notify();
    return found ? found.essay : updated;
  }

  // 樂觀更新反應（0ms 更新畫面，若伺服器拒絕則自動回滾並拋出錯誤供 UI 顯示 Toast）
  async setEssayReaction(essayId, reactionId, actorUid = this.state.currentUserId, dayKey = null, authorUid = null) {
    const found = this._findEssayById(essayId);
    if (!found) {
      throw new Error('找不到該篇隨筆');
    }
    const target = found.essay;
    const resolvedDayKey = dayKey || target.dayKey;
    const resolvedAuthorUid = authorUid || target.authorUid;

    const prevReactions = target.reactions ? { ...target.reactions } : {};
    const nextReactions = { ...prevReactions };
    if (!reactionId) {
      delete nextReactions[actorUid];
    } else {
      nextReactions[actorUid] = reactionId;
    }

    target.reactions = nextReactions;
    this.notify();

    try {
      const res = await this.client.request('setReaction', {
        essayId,
        dayKey: resolvedDayKey,
        authorUid: resolvedAuthorUid,
        reactionId: reactionId || null
      });
      target.reactions = res.reactions ? { ...res.reactions } : {};
      this.notify();
      return target.reactions[actorUid] || null;
    } catch (err) {
      target.reactions = prevReactions;
      this.notify();
      throw err;
    }
  }

  async makeUpYesterday() {
    const res = await this.client.request('makeUpYesterday', {});
    this._updateUserFromDto(res.user);
    const user = this.currentUser();
    const garden = this.currentGarden();
    const yKey = res.yesterdayKey;

    if (!user.days[yKey]) {
      user.days[yKey] = { essays: 0, words: 0, lastEssayAt: 0, madeUp: true };
    } else {
      user.days[yKey].madeUp = true;
    }

    if (garden.type === 'group') {
      if (!garden.days[yKey]) {
        garden.days[yKey] = { seedsGiven: 0, writers: {}, madeUp: true };
      } else {
        garden.days[yKey].madeUp = true;
      }
    }

    this.notify();
    return res.streak;
  }

  async plantSeed(speciesId, x, y, isLimited = false) {
    const garden = this.currentGarden();
    const region = garden.regions[garden.activeRegionId];
    const res = await this.client.request('plantSeed', {
      gardenId: region.id,
      speciesId,
      x: Number(x),
      y: Number(y),
      isLimited: Boolean(isLimited)
    });

    this._updateUserFromDto(res.user);
    region.plants[res.plant.id] = { ...res.plant };
    this.notify();
    return region.plants[res.plant.id];
  }

  async clearDeadPlant(gardenId, regionId, plantId) {
    const { region } = this._resolveRegionTarget(gardenId, regionId);
    const res = await this.client.request('clearDeadPlant', {
      gardenId: region.id,
      plantId
    });
    this.currentUser().energy = Number(res.energy);
    delete region.plants[plantId];
    this.notify();
  }

  async buyAndPlaceDecor(gardenId, regionId, itemId, x, y) {
    const { region } = this._resolveRegionTarget(gardenId, regionId);
    const res = await this.client.request('buyAndPlaceDecor', {
      gardenId: region.id,
      itemId,
      x: Number(x),
      y: Number(y)
    });
    this.currentUser().energy = Number(res.energy);
    region.decor[res.decor.id] = { ...res.decor };
    this.notify();
    return region.decor[res.decor.id];
  }

  async removeDecor(gardenId, regionId, decorId) {
    const { region } = this._resolveRegionTarget(gardenId, regionId);
    await this.client.request('removeDecor', {
      gardenId: region.id,
      decorId
    });
    delete region.decor[decorId];
    this.notify();
  }

  async moveGridItem(gardenId, regionId, kind, itemId, newX, newY) {
    const { region } = this._resolveRegionTarget(gardenId, regionId);
    const res = await this.client.request('moveGridItem', {
      gardenId: region.id,
      kind,
      itemId,
      newX: Number(newX),
      newY: Number(newY)
    });
    const bucket = kind === 'plant' ? region.plants : region.decor;
    if (bucket && bucket[itemId]) {
      bucket[itemId].x = Number(res.x);
      bucket[itemId].y = Number(res.y);
    }
    this.notify();
  }

  async decomposeSeed(speciesId, count = 1) {
    const user = this.currentUser();
    const prevEnergy = Number(user.energy || 0);
    const res = await this.client.request('decomposeSeed', {
      speciesId,
      count: Number(count)
    });
    user.energy = Number(res.energy);
    user.seeds = { ...(res.seeds || {}) };
    this.notify();
    return user.energy - prevEnergy;
  }

  async expandActiveRegion() {
    const garden = this.currentGarden();
    const region = garden.regions[garden.activeRegionId];
    const res = await this.client.request('expandGarden', {
      gardenId: region.id
    });
    this.currentUser().energy = Number(res.energy);
    region.size = Number(res.garden.size);
    region.expansions = Number(res.garden.expansions);
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
    this._persistLocalCache();
    this.notify();
    return true;
  }

  // 商店花費能量購買解鎖背景（若無指定 cost 則自動自 catalog SSOT 查詢）
  async buyBgTheme(themeId, cost) {
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
    this._persistLocalCache();
    this.notify();
    return { success: true, alreadyOwned: false };
  }

  async createGroupGarden(groupName, theme) {
    const res = await this.client.request('createGroup', {
      name: groupName,
      theme
    });
    await this.syncBootstrap();
    return {
      gardenId: res.group.groupId,
      inviteCode: res.group.inviteCode
    };
  }

  async joinGroupByCode(rawCode) {
    await this.client.request('joinGroup', {
      inviteCode: rawCode
    });
    await this.syncBootstrap();
    return this.currentGarden();
  }

  async leaveGroupGarden(newPersonalTheme = 'flowerbed') {
    await this.client.request('leaveGroup', {
      newPersonalTheme
    });
    await this.syncBootstrap();
  }

  async castGroupThemeVote(theme) {
    const garden = this.currentGarden();
    if (!garden || garden.type !== 'group') return;
    const res = await this.client.request('castThemeVote', {
      groupId: garden.id,
      theme
    });
    garden.themeVote = {
      month: res.themeVoteMonth,
      votes: { ...(res.themeVotes || {}) }
    };
    this.notify();
  }

  async startNewMonthRegion(theme) {
    const res = await this.client.request('startNewMonthGarden', {
      theme
    });
    const user = this.currentUser();
    const personalGarden = this.state.gardens[user.personalGardenId];
    for (const r of Object.values(personalGarden.regions)) {
      if (r.status === 'active') r.status = 'archived';
    }
    const newReg = this._projectGardenRowToRegion(res.garden);
    personalGarden.regions[newReg.id] = newReg;
    personalGarden.activeRegionId = newReg.id;
    this.notify();
    return newReg.id;
  }
}
