#!/usr/bin/env bash
# F7c-java 单测：纯 JVM，不需要 android.jar，不连 redroid，不装 APK。
# 只编 3 个文件（HttpJobRegistry + org.json shim + 测试本体），MainActivity 依赖 android.* 不参与。
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> public/

OUT="${TMPDIR:-/tmp}/td-java-test"
rm -rf "$OUT"
mkdir -p "$OUT"

javac --release 8 -Xlint:-options -d "$OUT" \
  test/java/org/json/JSONObject.java \
  test/java/top/xiaoma/tokendesk/F7cJavaTest.java \
  test/java/top/xiaoma/tokendesk/ApkDownloadTest.java \
  app/src/top/xiaoma/tokendesk/HttpJobRegistry.java \
  app/src/top/xiaoma/tokendesk/ApkDownload.java

java -cp "$OUT" top.xiaoma.tokendesk.F7cJavaTest
java -cp "$OUT" top.xiaoma.tokendesk.ApkDownloadTest
