#!/usr/bin/env bash
# CN 前端发布：Vite 构建到新发布目录 → 切软链 → 重启 vite preview（supervisor）→ 健康检查，失败自动回滚。
# 用法：bash scripts/cn-frontend/release.sh
set -euo pipefail
REPO=${REPO:-/root/ai-dca}
RELEASES=${RELEASES:-/var/www/ai-dca-cn-releases}
LIVE=${LIVE:-/var/www/ai-dca-cn}
PORT=${PORT:-4173}
SUPCTL="supervisorctl -c /etc/market-collector-supervisord.conf"
TS=$(date +%Y%m%d%H%M%S)
OUT="$RELEASES/$TS"
PREV=$(readlink -f "$LIVE")

cd "$REPO"
echo "[release] build -> $OUT (commit $(git rev-parse --short HEAD))"
VITE_API_ORIGIN=${VITE_API_ORIGIN:-https://api.freebacktrack.tech} VITE_OUT_DIR="$OUT" npx vite build >/tmp/cn-frontend-build.log 2>&1 || { tail -30 /tmp/cn-frontend-build.log; exit 1; }
cat > "$OUT/RELEASE.json" <<J
{"release":"$TS","commit":"$(git rev-parse HEAD)","branch":"$(git rev-parse --abbrev-ref HEAD)","dirty":$( [ -n "$(git status --porcelain -- src shared public index.html home.html vite.config.js)" ] && echo true || echo false ),"previous":"$PREV"}
J

ln -sfn "$OUT" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
$SUPCTL restart ai-dca-frontend >/dev/null
for i in $(seq 1 20); do
  code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/home.html" || true)
  [ "$code" = 200 ] && break; sleep 1
done
if [ "$code" != 200 ]; then
  echo "[release] health check failed ($code), rollback -> $PREV"
  ln -sfn "$PREV" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
  $SUPCTL restart ai-dca-frontend >/dev/null
  exit 1
fi
echo "[release] live -> $OUT ；回滚：bash scripts/cn-frontend/rollback.sh $(basename "$PREV")"
