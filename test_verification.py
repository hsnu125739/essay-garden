import functools
import http.server
import json
import mimetypes
import os
import re
import subprocess
import threading
from playwright._impl._driver import compute_driver_executable
from playwright.sync_api import sync_playwright

ROOT_DIR = r"d:\Antigravity workspaces\交通美地"
ASSET_VER = "20261126a"


def load_text(name):
    with open(os.path.join(ROOT_DIR, name), encoding="utf-8") as f:
        return f.read()


cfg = json.loads(load_text("game-config.json"))
cat = json.loads(load_text("catalog.json"))
app_js = load_text("app.js")
store_js = load_text("store.js")
cloud_store_js = load_text("cloud-store.js")
engine_js = load_text("engine.js")
bg_manager_js = load_text("bg-manager.js")
bg_themes_js = load_text("bg-themes.js")
gas_code_gs = load_text(os.path.join("gas", "Code.gs"))
index_html = load_text("index.html")


# ============================================================================
# 1. 靜態資料契約、架構封裝、版本同步與美術素材完整性驗證
# ============================================================================
species = cat["species"]
assert len(species) == 46, f"Expected 46 species, got {len(species)}"
for s in species:
    assert "scaleFactor" not in s, f"Unexpected legacy scaleFactor on {s['id']}"
for d in cat["decor"]:
    assert "scaleFactor" not in d, f"Unexpected legacy scaleFactor on {d['id']}"

assert "scaleFactor" not in app_js and "defaultScaleBySize" not in app_js, "app.js must not reference legacy scaleFactor/defaultScaleBySize"
assert "STANDARD_SPRITE_W" not in app_js and "config.spriteScale" in app_js, "app.js must read spriteScale from game-config.json"
assert isinstance(cfg["homeEssayLimit"], int) and cfg["homeEssayLimit"] > 0, "game-config.json must define positive homeEssayLimit"
assert "HOME_ESSAY_LIMIT" not in app_js and "config.homeEssayLimit" in app_js, "app.js must read homeEssayLimit from config"
assert "|| 100" not in engine_js and "200 /" not in engine_js, "engine.js must use dynamic maxTotalWidth without hardcoded 100/200"

# 版本號一致性檢查
assert f"./app.js?v={ASSET_VER}" in index_html, f"index.html must reference app.js?v={ASSET_VER}"
assert f"const ASSET_VER = '{ASSET_VER}';" in app_js, f"app.js ASSET_VER must be {ASSET_VER}"
for mod in ("engine.js", "store.js", "cloud-store.js", "cloud-client.js", "bg-manager.js"):
    assert f"./{mod}?v={ASSET_VER}" in app_js, f"app.js must import {mod}?v={ASSET_VER}"
assert f"./engine.js?v={ASSET_VER}" in store_js, f"store.js import must use ?v={ASSET_VER}"
for mod in ("engine.js", "store.js", "cloud-client.js"):
    assert f"./{mod}?v={ASSET_VER}" in cloud_store_js, f"cloud-store.js must import {mod}?v={ASSET_VER}"
assert f"./bg-themes.js?v={ASSET_VER}" in bg_manager_js, f"bg-manager.js must import bg-themes.js?v={ASSET_VER}"

# 三端背景主題 ID 一致性契約（catalog.json ≡ bg-themes.js ≡ gas/Code.gs）
cat_bg_ids = [b["id"] for b in cat["bgThemes"]]
gas_bg_match = re.search(r"bgThemes\s*:\s*\[([\s\S]*?)\]", gas_code_gs)
assert gas_bg_match, "gas/Code.gs must define CATALOG.bgThemes"
gas_bg_ids = re.findall(r"id\s*:\s*'([^']+)'", gas_bg_match.group(1))
assert cat_bg_ids == gas_bg_ids, f"bgThemes ID mismatch: catalog.json={cat_bg_ids} vs gas/Code.gs={gas_bg_ids}"

# 動態背景深模組契約與圖層檢查
assert 'id="dynamic-bg-layer"' in index_html, "index.html must define #dynamic-bg-layer"
assert 'id="dynamic-fg-layer"' in index_html, "index.html must define #dynamic-fg-layer"
assert 'id="garden-bg-selector-bar"' in index_html, "index.html must define #garden-bg-selector-bar"
assert "bgManager.init" in app_js and "store.setBgTheme" in app_js, "app.js must bind bgManager.init and route theme switches via store.setBgTheme"
assert "bgManager.setTheme" not in app_js, "app.js must not call dead bgManager.setTheme fallback"

# 架構封裝契約（Seam & Locality）與清理規則檢查
assert "store.notify()" not in app_js, "app.js must not call store.notify() directly"
assert "decorDivisor" not in app_js, "app.js must not recompute decor beauty divisor directly"
assert "streak.count >= 30" not in app_js, "app.js must not hardcode streak multiplier thresholds"
assert "export function createMemoryStorage" in store_js, "store.js must export injectable memory storage adapter"

# SSOT、無效 Tailwind v4 class 與殘留死碼／系統 Emoji 檢查
for dead_cfg in ["upgradeBase", "maxLevel", "voteOpensDaysBefore"]:
    assert dead_cfg not in cfg, f"Dead config key remains in game-config.json: {dead_cfg}"
for cat_name, cat_info in cfg["spriteScale"]["plantCategories"].items():
    assert set(cat_info.keys()) == {"rule", "ids"}, f"plantCategories.{cat_name} must follow SSOT (only rule + ids)"
for did, d_rule in cfg["spriteScale"]["decorSizes"].items():
    assert isinstance(d_rule, str), f"decorSizes.{did} must be plain rule string"

for legacy_field in ["cliffColors", "sizeClass", "archetype", "colors", "kind", "critter", "bgClass"]:
    assert f'"{legacy_field}"' not in json.dumps(cat, ensure_ascii=False), f"Legacy SVG field in catalog.json: {legacy_field}"
for bad_tw in ["blur-xs", "shadow-xs", "backdrop-blur-xs"]:
    assert bad_tw not in index_html and bad_tw not in app_js, f"Invalid Tailwind v4 class: {bad_tw}"
for sym in ["🗳", "🥀", "⏳", "⚡", "🌿", "🦊"]:
    assert sym not in store_js and sym not in app_js, f"Unexpected system emoji in code: {sym}"
for dead_fn in ["getAlbumRegions", "needsInitialTheme", "photoURL"]:
    assert dead_fn not in store_js, f"Dead code remains in store.js: {dead_fn}"

sprite_cfg = cfg["spriteScale"]
assert sprite_cfg["standardSpriteWidth"] > 0 and sprite_cfg["tileWidth"] > 0 and sprite_cfg["maxAdjacentTiles"] > 0

for th in ["flowerbed", "forest", "oasis"]:
    sub = [s for s in species if s["theme"] == th]
    assert len(sub) == 12
    assert len([s for s in sub if s["rarity"] == "common"]) == 5
    assert len([s for s in sub if s["rarity"] == "rare"]) == 4
    assert len([s for s in sub if s["rarity"] == "epic"]) == 2
    assert len([s for s in sub if s["rarity"] == "legendary"]) == 1
assert len([s for s in species if s["theme"] == "common"]) == 6
assert len([s for s in species if s["theme"] == "limited"]) == 4


def parse_rule_py(rule_str):
    assert isinstance(rule_str, str), f"Expected rule string, got {type(rule_str)}"
    s = rule_str.strip().upper()
    assert s[0] in ("W", "H"), f"Invalid rule prefix: {rule_str}"
    return ("width" if s[0] == "W" else "height"), float(s[1:])


SIZE_RULE = {}
for cat_name, cat_info in sprite_cfg["plantCategories"].items():
    mode, size = parse_rule_py(cat_info["rule"])
    assert mode in ("width", "height") and size > 0
    for pid in cat_info["ids"]:
        assert pid not in SIZE_RULE, f"Duplicate plant id in categories: {pid}"
        SIZE_RULE[pid] = (mode, size)
assert len(SIZE_RULE) == 46, f"Expected 46 plant rules, got {len(SIZE_RULE)}"

assets_root = os.path.join(ROOT_DIR, "assets")
species_files = {f"{sp['id']}_{sp['name']}.png" for sp in species}
for lv in ["Lv1", "Lv2", "Lv3", "Lv4", "Lv5", "perfect", "dead", "Lv1_wilt", "Lv2_wilt", "Lv3_wilt", "Lv4_wilt", "Lv1_dead", "Lv2_dead", "Lv3_dead", "Lv4_dead"]:
    s_dir = os.path.join(assets_root, "plants", lv)
    s_files = {f for f in os.listdir(s_dir) if f.endswith(".png")}
    assert s_files == species_files, f"Mismatch in plants/{lv}: missing={species_files - s_files}, extra={s_files - species_files}"
    for fname in s_files:
        assert os.path.getsize(os.path.join(s_dir, fname)) > 1000, f"Corrupted plant asset: {lv}/{fname}"

for dc in cat["decor"]:
    d_file = os.path.join(assets_root, "decor", f"{dc['id']}_{dc['name']}.png")
    assert os.path.isfile(d_file) and os.path.getsize(d_file) > 1000, f"Missing decor asset: {d_file}"
    d_mode, d_size = parse_rule_py(sprite_cfg["decorSizes"][dc["id"]])
    assert d_mode in ("width", "height") and d_size > 0

for th in ["flowerbed", "forest", "oasis"]:
    for sz in [5, 6, 7, 8, 9]:
        i_file = os.path.join(assets_root, "islands", f"{th}_{sz}x{sz}.png")
        assert os.path.isfile(i_file) and os.path.getsize(i_file) > 5000, f"Missing island asset: {i_file}"

print("[1/4] STATIC_AND_ASSET_CONTRACTS_PASSED")


# ============================================================================
# 2. 啟動臨時本地靜態伺服器，在真實 Chromium 執行 engine.js / store.js / app.js
# ============================================================================
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


class NoCacheStaticHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def log_message(self, format, *args):
        pass


handler = functools.partial(NoCacheStaticHandler, directory=ROOT_DIR)
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
port = httpd.server_address[1]
base_url = f"http://127.0.0.1:{port}"
srv_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
srv_thread.start()

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # --------------------------------------------------------------------
        # 2A. 真實 engine.js & store.js 模組單元測試
        # --------------------------------------------------------------------
        unit_page = browser.new_page()
        unit_errors = []
        unit_console_errors = []
        unit_page.on("pageerror", lambda err: unit_errors.append(str(err)))
        unit_page.on("console", lambda msg: unit_console_errors.append(msg.text) if msg.type == "error" else None)

        unit_page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        unit_res = unit_page.evaluate("""async (ver) => {
          const eng = await import(`/engine.js?v=${ver}`);
          const { GardenStore, createMemoryStorage, DEMO_ESSAY_ID, CARD_STYLE_STORAGE_KEY } = await import(`/store.js?v=${ver}`);
          const { CloudClient } = await import(`/cloud-client.js?v=${ver}`);
          const cfg = await (await fetch(`/game-config.json?v=${ver}`)).json();
          const cat = await (await fetch(`/catalog.json?v=${ver}`)).json();

          const assertEq = (a, b, msg) => {
            if (JSON.stringify(a) !== JSON.stringify(b)) {
              throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
            }
          };

          // (1) engine.js: countEssayWords
          assertEq(eng.countEssayWords(''), 0, 'empty word count');
          assertEq(eng.countEssayWords('今天寫了 Hello world! 2026，好嗎？'), 9, 'mixed CJK/EN word count');

          // (2) engine.js: 機率公式與多人需求進位
          const p10 = eng.getRarityProbabilities(10, cfg);
          assertEq([+p10.common.toFixed(1), +p10.rare.toFixed(1), +p10.epic.toFixed(1), +p10.legendary.toFixed(1)], [80.0, 17.0, 3.0, 0.0], 'probs 10');
          const p20 = eng.getRarityProbabilities(20, cfg);
          assertEq([+p20.common.toFixed(1), +p20.rare.toFixed(1), +p20.epic.toFixed(1), +p20.legendary.toFixed(1)], [36.0, 37.0, 17.0, 10.0], 'probs 20');
          assertEq(eng.calcRequiredDays(3, 2, cfg), 5, 'group 3*1.5=5');
          assertEq(eng.calcRequiredDays(2, 4, cfg), 5, 'group 2*2.5=5');
          assertEq(eng.calcRequiredDays(5, 5, cfg), 15, 'group 5*3=15');

          // (3) engine.js: calcPlantLevel 全階段對照
          assertEq([0, 1].map(i => eng.calcPlantLevel(i, 1)), [1, 5], 'req=1 levels (2天)');
          assertEq([0, 1, 2].map(i => eng.calcPlantLevel(i, 2)), [1, 3, 5], 'req=2 levels (3天)');
          assertEq([0, 1, 2, 3].map(i => eng.calcPlantLevel(i, 3)), [1, 2, 3, 5], 'req=3 levels (4天)');
          assertEq([0, 1, 2, 3, 4].map(i => eng.calcPlantLevel(i, 4)), [1, 2, 3, 4, 5], 'req=4 levels (5天)');
          assertEq([0, 1, 2, 3, 4, 5].map(i => eng.calcPlantLevel(i, 5)), [1, 1, 2, 3, 4, 5], 'req=5 levels (6天)');
          assertEq(eng.calcPlantLevel(14, 15), 4, 'req=15 pre-mature cap 4');
          assertEq(eng.calcPlantLevel(15, 15), 5, 'req=15 mature level 5');

          // (4) engine.js: evaluatePlantState 成長、枯萎、復活、死亡與補寫救活
          const p2 = { plantedDay: '2026-11-01', requiredDays: 2 };
          assertEq(eng.evaluatePlantState(p2, { '2026-11-01': { essays: 1 } }, '2026-11-01').level, 1, 'planted day Lv1');
          const sDay2 = eng.evaluatePlantState(p2, { '2026-11-02': { essays: 1 } }, '2026-11-02');
          assertEq([sDay2.stage, sDay2.progress, sDay2.level], ['growing', 1, 3], 'req=2 prog=1 -> Lv3');
          const sGrown = eng.evaluatePlantState(p2, { '2026-11-02': { essays: 1 }, '2026-11-03': { essays: 1 } }, '2026-11-03');
          assertEq([sGrown.stage, sGrown.level, sGrown.isPerfect], ['grown', 5, true], 'req=2 grown Lv5 perfect');

          // 連缺 2 天跨入 dead 當天（11-05：11-03 缺、11-04 缺）補寫 11-04 救活；且死亡等級反映死亡前最後進度
          const daysMiss2 = { '2026-11-02': { essays: 1 } };
          assertEq(eng.evaluatePlantState(p2, daysMiss2, '2026-11-04').stage, 'withering', 'day_2 withering');
          const sDeadProg1 = eng.evaluatePlantState(p2, daysMiss2, '2026-11-05');
          assertEq([sDeadProg1.stage, sDeadProg1.level], ['dead', 3], 'day_3 just dead keeps level 3');
          const sDeadProg0 = eng.evaluatePlantState(p2, {}, '2026-11-04');
          assertEq([sDeadProg0.stage, sDeadProg0.level], ['dead', 1], 'prog 0 dead keeps level 1');
          const daysRescued = { '2026-11-02': { essays: 1 }, '2026-11-04': { madeUp: true } };
          const sRescued = eng.evaluatePlantState(p2, daysRescued, '2026-11-05');
          assertEq([sRescued.stage, sRescued.level, sRescued.hadWilt, sRescued.isPerfect], ['growing', 3, true, false], 'rescued from just-dead');
          // 超過期限（11-06 才補寫 11-05，11-03/11-04 已連缺2天）不可救
          const daysTooLate = { '2026-11-02': { essays: 1 }, '2026-11-05': { madeUp: true } };
          assertEq(eng.evaluatePlantState(p2, daysTooLate, '2026-11-06').stage, 'dead', 'cannot rescue past 2 misses');
          assertEq(eng.evaluatePlantState({ finalStage: 'dead', finalLevel: 3 }, {}, '2026-11-06').level, 3, 'finalStage dead preserves finalLevel');
          assertEq(eng.evaluatePlantState({ finalStage: 'dead' }, {}, '2026-11-06').level, 1, 'finalStage dead defaults level to 1');

          // (5) engine.js: computeNeighborAdjustedScales & resolveGroupThemeVote
          const stdW = cfg.spriteScale.standardSpriteWidth;
          const tileW = cfg.spriteScale.tileWidth;
          const uScale = tileW / stdW;
          const maxAdj = tileW * cfg.spriteScale.maxAdjacentTiles;
          const adjRes = eng.computeNeighborAdjustedScales(
            [{ key: '1,1', x: 1, y: 1, width: 376 * uScale }, { key: '1,2', x: 1, y: 2, width: stdW * uScale }],
            maxAdj
          );
          if (Math.abs(adjRes.get('1,1') + adjRes.get('1,2') - maxAdj) > 1e-4) throw new Error('neighbor sum mismatch');
          assertEq(eng.resolveGroupThemeVote('g1', '2026-12', { u1: 'forest', u2: 'forest', u3: 'oasis' }), 'forest', 'vote winner');

          // (6) store.js: 損壞與結構無效 JSON 容錯 + 備份
          const badMem = createMemoryStorage();
          badMem.setItem('essay_garden_state_v4', '{broken_json');
          const sCorrupt = new GardenStore(cfg, cat, badMem);
          if (!sCorrupt.state.users[sCorrupt.state.currentUserId]) throw new Error('corrupt recovery failed');
          assertEq(badMem.getItem('essay_garden_state_v4_corrupted_backup'), '{broken_json', 'corrupt backup preserved');

          const badSchemaMem = createMemoryStorage();
          badSchemaMem.setItem('essay_garden_state_v4', '{}');
          new GardenStore(cfg, cat, badSchemaMem);
          assertEq(badSchemaMem.getItem('essay_garden_state_v4_corrupted_backup'), '{}', 'invalid schema backup preserved');

          // (7) store.js: 優先提示條（連寫1天斷簽）與「先查花園仍可補寫救活剛死亡植物」
          const mem = createMemoryStorage();
          const store = new GardenStore(cfg, cat, mem);
          const g = store.currentGarden();
          const reg = g.regions[g.activeRegionId];
          reg.plants = {}; // 清空花園測純連勝斷簽提示
          store.advanceSimulationDays(1); // 昨天沒寫，前天有寫(count=1)
          const bannerStreak = store.getPriorityBanner();
          if (!bannerStreak || bannerStreak.type !== 'makeup') {
            throw new Error('Expected makeup banner after 1-day streak broken');
          }

          // 重建乾淨 store 測試植物連缺 2 天剛死 -> 先讀 getEvaluatedRegion 再補寫救活
          const mem2 = createMemoryStorage();
          const store2 = new GardenStore(cfg, cat, mem2);
          const u2 = store2.currentUser();
          u2.seeds.fb_r1 = 1;
          u2.energy = 100;
          const planted = store2.plantSeed('fb_r1', 0, 0, false);
          store2.advanceSimulationDays(1); // Day+1 寫一篇推進至 progress=1
          store2.submitEssay('今天努力寫作推進植物成長進度滿十字了喔');
          store2.advanceSimulationDays(3); // 跳過 Day+2、Day+3，來到 Day+4（連缺2天剛死）

          const evDead = store2.getEvaluatedRegion(u2.activeGardenId, store2.currentGarden().activeRegionId);
          const pDead = evDead.plantsWithState.find(p => p.id === planted.id);
          assertEq(pDead.evalState.stage, 'dead', 'expected just-dead after 2 misses');
          if (store2.currentGarden().regions[store2.currentGarden().activeRegionId].plants[planted.id].finalStage) {
            throw new Error('getEvaluatedRegion must not mutate finalStage');
          }
          if (!store2.canRescuePlantByMakeUp(u2.activeGardenId, pDead)) {
            throw new Error('canRescuePlantByMakeUp should be true on day of 2nd miss');
          }
          const deadBanner = store2.getPriorityBanner();
          if (!deadBanner || deadBanner.type !== 'makeup' || !deadBanner.text.includes('救活')) {
            throw new Error('Expected rescue makeup banner for just-dead plant');
          }

          store2.makeUpYesterday();
          const evAlive = store2.getEvaluatedRegion(u2.activeGardenId, store2.currentGarden().activeRegionId);
          const pAlive = evAlive.plantsWithState.find(p => p.id === planted.id);
          assertEq([pAlive.evalState.stage, pAlive.evalState.level, pAlive.evalState.hadWilt, pAlive.evalState.isPerfect], ['growing', 3, true, false], 'plant alive after makeUpYesterday');

          // 模擬拖太久（連缺 3 天以上）應不可救
          const mem3 = createMemoryStorage();
          const store3 = new GardenStore(cfg, cat, mem3);
          const u3 = store3.currentUser();
          u3.seeds.fb_r1 = 1;
          u3.energy = 100;
          const planted3 = store3.plantSeed('fb_r1', 0, 0, false);
          store3.advanceSimulationDays(1);
          store3.submitEssay('寫一篇超過十個字的測試文章用來推動等級');
          store3.advanceSimulationDays(4); // 連缺 3 天
          const evTooLate = store3.getEvaluatedRegion(u3.activeGardenId, store3.currentGarden().activeRegionId);
          const pTooLate = evTooLate.plantsWithState.find(p => p.id === planted3.id);
          assertEq(store3.canRescuePlantByMakeUp(u3.activeGardenId, pTooLate), false, 'cannot rescue after 3 misses');
          store3.makeUpYesterday();
          const evStillDead = store3.getEvaluatedRegion(u3.activeGardenId, store3.currentGarden().activeRegionId);
          assertEq(evStillDead.plantsWithState.find(p => p.id === planted3.id).evalState.stage, 'dead', 'still dead after late makeup');

          // (8) bg-manager.js & store.js 深模組與 VirtualAdapter 接縫測試
          const { BgManager, VirtualAdapter, sampleBoxMullerNormal, nextPrng } = await import(`/bg-manager.js?v=${ver}`);
          const { BG_THEMES } = await import(`/bg-themes.js?v=${ver}`);
          assertEq(Array.isArray(cat.bgThemes), true, 'catalog.json must define bgThemes array');
          assertEq(cat.bgThemes.length, 5, 'expected 5 bgThemes');
          assertEq(Object.keys(BG_THEMES), cat.bgThemes.map(b => b.id), 'BG_THEMES keys must match catalog.json bgThemes');

          const mem4 = createMemoryStorage();
          const store4 = new GardenStore(cfg, cat, mem4);
          const u4 = store4.currentUser();
          u4.energy = 150;

          // 測試 Store 查表定價與扣能（不需 caller 外洩傳遞 cost）
          assertEq(store4.getUnlockedBgThemes(), ['morning'], 'default morning unlocked');
          const buyRes = store4.buyBgTheme('sunset'); // 50 能量
          assertEq(buyRes.success, true, 'buy sunset success');
          assertEq(u4.energy, 100, 'energy deducted from 150 to 100 by catalog SSOT');
          assertEq(store4.getActiveBgTheme(), 'sunset', 'activeBgTheme updated to sunset');

          // 測試 VirtualAdapter 與 BgManager 狀態訂閱自動連動
          const vAdapter = new VirtualAdapter();
          const bgTest = new BgManager({ adapter: vAdapter });
          bgTest.init({ store: store4 });

          assertEq(bgTest.getCurrentTheme(), 'sunset', 'bgManager synced with store initial activeBgTheme');
          assertEq(vAdapter.currentStageClass, 'bg-theme-sunset', 'VirtualAdapter stage class updated to sunset');

          // 測試 Store 狀態變更單向驅動 bgManager
          store4.setBgTheme('morning');
          assertEq(bgTest.getCurrentTheme(), 'morning', 'bgManager automatically updated on store setBgTheme');
          assertEq(vAdapter.currentStageClass, 'bg-theme-morning', 'VirtualAdapter stage class updated to morning');

          // 測試切換至 night 主題並生命週期清理
          store4.buyBgTheme('night'); // 60 能量
          assertEq(u4.energy, 40, 'energy deducted from 100 to 40');
          assertEq(bgTest.getCurrentTheme(), 'night', 'bgManager updated to night');
          assertEq(vAdapter.currentStageClass, 'bg-theme-night', 'VirtualAdapter stage class updated to night');

          // 測試數學分佈函數邊界
          for (let i = 0; i < 50; i++) {
            const r = nextPrng();
            if (r < 0 || r > 1) throw new Error('PRNG out of bounds [0, 1]');
            const norm = sampleBoxMullerNormal(38.0, 9.5);
            if (isNaN(norm)) throw new Error('Box-Muller produced NaN');
          }

          bgTest.setScreen('home');
          assertEq(vAdapter.currentScreen, 'home', 'VirtualAdapter currentScreen home');
          bgTest.setScreen('full_island');
          assertEq(vAdapter.currentScreen, 'full_island', 'VirtualAdapter currentScreen full_island');

          // 驗證縮圖 SVG <defs> ID 作用域隔離（同時渲染商店與切換列絕不碰撞）
          const extractSvgIds = (list) => {
            const ids = [];
            for (const item of list) {
              for (const m of item.thumbSvg.matchAll(/\\bid="([^"]+)"/g)) ids.push(m[1]);
            }
            return ids;
          };
          const ids1 = extractSvgIds(bgTest.getThemeCatalog());
          const ids2 = new Set(extractSvgIds(bgTest.getThemeCatalog()));
          assertEq(ids1.length > 0, true, 'thumbnails must contain scoped defs ids');
          assertEq(ids1.some(id => ids2.has(id)), false, 'consecutive getThemeCatalog() calls must not collide SVG defs ids');

          // 驗證 night 主題長駐動畫迴圈無 timer 洩漏（timeouts.size <= 14，destroy 後歸零）
          vAdapter.flushTimeouts();
          for (let round = 0; round < 3; round++) {
            const stars = vAdapter.backNodes.filter(n => n.className === 'dynamic-star-node');
            for (const s of stars) s.emit('animationend');
            if (vAdapter.timeouts.size > 14) throw new Error(`night timeouts leaked: ${vAdapter.timeouts.size}`);
            vAdapter.flushTimeouts();
          }

          bgTest.destroy();
          assertEq(vAdapter.intervals.size, 0, 'VirtualAdapter intervals cleared after destroy');
          assertEq(vAdapter.timeouts.size, 0, 'VirtualAdapter timeouts cleared after destroy');

          // 驗證零侵入擴充新主題：注入第 6 主題無須改動 BgManager 核心
          const vExt = new VirtualAdapter();
          let extCleanupCalled = false;
          const extBg = new BgManager({
            adapter: vExt,
            themes: {
              ...BG_THEMES,
              aurora: {
                sky: 'linear-gradient(180deg, #061326 0%, #193e4c 100%)',
                css: '.anim-aurora-test { opacity: 0.9; }',
                thumbSvg: '<svg viewBox="0 0 40 40"><defs><linearGradient id="ag"/></defs><rect fill="url(#ag)"/></svg>',
                mount(scope) {
                  scope.setBackHtml('<div class="anim-aurora-test"></div>');
                  scope.every(1000, () => {});
                  scope.onCleanup(() => { extCleanupCalled = true; });
                }
              }
            }
          });
          extBg.init({ defaultTheme: 'aurora' });
          assertEq(extBg.getCurrentTheme(), 'aurora', 'custom theme mounted');
          assertEq(vExt.currentStageClass, 'bg-theme-aurora', 'custom theme stage class applied');
          assertEq(vExt.injectedCss.includes('.bg-theme-aurora'), true, 'custom theme sky CSS compiled');
          assertEq(vExt.intervals.size, 1, 'custom theme interval tracked');
          extBg.destroy();
          assertEq(vExt.intervals.size, 0, 'custom theme interval cleared on destroy');
          assertEq(extCleanupCalled, true, 'custom theme onCleanup called on destroy');

          // (9) store.js: GardenStore 介面（示範反應增刪、成員顯示名稱、卡片樣式與重設、編輯保留隱私）
          const sMem = createMemoryStorage();
          const sStore = new GardenStore(cfg, cat, sMem);
          assertEq(sStore.setEssayReaction(DEMO_ESSAY_ID, 'love'), 'love', 'demo react add');
          assertEq(sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).reactions, { user_me: 'love' }, 'demo react persisted');
          assertEq(sStore.setEssayReaction(DEMO_ESSAY_ID, 'love'), null, 'demo react toggle off');
          assertEq('user_me' in sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).reactions, false, 'demo react toggle deletes key');
          sStore.setEssayReaction(DEMO_ESSAY_ID, 'sparkle');
          assertEq(sStore.setEssayReaction(DEMO_ESSAY_ID, null), null, 'demo react explicit null');
          assertEq('user_me' in sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).reactions, false, 'demo react null deletes without leaving null');

          const { essay: privEssay } = sStore.submitEssay('一篇超過十字用來測試隱私與紙張樣式的隨筆', true, undefined, 'card3');
          assertEq(sStore.getPreferredCardStyle(), 'card3', 'preferred style synced on submit');
          sStore.setEssayCardStyle(privEssay.id, 'card5');
          assertEq(sStore.getPreferredCardStyle(), 'card5', 'setEssayCardStyle updates preferred style');
          assertEq(sStore.getCarouselEssays().find(e => e.id === privEssay.id).cardStyle, 'card5', 'setEssayCardStyle updates essay');
          sStore.setEssayCardStyle(DEMO_ESSAY_ID, 'card6');
          assertEq(sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).cardStyle, 'card6', 'setEssayCardStyle updates demo essay');
          const editedEssay = sStore.updateEssayContent(privEssay.id, '更新後仍超過十字且不可誤清私密標記', undefined);
          assertEq(editedEssay.private, true, 'updateEssayContent(..., undefined) preserves private');

          assertEq(sStore.getMemberDisplayName('user_me'), '旅人作家', 'member displayName self');
          assertEq(sStore.getMemberDisplayName('missing_uid'), '旅人', 'member displayName fallback');
          sStore.createGroupGarden('共筆驗證團', 'forest');
          assertEq(sStore.getMemberDisplayName('user_friend_1'), '小沐(圈友)', 'member displayName teammate');

          sStore.resetAllData();
          assertEq(sStore.getPreferredCardStyle(), 'card1', 'resetAllData resets preferred style');
          assertEq(sMem.getItem(CARD_STYLE_STORAGE_KEY), null, 'resetAllData clears card style key');
          assertEq(sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).cardStyle, 'card2', 'resetAllData clears demo cardStyle');
          assertEq(sStore.getCarouselEssays().find(e => e.id === DEMO_ESSAY_ID).reactions, {}, 'resetAllData clears demo reactions');

          // (10) cloud-client.js: AbortController 逾時錯誤碼與 logout 收到 AUTH_INVALID 不觸發 onAuthInvalid
          let seenSignal = null;
          const ccTimeout = new CloudClient({
            gasWebAppUrl: 'https://example.invalid/gas',
            storage: createMemoryStorage(),
            fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
              seenSignal = init.signal;
              init.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
              }, { once: true });
            })
          });
          let timeoutErr = null;
          try { await ccTimeout.request('ping', {}, { timeoutMs: 15 }); } catch (err) { timeoutErr = err; }
          assertEq(Boolean(seenSignal && seenSignal.aborted), true, 'AbortController aborted on timeoutMs');
          assertEq(timeoutErr?.code, 'TIMEOUT_ERROR', 'CloudClient timeout throws TIMEOUT_ERROR');

          let authInvalidCalls = 0;
          const ccAuth = new CloudClient({
            gasWebAppUrl: 'https://example.invalid/gas',
            storage: createMemoryStorage(),
            onAuthInvalid: () => { authInvalidCalls += 1; },
            fetchImpl: async () => ({
              ok: true,
              text: async () => JSON.stringify({ ok: false, code: 'AUTH_INVALID', message: 'expired' })
            })
          });
          ccAuth.setSessionToken('tok_keep');
          let logoutErr = null;
          try { await ccAuth.request('logout', {}); } catch (err) { logoutErr = err; }
          assertEq(logoutErr?.code, 'AUTH_INVALID', 'logout surfaces AUTH_INVALID');
          assertEq(authInvalidCalls, 0, 'logout AUTH_INVALID must not trigger onAuthInvalid');
          try { await ccAuth.request('bootstrap', {}); } catch (_err) {}
          assertEq(authInvalidCalls, 1, 'bootstrap AUTH_INVALID triggers onAuthInvalid');

          return 'UNIT_OK';
        }""", ASSET_VER)
        assert unit_res == "UNIT_OK"
        assert not unit_errors, f"Unexpected unit test pageerror: {unit_errors}"
        unexpected_console_errs = [e for e in unit_console_errors if "[GardenStore] Stored state" not in e]
        assert not unexpected_console_errs, f"Unexpected unit console errors: {unexpected_console_errs}"
        unit_page.close()

        # 無 DOM 環境匯入 app.js 不觸發 boot()，並驗證島嶼幾何計算／零寬高防守／-0 正規化
        node_exe, _ = compute_driver_executable()
        node_app_proc = subprocess.run(
            [node_exe, "--input-type=module", "-"],
            input="""
import assert from 'node:assert/strict';
assert.equal(typeof document, 'undefined', 'expected no-DOM environment');
const { computeSvgViewportScale, computeIslandViewBox, clampIslandPanMetrics } = await import('./app.js');

assert.equal(computeSvgViewportScale(null, { width: 430, height: 450 }), 0);
assert.equal(computeSvgViewportScale({ width: 0, height: 400 }, { width: 430, height: 450 }), 0);
assert.equal(computeSvgViewportScale({ width: 400, height: -5 }, { width: 430, height: 450 }), 0);
assert.equal(computeSvgViewportScale({ width: 400, height: 400 }, { width: 430, height: 0 }), 0);
assert.equal(computeSvgViewportScale({ width: 215, height: 450 }, { width: 430, height: 450 }), 0.5);

assert.equal(computeIslandViewBox('home', 5, null), null);
assert.equal(computeIslandViewBox('home', 5, { svgRect: { top: 0, width: 0, height: 300 }, zoneTop: 0, zoneBottom: 300 }), null);
assert.equal(computeIslandViewBox('full', 5, { svgRect: { top: 0, width: 400, height: 0 }, winH: 844 }), null);
assert.throws(() => computeIslandViewBox('bad', 5, { svgRect: { top: 0, width: 400, height: 400 } }));

let prevHomeY = Infinity;
for (const sz of [5, 6, 7, 8, 9]) {
  const hv = computeIslandViewBox('home', sz, { svgRect: { top: 40, width: 380, height: 420 }, zoneTop: 60, zoneBottom: 380 });
  assert.equal(hv.x, -215);
  assert.equal(hv.width, 430);
  assert.equal(hv.height, 450);
  assert.ok(hv.scale > 0 && Number.isFinite(hv.y) && hv.y < prevHomeY, `home viewBox monotonic at ${sz}`);
  prevHomeY = hv.y;

  const fv = computeIslandViewBox('full', sz, { svgRect: { top: 0, width: 412, height: 780 }, winH: 844, navTop: 779 });
  assert.equal(fv.x, -300);
  assert.equal(fv.width, 600);
  assert.equal(fv.height, 580);
  assert.ok(fv.scale > 0 && Number.isFinite(fv.y), `full viewBox finite at ${sz}`);

  const zeroPan = clampIslandPanMetrics({
    containerRect: { width: 412, height: 700 }, svgRect: { width: 412, height: 700 },
    viewBox: fv, panX: -0, panY: -0, zoom: 1, regionSize: sz
  });
  assert.equal(Object.is(zeroPan.x, 0), true, `normalize -0 panX at ${sz}`);
  assert.equal(Object.is(zeroPan.y, 0), true, `normalize -0 panY at ${sz}`);

  const clamped = clampIslandPanMetrics({
    containerRect: { width: 412, height: 700 }, svgRect: { width: 412, height: 700 },
    viewBox: fv, panX: -9999, panY: 9999, zoom: 2.5, regionSize: sz
  });
  assert.ok(Math.abs(clamped.x) < 9999 && Math.abs(clamped.y) < 9999, `clamped pan at ${sz}`);
}

const zeroDef = clampIslandPanMetrics({
  containerRect: { width: 0, height: 700 }, svgRect: { width: 412, height: 700 },
  viewBox: { x: -300, y: -290, width: 600, height: 580 }, panX: 12, panY: -8
});
assert.deepEqual(zeroDef, { x: 12, y: -8 });
""",
            text=True,
            encoding="utf-8",
            cwd=ROOT_DIR,
            capture_output=True,
            check=False,
        )
        assert node_app_proc.returncode == 0, f"Node app.js check failed:\n{node_app_proc.stderr}\n{node_app_proc.stdout}"
        print("[2/4] REAL_JS_ENGINE_AND_STORE_UNIT_TESTS_PASSED")

        # --------------------------------------------------------------------
        # 2B. 真實 index.html + app.js 端到端整合測試（Bug #1 圖片/高度 + 雙指縮放 + 返回首頁歸位 + 商店阻擋）
        # --------------------------------------------------------------------
        e2e_page = browser.new_page(viewport={"width": 412, "height": 844}, has_touch=True, is_mobile=True)
        e2e_errors = []
        e2e_failed_reqs = []
        e2e_page.on("pageerror", lambda err: e2e_errors.append(str(err)))
        e2e_page.on("console", lambda msg: e2e_errors.append(msg.text) if msg.type == "error" else None)
        e2e_page.on("requestfailed", lambda req: e2e_failed_reqs.append(req.url))

        # 用同源真實 engine.js 與 config 先計算 todayKey 並構造含非 Perfect 成熟與進度跳級的測試狀態
        e2e_page.goto(f"{base_url}/index.html", wait_until="networkidle")
        e2e_page.evaluate("""async (ver) => {
          const eng = await import(`/engine.js?v=${ver}`);
          const { GardenStore, createMemoryStorage } = await import(`/store.js?v=${ver}`);
          const cfg = await (await fetch(`/game-config.json?v=${ver}`)).json();
          const cat = await (await fetch(`/catalog.json?v=${ver}`)).json();

          const tmpStore = new GardenStore(cfg, cat, createMemoryStorage());
          const todayKey = tmpStore.currentDayKey();
          const d1 = eng.addDays(todayKey, -1);
          const d2 = eng.addDays(todayKey, -2);
          const d3 = eng.addDays(todayKey, -3);
          const d4 = eng.addDays(todayKey, -4);
          const d5 = eng.addDays(todayKey, -5);

          const u = tmpStore.currentUser();
          const g = tmpStore.currentGarden();
          const reg = g.regions[g.activeRegionId];
          u.energy = 65;
          u.days = {
            [d4]: { essays: 1, words: 40, lastEssayAt: Date.now() - 4 * 86400000, madeUp: false },
            [d1]: { essays: 1, words: 40, lastEssayAt: Date.now() - 86400000, madeUp: false }
          };
          reg.decor = {};
          reg.plants = {
            p_c1_grown_np: {
              id: 'p_c1_grown_np', speciesId: 'fb_c1', x: 0, y: 0, plantedBy: u.uid,
              plantedDay: d3, plantedAt: Date.now() - 3 * 86400000,
              requiredDays: 1, limited: false, finalStage: 'grown', hadWilt: true, frozen: null
            },
            p_r1_lv3: {
              id: 'p_r1_lv3', speciesId: 'fb_r1', x: 2, y: 2, plantedBy: u.uid,
              plantedDay: d2, plantedAt: Date.now() - 2 * 86400000,
              requiredDays: 2, limited: false, finalStage: null, frozen: null
            },
            p_r2_lv2: {
              id: 'p_r2_lv2', speciesId: 'fo_r2', x: 4, y: 4, plantedBy: u.uid,
              plantedDay: d2, plantedAt: Date.now() - 2 * 86400000,
              requiredDays: 3, limited: false, finalStage: null, frozen: null
            },
            p_fo_c3_dead_lv3: {
              id: 'p_fo_c3_dead_lv3', speciesId: 'fo_c3', x: 0, y: 4, plantedBy: u.uid,
              plantedDay: d5, plantedAt: Date.now() - 5 * 86400000,
              requiredDays: 2, limited: false, finalStage: null, frozen: null
            }
          };
          localStorage.setItem('essay_garden_state_v4', JSON.stringify(tmpStore.state));
        }""", ASSET_VER)

        e2e_page.reload(wait_until="networkidle")
        e2e_page.click("#btn-enter-fullscreen-garden")
        e2e_page.wait_for_selector("#full-island-svg .island-pan-layer")

        u_scale = sprite_cfg["tileWidth"] / sprite_cfg["standardSpriteWidth"]
        expected_fb_c1_h = 190 * u_scale
        expected_fo_c3_dead_h = 230 * 0.7 * u_scale
        # 等待圖片載完觸發 rAF 重繪成真實天然比例尺寸
        e2e_page.wait_for_function("""({ expC1, expC3 }) => {
          const imgs = [...document.querySelectorAll('#full-island-svg image')];
          const fbC1 = imgs.find(el => (el.getAttribute('href') || '').includes('fb_c1'));
          const foC3 = imgs.find(el => (el.getAttribute('href') || '').includes('fo_c3'));
          if (!fbC1 || !foC3) return false;
          return Math.abs(parseFloat(fbC1.getAttribute('height') || '0') - expC1) < 0.4
              && Math.abs(parseFloat(foC3.getAttribute('height') || '0') - expC3) < 0.4;
        }""", arg={"expC1": expected_fb_c1_h, "expC3": expected_fo_c3_dead_h}, timeout=5000)

        hrefs = e2e_page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('#full-island-svg image')];
          return imgs.map(el => ({
            href: el.getAttribute('href'),
            w: parseFloat(el.getAttribute('width')),
            h: parseFloat(el.getAttribute('height'))
          }));
        }""")
        by_id = {}
        for item in hrefs:
            for pid in ["fb_c1", "fb_r1", "fo_r2", "fo_c3"]:
                if pid in item["href"]:
                    by_id[pid] = item

        assert "/Lv5/fb_c1_" in by_id["fb_c1"]["href"], f"Expected non-perfect grown fb_c1 to render Lv5, got {by_id['fb_c1']}"
        assert abs(by_id["fb_c1"]["h"] - expected_fb_c1_h) < 0.4, f"Expected fb_c1 height ~{expected_fb_c1_h:.1f}, got {by_id['fb_c1']}"
        assert "/Lv3/fb_r1_" in by_id["fb_r1"]["href"], f"Expected 2-day prog=1 fb_r1 to render Lv3, got {by_id['fb_r1']}"
        assert "/Lv2/fo_r2_" in by_id["fo_r2"]["href"], f"Expected 3-day prog=1 fo_r2 to render Lv2, got {by_id['fo_r2']}"
        assert "/Lv3_dead/fo_c3_" in by_id["fo_c3"]["href"], f"Expected dead level-3 fo_c3 to render Lv3_dead, got {by_id['fo_c3']}"
        assert abs(by_id["fo_c3"]["h"] - expected_fo_c3_dead_h) < 0.4, f"Expected fo_c3 dead height ~{expected_fo_c3_dead_h:.1f}, got {by_id['fo_c3']}"

        print("[3/4] E2E_SPRITE_LEVEL_AND_NON_PERFECT_LV5_PASSED")

        # 驗證單一事件委派點擊格子打開詳情卡 & Escape 關閉彈窗（島嶼有 CSS 飄浮動畫，取當前中心點做真實鼠標命中測試）
        cell_box = e2e_page.locator('#full-island-svg [data-cell-x="0"][data-cell-y="0"]').bounding_box()
        assert cell_box, "Expected grid cell (0,0) bounding box"
        e2e_page.mouse.click(cell_box["x"] + cell_box["width"] / 2, cell_box["y"] + cell_box["height"] / 2)
        assert e2e_page.locator("#modal-overlay").is_visible()
        assert "紫薰衣草" in e2e_page.locator("#modal-box").inner_text()
        e2e_page.keyboard.press("Escape")
        assert not e2e_page.locator("#modal-overlay").is_visible()

        # 回歸驗證：雙指放大 + 返回首頁歸位 + 商店能量不足阻擋
        header_before = e2e_page.locator("#screen-garden header").bounding_box()
        nav_before = e2e_page.locator("#garden-bottom-nav").bounding_box()
        vp = e2e_page.locator("#full-garden-viewport").bounding_box()
        cx, cy = vp["x"] + vp["width"] / 2, vp["y"] + vp["height"] / 2

        e2e_page.evaluate("""({ cx, cy }) => {
          const target = document.getElementById('full-garden-viewport');
          const fire = (type, id, x, y) => {
            const el = type === 'pointerdown' ? target : window;
            el.dispatchEvent(new PointerEvent(type, {
              bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch',
              clientX: x, clientY: y, isPrimary: id === 101
            }));
          };
          fire('pointerdown', 101, cx - 30, cy);
          fire('pointerdown', 102, cx + 30, cy);
          fire('pointermove', 101, cx - 70, cy);
          fire('pointermove', 102, cx + 70, cy);
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 102, pointerType: 'touch', clientX: cx + 70, clientY: cy }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 101, pointerType: 'touch', clientX: cx - 70, pointerY: cy }));
        }""", {"cx": cx, "cy": cy})

        tf_pinch = e2e_page.locator("#full-island-svg .island-pan-layer").get_attribute("transform")
        m = re.match(r"translate\(([-\d.]+),\s*([-\d.]+)\)\s*scale\(([-\d.]+)\)", tf_pinch or "")
        assert m and float(m.group(3)) > 2.0, f"Expected zoom > 2.0, got {tf_pinch}"
        assert e2e_page.locator("#screen-garden header").bounding_box() == header_before
        assert e2e_page.locator("#garden-bottom-nav").bounding_box() == nav_before

        e2e_page.click("#btn-back-home")
        tf_home = e2e_page.locator("#home-island-svg .island-pan-layer").get_attribute("transform")
        assert tf_home == "translate(0.0, 0.0) scale(1.000)", f"Expected home reset, got {tf_home}"

        # 驗證首頁隨筆卡（right）與閱讀彈窗（left）長按反應托盤對齊且不重疊錯位
        def assert_long_press_tray(btn_selector, expected_align):
            btn = e2e_page.locator(btn_selector).first
            assert btn.get_attribute("data-tray-align") == expected_align, f"Expected data-tray-align={expected_align} on {btn_selector}"
            box = btn.bounding_box()
            assert box, f"Expected bounding box for {btn_selector}"
            e2e_page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            e2e_page.mouse.down()
            e2e_page.wait_for_selector("#reaction-tray:not(.hidden)", timeout=2000)
            e2e_page.wait_for_timeout(200)
            geom = e2e_page.evaluate("""(sel) => {
              const tray = document.getElementById('reaction-tray');
              const btn = document.querySelector(sel);
              const iconRect = (btn.querySelector('svg') || btn).getBoundingClientRect();
              const tr = tray.getBoundingClientRect();
              const opts = [...tray.querySelectorAll('[data-reaction-opt]')].map(o => {
                const r = o.getBoundingClientRect();
                return { id: o.dataset.reactionOpt, left: r.left, right: r.right, cx: r.left + r.width / 2 };
              });
              return {
                align: tray.dataset.trayAlign,
                tray: { left: tr.left, right: tr.right, bottom: tr.bottom },
                btnTop: btn.getBoundingClientRect().top,
                iconCx: iconRect.left + iconRect.width / 2,
                opts,
                winW: window.innerWidth
              };
            }""", btn_selector)
            e2e_page.mouse.up()
            opts = geom["opts"]
            assert geom["align"] == expected_align and len(opts) == 5, f"Unexpected tray geom: {geom}"
            assert (opts[-1]["id"] if expected_align == "right" else opts[0]["id"]) == "love", f"Unexpected love order: {opts}"
            for a, b in zip(opts, opts[1:]):
                assert a["right"] <= b["left"] + 1, f"Reaction tray options overlapped: {a} vs {b}"
            assert geom["tray"]["left"] >= 8 and geom["tray"]["right"] <= geom["winW"] - 8, f"Tray outside viewport: {geom['tray']}"
            assert geom["tray"]["bottom"] <= geom["btnTop"], f"Tray overlapped trigger button: {geom}"
            love_opt = opts[-1] if expected_align == "right" else opts[0]
            if geom["tray"]["left"] > 8.5 and geom["tray"]["right"] < geom["winW"] - 8.5:
                assert abs(love_opt["cx"] - geom["iconCx"]) <= 4, f"Love icon misaligned: {love_opt['cx']} vs {geom['iconCx']}"

        assert_long_press_tray('#essay-carousel [data-react-btn="essay_demo_welcome"]', "right")
        card_box = e2e_page.locator('#essay-carousel .essay-card[data-essay-id="essay_demo_welcome"] .essay-text-wrap').first.bounding_box()
        assert card_box, "Expected demo essay card bounding box"
        e2e_page.mouse.click(card_box["x"] + card_box["width"] / 2, card_box["y"] + card_box["height"] / 2)
        e2e_page.wait_for_selector('#modal-box [data-react-btn="essay_demo_welcome"]', state="visible", timeout=2000)
        assert_long_press_tray('#modal-box [data-react-btn="essay_demo_welcome"]', "left")
        e2e_page.keyboard.press("Escape")
        assert not e2e_page.locator("#modal-overlay").is_visible()

        e2e_page.click("#btn-enter-fullscreen-garden")

        # 驗證需求 4：若僅擁有預設背景（unlockedBgThemes <= 1），全螢幕頂部背景切換列必須為隱藏狀態
        assert not e2e_page.locator("#garden-bg-selector-bar").is_visible(), "Selector bar must be hidden when only default theme is owned"

        # 驗證需求 3：在商店購買天候背景（能量足夠解鎖 sunset，50 能量）
        e2e_page.click("#nav-btn-shop")
        assert e2e_page.locator("#modal-overlay").is_visible()
        assert e2e_page.locator('[data-buy-bg="sunset"]').is_visible()
        e2e_page.click('[data-buy-bg="sunset"]')
        assert e2e_page.locator("#toast-bar").is_visible() and "購買成功" in e2e_page.locator("#toast-bar").inner_text()
        
        # 驗證單一進入點生效，背景樣式更新為 bg-theme-sunset
        app_cls = e2e_page.locator("#app-container").get_attribute("class") or ""
        assert "bg-theme-sunset" in app_cls, f"Expected bg-theme-sunset, got {app_cls}"

        # 關閉商店後，全螢幕頂部背景切換列自動顯現（因已擁有 >= 2 款背景）
        e2e_page.keyboard.press("Escape")
        assert e2e_page.locator("#garden-bg-selector-bar").is_visible(), "Selector bar must become visible after unlocking 2nd theme"
        assert e2e_page.locator('[data-switch-bg="morning"]').is_visible()
        assert e2e_page.locator('[data-switch-bg="sunset"]').is_visible()

        # 點擊頂部切換框切換回 morning
        e2e_page.click('[data-switch-bg="morning"]')
        app_cls_morning = e2e_page.locator("#app-container").get_attribute("class") or ""
        assert "bg-theme-morning" in app_cls_morning, f"Expected bg-theme-morning after switch, got {app_cls_morning}"

        e2e_page.click("#nav-btn-shop")
        e2e_page.click('[data-shop-decor="dec_pond"]')
        assert e2e_page.locator("#toast-bar").is_visible() and "能量不足" in e2e_page.locator("#toast-bar").inner_text()
        assert e2e_page.locator("#modal-overlay").is_visible()
        assert not e2e_page.locator("#placing-banner").is_visible()

        assert not e2e_errors, f"Unexpected E2E console/page errors: {e2e_errors}"
        assert not e2e_failed_reqs, f"Failed network requests: {e2e_failed_reqs}"
        browser.close()

    print("[4/4] E2E_INTERACTION_REGRESSION_PASSED")
    print("ALL_ENGINE_AND_ARCHITECTURE_CONTRACTS_PASSED")
finally:
    httpd.shutdown()
    httpd.server_close()
