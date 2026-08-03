#!/usr/bin/env bash
set -euo pipefail

auth_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-mcp-conformance.XXXXXX")"
trap 'rm -rf "$auth_dir"' EXIT
export PI_MCP_CONFORMANCE_AUTH_FILE="$auth_dir/auth.json"
exec node --import tsx conformance/driver.ts "$@"
