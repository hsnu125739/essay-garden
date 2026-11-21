import os
import json
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def capture_meteor():
    print("【抓拍流星劃過前景花園島之實機截圖】")
    viewport_w = 412
    viewport_h = 915

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': viewport_w, 'height': viewport_h}, device_scale_factor=2)
        page = context.new_page()

        page.goto("http://127.0.0.1:8765/index.html?mode=local", wait_until="networkidle")
        page.wait_for_timeout(600)
        page.evaluate("document.getElementById('modal-overlay').style.display = 'none'")

        page.evaluate("window.__bgManager.setTheme('night')")

        # 抓取數個影格，尋找前景流星劃過島嶼的瞬間
        best_diff = 0
        best_shot = None

        # 基準（無流星時）
        page.screenshot(path=os.path.join(OUTPUT_DIR, "meteor_base.png"))
        base_img = Image.open(os.path.join(OUTPUT_DIR, "meteor_base.png")).convert('RGB')
        base_np = np.array(base_img)

        for i in range(25):
            page.wait_for_timeout(200)
            p_shot = os.path.join(OUTPUT_DIR, f"temp_meteor_{i}.png")
            page.screenshot(path=p_shot)
            img = Image.open(p_shot).convert('RGB')
            # 比較島嶼區域 (y: 800~1400, x: 200~700)
            crop_base = base_np[800:1400, 200:700]
            crop_curr = np.array(img)[800:1400, 200:700]
            diff = float(np.mean(np.abs(crop_curr.astype(float) - crop_base.astype(float))))
            if diff > best_diff:
                best_diff = diff
                best_shot = img
            os.remove(p_shot)

        if best_shot:
            saved_path = os.path.join(OUTPUT_DIR, "verify_06_meteor_foreground_streak.png")
            best_shot.save(saved_path)
            print(f"前景流星劃過小島瞬間截圖已儲存 (像素差異 {best_diff:.2f}): {saved_path}")

        browser.close()

if __name__ == "__main__":
    capture_meteor()
