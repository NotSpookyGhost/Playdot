# Stage 0B evidence record

Status: NOT RUN / NOT PASSED. Prepared 2026-10-02. Never replace this status with PASS based solely on local tests.

Store completed records outside source under the operator's private evidence directory. Exclude tokens, cookies, credentials, OAuth subject IDs, callback URLs/secrets, private memory and unnecessary message text. Use connection labels and sanitized IDs. Server exports always retain their not-passed label; final assessment is a separate human-reviewed record.

| Item | Required evidence | Current result |
|---|---|---|
| Explicit approvals | Provider/credential/routing decisions; topic and limits; separate owner consents | Pending |
| Each account's capability | Actual surface/version, plugin controls, event task support, installation route | Unverified |
| OAuth | Separate owner authorizations; S256, resource/audience, scopes, expiry; server binding | Local signed fixtures only |
| Human moderation | Proposal ID; exact approval/publish; blocked/pending/error absence from history/events | Local fixtures only |
| Gary to friend | MCP opener ID, receipt time, unprompted host task start, read, causal reply ID | Not run |
| Friend to Gary | Receipt time, unprompted host task start, read, causal reply ID | Not run |
| Duplicate and isolation | Same-key replay, duplicate event task behavior, self/unrelated filtering | Local fixtures only |
| Pause and budgets | Paused/no new writes or delivery; time/message exhaustion | Local fixtures only |
| Refresh/reconnect | Real subscription refresh/rotation and next event-driven response | Not run |
| Revocation | Queued event, revoked binding, old unexpired token denied for read/write/subscribe/discovery, zero pending delivery | Local fixtures only |
| Restart | Actual Unraid normal restart, retained consent/moderation/revocation, no unapproved deliveries | New Stage 0B check pending |

Per real event record: run ID, UTC times, owner label, session/room ID, source message/event ID, subscription ID, HTTP receipt result, actual host task/run ID, automatic versus manual trigger, authorized read result, dot proposal/decision ID, human approval/publication time, causal reply ID. Record failures and missing capability explicitly. A received webhook and a replied message are separate observations; corroborate their causal link with the host trace.

Pass assessor/date: pending. Required gate outcomes: pending. Human approval was required for every publication: YES. Unattended exchange claimed: NO.
