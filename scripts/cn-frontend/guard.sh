#!/usr/bin/env bash
# 守护进程（supervisor: ai-dca-frontend-guard）：每 60 秒校验线上发布目录；
# 不通过 → 自动回滚到最新一个校验通过的发布目录，并重启 vite preview。
REPO=${REPO:-/root/ai-dca}
RELEASES=${RELEASES:-/var/www/ai-dca-cn-releases}
LIVE=${LIVE:-/var/www/ai-dca-cn}
V="$REPO/scripts/cn-frontend/verify.sh"
while true; do
  if ! out=$(bash "$V" "$LIVE" 2>&1); then
    echo "$(date '+%F %T') $out"
    good=""
    for d in $(ls -1d "$RELEASES"/2* 2>/dev/null | sort -r); do
      [ "$(readlink -f "$LIVE")" = "$d" ] && continue
      bash "$V" "$d" >/dev/null 2>&1 && { good="$d"; break; }
    done
    if [ -n "$good" ]; then
      ln -sfn "$good" "$LIVE.tmp" && mv -Tf "$LIVE.tmp" "$LIVE"
      supervisorctl -c /etc/market-collector-supervisord.conf restart ai-dca-frontend >/dev/null
      echo "$(date '+%F %T') [guard] 已自动回滚 -> $good"
    else
      echo "$(date '+%F %T') [guard] 没有校验通过的发布目录可回滚"
    fi
  fi
  sleep 60
done
