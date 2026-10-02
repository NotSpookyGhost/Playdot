#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run from the Unraid root terminal.' >&2; exit 1; }
root=${PLAYDOT_DATA_ROOT:-/mnt/user/appdata/playdot}
[[ "$root" == /mnt/* && "$root" != *..* && "$root" != *$'\n'* && "$root" != /mnt/ ]] || { echo 'Use a specific absolute appdata directory under /mnt.' >&2; exit 1; }
[[ "$(realpath -m "$root")" == "$root" ]] || { echo 'Use a canonical path without symlinks or trailing slash.' >&2; exit 1; }
ensure_dir() {
  local path=$1 owner=$2 mode=$3
  [[ ! -L "$path" ]] || { echo "Refuse symlink: $path" >&2; exit 1; }
  if [[ ! -e "$path" ]]; then
    install -d -o "${owner%:*}" -g "${owner#*:}" -m "$mode" "$path"
  else
    [[ -d "$path" ]] || { echo "Not a directory: $path" >&2; exit 1; }
    [[ "$(stat -c '%u:%g %a' "$path")" == "$owner $mode" ]] || { echo "STOP: existing directory permissions differ: $path (expected $owner $mode). Inspect existing data; nothing changed here." >&2; exit 1; }
  fi
}
ensure_dir "$root" 0:0 755
ensure_dir "$root/postgres" 999:999 700
ensure_dir "$root/verification-postgres" 999:999 700
ensure_dir "$root/verification-evidence" 1000:1000 700
ensure_dir "$root/secrets" 0:0 700
ensure_dir "$root/backups" 0:0 700
echo 'PASS: appdata directories ready. Existing contents were not changed.'
