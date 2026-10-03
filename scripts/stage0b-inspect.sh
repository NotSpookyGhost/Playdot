#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
printf '%s\n' 'Read-only inspection. No tunnel, port or security changes.'
docker compose version
docker compose ps
printf '%s\n' 'Actual application TCP binding:'
docker compose port playdot 3000
for service in db playdot; do
  container="$(docker compose ps -q "$service")"
  if [ -n "$container" ]; then
    docker inspect --format '{{.Name}} ports={{json .HostConfig.PortBindings}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$container"
  fi
done
printf '%s\n' 'Container names/images only (does not show tunnel tokens or configuration):'
docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'
printf '%s\n' 'A cloudflared container name does not establish that any route exists.'
