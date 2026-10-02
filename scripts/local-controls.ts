// Local harness only. Never imported by the server entry point or exposed over MCP.
import { randomUUID } from 'node:crypto';
import { hash, type Secrets } from '../packages/domain/src/service.js';
import { emptyState, Fault, type State, type Store } from '../packages/domain/src/model.js';
import { scopes } from '../packages/contracts/src/index.js';
import { BLOCK_LIMIT, MODERATION_POLICY, moderationContext, pauseForModeration, suspendConnection } from '../packages/domain/src/moderation.js';

export const fixtureIssuer = 'https://issuer.playdot.invalid';
export const fixtureResource = 'https://playdot.invalid/mcp';
export const fixtureClient = 'simulated-mcp-client';
export function fixtureState(now: number): State {
  const s = emptyState();
  for (const suffix of ['a', 'b']) s.connections.push({ id: `dot-${suffix}`, ownerId: `owner-${suffix}`, issuer: fixtureIssuer, subject: `subject-${suffix}`, clientId: fixtureClient, active: true, scopes: [...scopes] });
  for (const id of ['shared', 'private-a']) s.rooms.push({ id, ownerId: 'owner-a', brief: 'Harmless local fixture: name a color. These clients are simulated, not Dots.', seq: 0,
    session: { id: `session-${id}`, state: 'active', expiresAt: now + 15 * 60000, totalLimit: 20, perConnectionLimit: 5, cooldownMs: 10000, chainLimit: 20, starter: 'dot-a', total: 0, counts: {}, lastAt: {}, claims: [] } });
  for (const [ownerId, connectionId, roomId] of [['owner-a', 'dot-a', 'shared'], ['owner-b', 'dot-b', 'shared'], ['owner-a', 'dot-a', 'private-a']]) {
    s.memberships.push({ ownerId: ownerId!, roomId: roomId!, active: true, role: 'member', historyFrom: 1 });
    s.grants.push({ connectionId: connectionId!, roomId: roomId!, active: true, scopes: [...scopes] });
  }
  return s;
}
export function localControls(store: Store, now: () => number, secrets?: Secrets) {
  // Reviewer identity here is explicitly supplied by the local harness/operator,
  // not authenticated over HTTP. A real owner control flow is a Stage 0B prerequisite.
  function reviewEntry(s: State, id: string, reviewerId: string) {
    const entry = s.moderation.find(x => x.id === id);
    const room = s.rooms.find(x => x.id === entry?.roomId);
    if (!entry || !room || room.ownerId !== reviewerId || !s.memberships.some(m => m.ownerId === reviewerId && m.roomId === room.id && m.active && m.role === 'member')) throw new Fault('FORBIDDEN');
    return { entry, room };
  }
  return {
    async seed() { await store.transact(s => Object.assign(s, fixtureState(now()))); },
    async suspend(connectionId: string, ownerId: string) { await store.transact(s => {
      if (!s.connections.some(c => c.id === connectionId && c.ownerId === ownerId)) throw new Fault('FORBIDDEN');
      suspendConnection(s, connectionId, now());
    }); },
    async reviewContent(id: string, reviewerId: string) { return store.transact(s => {
      const { entry } = reviewEntry(s, id, reviewerId);
      if (!secrets || !entry.encryptedInput || entry.outcome !== 'human_review' || entry.expiresAt <= now()) throw new Fault('REVIEW_UNAVAILABLE', 409);
      return { id: entry.id, content: JSON.parse(secrets.open(entry.encryptedInput)), expected_hash: entry.hash, context_hash: entry.contextHash, source: entry.source, expires_at: entry.expiresAt };
    }); },
    async decideReview(id: string, reviewerId: string, expectedHash: string, action: 'approve' | 'reject') { await store.transact(s => {
      const { entry, room } = reviewEntry(s, id, reviewerId);
      const c = s.connections.find(x => x.id === entry.connectionId);
      if (!c?.active || c.suspended || room.session.state !== 'active' || room.session.expiresAt <= now()) throw new Fault('REVIEW_UNAVAILABLE', 409);
      if (entry.outcome !== 'human_review' || entry.hash !== expectedHash || entry.contextHash !== moderationContext(s, room.id) || entry.policyVersion !== MODERATION_POLICY || entry.expiresAt <= now()) throw new Fault('MODERATION_APPROVAL_STALE', 409);
      entry.outcome = action === 'approve' ? 'approved' : 'rejected'; entry.reviewedBy = reviewerId;
      delete entry.encryptedInput;
      s.audit.push({ action: `moderation.human.${action}`, target: entry.id, at: now() });
      if (action === 'reject') {
        c.blockCount = (c.blockCount ?? 0) + 1;
        if (c.blockCount >= BLOCK_LIMIT) { suspendConnection(s, c.id, now()); pauseForModeration(s, room.id, 'REPEATED_BLOCKS', now()); }
      }
    }); },
    async pause(roomId: string) { await store.transact(s => { const r = s.rooms.find(x => x.id === roomId); if (!r) throw new Error('Unknown room'); r.session.state = 'paused'; r.session.reason = 'HUMAN_PAUSE'; const ids = s.subscriptions.filter(x => x.roomId === roomId).map(x => x.id); s.outbox.filter(x => ids.includes(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; }); s.audit.push({ action: 'local.pause', target: roomId, at: now() }); }); },
    async revoke(connectionId: string) { await store.transact(s => { const c = s.connections.find(x => x.id === connectionId); if (!c) throw new Error('Unknown connection'); c.active = false; s.grants.filter(x => x.connectionId === connectionId).forEach(x => { x.active = false; }); const ids = s.subscriptions.filter(x => x.connectionId === connectionId).map(x => { x.active = false; return x.id; }); s.outbox.filter(x => ids.includes(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; }); s.audit.push({ action: 'local.revoke', target: connectionId, at: now() }); }); },
    async invite(roomId: string, ttlMs = 60000) { const token = randomUUID(); await store.transact(s => { if (!s.rooms.some(r => r.id === roomId)) throw new Error('Unknown room'); s.invitations.push({ hash: hash(token), roomId, expiresAt: now() + ttlMs, used: false, role: 'member' }); }); return token; },
    async accept(token: string, ownerId: string) { await store.transact(s => { const invite = s.invitations.find(x => x.hash === hash(token)); if (!invite || invite.used || invite.expiresAt <= now()) throw new Fault('INVITATION_UNAVAILABLE', 404); const room = s.rooms.find(x => x.id === invite.roomId)!; if (s.memberships.some(m => m.roomId === room.id && m.ownerId === ownerId && m.active)) throw new Fault('ALREADY_MEMBER', 409); invite.used = true; s.memberships.push({ ownerId, roomId: room.id, active: true, role: invite.role, historyFrom: room.seq + 1 }); /* acceptance intentionally creates no Dot grant */ }); }
  };
}
