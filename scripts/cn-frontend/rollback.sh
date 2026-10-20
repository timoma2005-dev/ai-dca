#!/usr/bin/env bash
# 回滚到指定发布目录（必须通过 verify.sh）：bash scripts/cn-frontend/rollback.sh 20261020164626
set -euo pipefail
RELEASES=${RELEASES:-/var/www/ai-dca-cn-releases}
LIVE=${LIVE:-/var/www/ai-dca-cn}
T="$RELEASES/${1:?usage: rollback.sh <release-timestamp>}"
bash "$(dirname "$0")/verify.sh" "$T" || { echo "[rollback][BLOCKED] $T 未通过校验，只能回滚到 release.sh 产出的目录" >&2; exit 2; }
ln -sfn "$T" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
supervisorctl -c /etc/market-collector-supervisord.conf restart ai-dca-frontend
echo "live -> $T"
