import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { createStore } from '../packages/db/src/store.js';
import { localControls } from '../scripts/local-controls.js';

it('embedded PostgreSQL dump/reopen retains revocation, suspension, block counters, moderation decisions and cancelled delivery', async () => {
  const first = new PGlite();
  const store = await createStore({ transaction: fn => first.transaction(sql => fn(sql)), close: () => first.close() });
  let archive: Blob;
  try {
    const controls = localControls(store, Date.now); await controls.seed();
    await store.transact(s => {
      s.subscriptions.push({ id: 's', connectionId: 'dot-b', roomId: 'shared', secret: 'opaque-test-ciphertext', url: 'https://receiver.invalid', active: true, expiresAt: Date.now() + 60000, tokenExpiresAt: Date.now() + 60000 });
      s.outbox.push({ id: 'o', subscriptionId: 's', eventId: 'e', attempts: 0, nextAt: Date.now(), state: 'queued' });
      s.connections[0]!.suspended = true; s.connections[0]!.blockCount = 3;
      s.moderation.push({ id: 'blocked-decision', connectionId: 'dot-a', roomId: 'shared', key: 'blocked-key', hash: 'fixture-hash', contextHash: 'fixture-context', policyVersion: 'stage-0a-moderation-v1', source: 'mock', outcome: 'block', createdAt: Date.now(), expiresAt: Date.now() + 60000 });
    });
    await controls.revoke('dot-b');
    archive = await first.dumpDataDir();
  } finally { await store.close(); }
  const second = new PGlite({ loadDataDir: archive });
  const reopened = await createStore({ transaction: fn => second.transaction(sql => fn(sql)), close: () => second.close() });
  try {
    await reopened.transact(s => {
      expect(s.connections.find(c => c.id === 'dot-b')!.active).toBe(false);
      expect(s.subscriptions[0]!.active).toBe(false);
      expect(s.outbox[0]!.state).toBe('cancelled');
      expect(s.connections[0]).toMatchObject({ suspended: true, blockCount: 3 });
      expect(s.moderation[0]).toMatchObject({ id: 'blocked-decision', outcome: 'block', source: 'mock' });
      expect(s.audit.at(-1)!.action).toBe('local.revoke');
    });
  } finally { await reopened.close(); }
});
