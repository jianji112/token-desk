#!/usr/bin/env bash
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/app"
OUT="${TD_BUILD_DIR:-$ROOT/build}"
DIST="${TD_DIST_DIR:-$ROOT/dist}"
mkdir -p "$OUT" "$DIST" "$ROOT/.signing"
ENVFILE="${TD_ENV_FILE:-$ROOT/.env}"
PKG="top.xiaoma.tokendesk"

VERSION_FILE="${TD_VERSION_FILE:-$ROOT/VERSION}"
# 默认不 bump：开发迭代只出包不改版本号；发版时才显式 TD_BUMP=patch|minor|major
BUMP="${TD_BUMP:-none}"
DRY_RUN="${TD_DRY_RUN:-0}"

V_NAME="1.0.0"; V_CODE="1"
if [ -f "$VERSION_FILE" ]; then
  V_NAME="$( { grep -E '^name=' "$VERSION_FILE" | tail -1 | cut -d= -f2-; } || true )"
  V_CODE="$( { grep -E '^code=' "$VERSION_FILE" | tail -1 | cut -d= -f2-; } || true )"
  V_NAME="$(printf '%s' "$V_NAME" | tr -d ' \t\r')"
  V_CODE="$(printf '%s' "$V_CODE" | tr -d ' \t\r')"
fi
V_NAME="${V_NAME:-1.0.0}"; V_CODE="${V_CODE:-1}"

_v_major="$(echo "$V_NAME" | cut -d. -f1)"; _v_minor="$(echo "$V_NAME" | cut -d. -f2)"; _v_patch="$(echo "$V_NAME" | cut -d. -f3)"
_v_major="${_v_major:-1}"; _v_minor="${_v_minor:-0}"; _v_patch="${_v_patch:-0}"
case "$BUMP" in
  major) _v_major=$((_v_major + 1)); _v_minor=0; _v_patch=0 ;;
  minor) _v_minor=$((_v_minor + 1)); _v_patch=0 ;;
  none)  ;;
  *)     _v_patch=$((_v_patch + 1)) ;;
esac
VERSION_NAME="$_v_major.$_v_minor.$_v_patch"
# 只有显式 bump 才递增 versionCode；none 模式版本号与 code 全部保持原值
if [ "$BUMP" = "none" ]; then
  VERSION_CODE="$V_CODE"
else
  VERSION_CODE=$((V_CODE + 1))
fi
echo "版本：$V_NAME($V_CODE) → $VERSION_NAME($VERSION_CODE)  [bump=$BUMP]"
if [ "$DRY_RUN" = "1" ]; then
  echo "（DRY_RUN=1：只打印版本号，不出包、不写回 VERSION）"
  exit 0
fi
ASSETS_SRC="${TD_ASSETS_DIR:-$APP/assets}"
ASSETS_DIR="$OUT/assets"
# 包名带出包时的实际 HEAD（不写死）：同名不同物是真实事故——10-20 的旧包与 Wave B 验收包
# 版本号完全相同，只靠文件名分不开。带短 commit 后，「这枚包是哪一版」和安装前 sha256 核对
# 都能一眼对上。工作树不干净时加 -dirty 后缀，让脏树包不可能被当成验收产物。
GIT_SHORT="$( { git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true; } | tr -d '[:space:]' )"
GIT_SHORT="${GIT_SHORT:-nogit}"
GIT_DIRTY=""
if [ -n "$( { git -C "$ROOT" status --porcelain 2>/dev/null || true; } )" ]; then
  GIT_DIRTY="-dirty"
  echo "⚠️ 工作树不干净（HEAD $GIT_SHORT）：包名加 -dirty 后缀，此包不得作为验收产物"
fi
APK_NAME="${TD_APK_NAME:-TokenDesk-$VERSION_NAME-$GIT_SHORT$GIT_DIRTY.apk}"
echo "📦 包名：$APK_NAME"
DEBUG_FLAG=""
[ "${TD_DEBUG:-0}" = "1" ] && DEBUG_FLAG="--debug-mode"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  [ -e "$f" ] || { echo "缺少构建组件: $f" >&2; exit 1; }
done

# ── 签名密钥守卫 ────────────────────────────────────────────────────────────
# 自动生成新密钥 = 换签名 = 设备上已装的包覆盖安装必然失败（INSTALL_FAILED_UPDATE_INCOMPATIBLE），
# 只能卸载重装、应用数据全丢。所以「生成新密钥」必须显式 TD_ALLOW_NEW_KEY=1 才放行。
# 本脚本刻意不回落到 ../private（private/build.sh:2 要求 public/ 不知道私有布局）。
KS_EXPLICIT="${TD_KEYSTORE:-}"
KS="${KS_EXPLICIT:-$ROOT/.signing/tokendesk.jks}"
ALLOW_NEW_KEY="${TD_ALLOW_NEW_KEY:-0}"
if [ ! -f "$KS" ]; then
  if [ "$ALLOW_NEW_KEY" != "1" ]; then
    if [ -z "$KS_EXPLICIT" ]; then
      echo "错误：签名密钥不存在：$KS（未显式给 TD_KEYSTORE，用的是默认位置）" >&2
    else
      echo "错误：签名密钥不存在：$KS（TD_KEYSTORE 指向的文件缺失）" >&2
    fi
    echo "  生成新密钥会换签名：设备上已装的包只能卸载重装，应用数据全部丢失。" >&2
    echo "  正常私钥在 private/keystore，应从 private/build.sh 出包（它自己指定 TD_KEYSTORE）。" >&2
    echo "  确实要用新签名（例如从未发布过的自用包）：显式加 TD_ALLOW_NEW_KEY=1 再跑。" >&2
    exit 1
  fi
  echo "⚠️ TD_ALLOW_NEW_KEY=1：在 $KS 生成新签名密钥（与已发布签名不同，旧包不能覆盖升级）"
fi

KS_PASS="${TD_KS_PASS:-}"
if [ -z "$KS_PASS" ] && [ -f "$ENVFILE" ]; then
  KS_PASS="$( { grep -E '^TD_KS_PASS=' "$ENVFILE" | tail -1 | cut -d= -f2-; } || true )"
  KS_PASS="$(printf '%s' "$KS_PASS" | tr -d "\"' \t" || true)"
fi
if [ -z "$KS_PASS" ]; then
  KS_PASS="$(python3 -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))')"
  printf 'TD_KS_PASS=%s\n' "$KS_PASS" >> "$ENVFILE"
  chmod 600 "$ENVFILE"
  echo "已生成签名口令并写入 $ENVFILE (TD_KS_PASS)"
fi

if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -alias tokendesk -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=TokenDesk, OU=opensource, O=TokenDesk, C=CN" >/dev/null 2>&1
  chmod 600 "$KS"
  echo "已生成签名证书 $KS"
fi

# 出包记录里可直接核：实际使用的 keystore 路径 + 证书指纹（与设备已装包比对用）
echo "🔑 签名 keystore：$KS"
KS_FP="$( { keytool -list -v -keystore "$KS" -alias tokendesk -storepass "$KS_PASS" 2>/dev/null || true; } \
  | { grep -m1 'SHA256:' || true; } | sed 's/.*SHA256: *//' )"
if [ -n "$KS_FP" ]; then
  echo "🔑 证书 SHA-256：$KS_FP"
else
  echo "🔑 证书 SHA-256：（读取失败，口令与 keystore 不匹配？签名步骤会报错）"
fi

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$DIST"

python3 "$ROOT/tools/inject-presets.py" "$ASSETS_SRC" "$ASSETS_DIR"

echo "[1/6] 编译资源"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip"

echo "[2/6] 链接资源与清单"
"$BT/aapt2" link $DEBUG_FLAG -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$OUT/res.zip" \
  -A "$ASSETS_DIR" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --replace-version --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --auto-add-overlay

echo "[3/6] 编译 Java"
find "$APP/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac --release 8 -Xlint:-options -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"
[ -f "$OUT/classes/top/xiaoma/tokendesk/MainActivity.class" ] || { echo "javac 失败" >&2; exit 1; }

echo "[4/6] dex 转换"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$OUT/dex" @"$OUT/classes.txt"

echo "[5/6] 打包 + 对齐"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT" && zip -q -j unsigned.apk dex/classes.dex )
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[6/6] 签名"
APK="$DIST/$APK_NAME"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$APK" | head -4

SIZE="$(du -h "$APK" | cut -f1)"
APK_SHA256="$(sha256sum "$APK" | cut -d' ' -f1)"
echo "✅ 构建完成: $APK ($SIZE)"
echo "🔐 APK sha256：$APK_SHA256"
echo "   安装前硬校验：sha256sum \"$APK\" 必须等于上面这串（设备上 pm path 拉回的包也要一致才允许覆盖安装）"

if [ "$BUMP" = "none" ]; then
  echo "🔖 bump=none：不写回 $VERSION_FILE（版本仍为 $VERSION_NAME / code $VERSION_CODE）"
else
  printf 'name=%s\ncode=%s\n' "$VERSION_NAME" "$VERSION_CODE" > "$VERSION_FILE"
  echo "🔖 已记录版本：$VERSION_NAME (versionCode $VERSION_CODE) → $VERSION_FILE"
fi

# dist 保留份数（默认 3，TD_KEEP_DIST 可调；只删本工具产出的 TokenDesk-*.apk/.idsig）
KEEP_DIST="${TD_KEEP_DIST:-3}"
prune_dist() {
  case "$KEEP_DIST" in ''|*[!0-9]*) echo "⚠️ TD_KEEP_DIST=$KEEP_DIST 非数字，跳过 dist 清理"; return 0 ;; esac
  if [ "$KEEP_DIST" -lt 1 ]; then
    echo "⚠️ TD_KEEP_DIST=$KEEP_DIST，跳过 dist 清理"; return 0
  fi
  local stale
  stale="$(ls -1t "$DIST"/TokenDesk-*.apk 2>/dev/null | tail -n +$((KEEP_DIST + 1)) || true)"
  if [ -z "$stale" ]; then
    echo "🧹 dist 无需清理（≤${KEEP_DIST} 份）"
    return 0
  fi
  local f n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rm -f -- "$f" "$f.idsig"
    n=$((n + 1))
  done <<< "$stale"
  echo "🧹 dist 清理：保留最近 ${KEEP_DIST} 份，删除 ${n} 份旧包"
}
prune_dist
