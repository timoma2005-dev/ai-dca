#!/usr/bin/env bash
# 回滚到指定发布目录：bash scripts/cn-frontend/rollback.sh 20261020123145
set -euo pipefail
RELEASES=${RELEASES:-/var/www/ai-dca-cn-releases}
LIVE=${LIVE:-/var/www/ai-dca-cn}
T="$RELEASES/${1:?usage: rollback.sh <release-timestamp>}"
[ -f "$T/home.html" ] || { echo "no such release: $T"; exit 1; }
ln -sfn "$T" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
supervisorctl -c /etc/market-collector-supervisord.conf restart ai-dca-frontend
echo "live -> $T"
