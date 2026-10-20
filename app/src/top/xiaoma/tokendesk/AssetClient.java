package top.xiaoma.tokendesk;

import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class AssetClient extends WebViewClient {

    private static final String ASSET_PREFIX = "file:///android_asset/";

    interface PageListener {
        void onFirstPageFinished();
    }

    private final PageListener listener;
    private boolean firstDone;

    /**
     * 当前主文档 URL：只由 UI 线程（WebViewClient 回调）写，Bridge 线程只读。
     * 供 Bridge 做来源白名单校验用——绝不在 Bridge 线程上调 WebView.getUrl()。
     */
    private volatile String pageUrl;

    AssetClient() {
        this(null);
    }

    AssetClient(PageListener listener) {
        this.listener = listener;
    }

    /**
     * URL 是否属于资产白名单：scheme 必须是 file、路径必须落在 /android_asset/ 下，
     * 且不含 ".."（挡 file:///android_asset/../../data/... 这类穿越）。
     * 纯函数，无 Android 依赖，可被 JVM 直接覆盖。
     */
    static boolean isAssetUrl(String u) {
        return u != null && u.startsWith(ASSET_PREFIX) && u.indexOf("..") < 0;
    }

    /**
     * 当前主文档是否仍在资产白名单内。
     * 未开始加载（pageUrl 为 null）时返回 false，宁拒不放。
     */
    boolean pageInAssetWhitelist() {
        return isAssetUrl(pageUrl);
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        if (url != null) {
            pageUrl = url;
        }
        super.onPageStarted(view, url, favicon);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if (url != null) {
            pageUrl = url;
        }
        if (!firstDone) {
            firstDone = true;
            if (listener != null) {
                listener.onFirstPageFinished();
            }
        }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return url == null || !url.startsWith(ASSET_PREFIX);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return request == null || request.getUrl() == null
                || !request.getUrl().toString().startsWith(ASSET_PREFIX);
    }
}
