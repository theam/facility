#!/usr/bin/env bash
# N-run eval matrix over the given scenarios (default: all six), sequential.
# Usage: [MODEL=sonnet] [N=5] bash matrix.sh [scenario ...]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N="${N:-5}"
export MODEL="${MODEL:-sonnet}"
SCENS=("$@")
[ ${#SCENS[@]} -gt 0 ] || SCENS=(f2-control f1-flow r2-control r1-review m2-control m1-fix)
echo "matrix start: model=$MODEL N=$N scenarios=${SCENS[*]} $(date -u +%H:%M:%SZ)"
for i in $(seq 1 "$N"); do
  for scen in "${SCENS[@]}"; do
    RUN_ID="r$i" bash "$ROOT/run/run.sh" "$scen"
  done
done
echo "matrix done $(date -u +%H:%M:%SZ)"
