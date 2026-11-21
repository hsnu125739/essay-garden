import os
import json
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def verify_dynamic_rainbow():
    print("=" * 70)
    print("【啟動彩虹動態位置與大小自適應驗證】")
    print("=" * 70)

    viewport_w = 412
    viewport_h = 915
    scale_factor = 2

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': viewport_w, 'height': viewport_h}, device_scale_factor=scale_factor)
        page = context.new_page()

        page.goto("http://127.0.0.1:8765/index.html?mode=local", wait_until="networkidle")
        page.evaluate("document.getElementById('modal-overlay').style.display = 'none'")

        # 切換到 rain 主題
        page.evaluate("window.__bgManager.setTheme('rain')")

        # 為了即時捕捉彩虹展開後的完整幾何，我們將動畫快進到彩虹完全顯現階段（例如 12s 時，或者手動觀察）
        # 先驗證首頁模式下的彩虹 stage wrapper 的幾何數值
        print("\n--- 1. 首頁模式下的彩虹幾何檢驗 ---")
        home_rainbow_geom = page.evaluate("""() => {
            const el = document.getElementById('rainbow-stage-container');
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const island = document.getElementById('home-island-svg')?.getBoundingClientRect();
            return {
                screen: document.getElementById('app-container').getAttribute('data-screen'),
                top: style.top,
                transform: style.transform,
                rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                islandRect: island ? { top: island.top, left: island.left, width: island.width, height: island.height } : null
            };
        }""")
        print(f"首頁彩虹幾何: {json.dumps(home_rainbow_geom, indent=2)}")

        # 暫時快進彩虹動畫到完全顯示（clip-path: 100%, opacity: 0.95）以抓拍首頁彩虹正中出現在島上的效果
        page.evaluate("""() => {
            const animEl = document.querySelector('.anim-rainbow-deep');
            if (animEl) {
                animEl.style.animation = 'none';
                animEl.style.opacity = '0.95';
                animEl.style.clipPath = 'polygon(0 0, 100% 0, 100% 100%, 0 100%)';
            }
        }""")
        page.wait_for_timeout(300)

        shot_home_rainbow = os.path.join(OUTPUT_DIR, "rainbow_01_home_on_island.png")
        page.screenshot(path=shot_home_rainbow)
        print(f"首頁彩虹橫跨島嶼實機截圖已儲存: {shot_home_rainbow}")

        # -------------------------------------------------------------
        # 2. 切換至全螢幕模式，檢驗瞬間切換幾何
        # -------------------------------------------------------------
        print("\n--- 2. 切換至全螢幕模式（彩虹顯現中瞬間響應） ---")
        page.evaluate("""() => {
            document.getElementById('btn-enter-fullscreen-garden')?.click();
        }""")
        page.wait_for_timeout(300)

        garden_rainbow_geom = page.evaluate("""() => {
            const el = document.getElementById('rainbow-stage-container');
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                screen: document.getElementById('app-container').getAttribute('data-screen'),
                top: style.top,
                transform: style.transform,
                rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
            };
        }""")
        print(f"全螢幕彩虹幾何: {json.dumps(garden_rainbow_geom, indent=2)}")

        shot_garden_rainbow = os.path.join(OUTPUT_DIR, "rainbow_02_fullscreen_sky.png")
        page.screenshot(path=shot_garden_rainbow)
        print(f"全螢幕天幕彩虹實機截圖已儲存: {shot_garden_rainbow}")

        # -------------------------------------------------------------
        # 3. 瞬間切換回首頁，驗證瞬間轉回首頁大小與位置
        # -------------------------------------------------------------
        print("\n--- 3. 瞬間切換回首頁（彩虹顯現中瞬間轉回） ---")
        page.evaluate("""() => {
            document.getElementById('btn-back-home')?.click();
        }""")
        page.wait_for_timeout(300)

        back_home_geom = page.evaluate("""() => {
            const el = document.getElementById('rainbow-stage-container');
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                screen: document.getElementById('app-container').getAttribute('data-screen'),
                top: style.top,
                transform: style.transform,
                rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
            };
        }""")
        print(f"切回首頁彩虹幾何: {json.dumps(back_home_geom, indent=2)}")

        shot_back_home = os.path.join(OUTPUT_DIR, "rainbow_03_back_home_instant.png")
        page.screenshot(path=shot_back_home)
        print(f"切回首頁彩虹瞬間實機截圖已儲存: {shot_back_home}")

        browser.close()

if __name__ == "__main__":
    verify_dynamic_rainbow()
