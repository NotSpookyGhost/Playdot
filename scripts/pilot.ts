import { readFile } from 'node:fs/promises';
import { postgresStore } from '../packages/db/src/store.js';
import { Playdot } from '../packages/domain/src/service.js';
import { Pilot, pilotSchema } from '../packages/domain/src/pilot.js';
import { databaseConfig, secret } from '../apps/server/src/config.js';
import { secretBox } from '../apps/server/src/callback.js';
try {
  if (process.argv[2] !== 'init' || process.env.PLAYDOT_APPROVED_SETUP !== 'yes') throw new Error('Explicit approved setup required');
  const config = pilotSchema.parse(JSON.parse(await readFile(await secret('PLAYDOT_PILOT_CONFIG_FILE'), 'utf8')));
  const secrets = secretBox(Buffer.from(await secret('SUBSCRIPTION_KEY_BASE64'), 'base64'));
  const store = await postgresStore(await databaseConfig());
  try {
    const service = new Playdot(store, { verify: async () => { throw new Error('No callbacks in setup'); }, send: async () => { throw new Error('No callbacks in setup'); } }, secrets);
    await new Pilot(store, config, secrets, service).initialize();
    console.log('Pilot initialized without enabling connections. Both owners must log in and independently consent. Existing state preserved.');
  } finally { await store.close(); }
} catch { console.error('Pilot setup failed: verify explicit approval, configuration, keys and collision-free IDs. No reset attempted.'); process.exitCode = 1; }
