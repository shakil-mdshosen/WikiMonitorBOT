import json, base64, os, requests
from config import GITHUB_TOKEN, GITHUB_REPO, GITHUB_FILE_PATH, GITHUB_BRANCH

def load_settings():
    if os.path.exists(GITHUB_FILE_PATH):
        with open(GITHUB_FILE_PATH, "r") as f:
            return json.load(f)
    return {}

def save_settings_locally(settings):
    with open(GITHUB_FILE_PATH, "w") as f:
        json.dump(settings, f, indent=2)

def update_github(settings):
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{GITHUB_FILE_PATH}?ref={GITHUB_BRANCH}"
    headers = {"Authorization": f"token {GITHUB_TOKEN}"}

    r = requests.get(url, headers=headers)
    sha = r.json()["sha"] if r.status_code == 200 else None

    content_b64 = base64.b64encode(json.dumps(settings, indent=2).encode()).decode()
    payload = {
        "message": "Update wiki settings",
        "content": content_b64,
        "branch": GITHUB_BRANCH,
    }
    if sha:
        payload["sha"] = sha

    r2 = requests.put(f"https://api.github.com/repos/{GITHUB_REPO}/contents/{GITHUB_FILE_PATH}",
                      headers=headers, json=payload)
    return r2.status_code in [200, 201]
