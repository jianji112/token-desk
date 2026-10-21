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

# 残留检测：允许中间带非 ASCII 字符（占位符名字曾漂移成 __PRESET_PUBLIC_账号池__ 而漏检）；
# 但不吃 * 通配（源码注释里的 __PRESET_*__ 属于说明文字，不该每次构建都报警）
PLACEHOLDER_RE = re.compile(r"__PRESET_[A-Za-z0-9_\u4e00-\u9fff]*__")


def check_placeholders(src_text, src_js):
    """替换前校验：PLACEHOLDERS 里每个占位符都必须能在源 app.js 里找到。

    为什么要这道守卫：text.replace 找不到目标时不报错，注入会静默失效，
    `__PRESET_x__` 字面量原样打进 APK（历史上 HUB 两个占位符名字与这里不一致，
    从引入起就从未生效）。名字一漂移就在这里构建期失败，并列出缺哪个。
    返回缺失的占位符列表（空列表 = 通过）。
    """
    missing = [ph for ph in PLACEHOLDERS if ph not in src_text]
    if not missing:
        return []
    print("错误：源 app.js 缺少占位符，注入会静默失效（%s）" % src_js, file=sys.stderr)
    for ph in missing:
        print("  缺少 %-26s ← 对应环境变量 %s" % (ph, PLACEHOLDERS[ph]), file=sys.stderr)
    found = sorted(set(PLACEHOLDER_RE.findall(src_text)))
    if found:
        print("  源里实际出现的占位符：%s" % ", ".join(found), file=sys.stderr)
        print("  提示：占位符名必须与 tools/inject-presets.py 的 PLACEHOLDERS 键逐字一致（大小写敏感）", file=sys.stderr)
    return missing



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

    # 替换前先校验占位符存在性——名字漂移必须在构建期失败，不能静默出包
    src_js = os.path.join(src, "app.js")
    if not os.path.isfile(src_js):
        print("错误：源目录里没有 app.js：%s" % src_js, file=sys.stderr)
        return 1
    with open(src_js, encoding="utf-8") as f:
        src_text = f.read()
    if check_placeholders(src_text, src_js):
        return 1

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
    left = sorted(set(PLACEHOLDER_RE.findall(text)))
    if left:
        # 只告警不失败：源码注释里可能合法地写着 __PRESET_*__ 这类说明文字。
        # 真正的守卫是函数开头的存在性校验（名字漂移会在那里 exit 1）。
        print("警告：仍有未替换的占位符 %s" % left, file=sys.stderr)
    with open(js, "w", encoding="utf-8") as f:
        f.write(text)

    filled = [k for k, v in values.items() if v]
    print("预设地址已注入 %d 项（未注入的按钮会自动隐藏）" % len(filled))
    return 0


if __name__ == "__main__":
    sys.exit(main())
