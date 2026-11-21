import os
import urllib.request
import urllib.error
import json

token_path = r"C:\Users\wl020\.gemini\credentials\github_token.txt"

def create_repo():
    with open(token_path, "r", encoding="utf-8") as f:
        token = f.read().strip()

    repo_data = {
        "name": "essay-garden",
        "description": "美地隨筆 - 隨筆花園 Essay Garden",
        "private": True,
        "auto_init": False
    }

    req = urllib.request.Request(
        "https://api.github.com/user/repos",
        data=json.dumps(repo_data).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "Antigravity-Agent"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            print(f"✅ 成功創建 GitHub 倉庫: {res_data.get('full_name')}")
            print(f"   可見性: {'Private' if res_data.get('private') else 'Public'}")
            print(f"   Clone URL: {res_data.get('clone_url')}")
            print(f"   HTML URL: {res_data.get('html_url')}")
            return True, res_data
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"❌ 創建失敗 (HTTP {e.code}): {error_body}")
        # 如果倉庫已存在
        if e.code == 422:
            print("提示: 該倉庫可能已存在。")
        return False, error_body
    except Exception as e:
        print(f"❌ 發生異常: {e}")
        return False, str(e)

if __name__ == "__main__":
    create_repo()
