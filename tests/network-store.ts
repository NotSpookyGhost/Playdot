import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { databaseConfig } from '../apps/server/src/config.js';
import { postgresStore } from '../packages/db/src/store.js';

export async function verificationConfig(): Promise<PoolConfig> {
  if (process.env.PLAYDOT_VERIFY_ONLY !== 'yes' || process.env.PGDATABASE !== 'playdot_verify' || process.env.DATABASE_URL || !['test-db', '127.0.0.1'].includes(process.env.PGHOST ?? '')) {
    throw new Error('Verification requires an isolated playdot_verify database on test-db/127.0.0.1, PG* settings and PLAYDOT_VERIFY_ONLY=yes');
  }
  return databaseConfig();
}
export async function isolatedConfig(existingSchema?: string): Promise<{ config: PoolConfig; schema: string }> {
  const base = await verificationConfig();
  const schema = existingSchema ?? `verify_${randomUUID().replaceAll('-', '')}`;
  if (!/^verify_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid verification schema');
  const pool = new Pool({ ...base, connectionTimeoutMillis: 5000 });
  try {
    if (existingSchema) {
      const result = await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema]);
      if (!result.rowCount) throw new Error('Recorded verification schema is missing');
    } else {
      await pool.query(`CREATE SCHEMA "${schema}"`);
    }
  } finally { await pool.end(); }
  // No public fallback; every run gets new state, with NO resets or DROP commands.
  return { config: { ...base, options: `-c search_path=${schema}` }, schema };
}
export async function networkStore() {
  const { config } = await isolatedConfig();
  return postgresStore(config);
}
