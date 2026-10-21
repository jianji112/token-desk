package top.xiaoma.tokendesk;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 更新包下载（纯 Java，不依赖 android.*，便于 JVM 单测）。
 *
 * <p>为什么不直接把 URL 丢给浏览器/DownloadManager：应用内更新要求「下完立刻拉起安装器」，
 * DownloadManager 的完成回调还得再跨进程查状态，且部分 ROM 上不允许直接安装它的产物。
 * 这里自己下到 cache/apk/，再交给 {@link ApkProvider} 以 content:// 暴露给包安装器。
 *
 * <p>文件名必须清洗：URL/版本号来自远端，直接把 {@code ../../} 之类拼进路径就是任意文件写。
 */
public final class ApkDownload {

    private ApkDownload() {
    }

    /**
     * 只保留安全字符并兜底名称。刻意不接受任何路径分隔符与点号开头。
     */
    public static String safeName(String raw) {
        String s = raw == null ? "" : raw.trim();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '_' || c == '-';
            if (ok) {
                sb.append(c);
            } else if (c == ' ' || c == '/' || c == '\\' || c == ':') {
                sb.append('_');
            }
        }
        String out = sb.toString();
        while (out.startsWith(".")) {
            out = out.substring(1);
        }
        // 「..」即使没有分隔符也不留：防的是任何把文件名当路径片段拼的实现
        out = out.replace("..", "_");
        if (out.isEmpty()) {
            out = "update.apk";
        }
        if (!out.toLowerCase().endsWith(".apk")) {
            out = out + ".apk";
        }
        return out;
    }

    /**
     * 下载到 dest（覆盖写），返回字节数。任何非 200/206 都抛异常，避免把错误页存成 APK。
     */
    public static long fetch(String url, File dest, int connectMs, int readMs) throws IOException {
        if (url == null || url.trim().isEmpty()) {
            throw new IOException("空地址");
        }
        File dir = dest.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.exists()) {
            throw new IOException("建不了目录：" + dir);
        }
        HttpURLConnection conn = null;
        InputStream in = null;
        BufferedOutputStream out = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(connectMs > 0 ? connectMs : 15000);
            conn.setReadTimeout(readMs > 0 ? readMs : 60000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept-Encoding", "identity");
            // UA 不再带 App 标识（1.1.0）：`TokenDesk/1.0` 会被带 UA 白名单的网关/WAF 判成陌生客户端。
            // 也不能空着不发 —— 默认的 Dalvik/x.y 同样容易被挡，这里给普通 Chrome 形态。
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36");
            int code = conn.getResponseCode();
            if (code != 200 && code != 206) {
                throw new IOException("HTTP " + code);
            }
            long total = conn.getContentLengthLong();
            in = new BufferedInputStream(conn.getInputStream(), 64 * 1024);
            out = new BufferedOutputStream(new FileOutputStream(dest), 64 * 1024);
            byte[] buf = new byte[64 * 1024];
            long got = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
            }
            out.flush();
            if (total > 0 && got != total) {
                throw new IOException("下载不完整 " + got + "/" + total);
            }
            if (got <= 0) {
                throw new IOException("下载内容为空");
            }
            return got;
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                }
            }
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
            if (conn != null) {
                conn.disconnect();
            }
        }
    }
}
