# Identity-provider compatibility check

Checked 2 October 2026. Documentation review only: no provider was installed, configured or connected.

## Decision

Keep the resource-server adapter provider-neutral. **Keycloak 26.8.0 is now the prepared candidate because no existing provider was reported; live compatibility remains a gate.** Use established OAuth/OIDC infrastructure for authorization and `jose` for access-token verification; do not implement an authorization server in Playdot.

## Findings

OpenAI documents authorization-code flow with S256 PKCE, protected-resource and authorization-server metadata, resource/audience binding, and supported client registration. CIMD is preferred where compatible; DCR and predefined clients are documented alternatives. The actual management surface supplies the applicable client/redirect details. [OpenAI authentication](https://developers.openai.com/plugins/build/auth)

Keycloak documents MCP authorization, DCR, CIMD and resource-indicator configuration. However, its ChatGPT section explicitly reports an incompatibility with ChatGPT's plural token-authentication-method metadata and describes a custom executor workaround. [Keycloak MCP authorization](https://www.keycloak.org/securing-apps/mcp-authz-server)

OpenAI's current guide also describes a transitional singular compatibility field, so the two guides do not conclusively establish the behavior of any particular deployed combination. This is a documentation conflict, not evidence that a live flow succeeds or fails.

## Recommended later proof

1. Record the selected provider/version and actual discovery metadata.
2. Confirm S256, issuer, resource/audience binding, scopes and accepted token endpoint authentication method.
3. Obtain the actual client registration choice and exact redirect URI from the authorized host interface; do not guess them.
4. Try an established supported route, with DCR or a predefined client as candidates if CIMD remains incompatible. Keep any required registration credentials subject to separate approval.
5. Prove consent and token validation for both owners and reject wrong audience, expired tokens and unknown client bindings.
6. Accept Keycloak for the real pilot only after this succeeds. A custom Keycloak policy executor is outside the minimal spike and should not be assumed necessary or authorized.

The spike accepts configured RS256 JWT access tokens with issuer, audience, subject, expiry, issuance time, scope and an unambiguous `azp` or `client_id`. An established provider issuing opaque tokens or another signing algorithm requires a separately reviewed verification adapter; the spike does not silently weaken checks.

## Other official references checked

- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)
- [PGlite documentation](https://pglite.dev/docs/)

Stage 0B preparation is now authorized. Optional templates use pre-registered public PKCE clients and experimental resource indicators, with no CIMD customization. Both accounts must support that registration route. See [setup and approval gates](stage-0b-setup.md).
