# OAuth setup fix: local results

Scope: local repository only. No Unraid connection, deployment, public endpoint request, provider/account change or DNS/tunnel action was performed. The live endpoint descriptions in the guide are user-supplied facts, not agent observations.

- TypeScript check and production compilation: passed.
- Final full regression run: **108 passed, 1 network PostgreSQL test skipped** (109 total).
- Focused OAuth setup/migration/packaging suite: 12 passed, including exclusive backup creation and guarded rollback. The four migration tests also passed again after moving their temporary backup file to the writable OS temp directory used by the read-only test container.
- YAML/JSON and documented Bash syntax: checked locally; Docker Compose runtime validation remains operator-run.
- Docker image build/startup, network PostgreSQL, live Keycloak token flow and public verification commands: not run locally (Docker unavailable; no remote access requested).

Tests assemble the SAME runtime factory used by main.ts against embedded PostgreSQL with ephemeral signed JWT fixtures. Setup starts without pilot/encryption files or callback hosts; both metadata routes advertise the configured real-format issuer/resource; GET/POST without authentication return the discovery challenge; wrong issuer/audience/expiry/client/scope are rejected; valid setup clients discover tools without enrollment; room access and events are blocked; revoked bindings remain blocked. Queued dispatch and callback verification remain off even if old queued state exists. Event activation requires approved room mode, explicit event flag and a valid nonempty hostname list together.

Issuer migration tests cover the narrow same-realm hostname change, unchanged owner/client/grant/history records, preserved revocation/suspension, paused sessions, cleared consent, disabled subscriptions, cancelled delivery, unrelated-config rejection, no reseeding, and key-order-independent rollback fingerprints. Backup/rollback tests exercise exclusive backup creation, dry-run immutability, failure on backup overwrite, rollback rejection after subsequent changes and exact restoration before further writes. These are local fixtures, not a production migration or backup-restore rehearsal.

Real Stage 0B status remains NOT PASSED. No new credentials were generated except ephemeral/public test fixtures. Existing operator secrets and owner data are never replaced by examples. Optional migration is explicitly separate from the normal OAuth-only deployment, which leaves stored pilot data unchanged.
