#!/usr/bin/env bash
set -euo pipefail

results_dir="${CONFORMANCE_RESULTS_DIR:-conformance/results}"
timeout_ms="${CONFORMANCE_TIMEOUT_MS:-90000}"
args=(client --command "bash conformance/driver.sh" --timeout "$timeout_ms" -o "$results_dir")

if [[ "${1:-}" == "--scenario" ]]; then
  [[ -n "${2:-}" ]] || { echo "--scenario requires a name" >&2; exit 2; }
  args+=(--scenario "$2")
  shift 2
else
  args+=(--suite all --expected-failures conformance/baseline-client.yml)
fi

if [[ "${1:-}" == "--verbose" ]]; then
  args+=(--verbose)
fi

exec npx conformance "${args[@]}"
