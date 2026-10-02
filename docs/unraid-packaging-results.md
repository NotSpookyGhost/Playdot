# Unraid packaging evidence — 2 October 2026

Prepared locally; **not deployed**. The Unraid host is not accessible from this environment. No DNS, tunnel, account, server setting, real credential or external moderation service was configured.

## Changes

- Added a multi-stage application Dockerfile (compiled production runtime plus separate one-shot test target), PostgreSQL init image, Compose configuration, build-context exclusions and placeholder environment configuration.
- Default installation is locked: loopback host port 41873 maps to container 3000, all MCP requests are unauthorized, and the existing in-process worker is disabled. No mock HTTP authentication or fixture state is installed. OIDC mode remains separately gated.
- Added file-secret database configuration, readiness checks, non-root service users, private database/test networks, bounded logs, restart/shutdown policy and configurable appdata mounts. Production dependencies and compiled runtime code exclude the test harness.
- Preserved migration 001's idempotent table/singleton creation, added schema-version rejection and an explicit migration command. No state reset or destructive upgrade procedure.
- Replaced the opt-in reset-based network smoke test with fresh isolated verification schemas. The shared spike/moderation harness can now run against a separate network PostgreSQL instance.
- Added a synthetic prepare/restart/verify command and an embedded dump/reopen test of the same scenario. It checks retained authorization, revocation, suspension, encrypted pending review, approved/unpublished and rejected decisions, stale approval denial, duplicate handling and cancelled delivery.
- Added Unraid directory/secret/preflight scripts and the [complete operator runbook](unraid.md), including the future shared-network Cloudflare origin route.

## Local checks

Environment: Windows, Node 24.18.0, npm 11.16.0, installed locked dependencies. Proposed image runtime is Node 24.21.0; that Linux image was not executed locally.

| Check | Actual result |
|---|---|
| `npm run check` | Passed |
| `npm run build` | Passed; compiled server and migration plus SQL asset present; no test files emitted |
| `npm test` | **88 passed, 1 skipped**, 7 files, approximately 104 seconds |
| Focused packaging/restart tests | 3 passed, also included in full suite |
| `npm run spike` | Passed: 2 synthetic messages, 1 signed fixture event, revoked read denied; mock moderation and real-Dot gate not-run labels retained |
| YAML parser and static safety assertions | Passed: loopback-only mapping, locked mode, no DB/test/migration port mappings, distinct DB paths, isolated test network, non-root users and security options |
| Shell syntax | All 4 shell scripts and all 15 runbook Bash command blocks passed Git Bash syntax checks; no Unraid script executed against a real server |
| `git diff --check` | Passed; Windows line-ending advisories only |

Initial ad hoc validation commands encountered PowerShell placeholder expansion and Windows default-text-encoding errors. Re-running with literal input and explicit UTF-8 passed; these were validation-command issues, not application or Compose failures. No application test failed. Docker Compose validation is **not** claimed from YAML parsing.

## Not tested here

- Docker/Compose are unavailable, so image pull/build, Linux image behavior, Compose schema validation, container UID/mount enforcement, database initialization, health dependencies, loopback publication and signal handling must be checked on Unraid.
- No network PostgreSQL server is available locally. The network test is skipped, and the full network suite and actual normal PostgreSQL-container restart proof remain pending. Embedded PostgreSQL dump/reopen passed but is not equivalent to a container restart.
- The runbook's network expectation is 89 passing tests; this is an expected result, not a recorded execution.
- Unraid storage/permissions, backup restore, real identity-provider consent, authenticated human review, real moderation classification and real-Dot interoperability remain unverified.

The user's existing and concurrent README changes were retained; only a packaging/runbook paragraph was added. Original planning and animation assets were not rebuilt or overwritten. The original Stage 0A evidence report remains historical; this report records the subsequent packaging work. The next action is operator execution of the runbook, followed by the remaining [Stage 0B gates](stage-0b-requirements.md).
