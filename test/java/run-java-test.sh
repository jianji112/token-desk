#!/usr/bin/env bash
# Java 单测：纯 JVM，不需要装 APK、不连 redroid。
#   F7cJavaTest      — HttpJobRegistry：取消即断 / 同 id 去重 / clampTimeout
#   BrowserGateTest  — Wave B ③ 按需开闸：默认关 / 白名单拒绝 / 幂等 / 关闸读回 false / 不持久化
# MainActivity 依赖 android.*，不参与本脚本（真机启动由真机验收覆盖，见准入规则）。
set -uo pipefail
cd "$(dirname "$0")/../.."   # -> public/

OUT="${TMPDIR:-/tmp}/td-java-test"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "## javac --release 8"
if ! javac --release 8 -Xlint:-options -d "$OUT" \
  test/java/org/json/JSONObject.java \
  test/java/top/xiaoma/tokendesk/F7cJavaTest.java \
  test/java/top/xiaoma/tokendesk/BrowserGateTest.java \
  app/src/top/xiaoma/tokendesk/HttpJobRegistry.java \
  app/src/top/xiaoma/tokendesk/BrowserGate.java; then
  echo "SUMMARY: 0 pass / 0 fail / 1 error"
  exit 1
fi

run_suite() {
  local main="$1"
  echo
  echo "## ${main##*.}"
  java -cp "$OUT" "$main"
  return $?
}

run_suite top.xiaoma.tokendesk.F7cJavaTest
f7c=$?
run_suite top.xiaoma.tokendesk.BrowserGateTest
bg=$?

if [ "$f7c" -ne 0 ] || [ "$bg" -ne 0 ]; then
  echo
  echo "JAVA_TEST_FAILED (F7cJavaTest exit=$f7c / BrowserGateTest exit=$bg)"
  exit 1
fi
exit 0
