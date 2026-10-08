#!/bin/bash
# Unified deployment script for ai-dca
# Replaces GitHub Actions workflows with local execution.
#
# Usage:
#   ./scripts/deploy-unified.sh --target <pages|cn|workers|all> [options]
#
# Targets:
#   pages    - Build main branch frontend, deploy to Cloudflare Pages (ai-dca.pages.dev)
#   cn       - Build cn branch frontend, deploy to CN host via SSH
#   workers  - Deploy all Cloudflare Workers via wrangler
#   all      - Run all three in sequence
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  - Cloudflare API token (for wrangler pages/workers deploy)
#   CN_SSH_PASSWORD       - CN host root password (for cn target only)
#
# Optional env vars:
#   CN_HOST               - CN host (default: rdfo1495558.bohrium.tech)
#   CN_USER               - CN ssh user (default: root)
#   WORKERS               - Space-separated worker dirs to deploy (default: all with wrangler.toml)
#   SKIP_BUILD            - Set to 1 to skip npm build (use existing .frontend-build)
#
# Example:
#   CLOUDFLARE_API_TOKEN=xxx CN_SSH_PASSWORD=yyy ./scripts/deploy-unified.sh --target all

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARGET=""
CN_HOST="${CN_HOST:-rdfo1495558.bohrium.tech}"
CN_USER="${CN_USER:-root}"
PAGES_PROJECT="${PAGES_PROJECT:-ai-dca}"

usage() {
  echo "Usage: $0 --target <pages|cn|workers|all>"
  echo ""
  echo "Env vars:"
  echo "  CLOUDFLARE_API_TOKEN  Required for pages/workers"
  echo "  CN_SSH_PASSWORD       Required for cn target"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$TARGET" ]] && usage

need() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: env var $var is required for target '$TARGET'" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------- pages ---
deploy_pages() {
  need CLOUDFLARE_API_TOKEN
  echo "=== [pages] building main branch ==="
  git checkout -q main

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    npm ci
    npm run build:app
  fi

  # SPA fallback + nojekyll (mirrors deploy-global-frontend-pages.yml)
  cp .frontend-build/index.html .frontend-build/404.html
  touch .frontend-build/.nojekyll

  echo "=== [pages] deploying to Cloudflare Pages ($PAGES_PROJECT) ==="
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    npx wrangler pages deploy .frontend-build --project-name="$PAGES_PROJECT"
  echo "=== [pages] done: https://$PAGES_PROJECT.pages.dev ==="
}

# -------------------------------------------------------------------- cn ---
deploy_cn() {
  need CN_SSH_PASSWORD
  echo "=== [cn] building cn branch ==="
  git checkout -q cn

  npm run check:refactor

  if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    VITE_API_ORIGIN='' npm run build:app
  fi

  # Guard: no hardcoded API origins in bundle
  if grep -R --include='*.js' -E "https://(cn\.freebacktrack\.tech:5000|api\.freebacktrack\.tech)/api/" .frontend-build; then
    echo "ERROR: bundle contains hardcoded API URLs" >&2
    exit 1
  fi

  tar -C .frontend-build -czf /tmp/ai-dca-frontend.tgz .

  echo "=== [cn] uploading to $CN_HOST ==="
  SSHPASS="$CN_SSH_PASSWORD" sshpass -e scp -o StrictHostKeyChecking=no \
    /tmp/ai-dca-frontend.tgz "$CN_USER@$CN_HOST:/tmp/ai-dca-frontend.tgz"

  echo "=== [cn] deploying on host ==="
  SSHPASS="$CN_SSH_PASSWORD" sshpass -e ssh -o StrictHostKeyChecking=no \
    "$CN_USER@$CN_HOST" \
    "CN_TARGET_DIR='/var/www/ai-dca-cn' CN_RELEASES_DIR='/var/www/ai-dca-cn-releases' bash -s" <<'REMOTE'
set -euo pipefail
stamp=$(date +%Y%m%d%H%M%S)
release="$CN_RELEASES_DIR/$stamp"
install -d -m 755 "$CN_RELEASES_DIR" "$release"
tar -xzf /tmp/ai-dca-frontend.tgz -C "$release"
id www-data >/dev/null 2>&1 && chown -R www-data:www-data "$release" || true
if [ -d "$CN_TARGET_DIR" ] && [ ! -L "$CN_TARGET_DIR" ]; then
  mv "$CN_TARGET_DIR" "$CN_TARGET_DIR.backup.$stamp"
fi
ln -sfn "$release" "$CN_TARGET_DIR"
ls -dt "$CN_RELEASES_DIR"/* 2>/dev/null | tail -n +6 | xargs -r rm -rf
nginx -s reload
echo "deployed $release"
REMOTE
  echo "=== [cn] done: https://cn.freebacktrack.tech:5000 ==="
}

# ---------------------------------------------------------------- workers ---
deploy_workers() {
  need CLOUDFLARE_API_TOKEN
  local workers="${WORKERS:-}"
  if [[ -z "$workers" ]]; then
    # auto-discover dirs with wrangler.toml, excluding container-based markets-agent
    workers=$(find workers -maxdepth 2 -name "wrangler.toml" -not -path "*markets-agent*" | xargs -n1 dirname)
  fi

  export CLOUDFLARE_API_TOKEN
  for w in $workers; do
    echo "=== [worker] deploying $w ==="
    ( cd "$w" && npx wrangler deploy )
  done
  echo "=== [workers] done ==="
}

case "$TARGET" in
  pages)   deploy_pages ;;
  cn)      deploy_cn ;;
  workers) deploy_workers ;;
  all)
    deploy_pages
    deploy_cn
    deploy_workers
    ;;
  *) echo "Unknown target: $TARGET"; usage ;;
esac

echo "All requested deployments completed."
