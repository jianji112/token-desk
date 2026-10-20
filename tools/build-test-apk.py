"""构建「带测试配置」的验证包（仅用于装机自测，绝不外发）。

把 app/assets 复制到临时目录 tokendesk-assets（build.sh 会清空 build/，所以不能放 build 里），注入 bootstrap.js（读项目根 .env 或环境变量的真实凭证），
再调 build.sh 输出 dist/tokendesk-test.apk。

用法：python3 tools/build-test-apk.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "app", "assets")
STAGE = os.path.join(tempfile.gettempdir(), "tokendesk-assets")
ENV = os.path.join(ROOT, ".env")


def load_env():
    out = {}
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v.strip().strip('"').strip("'")
    return out


def main():
    env = load_env()
    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    shutil.copytree(ASSETS, STAGE)
    boot = {

        "newapiBase": os.environ.get("TD_NEWAPI_BASE", ""),
        "newapiToken": env.get("NEWAPI_ACCESS_TOKEN", ""),
        "newapiUid": env.get("NEWAPI_USER_ID", "1"),
        "hubBase": os.environ.get("TD_HUB_BASE", ""),
        "hubPass": env.get("WB_HUB_PANEL_PASS", ""),
        "range": "24h",
        "maxPages": "80",
        "channel": os.environ.get("TD_CHANNEL", "browser"),
    }
    with open(os.path.join(STAGE, "bootstrap.js"), "w", encoding="utf-8") as f:
        f.write("window.__BOOTSTRAP__ = " + json.dumps(boot, ensure_ascii=False) + ";\n")
    print("凭证已注入（%d 项）" % len([k for k, v in boot.items() if v]))

    cmd = [os.path.join(ROOT, "build.sh")]

    e = dict(os.environ, TD_ASSETS_DIR=STAGE, TD_APK_NAME="tokendesk-test.apk", TD_DEBUG="1")
    r = subprocess.run(cmd, env=e, cwd=ROOT)
    if r.returncode != 0:
        return r.returncode
    apk = os.path.join(ROOT, "dist", "tokendesk-test.apk")
    print("测试包:", apk, os.path.getsize(apk), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
