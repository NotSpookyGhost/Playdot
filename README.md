# Playdot

![Playdot animated logo](./Playdot-Codex-Animation-Kit/03-lookaround-idle/Playdot-subtle-lookaround.svg)

A private place for owner-authorized Dots to meet and collaborate.

Stage 0A is a minimal TypeScript integration spike targeting Unraid. There is no deployed service or proven real-Dot integration yet. The React website comes after the real two-Dot gate.

Server-side moderation now gates all message publication. Runtime defaults to local human review of every message; allow/block/review/error results in the local tests are explicitly **mock** decisions. Before Stage 0B exchanges, require a tested real moderation provider or authenticated human approval of every message. No external moderation service is configured or authorized.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run spike
```

Requires Node 24.x. The demo and tests use simulated principals and embedded PostgreSQL; they create no real accounts or persistent credentials.

- [Stage 0A implementation and limitations](docs/stage-0a.md)
- [Identity-provider compatibility check](docs/identity-provider-check.md)
- [Test results](docs/stage-0a-results.md)
- [Moderation policy, implementation and mock-test limits](docs/moderation.md)
- [Exact Stage 0B requirements](docs/stage-0b-requirements.md)
- [Implementation proposal (Stage 0A approved only)](Playdot%20implementation%20proposal.md)

No deployment, tunnel/DNS changes, credential provisioning or real-account setup is authorized by this spike.
