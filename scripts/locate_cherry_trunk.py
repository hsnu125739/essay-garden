from playwright.sync_api import sync_playwright
import os
from PIL import Image
import numpy as np

OUTPUT_DIR = r"d:\Antigravity workspaces\交通美地\scratch"
os.makedirs(OUTPUT_DIR, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 412, 'height': 915})
    page.goto('http://127.0.0.1:8765/index.html')
    page.wait_for_load_state('networkidle')
    page.evaluate("""() => {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.style.display = 'none';
        window.__bgManager.setTheme('morning');
    }""")
    
    # 截取基準無遮擋首頁截圖
    base_path = os.path.join(OUTPUT_DIR, "test_base_home.png")
    page.screenshot(path=base_path)
    
    # 取得櫻花樹的 DOM bounding box
    tree_box = page.evaluate("""() => {
        const tree = document.querySelector('#home-island-svg image[href*="fb_l1"]');
        if (!tree) return null;
        const r = tree.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    }""")
    print("Tree bounding box in viewport (412x915):", tree_box)
    browser.close()

# 用使用者框選的 65x44 模板匹配在 test_base_home.png 中的位置
template_path = r"C:\Users\wl020\.gemini\antigravity\brain\e87411b6-b4ee-4861-bf11-e827b02810d3\.system_generated\logs\media\step_2354_media_0.png"
template = np.array(Image.open(template_path).convert('RGB'))
base_img = np.array(Image.open(base_path).convert('RGB'))
th, tw, _ = template.shape
bh, bw, _ = base_img.shape

best_diff = float('inf')
best_loc = (0, 0)
for y in range(int(bh * 0.45), int(bh * 0.75), 1):
    for x in range(int(bw * 0.3), int(bw * 0.7), 1):
        diff = np.mean(np.abs(base_img[y:y+th, x:x+tw].astype(float) - template.astype(float)))
        if diff < best_diff:
            best_diff = diff
            best_loc = (x, y)

print(f"Template match in test_base_home: x={best_loc[0]}, y={best_loc[1]}, diff={best_diff}")
