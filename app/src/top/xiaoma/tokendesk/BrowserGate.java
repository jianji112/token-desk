package top.xiaoma.tokendesk;

/**
 * 浏览器内核直连闸门（Wave B ③，2026-10-21 定案）。
 *
 * <p>背景：{@code file://} 资产页在 {@code setAllowUniversalAccessFromFileURLs(false)} 下
 * 变成 {@code origin=null} 的普通请求方，真实网关（NewAPI 3010 / 账号池 8788）不返回
 * {@code Access-Control-Allow-Origin} → 「浏览器内核直连」通道对内网网关必然 CORS 失败。
 * 但这两个万能跨源开关又不能常开（主人 2026-10-21 明令关掉的后门），
 * 于是改成「按需开闸」：页面切到非 native 通道时临时打开，切回 native 立即关闭。
 *
 * <p>四条硬约束（秘书长定版，改动前先报备）：
 * <ul>
 *   <li>默认关，只有页面显式请求才开；</li>
 *   <li><b>不持久化</b>：不写 SharedPreferences、不写文件，进程重启必然回到 false；</li>
 *   <li>只在资产白名单内的调用生效（{@code trusted=false} 直接拒绝且状态不变）；</li>
 *   <li>重复设置同一值返回 false（幂等）；JS 只在返回 true 时重载页面，防止重载循环。</li>
 * </ul>
 *
 * <p>纯 Java、无 android 依赖，可被 JVM 单测直接覆盖（见 test/java 下的 BrowserGateTest）。
 */
final class BrowserGate {

    /** 把闸门状态落到真实 WebSettings 的出口；MainActivity 里实现为切到 UI 线程后再写。 */
    interface Sink {
        void apply(boolean universalAccess);
    }

    private final Sink sink;
    private boolean open = false;   // guarded by this
    private int changes = 0;        // guarded by this，仅供测试与诊断

    BrowserGate(Sink sink) {
        this.sink = sink;
    }

    /**
     * 请求把闸门设置成 want。
     *
     * @param want    true=放开跨源（浏览器内核直连要用），false=收紧回默认
     * @param trusted 调用方是否来自资产页（Bridge 的 allowed() 结果）
     * @return true 表示状态真的变了，调用方应重载页面一次；false 表示被拒或本来就等于 want
     */
    boolean set(boolean want, boolean trusted) {
        if (!trusted) return false;
        synchronized (this) {
            if (open == want) return false;
            open = want;
            changes++;
        }
        Sink s = sink;
        if (s != null) {
            try {
                s.apply(want);
            } catch (Throwable ignored) {
                // 落设置失败不回滚内存状态：页面下一次请求会再走一遍，不在这里把异常抛给 JS
            }
        }
        return true;
    }

    /** 当前闸门状态（仅进程内有效，进程重启即 false）。 */
    synchronized boolean isOpen() {
        return open;
    }

    /** 状态变更次数，只给测试与诊断用，不对 JS 暴露。 */
    synchronized int changes() {
        return changes;
    }
}
