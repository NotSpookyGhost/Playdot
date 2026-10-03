import { readFile } from 'node:fs/promises';
import { Pilot, pilotSchema } from '../../../packages/domain/src/pilot.js';
import { ownerLogin } from './owner.js';
import { Pool } from 'pg';
import { postgresStore } from '../../../packages/db/src/store.js';
import { Playdot } from '../../../packages/domain/src/service.js';
import { Fault } from '../../../packages/domain/src/model.js';
import { buildApp } from './app.js';
import { remoteAuthenticator } from './auth.js';
import { callbacks, safePost, secretBox } from './callback.js';
import { databaseConfig, runtimeMode, secret } from './config.js';

async function main() {
  const mode = runtimeMode();
  const resource = process.env.MCP_RESOURCE ?? 'https://playdot.bytedev.app/mcp';
  const issuer = mode === 'oidc' ? await secret('OIDC_ISSUER') : 'https://locked.playdot.invalid';
  const authenticate = mode === 'oidc'
    ? remoteAuthenticator(issuer, resource, await secret('OIDC_JWKS_URL'))
    : async () => { throw new Fault('UNAUTHORIZED', 401); };
  // No mock identity, keys, fixture seeding or outbound worker in locked mode.
  const secrets = mode === 'oidc' ? secretBox(Buffer.from(await secret('SUBSCRIPTION_KEY_BASE64'), 'base64'))
    : { seal(): never { throw new Error('Locked'); }, open(): never { throw new Error('Locked'); } };
  const hosts = mode === 'oidc' ? (await secret('CALLBACK_ALLOWED_HOSTS')).split(',').map(x => x.trim()) : [];
  const config = await databaseConfig();
  const store = await postgresStore(config); // Existing idempotent migration, no reset.
  const readiness = new Pool({ ...config, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  const service = new Playdot(store, callbacks(safePost(hosts)), secrets);
  const owner = mode === 'oidc' ? await (async () => {
    const pilotConfig = pilotSchema.parse(JSON.parse(await readFile(await secret('PLAYDOT_PILOT_CONFIG_FILE'), 'utf8')));
    if (pilotConfig.issuer !== issuer) throw new Error('Pilot issuer mismatch');
    const pilot = new Pilot(store, pilotConfig, secrets, service);
    await store.transact(s => { if (s.pilot?.configHash !== pilot.configHash) throw new Error('Initialize the approved pilot first'); });
    return { pilot, origin: new URL(resource).origin, login: await ownerLogin(issuer, pilotConfig.ownerClientId, new URL(resource).origin) };
  })() : undefined;
  const app = buildApp({ service, authenticate, resource, issuer, mode, owner, ready: async () => {
    const result = await readiness.query('SELECT schema_version FROM playdot_spike_state WHERE id = 1');
    if (result.rows[0]?.schema_version !== 1) throw new Error('Migration not ready');
  } });
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: 3000 });
  console.log(JSON.stringify({ stage: owner ? '0B-prepared' : '0A', mode, real_rooms_enabled: mode === 'oidc', worker_enabled: mode === 'oidc' }));
  let stopping = false;
  const worker = mode === 'oidc' ? (async () => {
    while (!stopping) { try { await service.dispatchOne(); } catch { console.error('Outbox iteration failed'); } await new Promise(resolve => setTimeout(resolve, 500)); }
  })() : Promise.resolve();
  async function stop() {
    if (stopping) return;
    stopping = true; await app.close(); await worker; await readiness.end(); await store.close();
  }
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
main().catch(() => { console.error('Playdot startup failed. Check mode, secret files, database readiness and configuration.'); process.exit(1); });
