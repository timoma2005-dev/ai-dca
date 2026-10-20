#!/usr/bin/env bash
# CN 前端发布（唯一合法入口）：源码 → Vite 构建 → 新发布目录（带 MANIFEST，只读）→ 切软链 → 重启 vite preview → 健康检查，失败自动回滚。
# 栅栏：工作区必须干净、HEAD 必须已 push 到 origin（git merge-base --is-ancestor HEAD origin/<branch>）。
# 用法：bash scripts/cn-frontend/release.sh
set -euo pipefail
exec 9>/tmp/cn-frontend-release.lock; flock -n 9 || { echo "[release] 另一个发布正在进行" >&2; exit 3; }
REPO=${REPO:-/root/ai-dca}
RELEASES=${RELEASES:-/var/www/ai-dca-cn-releases}
LIVE=${LIVE:-/var/www/ai-dca-cn}
PORT=${PORT:-4173}
SUPCTL="supervisorctl -c /etc/market-collector-supervisord.conf"
cd "$REPO"
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# ── 栅栏 1：只能从干净、已推送的源码发布 ──
DIRTY=$(git status --porcelain --untracked-files=normal -- src shared public index.html home.html vite.config.js package.json postcss.config.mjs)
if [ -n "$DIRTY" ]; then echo "[release][BLOCKED] 源码有未提交改动，先 commit + push：" >&2; echo "$DIRTY" >&2; exit 2; fi
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH" 2>/dev/null; then
  echo "[release][BLOCKED] HEAD $(git rev-parse --short HEAD) 未推送到 origin/$BRANCH，先 git push origin $BRANCH" >&2; exit 2; fi

TS=$(date +%Y%m%d%H%M%S); OUT="$RELEASES/$TS"; PREV=$(readlink -f "$LIVE")
echo "[release] build -> $OUT (commit $(git rev-parse --short HEAD))"
VITE_API_ORIGIN=${VITE_API_ORIGIN:-https://api.freebacktrack.tech} VITE_OUT_DIR="$OUT" npx vite build >/tmp/cn-frontend-build.log 2>&1 || { tail -30 /tmp/cn-frontend-build.log; exit 1; }
cat > "$OUT/RELEASE.json" <<J
{"release":"$TS","commit":"$(git rev-parse HEAD)","branch":"$BRANCH","source":"scripts/cn-frontend/release.sh","previous":"$PREV"}
J
# ── 栅栏 2：文件指纹 + 只读 ──
( cd "$OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )
chmod -R a-w "$OUT"

ln -sfn "$OUT" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
$SUPCTL restart ai-dca-frontend >/dev/null
code=000
for i in $(seq 1 20); do
  code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/home.html" || true)
  [ "$code" = 200 ] && break; sleep 1
done
if [ "$code" != 200 ]; then
  echo "[release] health check failed ($code), rollback -> $PREV"
  ln -sfn "$PREV" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"; $SUPCTL restart ai-dca-frontend >/dev/null; exit 1
fi
echo "[release] live -> $OUT ；回滚：bash scripts/cn-frontend/rollback.sh $(basename "$PREV")"
