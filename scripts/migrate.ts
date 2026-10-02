import { postgresStore } from '../packages/db/src/store.js';
import { databaseConfig } from '../apps/server/src/config.js';
try {
  const store = await postgresStore(await databaseConfig());
  await store.close();
  console.log('Migration 001 ready; existing state preserved.');
} catch { console.error('Migration failed; check database access and schema compatibility. No reset was attempted.'); process.exitCode = 1; }
