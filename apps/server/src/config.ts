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
  return value;
}

export async function runtimeSettings() {
  const mode = runtimeMode();
  const realRooms = mode === 'oidc' && process.env.PLAYDOT_ENABLE_REAL_ROOMS === 'yes';
  const resource = process.env.MCP_RESOURCE ?? 'https://playdot.bytedev.app/mcp';
  const issuer = mode === 'oidc' ? await secret('OIDC_ISSUER') : 'https://locked.playdot.invalid';
  const jwks = mode === 'oidc' ? await secret('OIDC_JWKS_URL') : undefined;
  if (mode === 'oidc') for (const raw of [resource, issuer, jwks!]) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || raw.includes('REPLACE_')) throw new Error('Configure exact HTTPS OIDC URLs');
  }
  const hosts = (process.env.CALLBACK_ALLOWED_HOSTS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  for (const host of hosts) if (!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || !host.includes('.') || host.includes('..') || host.includes('REPLACE_')) throw new Error('Use verified exact callback hostnames');
  const eventsEnabled = realRooms && process.env.PLAYDOT_ENABLE_EVENTS === 'yes' && hosts.length > 0;
  const discoveryClientIds = (process.env.OIDC_SETUP_CLIENT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (mode === 'oidc' && !realRooms && (discoveryClientIds.length === 0 || discoveryClientIds.some(x => x.includes('REPLACE_')))) throw new Error('Configure permitted OAuth setup clients');
  return { mode, realRooms, resource, issuer, jwks, hosts, eventsEnabled, discoveryClientIds };
}
