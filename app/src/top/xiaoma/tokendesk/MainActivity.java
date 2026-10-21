package top.xiaoma.tokendesk;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends Activity {

    private static final String HOME_URL = "file:///android_asset/index.html";
    // 超时默认值：与历史行为一致，可由 JS 通过 httpOpts 的 optsJson 覆盖
    static final int DEF_CONNECT_MS = HttpJobRegistry.DEF_CONNECT_MS;
    static final int DEF_READ_MS = HttpJobRegistry.DEF_READ_MS;
    WebView webView;
    // 记录当前主文档 URL 供 Bridge 白名单校验（Bridge 线程不碰 WebView）
    AssetClient assetClient;
    final ExecutorService pool = Executors.newFixedThreadPool(4);
    // 在途请求登记表：提交/同 id 去重/取消。不依赖 Android API，可被 JVM 单测直接覆盖
    final HttpJobRegistry jobs = new HttpJobRegistry(pool, this::onHttpResult);
    // 凭证安全存储：Keystore 主密钥 + SharedPreferences 密文（P0-3 Wave A，纯新增）。
    // ⚠️ 不能在字段初始化期构造：字段初始化跑在 Activity 构造里，早于 attachBaseContext，
    // this.getApplicationContext() 必抛 NPE → 启动即崩（真机实测）。改为 onCreate 里赋值。
    SecureStore secure;

    // ---- 凭证安全存储对外接口（Bridge 只做转发，逻辑全在 SecureStore） ----
    /** Keystore 是否可用；返回 false 时 JS 必须回退 localStorage 并在设置页标红。 */
    public boolean secureAvailable() {
        return secure.secureAvailable();
    }

    /** 加密写入单个凭证键。成功 true；任何异常 false（不抛出、不回传内容）。 */
    public boolean secureSet(String key, String value) {
        return secure.secureSet(key, value);
    }

    /** 解密读取单个凭证键。不存在或解不开返回 null。 */
    public String secureGet(String key) {
        return secure.secureGet(key);
    }

    /** 清空密文并删除主密钥（退出登录 / 迁移完成）。 */
    public void secureClear() {
        secure.secureClear();
    }

    /** 原生请求完成回调（pool 线程）→ 回 UI 线程喂给 window.__nativeHttp。 */
    private void onHttpResult(String id, String payload) {
        final String js = "window.__nativeHttp && window.__nativeHttp("
                + JSONObject.quote(id) + "," + JSONObject.quote(payload) + ")";
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // SecureStore 只能在这里（attachBaseContext 之后）构造，见字段声明处注释
        secure = new SecureStore(this);
        getWindow().setStatusBarColor(Color.parseColor("#0b0f14"));
        getWindow().setNavigationBarColor(Color.parseColor("#0b0f14"));

        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(isDebuggable());
        }

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        // content:// 对本应用无用，但 file:// 页面直连远端要靠 WebView 的跨源后门，
        // 这里保持与 GitHub v1.0.72 一致（2026-10-21 主人明确要求：浏览器内核通道必须能用）。
        // 原因：网关 new-api 只在 OPTIONS 预检回 CORS 头，真实 GET/POST 响应没有 ACAO，
        // 关掉下面两个开关就等于把浏览器内核通道废掉（报 Failed to fetch）。
        // 代价：本应用页面是内置资产，不接受外部页面注入，风险面可控。
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 混合内容一律不放行：资产页是 file:// 本地页面，正常不加载任何 http 子资源
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // UA 不再追加自定义后缀（1.1.0）：`TokenDesk/1.0` 会让带 UA 白名单的网关/WAF
        // 把请求判成未知客户端；顺手把 WebView 的 `; wv` 标记去掉，表现与普通 Chrome 一致。
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv)", ")").replace(" wv ", " ");
            s.setUserAgentString(ua);
        }

        webView.setBackgroundColor(Color.parseColor("#0b0f14"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        assetClient = new AssetClient(this::applyPendingTab);
        webView.setWebViewClient(assetClient);
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Bridge(this), "NativeBridge");

        setContentView(webView);
        webView.loadUrl(HOME_URL);
    }

    /**
     * Bridge 调用来源是否受信：当前主文档必须仍在资产白名单内
     * （scheme=file、路径 /android_asset/）。非资产页拉起的页面调进 Bridge 一律静默丢弃。
     * 只读 volatile 字段，不触碰 WebView——本方法会在 JavaBridge 线程上被调用。
     */
    boolean callerTrusted() {
        AssetClient c = assetClient;
        return c != null && c.pageInAssetWhitelist();
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private void applyPendingTab() {
        if (webView == null || getIntent() == null) return;
        String ev = getIntent().getStringExtra("eval");
        if (ev != null && !ev.isEmpty() && isDebuggable()) {
            webView.evaluateJavascript("(function(){try{" + ev + "}catch(e){}})()", null);
        }
        String tab = getIntent().getStringExtra("tab");
        if (tab == null || tab.isEmpty()) return;
        if (!tab.matches("[a-z]{2,12}")) return;
        webView.evaluateJavascript(
                "(function(){try{if(window.__app&&window.__app.showTab){window.__app.showTab('"
                        + tab + "');return '1';}}catch(e){}return '0';})()", null);
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyPendingTab();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return (window.__onBack && window.__onBack())?'1':'0';}catch(e){return '0';}})()",
                value -> {
                    boolean handled = value != null && value.replace("\"", "").equals("1");
                    if (!handled) {
                        MainActivity.super.onBackPressed();
                    }
                });
    }

    @Override
    protected void onPause() {
        // 切后台/锁屏：WebView 的 JS 定时器立刻停（否则 liveTimer / autoTimer 还在每 2s 打一次
        // /usage/recent），同时暂停渲染，回来不用重建页面。JS 侧还有 document.hidden 兜底，
        // 这里停的是「浏览器连计时器都不再跑」，两条互补。
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        // 页面销毁时把在途请求全部断连，避免线程阻塞到 read 超时才退出
        jobs.cancelAll();
        pool.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("NativeBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    static class Bridge {

        private final MainActivity host;

        Bridge(MainActivity host) {
            this.host = host;
        }

        /**
         * 来源白名单：只放行来自 file:///android_asset/ 主文档的调用。
         * 每个对外方法第一行都过这道闸；不受信时按各自失败语义静默返回，不抛异常。
         */
        private boolean allowed() {
            return host.callerTrusted();
        }

        @JavascriptInterface
        public void http(final String id, final String method, final String url,
                         final String headersJson, final String body) {
            httpOpts(id, method, url, headersJson, body, null);
        }

        /**
         * 带超时参数的 HTTP 桥。optsJson 形如 {"connectMs":10000,"readMs":45000}，
         * 缺省或非法值回落各自默认值，并夹在 [MIN,MAX] 之间。
         */
        @JavascriptInterface
        public void httpOpts(final String id, final String method, final String url,
                             final String headersJson, final String body, final String optsJson) {
            if (!allowed()) return;
            if (id == null || id.isEmpty()) return;
            int connectMs = DEF_CONNECT_MS;
            int readMs = DEF_READ_MS;
            try {
                if (optsJson != null && optsJson.length() > 2) {
                    JSONObject o = new JSONObject(optsJson);
                    connectMs = HttpJobRegistry.clampTimeout(o.optInt("connectMs", DEF_CONNECT_MS), DEF_CONNECT_MS);
                    readMs = HttpJobRegistry.clampTimeout(o.optInt("readMs", DEF_READ_MS), DEF_READ_MS);
                }
            } catch (Throwable ignored) {
                // 参数解析失败就用默认值，不阻断请求
            }
            final int cm = connectMs;
            final int rm = readMs;
            // 去重/取消/回调全交给登记表：同 id 已在途会被丢弃，不再重复打到服务器
            host.jobs.submit(id, holder -> doHttp(method, url, headersJson, body, cm, rm, holder));
        }

        /** 取消在途请求：中断等待并断开 socket，返回是否命中。 */
        @JavascriptInterface
        public boolean cancel(String id) {
            if (!allowed()) return false;
            return host.jobs.cancel(id);
        }

        // ---- 凭证安全存储（P0-3 Wave A）：JS 侧只认这四个方法 ----
        // 失败语义定版：可用性 false、写入 false、读取 null、清空无返回，均不抛异常、不回传内容。
        @JavascriptInterface
        public boolean secureAvailable() {
            if (!allowed()) return false;
            return host.secureAvailable();
        }

        @JavascriptInterface
        public boolean secureSet(String key, String value) {
            if (!allowed()) return false;
            return host.secureSet(key, value);
        }

        @JavascriptInterface
        public String secureGet(String key) {
            if (!allowed()) return null;
            return host.secureGet(key);
        }

        @JavascriptInterface
        public void secureClear() {
            if (!allowed()) return;
            host.secureClear();
        }

        @JavascriptInterface
        public void clearWebData() {
            if (!allowed()) return;
            host.runOnUiThread(() -> {
                try {
                    if (host.webView != null) {
                        host.webView.clearCache(true);
                        host.webView.clearHistory();
                        host.webView.clearFormData();
                    }
                    WebStorage.getInstance().deleteAllData();
                } catch (Throwable ignored) {
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            if (!allowed()) return;
            host.runOnUiThread(() -> Toast.makeText(host, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void copy(final String text) {
            if (!allowed()) return;
            host.runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) host.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("tokendesk", text));
                }
            });
        }

        @JavascriptInterface
        public void downloadApk(final String url, final String ver) {
            if (!allowed()) return;
            host.startApkDownload(url, ver);
        }

        @JavascriptInterface
        public void finishApp() {
            if (!allowed()) return;
            host.runOnUiThread(host::finish);
        }

        @JavascriptInterface
        public String appInfo() {
            if (!allowed()) return "{}";
            String ver = "?";
            try {
                ver = host.getPackageManager()
                        .getPackageInfo(host.getPackageName(), 0).versionName;
            } catch (Exception ignored) {
            }
            return "{\"version\":" + JSONObject.quote(ver == null ? "?" : ver)
                    + ",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"model\":" + JSONObject.quote(Build.MODEL) + "}";
        }
    }

    static String doHttp(String method, String url, String headersJson, String body)
            throws Exception {
        return doHttp(method, url, headersJson, body, DEF_CONNECT_MS, DEF_READ_MS, null);
    }

    // ── 应用内更新：下载 APK 并拉起系统安装器 ──────────────────────────────
    // 只在用户明确点「下载并安装」时走（不自动下载）。JS 通过 window.__onApk(json) 收到结果。
    void startApkDownload(final String url, final String ver) {
        if (url == null || !url.startsWith("https://")) {
            apkCallback(false, "只支持 https 下载地址", null);
            return;
        }
        apkCallback(true, "开始下载…", null);
        new Thread(() -> {
            File dir = ApkProvider.dirOf(this);
            File dest = new File(dir, ApkDownload.safeName("TokenDesk-" + (ver == null ? "" : ver) + ".apk"));
            try {
                long bytes = ApkDownload.fetch(url, dest, 15000, 120000);
                apkCallback(true, "下载完成（" + (bytes / 1024) + " KB），准备安装", dest.getName());
                runOnUiThread(() -> installApk(dest));
            } catch (Throwable e) {
                String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                apkCallback(false, "下载失败：" + msg, null);
            }
        }, "apk-dl").start();
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            // 安卓 8+ 要「允许安装未知应用」逐应用授权，跳过去让用户点一下
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
                Toast.makeText(this, "请允许本应用安装应用，然后回到 App 再点一次", Toast.LENGTH_LONG).show();
            } catch (Throwable ignored) {
                Toast.makeText(this, "请到系统设置允许安装未知应用", Toast.LENGTH_LONG).show();
            }
            return;
        }
        try {
            Uri uri = ApkProvider.uriFor(this, apk);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Throwable e) {
            Toast.makeText(this, "拉起安装器失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void apkCallback(boolean ok, String msg, String file) {
        if (webView == null) return;
        final String js = "window.__onApk&&window.__onApk({ok:" + ok
                + ",msg:" + JSONObject.quote(msg == null ? "" : msg)
                + ",file:" + JSONObject.quote(file == null ? "" : file) + "})";
        runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    /**
     * @param holder 传入非 null 时，会把 conn 写入其中，供 cancel(id) 断连使用
     */
    static String doHttp(String method, String url, String headersJson, String body,
                         int connectMs, int readMs, AtomicReference<HttpURLConnection> holder)
            throws Exception {
        long t0 = System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            if (holder != null) holder.set(conn);
            conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase());
            conn.setConnectTimeout(HttpJobRegistry.clampTimeout(connectMs, DEF_CONNECT_MS));
            conn.setReadTimeout(HttpJobRegistry.clampTimeout(readMs, DEF_READ_MS));
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept-Encoding", "identity");
            // UA 不再带 App 标识（1.1.0）：`TokenDesk/1.0` 会被带 UA 白名单的网关/WAF 判成陌生客户端。
            // 也不能空着不发 —— 默认的 Dalvik/x.y 同样容易被挡，这里给普通 Chrome 形态。
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
            if (headersJson != null && headersJson.length() > 2) {
                JSONObject h = new JSONObject(headersJson);
                Iterator<String> it = h.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = h.optString(k, "");
                    if (!k.isEmpty()) {
                        conn.setRequestProperty(k, v);
                    }
                }
            }
            boolean hasBody = body != null && !body.isEmpty()
                    && !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method);
            if (hasBody) {
                conn.setDoOutput(true);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }

            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);

            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("body", text);
            out.put("ms", System.currentTimeMillis() - t0);
            return out.toString();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}
