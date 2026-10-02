import { PGlite } from '@electric-sql/pglite';
import { it } from 'vitest';
import { createStore } from '../packages/db/src/store.js';
import { prepareRestart, verifyRestart } from './restart-scenario.js';

it('restart proof reopens embedded PostgreSQL and rechecks publication and authorization boundaries', async () => {
  const db = new PGlite();
  const store = await createStore({ transaction: fn => db.transaction(sql => fn(sql)), close: () => db.close() });
  const now = Date.now(); let archive: Blob;
  try { await prepareRestart(store, now); archive = await db.dumpDataDir(); } finally { await store.close(); }
  const reopenedDb = new PGlite({ loadDataDir: archive });
  const reopened = await createStore({ transaction: fn => reopenedDb.transaction(sql => fn(sql)), close: () => reopenedDb.close() });
  try { await verifyRestart(reopened, now); } finally { await reopened.close(); }
});
