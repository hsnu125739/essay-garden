import os
import json
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)
USER_CROP_PATH = r"C:\Users\wl020\.gemini\antigravity\brain\e87411b6-b4ee-4861-bf11-e827b02810d3\.system_generated\logs\media\step_2354_media_0.png"

def capture_real_occlusions():
    print("=" * 70)
    print("【啟動實機抓拍：正式夢幻泡泡與雨絲前景遮擋櫻花樹樹幹驗收】")
    print("=" * 70)

    viewport_w = 412
    viewport_h = 915
    scale_factor = 2

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': viewport_w, 'height': viewport_h}, device_scale_factor=scale_factor)
        page = context.new_page()

        # 載入 Local 模式以取得完整的花園神木
        page.goto("http://127.0.0.1:8765/index.html?mode=local", wait_until="networkidle")
        page.wait_for_timeout(800)

        # 確保關閉 modal
        page.evaluate("""() => {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) overlay.style.display = 'none';
        }""")

        # 1. 取得基準圖
        page.evaluate("window.__bgManager.setTheme('morning')")
        page.wait_for_timeout(400)
        baseline_full_path = os.path.join(OUTPUT_DIR, "real_01_baseline_morning.png")
        page.screenshot(path=baseline_full_path)

        # 櫻花樹定位
        template_img = Image.open(USER_CROP_PATH).convert('RGB')
        template_np = np.array(template_img)
        th, tw, _ = template_np.shape

        base_img = Image.open(baseline_full_path).convert('RGB')
        base_np = np.array(base_img)
        bh, bw, _ = base_np.shape

        match_x, match_y = 383, 1098
        trunk_baseline = base_img.crop((match_x, match_y, match_x + tw, match_y + th))
        trunk_baseline.save(os.path.join(OUTPUT_DIR, "real_02_trunk_baseline.png"))

        # 2. 測試正式泡泡場景：抓拍泡泡升騰時完全穿過櫻花樹的瞬間
        print("切換至【夢幻泡泡】場景，監測泡泡升騰覆蓋櫻花樹...")
        page.evaluate("window.__bgManager.setTheme('bubbles')")

        # 檢查前景層 z-index 與子元素數量
        fg_info = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const bg = document.getElementById('dynamic-bg-layer');
            return {
                fg_zIndex: window.getComputedStyle(fg).zIndex,
                fg_children: fg.children.length,
                bg_zIndex: window.getComputedStyle(bg).zIndex,
                bg_children: bg.children.length
            };
        }""")
        print(f"泡泡場景圖層資訊: {json.dumps(fg_info, indent=2)}")

        # 搜尋泡泡通過樹幹的最佳影格
        best_bubble_diff = 0
        best_bubble_frame = None
        best_bubble_crop = None

        # 採樣 20 個影格（間隔 200ms，共 4 秒）
        for i in range(20):
            page.wait_for_timeout(200)
            shot_path = os.path.join(OUTPUT_DIR, f"temp_bubble_{i}.png")
            page.screenshot(path=shot_path)
            shot_img = Image.open(shot_path).convert('RGB')
            crop = shot_img.crop((match_x, match_y, match_x + tw, match_y + th))
            diff = float(np.mean(np.abs(np.array(crop).astype(float) - np.array(trunk_baseline).astype(float))))
            if diff > best_bubble_diff:
                best_bubble_diff = diff
                best_bubble_frame = shot_img
                best_bubble_crop = crop
            os.remove(shot_path)

        bubble_full_path = os.path.join(OUTPUT_DIR, "real_03_bubble_full.png")
        best_bubble_frame.save(bubble_full_path)
        bubble_crop_path = os.path.join(OUTPUT_DIR, "real_04_bubble_trunk_crop.png")
        best_bubble_crop.save(bubble_crop_path)
        print(f"泡泡覆蓋樹幹最大像素差異: {best_bubble_diff:.2f}")

        # 3. 測試雨後彩虹場景
        print("切換至【雨後彩虹】場景，監測雨絲橫切櫻花樹...")
        page.evaluate("window.__bgManager.setTheme('rain')")

        best_rain_diff = 0
        best_rain_frame = None
        best_rain_crop = None

        # 採樣 20 個影格
        for i in range(20):
            page.wait_for_timeout(150)
            shot_path = os.path.join(OUTPUT_DIR, f"temp_rain_{i}.png")
            page.screenshot(path=shot_path)
            shot_img = Image.open(shot_path).convert('RGB')
            crop = shot_img.crop((match_x, match_y, match_x + tw, match_y + th))
            diff = float(np.mean(np.abs(np.array(crop).astype(float) - np.array(trunk_baseline).astype(float))))
            if diff > best_rain_diff:
                best_rain_diff = diff
                best_rain_frame = shot_img
                best_rain_crop = crop
            os.remove(shot_path)

        rain_full_path = os.path.join(OUTPUT_DIR, "real_05_rain_full.png")
        best_rain_frame.save(rain_full_path)
        rain_crop_path = os.path.join(OUTPUT_DIR, "real_06_rain_trunk_crop.png")
        best_rain_crop.save(rain_crop_path)
        print(f"雨絲切過樹幹最大像素差異: {best_rain_diff:.2f}")

        # 產生四聯對比圖（基準樹幹 vs 使用者框選 vs 泡泡遮擋 vs 雨絲遮擋）
        combo = Image.new('RGB', (tw * 4 + 50, th + 40), (255, 255, 255))
        combo.paste(trunk_baseline, (10, 20))
        combo.paste(template_img, (tw + 20, 20))
        combo.paste(best_bubble_crop, (tw * 2 + 30, 20))
        combo.paste(best_rain_crop, (tw * 3 + 40, 20))
        combo_path = os.path.join(OUTPUT_DIR, "real_07_cherry_occlusions_quad.png")
        combo.save(combo_path)
        print(f"四聯對比圖已儲存: {combo_path}")

        browser.close()

if __name__ == "__main__":
    capture_real_occlusions()
