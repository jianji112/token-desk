"""令牌台 Web 层自测：用 headless Chrome + CDP 真实访问局域网接口，逐页签抓文本。

用法：python3 tools/webtest.py            # 自动从项目根 .env / 环境变量取凭证写测试用 bootstrap
产物：$TMPDIR/tokendesk-test/{dom-*.txt,screen-*.png}（默认系统临时目录）
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

SCRATCH = os.path.join(tempfile.gettempdir(), "tokendesk-test")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(PROJ, "app", "assets")
ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
PORT = 9333


def load_env():
    out = {}
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v.strip().strip('"').strip("'")
    return out


def prepare():
    if os.path.isdir(SCRATCH):
        shutil.rmtree(SCRATCH)
    os.makedirs(SCRATCH)
    for name in ("index.html", "style.css", "app.js"):
        shutil.copy(os.path.join(ASSETS, name), os.path.join(SCRATCH, name))
    env = load_env()

    boot = {
        "newapiBase": os.environ.get("TD_NEWAPI_BASE", env.get("NEWAPI_BASE_URL", "")),
        "newapiToken": env.get("NEWAPI_ACCESS_TOKEN", ""),
        "newapiUid": env.get("NEWAPI_USER_ID", "1"),
        "hubBase": os.environ.get("TD_HUB_BASE", env.get("WB_HUB_URL", "")),
        "hubPass": env.get("WB_HUB_PANEL_PASS", ""),
        "range": "24h",
        "maxPages": "80",
        "channel": os.environ.get("TD_CHANNEL", "auto"),
    }
    with open(os.path.join(SCRATCH, "bootstrap.js"), "w", encoding="utf-8") as f:
        f.write("window.__BOOTSTRAP__ = " + json.dumps(boot, ensure_ascii=False) + ";\n")


class CDP:
    def __init__(self, ws_url):
        from websockets.sync.client import connect
        self.ws = connect(ws_url, max_size=80 * 1024 * 1024)
        self.n = 0
        self.events = []

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg
            self.events.append(msg)

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise, userGesture=True)
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return {"__error": res["exceptionDetails"].get("text"), "detail": json.dumps(res["exceptionDetails"])[:400]}
        return res.get("result", {}).get("value")

    def drain(self):
        self.ws.settimeout(0.05)
        try:
            while True:
                self.events.append(json.loads(self.ws.recv()))
        except Exception:
            pass
        self.ws.settimeout(30)


def waiting_eval(cdp, expr, timeout=90, interval=1.0):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        try:
            last = cdp.eval(expr)
        except Exception as e:
            last = {"__error": str(e)}
        if last:
            return last
        time.sleep(interval)
    return last


def main():
    prepare()
    profile = os.path.join(SCRATCH, "chrome-profile")
    chrome = subprocess.Popen([
        "google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-web-security", "--allow-file-access-from-files",
        "--remote-debugging-port=%d" % PORT,
        "--user-data-dir=" + profile,
        "--window-size=412,915",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        ws_base = None
        for _ in range(50):
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1) as r:
                    ws_base = json.loads(r.read())["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.3)
        if not ws_base:
            print("无法连接 Chrome 调试端口")
            return 1

        req = urllib.request.Request("http://127.0.0.1:%d/json/new?about:blank" % PORT, method="PUT")
        with urllib.request.urlopen(req, timeout=5) as r:
            target = json.loads(r.read())

        cdp = CDP(target["webSocketDebuggerUrl"])
        cdp.send("Runtime.enable")
        cdp.send("Page.enable")
        cdp.send("Log.enable")
        cdp.send("Page.navigate", url="file://" + os.path.join(SCRATCH, "index.html"))
        time.sleep(2)


        state = waiting_eval(cdp, "(function(){var s=window.__app&&window.__app.state;if(!s)return 'no-state';"
                                  "if(s.busy.over||s.busy.usage||s.busy.wb)return null;"
                                  "if(!s.over||!s.usage||!s.wb)return null;return 'done';})()",
                             timeout=240)
        print("wait state:", state)
        print("errors:", cdp.eval("JSON.stringify(window.__app.state.errors)"))

        report = {}
        for tab in ("overview", "tokens", "usage", "wb", "settings"):
            cdp.eval("window.__app.showTab('%s')" % tab)
            time.sleep(0.6)
            txt = cdp.eval("document.querySelector('.view[data-view=\"%s\"]').innerText" % tab)
            report[tab] = txt
            with open(os.path.join(SCRATCH, "dom-%s.txt" % tab), "w", encoding="utf-8") as f:
                f.write(txt or "")

            shot = cdp.send("Page.captureScreenshot", format="png")
            data = shot.get("result", {}).get("data")
            if data:
                import base64
                with open(os.path.join(SCRATCH, "screen-%s.png" % tab), "wb") as f:
                    f.write(base64.b64decode(data))


        cdp.eval("(function(){var b=document.querySelector('#f-diag'); if(b) b.click(); return !!b;})()")
        diag = waiting_eval(cdp, "(function(){var o=document.querySelector('#diag-out'); if(!o)return null; var t=o.innerText||''; return t.indexOf('通道：')>=0?t:null;})()", timeout=120)
        print("\n===== 通道自检 =====")
        print(diag if isinstance(diag, str) else diag)
        with open(os.path.join(SCRATCH, "diag.txt"), "w", encoding="utf-8") as f:
            f.write(diag if isinstance(diag, str) else json.dumps(diag, ensure_ascii=False))


        keys = cdp.eval("JSON.stringify({usage:window.__app.state.usage&&{total:window.__app.state.usage.total,req:window.__app.state.usage.req,pages:window.__app.state.usage.pages,keys:Object.keys(window.__app.state.usage.byKey).length},tokens:window.__app.state.tokens&&window.__app.state.tokens.length,wbErr:window.__app.state.wb&&window.__app.state.wb.errors,wbAcc:(window.__app.state.wb&&window.__app.state.wb.accounts)?window.__app.state.wb.accounts.accounts.length:0,models:(window.__app.state.wb&&window.__app.state.wb.models)?(window.__app.state.wb.models.cn.length+'+'+window.__app.state.wb.models.intl.length):null})")
        print("summary:", keys)

        errs = [e for e in cdp.events if e.get("method") in ("Runtime.exceptionThrown", "Log.entryAdded")]
        print("console/log errors:", len(errs))
        for e in errs[:5]:
            print("  ", json.dumps(e, ensure_ascii=False)[:300])

        print("\n===== OVERVIEW =====")
        print((report.get("overview") or "")[:900])
        print("\n===== WB =====")
        print((report.get("wb") or "")[:900])
        return 0
    finally:
        chrome.terminate()


if __name__ == "__main__":
    sys.exit(main())
