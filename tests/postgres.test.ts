import { expect, it } from 'vitest';
import { postgresStore } from '../packages/db/src/store.js';
import { localControls } from '../scripts/local-controls.js';
// Opt-in only: never connect to a database merely because DATABASE_URL is set.
// The caller must supply an isolated disposable database and explicitly permit reset.
const enabled = Boolean(process.env.PLAYDOT_TEST_DATABASE_URL && process.env.PLAYDOT_ALLOW_TEST_RESET === 'yes');
it.skipIf(!enabled)('network PostgreSQL: serialized concurrent transaction and durable reopen', async () => {
  const url = process.env.PLAYDOT_TEST_DATABASE_URL!;
  const store = await postgresStore(url);
  try {
    await localControls(store, Date.now).seed();
    await Promise.all(Array.from({ length: 8 }, () => store.transact(s => { s.rooms[0]!.seq++; })));
  } finally { await store.close(); }
  const reopened = await postgresStore(url);
  try { await reopened.transact(s => { expect(s.rooms[0]!.seq).toBe(8); }); } finally { await reopened.close(); }
});
