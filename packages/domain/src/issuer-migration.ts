import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pilotSchema, type PilotConfig } from './pilot.js';
import type { State, Store } from './model.js';
import { pauseForModeration } from './moderation.js';
export const oldIssuer = 'https://auth.playdot.bytedev.app/realms/playdot';
export const newIssuer = 'https://playdot-auth.bytedev.app/realms/playdot';
const configHash = (c: PilotConfig) => createHash('sha256').update(JSON.stringify(pilotSchema.parse(c))).digest('hex');
export function stateDigest(state: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}
export function migrateIssuer(s: State, input: unknown, now = Date.now()) {
  const next = pilotSchema.parse(input);
  if (next.issuer !== newIssuer) throw new Error('Only the approved hostname migration is supported');
  if (!s.pilot) return 'NO_PILOT';
  const prior = { ...next, issuer: oldIssuer };
  if (s.pilot.configHash === configHash(next)) {
    for (const owner of next.owners) {
      const c = s.connections.find(c => c.id === owner.connectionId);
      if (c && (c.issuer !== newIssuer || c.subject !== owner.subject || c.clientId !== owner.mcpClientId || c.ownerId !== owner.id)) throw new Error('Current config has mismatched bindings');
    }
    return 'ALREADY_CURRENT';
  }
  if (s.pilot.configHash !== configHash(prior)) throw new Error('Refuse unrelated config change');
  for (const owner of next.owners) {
    const connection = s.connections.find(c => c.id === owner.connectionId);
    if (connection) {
      if (connection.issuer !== oldIssuer || connection.subject !== owner.subject || connection.clientId !== owner.mcpClientId || connection.ownerId !== owner.id) throw new Error('Owner binding mismatch');
      connection.issuer = newIssuer; // Never reactivates or unsuspends a connection.
    }
  }
  for (const id of [next.roomId, next.privateRoomId]) {
    pauseForModeration(s, id, 'ISSUER_CHANGED_REQUIRES_NEW_CONSENT', now);
    s.subscriptions.filter(sub => sub.roomId === id).forEach(sub => { sub.active = false; });
  }
  s.pilot.configHash = configHash(next); s.pilot.consents = []; s.pilot.deliveryHold = true;
  s.audit.push({ action: 'pilot.issuer_migrated', target: next.roomId, at: now });
  return 'MIGRATED_PAUSED';
}

export async function applyIssuerMigration(store: Store, input: unknown, backup?: string, checkOnly = false) {
  return store.transact(async state => {
    const candidate = structuredClone(state);
    const outcome = migrateIssuer(candidate, input);
    if (checkOnly || outcome !== 'MIGRATED_PAUSED') return outcome;
    if (!backup) throw new Error('A fresh private backup path is required');
    await writeFile(backup, JSON.stringify({version:1,before:state,beforeDigest:stateDigest(state),afterDigest:stateDigest(candidate)}), {flag:'wx',mode:0o600});
    Object.assign(state, candidate); return outcome;
  });
}
export async function rollbackIssuerMigration(store: Store, backup: any) {
  return store.transact(state => {
    if (backup.version !== 1 || stateDigest(state) !== backup.afterDigest || stateDigest(backup.before) !== backup.beforeDigest) throw new Error('State changed; refusing rollback');
    for (const key of Object.keys(state)) delete (state as any)[key];
    Object.assign(state, backup.before); return 'ROLLED_BACK';
  });
}
