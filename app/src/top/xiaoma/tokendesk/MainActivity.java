package top.xiaoma.tokendesk;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
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
    final ExecutorService pool = Executors.newFixedThreadPool(4);
    // 在途请求登记表：提交/同 id 去重/取消。不依赖 Android API，可被 JVM 单测直接覆盖
    final HttpJobRegistry jobs = new HttpJobRegistry(pool, this::onHttpResult);

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
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv)", ")").replace(" wv ", " ");
        }
        s.setUserAgentString((ua == null ? "" : ua) + " TokenDesk/1.0");

        webView.setBackgroundColor(Color.parseColor("#0b0f14"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setWebViewClient(new AssetClient(this::applyPendingTab));
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Bridge(this), "NativeBridge");

        setContentView(webView);
        webView.loadUrl(HOME_URL);
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
            return host.jobs.cancel(id);
        }

        @JavascriptInterface
        public void clearWebData() {
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
            host.runOnUiThread(() -> Toast.makeText(host, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void copy(final String text) {
            host.runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) host.getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("tokendesk", text));
                }
            });
        }

        @JavascriptInterface
        public void finishApp() {
            host.runOnUiThread(host::finish);
        }

        @JavascriptInterface
        public String appInfo() {
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
            conn.setRequestProperty("User-Agent", "TokenDesk/1.0 (Android)");
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
