#!/usr/bin/env bash
# 自动发布（supervisor: ai-dca-frontend-autorelease）：每 60 秒 git fetch origin（公开仓库，无需凭据），
# origin/<分支> 比线上发布新、且改动涉及前端文件时：工作区干净则 fast-forward 到 origin，再调用 release.sh。
# 工作区有未提交的前端改动或本地分支已分叉时只记日志、不发布。
REPO=${REPO:-/root/ai-dca}
LIVE=${LIVE:-/var/www/ai-dca-cn}
INTERVAL=${INTERVAL:-60}
FE_PATHS="src shared public index.html home.html vite.config.js package.json postcss.config.mjs"
log(){ echo "$(date '+%F %T') $*"; }
cd "$REPO" || exit 1
while true; do
  BR=$(git rev-parse --abbrev-ref HEAD)
  if timeout 60 git fetch -q origin "$BR" 2>/tmp/autorelease-fetch.err; then
    REMOTE=$(git rev-parse "origin/$BR")
    LIVEC=$(python3 -c "import json;print(json.load(open('$LIVE/RELEASE.json'))['commit'])" 2>/dev/null || echo none)
    if [ "$REMOTE" != "$LIVEC" ]; then
      if [ "$LIVEC" != none ] && git cat-file -e "$LIVEC^{commit}" 2>/dev/null && [ -z "$(git diff --name-only "$LIVEC" "$REMOTE" -- $FE_PATHS)" ]; then
        : # 新提交不涉及前端，跳过
      elif [ -n "$(git status --porcelain -- $FE_PATHS)" ]; then
        log "[skip] origin/$BR=${REMOTE:0:8} 有新前端提交，但工作区有未提交前端改动"
      elif ! git merge-base --is-ancestor HEAD "$REMOTE"; then
        [ "$(git rev-parse HEAD)" = "$REMOTE" ] || log "[skip] 本地 $BR 与 origin/$BR 已分叉，需要人工处理"
        [ "$(git rev-parse HEAD)" = "$REMOTE" ] && { log "[release] ${REMOTE:0:8}"; bash scripts/cn-frontend/release.sh 2>&1 | sed 's/^/  /'; }
      else
        if git merge -q --ff-only "$REMOTE" 2>/tmp/autorelease-merge.err; then
          log "[release] ff -> ${REMOTE:0:8}"; bash scripts/cn-frontend/release.sh 2>&1 | sed 's/^/  /'
        else
          log "[skip] fast-forward 失败：$(head -c 300 /tmp/autorelease-merge.err)"
        fi
      fi
    fi
  fi
  sleep "$INTERVAL"
done
