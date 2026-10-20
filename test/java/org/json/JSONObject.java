package org.json;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 最小 org.json 替身，只服务 JVM 单测。
 *
 * <p>为什么需要：`android.jar` 里的 `android.*` 与 `org.json.*` 全是抛 `Stub!` 的桩，
 * 纯 JVM 上任何 `new JSONObject(...)` 都会直接炸，导致 HttpJobRegistry 无法被测。
 *
 * <p>纪律：只实现 TokenDesk 真正用到的方法（quote / put / optString / optInt / keys / toString
 * 和一个扁平对象解析）。遇到没实现的形态（嵌套对象、数组、非字符串键）**直接抛
 * UnsupportedOperationException**，不静默返回假值——否则测试会绿在假实现上。
 */
public final class JSONObject {

    private final Map<String, Object> map = new LinkedHashMap<>();

    public JSONObject() {
    }

    public JSONObject(String text) {
        parse(text);
    }

    public JSONObject put(String key, Object value) {
        map.put(key, value);
        return this;
    }

    public String optString(String key, String fallback) {
        Object v = map.get(key);
        return v == null ? fallback : String.valueOf(v);
    }

    public int optInt(String key, int fallback) {
        Object v = map.get(key);
        if (v == null) return fallback;
        if (v instanceof Number) return ((Number) v).intValue();
        try {
            return Integer.parseInt(String.valueOf(v).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    public Iterator<String> keys() {
        return new ArrayList<>(map.keySet()).iterator();
    }

    public boolean has(String key) {
        return map.containsKey(key);
    }

    /** 键按插入顺序输出；值只支持字符串/数值/布尔/null。 */
    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append(quote(e.getKey())).append(':').append(literal(e.getValue()));
        }
        return sb.append('}').toString();
    }

    private static String literal(Object v) {
        if (v == null) return "null";
        if (v instanceof Boolean || v instanceof Number) return String.valueOf(v);
        return quote(String.valueOf(v));
    }

    /** 与 org.json.JSONObject.quote 一致的转义行为。 */
    public static String quote(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                case '\\':
                case '/':
                    sb.append('\\').append(c);
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        String hex = Integer.toHexString(c);
                        sb.append("\\u");
                        for (int k = hex.length(); k < 4; k++) sb.append('0');
                        sb.append(hex);
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.append('"').toString();
    }

    private void parse(String text) {
        if (text == null) return;
        int[] pos = {0};
        if (nextNonWs(text, pos) < 0) return; // 空串 == 空对象
        if (text.charAt(pos[0]) != '{') throw new UnsupportedOperationException("shim 只能解析对象：" + text);
        pos[0]++;
        while (true) {
            int c = nextNonWs(text, pos);
            if (c < 0) throw new UnsupportedOperationException("对象未闭合：" + text);
            if (c == '}') {
                pos[0]++;
                return;
            }
            if (c == ',') {
                pos[0]++;
                continue;
            }
            if (c != '"') throw new UnsupportedOperationException("shim 只支持字符串键：" + text);
            String key = readString(text, pos);
            if (nextNonWs(text, pos) != ':') throw new UnsupportedOperationException("缺少冒号：" + text);
            pos[0]++;
            int v = nextNonWs(text, pos);
            if (v < 0) throw new UnsupportedOperationException("缺少值：" + text);
            map.put(key, readValue(text, pos, (char) v));
        }
    }

    private static Object readValue(String text, int[] pos, char c) {
        if (c == '"') return readString(text, pos);
        if (c == '{' || c == '[') {
            throw new UnsupportedOperationException("shim 不支持嵌套结构与数组：" + text);
        }
        int start = pos[0];
        while (pos[0] < text.length() && ",}] \t\r\n".indexOf(text.charAt(pos[0])) < 0) pos[0]++;
        String raw = text.substring(start, pos[0]).trim();
        if ("true".equals(raw)) return Boolean.TRUE;
        if ("false".equals(raw)) return Boolean.FALSE;
        if ("null".equals(raw)) return null;
        try {
            if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) {
                return Integer.valueOf(raw);
            }
            return Double.valueOf(raw);
        } catch (NumberFormatException e) {
            throw new UnsupportedOperationException("shim 无法识别的值：" + raw);
        }
    }

    private static String readString(String text, int[] pos) {
        StringBuilder sb = new StringBuilder();
        pos[0]++; // 跳过开引号
        while (pos[0] < text.length()) {
            char c = text.charAt(pos[0]++);
            if (c == '"') return sb.toString();
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            if (pos[0] >= text.length()) break;
            char e = text.charAt(pos[0]++);
            switch (e) {
                case '"':
                case '\\':
                case '/':
                    sb.append(e);
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'n':
                    sb.append('\n');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case 'u':
                    if (pos[0] + 4 > text.length()) throw new UnsupportedOperationException("\\u 转义不完整");
                    sb.append((char) Integer.parseInt(text.substring(pos[0], pos[0] + 4), 16));
                    pos[0] += 4;
                    break;
                default:
                    throw new UnsupportedOperationException("shim 不支持的转义：\\" + e);
            }
        }
        throw new UnsupportedOperationException("字符串未闭合：" + text);
    }

    private static int nextNonWs(String text, int[] pos) {
        while (pos[0] < text.length() && Character.isWhitespace(text.charAt(pos[0]))) pos[0]++;
        return pos[0] < text.length() ? text.charAt(pos[0]) : -1;
    }
}
