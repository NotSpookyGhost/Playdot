import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { emptyState, type State, type Store } from '../../domain/src/model.js';

export interface Sql { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }
export interface Driver { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> }
export async function createStore(driver: Driver): Promise<Store> {
  const migration = await readFile(new URL('../migrations/001_spike.sql', import.meta.url), 'utf8');
  await driver.transaction(async sql => {
    await sql.query(migration);
    await sql.query('INSERT INTO playdot_spike_state VALUES (1, 1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(emptyState())]);
  });
  return {
    transact: fn => driver.transaction(async sql => {
      const { rows } = await sql.query<{ data: State }>('SELECT data FROM playdot_spike_state WHERE id = 1 FOR UPDATE');
      if (!rows[0]) throw new Error('Missing spike state');
      const state = rows[0].data;
      // Backward-compatible addition. Legacy messages have no approval proof and
      // are withheld by the domain read/dispatch gate, never grandfathered in.
      state.moderation ??= [];
      const result = await fn(state);
      await sql.query('UPDATE playdot_spike_state SET data = $1::jsonb WHERE id = 1', [JSON.stringify(state)]);
      return result;
    }),
    close: () => driver.close()
  };
}
export async function postgresStore(connectionString: string): Promise<Store> {
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  return createStore({
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async <T>(sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params); return { rows: result.rows as T[] };
        } });
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end()
  });
}
