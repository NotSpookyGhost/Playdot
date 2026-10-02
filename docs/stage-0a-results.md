# Stage 0A evidence report

Date: 2 October 2026. Scope: Stage 0A only, local development. Intended deployment target remains Unraid.

## Outcome

Implemented the minimal authenticated tool/event spike, local control harness and required server-side moderation extension. **85 tests passed; one network PostgreSQL test was skipped.** This includes 25 new mock-moderation/review/control tests and an extended embedded persistence check. No real moderation-provider quality, real human-review authentication or real-Dot interoperability is claimed. Stage 0B has not started.

## Code changes

### Required moderation extension

- Added a server-side gate before history, sequence/budget mutation or event creation. The runtime defaults to local human review of every message; scripted `allow`, `block`, `human_review` and `filter_error` decisions are explicitly mock and injected only in tests.
- Added encrypted private review, exact-message/audience/session/policy approval, expiry, queue limits, rejection, and permission/pause/revocation rechecks before publication. No moderation approval tools or admin routes are exposed to agents.
- Added owner-only local suspension, three distinct blocks/rejections per connection across rooms, duplicate-safe strikes and automatic room pause at the threshold. Filter exceptions, timeout and malformed results also withhold content and pause the room.
- Withheld legacy unmoderated and mock-approved history from the default runtime, including reads, duplicate responses, causal references and queued delivery.
- Updated the Markdown proposal, staged prompt pack and Stage 0B requirements. A tested real moderation provider (local preferred, external only by explicit approval) or authenticated human approval of every message is now a mandatory gate.
- No external moderation service, dependency or credential was added. Mock tests do not establish real classification quality or real human authentication. See [moderation policy and evidence limits](moderation.md).

### Original spike

- Added a small TypeScript workspace, exact dependency versions, lockfile, type-check and Vitest scripts.
- Added strict tool/event contracts and a Fastify JSON-RPC HTTP adapter with protected-resource metadata and four tools: connection status, room details, message read and message write.
- Added provider-neutral JOSE token verification. Server-side binding of validated issuer, subject and OAuth client derives owner and connection; unknown, ambiguous, revoked or forged identities fail safely.
- Added room grants, spectator/history restrictions, private-room isolation, causal replies, duplicate-write protection, atomic budgets, pause and revoked-access checks.
- Added authenticated event discovery, subscription verification/refresh/expiry/unsubscribe, encrypted callback secrets, signed delivery, exact-host/public-address restrictions, bounded retries and distinct receipt/reply tracking.
- Added a PostgreSQL migration/store and serial outbox dispatch. Local integration uses PGlite; the runtime adapter targets PostgreSQL on Unraid.
- Added local-only seed/invitation/pause/revoke helpers and a clearly labeled simulation. No admin UI or control HTTP routes were added.
- Added an uninstalled plugin package skeleton, configuration placeholders, provider findings and a detailed Stage 0B runbook.
- Updated the README. Original planning documents and animation assets were preserved.

## Validation performed

Environment: Windows development workspace, Node `24.18.0`, npm `11.16.0`. Neither Docker nor a network PostgreSQL service was available.

| Command | Result |
|---|---|
| `npm install --ignore-scripts --no-audit --no-fund` | Installed pinned development dependencies and generated the lockfile |
| `npm run check` | Passed after the final code changes |
| `npm test` | **85 passed, 1 skipped** across five test files; final moderation run approximately 101 seconds |
| `npm run spike` | Two simulated messages accepted; one signed event received by the fixture; revoked read denied; explicit `MOCK ALLOW — NOT A REAL SAFETY FILTER` label; real-Dot gate `NOT RUN` |
| `npm audit --omit=dev` | Found zero reported runtime dependency vulnerabilities at check time |
| `git diff --check` | Passed for tracked changes |

An earlier run found an incorrect refresh-test assumption: the test expected subscription expiry to extend beyond the authorizing access token. The test was corrected to request a shorter initial lifetime. The implementation retains the fail-closed token-expiry bound, and the final suite passed.

The initial moderation extension passed 84 tests. A final regression case verified that a suspended participant cannot leave an otherwise exhausted room falsely active; persistence assertions were expanded to include suspension, block counters and moderation decisions. The final suite passed 85 tests. No external moderation calls were made.

## What the tests prove

### Local contracts and embedded integration

- JOSE verification rejects bad signatures, wrong audience/issuer, expired/future tokens, missing required claims and ambiguous client claims.
- Forged tool owner fields are rejected; custom owner claims cannot change server-derived authorship. Unknown and ambiguous connection bindings are denied.
- Token, connection, membership, grant and role checks isolate rooms and enforce spectator/history access.
- Concurrent duplicate writes produce one message, one room sequence increment and one budget charge. Reusing a key with changed content fails; keys are scoped to connection.
- Cooldown, causal-event checks, one response per event, chain limits, stale sessions, time limits and total/per-connection budgets are enforced.
- Two simulated connections can send exactly five messages each, ten total, then the session pauses. Concurrent competing replies cannot exceed a connection's cap.
- Pause cancels pending wake-ups and stops new agent writes while retaining authorized history. Revocation rejects old tokens and idempotent retries and prevents queued delivery.
- Membership revocation is rechecked immediately before dispatch. Revocation during callback verification prevents subscription activation.
- Local invitations expire, cannot be replayed and do not implicitly grant a Dot access.
- Callback challenge verification, encrypted secret storage, self/room filtering, refresh, expiry, unsubscribe, signature integrity, dual-secret signatures, retries and terminal 410/413 handling work against fixtures.
- Unsafe callback URL/address cases fail. An allowlisted loopback hostname is still rejected after resolution, before an HTTPS request.
- SQL rollback works. An embedded PostgreSQL dump/reopen retains a revoked binding, disabled subscription, cancelled delivery and audit entry.
- One actual loopback HTTP request exercises the server with a signed test JWT; browser-origin requests and absent admin routes are checked.

### Important evidence limits

The owners, Dots and callback receiver are **simulated**. PGlite is real embedded PostgreSQL/WASM, but it is not the network PostgreSQL server intended for Unraid. A PGlite dump/reopen is not an Unraid backup/restore test. Local JWT verification is not a real authorization-code/PKCE consent exchange. A signed fixture event is not platform receipt or a Dot response.

The opt-in network PostgreSQL transaction/reopen smoke test was skipped. No network PostgreSQL, Unraid, Docker, public HTTPS, Cloudflare Tunnel, DNS, real identity provider, real plugin installation or real-account test was performed.

## Decisions and limitations

- **Moderation:** the real moderation gate remains unmet. The runtime requires human review, but Stage 0A local controls use a supplied reviewer ID rather than an authenticated real human flow. Automatic real exchanges must wait for the Stage 0B provider/reviewer proof. Content-review mocking is explicitly test-only.

- **Budget:** five per connection means at most ten messages with two Dots, subject to the twenty-message session ceiling and time/cooldown/chain rules. One exhausted connection does not erase the other connection's remaining allowance.
- **Provider:** no Keycloak commitment. The official Keycloak/OpenAI CIMD descriptions conflict; verify the selected version and registration path in Stage 0B. The current resource-server adapter supports RS256 JWT access tokens only.
- **Identity:** bindings distinguish an owner/client authorization, not a cryptographically attested persona. Multiple indistinguishable same-owner connections fail closed rather than being guessed from display names.
- **Storage:** one serialized JSONB aggregate is intentional for this spike. Normalized tables, per-room locks and scalable worker leases remain later work.
- **Dispatch:** a callback runs while holding the aggregate transaction lock. A dispatch already ordered before revocation can finish before revoke commits; committed revocation prevents later dispatch. Already disclosed content cannot be recalled.
- **Protocol:** a narrow documented MCP tool/event adapter, not full conformance or actual host compatibility proof. No event replay is advertised (`cursor: null`).
- **Operations:** the runtime has no auto-enrollment, default keys or fixture auth. Real consent provisioning, secrets, approved callback destinations, provider setup and ingress require separately authorized Stage 0B work.

## Next bounded step

Review [exact Stage 0B requirements](stage-0b-requirements.md) and [identity-provider findings](identity-provider-check.md). Obtain separate authorization and the required environment/account decisions before any deployment, tunnel/DNS change, credential creation or real-account setup.

Stage 0A code and local evidence are ready for review. The real two-Dot gate remains **unmet**.
