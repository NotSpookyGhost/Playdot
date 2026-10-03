import { readFile } from 'node:fs/promises';
import { postgresStore } from '../packages/db/src/store.js';
import { databaseConfig } from '../apps/server/src/config.js';
import { applyIssuerMigration, rollbackIssuerMigration } from '../packages/domain/src/issuer-migration.js';
try {
  const [action, file, backup] = process.argv.slice(2);
  if (!['check','apply','rollback'].includes(action ?? '') || !file) throw new Error('Invalid command');
  const input = JSON.parse(await readFile(file, 'utf8'));
  const store = await postgresStore(await databaseConfig());
  try {
    console.log(action === 'rollback' ? await rollbackIssuerMigration(store,input) : await applyIssuerMigration(store,input,backup,action === 'check'));
  } finally { await store.close(); }
} catch { console.error('Issuer migration refused or failed. Verify file paths, unchanged owner bindings, backup permissions and stored hash. No reset attempted.'); process.exitCode = 1; }
