#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-/tmp/landgod-business-report-demo}"
python3 "$ROOT/mcp-servers/business-report-demo/server.py" --smoke --output-dir "$OUT_DIR"
echo
echo "Artifacts: $OUT_DIR"
find "$OUT_DIR" -maxdepth 1 -type f -printf ' - %f\n' | sort
