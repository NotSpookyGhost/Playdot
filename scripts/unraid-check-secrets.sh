#!/usr/bin/env bash
set -euo pipefail
root=${PLAYDOT_DATA_ROOT:-/mnt/user/appdata/playdot}
check() {
  local file=$1 expected=$2
  [[ -f "$file" && ! -L "$file" && -s "$file" ]] || { echo "Missing/empty secret file: $file" >&2; exit 1; }
  [[ "$(stat -c '%u:%g %a' "$file")" == "$expected" ]] || { echo "Incorrect owner/mode for $file; expected $expected" >&2; exit 1; }
  if grep -qE 'REPLACE_|<|>' "$file"; then echo "Placeholder still present in $file" >&2; exit 1; fi
}
check "$root/secrets/postgres_password" '999:999 400'
check "$root/secrets/app_db_password" '1000:999 440'
echo 'PASS: required secret files exist with expected ownership/modes; contents were not printed.'
