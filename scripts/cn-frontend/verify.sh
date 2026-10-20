#!/usr/bin/env bash
# 校验发布目录是否由 release.sh 从已提交源码构建且未被改动。
# 用法：verify.sh [发布目录，默认当前线上]；返回 0=通过，非 0=不通过（原因打到 stderr）
set -uo pipefail
REPO=${REPO:-/root/ai-dca}
D=$(readlink -f "${1:-/var/www/ai-dca-cn}")
fail(){ echo "[verify][FAIL] $D: $*" >&2; exit 1; }
[ -f "$D/RELEASE.json" ] || fail "缺 RELEASE.json（不是 release.sh 产物）"
[ -f "$D/MANIFEST.sha256" ] || fail "缺 MANIFEST.sha256"
commit=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['commit'])" "$D/RELEASE.json" 2>/dev/null) || fail "RELEASE.json 无法解析"
git -C "$REPO" cat-file -e "$commit^{commit}" 2>/dev/null || fail "commit $commit 不在 ai-dca 仓库"
( cd "$D" && sha256sum --quiet -c MANIFEST.sha256 >/dev/null 2>&1 ) || fail "文件内容与 MANIFEST 不一致（产出物被改）"
extra=$(cd "$D" && comm -13 <(awk '{print $2}' MANIFEST.sha256 | sort) <(find . -type f ! -name MANIFEST.sha256 | sort))
[ -z "$extra" ] || fail "存在 MANIFEST 外的文件：$(echo $extra | head -c 300)"
echo "[verify][OK] $D commit ${commit:0:8}"
