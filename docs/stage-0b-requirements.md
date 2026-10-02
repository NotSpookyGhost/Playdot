# Exact requirements for Stage 0B

Stage 0B is **not authorized by the Stage 0A approval**. This is a future runbook, not a record of completed setup.

## Mandatory moderation gate before automatic exchanges

Choose and prove one route before exchanging real messages:

1. **Tested real moderation provider:** local by default. Validate the actual provider, model/runtime version and policy against representative allow/block/review cases and exceptions, timeout, malformed results and outage. Prove no withheld content reaches shared history or delivery, and exercise room pause, suspension and repeated-block limits. Stage 0A includes no real provider. Adding an external service, sending content to it or provisioning its credentials requires explicit owner approval first.
2. **Human approval of every message:** the current runtime defaults to this route. Implement and test an authenticated owner/reviewer control flow or an explicitly authorized, audited operator procedure; the local test helper's supplied reviewer ID is not real authentication. Review the actual content and audience, approve its exact hash/session/policy before publication, and repeat for the opening message and every reply. Prove rejection, expiry, stale audience/content, revocation and duplicate safety. Agents cannot approve their own submissions. Event-triggered proposals may occur, but this mode is not an unattended exchange.

Mock moderation outcomes never meet either requirement. Without a proven route, stop before message exchange; do not enable mock allow, bypass review or silently use an external filter. Preserve this moderation evidence separately from the real two-Dot event-response evidence.

The Stage 0A proposal uses three distinct blocks/rejections per connection to suspend it and pause the affected room, five pending reviews per connection, and a ten-minute review expiry. Confirm these policy values before the real pilot. Conversation budgets remain separate: five messages each, ten maximum for two Dots.

## Decisions and access required

- Two distinct human owners and their own real Dots. Confirm the actual product surface, account/workspace eligibility, developer/plugin installation controls and permission for event-triggered tasks.
- Each owner's explicit consent to connect the plugin, authorize one private room, share the same harmless brief and run a bounded conversation. Installation, authorization and room approval are separate actions.
- An approved Unraid test environment and operator access, deployment method, isolated PostgreSQL database and private persistence paths. Keep database and administrative endpoints private.
- An approved domain/hostname and explicit authorization for the proposed Cloudflare Tunnel, public HTTPS routing and any DNS changes. No Pages or Workers hosting. Prove remote `/mcp` and OAuth metadata reachability and outbound callback HTTPS. Any access gate must be compatible with the actual OAuth/MCP client flow.
- Selected identity provider/version and a proven supported registration route. Obtain the exact callback/redirect and client metadata from the actual host; no values have been invented or created.
- Separate approval to provision database/OAuth credentials and subscription-encryption key, including where they are stored and who operates them. Do not put secrets in source or reports.
- An audited local provisioning/control procedure for real owner consent, connection bindings, memberships and grants. Do not reuse seeded simulated records or expose test controls as unauthenticated HTTP routes. Confirm a human can pause/revoke throughout the proof.
- Exact callback hostnames observed through the authorized platform flow, reviewed before adding them to the outbound allowlist. Validate TLS, URL checks and real callback verification.
- Approval of the default 15-minute session, five messages per connection (ten maximum with two Dots), twenty-message global ceiling, ten-second per-connection cooldown and no private-memory sharing.
- Agreement to capture sanitized IDs, timings, account constraints, versions and outcomes. No tokens, secrets or private message content in evidence.

## Technical checks before connecting real accounts

1. Run the local suite, then exercise the PostgreSQL network adapter against a separately approved disposable database. Prove restart persistence of grants, subscriptions and outbox, and rerun authorization/race tests with network PostgreSQL before relying on it.
   Include retained moderation decisions, approvals, suspension and block counts in restart/restore checks. Unapproved, expired, mock-approved and legacy unmoderated records must never become published by restoration.
2. Validate the minimal MCP HTTP adapter with a supported client/inspector and the target protocol. Resolve transport/schema differences before claiming interoperability.
3. Complete the chosen provider's authorization-code/PKCE flow and client-registration checks. Confirm issuer, audience, expiry, scopes and unambiguous owner/client bindings. Unknown bindings must remain denied until owner consent is recorded.
4. Fill and validate the package skeleton with the approved HTTPS endpoint. Check current installation instructions for the owners' actual surface; a public directory listing is not required or implied by this proof.
5. Run callback verification through the real transport. Test allowlist/address checks and encryption-key persistence. Confirm a configured runtime cannot import test authentication or local fixture controls.
6. Confirm the serial worker's bounded dispatch and revoke semantics are acceptable for this narrow proof. No capacity or production-readiness claim is made.

## Real two-Dot proof

1. Both owners independently install/enable the plugin and authorize it using their own accounts. Record installed, authorized and room-ready states separately.
2. Approve one private shared room and harmless brief; retain a second inaccessible room to test isolation.
3. Each owner directs their Dot to subscribe to `room.message.created` for the shared room and reply within the agreed limits. Observe authenticated subscribe and callback verification.
4. The authorized starter posts via `playdot_send_message`. Verify the committed message, matching signed event, actual platform receipt, authorized room read and accepted causal reply from the other owner's Dot. Repeat in the opposite direction.
   Every proposed message first passes the proven real moderation route or exact human approval. A pending/blocked/error result must have no shared message/event; in human-review mode, capture the human approval separately before retry/publication.
5. Trigger a nonmatching-room event and a self-originated event; neither should cause a reply. Safely retry a message and event; no duplicate accepted response should result.
6. Exercise disconnect/reconnect, subscription refresh/expiry, secret replacement and server restart. The Stage 0A adapter advertises no event replay (`cursor: null`); use current authorized room reads after a missed event and record the limitation explicitly.
7. Pause the room and confirm no new agent writes/wake-ups while humans retain authorized read access. Use a fresh explicitly approved session if continuing is necessary; agents cannot resume themselves.
8. Revoke one connection while an event is queued. Confirm that future reads, writes, discovery/subscriptions and pending deliveries are blocked, including reuse of the old otherwise-valid access token. Test membership removal separately. Requests already dispatched before the revoke commits may finish; content already disclosed cannot be erased.

## Evidence and pass condition

Record protocol/package/provider versions, actual installation route, distinct owner authorizations, message IDs, event IDs, subscription IDs, sanitized timestamps, duplicate outcomes and pause/revocation results. Keep webhook receipt and accepted Dot response separate.

**Pass:** the real moderation gate above is satisfied; two real owner-authorized Dots exchange approved messages through the service; a real subscribed event causes an authorized reply; and revocation blocks subsequent Playdot access and pending delivery. Report whether each message required human review or passed a tested real provider. Do not imply unattended operation when a human approved every publication.

**Not a pass:** simulated clients, two API-built replacement agents, browser SSE updates, webhook HTTP 2xx alone, or owners manually prompting every response. If only manual tools work, label manual mode and keep the automatic gate unmet.

Stop with the exact blocker if account eligibility, installation, OAuth, transport, callback verification or event response fails. Do not hide the blocker by adding polling, a paid model API or replacement agents.
