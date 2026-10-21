package top.xiaoma.tokendesk;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 FileProvider：把 cache/apk/ 下的更新包以 content:// 暴露给系统包安装器。
 *
 * <p>为什么不用 androidx.core.content.FileProvider：本项目不引 AndroidX（无 Gradle）。
 * targetSdk 24+ 用 file:// 传 APK 会直接 FileUriExposure 崩溃，所以必须给 content:// URI。
 *
 * <p>安全边界：只服务 {@code cache/apk/} 这一层里的文件，URI 末段必须是
 * {@link ApkDownload#safeName(String)} 清洗后同名的纯文件名，杜绝 ../ 穿越。
 */
public class ApkProvider extends ContentProvider {

    public static final String AUTHORITY = "top.xiaoma.tokendesk.apk";
    private static final String DIR = "apk";

    public static File dirOf(Context ctx) {
        File d = new File(ctx.getCacheDir(), DIR);
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    public static Uri uriFor(Context ctx, File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(f.getName()).build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Context ctx = getContext();
        if (ctx == null) {
            throw new FileNotFoundException("no context");
        }
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) {
            throw new FileNotFoundException("empty name");
        }
        // 只认清洗后的纯文件名：任何分隔符/穿越写法一律拒绝
        if (!ApkDownload.safeName(name).equals(name)) {
            throw new FileNotFoundException("bad name");
        }
        File f = new File(dirOf(ctx), name);
        if (!f.exists() || !f.isFile()) {
            throw new FileNotFoundException(name);
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only");
    }
}
