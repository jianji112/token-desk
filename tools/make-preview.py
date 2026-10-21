#!/usr/bin/env python3
"""生成 README 展示图：用 App 真实资源 + 虚构数据渲染三屏样机。"""
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from websockets.sync.client import connect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "app", "assets")
OUT = os.path.join(ROOT, "docs", "screenshots", "preview.png")
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_B = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
TMP_HTML = os.path.join(ROOT, "tools", ".preview-tmp.html")
PORT = 9333
SHOT_W, SHOT_H = 407, 837
SCALE = 3.0

CHROME = shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")


def now():
    return int(time.time())


def build_tokens():
    return [
        {"id": 1, "name": "研发主力", "status": 1, "unlimited": True, "remain": 0,
         "used": 12768493, "expired": -1, "accessed": now() - 96, "models": [], "raw": {}},
        {"id": 2, "name": "内容生产", "status": 1, "unlimited": True, "remain": 0,
         "used": 6656164, "expired": -1, "accessed": now() - 640, "models": [], "raw": {}},
        {"id": 3, "name": "离线批处理", "status": 1, "unlimited": True, "remain": 0,
         "used": 3586301, "expired": -1, "accessed": now() - 3900, "models": [], "raw": {}},
        {"id": 4, "name": "测试临时", "status": 2, "unlimited": True, "remain": 0,
         "used": 1260274, "expired": -1, "accessed": now() - 86400 * 2, "models": [
             "gpt-4o-mini", "deepseek-chat", "qwen3-max"], "raw": {}},
        {"id": 5, "name": "翻译小助手", "status": 1, "unlimited": True, "remain": 0,
         "used": 398630, "expired": -1, "accessed": now() - 18000, "models": [], "raw": {}},
        {"id": 6, "name": "临时验证", "status": 1, "unlimited": False, "remain": 420000,
         "used": 56849, "expired": now() + 86400 * 40, "accessed": now() - 86400 * 5, "models": [], "raw": {}},
    ]


def build_usage():
    by_key = {
        "#1": {"name": "研发主力", "req": 842, "tokens": 67550000, "prompt": 64100000,
               "completion": 3450000, "quota": 463014, "models": {}},
        "#2": {"name": "内容生产", "req": 276, "tokens": 35210000, "prompt": 33400000,
               "completion": 1810000, "quota": 241096, "models": {}},
        "#3": {"name": "离线批处理", "req": 121, "tokens": 19020000, "prompt": 18400000,
               "completion": 620000, "quota": 130137, "models": {}},
        "#4": {"name": "测试临时", "req": 47, "tokens": 6680000, "prompt": 6000000,
               "completion": 680000, "quota": 45890, "models": {}},
    }
    by_model = {
        "gpt-4o-mini": {"req": 812, "tokens": 78800000},
        "claude-sonnet-4": {"req": 246, "tokens": 29100000},
        "deepseek-chat": {"req": 118, "tokens": 12600000},
        "gemini-2.5-pro": {"req": 76, "tokens": 6100000},
        "qwen3-max": {"req": 34, "tokens": 1900000},
    }
    recent = []
    seeds = [("研发主力", "gpt-4o-mini", 12480, 860, 921, 3120, 880, "high"),
             ("内容生产", "claude-sonnet-4", 8960, 1440, 1180, 4680, 1120, "high"),
             ("研发主力", "deepseek-chat", 15220, 640, 733, 2240, 520, "max"),
             ("离线批处理", "gemini-2.5-pro", 24800, 1980, 1560, 6120, 1640, "high"),
             ("研发主力", "gpt-4o-mini", 6420, 420, 486, 1740, 610, "high"),
             ("测试临时", "qwen3-max", 3120, 1680, 402, 2980, 720, "none"),
             ("内容生产", "gpt-4o-mini", 11400, 720, 812, 2560, 690, "high"),
             ("研发主力", "claude-sonnet-4", 9840, 1260, 1044, 3820, 980, "max")]
    for i in range(20):
        nm, md, pt, ct, q, tm, tt, ef = seeds[i % len(seeds)]
        recent.append({"created_at": now() - 42 - i * 86 - (i * 13) % 40,
                       "token_name": nm, "model_name": md,
                       "prompt_tokens": pt + (i * 137) % 900, "completion_tokens": ct + (i * 29) % 120,
                       "quota": q, "total_ms": tm, "ttft_ms": tt, "bad": 0, "effort": ef})
    return {
        "range": "24h", "since": now() - 86400, "label": "最近 24 小时",
        "req": 1286, "prompt": 121900000, "completion": 6560000, "total": 128460000,
        "quota": 896576, "pages": 14, "capped": False, "aborted": False,
        "local": True, "filling": False, "partial": None, "at": now() - 1800,
        "byKey": by_key, "byModel": by_model, "recent": recent,
    }


def build_rawlog():
    rows = []
    base = now() - 86400
    names = [("1", "研发主力", "gpt-4o-mini"), ("2", "内容生产", "claude-sonnet-4"),
             ("3", "离线批处理", "gemini-2.5-pro"), ("4", "测试临时", "qwen3-max")]
    total = 12486
    for i in range(total):
        tid, tname, model = names[i % 4]
        ts = base + int(i * 86400 / total)
        pt = 600 + (i * 37) % 18000
        ct = 80 + (i * 13) % 2000
        rows.append([ts, tid, tname, model, pt, ct, (pt + ct) // 14,
                     1200 + (i * 71) % 4000, 420 + (i * 29) % 900, 0])
    return {
        "at": now() - 1800, "since": base, "newest": rows[-1][0],
        "pages": 125, "complete": False, "coverFrom": base,
        "scan": None, "rows": rows,
    }


def build_wb():
    accounts = [
        {"uid": "a1b2c3d4e5f60001", "nickname": "主力账号", "realm": "cn", "enabled": True,
         "credits": {"remain": 128400000, "used": 86400000, "size": 214800000,
                     "earliest_expiring": {"cycle_end_time": "2026-11-08 00:00:00"},
                     "checkin": {"active": True, "today_checked_in": True, "streak_days": 12},
                     "packages": [
                         {"remain": 3200.0, "expire_time": "2026-11-08 09:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 1800.0, "expire_time": "2026-11-08 15:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 2400.0, "expire_time": "2026-11-15 09:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 1100.0, "expire_time": "2026-11-22 09:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 950.0, "expire_time": "2026-11-29 09:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 600.0, "expire_time": "2026-12-06 09:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 500.0, "expire_time": None, "is_expired": False, "no_expiry": True}]},
         "modelCooldowns": [], "disabledModels": []},
        {"uid": "a1b2c3d4e5f60002", "nickname": "备用账号", "realm": "intl", "enabled": True,
         "credits": {"remain": 74100000, "used": 41200000, "size": 115300000,
                     "earliest_expiring": {"cycle_end_time": "2026-11-15 00:00:00"},
                     "checkin": {"active": True, "today_checked_in": True, "streak_days": 5},
                     "packages": [
                         {"remain": 2100.0, "expire_time": "2026-11-15 10:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 1500.0, "expire_time": "2026-11-22 10:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 800.0, "expire_time": "2026-11-29 10:00:00", "is_expired": False, "no_expiry": False}]},
         "modelCooldowns": [], "disabledModels": []},
        {"uid": "a1b2c3d4e5f60003", "nickname": "测试账号", "realm": "cn", "enabled": True,
         "credits": {"remain": 52300000, "used": 31800000, "size": 84100000,
                     "earliest_expiring": {"cycle_end_time": "2026-11-02 00:00:00"},
                     "checkin": {"active": True, "today_checked_in": False, "streak_days": 2},
                     "packages": [
                         {"remain": 450.0, "expire_time": "2026-11-02 12:00:00", "is_expired": False, "no_expiry": False},
                         {"remain": 320.0, "expire_time": "2026-11-09 12:00:00", "is_expired": False, "no_expiry": False}]},
         "modelCooldowns": [{"model": "gpt-4o-mini", "expiresAt": now() + 3600 * 6,
                             "startedAt": now() - 3600 * 2}],
         "disabledModels": []},
        {"uid": "a1b2c3d4e5f60004", "nickname": "备用二", "realm": "intl", "enabled": True,
         "credits": {"remain": 31700000, "used": 18600000, "size": 50300000,
                     "earliest_expiring": {"cycle_end_time": "2026-11-20 00:00:00"},
                     "checkin": {"active": True, "today_checked_in": True, "streak_days": 3},
                     "packages": [
                         {"remain": 1200.0, "expire_time": "2026-11-20 14:00:00", "is_expired": False, "no_expiry": False}]},
         "modelCooldowns": [], "disabledModels": []},
        {"uid": "a1b2c3d4e5f60005", "nickname": "归档账号", "realm": "cn", "enabled": False,
         "inCooldown": True,
         "credits": {"remain": 0, "used": 84200000, "size": 84200000,
                     "earliest_expiring": None,
                     "checkin": {"active": True, "today_checked_in": True, "streak_days": 0},
                     "packages": []},
         "modelCooldowns": [], "disabledModels": ["deepseek-chat"]},
    ]
    creds = {"a1b2c3d4e5f60001": 6.20, "a1b2c3d4e5f60002": 2.80, "a1b2c3d4e5f60003": 1.15,
             "a1b2c3d4e5f60004": 0.42, "a1b2c3d4e5f60005": 0.0}
    return {
        "at": now() - 240,
        "health": {"ok": True, "realm": "all", "accounts": 5, "accounts_ready": 5},
        "accounts": {"accounts": accounts},
        "credToday": {"accounts": [{"uid": k, "window": {"credit": v}} for k, v in creds.items()]},
        "analytics": {
            "realm": "all",
            "summary": {"all_time": {"total_tokens": 2846000000, "requests": 41982, "errors": 96,
                                     "cache_hit_pct": 38.4, "ttft_ms_avg": 742, "elapsed_ms_avg": 3180,
                                     "speed_avg": 86}},
            "accounts": [{"uid": k, "window": {"credit": v}, "all_time": {"credit": v * 28}}
                         for k, v in creds.items()],
            "keys": [{"name": "研发主力", "key": "k1", "realm": "cn", "all_time": {
                "total_tokens": 1682000000, "requests": 24800, "cache_hit_pct": 41.2}},
                {"name": "内容生产", "key": "k2", "realm": "cn", "all_time": {
                    "total_tokens": 862000000, "requests": 12100, "cache_hit_pct": 33.8}},
                {"name": "离线批处理", "key": "k3", "realm": "intl", "all_time": {
                    "total_tokens": 301000000, "requests": 5082, "cache_hit_pct": 29.6}}],
        },
        "analyticsCn": {"models": [{"model": "gpt-4o-mini", "window": {"requests": 812}},
                                   {"model": "deepseek-chat", "window": {"requests": 118}},
                                   {"model": "qwen3-max", "window": {"requests": 34}},
                                   {"model": "gemini-2.5-pro", "window": {"requests": 76}}]},
        "analyticsIntl": {"models": [{"model": "claude-sonnet-4", "window": {"requests": 246}}]},
        "remain": {"models": [
            {"realm": "cn", "model": "gpt-4o-mini", "available": 3, "cooling": 0, "total_remaining": 31200000},
            {"realm": "intl", "model": "claude-sonnet-4", "available": 2, "cooling": 0, "total_remaining": 18600000},
            {"realm": "cn", "model": "deepseek-chat", "available": 1, "cooling": 1, "total_remaining": 12600000},
            {"realm": "cn", "model": "gemini-2.5-pro", "available": 2, "cooling": 0, "total_remaining": 8800000},
            {"realm": "cn", "model": "qwen3-max", "available": 1, "cooling": 0, "total_remaining": 4200000},
            {"realm": "intl", "model": "kimi-k2", "available": 1, "cooling": 0, "total_remaining": 2100000},
        ], "rows": [
            {"uid": "m1", "nickname": "主力账号", "realm": "cn", "model": "deepseek-chat", "cooling": True,
             "reset_at": time.time() + 9.8 * 3600},
            {"uid": "m2", "nickname": "备用账号", "realm": "cn", "model": "deepseek-chat", "cooling": True,
             "reset_at": time.time() + 40 * 60},
            {"uid": "m3", "nickname": "主力账号", "realm": "cn", "model": "gpt-4o-mini", "cooling": False,
             "reset_at": 0},
        ]},
        "models": {
            "cn": [{"id": "gpt-4o-mini", "credits": "x1.00"}, {"id": "deepseek-chat", "credits": "x0.28"},
                   {"id": "qwen3-max", "credits": "x0.60"}, {"id": "gemini-2.5-pro", "credits": "x0.00"}],
            "intl": [{"id": "claude-sonnet-4", "credits": "x3.00"}, {"id": "kimi-k2", "credits": "x0.00"}],
        },
    }


def build_cred():
    acct = {"研发主力": "a1b2c3d4e5f60001", "内容生产": "a1b2c3d4e5f60002",
            "离线批处理": "a1b2c3d4e5f60003", "测试临时": "a1b2c3d4e5f60004",
            "备用二": "a1b2c3d4e5f60005"}
    idx = {}
    for r in build_usage()["recent"]:
        model = r["model_name"]
        realm = "intl" if model.startswith("global:") else "cn"
        model = re.sub(r"^(cn|global):", "", model)
        key = "%s|%s|%d|%d" % (realm, model, r["prompt_tokens"], r["completion_tokens"])
        idx[key] = {
            "cr": round(0.02 + (r["prompt_tokens"] + r["completion_tokens"]) / 90000.0, 2),
            "uid": acct.get(r["token_name"], "a1b2c3d4e5f60001"),
        }
    return idx


INJECT = """
(function(){
  var A = window.__app;
  if (!A) return 'no __app';
  var S = A.state, C = A.cfg();
  C.range = '24h'; C.accRealm = 'all'; C.privacy = false;
  A.rawClear();
  localStorage.setItem('tokendesk.rawlog.v2', JSON.stringify(__RAW__));
  S.errors = {}; S.busy = {}; S.usageLive = null;
  S.tokens = __TOKENS__;
  S.over = {at: Date.now(), tokenTotal: 6, tokenTruncated: false};
  S.rate = {unit: 500000, cny: 7.3, sym: '\\u00a5', kind: 'CNY'};
  S.usage = __USAGE__;
  S.wb = __WB__;
  S.credIdx = __CRED__;
  S.modelsExpanded = false; S.accOpen = {"a1b2c3d4e5f60001": true}; S.lastErr = null;
  A.live({"a1b2c3d4e5f60001": {age: 6, run: false}, "a1b2c3d4e5f60003": {age: 14, run: false}});
  return 'ok';
})()
"""

SHOW = """
(function(){
  window.__app.showTab('%s');
  document.getElementById('hdsub').textContent = '%s';\n  var tt = document.getElementById('toast');\n  if (tt) { tt.className = 'hidden'; tt.textContent = ''; tt.style.display = 'none'; }
  return document.querySelector('.view[data-view="%s"]').scrollHeight;
})()
"""


def wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


class Cdp:
    def __init__(self, ws_url):
        self.ws = connect(ws_url, max_size=10 ** 9, open_timeout=20)
        self.n = 0

    def cmd(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def js(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError(str(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    def shot(self):
        r = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        return base64.b64decode(r["data"])

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def page_target(port):
    for _ in range(60):
        try:
            data = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=3))
            for t in data:
                if t.get("type") == "page":
                    return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError("没有可用的 page target")


def render_shots(workdir):
    prof = os.path.join(workdir, "chrome-prof")
    shutil.rmtree(prof, ignore_errors=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
         "--no-default-browser-check", "--disable-dev-shm-usage",
         "--allow-file-access-from-files", f"--user-data-dir={prof}",
         f"--remote-debugging-port={PORT}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_port(PORT):
            raise RuntimeError("Chrome 调试端口没起来")
        c = Cdp(page_target(PORT))
        c.cmd("Page.enable")
        c.cmd("Runtime.enable")
        c.cmd("Emulation.setDeviceMetricsOverride",
              width=SHOT_W, height=SHOT_H, deviceScaleFactor=SCALE, mobile=True)
        c.cmd("Page.navigate", url="file://" + TMP_HTML)
        time.sleep(1.6)
        got = c.js(INJECT
                   .replace("__RAW__", json.dumps(build_rawlog(), separators=(",", ":")))
                   .replace("__TOKENS__", json.dumps(build_tokens(), ensure_ascii=False))
                   .replace("__USAGE__", json.dumps(build_usage(), ensure_ascii=False))
                   .replace("__WB__", json.dumps(build_wb(), ensure_ascii=False))
                   .replace("__CRED__", json.dumps(build_cred(), ensure_ascii=False, separators=(",", ":"))))
        if got != "ok":
            raise RuntimeError(f"注入失败: {got}")
        shots = {}
        for tab, sub in (("overview", "已更新 09:41:07"), ("tokens", "已更新 09:41:07"),
                         ("wb", "已更新 09:41:07")):
            c.js(SHOW % (tab, sub, tab))
            time.sleep(0.6)
            p = os.path.join(workdir, f"shot-{tab}.png")
            with open(p, "wb") as f:
                f.write(c.shot())
            shots[tab] = p
        c.close()
        return shots
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()


def compose(shots):
    W, H = 1400, 1014
    img = Image.new("RGB", (W, H), "#080b0f")
    d = ImageDraw.Draw(img)
    for y in range(H):
        k = y / H
        r = int(8 + 6 * k)
        g = int(11 + 10 * k)
        b = int(15 + 14 * k)
        d.line([(0, y), (W, y)], fill=(r, g, b))
    glow = Image.new("RGB", (W, H), "#000000")
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W // 2 - 520, H - 300, W // 2 + 520, H + 260], fill=(16, 44, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.blend(img, Image.blend(img, glow, 0.5), 0.5)
    d = ImageDraw.Draw(img)

    f_top = ImageFont.truetype(FONT_B, 26)
    d.text((W // 2, 34), "TokenDesk  \u00b7  NewAPI \u7528\u91cf  +  \u8d26\u53f7\u6c60",
           fill="#9fb3c8", anchor="mm", font=f_top)

    bw, pad = 9, 6
    scr_w, scr_h = 390, 866
    ph_w, ph_h = scr_w + bw * 2, scr_h + bw * 2
    gap = 40
    total = ph_w * 3 + gap * 2
    x0 = (W - total) // 2
    y0 = 78

    for i, tab in enumerate(("overview", "tokens", "wb")):
        px = x0 + i * (ph_w + gap)
        d.rounded_rectangle([px, y0, px + ph_w, y0 + ph_h], radius=44, fill="#1b2129")
        d.rounded_rectangle([px + bw - pad, y0 + bw - pad, px + ph_w - bw + pad, y0 + ph_h - bw + pad],
                            radius=44 - pad, outline="#2b3542", width=1)
        screen = Image.open(shots[tab]).convert("RGB").resize((scr_w, scr_h), Image.LANCZOS)
        mask = Image.new("L", (scr_w, scr_h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, scr_w - 1, scr_h - 1], radius=36, fill=255)
        img.paste(screen, (px + bw, y0 + bw), mask)

    f_bot = ImageFont.truetype(FONT_B, 20)
    d.text((W // 2, H - 30), "\u793a\u4f8b\u6570\u636e\uff0c\u975e\u771f\u5b9e\u7528\u91cf",
           fill="#9fb3c8", anchor="mm", font=f_bot)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    return OUT


def main():
    if not CHROME:
        print("找不到 Chrome", file=sys.stderr)
        return 1
    html = open(os.path.join(ASSETS, "index.html"), encoding="utf-8").read()
    html = html.replace('href="style.css"', 'href="../app/assets/style.css"')
    html = html.replace('src="bootstrap.js"', 'src="../app/assets/bootstrap.js"')
    html = html.replace('src="app.js"', 'src="../app/assets/app.js"')
    with open(TMP_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    work = os.path.join(ROOT, "tools", ".preview-work")
    os.makedirs(work, exist_ok=True)
    try:
        shots = render_shots(work)
        out = compose(shots)
        im = Image.open(out)
        print(f"已生成 {out}  {im.size[0]}x{im.size[1]}  {os.path.getsize(out)} 字节")
        return 0
    finally:
        for p in (TMP_HTML,):
            try:
                os.remove(p)
            except OSError:
                pass
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
