# OAuth-ready startup fix: operator-run Unraid procedure

Work performed locally only. Deployment facts supplied by the owner: application healthy at `127.0.0.1:41873` and publicly reachable; it reports locked Stage 0A and advertises `locked.playdot.invalid`. Working Keycloak issuer: `https://playdot-auth.bytedev.app/realms/playdot`. Resource: `https://playdot.bytedev.app/mcp`. Auth origin host port: 41874. These endpoints were not probed by the agent.

## Cause and corrected behavior

The base `compose.yaml` deliberately fixes `PLAYDOT_MODE=locked` and real rooms off. Changing `.env` alone cannot override those literal values, and restarting a container does not apply changed Compose environment. The previous real-room overlay coupled OIDC to a fully initialized pilot, encryption key, callback allowlist and active worker.

Use the new **`compose.oauth-setup.yaml` after `compose.yaml`**, without the real-room overlay. It sets the correct issuer, JWKS and audience/resource; enables real JWT verification; explicitly disables real rooms and events; and permits metadata discovery only for valid tokens from `playdot-gary` or `playdot-friend` with `room:read`. Discovery never enrolls an owner or grants room access. Known revoked, suspended or mismatched stored bindings remain denied. All room reads/writes, subscriptions and outbound dispatch are disabled, including previously queued deliveries. Owner-control routes are absent in this mode.

Real conversations still require the separate owner-consented pilot. In real-room mode events additionally require BOTH `PLAYDOT_ENABLE_EVENTS=yes` and a nonempty verified exact-host allowlist. Empty allowlist means disabled even when the flag says yes. Wildcards/URLs/placeholders are rejected; the existing TLS, address and callback validation is unchanged. Paused/expired/revoked controls remain enforced when events are eventually enabled.

## 1. Copy the prepared source files (no downtime)

Local root: `C:\Users\Administrator\Documents\Playdot\Playdot`. Destination root: `/mnt/user/appdata/playdot/source`.

Copy these directories in full to their corresponding source paths so no previous Stage 0B dependency is omitted:

- `apps/server/src/`: `app.ts`, `auth.ts`, `callback.ts`, `config.ts`, `main.ts`, `owner.ts`, `runtime.ts`.
- `packages/domain/src/`: `model.ts`, `moderation.ts`, `pilot.ts`, `service.ts`, `issuer-migration.ts`.

Copy these individual files, preserving relative paths:

- `Dockerfile`, `tsconfig.build.json`, `package.json`, `package-lock.json`.
- `compose.oauth-setup.yaml`, `compose.stage0b.example.yaml`.
- `scripts/migrate-pilot-issuer.ts`, `scripts/verify-oauth-setup.mjs`, `scripts/check-provider.mjs`.
- `tests/oauth-setup.test.ts`, `tests/issuer-migration.test.ts`, `tests/packaging.test.ts`.
- `config/stage0b.env.example`, `config/stage0b.example.json`.
- `docs/oauth-setup-fix.md`, `docs/oauth-setup-results.md`.

The existing `compose.yaml`, database migration, contracts and build script must remain present. Do not replace server `.env`, secrets, database directories or operator configuration with examples. Keycloak is already working at the correct hostname; this fix does not require rebuilding/restarting Keycloak, changing its users/clients, or modifying DNS/tunnel routes.

## 2. Preserve the current image and configuration (no downtime)

Run every block in the same Unraid root terminal. Each subshell uses `set -e` so it stops on error; do not proceed to the next numbered stage after an error. Retain the backup directory path printed below for rollback. It contains private configuration and later a database dump; do not upload it to chat or GitHub.

```bash
cd /mnt/user/appdata/playdot/source
export PLAYDOT_DATA_ROOT=/mnt/user/appdata/playdot
export PLAYDOT_PORT=41873
export PLAYDOT_FIX_BACKUP="$PLAYDOT_DATA_ROOT/backups/oauth-setup-$(date -u +%Y%m%dT%H%M%SZ)"
(
  set -eu
  test ! -e "$PLAYDOT_FIX_BACKUP"
  install -d -o 0 -g 0 -m 0700 "$PLAYDOT_FIX_BACKUP"
  umask 077
  app_id=$(docker compose ps -q playdot)
  test -n "$app_id"
  prior_image=$(docker inspect --format '{{.Image}}' "$app_id")
  rollback_tag="playdot-oauth-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
  docker image tag "$prior_image" "$rollback_tag"
  printf 'services:\n  playdot:\n    image: %s\n' "$rollback_tag" > "$PLAYDOT_FIX_BACKUP/rollback.yaml"
  cp -p compose.yaml "$PLAYDOT_FIX_BACKUP/compose.yaml"
  test ! -f .env || cp -p .env "$PLAYDOT_FIX_BACKUP/source.env"
  test ! -f "$PLAYDOT_DATA_ROOT/config/stage0b.json" || cp -p "$PLAYDOT_DATA_ROOT/config/stage0b.json" "$PLAYDOT_FIX_BACKUP/stage0b.json"
  test ! -f "$PLAYDOT_DATA_ROOT/config/stage0b.env" || cp -p "$PLAYDOT_DATA_ROOT/config/stage0b.env" "$PLAYDOT_FIX_BACKUP/stage0b.env"
  printf 'Backup location: %s\n' "$PLAYDOT_FIX_BACKUP"
)
```

Expected: exit 0 and a new private backup location. No database/secret/Keycloak changes occur.

## 3. Validate and build locally on Unraid (no app downtime yet)

```bash
oauth() { docker compose -f compose.yaml -f compose.oauth-setup.yaml "$@"; }
(
  set -eu
  oauth config --quiet
  docker compose --profile verify build playdot tests
  docker compose --profile verify run --rm --no-deps -e PLAYDOT_TEST_NETWORK=no tests npm run check
  docker compose --profile verify run --rm --no-deps -e PLAYDOT_TEST_NETWORK=no tests npx vitest run tests/oauth-setup.test.ts tests/issuer-migration.test.ts tests/packaging.test.ts
)
```

Expected: valid Compose, successful image build/type-check, 12 focused tests passed. No fake allowlist, encryption key or owner subject is needed to start OAuth setup. If the build fails, the old running container remains intact. Do not add a guessed callback hostname to get past an error.

## 4. Back up the database, then apply OAuth setup (brief app downtime)

**Downtime starts at `stop playdot`.** PostgreSQL and Keycloak remain running. No reset/reseed is performed. Capture the aggregate digest before startup and compare it afterward. A failed/partial dump is not a usable backup; stop on any error.

```bash
(
  set -eu
  umask 077
  test -d "$PLAYDOT_FIX_BACKUP"
  docker compose stop playdot
  test ! -e "$PLAYDOT_FIX_BACKUP/playdot.sql"
  docker compose exec -T db pg_dump -U postgres -d playdot > "$PLAYDOT_FIX_BACKUP/playdot.sql"
  test -s "$PLAYDOT_FIX_BACKUP/playdot.sql"
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1' > "$PLAYDOT_FIX_BACKUP/state-before.txt"
  oauth up -d --no-deps --no-build --pull never --wait --wait-timeout 180 playdot
  oauth exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d playdot -Atc 'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1' > "$PLAYDOT_FIX_BACKUP/state-after.txt"
  cmp "$PLAYDOT_FIX_BACKUP/state-before.txt" "$PLAYDOT_FIX_BACKUP/state-after.txt"
  oauth ps
  oauth port playdot 3000
)
```

Expected: healthy app, digest comparison succeeds, binding still `127.0.0.1:41873`. The existing idempotent version-1 schema check runs, but this fix does not migrate or initialize pilot state. If startup fails, inspect `oauth logs --tail=80 playdot` and use the rollback section; do not delete database files or regenerate secrets.

## 5. Verify publicly BEFORE retrying ChatGPT

These commands are for the operator, not commands run by the agent. The packaged verifier checks public health, BOTH metadata routes and unauthenticated GET/POST challenges and exits nonzero on a mismatch:

```bash
(
  set -eu
  oauth exec -T playdot node scripts/verify-oauth-setup.mjs
  oauth exec -T playdot node scripts/check-provider.mjs
)
```

For visible endpoint responses directly from the Unraid terminal:

```bash
curl --fail --silent --show-error https://playdot.bytedev.app/health
curl --fail --silent --show-error https://playdot.bytedev.app/.well-known/oauth-protected-resource
curl --fail --silent --show-error https://playdot.bytedev.app/.well-known/oauth-protected-resource/mcp
curl --silent --show-error --include -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' https://playdot.bytedev.app/mcp
curl --silent --show-error --include https://playdot.bytedev.app/mcp
```

Expected health: `stage:"0B-oauth-setup"`, `mode:"oidc"`, `real_rooms_enabled:false`, `events_enabled:false`, `worker_enabled:false`, `real_dot_verified:false`.

Both metadata routes must show resource `https://playdot.bytedev.app/mcp` and sole authorization server `https://playdot-auth.bytedev.app/realms/playdot`. Unauthenticated MCP GET and POST must return **401** with:

```text
WWW-Authenticate: Bearer resource_metadata="https://playdot.bytedev.app/.well-known/oauth-protected-resource"
```

The header is case-insensitive. The last two curl commands intentionally do not use `--fail`, because 401 is expected. If any endpoint still reports locked mode/old issuer, stop: ensure the updated image and **both Compose files** were applied and the tunnel reaches this container. Do not retry OAuth until these checks pass.

## 6. Supply the exact ChatGPT callback, then retry OAuth

Confirmed client settings supplied by the owner: User-Defined OAuth Client, client ID **`playdot-gary`**, secret blank, token endpoint authentication method **`none`**, S256 PKCE. Preserve these. The exact ChatGPT-generated Callback URL remains the one required value for this owner's OAuth connection.

Put that exact URL in the **existing Keycloak realm `playdot` > client `playdot-gary` > Valid redirect URIs**, through your existing authorized administration workflow. Preserve other valid redirects and client settings. Remove only the placeholder redirect if present. Do not recreate the client or re-import/reset the realm. Do not use a wildcard. It is NOT `https://playdot.bytedev.app/owner/callback`; that separate URL belongs exclusively to `playdot-owner`.

Retain the supplied redirect in the operator `/mnt/user/appdata/playdot/config/keycloak-realm.json` template for recovery consistency, but editing that file alone does not update a realm that already exists. Do not copy the repository example over it.

The access token must carry issuer above, audience `https://playdot.bytedev.app/mcp`, `azp`/`client_id=playdot-gary`, the correct owner subject, unexpired `exp`, `iat`, and a scope string including `room:read` for discovery. Keep the existing resource-indicator/audience mapper and PKCE configuration; if the actual token doesn't meet these requirements, inspect it privately and fix the provider client configuration instead of weakening validation. No token or secret should be pasted into chat.

Refresh/retry the ChatGPT connection after the public checks pass. An unbound authenticated user may list the four tools, initialize, discover metadata and see an empty event list. This does not create a Playdot connection or confer room authority. Room tools return `REAL_ROOMS_DISABLED`; subscriptions return `EVENTS_DISABLED`. Real owner consent and event-driven exchanges remain later, separately approved steps. A known revoked connection still fails discovery.

## 7. Operator configuration and optional existing-pilot issuer migration

**Not needed to get public OAuth metadata working.** OAuth setup intentionally does not load `/mnt/user/appdata/playdot/config/stage0b.json`, the subscription key or owner-login configuration. Do not run `pilot init` merely to make discovery work.

For later real-room activation, edit only these operator values, preserving secrets and owner data:

- `config/stage0b.env`: set `PLAYDOT_ENABLE_EVENTS=no`, `CALLBACK_ALLOWED_HOSTS=` (empty); leave real-room approval disabled until separately approved. Preserve data root, ports and existing settings. An event hostname is NOT required now.
- `config/stage0b.json`: issuer must be `https://playdot-auth.bytedev.app/realms/playdot`. Retain actual owner IDs/subjects, connection IDs, labels and client IDs. Gary's existing MCP client must be `playdot-gary`; the friend's exact client/subject must be verified independently before real operation. Do not change a bound client ID to silence a hash error.
- `config/keycloak-realm.json`: retain actual registered clients/users and the supplied ChatGPT redirect; do not substitute the owner-login redirect.

If the pilot is absent (the owner previously reported `f`), changing its uninitialized JSON issuer needs no database migration. If a pilot already exists, a stored hash is checked strictly. The included migration supports **only the same-realm old auth hostname to new auth hostname**, with identical owner/client/config fields. It refuses unrelated changes or mismatched bindings, never reactivates revoked/suspended connections, and keeps histories, grants, moderation records and idempotency data. It updates the pilot hash and bound issuers, pauses both rooms, clears session consent, disables subscriptions, cancels queued delivery and holds delivery until humans explicitly reauthorize. Old approvals cannot bypass the changed session/context.

Before running it, privately verify this is the same Keycloak realm/users, not a different identity provider. Keep the application stopped for the entire apply/rollback interval. An issuer change is an authentication-boundary change and requires owners to log in again. No current credentials are printed or replaced.

Once actual owner fields are complete, and the operator JSON has the NEW issuer, inspect without applying:

```bash
(
  set -eu
  docker compose --profile tools run --rm --no-deps     -v "$PLAYDOT_DATA_ROOT/config/stage0b.json:/run/pilot.json:ro"     migrate node dist/scripts/migrate-pilot-issuer.js check /run/pilot.json
)
```

Expected: `NO_PILOT` (no migration needed), `ALREADY_CURRENT`, or `MIGRATED_PAUSED` (dry-run result only, migration needed). A refusal means STOP and review the config; do not reseed/reset.

Only when that check says `MIGRATED_PAUSED` and the operator chooses to migrate:

```bash
export PLAYDOT_ISSUER_BACKUP="$PLAYDOT_DATA_ROOT/backups/issuer-change-$(date -u +%Y%m%dT%H%M%SZ)"
(
  set -eu
  oauth stop playdot
  test ! -e "$PLAYDOT_ISSUER_BACKUP"
  install -d -o 1000 -g 1000 -m 0700 "$PLAYDOT_ISSUER_BACKUP"
  docker compose --profile tools run --rm --no-deps     -v "$PLAYDOT_DATA_ROOT/config/stage0b.json:/run/pilot.json:ro"     -v "$PLAYDOT_ISSUER_BACKUP:/backup"     migrate node dist/scripts/migrate-pilot-issuer.js apply /run/pilot.json /backup/state.json
)
```

Expected: `MIGRATED_PAUSED`. The command writes a private 0600 before-state backup **before** committing changes; an existing backup file is never overwritten. Preserve this file and the operator configuration backup securely. If any operation fails, stop and inspect; do not delete backups to retry. Starting OAuth-only mode afterward remains safe: no room access or delivery becomes enabled.

For rollback, BEFORE allowing subsequent state changes, restore the exact prior aggregate with the guarded command:

```bash
(
  set -eu
  oauth stop playdot
  docker compose --profile tools run --rm --no-deps     -v "$PLAYDOT_ISSUER_BACKUP:/backup:ro"     migrate node dist/scripts/migrate-pilot-issuer.js rollback /backup/state.json
)
```

Expected: `ROLLED_BACK`. Rollback refuses if database state has changed since migration; do not bypass this guard. Restore the corresponding old operator JSON from its private backup before ever running old real-room configuration. OAuth setup can remain selected while resolving configuration; it will not enable conversations. No cluster/volume reset or Keycloak rollback is needed.

## 8. Roll back the application image/configuration if startup fails

**Brief app downtime; no database restore is needed for the normal OAuth-only update.** The base configuration deliberately returns to locked mode, so public metadata will again be unsuitable for real OAuth. Use this only to recover the previously working service:

```bash
(
  set -eu
  docker compose -f compose.yaml -f "$PLAYDOT_FIX_BACKUP/rollback.yaml"     up -d --no-deps --no-build --pull never --wait --wait-timeout 180 playdot
)
```

Do not feed the SQL dump over a live database as a generic rollback. It is a protected recovery artifact; the optional issuer migration has its own guarded rollback above. Keep using `oauth()` for subsequent OAuth-ready restarts/recreation; plain `docker compose up` intentionally selects locked configuration again. No database or worker port is published by this fix. Keycloak continues on host 41874.

Stage 0B remains NOT PASSED. This fixes OAuth setup/discovery and prepares manual verification; it does not prove a real OAuth login, owner consent, event callback, or automatic dot reply.
