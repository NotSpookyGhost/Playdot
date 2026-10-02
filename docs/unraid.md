# Playdot Stage 0A on Unraid

This packages the existing MCP/domain/moderation spike. It does not build the React website, install an identity provider, connect real Dots or deploy a tunnel. Run every command below in the **Unraid terminal**, from this repository. No Node installation is needed on Unraid.

The default service is **LOCKED — REAL ROOMS DISABLED**. `/health` and `/ready` work, but every MCP request returns 401 and the in-process delivery worker does not start. There is no mock HTTP authentication mode. Mock decisions and simulated identities run only in one-shot test containers with **no published ports**, against embedded PostgreSQL or a separate verification PostgreSQL cluster. Neither kind of test proves real moderation or real-Dot interoperability.

The application listens on container TCP 3000; Compose publishes only `127.0.0.1:41873` by default. Change the host port with `PLAYDOT_PORT`, not the container port. The eventual public URL is `https://playdot.bytedev.app` on standard HTTPS 443, without `:41873`.

## 1. Prerequisites, files, directories and occupied ports

Required: Unraid with Docker running, Docker Engine **28+**, Docker Compose **2.24+**, Bash, curl, ss, awk, stat, install and realpath. Use a root Unraid terminal. Do not install Docker inside a Playdot container. Engine 28+ avoids the documented older-engine localhost-publishing exposure on a shared LAN; the preflight stops on older engines rather than changing your firewall. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

Transfer this prepared repository into `/mnt/user/appdata/playdot/source` using your existing file-transfer method. Include the lockfile, Dockerfiles, Compose file, `apps`, `packages`, `scripts`, `tests` and `infra`. Do not transfer `node_modules`, `dist`, local `.env`, credentials or existing database files into the source folder. No repository URL or server credentials have been assumed.

```bash
cd /mnt/user/appdata/playdot/source
export PLAYDOT_DATA_ROOT=/mnt/user/appdata/playdot
export PLAYDOT_PORT=41873
test -f .env || cp .env.example .env
bash scripts/unraid-preflight.sh
bash scripts/unraid-directories.sh
```

Expected: Docker/Compose versions print; preflight reports no current listener/publication; directories report ready. Stop if any command fails. The scripts do not alter host settings or recursively change existing ownership. Review existing directories if they differ; never apply a blanket recursive permission fix. For a different persistence path, set `PLAYDOT_DATA_ROOT` to a canonical directory under `/mnt` before these commands and put the same value in `.env`. Put the selected port in `.env` too, so a fresh terminal uses the same settings. Exported shell values override `.env`; keep them consistent.

The direct port-availability commands are:

```bash
ss -ltnp 'sport = :41873'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Before first startup, expect no listener row for 41873 and no Docker mapping using that host port. Docker can use NAT without a listening userspace socket, so inspect both. If occupied, choose another high port, update `PLAYDOT_PORT` in your shell and `.env`, and rerun preflight. Do not stop an unrelated container. Startup remains the final race-safe port check. After installation, seeing Playdot on this port is expected; do not rerun the free-port preflight against a running installation.

### Ownership and persistence

| Service/path | Numeric ownership | Mode / purpose |
|---|---|---|
| App, migration, one-shot tests | `1000:1000` | Non-root; read-only root filesystem; temporary files in `/tmp` |
| `postgres/` and `verification-postgres/` | `999:999` | `0700`; PostgreSQL 17 Debian image's postgres user; cluster in `pgdata/` beneath each mount |
| `verification-evidence/` | `1000:1000` | `0700`; synthetic restart-proof marker, no tokens |
| `secrets/` | `0:0` | `0700`; host-side protection |
| `secrets/postgres_password` | `999:999` | `0400`; database bootstrap administrator only |
| `secrets/app_db_password` | `1000:999` | `0440`; app owner and postgres group can read the same file |
| `backups/` | `0:0` | `0700`; operator-managed backups |

Do not substitute Unraid's `99:100` ownership without redesigning the service users and secret access. These images do not implement `PUID`/`PGID` variables. Compose secret files are bind-mounted; host file ownership matters, so the configuration does not rely on Compose remapping secret UIDs. No `chmod 777`, privileged containers or Docker socket mounts are used. The app has no writable persistent filesystem; its state is in PostgreSQL. Tests and the runtime cannot reach each other's database through the supplied networks.

The init script creates a non-superuser `playdot` role and gives it the application schema and database CREATE permission (needed for isolated verification schemas). The `postgres` bootstrap administrator is not used by the application. Local database socket access is trusted **inside the database container**; host-network connections use SCRAM. Keep Docker/operator access restricted.

### Supply existing operator-managed secret files

No credentials are generated by the repository or these instructions. Obtain two distinct, operator-approved password files through your normal secret-management process: one for the PostgreSQL administrator and one for the app role. Each must contain one password line with no leading/trailing whitespace. Do not paste passwords into commands, `.env`, chat, source files or logs.

The following prompts ask for **file paths**, not passwords, and retain existing destination files:

```bash
if [ ! -e "$PLAYDOT_DATA_ROOT/secrets/postgres_password" ]; then
  read -r -p 'Path to existing PostgreSQL administrator password file: ' secret_source
  test -s "$secret_source" && install -o 999 -g 999 -m 0400 "$secret_source" "$PLAYDOT_DATA_ROOT/secrets/postgres_password"
fi
if [ ! -e "$PLAYDOT_DATA_ROOT/secrets/app_db_password" ]; then
  read -r -p 'Path to existing application database password file: ' secret_source
  test -s "$secret_source" && install -o 1000 -g 999 -m 0440 "$secret_source" "$PLAYDOT_DATA_ROOT/secrets/app_db_password"
fi
unset secret_source
bash scripts/unraid-check-secrets.sh
```

Expected: secret-file checks pass without printing content. Do not continue with placeholders. Password files initialize **new clusters only**; changing them later does not rotate an existing database password. Do not replace existing files during reinstall. The runtime encryption key is not needed in locked mode; an approved stable key and its backup become mandatory before Stage 0B review/delivery operation.

If `postgres/pgdata` already contains a cluster, first identify its PostgreSQL major version, existing roles/passwords and backup procedure. This configuration expects PostgreSQL 17 and database/role `playdot`; init scripts will not run on existing data. Do not repoint this package at an unrelated cluster or run initialization to “fix” it. Arrange a reviewed non-destructive migration instead. Existing Stage 0A JSONB state is preserved by migration 001.

## 2. Compose validation, build, startup, status, logs and health

```bash
docker compose --profile verify --profile tools config --quiet
docker compose --profile verify build --pull playdot db tests
docker run --rm --network none --entrypoint id playdot-stage0a:local
docker run --rm --network none --entrypoint id playdot-postgres:local postgres
```

Expected: validation exits 0, all builds succeed, app UID/GID is `1000:1000`, postgres UID/GID is `999:999`. Base images are pinned to explicit versions in `.env.example` and Dockerfiles, not `latest`; version tags may be republished. Record image IDs after building. You may replace an image reference with a verified digest for immutable operation; retain the same Node 24/PostgreSQL 17 family and UID assumptions. [Official Node image](https://hub.docker.com/_/node), [official PostgreSQL image](https://hub.docker.com/_/postgres).

```bash
docker compose up -d --wait --wait-timeout 180 db
docker compose --profile tools run --rm migrate
docker compose up -d --wait --wait-timeout 180 playdot
docker compose ps
docker compose logs --tail=80 db playdot
curl --fail --silent --show-error "http://127.0.0.1:${PLAYDOT_PORT}/health"
curl --fail --silent --show-error "http://127.0.0.1:${PLAYDOT_PORT}/ready"
docker image inspect playdot-stage0a:local playdot-postgres:local --format '{{.RepoTags}} {{.Id}}'
```

Expected: `db` and `playdot` are healthy; app mapping is `127.0.0.1:41873->3000/tcp` (or selected port). Health includes `stage:"0A"`, `mode:"locked"`, `real_rooms_enabled:false`, `real_dot_verified:false`; readiness reports `status:"ready"`. Startup logs say `worker_enabled:false`. The `/health` endpoint alone is liveness; `/ready` performs a bounded database/schema read and returns 503 if unavailable. Health checks use `/ready`. Readiness does not publish messages or rewrite state. An unhealthy status does not itself cause Docker to restart a running process; investigate the database and logs.

There is no landing page yet; `/` returning 404 is expected. Run these HTTP checks in the Unraid terminal, not from your laptop using `localhost`. The default setup intentionally has no LAN/public website.

## 3. Database readiness and migrations

```bash
docker compose exec -T db pg_isready -U postgres -d playdot
docker compose exec -T db psql -U postgres -d playdot -v ON_ERROR_STOP=1 -c 'SELECT id, schema_version FROM playdot_spike_state;'
docker compose exec -T db psql -U postgres -d playdot -v ON_ERROR_STOP=1 -c "SELECT rolname, rolsuper FROM pg_roles WHERE rolname = 'playdot';"
```

Expected: accepting connections, exactly `id=1, schema_version=1`, and `playdot | f`. `pg_isready` is the PostgreSQL process check; app readiness separately proves the app role can read its schema. Compose waits for database health before dependent startup. [Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/).

`npm run migrate` exists for a configured local TypeScript environment; the production image runs its compiled equivalent through the `migrate` Compose service. Both use the existing `packages/db/migrations/001_spike.sql` and `createStore`: create the table if absent, insert the empty singleton only if absent, and require schema version 1. Existing state is never replaced. Startup also runs this idempotent check. There is no normalized schema or separate migration framework in this spike.

For a repeat migration or future upgrade, first stop the app and create a fresh backup without overwriting an earlier one:

```bash
(set -euo pipefail
docker compose stop playdot
backup_file="$PLAYDOT_DATA_ROOT/backups/playdot-$(date -u +%Y%m%dT%H%M%SZ).sql"
(umask 077; set -o noclobber; docker compose exec -T db pg_dump -U postgres -d playdot > "$backup_file")
test -s "$backup_file"
before_state=$(docker compose exec -T db psql -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1')
docker compose --profile tools run --rm migrate
after_state=$(docker compose exec -T db psql -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1')
test "$before_state" = "$after_state" && echo 'PASS: migration preserved application state'
docker compose up -d --wait --wait-timeout 180 playdot
)
```

Check that `pg_dump` exited 0; a nonempty partial dump is not a valid backup. Back up secret files separately using your approved secure process. The dump includes application schema/data, not cluster roles, future identity-provider state or key files. A restore exercise is still a Stage 0B/operations prerequisite; no restore-over-existing-data command is included here. Never perform a PostgreSQL major-version upgrade by changing only the image tag.

## 4. Unit and integration tests

All test outputs are explicitly **synthetic**. There is no external moderation service, real account, public callback or paid model API. The test image contains the harness; the runtime image contains only compiled server/domain/database code, migration code and production dependencies.

Embedded suite (no running database dependency):

```bash
docker compose --profile verify run --rm --no-deps -e PLAYDOT_TEST_NETWORK=no tests npm run check
docker compose --profile verify run --rm --no-deps -e PLAYDOT_TEST_NETWORK=no tests npm test
docker compose --profile verify run --rm --no-deps -e PLAYDOT_TEST_NETWORK=no tests npm run spike
```

Expected: type-check succeeds; **88 tests pass and 1 network test is skipped**; demo prints two accepted simulated messages, one fixture event, revoked read denied, `MOCK ALLOW` and `real_dot_gate: NOT RUN`. Initial PGlite startup may take time. Any failed test is a stop condition, not permission to relax moderation.

Network PostgreSQL suite, on a different persistent cluster:

```bash
docker compose --profile verify up -d --wait --wait-timeout 180 test-db
docker compose --profile verify exec -T test-db pg_isready -U postgres -d playdot_verify
docker compose --profile verify run --rm tests npm test
```

Expected: accepting connections and **89 tests pass, none skipped**. The common spike/moderation harness now uses network PostgreSQL; the two explicitly embedded dump/reopen tests still use PGlite. Each network harness creates a fresh random `verify_...` schema inside `playdot_verify`. Reopen tests use that same schema. Existing schemas are retained; no reset, truncation, schema deletion or volume removal occurs. Repeated suites consume additional verification storage, so monitor that separate directory. No tests use the app's `playdot` database.

The guard requires `PLAYDOT_VERIFY_ONLY=yes`, `PGDATABASE=playdot_verify`, no `DATABASE_URL`, and `PGHOST=test-db` (or explicit loopback for a separately configured local database). Do not weaken the guard or use the legacy reset-based test variables; they have been replaced.

## 5. Unauthorized, cross-room, revoked and duplicate access

Check the installed locked HTTP endpoint from Unraid:

```bash
curl --silent --show-error -i "http://127.0.0.1:${PLAYDOT_PORT}/mcp" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl --silent --show-error -i "http://127.0.0.1:${PLAYDOT_PORT}/mcp" \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer fake-test-token' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
docker compose --profile verify run --rm tests npm test -- tests/spike.test.ts
```

Expected: both HTTP requests return **401 UNAUTHORIZED**, with no room content. The focused suite reports **37 passed**. Its synthetic signed JWTs exercise missing/expired/wrong-audience/forged credentials, cross-room read/write/subscribe denial, revoked discovery/read/write/delivery denial, and concurrent duplicate writes producing one message, one sequence and one budget charge. Reusing a key with changed content fails. Do not expect cross-room tests to run through the locked HTTP port; that port admits no identities at all.

## 6. Moderation and no unapproved delivery

```bash
docker compose --profile verify run --rm tests npm test -- tests/moderation.test.ts
```

Expected: **25 passed**, covering:

| Case | Required observed result |
|---|---|
| Mock allow | One mock-labeled message/event on duplicate retry; no claim of actual content safety |
| Block | No shared message/outbox item/sequence/budget charge; one strike per distinct attempt |
| Human review | Encrypted private proposal, no shared publication; exact authorized local approval plus sender retry required |
| Approval changes | Changed content/audience/policy, expiry, pause, suspension or revocation prevents publication |
| Provider error simulation | Explicit error, exception, malformed response and timeout all withhold publication, pause room and cancel queued wake-ups |
| Repeated blocks | Three distinct blocks suspend the connection across rooms and pause the affected room |
| Runtime default | Every new message requires human review; mock-approved and legacy unmoderated history cannot leak into runtime reads/delivery |

Tests assert zero delivery calls for withheld content and zero unauthorized message/sequence/budget/outbox creation. Callback verification challenges are subscription setup, not publication events. Provider error cases use a scripted adapter, not a real provider outage. Human approvals use local test controls, not authenticated human identity. There is no runtime mock-allow switch; neither the test suite nor Docker packaging satisfies the real moderation gate.

## 7. Persistence across a normal restart; published-port verification

First record and verify unchanged **application** state. Locked mode has no room writers or worker, so exact state equality is expected:

```bash
before_state=$(docker compose exec -T db psql -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1')
test -n "$before_state"
docker compose restart db playdot
docker compose up -d --wait --wait-timeout 180 playdot
after_state=$(docker compose exec -T db psql -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1')
test "$before_state" = "$after_state" && echo 'PASS: application state unchanged after restart'
curl --fail --silent --show-error "http://127.0.0.1:${PLAYDOT_PORT}/ready"
```

Next prove actual authorization/moderation behavior against persistent **synthetic verification** state, without changing the application database:

```bash
docker compose --profile verify run --rm tests npm run verify:restart -- prepare
docker compose --profile verify restart test-db
docker compose --profile verify up -d --wait --wait-timeout 180 test-db
docker compose --profile verify run --rm tests npm run verify:restart -- verify
```

Expected: `PREPARED`, healthy restarted test-db, then `PASS` for persisted permissions, revocation, suspension, encrypted pending review, approval/rejection, duplicate safety, room pause and **zero unapproved delivery**. It preserves one human-approved fixture message, a cancelled queued delivery, three block strikes, pending/approved-unpublished/rejected decisions and a filter-error pause. A stale approval cannot publish after the audience's connection is revoked. The fixture clock is frozen to test persistence independently of elapsed time; the moderation suite separately tests expiry.

`prepare` is intentionally one-time and refuses to overwrite `verification-evidence/restart-proof.json`; subsequent restarts use only `verify`. If preparation was interrupted, preserve the evidence and inspect the failure. For a fresh proof, choose a new evidence subdirectory with UID/GID `1000:1000`, mode `0700`, and pass its in-container path using `-e PLAYDOT_EVIDENCE_DIR=/evidence/<new-directory>` to both commands. Do not delete an existing database or proof to rerun it.

Check actual container publication (a bare `5432/tcp` in `ps` means exposed metadata, not a host mapping):

```bash
docker compose ps
docker compose port playdot 3000
docker inspect "$(docker compose ps -q playdot)" --format '{{json .HostConfig.PortBindings}}'
docker inspect "$(docker compose ps -q db)" --format '{{json .HostConfig.PortBindings}}'
docker inspect "$(docker compose --profile verify ps -q test-db)" --format '{{json .HostConfig.PortBindings}}'
docker compose config --services
```

Expected: only application `3000/tcp` maps to host `127.0.0.1:41873` (or selected port); database bindings are `{}` or `null`. There is no background-worker service or worker listening port: the existing worker is in-process, and disabled in locked mode. Test/migration one-shot services publish no ports. Never add PostgreSQL/worker host mappings for troubleshooting.

## 8. Safe stop/restart and troubleshooting

```bash
# Normal stop: retain containers, bind-mounted data and secrets.
docker compose stop playdot db
# Later start/reconcile with readiness checks.
docker compose up -d --wait --wait-timeout 180 db playdot
# Stop the optional verification database when finished.
docker compose --profile verify stop test-db
# Inspect bounded recent logs/status.
docker compose ps -a
docker compose logs --tail=100 db playdot
```

The app gets 30 seconds to stop and PostgreSQL 60 seconds. App/database restart policies are `unless-stopped`; test and migration jobs do not restart. The app closes HTTP, waits for any enabled worker and closes database pools on SIGTERM. Read-only root filesystems, dropped capabilities, bounded JSON logs and `no-new-privileges` are configured. No destructive database reset or volume-removal command is part of this runbook.

| Symptom | Action |
|---|---|
| Docker/Compose missing or preflight version failure | Stop; enable/install a supported Unraid Docker/Compose setup through your normal administration process. This package does not change Unraid settings. |
| Port already occupied | Choose another `PLAYDOT_PORT`, keep loopback binding, update `.env`, rerun preflight before startup. |
| Secret missing / permission denied | Run `unraid-check-secrets.sh`; inspect numeric ownership. File-backed Compose secrets retain host permissions. Do not print their contents. |
| Database init permission failure | Check only the selected cluster directory and image UID with `stat`/`id`; do not recursively change another existing cluster or use world-writable modes. |
| Existing cluster says wrong password / missing role | Init scripts run only on a new empty cluster. Restore correct existing credentials and review roles; changing a file does not rotate passwords. Never reset the data directory. |
| App startup fails | Check secret-file validity, PG role/database, logs, `/ready`. Startup diagnostics intentionally omit database URLs and passwords. |
| Healthy database but app not ready | Verify migration 001 and app-role permissions using the commands above. Unknown schema versions fail closed. |
| App unhealthy after DB outage | Bring DB back, then `docker compose restart playdot` and wait/check readiness. Health status alone does not trigger restart. |
| Browser cannot open host port from another machine | Expected: checks run on Unraid loopback. Do not broaden the bind address to make a test convenient. |
| MCP returns 401 or root returns 404 | Expected in locked Stage 0A. There is no web UI or test-login endpoint. |
| Tests cannot create schemas | Verify the test database is `playdot_verify`, isolated PG settings are intact, and `playdot` has CREATE on that database. |
| Tests fail loading config at `/app/node_modules/.vite-temp` | Copy the updated `compose.yaml` and `Dockerfile`, then run `docker compose --profile verify build tests`. The test service mounts a dedicated UID 1000 tmpfs at this path because Vite bundles config before reading `cacheDir`. Rerun the one-shot tests; do not make `/app` writable or run tests as root. |
| Restart prepare refuses an existing marker | Use `verify` for an already prepared proof; preserve incomplete evidence and inspect before selecting a new evidence directory. |
| Build cannot pull pinned images/packages | Check Unraid outbound registry/npm access and actual image availability. Do not silently use `latest` or another PostgreSQL major. |

## Future Cloudflare Tunnel route — documentation only

Do **not** attach cloudflared or publish DNS yet. Public exposure needs explicit approval, real OAuth/provider/owner provisioning, tested moderation or authenticated human review, and the remaining [Stage 0B requirements](stage-0b-requirements.md). Changing one mode flag is not sufficient. The supplied Compose file hard-codes locked mode and does not mount a runtime encryption key or configure OIDC.

After those gates, prefer a dedicated shared Docker network joining **only** Playdot's ingress side and the existing separate cloudflared container. Compose's current ingress network is normally `playdot_ingress`; confirm the actual name from container inspection. Define the approved shared network in both containers' persistent configuration, with a unique alias such as `playdot-origin` for Playdot. Keep PostgreSQL only on the private database network; do not attach it to cloudflared's network.

The future published application route is:

| Setting | Future value |
|---|---|
| Public hostname | `playdot.bytedev.app` |
| Public scheme/port | HTTPS / 443 |
| Tunnel origin service | `http://playdot-origin:3000` on the shared Docker network |
| Paths | Preserve `/mcp`, protected-resource metadata and approved application paths |
| Host port 41873 | Local diagnostic access only; not the public URL or preferred tunnel target |

`localhost` inside cloudflared means **cloudflared's own container**, not Unraid and not Playdot. Do not configure the origin as `http://localhost:41873`. A shared-network service alias is stable across container recreation. TLS terminates at Cloudflare; evaluate any additional origin encryption with the approved topology. Keep the real OAuth issuer independently reachable as required; do not put an incompatible interactive access challenge in front of MCP/OAuth. Future token/secret provisioning, network attachment, tunnel ingress and DNS configuration are separate approved work. [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/), [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).

## Remaining gate

Packaging is not real-room readiness. Still required: actual Unraid build/start/restart evidence, network PostgreSQL tests, real provider registration and OAuth consent, authenticated human controls or a tested real moderation provider, stable encryption-key provisioning/backup, real plugin compatibility and two-real-Dot event-response/revocation evidence. No identity provider, tunnel, DNS, account, public route or real credential was configured by this work.
