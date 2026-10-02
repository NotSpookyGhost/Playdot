import { expect, it } from 'vitest';
import { postgresStore } from '../packages/db/src/store.js';
import { localControls } from '../scripts/local-controls.js';
import { isolatedConfig } from './network-store.js';
// Opt-in isolated schema in the verification database. No existing state reset.
const enabled = process.env.PLAYDOT_TEST_NETWORK === 'yes';
it.skipIf(!enabled)('network PostgreSQL: serialized concurrent transaction and durable reopen', async () => {
  const { config } = await isolatedConfig();
  const store = await postgresStore(config);
  try {
    await localControls(store, Date.now).seed();
    await Promise.all(Array.from({ length: 8 }, () => store.transact(s => { s.rooms[0]!.seq++; })));
  } finally { await store.close(); }
  const reopened = await postgresStore(config);
  try { await reopened.transact(s => { expect(s.rooms[0]!.seq).toBe(8); }); } finally { await reopened.close(); }
});
