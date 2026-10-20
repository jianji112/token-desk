package top.xiaoma.tokendesk;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 在途 HTTP 请求登记表：负责提交、同 id 去重、取消（cancel/cancelAll）。
 *
 * <p>刻意不依赖任何 android.* 类（只用 java.net + org.json），因此可以在纯 JVM 上被
 * {@code test/java/top/xiaoma/tokendesk/F7cJavaTest} 直接验证「cancel 能否真的打断阻塞读」
 * —— 这是 F7c-java 里唯一有价值、又只能靠跑起来才能证明的部分。
 *
 * <p>为什么 cancel 必须 disconnect：{@code Future.cancel(true)} 只能中断线程的等待状态标记，
 * 打断不了已经阻塞在 socket read 上的调用；只有 {@code HttpURLConnection.disconnect()}
 * 关掉底层连接才能让 worker 立刻抛出 IOException 退出。
 */
public final class HttpJobRegistry {

    // 超时默认值：与历史行为一致（MainActivity 的 10s/45s 硬编码），可被 JS 的 httpOpts 覆盖
    static final int DEF_CONNECT_MS = 10000;
    static final int DEF_READ_MS = 45000;
    static final int MIN_TIMEOUT_MS = 1000;
    static final int MAX_TIMEOUT_MS = 120000;

    /** 一次请求的执行体。holder 写入底层连接，供 cancel 断连使用。 */
    public interface Task {
        String run(AtomicReference<HttpURLConnection> holder) throws Exception;
    }

    /** 完成回调。被取消的请求不会回调，避免取消后上游重试的响应被旧结果覆盖。 */
    public interface Sink {
        void onResult(String id, String payload);
    }

    static final class Inflight {
        volatile Future<?> future;
        volatile boolean cancelled;
        final AtomicReference<HttpURLConnection> conn = new AtomicReference<>();
    }

    private final ExecutorService pool;
    private final Sink sink;
    private final Map<String, Inflight> inflight = new ConcurrentHashMap<>();

    public HttpJobRegistry(ExecutorService pool, Sink sink) {
        this.pool = pool;
        this.sink = sink;
    }

    /**
     * 提交一次请求。
     *
     * <p>同 id 已在途时**丢弃新来的**并返回 false，而不是「撤旧的、起新的」：JS 侧
     * {@code pending[id]} 只会 settle 一次，同一 id 的第二份响应注定被丢掉，起新请求只会让
     * 服务器多收一次（正是要修的「同一 POST 发两次」）。真正的重试由 JS 换新 id + cancel(id) 完成。
     *
     * @return true 已真正下发；false id 非法 / 同 id 在途 / 线程池已关
     */
    public boolean submit(final String id, final Task task) {
        if (id == null || id.isEmpty() || task == null) return false;
        final Inflight job = new Inflight();
        if (inflight.putIfAbsent(id, job) != null) return false;
        try {
            job.future = pool.submit(() -> runJob(id, job, task));
        } catch (Throwable t) {
            inflight.remove(id, job);
            return false;
        }
        // 提交与 cancel 的竞态：cancel 先到时把刚拿到的 future 补撤
        if (job.cancelled) job.future.cancel(true);
        return true;
    }

    private void runJob(String id, Inflight job, Task task) {
        if (job.cancelled) {
            inflight.remove(id, job);
            return;
        }
        String payload;
        try {
            payload = task.run(job.conn);
        } catch (Throwable t) {
            String msg = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
            payload = "{\"error\":" + JSONObject.quote(msg) + "}";
        }
        inflight.remove(id, job);
        if (job.cancelled) return;
        Sink s = sink;
        if (s != null) s.onResult(id, payload);
    }

    /** 取消单个在途请求：中断 + 断连，返回是否命中。 */
    public boolean cancel(String id) {
        if (id == null || id.isEmpty()) return false;
        Inflight job = inflight.remove(id);
        if (job == null) return false;
        abort(job);
        return true;
    }

    /** 取消全部在途请求（页面销毁用），返回命中条数。 */
    public int cancelAll() {
        List<String> ids = new ArrayList<>(inflight.keySet());
        int n = 0;
        for (String id : ids) {
            if (cancel(id)) n++;
        }
        return n;
    }

    /** 当前在途条数（测试与诊断用）。 */
    public int size() {
        return inflight.size();
    }

    public boolean isInflight(String id) {
        return id != null && inflight.containsKey(id);
    }

    private static void abort(Inflight job) {
        job.cancelled = true;
        Future<?> f = job.future;
        if (f != null) f.cancel(true);
        HttpURLConnection c = job.conn.get();
        if (c != null) {
            try {
                c.disconnect();
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * 超时夹紧：非正值回落到**该参数自己的**默认值，越界夹到 [MIN,MAX]。
     * 早先的实现一律回落到 DEF_READ_MS，会把 connectMs=0 放大成 45s（比默认 10s 还慢 4.5 倍）。
     */
    public static int clampTimeout(int ms, int def) {
        if (ms <= 0) return def;
        if (ms < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
        if (ms > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
        return ms;
    }
}
