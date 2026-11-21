import os
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"

def snap_rainbow():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        page = context.new_page()

        page.goto("http://127.0.0.1:8765/index.html?mode=local", wait_until="networkidle")
        page.evaluate("document.getElementById('modal-overlay').style.display = 'none'")
        page.evaluate("window.__bgManager.setTheme('rain')")

        # 快進動畫或設定彩虹關鍵時間點
        # 18s 週期中，87% (約 15.6s) 正好是彩虹從左向右全透明消失的中間
        page.wait_for_timeout(400)
        shot_path = os.path.join(OUTPUT_DIR, "fix5_03_rainbow_fade_left_to_right.png")
        page.screenshot(path=shot_path)
        browser.close()

if __name__ == "__main__":
    snap_rainbow()
