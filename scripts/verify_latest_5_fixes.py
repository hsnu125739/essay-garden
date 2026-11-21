import os
import json
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def verify_latest_5_fixes():
    print("=" * 70)
    print("【啟動最新 5 大問題修復量化驗收與截圖】")
    print("=" * 70)

    viewport_w = 412
    viewport_h = 915
    scale_factor = 2

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': viewport_w, 'height': viewport_h}, device_scale_factor=scale_factor)
        page = context.new_page()

        page.goto("http://127.0.0.1:8765/index.html?mode=local", wait_until="networkidle")
        page.wait_for_timeout(600)

        page.evaluate("document.getElementById('modal-overlay').style.display = 'none'")

        # -------------------------------------------------------------
        # 1. 驗證全螢幕花園頁文字框絕無泡泡遮擋 (問題 1) 與泡泡升至標題下方 (問題 2)
        # -------------------------------------------------------------
        print("\n--- [驗證 1 & 2：全螢幕文字框層級與泡泡升騰路徑] ---")
        page.evaluate("""() => {
            document.getElementById('btn-enter-fullscreen-garden')?.click();
            window.__bgManager.setTheme('bubbles');
        }""")
        page.wait_for_timeout(400)

        layer_info = page.evaluate("""() => {
            const fgLayer = document.getElementById('dynamic-fg-layer');
            const fullInfo = document.getElementById('full-floating-info');
            const fullNav = document.getElementById('garden-bottom-nav');
            const fullHeader = document.querySelector('#screen-garden header');
            const viewport = document.getElementById('full-garden-viewport');

            return {
                fg_zIndex: parseInt(window.getComputedStyle(fgLayer).zIndex),
                fullInfo_zIndex: parseInt(window.getComputedStyle(fullInfo).zIndex),
                fullNav_zIndex: parseInt(window.getComputedStyle(fullNav).zIndex),
                fullHeader_zIndex: parseInt(window.getComputedStyle(fullHeader).zIndex),
                viewport_zIndex: parseInt(window.getComputedStyle(viewport).zIndex),
                text_above_fg: parseInt(window.getComputedStyle(fullInfo).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex),
                nav_above_fg: parseInt(window.getComputedStyle(fullNav).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex),
                header_above_fg: parseInt(window.getComputedStyle(fullHeader).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex)
            };
        }""")
        print(f"全螢幕層級驗證: {json.dumps(layer_info, indent=2)}")

        # 抓拍全螢幕花園泡泡升騰圖
        shot_full_bubbles = os.path.join(OUTPUT_DIR, "fix5_01_fullscreen_bubbles.png")
        page.screenshot(path=shot_full_bubbles)
        print(f"全螢幕泡泡實機截圖已儲存: {shot_full_bubbles}")

        # -------------------------------------------------------------
        # 2. 驗證流星時長翻倍 (問題 3)
        # -------------------------------------------------------------
        print("\n--- [驗證 3：流星時長翻倍與慢速劃過] ---")
        page.evaluate("window.__bgManager.setTheme('night')")
        page.wait_for_timeout(400)

        meteor_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            const allTracks = Array.from(document.querySelectorAll('.meteor-track')).map(el => ({
                dur: parseFloat(el.style.getPropertyValue('--meteor-dur')),
                del: el.style.getPropertyValue('--meteor-del'),
                durStr: el.style.getPropertyValue('--meteor-dur')
            }));
            return {
                tracksCount: allTracks.length,
                allTracks,
                minDur: Math.min(...allTracks.map(t => t.dur)),
                maxDur: Math.max(...allTracks.map(t => t.dur))
            };
        }""")
        print(f"流星時長（翻倍後）實測: {json.dumps(meteor_info, indent=2)}")

        # -------------------------------------------------------------
        # 3. 驗證切換到雨後彩虹時剛開始沒有雨且絕無停滯雨絲 (問題 4)
        # -------------------------------------------------------------
        print("\n--- [驗證 4：剛切換到雨後彩虹前 2 秒無雨且無停滯雨絲] ---")
        page.evaluate("window.__bgManager.setTheme('morning')")
        page.wait_for_timeout(200)

        # 切換到 rain
        page.evaluate("window.__bgManager.setTheme('rain')")

        # 剛切換後立即（100ms）檢查畫面上所有雨絲的 computed opacity
        rain_instant_check = page.evaluate("""() => {
            const allBars = Array.from(document.querySelectorAll('.rain-bar, .rain-bar-fg'));
            const opacities = allBars.map(el => parseFloat(window.getComputedStyle(el).opacity));
            const maxOpacity = Math.max(...opacities);
            const allZero = opacities.every(op => op === 0);
            return {
                totalRainBars: allBars.length,
                maxInstantOpacity: maxOpacity,
                allCompletelyInvisible: allZero
            };
        }""")
        print(f"剛切換瞬間雨絲可見度檢查: {json.dumps(rain_instant_check, indent=2)}")

        shot_rain_initial = os.path.join(OUTPUT_DIR, "fix5_02_rain_instant_clean.png")
        page.screenshot(path=shot_rain_initial)
        print(f"剛切換瞬間純淨無雨截圖已儲存: {shot_rain_initial}")

        # -------------------------------------------------------------
        # 4. 驗證彩虹結束動畫從左至右且全透明消失 (問題 5)
        # -------------------------------------------------------------
        print("\n--- [驗證 5：彩虹結束動畫規格] ---")
        rainbow_anim_rules = page.evaluate("""() => {
            const styleSheet = document.getElementById('essay-garden-dynamic-bg-styles');
            const rules = styleSheet ? styleSheet.textContent : '';
            const matchKeyframes = rules.includes('polygon(100% 0, 100% 0, 100% 100%, 100% 100%)');
            const match96 = rules.includes('96%');
            return {
                hasLeftToRightClipPath: matchKeyframes,
                has96PercentMarker: match96
            };
        }""")
        print(f"彩虹動畫 CSS 規格檢測: {json.dumps(rainbow_anim_rules, indent=2)}")

        browser.close()

if __name__ == "__main__":
    verify_latest_5_fixes()
