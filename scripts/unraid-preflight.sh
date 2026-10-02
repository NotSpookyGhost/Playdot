#!/usr/bin/env bash
set -euo pipefail
for tool in docker curl ss awk stat install realpath; do command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }; done
docker version
docker compose version
engine=$(docker version --format '{{.Server.Version}}')
if (( ${engine%%.*} < 28 )); then echo 'STOP: Docker Engine 28+ required for the documented localhost publishing isolation. No host settings were changed.' >&2; exit 1; fi
compose=$(docker compose version --short | sed 's/^v//')
IFS=. read -r major minor rest <<< "$compose"
if (( major < 2 || (major == 2 && minor < 24) )); then echo 'STOP: Docker Compose 2.24+ required.' >&2; exit 1; fi
port=${PLAYDOT_PORT:-41873}
[[ "$port" =~ ^[0-9]+$ ]] && (( port > 1023 && port < 65536 )) || { echo 'Invalid PLAYDOT_PORT' >&2; exit 1; }
listeners=$(ss -H -ltn "sport = :$port")
if [[ -n "$listeners" ]]; then printf 'STOP: TCP port %s is occupied:\n%s\n' "$port" "$listeners" >&2; exit 1; fi
# Docker can publish through NAT without a userspace listening socket.
published=$(docker ps --format '{{.Names}} {{.Ports}}' | awk -v p=":$port->" 'index($0,p)')
if [[ -n "$published" ]]; then printf 'STOP: Docker already publishes this port:\n%s\n' "$published" >&2; exit 1; fi
printf 'PASS: no current TCP listener or Docker publication on %s. Startup is the final bind check.\n' "$port"
df -h "${PLAYDOT_DATA_ROOT:-/mnt/user/appdata/playdot}" 2>/dev/null || df -h /mnt/user/appdata
