import { readFile } from 'node:fs/promises';
import { Playdot } from '../../../packages/domain/src/service.js';
import { Fault, type Store } from '../../../packages/domain/src/model.js';
import { Pilot, pilotSchema } from '../../../packages/domain/src/pilot.js';
import { ownerLogin } from './owner.js';
import { callbacks, safePost, secretBox } from './callback.js';
import { remoteAuthenticator, type Authenticate } from './auth.js';
import { runtimeSettings, secret } from './config.js';
import { buildApp } from './app.js';

// Shared by production startup and local integration tests. No fixture seeding.
export async function createRuntime(store: Store, ready: () => Promise<void>, authenticateOverride?: Authenticate) {
  const settings = await runtimeSettings();
  const { mode, realRooms, resource, issuer, jwks, hosts, eventsEnabled, discoveryClientIds } = settings;
  const authenticate = authenticateOverride ?? (mode === 'oidc' ? remoteAuthenticator(issuer, resource, jwks!) : async () => { throw new Fault('UNAUTHORIZED', 401); });
  const secrets = realRooms ? secretBox(Buffer.from(await secret('SUBSCRIPTION_KEY_BASE64'), 'base64'))
    : { seal(): never { throw new Error('Rooms disabled'); }, open(): never { throw new Error('Rooms disabled'); } };
  const service = new Playdot(store, callbacks(safePost(hosts)), secrets, Date.now, undefined, { roomsEnabled: realRooms, eventsEnabled });
  const owner = realRooms ? await (async () => {
    const pilotConfig = pilotSchema.parse(JSON.parse(await readFile(await secret('PLAYDOT_PILOT_CONFIG_FILE'), 'utf8')));
    if (pilotConfig.issuer !== issuer) throw new Error('Pilot issuer mismatch');
    const pilot = new Pilot(store, pilotConfig, secrets, service);
    await store.transact(s => { if (s.pilot?.configHash !== pilot.configHash) throw new Error('Initialize or explicitly migrate the approved pilot first'); });
    return { pilot, origin: new URL(resource).origin, login: await ownerLogin(issuer, pilotConfig.ownerClientId, new URL(resource).origin) };
  })() : undefined;
  const app = buildApp({ service, authenticate, resource, issuer, mode, owner, realRooms, discoveryClientIds: mode === 'oidc' && !realRooms ? discoveryClientIds : undefined, ready });
  return { app, service, settings };
}
