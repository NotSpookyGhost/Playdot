# Keycloak subject mapper: TOKEN_SUBJECT_INVALID

## Evidence and scope

Operator diagnostics show HTTP_CONTENT_TYPE_REJECTED for one request and TOKEN_SUBJECT_INVALID for two different requests. This confirms rejection at subject validation, not successful authorization or tool listing. The subject code covers a missing or non-string subject; it does not print the value or prove that all later checks would pass. The HTTP code covers an unsupported request media type; it does not identify the caller or the raw media type. Keep the existing JSON parser restrictions.

The local realm template explicitly sets defaultClientScopes to an empty list on both MCP clients and, before this correction, configured only an audience mapper. It supplied neither the built-in basic scope nor a direct subject mapper. This was a template omission.

Keycloak's [25.0 migration notes](https://github.com/keycloak/keycloak/blob/26.8.0/docs/documentation/upgrading/topics/changes/changes-25_0_0.adoc) explain that access-token sub moved to a mapper, normally in the basic client scope. The pinned [26.8.0 SubMapper](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/mappers/SubMapper.java) uses the authenticated user's persistent Keycloak ID. It does not use a username, arbitrary attribute or configured constant. Its [configuration keys](https://github.com/keycloak/keycloak/blob/26.8.0/services/src/main/java/org/keycloak/protocol/oidc/mappers/OIDCAttributeMapperHelper.java) were checked against the same pinned release.

The template now adds an explicit oidc-sub-mapper to playdot-gary and playdot-friend, retaining the minimal scope assignments. This avoids relying on an imported realm automatically attaching basic. No owner-client change, new owner binding, pilot initialization, authorization relaxation, runtime code change or parser change is included in this subject fix.

The actual live client has not been inspected. Verify its effective mapper configuration below. If it already has an enabled subject mapper, stop instead of adding a duplicate or overwriting another subject strategy. A real reconnect is still required; local JWT fixtures do not run Keycloak.

## 1. Private backup, no downtime

Run in the Unraid terminal. Stop on any failure. This only reads the Keycloak database and writes a new private backup file. Do not share the backup.

```bash
export PLAYDOT_SUBJECT_BACKUP="/mnt/user/appdata/playdot/backups/subject-$(date -u +%Y%m%dT%H%M%SZ)"
(
  set -eu
  umask 077
  test ! -e "$PLAYDOT_SUBJECT_BACKUP"
  install -d -o 0 -g 0 -m 0700 "$PLAYDOT_SUBJECT_BACKUP"
  docker exec playdot-identity-identity-db-1 pg_dump -U postgres -d keycloak \
    > "$PLAYDOT_SUBJECT_BACKUP/keycloak.sql"
  test -s "$PLAYDOT_SUBJECT_BACKUP/keycloak.sql"
  printf 'Backup saved privately under %s\n' "$PLAYDOT_SUBJECT_BACKUP"
)
```

Expected: exit 0, nonempty backup. No application stop or rebuild.

## 2. Inspect before changing

Use the existing private Keycloak administration route, not a new public admin/tunnel route. Select realm playdot, Clients, playdot-gary, Client scopes.

- Inspect assigned default scopes, especially basic if present, and the dedicated scope's Mappers list.
- If a Subject (sub) mapper already applies, inspect its Add to access token setting. If disabled, record its prior settings privately, enable it, and do not create another mapper.
- If a default basic scope already provides an enabled Subject (sub), or there is a pairwise/custom mapper that overrides sub, stop and report only that configuration fact. Do not send user IDs, token values, salts or mapper secrets. The template omission alone does not explain a client already correctly configured.
- Otherwise follow stage 3 to add the missing built-in mapper on this client only.

## 3. Add the missing Subject (sub) mapper

Navigate: playdot realm -> Clients -> playdot-gary -> Client scopes -> playdot-gary-dedicated -> Mappers -> Add mapper -> By configuration -> Subject (sub).

Set:

| Field | Value |
| --- | --- |
| Name | playdot-subject |
| Mapper type | Subject (sub) |
| Add to access token | ON |
| Add to lightweight access token, if shown | ON |
| Add to token introspection, if shown | ON |

Save. There is no user ID or claim-value field to fill in for this built-in mapper. If the screen asks you to invent a subject value, you selected a different mapper: stop. Do not choose Hardcoded claim, User Attribute or Pairwise subject identifier. Do not change user IDs, scopes, client ID, redirect URIs, the corrected audience, signing algorithm or S256 PKCE. The new mapper automatically uses the signed-in user's existing identity; it does not grant room access.

No restart is necessary. This affects newly issued access tokens. Existing tokens are not rewritten. For playdot-friend, the template is also corrected, but the friend's existing connection/setup remains separate; do not connect the friend's account as part of this diagnosis. Leave playdot-owner unchanged.

## 4. One new OAuth authorization and filtered evidence

In the Unraid terminal BEFORE reconnecting:

```bash
export PLAYDOT_RECONNECT_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

Reconnect once in ChatGPT using the personal Playdot account and the existing playdot-gary OAuth configuration. Complete a fresh OAuth authorization; merely retrying an action with the already-rejected access token cannot add sub.

Afterward, run:

```bash
(
  set -euo pipefail
  cd /mnt/user/appdata/playdot/source
  : "${PLAYDOT_RECONNECT_SINCE:?Record the reconnect time first}"
  app_id=$(docker compose -f compose.yaml -f compose.oauth-setup.yaml ps -q playdot)
  test -n "$app_id"
  docker logs --since "$PLAYDOT_RECONNECT_SINCE" "$app_id" 2>&1 \
    | docker run --rm -i --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --entrypoint node \
        playdot-stage0a:local scripts/collect-diagnostics.mjs
)
```

Desired evidence for an authenticated tools/list request: TOKEN_OK, AUTHORIZED and TOOLS_LIST_OK with the same server correlation ID. INITIALIZE_OK and/or DISCOVER_OK can occur on separate requests. A later token/authorization error exposes the next unmet check; do not bypass it. TOKEN_SUBJECT_INVALID can precede other failures, so its disappearance is not a promise that all checks pass. HTTP_CONTENT_TYPE_REJECTED on a separate request is still unresolved; if tools listing succeeds and ChatGPT connects, that rejection did not prevent that connection. No raw token or request capture is needed.

All room/event/worker flags must remain false. ChatGPT connection success is not real-dot conversation evidence and does not mark Stage 0B passed.

## 5. Rollback and files

For a mapper added in stage 3, rollback means removing only the newly added playdot-subject mapper. For an existing mapper whose flags you edited, restore those recorded flags instead. It affects future tokens; existing tokens remain subject to their expiry and existing revocation policy. Do not restore the whole SQL dump over a live database, recreate the realm, or change owner mappings.

No files need copying and no Playdot Docker rebuild is needed to apply this correction to the existing realm. Local files changed in this subject-specific follow-up are:

- config/keycloak-realm.example.json: explicit subject mapper for the two MCP clients.
- tests/discovery.test.ts: assert subject mapper configuration and reject missing/null/numeric subject fixtures.
- docs/keycloak-subject-fix.md: this procedure.
- docs/authenticated-discovery-fix.md: link to this follow-up.

You may copy these to corresponding paths under /mnt/user/appdata/playdot/source to keep source synchronized. Do NOT replace /mnt/user/appdata/playdot/config/keycloak-realm.json with the example. Its actual callback URLs must be retained, and realm import would not update the existing realm anyway.

## Validation

Type-check, compilation and the full test suite are run locally for this correction. Results are appended below. No Unraid, Playdot or Keycloak live endpoint was accessed, no credentials were generated, and no push or deployment was performed. Docker/real Keycloak issuance remains operator-verified.

Final local results: `npm run check` passed; `npm run build` passed; `npm test` completed with **144 passed, 1 network PostgreSQL test skipped** (145 total). No test failures. JSON validation, manual Bash syntax checks and `git diff --check` passed. Actual Keycloak issuance, Docker execution and ChatGPT reconnect were not run.

## Operator confirmation

On 2026-10-03, the operator reported that ChatGPT connected after applying the Subject (sub) mapper correction. This is operator-reported connection success; no live endpoint or account was accessed by the coding agent. No tokens, identities or private request data were supplied as evidence. Automatic dot-to-dot events, replies, real-room participation and the full Stage 0B proof remain unverified and are not marked passed.
