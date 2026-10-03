# Stage 0B local preparation results

Date: 2026-10-02. Real Stage 0B status: **NOT PASSED / NOT RUN**.

Baseline rerun before extension: `npm run check` passed; `npm test` passed 88 tests, with one network PostgreSQL test skipped. The user separately reports all Stage 0A Unraid tests passed. The agent did not independently access that server.

After extension:

| Check | Result |
|---|---|
| TypeScript `npm run check` | Passed |
| Existing compilation `npm run build` | Passed after explicit user approval; only ignored dist output |
| Full `npm test` | 98 passed, 1 network test skipped |
| `npm run test:stage0b` | 10 passed, including signed OIDC-library token fixtures |
| Updated embedded PostgreSQL restart test | Passed; actual dump/close/reopen with pilot consent, encrypted review and revocation |
| Compose YAML / template JSON parsing | Passed syntax only, not Docker Compose semantics |
| Shell scripts and runbook Bash blocks | Passed `bash -n`; commands were not executed on Unraid |
| Documentation links / diff whitespace | Passed |
| Docker build, Compose validation, container startup and health | Not run: Docker unavailable locally |
| Network PostgreSQL / Unraid normal restart | Not run locally; exact commands supplied |
| Keycloak discovery, realm import, resource indicators and both real logins | Not run; templates only |
| Plugin install, real callbacks, automatic replies and live refresh/revocation | Not run; both accounts unverified |

Two initial consent tests failed because reading a paused pre-consent session replaced its pause reason with TIME_LIMIT. The service now applies expiry transitions only to active sessions; those tests pass. Consent also checks the session ID to reject stale browser forms after session replacement. No failed check was reclassified as a pass without a correction and rerun.

The OIDC test exercises openid-client against ephemeral signed fixtures, including signature, issuer, audience, nonce, expiry and state rejection. The owner-route test uses an injected login adapter for cookie/CSRF/escaping checks. Neither is a live Keycloak or ChatGPT login. Domain fixtures are not real dots. No real credentials or accounts were created.

Automatic approval review initially blocked compilation under the instruction not to rebuild the project. After the user specifically approved the existing compilation check, it ran successfully. No project scaffolding was replaced.

Prepared artifacts: optional identity/Stage 0B Compose files, Keycloak container wrapper and realm/config templates, read-only inventory/metadata checks, authenticated owner controls, pilot initialization CLI, and [setup guide](stage-0b-setup.md). The base Compose mode and loopback bind are unchanged. No DNS/tunnel/security setting, remote deployment, GitHub push or account connection was performed.

Remaining approvals and capability blockers are listed in the setup guide. Preserve [sanitized real-test evidence](stage-0b-evidence.md) separately. Do not claim unattended operation: the selected moderation route requires human approval of every publication. Stop before later stages.

## Approved authentication host-port update

Prepared Keycloak host mapping `${KEYCLOAK_BIND_IP}:${KEYCLOAK_HOST_PORT:-41874}:8080/tcp` and an auth tunnel origin using the Unraid LAN IP on port 41874. The actual IP is intentionally not guessed. Application loopback binding and unpublished PostgreSQL/worker/management ports remain unchanged. Updated Compose/environment/ingress templates and runbook; no application source change or image rebuild is needed. YAML parsing, expected mapping checks and documented Bash syntax pass locally. Docker Compose runtime validation, port availability and tunnel reachability still require Unraid. No deployment or tunnel change was performed.
