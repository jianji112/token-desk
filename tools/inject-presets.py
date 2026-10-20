"""构建期注入「预设地址」：把 app/assets 复制到 build/assets，并替换 __PRESET_*__ 占位符。

开源仓库里 app.js 只有占位符；私人地址通过环境变量或 .env 传入，不会进仓库。

对应的环境变量（都可为空 → 界面上的一键切换按钮自动隐藏）：
    TD_PRESET_PUBLIC_NEWAPI   例 https://newapi.example.com
    TD_PRESET_PUBLIC_HUB      例 https://hub.example.com
    TD_PRESET_LAN_NEWAPI      例 http://192.0.2.10:3000
    TD_PRESET_LAN_HUB         例 http://192.0.2.10:8788

用法： python3 tools/inject-presets.py <源 assets 目录> <目标 assets 目录>
"""
import os
import re
import shutil
import sys

PLACEHOLDERS = {
    "__PRESET_PUBLIC_NEWAPI__": "TD_PRESET_PUBLIC_NEWAPI",
    "__PRESET_PUBLIC_HUB__": "TD_PRESET_PUBLIC_HUB",
    "__PRESET_LAN_NEWAPI__": "TD_PRESET_LAN_NEWAPI",
    "__PRESET_LAN_HUB__": "TD_PRESET_LAN_HUB",
}


def load_env_file(path):
    out = {}
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    envfile = load_env_file(os.environ.get("TD_ENV_FILE") or os.path.join(root, ".env"))

    values = {}
    for ph, var in PLACEHOLDERS.items():

        values[ph] = (os.environ[var] if var in os.environ else envfile.get(var, "")).strip()

    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

    js = os.path.join(dst, "app.js")
    with open(js, encoding="utf-8") as f:
        text = f.read()
    for ph, val in values.items():
        text = text.replace(ph, val)
    left = re.findall(r"__PRESET_[A-Z_]+__", text)
    if left:
        print("警告：仍有未替换的占位符 %s" % sorted(set(left)), file=sys.stderr)
    with open(js, "w", encoding="utf-8") as f:
        f.write(text)

    filled = [k for k, v in values.items() if v]
    print("预设地址已注入 %d 项（未注入的按钮会自动隐藏）" % len(filled))
    return 0


if __name__ == "__main__":
    sys.exit(main())
