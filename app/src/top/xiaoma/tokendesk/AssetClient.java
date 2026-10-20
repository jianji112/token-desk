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

    AssetClient() {
        this(null);
    }

    AssetClient(PageListener listener) {
        this.listener = listener;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
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
