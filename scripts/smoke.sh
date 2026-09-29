#!/usr/bin/env bash
# Load the package in a real Pi process and fail on any extension load error.
# `pi --help` swallows load errors; RPC mode reports them and lists commands.
set -uo pipefail
out=$(mktemp); err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT
printf '{"type":"get_commands"}\n' | PI_OFFLINE=1 timeout 60 pi -ne -e . --mode rpc --no-session >"$out" 2>"$err"
status=$?
if grep -h "Failed to load\|cannot load\|Error loading" "$out" "$err"; then exit 1; fi
if ! grep -q '"compact-at"' "$out"; then
  echo "smoke: Muster's /compact-at command is missing; the extension did not load" >&2
  head -c 2000 "$out" "$err" >&2
  exit 1
fi
echo "smoke: pi loaded pi-muster (rpc exit $status)"
