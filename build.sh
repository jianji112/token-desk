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
BUMP="${TD_BUMP:-patch}"
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
VERSION_CODE=$((V_CODE + 1))
echo "版本：$V_NAME($V_CODE) → $VERSION_NAME($VERSION_CODE)  [bump=$BUMP]"
if [ "$DRY_RUN" = "1" ]; then
  echo "（DRY_RUN=1：只打印版本号，不出包、不写回 VERSION）"
  exit 0
fi
ASSETS_SRC="${TD_ASSETS_DIR:-$APP/assets}"
ASSETS_DIR="$OUT/assets"
APK_NAME="${TD_APK_NAME:-TokenDesk-$VERSION_NAME.apk}"
DEBUG_FLAG=""
[ "${TD_DEBUG:-0}" = "1" ] && DEBUG_FLAG="--debug-mode"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  [ -e "$f" ] || { echo "缺少构建组件: $f" >&2; exit 1; }
done

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

KS="${TD_KEYSTORE:-$ROOT/.signing/tokendesk.jks}"
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -alias tokendesk -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=TokenDesk, OU=opensource, O=TokenDesk, C=CN" >/dev/null 2>&1
  chmod 600 "$KS"
  echo "已生成签名证书 $KS"
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
echo "✅ 构建完成: $APK ($SIZE)"

printf 'name=%s\ncode=%s\n' "$VERSION_NAME" "$VERSION_CODE" > "$VERSION_FILE"
echo "🔖 已记录版本：$VERSION_NAME (versionCode $VERSION_CODE) → $VERSION_FILE"
