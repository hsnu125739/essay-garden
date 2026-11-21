import os
import json
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\fix_previews"
os.makedirs(OUTPUT_DIR, exist_ok=True)

USER_CROP_PATH = r"C:\Users\wl020\.gemini\antigravity\brain\e87411b6-b4ee-4861-bf11-e827b02810d3\.system_generated\logs\media\step_2354_media_0.png"

def run_blackbox_test():
    print("=" * 70)
    print("【啟動金標準黑箱測試：大型純黑色不透明方塊 (0.6 螢幕寬度) 遮擋櫻花樹樹幹驗收】")
    print("=" * 70)

    viewport_w = 412
    viewport_h = 915
    scale_factor = 2 # 採用 2x Retina 截圖

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

        # -------------------------------------------------------------
        # 步驟 1：截取無遮擋基準圖，並精確定位櫻花樹與使用者框選區域
        # -------------------------------------------------------------
        page.evaluate("window.__bgManager.setTheme('morning')")
        page.wait_for_timeout(400)

        baseline_full_path = os.path.join(OUTPUT_DIR, "blackbox_01_baseline_full.png")
        page.screenshot(path=baseline_full_path)

        # 取得櫻花樹 DOM 邊界 (CSS 像素)
        cherry_rect = page.evaluate("""() => {
            const el = document.querySelector('#home-island-svg image[href*="fb_l1"]');
            if (!el) throw new Error('Cannot find fb_l1 cherry tree image on home island!');
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }""")
        print(f"櫻花樹 DOM 邊界 (CSS px): {cherry_rect}")

        # 使用使用者框選的 65x44 模板在基準圖中精準匹配
        template_img = Image.open(USER_CROP_PATH).convert('RGB')
        template_np = np.array(template_img)
        th, tw, _ = template_np.shape
        print(f"使用者框選區域尺寸: {tw}x{th} px")

        base_img = Image.open(baseline_full_path).convert('RGB')
        base_np = np.array(base_img)
        bh, bw, _ = base_np.shape

        # 在櫻花樹附近 (以 scale_factor 放大) 進行最佳匹配
        search_min_x = max(0, int((cherry_rect['left'] - 20) * scale_factor))
        search_max_x = min(bw - tw, int((cherry_rect['left'] + cherry_rect['width'] + 20) * scale_factor))
        search_min_y = max(0, int((cherry_rect['top'] - 20) * scale_factor))
        search_max_y = min(bh - th, int((cherry_rect['top'] + cherry_rect['height'] + 20) * scale_factor))

        best_diff = float('inf')
        match_x, match_y = search_min_x, search_min_y

        for y in range(search_min_y, search_max_y, 1):
            for x in range(search_min_x, search_max_x, 1):
                diff = np.mean(np.abs(base_np[y:y+th, x:x+tw].astype(float) - template_np.astype(float)))
                if diff < best_diff:
                    best_diff = diff
                    match_x, match_y = x, y

        print(f"在 2x 基準截圖中精準鎖定使用者框選樹幹區域: x={match_x}, y={match_y}, diff={best_diff:.2f}")

        # 裁切基準圖上的樹幹部位
        trunk_baseline_crop = base_img.crop((match_x, match_y, match_x + tw, match_y + th))
        trunk_baseline_path = os.path.join(OUTPUT_DIR, "blackbox_02_trunk_baseline.png")
        trunk_baseline_crop.save(trunk_baseline_path)

        # -------------------------------------------------------------
        # 步驟 2：執行使用者要求之黑箱測試配置
        # 「將泡泡改成大型純黑色不透明方塊(w=h=0.6螢幕寬度)，覆蓋在櫻花樹樹幹部位」
        # -------------------------------------------------------------
        box_size_css = round(viewport_w * 0.6) # 0.6 * 412 = 247 px
        print(f"依使用者規格配置黑箱方塊: w=h=0.6*螢幕寬度 = {box_size_css}px, 純黑色 #000000, 不透明度 1.0")

        # 切換到 bubbles 主題，並將前景泡泡替換為大型純黑方塊，正中置於櫻花樹中心
        page.evaluate(f"""() => {{
            window.__bgManager.setTheme('bubbles');

            // 確保前景層 z-index 為 25 !important
            const fg = document.getElementById('dynamic-fg-layer');
            fg.style.setProperty('z-index', '25', 'important');
            fg.style.setProperty('pointer-events', 'none', 'important');

            // 建立大型純黑色不透明方塊
            const cx = {cherry_rect['cx']};
            const cy = {cherry_rect['cy']};
            const size = {box_size_css};

            fg.innerHTML = `
              <div id="black-box-test-target"
                   style="position: absolute;
                          left: ${{cx - size / 2}}px;
                          top: ${{cy - size / 2}}px;
                          width: ${{size}}px;
                          height: ${{size}}px;
                          background-color: #000000;
                          opacity: 1 !important;
                          z-index: 25;
                          pointer-events: none;">
              </div>
            `;
        }}""")

        page.wait_for_timeout(400)

        # 檢查該方塊與前景層的 computedStyle
        fg_check = page.evaluate("""() => {
            const fg = document.getElementById('dynamic-fg-layer');
            const target = document.getElementById('black-box-test-target');
            const tree = document.querySelector('#home-island-svg image[href*="fb_l1"]');
            const fgStyle = window.getComputedStyle(fg);
            const targetStyle = window.getComputedStyle(target);
            const treeStyle = window.getComputedStyle(tree.parentElement);
            return {
                fg_zIndex: fgStyle.zIndex,
                target_bg: targetStyle.backgroundColor,
                target_opacity: targetStyle.opacity,
                target_rect: target.getBoundingClientRect(),
                tree_zIndex: treeStyle.zIndex
            };
        }""")
        print(f"黑箱目標 DOM 與 Computed Style: {json.dumps(fg_check, indent=2)}")

        # -------------------------------------------------------------
        # 步驟 3：截取帶有黑箱方塊之實機截圖，並裁切同一個樹幹部位進行像素分析
        # -------------------------------------------------------------
        blackbox_full_path = os.path.join(OUTPUT_DIR, "blackbox_03_occluded_full.png")
        page.screenshot(path=blackbox_full_path)

        occluded_img = Image.open(blackbox_full_path).convert('RGB')
        trunk_occluded_crop = occluded_img.crop((match_x, match_y, match_x + tw, match_y + th))
        trunk_occluded_path = os.path.join(OUTPUT_DIR, "blackbox_04_trunk_occluded.png")
        trunk_occluded_crop.save(trunk_occluded_path)

        browser.close()

    # -------------------------------------------------------------
    # 步驟 4：像素量化判定（必須全部像素變為純黑 (0, 0, 0)）
    # -------------------------------------------------------------
    trunk_pixels = np.array(trunk_occluded_crop)
    total_pixels = tw * th
    black_pixels = np.sum((trunk_pixels[:, :, 0] == 0) & (trunk_pixels[:, :, 1] == 0) & (trunk_pixels[:, :, 2] == 0))
    non_black_pixels = total_pixels - black_pixels
    black_percentage = (black_pixels / total_pixels) * 100.0

    print("-" * 60)
    print(f"【黑箱樹幹區域像素判定結果】")
    print(f"總像素數: {total_pixels} px (區域寬 {tw} × 高 {th})")
    print(f"純黑 (0,0,0) 像素數: {black_pixels} px")
    print(f"非黑色像素數: {non_black_pixels} px")
    print(f"全黑覆蓋率: {black_percentage:.2f}%")
    print("-" * 60)

    # 產生並排對比圖（基準圖 vs 使用者框選 vs 黑箱遮擋）
    side_by_side = Image.new('RGB', (tw * 3 + 40, th + 40), (255, 255, 255))
    side_by_side.paste(trunk_baseline_crop, (10, 20))
    side_by_side.paste(template_img, (tw + 20, 20))
    side_by_side.paste(trunk_occluded_crop, (tw * 2 + 30, 20))
    comparison_path = os.path.join(OUTPUT_DIR, "blackbox_05_cherry_trunk_comparison.png")
    side_by_side.save(comparison_path)
    print(f"已生成黑箱驗收三聯對比圖: {comparison_path}")

    if black_pixels == total_pixels:
        print(">>> 判定: ✅ PASSED! 使用者框選區域 100% 完全被純黑色方塊遮擋，前景層成功覆蓋在櫻花樹前方！")
        return True
    else:
        print(">>> 判定: ❌ FAILED! 該區域未能 100% 變為全黑，遮擋失敗！")
        return False

if __name__ == "__main__":
    success = run_blackbox_test()
    exit(0 if success else 1)
