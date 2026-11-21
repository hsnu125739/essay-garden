import os
import urllib.request
import json
import re

token_path = r"C:\Users\wl020\.gemini\credentials\github_token.txt"
git_cred_path = r"C:\Users\wl020\.gemini\credentials\.git-credentials"

def check_github():
    print("=== 1. GitHub API Token 檢測 ===")
    if not os.path.exists(token_path):
        print(f"❌ Token 檔案不存在: {token_path}")
        return

    with open(token_path, "r", encoding="utf-8") as f:
        token = f.read().strip()

    req = urllib.request.Request(
        "https://api.github.com/user",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "Antigravity-Agent"
        }
    )

    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode("utf-8"))
            scopes = response.headers.get("X-OAuth-Scopes", "None")
            login = data.get("login")
            print(f"✅ 認證成功，登入帳號: {login}")
            print(f"   公開倉庫數: {data.get('public_repos')}")
            print(f"   Token 權限範圍 (Scopes): {scopes}")
            can_create = "repo" in scopes
            print(f"   創建專案權限 (repo scope): {'✅ 具備完整建立/管理權限' if can_create else '❌ 缺乏權限'}")
    except Exception as e:
        print(f"❌ GitHub API 請求失敗: {e}")

    print("\n=== 2. Git CLI 本機認證配置檢測 ===")
    if os.path.exists(git_cred_path):
        with open(git_cred_path, "r", encoding="utf-8") as f:
            creds = f.readlines()
        matched_users = []
        for line in creds:
            m = re.search(r"https://([^:]+):.*@github\.com", line)
            if m:
                matched_users.append(m.group(1))
        if matched_users:
            print(f"✅ .git-credentials 包含 GitHub 認證帳號: {', '.join(matched_users)}")
        else:
            print("⚠️ .git-credentials 存在但未找到 github.com 記錄")
    else:
        print(f"⚠️ 找不到 .git-credentials 檔案: {git_cred_path}")

if __name__ == "__main__":
    check_github()
