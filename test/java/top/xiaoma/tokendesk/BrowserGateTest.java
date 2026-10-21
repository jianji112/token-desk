package top.xiaoma.tokendesk;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Wave B ③（按需开闸）的纯 JVM 单测：不连 redroid、不装 APK、不引 JUnit/Gradle。
 *
 * <p>{@link BrowserGate} 是纯 Java 类（无 android 依赖），所以「白名单拒绝 / 幂等 /
 * 关闸读回 false / 进程重启回 false」都能在 JVM 上直接验。真实的
 * {@code WebSettings} 读回只能在设备上做，见真机验收记录；
 * 这里的 {@link FakeSettings} 与 {@code MainActivity.applyBrowserMode} 逐行同构，
 * 只用来断言「闸门把什么值交出去」。
 *
 * <p>跑法见 test/java/run-java-test.sh。
 */
public final class BrowserGateTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        testDefaultClosed();
        testOpenThenApply();
        testUntrustedRejected();
        testIdempotent();
        testCloseReadsBackFalse();
        testConcurrentOpenOnlyOneTrue();
        testNoPersistenceOnRestart();
        testSourceHasNoPersistence();

        System.out.println();
        System.out.println("SUMMARY: " + pass + " pass / " + fail + " fail / 0 error");
        System.exit(fail == 0 ? 0 : 1);
    }

    // ── 1. 默认关 ────────────────────────────────────────────────────────────
    private static void testDefaultClosed() {
        FakeSettings s = new FakeSettings();
        BrowserGate g = new BrowserGate(s);
        check("1a 默认关（进程内初始状态）", !g.isOpen() && g.changes() == 0,
                "isOpen=" + g.isOpen() + " changes=" + g.changes());
        check("1b 默认关时不碰 WebSettings", s.applies == 0, "applies=" + s.applies);
    }

    // ── 2. 资产页开闸：返回 true 且落地 ───────────────────────────────────────
    private static void testOpenThenApply() {
        FakeSettings s = new FakeSettings();
        BrowserGate g = new BrowserGate(s);
        boolean changed = g.set(true, true);
        check("2a 开闸返回 true（JS 据此重载一次）", changed, "changed=" + changed);
        check("2b 开闸后 universal=true、fileAccessFrom 恒 false", s.universal && !s.fileAccessFrom,
                "universal=" + s.universal + " fileAccessFrom=" + s.fileAccessFrom);
        check("2c 开闸后状态为开", g.isOpen() && s.applies == 1,
                "isOpen=" + g.isOpen() + " applies=" + s.applies);
    }

    // ── 3. 白名单外：拒绝且状态不变（Bridge 的 allowed() 传 trusted=false） ──
    private static void testUntrustedRejected() {
        FakeSettings s = new FakeSettings();
        BrowserGate g = new BrowserGate(s);
        boolean changed = g.set(true, false);
        check("3a 白名单外开闸被拒（返回 false）", !changed, "changed=" + changed);
        check("3b 白名单外不改状态、不碰 WebSettings", !g.isOpen() && s.applies == 0 && g.changes() == 0,
                "isOpen=" + g.isOpen() + " applies=" + s.applies + " changes=" + g.changes());

        FakeSettings s2 = new FakeSettings();
        BrowserGate g2 = new BrowserGate(s2);
        g2.set(true, true);
        boolean closed = g2.set(false, false);
        check("3c 白名单外关闸同样被拒，闸门保持开", !closed && g2.isOpen() && s2.applies == 1,
                "closed=" + closed + " isOpen=" + g2.isOpen() + " applies=" + s2.applies);
    }

    // ── 4. 幂等：重复开闸返回 false，不重复落地（防重载循环） ────────────────
    private static void testIdempotent() {
        FakeSettings s = new FakeSettings();
        BrowserGate g = new BrowserGate(s);
        g.set(true, true);
        boolean again = g.set(true, true);
        check("4a 重复开闸幂等返回 false", !again, "again=" + again);
        check("4b 幂等时不重复落 WebSettings", s.applies == 1 && g.changes() == 1,
                "applies=" + s.applies + " changes=" + g.changes());
    }

    // ── 5. 关闸：两个开关都读回 false ────────────────────────────────────────
    private static void testCloseReadsBackFalse() {
        FakeSettings s = new FakeSettings();
        BrowserGate g = new BrowserGate(s);
        g.set(true, true);
        boolean closed = g.set(false, true);
        check("5a 关闸返回 true（JS 据此重载一次）", closed, "closed=" + closed);
        check("5b 关闸后两开关读回 false", !s.universal && !s.fileAccessFrom,
                "universal=" + s.universal + " fileAccessFrom=" + s.fileAccessFrom);
        boolean again = g.set(false, true);
        check("5c 关闸后再关：幂等 false、状态仍是关", !again && !g.isOpen() && g.changes() == 2,
                "again=" + again + " isOpen=" + g.isOpen() + " changes=" + g.changes());
    }

    // ── 6. 并发：同一时刻只有一个调用拿到 true ───────────────────────────────
    private static void testConcurrentOpenOnlyOneTrue() throws Exception {
        final FakeSettings s = new FakeSettings();
        final BrowserGate g = new BrowserGate(s);
        final AtomicInteger trues = new AtomicInteger();
        final CountDownLatch start = new CountDownLatch(1);
        final CountDownLatch done = new CountDownLatch(2);
        for (int i = 0; i < 2; i++) {
            new Thread(() -> {
                try {
                    start.await();
                    if (g.set(true, true)) trues.incrementAndGet();
                } catch (InterruptedException ignored) {
                } finally {
                    done.countDown();
                }
            }).start();
        }
        start.countDown();
        done.await();
        check("6 两个线程同时开闸，只有一个拿到 true（只重载一次）",
                trues.get() == 1 && s.applies == 1,
                "true_count=" + trues.get() + " applies=" + s.applies);
    }

    // ── 7. 模拟进程重启：新实例必然回 false（不持久化） ──────────────────────
    private static void testNoPersistenceOnRestart() {
        FakeSettings s = new FakeSettings();
        BrowserGate first = new BrowserGate(s);
        first.set(true, true);

        // 进程重启 = 新 Activity = 新闸门实例（磁盘上没有任何状态可恢复）
        FakeSettings s2 = new FakeSettings();
        BrowserGate restarted = new BrowserGate(s2);
        check("7a 重启后闸门是关的", !restarted.isOpen() && restarted.changes() == 0,
                "isOpen=" + restarted.isOpen() + " changes=" + restarted.changes());
        boolean closed = restarted.set(false, true);
        check("7b 重启后 request(close) 返回 false（本来就关，无需重载）",
                !closed && s2.applies == 0, "closed=" + closed + " applies=" + s2.applies);
    }

    // ── 8. 源码级：闸门类不许出现任何持久化 API ──────────────────────────────
    private static void testSourceHasNoPersistence() {
        Path src = Paths.get("app/src/top/xiaoma/tokendesk/BrowserGate.java");
        String text = "";
        String err = "";
        try {
            text = new String(Files.readAllBytes(src), StandardCharsets.UTF_8);
        } catch (IOException e) {
            err = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        // 注释里会**提到**这些名字（类注释写明「不写 SharedPreferences」），
        // 所以先剥掉注释只看代码，否则守卫会被自己的说明文字打红。
        String code = stripComments(text);
        String[] banned = {"SharedPreferences", "getSharedPreferences", "FileOutputStream",
                "Files.write", "openFileOutput", "new File("};
        String hit = "";
        for (String b : banned) {
            if (code.contains(b)) hit += b + " ";
        }
        check("8 不持久化：BrowserGate 代码零持久化 API（注释不计）",
                text.length() > 0 && hit.isEmpty(),
                text.isEmpty() ? "读不到源码 " + err
                        : "命中=[" + hit.trim() + "] 代码 " + code.replaceAll("\\s+", "").length() + " 字符");
    }

    /** 去掉 // 行注释与块注释，只留代码本体。 */
    private static String stripComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                while (i < n && src.charAt(i) != '\n') i++;
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(src.charAt(i) == '*' && src.charAt(i + 1) == '/')) i++;
                i += 2;
            } else if (c == '"') {
                out.append(c);
                i++;
                while (i < n) {
                    out.append(src.charAt(i));
                    if (src.charAt(i) == '\\' && i + 1 < n) {
                        out.append(src.charAt(i + 1));
                        i += 2;
                        continue;
                    }
                    if (src.charAt(i) == '"') {
                        i++;
                        break;
                    }
                    i++;
                }
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    // ── 工具 ─────────────────────────────────────────────────────────────────

    /** 与 MainActivity.applyBrowserMode 逐行同构的假 WebSettings。 */
    static final class FakeSettings implements BrowserGate.Sink {
        boolean universal = false;
        boolean fileAccessFrom = false;
        int applies = 0;

        @Override
        public void apply(boolean universalAccess) {
            universal = universalAccess;
            fileAccessFrom = false;   // 与真实现一致：这个开关恒关
            applies++;
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
}
