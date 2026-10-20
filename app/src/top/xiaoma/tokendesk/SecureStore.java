package top.xiaoma.tokendesk;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 凭证安全存储：AES/GCM 加密后落 SharedPreferences，密钥由 Android Keystore 持有，
 * 应用进程内拿不到明文密钥材料（root 提取 shared_prefs 也只能看到密文）。
 *
 * <p>存储格式定版：SharedPreferences 名为 {@code td_secure}，每个业务 key 一个条目，
 * 值为 {@code Base64(iv ‖ ciphertext‖tag)}，iv 固定 12 字节（GCM 标准长度，由
 * KeyGenParameterSpec 的 randomized-encryption 生成）。主密钥 alias
 * {@code tokendesk.master.v1}，AES-256/GCM/NoPadding。
 *
 * <p>安全纪律：
 * <ul>
 *   <li>任何异常都**不打印、不返回**凭证内容与密文（异常只留在 Keystore 内部，
 *       对外一律退化为 false / null，由 JS 侧回退 localStorage 并标红）。</li>
 *   <li>{@link #secureClear()} 会连同主密钥一起删除，避免 logout 后残留可解密的密文。</li>
 *   <li>本类不做线程同步之外的额外缓存；Keystore 探测失败每次都会重试，
 *       以免一次偶发失败把整个会话钉死在「不可用」。</li>
 * </ul>
 */
public final class SecureStore {

    /** SharedPreferences 文件名（定版）。 */
    static final String PREFS_NAME = "td_secure";
    /** Android Keystore 主密钥别名（定版）。 */
    static final String KEY_ALIAS = "tokendesk.master.v1";
    private static final String KEYSTORE = "AndroidKeyStore";

    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private static final int KEY_BITS = 256;

    private final Context appContext;

    public SecureStore(Context context) {
        // 只拿 application context：不持有 Activity 引用，避免泄漏；
        // 构造阶段不碰 Keystore，绝不阻塞 onCreate。
        Context c = context.getApplicationContext();
        this.appContext = c != null ? c : context;
    }

    private SharedPreferences prefs() {
        return appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /**
     * Keystore 是否可用。返回 false 时调用方必须回退到 localStorage 并显式标红，
     * 不得静默降级成「凭证看起来存上了」。
     */
    public boolean secureAvailable() {
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 加密写入单个 key。成功返回 true；任何异常返回 false（不抛出、不带内容）。 */
    public boolean secureSet(String key, String value) {
        if (key == null || key.isEmpty() || value == null) return false;
        try {
            byte[] iv;
            byte[] cipherText;
            synchronized (SecureStore.class) {
                SecretKey master = loadOrCreateKey();
                Cipher cipher = Cipher.getInstance(TRANSFORMATION);
                cipher.init(Cipher.ENCRYPT_MODE, master);
                iv = cipher.getIV();
                cipherText = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            }
            if (iv == null || iv.length != IV_LEN) return false;
            byte[] packed = new byte[iv.length + cipherText.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(cipherText, 0, packed, iv.length, cipherText.length);
            String encoded = Base64.encodeToString(packed, Base64.NO_WRAP);
            return prefs().edit().putString(key, encoded).commit();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 解密读取单个 key。不存在、密文损坏、密钥丢失一律返回 null。 */
    public String secureGet(String key) {
        if (key == null || key.isEmpty()) return null;
        String encoded;
        try {
            encoded = prefs().getString(key, null);
        } catch (Throwable t) {
            return null;
        }
        if (encoded == null || encoded.isEmpty()) return null;
        try {
            byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
            if (packed.length <= IV_LEN) return null;
            byte[] iv = new byte[IV_LEN];
            byte[] cipherText = new byte[packed.length - IV_LEN];
            System.arraycopy(packed, 0, iv, 0, IV_LEN);
            System.arraycopy(packed, IV_LEN, cipherText, 0, cipherText.length);
            byte[] plain;
            synchronized (SecureStore.class) {
                KeyStore ks = KeyStore.getInstance(KEYSTORE);
                ks.load(null);
                if (!ks.containsAlias(KEY_ALIAS)) return null;
                SecretKey master = (SecretKey) ks.getKey(KEY_ALIAS, null);
                if (master == null) return null;
                Cipher cipher = Cipher.getInstance(TRANSFORMATION);
                cipher.init(Cipher.DECRYPT_MODE, master, new GCMParameterSpec(TAG_BITS, iv));
                plain = cipher.doFinal(cipherText);
            }
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 清空所有密文并删除主密钥。用于退出登录 / 迁移完成后清理旧存储。
     * 删除密钥是刻意的：残留密文在没有密钥时不可解，等于把「已清除」做成物理事实。
     */
    public void secureClear() {
        try {
            prefs().edit().clear().commit();
        } catch (Throwable ignored) {
        }
        synchronized (SecureStore.class) {
            try {
                KeyStore ks = KeyStore.getInstance(KEYSTORE);
                ks.load(null);
                if (ks.containsAlias(KEY_ALIAS)) {
                    ks.deleteEntry(KEY_ALIAS);
                }
            } catch (Throwable ignored) {
            }
        }
    }

    /** 取主密钥，不存在则生成。调用方需持有 SecureStore.class 锁。 */
    private static SecretKey loadOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            SecretKey existing = (SecretKey) ks.getKey(KEY_ALIAS, null);
            if (existing != null) return existing;
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build();
        kg.init(spec);
        return kg.generateKey();
    }
}
