import { postgresStore } from '../../../packages/db/src/store.js';
import { Playdot } from '../../../packages/domain/src/service.js';
import { buildApp } from './app.js';
import { remoteAuthenticator } from './auth.js';
import { callbacks, safePost, secretBox } from './callback.js';

function required(name: string) { const value = process.env[name]; if (!value || value.includes('<')) throw new Error(`Configure ${name} before starting; Stage 0A does not provision credentials`); return value; }
// No fallback credentials, fixture authentication, auto-enrollment, or control routes.
const issuer = required('OIDC_ISSUER');
const resource = required('MCP_RESOURCE');
const jwks = required('OIDC_JWKS_URL');
const authenticate = remoteAuthenticator(issuer, resource, jwks);
const secrets = secretBox(Buffer.from(required('SUBSCRIPTION_KEY_BASE64'), 'base64'));
const hosts = required('CALLBACK_ALLOWED_HOSTS').split(',').map(x => x.trim());
const store = await postgresStore(required('DATABASE_URL'));
// Default moderation is local human review of EVERY message. There is no runtime
// mock-allow switch or external moderation adapter. Stage 0B needs a tested real
// provider or an authenticated human review/control flow before exchanges proceed.
const service = new Playdot(store, callbacks(safePost(hosts)), secrets);
const app = buildApp({ service, authenticate, resource, issuer });
// Unraid ingress/containers are a later authorized setup; never bind publicly here.
await app.listen({ host: '127.0.0.1', port: 3000 });
let stopping = false;
const worker = (async () => {
  while (!stopping) { try { await service.dispatchOne(); } catch { console.error('Outbox iteration failed'); } await new Promise(resolve => setTimeout(resolve, 500)); }
})();
async function stop() { stopping = true; await app.close(); await worker; await store.close(); }
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
