import os
import json
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def verify_all():
    print("=" * 70)
    print("【啟動全新 7 大需求實機驗收與抓拍】")
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

        page.evaluate("""() => {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.style.display = 'none';
        }""")

        # -------------------------------------------------------------
        # 驗收 1 & 2：流星雨（隨機 50%~100% 速度、1/3 在前景、大小不受前後景影響）
        # -------------------------------------------------------------
        print("\n--- [驗收 1 & 2：流星雨] ---")
        page.evaluate("window.__bgManager.setTheme('night')")
        page.wait_for_timeout(400)

        meteor_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            const fgMeteors = Array.from(fg.querySelectorAll('.meteor-track')).map(el => ({
                dur: el.style.getPropertyValue('--meteor-dur'),
                del: el.style.getPropertyValue('--meteor-del'),
                top: el.style.top,
                svgW: el.querySelector('svg')?.getAttribute('width'),
                svgH: el.querySelector('svg')?.getAttribute('height')
            }));
            const bgMeteors = Array.from(bg.querySelectorAll('.meteor-track')).map(el => ({
                dur: el.style.getPropertyValue('--meteor-dur'),
                del: el.style.getPropertyValue('--meteor-del'),
                top: el.style.top,
                svgW: el.querySelector('svg')?.getAttribute('width'),
                svgH: el.querySelector('svg')?.getAttribute('height')
            }));
            return {
                fgCount: fgMeteors.length,
                bgCount: bgMeteors.length,
                ratio: `${fgMeteors.length} / ${fgMeteors.length + bgMeteors.length}`,
                fgMeteors,
                bgMeteors
            };
        }""")
        print(f"流星雨分層與速度資訊: {json.dumps(meteor_info, indent=2)}")

        shot_night = os.path.join(OUTPUT_DIR, "verify_01_meteor_night.png")
        page.screenshot(path=shot_night)
        print(f"流星雨實機截圖已儲存: {shot_night}")

        # -------------------------------------------------------------
        # 驗收 3 & 4：雨絲（前景與後景一樣粗細、更透明）
        # -------------------------------------------------------------
        print("\n--- [驗收 3 & 4：雨絲粗細與透明度] ---")
        page.evaluate("window.__bgManager.setTheme('rain')")
        page.wait_for_timeout(400)

        rain_info = page.evaluate("""() => {
            const fgBar = document.querySelector('#dynamic-fg-layer .rain-bar-fg');
            const bgBar = document.querySelector('#dynamic-bg-layer .rain-bar');
            const fgStyle = window.getComputedStyle(fgBar);
            const bgStyle = window.getComputedStyle(bgBar);
            return {
                fgThickness: fgStyle.height,
                bgThickness: bgStyle.height,
                fgWidth: fgStyle.width,
                bgWidth: bgStyle.width,
                fgOpacity: fgStyle.opacity,
                bgOpacity: bgStyle.opacity,
                sameThickness: fgStyle.height === bgStyle.height
            };
        }""")
        print(f"雨絲粗細與透明度比較: {json.dumps(rain_info, indent=2)}")

        shot_rain = os.path.join(OUTPUT_DIR, "verify_02_rain_translucent.png")
        page.screenshot(path=shot_rain)
        print(f"柔和雨絲實機截圖已儲存: {shot_rain}")

        # -------------------------------------------------------------
        # 驗收 5：在全螢幕花園島頁，雨絲不能蓋到底下的文字框跟選單
        # -------------------------------------------------------------
        print("\n--- [驗收 5：全螢幕花園頁雨絲與層級] ---")
        # 點擊進入全螢幕花園
        page.evaluate("""() => {
            const btn = document.getElementById('btn-enter-fullscreen-garden');
            if (btn) btn.click();
        }""")
        page.wait_for_timeout(500)

        fullscreen_layer_info = page.evaluate("""() => {
            const fgLayer = document.getElementById('dynamic-fg-layer');
            const screenGarden = document.getElementById('screen-garden');
            const fullHeader = document.querySelector('#screen-garden header');
            const fullInfo = document.getElementById('full-floating-info');
            const fullNav = document.getElementById('garden-bottom-nav');
            const islandViewport = document.getElementById('full-garden-viewport');

            return {
                fg_zIndex: parseInt(window.getComputedStyle(fgLayer).zIndex),
                fullHeader_zIndex: parseInt(window.getComputedStyle(fullHeader).zIndex),
                fullInfo_zIndex: parseInt(window.getComputedStyle(fullInfo).zIndex),
                fullNav_zIndex: parseInt(window.getComputedStyle(fullNav).zIndex),
                island_zIndex: parseInt(window.getComputedStyle(islandViewport.parentElement).zIndex || '10'),
                text_above_fg: parseInt(window.getComputedStyle(fullInfo).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex),
                nav_above_fg: parseInt(window.getComputedStyle(fullNav).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex)
            };
        }""")
        print(f"全螢幕花園頁層疊上下文檢測: {json.dumps(fullscreen_layer_info, indent=2)}")

        shot_full_rain = os.path.join(OUTPUT_DIR, "verify_03_fullscreen_rain.png")
        page.screenshot(path=shot_full_rain)
        print(f"全螢幕花園雨景截圖已儲存: {shot_full_rain}")

        # -------------------------------------------------------------
        # 驗收 6 & 7：泡泡縮小 50%，不遮擋底部文字框選單與上方標題
        # -------------------------------------------------------------
        print("\n--- [驗收 6 & 7：泡泡縮小 50% 且不遮擋文字框、選單與標題] ---")
        page.evaluate("window.__bgManager.setTheme('bubbles')")
        page.wait_for_timeout(500)

        bubble_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            const fgSvgs = Array.from(fg.querySelectorAll('svg')).map(s => ({
                w: parseInt(s.getAttribute('width')),
                h: parseInt(s.getAttribute('height'))
            }));
            const bgSvgs = Array.from(bg.querySelectorAll('svg')).map(s => ({
                w: parseInt(s.getAttribute('width')),
                h: parseInt(s.getAttribute('height'))
            }));

            const fullHeader = document.querySelector('#screen-garden header');
            const fullInfo = document.getElementById('full-floating-info');
            const fullNav = document.getElementById('garden-bottom-nav');
            const fgLayer = document.getElementById('dynamic-fg-layer');

            return {
                fgBubbleSizes: fgSvgs,
                bgBubbleSizes: bgSvgs,
                header_above_fg: parseInt(window.getComputedStyle(fullHeader).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex),
                text_above_fg: parseInt(window.getComputedStyle(fullInfo).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex),
                nav_above_fg: parseInt(window.getComputedStyle(fullNav).zIndex) > parseInt(window.getComputedStyle(fgLayer).zIndex)
            };
        }""")
        print(f"泡泡尺寸與不遮擋檢驗: {json.dumps(bubble_info, indent=2)}")

        shot_full_bubble = os.path.join(OUTPUT_DIR, "verify_04_fullscreen_bubbles.png")
        page.screenshot(path=shot_full_bubble)
        print(f"全螢幕花園縮小泡泡截圖已儲存: {shot_full_bubble}")

        # 返回首頁再截一張首頁縮小泡泡截圖
        page.evaluate("""() => {
            const btn = document.getElementById('btn-back-home');
            if (btn) btn.click();
        }""")
        page.wait_for_timeout(500)

        shot_home_bubble = os.path.join(OUTPUT_DIR, "verify_05_home_bubbles.png")
        page.screenshot(path=shot_home_bubble)
        print(f"首頁縮小泡泡截圖已儲存: {shot_home_bubble}")

        browser.close()

if __name__ == "__main__":
    verify_all()
