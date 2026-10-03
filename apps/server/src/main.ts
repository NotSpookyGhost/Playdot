import { Pool } from 'pg';
import { postgresStore } from '../../../packages/db/src/store.js';
import { databaseConfig } from './config.js';
import { createRuntime } from './runtime.js';

async function main() {
  const config = await databaseConfig();
  const store = await postgresStore(config); // Idempotent schema check; never reset.
  const readiness = new Pool({ ...config, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  const { app, service, settings } = await createRuntime(store, async () => {
    const result = await readiness.query('SELECT schema_version FROM playdot_spike_state WHERE id = 1');
    if (result.rows[0]?.schema_version !== 1) throw new Error('Migration not ready');
  });
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: 3000 });
  console.log(JSON.stringify({ mode: settings.mode, real_rooms_enabled: settings.realRooms, worker_enabled: settings.eventsEnabled }));
  let stopping = false;
  const worker = settings.eventsEnabled ? (async () => {
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
