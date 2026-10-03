# Authenticated discovery fix and manual Unraid deployment

Work is local only. No Unraid, Playdot or Keycloak endpoint was accessed. No push or deployment was performed. Stage 0B is not passed. OAuth-only mode still prohibits room access, event subscriptions and queued dispatch, and does not initialize a pilot or bind an owner.

## Findings and limits

The operator reports successful Keycloak login followed by ChatGPT action discovery failure. Metadata checks alone cannot validate the token ChatGPT presents or the authenticated RPC exchange. The exact live failure remains unknown until one reconnect produces the new diagnostic codes.

Demonstrated defects:

- The realm example used `included.client.audience: playdot-resource`. Keycloak 26.8.0's [AudienceProtocolMapper implementation](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/mappers/AudienceProtocolMapper.java) adds that literal client ID; it does not convert it through `resource_url`. The example now uses only `included.custom.audience: https://playdot.bytedev.app/mcp`. The actual issued token might have additional audiences from other mappers/resource-indicator behavior; no live token was inspected. URL audience validation remains mandatory. Existing realms are not updated by changing an import example.
- Legacy `initialize` accepted only `2026-07-28`, despite that revision using handshake-free discovery. Supported legacy versions now negotiate `2025-11-25`, `2025-06-18`, or `2025-03-26`; unknown initialize versions receive the newest implemented legacy version. Subsequent unknown versions receive HTTP 400 and supported-version data. See [legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [modern versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).
- `tools/list` rejected standard `_meta`. Transport metadata is now accepted separately from tool arguments, with modern version/method/name header consistency checks. Modern results include `resultType: complete`, and `server/discover` includes server identity. Tool listing remains stable, four tools, with object input schemas and OAuth security schemes. See [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), and [HTTP binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

The official [OpenAI quickstart](https://developers.openai.com/plugins/build/app-quickstart) supports stateless Streamable HTTP with JSON responses. These docs do not establish which version this user's ChatGPT connection actually sends. GET returning 405 after authorization is intentional; no SSE session or event worker is enabled. No inferred ChatGPT version, guessed browser origin allowlist, or bypass of token checks was added.

## 1. Files to copy

Copy from `C:\Users\Administrator\Documents\Playdot\Playdot` to `/mnt/user/appdata/playdot/source`, preserving these relative paths:

```text
.dockerignore
Dockerfile
apps/server/src/app.ts
apps/server/src/auth.ts
apps/server/src/diagnostics.ts         NEW
apps/server/src/protocol.ts            NEW
packages/contracts/src/index.ts
config/keycloak-realm.example.json
scripts/check-provider.mjs
scripts/collect-diagnostics.mjs        NEW
tests/discovery.test.ts                NEW
tests/spike.test.ts
docs/authenticated-discovery-fix.md    NEW
```

No package/dependency, Compose, database schema, stored config hash or owner-binding change is needed. Existing `compose.yaml` and `compose.oauth-setup.yaml` remain the deployment combination. Do not copy `dist`, `node_modules`, `.git`, secrets, or a replacement `.env`. Do not overwrite `/mnt/user/appdata/playdot/config/stage0b.json` or `stage0b.env`. Keep ports 41873 (app loopback) and 41874 (existing auth origin) unchanged. Do not reimport/reseed Keycloak. The example belongs under **source/config**, not the active **appdata/config** path.

## 2. Preserve rollback image (no downtime)

Run all stages in the same Unraid Bash terminal. Stop after any failed command; do not proceed to the next stage. Commands in subshells use `set -eu`. Do not enable `set -x`.

```bash
cd /mnt/user/appdata/playdot/source
export PLAYDOT_DATA_ROOT=/mnt/user/appdata/playdot
export PLAYDOT_PORT=41873
oauth() { docker compose -f compose.yaml -f compose.oauth-setup.yaml "$@"; }
export PLAYDOT_DISCOVERY_BACKUP="$PLAYDOT_DATA_ROOT/backups/discovery-$(date -u +%Y%m%dT%H%M%SZ)"
(
  set -eu
  umask 077
  test ! -e "$PLAYDOT_DISCOVERY_BACKUP"
  install -d -o 0 -g 0 -m 0700 "$PLAYDOT_DISCOVERY_BACKUP"
  app_id=$(oauth ps -q playdot)
  test -n "$app_id"
  old_image=$(docker inspect --format '{{.Image}}' "$app_id")
  rollback_tag="playdot-discovery-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
  docker image tag "$old_image" "$rollback_tag"
  printf 'services:\n  playdot:\n    image: %s\n' "$rollback_tag" > "$PLAYDOT_DISCOVERY_BACKUP/rollback.yaml"
  cp -p compose.yaml compose.oauth-setup.yaml "$PLAYDOT_DISCOVERY_BACKUP/"
  test ! -f .env || cp -p .env "$PLAYDOT_DISCOVERY_BACKUP/source.env"
  printf 'Keep this backup path: %s\n' "$PLAYDOT_DISCOVERY_BACKUP"
)
```

Expected: successful backup and image tag. Keep the backup private. The files may contain operator configuration; never paste them in chat.

## 3. Build and test (old app continues running)

```bash
(
  set -eu
  oauth config --quiet
  oauth build --no-cache playdot
  docker compose --profile verify build tests
  docker compose --profile verify run --rm --no-deps \
    -e PLAYDOT_TEST_NETWORK=no tests npm run check
  docker compose --profile verify run --rm --no-deps \
    -e PLAYDOT_TEST_NETWORK=no tests npm test
  oauth run --rm --no-deps -T --entrypoint node playdot \
    --input-type=module -e 'const p=await import("./dist/apps/server/src/protocol.js"); if(typeof p.protocolRequest!=="function")process.exit(1); console.log("PASS: updated discovery code is in the runtime image")'
)
```

Expected: compilation and tests pass (network PostgreSQL test skipped in this embedded mode), followed by the runtime-image PASS. This explicit build and image check avoid the stale-image problem encountered during the earlier rollout. Stop if any step fails; the existing app container is still using its previous image.

## 4. Back up state and recreate only Playdot (brief app downtime)

Downtime starts at `stop playdot`. Database and Keycloak remain running. No migration, reset, volume deletion, credential generation or pilot initialization is performed. These private database backups contain sensitive application state; keep them on the server.

```bash
(
  set -eu
  umask 077
  test -d "$PLAYDOT_DISCOVERY_BACKUP"
  test ! -e "$PLAYDOT_DISCOVERY_BACKUP/playdot.sql"
  oauth stop playdot
  oauth exec -T db pg_dump -U postgres -d playdot > "$PLAYDOT_DISCOVERY_BACKUP/playdot.sql"
  test -s "$PLAYDOT_DISCOVERY_BACKUP/playdot.sql"
  oauth exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d playdot -Atc \
    'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1' > "$PLAYDOT_DISCOVERY_BACKUP/state-before.txt"
  oauth up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 playdot
  oauth exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d playdot -Atc \
    'SELECT md5(data::text) FROM playdot_spike_state WHERE id=1' > "$PLAYDOT_DISCOVERY_BACKUP/state-after.txt"
  cmp "$PLAYDOT_DISCOVERY_BACKUP/state-before.txt" "$PLAYDOT_DISCOVERY_BACKUP/state-after.txt"
  oauth ps playdot
  oauth port playdot 3000
)
```

Expected: healthy, unchanged state digest, `127.0.0.1:41873`. A failed start means stop here and collect sanitized diagnostics or use rollback below, not repeat the backup block over its existing files.

## 5. Verify OAuth-only safety and public metadata

These network commands are for the operator only; they were not run during local development.

```bash
(
  set -eu
  curl --fail --show-error http://127.0.0.1:41873/health
  oauth exec -T playdot node scripts/verify-oauth-setup.mjs
  oauth exec -T playdot node scripts/check-provider.mjs
)
```

Expected: `0B-oauth-setup`, `oidc`, rooms/events/worker/real-dot verification all false; correct issuer/resource at both protected-resource routes; unauthenticated GET/POST challenges; public provider metadata checks pass. Token audience and action discovery are still not proven by these scripts.

## 6. Review/correct the existing Keycloak audience mapper

This is an operator-applied change to newly issued access tokens, not a realm import. No restart is required. Keep the existing client IDs, actual ChatGPT redirect URL, S256 PKCE, public-client setting, users, scopes and owner client unchanged. Never add a wildcard redirect or expose public `/admin` just for this change.

Before editing, take a private identity database backup (read-only, no downtime):

```bash
(
  set -eu
  umask 077
  test -d "$PLAYDOT_DISCOVERY_BACKUP"
  test ! -e "$PLAYDOT_DISCOVERY_BACKUP/keycloak.sql"
  docker exec playdot-identity-identity-db-1 pg_dump -U postgres -d keycloak \
    > "$PLAYDOT_DISCOVERY_BACKUP/keycloak.sql"
  test -s "$PLAYDOT_DISCOVERY_BACKUP/keycloak.sql"
)
```

Using the existing private Keycloak administration access that you used to save the callback:

1. Select realm **playdot**, **Clients**, **playdot-gary**, **Client scopes**, **playdot-gary-dedicated**, **Mappers**, **playdot-audience**. Keycloak may show the dedicated scope by a shortened label.
2. Record the mapper's existing fields privately for rollback. If it already uses only the exact URL as custom audience and adds it to access tokens, leave it unchanged.
3. Set **Included Client Audience** to empty/unselected. This matters: Keycloak gives that field precedence over custom audience.
4. Set **Included Custom Audience** to `https://playdot.bytedev.app/mcp` (no trailing slash).
5. Keep **Add to access token ON** and **Add to ID token OFF**. Save. If the expected mapper is absent, stop and inspect the client configuration rather than deleting or recreating clients.
6. Apply the same narrowly scoped mapper correction to **playdot-friend** if it has the old template value, with that owner's setup approval before connecting their account. Do not change `playdot-owner`.

Existing `config/keycloak-realm.json` is only an initial import artifact: changing it alone does not update this live realm. You may separately back it up and change only these two mapper fields to match the approved live configuration; do not replace the whole file with the example or erase actual callback URLs. This is not required to deploy the app fix. No other `/mnt/user/appdata/playdot/config` file needs editing.

## 7. One reconnect, then sanitized diagnostics

Immediately before reconnecting, record the start time in the same terminal:

```bash
export PLAYDOT_RECONNECT_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Perform **one** reconnect in ChatGPT with your personal Playdot account, client `playdot-gary`, blank secret/token auth `none`, and the existing exact callback URL. Do not connect the friend's account or enable rooms/events yet. Do not copy tokens or decoded claims into terminal/chat.

Then collect only validated diagnostic records:

```bash
(
  set -euo pipefail
  : "${PLAYDOT_RECONNECT_SINCE:?Record the reconnect time first}"
  app_id=$(oauth ps -q playdot)
  test -n "$app_id"
  docker logs --since "$PLAYDOT_RECONNECT_SINCE" "$app_id" 2>&1 \
    | docker run --rm -i --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --entrypoint node \
        playdot-stage0a:local scripts/collect-diagnostics.mjs
)
```

The collector uses no network, Docker socket, mounts, credentials or application database. It discards anything except the exact allowed three-field diagnostic schema and reserializes it. Share this filtered output and the ChatGPT success/error text. Empty output means no accepted diagnostic records were found; it is not proof of successful discovery. Verify the new image/start time before retrying. Do not enable full request logging or paste raw container logs/token payloads.

Diagnostics contain only `phase`, `reason`, and a random server-generated `correlation_id`. The ID groups phases for one HTTP request, not a user or an entire OAuth flow. Client request IDs and headers are never used as logged IDs.

| Phase/reason | Meaning / next step |
| --- | --- |
| token / BEARER_REQUIRED | No Bearer credential; an initial OAuth challenge is normal. |
| token / TOKEN_AUDIENCE | Token did not satisfy exact MCP audience; review mapper and newly issued authorization. Do not relax audience validation. |
| token / TOKEN_ISSUER, TOKEN_EXPIRED, TOKEN_CLAIMS, TOKEN_SIGNATURE, TOKEN_ALGORITHM, TOKEN_INVALID | Token validation rejected it; no claims or raw errors are retained. |
| jwks / JWKS_TIMEOUT, JWKS_KEY_UNAVAILABLE, JWKS_FETCH_FAILED | Key retrieval/selection failed; distinct from token claims. Public metadata success does not prove the app's configured JWKS request succeeded at reconnect time. |
| authorization / CLIENT_DENIED, SCOPE_DENIED | Verified token lacks an approved client or `room:read`; inspect Keycloak client/scope configuration, not owner mappings. |
| authorization / CONNECTION_DENIED | Existing binding is revoked/suspended/mismatched/ambiguous. Do not bypass or reseed it. |
| authorization / AUTHORIZATION_DENIED | Other authorization rejection such as expiry under the store lock. |
| protocol / INITIALIZE_OK, DISCOVER_OK, TOOLS_LIST_OK | Server produced a successful response at that step. TOOLS_LIST_OK is not proof ChatGPT consumed it. |
| protocol / UNSUPPORTED_VERSION, HEADER_MISMATCH, INVALID_REQUEST, INVALID_PARAMS, METHOD_NOT_FOUND | Protocol rejection; report the codes, not raw request data. |
| protocol / ORIGIN_DENIED, HTTP_PARSE_REJECTED | Origin/HTTP parser rejection before authenticated dispatch; do not weaken origin validation. |
| protocol / GET_NOT_SUPPORTED | Authorized optional GET stream probe rejected with 405, intentional. |
| protocol / INITIALIZED, RPC_OK, OPERATION_DENIED | Notification/other RPC outcome; tool results can still be safety-gated errors. |
| internal / INTERNAL_FAILURE | Sanitized server failure; no exception text is logged. |

## 8. Rollback if necessary (brief app restart)

Restore only the previous image, retaining the same OAuth-only environment and data:

```bash
(
  set -eu
  test -s "$PLAYDOT_DISCOVERY_BACKUP/rollback.yaml"
  docker compose -f compose.yaml -f compose.oauth-setup.yaml \
    -f "$PLAYDOT_DISCOVERY_BACKUP/rollback.yaml" \
    up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 playdot
)
```

For an audience-mapper rollback, restore only the recorded original fields through the same existing private administration access; newly issued tokens will reflect them. Existing tokens last until expiry. Do not restore an entire SQL dump over an active database or delete volumes. No data/schema rollback is needed for this application change. Restoring the old image also restores its discovery defects and removes the new diagnostics.

## Local validation

Results are recorded after the final local run below. Local fixtures use ephemeral test signing keys and embedded PostgreSQL, not real users, tokens, providers or endpoints. They do not establish ChatGPT acceptance or Stage 0B completion.

- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: 132 passed, 1 network PostgreSQL test skipped (133 total); no failures. Tests include existing permission/moderation/revocation/rotation regressions plus 21 new discovery/diagnostic/template cases.
- After final collector hardening: type-check/build passed again; focused discovery suite 21/21 passed.
- Manual Bash blocks: syntax checked locally. Collector JavaScript syntax checked; compiled collector fixture checks passed. Docker build context now explicitly permits only the nonsecret realm example required by the new template regression test.
- Not run: Docker image build/Compose startup (Docker unavailable locally), network PostgreSQL, actual Keycloak-issued tokens/mappers, ChatGPT reconnect, Unraid or public health/provider checks. No claim that the real discovery failure or Stage 0B has been resolved until the operator confirms the reconnect.

## Follow-up: broad TOKEN_CLAIMS / HTTP_PARSE_REJECTED records

The operator observed two TOKEN_CLAIMS records and a separate HTTP_PARSE_REJECTED record. These do not identify a specific claim or prove a protocol-version problem. Additional predefined codes now distinguish missing/invalid subject, issued-at, expiration, not-before, client identity, conflicting client identity, and scope representation. Missing `room:read` in an otherwise valid scope string still produces authorization / SCOPE_DENIED. Parser codes distinguish rejected content type, invalid JSON, empty JSON body, and oversized body. No validation was relaxed; no values, claim payloads or parser messages are logged.

For this follow-up only, copy `apps/server/src/app.ts`, `apps/server/src/auth.ts`, `apps/server/src/diagnostics.ts`, `tests/discovery.test.ts` and this guide. The existing collector imports the updated allowlist; no collector script edit is necessary. Preserve a rollback image using stage 2 with a NEW backup directory, then build/test/recreate using stages 3-5. Keep the mapper, owner bindings, scopes and other provider settings unchanged until the new reason identifies the rejection. Repeat stage 7 once, with a fresh start time recorded BEFORE reconnecting, and collect filtered diagnostics afterward.

| New reason | Meaning (no claim value is logged) |
| --- | --- |
| TOKEN_SUBJECT_INVALID | Required subject missing or wrong type. |
| TOKEN_IAT_INVALID | Required issued-at claim missing or invalid. |
| TOKEN_EXP_INVALID | Expiration missing or invalid; expired tokens retain TOKEN_EXPIRED. |
| TOKEN_NBF_INVALID | Not-before validation failed. |
| TOKEN_CLIENT_INVALID | No usable authenticated client claim. |
| TOKEN_CLIENT_AMBIGUOUS | The two supported client identity claims conflict. |
| TOKEN_SCOPE_INVALID | Scope claim missing or not a string. This differs from SCOPE_DENIED. |
| HTTP_CONTENT_TYPE_REJECTED | HTTP parser rejected the media type. |
| HTTP_JSON_INVALID | HTTP parser rejected malformed JSON. |
| HTTP_BODY_EMPTY | JSON content type was supplied without a JSON body. |
| HTTP_BODY_TOO_LARGE | Body exceeded the existing 32 KiB limit. |

Generic TOKEN_CLAIMS and HTTP_PARSE_REJECTED remain bounded fallback codes. The three observed requests have different correlation IDs; the logs do not establish that the parser rejection caused the subsequent JWT rejections.

Follow-up local validation: type-check and build passed; all 31 focused discovery/diagnostic tests passed. The previous full-suite result above predates this diagnostic refinement; the full suite was not rerun for this follow-up. No live requests, push or deployment occurred.

## Subject rejection follow-up

For operator evidence showing TOKEN_SUBJECT_INVALID, see [the subject-mapper correction](keycloak-subject-fix.md). The template omitted the subject mapper required for access tokens in the pinned Keycloak version. This follow-up can be applied to an existing client without another Playdot image rebuild; do not repeat the full app deployment solely for it.
