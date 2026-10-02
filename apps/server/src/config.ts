import { readFile } from 'node:fs/promises';
import type { PoolConfig } from 'pg';

export async function secret(name: string): Promise<string> {
  const file = process.env[`${name}_FILE`];
  const value = (file ? await readFile(file, 'utf8') : process.env[name])?.trim();
  if (!value || value.includes('<') || value.startsWith('REPLACE_')) throw new Error(`Configure ${name} or ${name}_FILE`);
  return value;
}
export async function databaseConfig(): Promise<PoolConfig> {
  if (process.env.DATABASE_URL) return { connectionString: await secret('DATABASE_URL') };
  return { host: process.env.PGHOST ?? 'db', port: 5432, database: process.env.PGDATABASE ?? 'playdot', user: process.env.PGUSER ?? 'playdot', password: await secret('PGPASSWORD') };
}
export function runtimeMode(value = process.env.PLAYDOT_MODE ?? 'locked'): 'locked' | 'oidc' {
  if (value !== 'locked' && value !== 'oidc') throw new Error('PLAYDOT_MODE must be locked or oidc; mock HTTP authentication is not supported');
  if (value === 'oidc' && process.env.PLAYDOT_ENABLE_REAL_ROOMS !== 'yes') throw new Error('Real rooms require a separately approved Stage 0B setup');
  return value;
}
