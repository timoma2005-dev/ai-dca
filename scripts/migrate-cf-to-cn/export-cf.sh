#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$script_dir/export-local.mjs" "${1:-cf-export-$(date -u +%Y%m%d)}"
