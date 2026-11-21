import os
import json
import time
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"C:\Users\wl020\.gemini\antigravity\brain\e87411b6-b4ee-4861-bf11-e827b02810d3\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def verify_and_capture():
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 430, 'height': 932})
        page = context.new_page()

        page.goto("http://127.0.0.1:8765/index.html")
        page.evaluate("""async () => {
            const ver = '20261121t';
            const { GardenStore, createMemoryStorage } = await import(`/store.js?v=${ver}`);
            const cfg = await (await fetch(`/game-config.json?v=${ver}`)).json();
            const cat = await (await fetch(`/catalog.json?v=${ver}`)).json();
            const tmpStore = new GardenStore(cfg, cat, createMemoryStorage());
            const u = tmpStore.currentUser();
            u.energy = 9999;
            u.unlockedBgThemes = ['morning', 'sunset', 'night', 'rain', 'bubbles'];
            u.activeBgTheme = 'rain';

            localStorage.setItem('essay_garden_state_v4', JSON.stringify(tmpStore.state));
            localStorage.setItem('essay_garden_session_token_v1', 'valid_test_session_token_999');
        }""")
        page.reload()
        page.wait_for_load_state("networkidle")

        # 強制關閉任何彈出視窗，並鎖定 display: none !important
        page.evaluate("""() => {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.style.setProperty('display', 'none', 'important');
            }
        }""")

        # --- 驗證 1: 雨後彩虹背景顏色與前景雨絲 ---
        page.evaluate("window.__bgManager.setTheme('rain')")
        time.sleep(1.2)

        # 取得 #app-container computed background
        rain_bg_style = page.evaluate("""() => {
            const el = document.getElementById('app-container');
            const style = window.getComputedStyle(el);
            return {
                backgroundImage: style.backgroundImage,
                backgroundColor: style.backgroundColor,
                className: el.className
            };
        }""")

        # 檢查前景雨絲與花園島的重疊
        rain_overlap_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            const island = document.getElementById('home-island-svg');
            const islandRect = island.getBoundingClientRect();
            
            const fgTracks = Array.from(fg.querySelectorAll('.rain-track'));
            const bgTracks = Array.from(bg.querySelectorAll('.rain-track'));
            
            // 檢查前景雨絲位置是否落在小島 boundingBox 範圍內
            const fgOverlaps = fgTracks.map(t => {
                const r = t.getBoundingClientRect();
                const overlaps = !(r.right < islandRect.left || 
                                   r.left > islandRect.right || 
                                   r.bottom < islandRect.top || 
                                   r.top > islandRect.bottom);
                return {
                    top: t.style.top,
                    left: t.style.left,
                    rect: { top: r.top, left: r.left, width: r.width, height: r.height },
                    overlapsIsland: overlaps
                };
            });

            return {
                fgTrackCount: fgTracks.length,
                bgTrackCount: bgTracks.length,
                islandRect: { top: islandRect.top, left: islandRect.left, width: islandRect.width, height: islandRect.height },
                fgOverlaps: fgOverlaps
            };
        }""")

        rain_screenshot_path = os.path.join(OUTPUT_DIR, "01_rain_rainbow_verified.png")
        page.screenshot(path=rain_screenshot_path)
        results["rain"] = {
            "bgStyle": rain_bg_style,
            "rainOverlap": rain_overlap_info,
            "screenshot": rain_screenshot_path
        }

        # --- 驗證 2: 夢幻泡泡前景大泡泡蓋過花園島 ---
        page.evaluate("window.__bgManager.setTheme('bubbles')")
        # 等待泡泡動畫運行至花園島位置（或因為已設定負延遲，當前已有泡泡在花園島）
        time.sleep(1.5)

        bubbles_bg_style = page.evaluate("""() => {
            const el = document.getElementById('app-container');
            const style = window.getComputedStyle(el);
            return {
                backgroundImage: style.backgroundImage,
                className: el.className
            };
        }""")

        bubbles_overlap_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            const island = document.getElementById('home-island-svg');
            const islandRect = island.getBoundingClientRect();
            
            const fgBubbles = Array.from(fg.querySelectorAll('.anim-soap-bubble'));
            const bgBubbles = Array.from(bg.querySelectorAll('.anim-soap-bubble'));
            
            const fgDetails = fgBubbles.map(b => {
                const r = b.getBoundingClientRect();
                const svg = b.querySelector('svg');
                const overlaps = !(r.right < islandRect.left || 
                                   r.left > islandRect.right || 
                                   r.bottom < islandRect.top || 
                                   r.top > islandRect.bottom);
                return {
                    styleLeft: b.style.left,
                    styleBottom: b.style.bottom,
                    svgWidth: svg ? svg.getAttribute('width') : null,
                    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
                    overlapsIsland: overlaps
                };
            });

            return {
                fgBubbleCount: fgBubbles.length,
                bgBubbleCount: bgBubbles.length,
                islandRect: { top: islandRect.top, bottom: islandRect.bottom, left: islandRect.left, right: islandRect.right },
                fgDetails: fgDetails
            };
        }""")

        bubbles_screenshot_path = os.path.join(OUTPUT_DIR, "02_bubbles_foreground_verified.png")
        page.screenshot(path=bubbles_screenshot_path)
        results["bubbles"] = {
            "bgStyle": bubbles_bg_style,
            "bubblesOverlap": bubbles_overlap_info,
            "screenshot": bubbles_screenshot_path
        }

        # --- 驗證 3: 全螢幕花園頁面切換背景與前景效果 ---
        page.evaluate("""() => {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.style.setProperty('display', 'none', 'important');
        }""")
        page.click("#btn-enter-fullscreen-garden")
        time.sleep(0.8)
        page.evaluate("""() => {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.style.setProperty('display', 'none', 'important');
        }""")

        # 切換回雨後彩虹，截圖全螢幕
        page.evaluate("window.__bgManager.setTheme('rain')")
        time.sleep(1.2)
        fullscreen_rain_path = os.path.join(OUTPUT_DIR, "03_fullscreen_rain_verified.png")
        page.screenshot(path=fullscreen_rain_path)
        results["fullscreen_rain"] = fullscreen_rain_path

        # 切換至夢幻泡泡，截圖全螢幕
        page.evaluate("window.__bgManager.setTheme('bubbles')")
        time.sleep(1.2)
        fullscreen_bubbles_path = os.path.join(OUTPUT_DIR, "04_fullscreen_bubbles_verified.png")
        page.screenshot(path=fullscreen_bubbles_path)
        results["fullscreen_bubbles"] = fullscreen_bubbles_path

        browser.close()

    print(json.dumps(results, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    verify_and_capture()
