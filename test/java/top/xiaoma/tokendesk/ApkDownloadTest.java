package top.xiaoma.tokendesk;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * F7c-java 的姊妹单测：{@link ApkDownload} 纯 JVM 可跑（不依赖 android.jar），
 * 因此「文件名清洗」和「非 200 不落盘」这两条安全约束可以被真正验证，而不是只写在注释里。
 *
 * <p>跑法：run-java-test.sh 一起编进来。
 */
public final class ApkDownloadTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        testSafeName();
        testRejectsPathTraversal();
        testFetchWritesFile();
        testFetchRejectsNon200();
        System.out.println("\nSUMMARY: " + pass + " pass / " + fail + " fail");
        if (fail > 0) {
            System.exit(1);
        }
    }

    private static void check(String label, Object actual, Object expected) {
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        if (ok) {
            pass++;
            System.out.println("PASS " + label + "  [" + actual + "]");
        } else {
            fail++;
            System.out.println("FAIL " + label + "  expected=" + expected + " actual=" + actual);
        }
    }

    private static void testSafeName() {
        check("正常名原样保留", ApkDownload.safeName("TokenDesk-1.0.77.apk"), "TokenDesk-1.0.77.apk");
        check("空格/斜杠变下划线", ApkDownload.safeName("a b/c\\d:e.apk"), "a_b_c_d_e.apk");
        check("中文与括号被剔除", ApkDownload.safeName("令牌(1).apk"), "1.apk");
        check("空名兜底", ApkDownload.safeName(""), "update.apk");
        check("null 兜底", ApkDownload.safeName(null), "update.apk");
        check("没有扩展名自动补 .apk", ApkDownload.safeName("v1.0.77"), "v1.0.77.apk");
    }

    private static void testRejectsPathTraversal() {
        String n = ApkDownload.safeName("../../etc/passwd");
        check("路径穿越被压平（不含 ..）", n.contains(".."), false);
        check("路径穿越不含分隔符", n.contains("/") || n.contains("\\"), false);
        check("穿越结果仍以 .apk 结尾", n.endsWith(".apk"), true);
    }

    private static void testFetchWritesFile() throws Exception {
        byte[] payload = new byte[64 * 1024 + 7];
        for (int i = 0; i < payload.length; i++) {
            payload[i] = (byte) (i % 251);
        }
        try (OneShot server = new OneShot(200, payload)) {
            File dir = Files.createTempDirectory("apkdl").toFile();
            File dest = new File(dir, "out.apk");
            long n = ApkDownload.fetch(server.url(), dest, 3000, 5000);
            check("返回字节数", n, (long) payload.length);
            check("文件大小一致", dest.length(), (long) payload.length);
            byte[] got = Files.readAllBytes(dest.toPath());
            boolean same = got.length == payload.length;
            if (same) {
                for (int i = 0; i < got.length; i++) {
                    if (got[i] != payload[i]) {
                        same = false;
                        break;
                    }
                }
            }
            check("内容逐字节一致", same, true);
            //noinspection ResultOfMethodCallIgnored
            dest.delete();
            //noinspection ResultOfMethodCallIgnored
            dir.delete();
        }
    }

    private static void testFetchRejectsNon200() throws Exception {
        try (OneShot server = new OneShot(404, "not found".getBytes(StandardCharsets.UTF_8))) {
            File dir = Files.createTempDirectory("apkdl404").toFile();
            File dest = new File(dir, "err.apk");
            String msg = "";
            try {
                ApkDownload.fetch(server.url(), dest, 3000, 5000);
            } catch (IOException e) {
                msg = e.getMessage() == null ? "" : e.getMessage();
            }
            check("非 200 必须抛错", msg.startsWith("HTTP"), true);
            check("非 200 不得留下文件", dest.exists(), false);
            //noinspection ResultOfMethodCallIgnored
            dir.delete();
        }
        File f = File.createTempFile("apkdl-empty", ".apk");
        String msg2 = "";
        try {
            ApkDownload.fetch("", f, 1000, 1000);
        } catch (IOException e) {
            msg2 = e.getMessage() == null ? "" : e.getMessage();
        }
        check("空地址必须抛错", msg2.length() > 0, true);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** 回一次固定响应就关的极简 HTTP 服务器 */
    private static final class OneShot implements AutoCloseable {
        private final ServerSocket ss;
        private final Thread t;

        OneShot(int code, byte[] body) throws IOException {
            ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
            t = new Thread(() -> {
                try (Socket s = ss.accept()) {
                    s.getInputStream().read(new byte[2048]);
                    String head = "HTTP/1.1 " + code + " X\r\nContent-Length: " + body.length
                            + "\r\nConnection: close\r\n\r\n";
                    OutputStream out = s.getOutputStream();
                    out.write(head.getBytes(StandardCharsets.ISO_8859_1));
                    out.write(body);
                    out.flush();
                } catch (IOException ignored) {
                }
            }, "oneshot");
            t.setDaemon(true);
            t.start();
        }

        String url() {
            return "http://127.0.0.1:" + ss.getLocalPort() + "/x.apk";
        }

        @Override
        public void close() throws Exception {
            ss.close();
            t.join(1000);
        }
    }
}
