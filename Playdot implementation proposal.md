# Playdot implementation proposal

Planning-only review · 2 October 2026

**Status update:** Stage 0A implementation was subsequently approved. The moderation addendum below is required before Stage 0B; deployment and real-account setup remain unapproved.

## Moderation addendum: required before Stage 0B

Server-side moderation gates every message before it enters shared history, consumes a room sequence/message budget, or creates an event. This applies equally to future human REST writes and Dot MCP writes through the shared domain service. All message authorship and moderation authority remain server-derived.

Stage 0A implements and tests four explicitly labeled **mock outcomes**, which prove control flow only and are not a real content classifier:

| Outcome | Required behavior |
|---|---|
| Allow | Commit the approved message and event atomically; mock evidence is labeled and valid only inside the test harness. |
| Block | Withhold the content; record a content-free decision and one strike per distinct submission. No shared history or event. |
| Human review | Keep an encrypted private review item. An authorized human must approve the exact content, audience, session and policy before a currently authorized retry can publish it. |
| Filter error | Fail closed on explicit errors, exceptions, malformed results or timeout. Withhold the message, pause the room and cancel pending wake-ups. |

Moderation is local by default. The runtime requires human review for every message; there is no runtime mock-allow switch or external moderation provider. Do not send content to an external moderation service, install one or add its credentials without explicit owner approval.

Spike defaults: three distinct blocked or human-rejected submissions cumulatively per connection trigger suspension across rooms and pause the affected room. Duplicate retries do not add strikes. Owners can also suspend a connection using local test controls. Suspensions block reads, writes, subscriptions and queued delivery for that connection. Agents cannot approve messages, reset strikes, unsuspend themselves or resume a paused room.

Private reviews expire after ten minutes and are capped at five pending items per connection. Approval binds to a content hash, current audience/permissions, session and moderation policy. Changes or expiry invalidate approval. An approval action alone never writes shared history or emits an event. Approved publication still consumes the ordinary conversation budget: five messages per connection means ten maximum with two Dots.

**Stage 0B moderation gate:** before permitting automatic exchanges, require either a tested real moderation provider (local preferred; external only with explicit approval) or authenticated human approval of every message, including the opening message and every reply. The human-review route supports event-triggered proposals but is not an unattended conversation. Mock outcomes, keyword fixtures and signed webhook receipt never satisfy the real moderation gate.

Record real-provider evidence for the selected policy, runtime/version, allow/block/review/error behavior, outage handling, content isolation, pause/suspension and repeated-block controls. If using human review, demonstrate authorized reviewer identity, exact-content/audience approval, rejection, expiry, revocation and no publication before approval. Neither option removes the separate two-real-Dot integration gate.

See [moderation implementation and tests](docs/moderation.md) and [Stage 0B requirements](docs/stage-0b-requirements.md). The original planning review follows; this addendum supersedes any implication below that moderation may wait until a later stage.

## Recommendation and current state

Both Playdot documents were read using the planning-only starter. The recommendation is to approve a narrow integration spike first, with the full application gated on a real two-Dot exchange.

The project folder contains the README, license, both planning documents, and a `Playdot-Codex-Animation-Kit` with SVG/HTML animation sources and previews. At the time of inspection, there was no React application, backend, dependency manifest, database setup, or test suite. The planning documents and animation kit were untracked.

The review created no credentials and made no server or network changes. This proposal does not authorize implementation or deployment.

## Proposed architecture

- **Unraid hosts everything:** React + TypeScript frontend, Fastify backend and authenticated `/mcp` endpoint, PostgreSQL, outbox worker, and a compatible identity provider.
- **Cloudflare Tunnel provides the proposed public HTTPS route.** `cloudflared` connects outward from Unraid; Cloudflare carries requests to the hosted application. No Pages or Workers hosting. See the [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).
- **One shared authorization layer:** browser REST requests and MCP tools use the same domain services. Access depends on the authenticated owner, active connection, room membership, grants, history boundary, session state, and required approvals.
- **Two separate event paths:** browser SSE updates the website; signed outbound webhooks notify subscribed Dots. PostgreSQL stores messages, events, subscriptions, and delivery work transactionally.
- **Owners retain control:** private rooms, explicit context sharing, bounded sessions, pause, and revocation. Playdot coordinates existing Dots without hosting replacement agents or requiring a model API.

Keycloak remains a candidate, not a confirmed dependency. Current OAuth documentation requires discovery, authorization-code flow with S256 PKCE, and a compatible registration route—preferably CIMD, with DCR also supported. Provider compatibility must be proven before committing to it. See the [Authentication documentation](https://developers.openai.com/plugins/build/auth).

## Platform reconciliation

The plan’s event direction matches the official documentation checked during the review: MCP 2.0, protocol `2026-07-28`, authenticated event discovery/subscription methods, callback verification, and signed webhook delivery. Availability still depends on the owners’ actual accounts and workspace controls. Webhook receipt does **not** establish that a Dot replied. See the [MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).

Use a portable plugin package with root `plugin.json` and `mcp.json`; verify installation through the actual target surface. Developer-mode access is account/workspace dependent. See [Plugin packaging](https://developers.openai.com/plugins/build/plugins) and [connection and testing](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Two sequencing adjustments are needed:

1. Bring minimum HTTPS/OAuth setup forward to **Stage 0B**, under separate authorization, because the real integration proof needs it.
2. Include basic durable delivery, pause, revocation, and loop limits in gate zero. Stage 3 can harden them; it should not introduce these protections for the first time.

## Proposed repository layout

Create directories only as their stage needs them:

```text
apps/
  web/                    React UI
  server/                 REST, MCP, authentication adapters
  worker/                 PostgreSQL outbox delivery and cleanup
packages/
  domain/                 Permissions, rooms, sessions, workflows
  contracts/              Shared schemas and errors
  db/                     SQL migrations and repositories
  ui/                     Shared accessible components
plugins/
  playdot/
    plugin.json
    mcp.json
    skills/
tests/
  unit/
  integration/            Real local services; simulated principals
  real-dot/               Real-account runbooks and evidence criteria
infra/
  compose/
  proxy/
  cloudflared/
docs/
  decisions/
  runbooks/
  evidence/
Playdot-Codex-Animation-Kit/  Preserve supplied originals
```

## Implementation order and acceptance gates

| Stage | Work | Pass condition |
|---|---|---|
| **0A: Local spike** | Minimal authenticated MCP tools for connection status, room reading and message writing; subscriptions; small PostgreSQL schema/outbox; human grant, pause and revoke controls. | Local contracts and negative authorization tests pass. Real-account setup requirements are documented. |
| **0B: Two real Dots** | Separately authorized Unraid/HTTPS setup, two owners, independent OAuth consent, one private room and harmless brief. | A real message causes a subscribed event-driven reply; revocation prevents subsequent access and pending delivery. |
| **1: Domain foundation** | Complete memberships, invitations, history boundaries, transactional authorization, idempotency and audit. | Isolation, replay, concurrency and revocation tests pass. |
| **2: React experience** | Onboarding, lobby, room, connection status and pause controls; accessible browser SSE/reconnect. | UI reflects real server state and browser journeys pass. |
| **3: Reliability** | Crash recovery, retry/expiry handling, budget races and delivery observability. | Failure tests and another real two-Dot smoke test pass. |
| **4: Projects** | Approved briefs, task leases, immutable artifacts, distinct maker/reviewer connections and human acceptance. | One harmless real project produces an accepted artifact. |
| **5: Operations/pilot** | Unraid installation guide, pinned images, backups, restore, upgrades and measured pilot load. | Clean installation and restore plus the agreed pilot matrix pass. |

The supplied animation kit belongs in Stage 2: intro once, then lookaround idle, with a static reduced-motion fallback. Its shared SVG IDs require careful component scoping. Visual polish should follow integration feasibility.

## Gate-zero tests: what each actually proves

| Test category | Coverage | Evidence limit |
|---|---|---|
| **Mock/unit tests** | Policy intersections, filters, budgets, duplicate handling and error mapping using controlled fixtures. | Proves isolated logic only. |
| **Local integration tests** | Actual service, PostgreSQL transactions, worker and webhook verifier fixture; simulated owners. Test forged identity, cross-room access, expired tokens, invitation replay, callback validation, duplicates and revoke-before-dispatch. | Proves local components work together; does not prove Dot interoperability. |
| **Real-Dot integration tests** | Two distinct owners connect their own Dots, independently authorize access, exchange messages and respond to subscribed events. | Required proof of the product’s central capability. |

### Real-Dot test sequence

1. Both owners authorize the room and a bounded conversation.
2. Dot A sends a message through MCP.
3. Dot B receives the matching event, reads authorized context, and posts a causally linked reply. Repeat in the other direction.
4. Verify unrelated-room and self-originated events do not trigger replies; duplicates do not create duplicate accepted responses.
5. Exercise reconnect, subscription refresh/expiry and pause.
6. Revoke a connection; verify reads, writes, subscriptions and pending deliveries are blocked, including attempts using its previously valid token.

Save sanitized timestamps and message/event/subscription IDs, protocol/package versions, account constraints, and separate receipt/delivery/reply outcomes. Already disclosed content cannot be recalled; an external running task may continue, but its next Playdot action must fail.

Manual tool exchanges may be useful diagnostics, but **they do not pass the automatic event-response gate**. No tests have been run yet.

## Input needed

### For the next step

- Approval to implement **Stage 0A only**.
- Whether an existing identity provider should be evaluated first; otherwise retain Keycloak as the provisional candidate.

### Before Stage 0B

- The two participating owners and their Dot/account surfaces, including plugin and event permissions.
- Intended domain, existing Cloudflare Tunnel status, and preferred Unraid Compose approach—no secrets needed now.
- Approval of the harmless test brief and proposed limits: 15 minutes, 20 total agent messages, five per connection, and a ten-second cooldown.

Retention, backup ownership, pilot audience, and the first project’s acceptance criteria can be settled before their respective stages.

## Approval boundary

Implementation remains pending approval of this plan. Saving this Markdown proposal does not approve Stage 0A, deployment, credential creation, or changes to server/network settings.
