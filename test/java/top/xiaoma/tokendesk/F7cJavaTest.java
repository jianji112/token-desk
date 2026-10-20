package top.xiaoma.tokendesk;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * F7c-java 单测（纯 JVM，不连 redroid、不装 APK、不引 JUnit/Gradle）。
 *
 * <p>只测一件事：{@link HttpJobRegistry} 在真实 socket 上是否真的能
 * 「取消即断、同 id 只打一次、cancelAll 全断」。android.jar 的桩跑不了这些，
 * 所以用本地 {@link ServerSocket} 造一个「接受后睡 20s 再回」的假服务器，
 * 让 worker 真实地阻塞在 read 上。
 *
 * <p>跑法见 test/java/run-java-test.sh。
 */
public final class F7cJavaTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        try (SlowServer server = new SlowServer()) {
            testCancelInterruptsRead(server);
            testDedupSameId(server);
            testCompletionCallback(server);
            testClampTimeout();
            testCancelAll(server);
        }
        System.out.println();
        System.out.println("SUMMARY: " + pass + " pass / " + fail + " fail / 0 error");
        System.exit(fail == 0 ? 0 : 1);
    }

    // ── 1. cancel(id) 必须真的打断阻塞读，而不是等 read 超时 ──────────────────

    private static void testCancelInterruptsRead(SlowServer server) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        AtomicInteger callbacks = new AtomicInteger();
        HttpJobRegistry reg = new HttpJobRegistry(pool, (id, payload) -> callbacks.incrementAndGet());
        CountDownLatch exited = new CountDownLatch(1);

        boolean submitted = reg.submit("c1", holder -> {
            try {
                return fetch(server.url("/slow-c1"), holder);
            } finally {
                exited.countDown();
            }
        });
        server.awaitRequest();
        Thread.sleep(200); // 让 worker 真正进到 read 阻塞

        long t0 = System.nanoTime();
        boolean hit = reg.cancel("c1");
        boolean terminated = exited.await(5, TimeUnit.SECONDS);
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;
        Thread.sleep(100);

        check("1a 提交成功", submitted, "submit=" + submitted);
        check("1b cancel 命中", hit, "cancel=" + hit);
        check("1c 读在 1s 内中断", terminated && elapsedMs < 1000,
                "terminated=" + terminated + " elapsed=" + elapsedMs + "ms（旧实现要等到 45s）");
        check("1d 取消后不回回调", callbacks.get() == 0, "callbacks=" + callbacks.get());
        check("1e 登记表已清空", reg.size() == 0, "size=" + reg.size());
        pool.shutdownNow();
    }

    // ── 2. 同 id 连续下发两次 → 服务器只收 1 个请求、在途只 1 条 ──────────────

    private static void testDedupSameId(SlowServer server) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        HttpJobRegistry reg = new HttpJobRegistry(pool, (id, payload) -> { });
        AtomicInteger runs = new AtomicInteger();
        int before = server.requests.get();

        boolean first = reg.submit("dup", holder -> {
            runs.incrementAndGet();
            return fetch(server.url("/dup-1"), holder);
        });
        boolean second = reg.submit("dup", holder -> {
            runs.incrementAndGet();
            return fetch(server.url("/dup-2"), holder);
        });
        Thread.sleep(800);

        check("2a 第一次下发成功", first, "submit#1=" + first);
        check("2b 同 id 第二次被丢弃", !second, "submit#2=" + second + "（丢弃而非替换）");
        check("2c 执行体只跑 1 次", runs.get() == 1, "runs=" + runs.get());
        check("2d 服务器只收到 1 个请求", server.requests.get() - before == 1,
                "server_requests=" + (server.requests.get() - before));
        check("2e 在途只 1 条", reg.size() == 1, "size=" + reg.size());

        reg.cancelAll();
        pool.shutdownNow();
    }

    // ── 3. 正常完成必须回调（防呆：别把正常路径一起改坏） ────────────────────

    private static void testCompletionCallback(SlowServer server) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> payloadRef = new AtomicReference<>();
        HttpJobRegistry reg = new HttpJobRegistry(pool, (id, payload) -> {
            payloadRef.set(payload);
            done.countDown();
        });
        boolean ok = reg.submit("ok1", holder -> fetch(server.url("/fast-ok"), holder));
        boolean got = done.await(5, TimeUnit.SECONDS);
        String payload = payloadRef.get();
        check("3a 完成后回调", ok && got && payload != null && payload.contains("\"status\":200"),
                "payload=" + payload);

        // 完成后再用同一个 id 重试，必须能再次下发（取消/完成后要放行）
        boolean again = reg.submit("ok1", holder -> fetch(server.url("/fast-ok-2"), holder));
        check("3b 同 id 完成可重新下发", again, "resubmit=" + again);
        Thread.sleep(500);
        pool.shutdownNow();
    }

    // ── 4. clampTimeout 语义 ────────────────────────────────────────────────

    private static void testClampTimeout() {
        check("4a 负数回落该参数默认值", HttpJobRegistry.clampTimeout(-1, 10000) == 10000,
                "clamp(-1,10000)=" + HttpJobRegistry.clampTimeout(-1, 10000));
        check("4b 0 回落该参数默认值（不是 45s）", HttpJobRegistry.clampTimeout(0, 45000) == 45000,
                "clamp(0,45000)=" + HttpJobRegistry.clampTimeout(0, 45000));
        check("4c 低于下限夹到 1000", HttpJobRegistry.clampTimeout(500, 45000) == 1000,
                "clamp(500,*)=" + HttpJobRegistry.clampTimeout(500, 45000));
        check("4d 超上限夹到 120000", HttpJobRegistry.clampTimeout(999999, 10000) == 120000,
                "clamp(999999,*)=" + HttpJobRegistry.clampTimeout(999999, 10000));
        check("4e 合法值原样返回", HttpJobRegistry.clampTimeout(8000, 10000) == 8000,
                "clamp(8000,*)=" + HttpJobRegistry.clampTimeout(8000, 10000));
    }

    // ── 5. cancelAll：全部断连、登记表为空 ─────────────────────────────────

    private static void testCancelAll(SlowServer server) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        HttpJobRegistry reg = new HttpJobRegistry(pool, (id, payload) -> { });
        CountDownLatch exited = new CountDownLatch(3);

        for (int i = 0; i < 3; i++) {
            final String id = "all" + i;
            boolean ok = reg.submit(id, holder -> {
                try {
                    return fetch(server.url("/slow-" + id), holder);
                } finally {
                    exited.countDown();
                }
            });
            if (!ok) check("5 前置提交 " + id, false, "submit=false");
        }
        Thread.sleep(400);
        long t0 = System.nanoTime();
        int cancelled = reg.cancelAll();
        boolean allExited = exited.await(5, TimeUnit.SECONDS);
        long elapsedMs = (System.nanoTime() - t0) / 1_000_000L;

        check("5a cancelAll 命中 3 条", cancelled == 3, "cancelled=" + cancelled);
        check("5b 全部断连", allExited && elapsedMs < 2000,
                "exited=" + allExited + " elapsed=" + elapsedMs + "ms");
        check("5c 登记表为空", reg.size() == 0, "size=" + reg.size());
        check("5d 取消后不再残留", !reg.isInflight("all0") && !reg.isInflight("all2"),
                "isInflight(all0)=" + reg.isInflight("all0"));
        pool.shutdownNow();
    }

    // ── 被测代码用到的真实 HTTP GET ────────────────────────────────────────

    private static String fetch(String url, AtomicReference<HttpURLConnection> holder) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        holder.set(conn);
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(60000); // 故意远大于测试等待：能返回只能是因为 cancel 断连
        try {
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = "";
            if (in != null) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                in.close();
                body = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            }
            return "{\"status\":" + status + ",\"body\":" + org.json.JSONObject.quote(body) + "}";
        } finally {
            conn.disconnect();
        }
    }

    private static void check(String name, boolean ok, String detail) {
        if (ok) {
            pass++;
            System.out.println("PASS " + name + "  [" + detail + "]");
        } else {
            fail++;
            System.out.println("FAIL " + name + "  [" + detail + "]");
        }
    }

    // ── 假服务器：接受连接后先读完请求头，再睡 20s 才回包 ──────────────────

    private static final class SlowServer implements Closeable {

        final ServerSocket ss;
        final AtomicInteger requests = new AtomicInteger();
        final AtomicLong lastAcceptAt = new AtomicLong();
        volatile boolean stop;

        SlowServer() throws IOException {
            ss = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this::acceptLoop, "slow-server");
            t.setDaemon(true);
            t.start();
        }

        String url(String path) {
            return "http://127.0.0.1:" + ss.getLocalPort() + path;
        }

        /** 等至少一个连接被接受（说明客户端已经开始请求，随后会卡在 read 上）。 */
        void awaitRequest() throws InterruptedException {
            long deadline = System.currentTimeMillis() + 5000;
            while (requests.get() == 0 && System.currentTimeMillis() < deadline) {
                Thread.sleep(10);
            }
        }

        private void acceptLoop() {
            while (!stop) {
                try {
                    final Socket s = ss.accept();
                    requests.incrementAndGet();
                    lastAcceptAt.set(System.currentTimeMillis());
                    Thread h = new Thread(() -> handle(s), "slow-handler");
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) {
                    return;
                }
            }
        }

        private void handle(Socket s) {
            try {
                s.setSoTimeout(30000);
                BufferedReader r = new BufferedReader(
                        new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                String line;
                String requestLine = "";
                int contentLength = 0;
                boolean first = true;
                while ((line = r.readLine()) != null && !line.isEmpty()) {
                    if (first) {
                        first = false;
                        requestLine = line;
                        continue;
                    }
                    int i = line.indexOf(':');
                    if (i > 0 && "content-length".equalsIgnoreCase(line.substring(0, i).trim())) {
                        try {
                            contentLength = Integer.parseInt(line.substring(i + 1).trim());
                        } catch (NumberFormatException ignored) {
                        }
                    }
                }
                if (contentLength > 0) {
                    char[] buf = new char[contentLength];
                    int read = 0;
                    while (read < contentLength) {
                        int n = r.read(buf, read, contentLength - read);
                        if (n < 0) break;
                        read += n;
                    }
                }
                // /fast* 立刻回包（验证正常完成会回调）；其余路径睡 20s 拖住客户端，制造「阻塞在 read」
                if (requestLine.indexOf("/fast") < 0) {
                    Thread.sleep(20000);
                }
                byte[] body = "{\"status\":200,\"body\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
                String head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + body.length + "\r\nConnection: close\r\n\r\n";
                s.getOutputStream().write(head.getBytes(StandardCharsets.UTF_8));
                s.getOutputStream().write(body);
                s.getOutputStream().flush();
            } catch (Throwable ignored) {
                // 客户端断连/测试结束都会走到这里，属预期
            } finally {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
            }
        }

        @Override
        public void close() {
            stop = true;
            try {
                ss.close();
            } catch (IOException ignored) {
            }
        }
    }
}
