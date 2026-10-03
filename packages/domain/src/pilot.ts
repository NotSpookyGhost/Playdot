import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopes } from '../../contracts/src/index.js';
import { Fault, type State, type Store } from './model.js';
import { type Playdot, type Secrets } from './service.js';
import { BLOCK_LIMIT, MODERATION_POLICY, moderationContext, pauseForModeration, suspendConnection } from './moderation.js';

const text = z.string().min(1).max(200).refine(s => !s.includes('<') && !s.startsWith('REPLACE_'));
export const pilotSchema = z.strictObject({
  issuer: z.url().startsWith('https://'), ownerClientId: text,
  roomId: text, privateRoomId: text,
  topic: z.literal('Invent a friendly name and one-sentence description for a fictional garden robot. No links, personal data or external actions.'),
  owners: z.array(z.strictObject({ id: text, subject: text, connectionId: text, mcpClientId: text, label: text })).length(2)
}).superRefine((c, ctx) => {
  for (const key of ['id', 'subject', 'connectionId'] as const) if (new Set(c.owners.map(o => o[key])).size !== 2) ctx.addIssue({ code: 'custom', message: 'Owners must have distinct ' + key });
  if (c.roomId === c.privateRoomId || c.owners.some(o => o.mcpClientId === c.ownerClientId)) ctx.addIssue({ code: 'custom', message: 'Separate room and OAuth client identities required' });
});
export type PilotConfig = z.infer<typeof pilotSchema>;
export type Human = { issuer: string; subject: string; clientId: string; expiresAt: number };
export const policy = { durationMs: 15 * 60000, totalLimit: 10, perConnectionLimit: 5, cooldownMs: 10000, chainLimit: 10 };
export class Pilot {
  readonly config: PilotConfig;
  readonly configHash: string;
  constructor(readonly store: Store, config: PilotConfig, private secrets: Secrets, private service: Playdot, private now = Date.now) {
    this.config = pilotSchema.parse(config);
    this.configHash = createHash('sha256').update(JSON.stringify(this.config)).digest('hex');
  }
  owner(h: Human) {
    const o = this.config.owners.find(o => o.subject === h.subject);
    if (!o || h.issuer !== this.config.issuer || h.clientId !== this.config.ownerClientId || h.expiresAt <= this.now()) throw new Fault('HUMAN_AUTH_REQUIRED', 401);
    return o;
  }
  private ready(s: State) {
    if (s.pilot?.configHash !== this.configHash) throw new Fault('PILOT_CONFIGURATION_MISMATCH', 409);
    return s.pilot;
  }
  async initialize() {
    await this.store.transact(s => {
      if (s.pilot) { this.ready(s); return; }
      if (s.rooms.some(r => [this.config.roomId, this.config.privateRoomId].includes(r.id)) || s.connections.some(c => this.config.owners.some(o => o.connectionId === c.id || (c.issuer === this.config.issuer && c.subject === o.subject && c.clientId === o.mcpClientId)))) throw new Fault('PILOT_COLLISION', 409);
      for (const id of [this.config.roomId, this.config.privateRoomId]) s.rooms.push({ id, ownerId: this.config.owners[0]!.id, brief: this.config.topic, seq: 0, stage0b: true, session: this.session() });
      s.pilot = { configHash: this.configHash, roomId: this.config.roomId, consents: [] };
      s.audit.push({ action: 'pilot.initialized', target: this.config.roomId, at: this.now() });
    });
  }
  private session() {
    return { id: randomUUID(), state: 'paused' as const, reason: 'AWAITING_BOTH_OWNERS', expiresAt: this.now(), ...policy, starter: this.config.owners[0]!.connectionId, total: 0, counts: {}, lastAt: {}, claims: [] };
  }
  async consent(h: Human, configHash: string, sessionId: string) {
    const o = this.owner(h);
    await this.store.transact(s => {
      this.owner(h);
      const pilot = this.ready(s);
      if (configHash !== this.configHash || s.rooms.find(r => r.id === pilot.roomId)?.session.id !== sessionId) throw new Fault('CONSENT_STALE', 409);
      const old = s.connections.find(c => c.id === o.connectionId);
      if (old && (!old.active || old.suspended)) throw new Fault('CONNECTION_REVOKED_OR_SUSPENDED');
      if (!old) s.connections.push({ id: o.connectionId, ownerId: o.id, issuer: this.config.issuer, subject: o.subject, clientId: o.mcpClientId, active: true, scopes: [...scopes] });
      for (const id of o.id === this.config.owners[0]!.id ? [this.config.roomId, this.config.privateRoomId] : [this.config.roomId]) {
        const room = s.rooms.find(r => r.id === id)!;
        if (!s.memberships.some(m => m.roomId === id && m.ownerId === o.id)) s.memberships.push({ roomId: id, ownerId: o.id, role: 'member', active: true, historyFrom: room.seq + 1 });
        if (!s.grants.some(g => g.roomId === id && g.connectionId === o.connectionId)) s.grants.push({ roomId: id, connectionId: o.connectionId, active: true, scopes: [...scopes] });
      }
      if (!pilot.consents.includes(o.id)) {
        pilot.consents.push(o.id); s.audit.push({ action: 'pilot.owner_consented', target: o.connectionId, at: this.now() });
      }
      if (pilot.consents.length === 2) for (const room of s.rooms.filter(r => [this.config.roomId, this.config.privateRoomId].includes(r.id))) {
        if (room.session.reason === 'AWAITING_BOTH_OWNERS') { room.session.state = 'active'; delete room.session.reason; room.session.expiresAt = this.now() + policy.durationMs; }
      }
    });
  }
  async pause(h: Human) {
    this.owner(h);
    await this.store.transact(s => { this.ready(s); for (const id of [this.config.roomId, this.config.privateRoomId]) pauseForModeration(s, id, 'HUMAN_PAUSE', this.now()); });
  }
  async newSession(h: Human) {
    this.owner(h);
    await this.store.transact(s => {
      const p = this.ready(s);
      if (s.rooms.find(r => r.id === p.roomId)!.session.state !== 'paused') throw new Fault('PAUSE_FIRST', 409);
      if (this.config.owners.some(o => !s.connections.some(c => c.id === o.connectionId && c.active && !c.suspended))) throw new Fault('CONNECTION_REVOKED_OR_SUSPENDED');
      for (const id of [this.config.roomId, this.config.privateRoomId]) {
        pauseForModeration(s, id, 'NEW_SESSION', this.now()); s.rooms.find(r => r.id === id)!.session = this.session();
        s.subscriptions.filter(x => x.roomId === id).forEach(x => { x.active = false; });
      }
      p.consents = []; s.audit.push({ action: 'pilot.new_session', target: p.roomId, at: this.now() });
    });
  }
  async deliveryHold(h: Human, hold: boolean) {
    this.owner(h);
    await this.store.transact(s => { this.ready(s).deliveryHold = hold; s.audit.push({action: hold ? 'pilot.delivery_held' : 'pilot.delivery_released',target:this.config.roomId,at:this.now()}); });
  }
  async revoke(h: Human) {
    const o = this.owner(h);
    await this.store.transact(s => {
      this.ready(s); const c = s.connections.find(c => c.id === o.connectionId);
      if (!c) throw new Fault('NOT_FOUND', 404);
      c.active = false; s.grants.filter(g => g.connectionId === c.id).forEach(g => { g.active = false; });
      const ids = s.subscriptions.filter(x => x.connectionId === c.id).map(x => { x.active = false; return x.id; });
      s.outbox.filter(x => ids.includes(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; });
      s.audit.push({ action: 'pilot.owner_revoked', target: c.id, at: this.now() });
    });
  }
  async dashboard(h: Human) {
    const o = this.owner(h);
    return this.store.transact(s => {
      const pilot = this.ready(s);
      return { owner: o.label, configHash: this.configHash, topic: this.config.topic, policy, audience: this.config.owners.map(o => o.label), consents: pilot.consents.length, deliveryHold: pilot.deliveryHold === true,
        room: s.rooms.find(r => r.id === this.config.roomId),
        context: s.messages.filter(m => m.room_id === this.config.roomId && m.moderation?.source === 'human' && m.moderation.approved && s.memberships.some(member => member.ownerId === o.id && member.roomId === m.room_id && member.active && m.room_seq >= member.historyFrom)).slice(-10).map(m => ({author:m.author_connection_id,body:m.body,id:m.id})),
        reviews: s.moderation.filter(d => d.reviewerOwnerId === o.id && d.encryptedInput && ['human_review', 'approved'].includes(d.outcome) && d.expiresAt > this.now()).map(d => ({ id: d.id, hash: d.hash, contextHash: d.contextHash, outcome: d.outcome, expiresAt: d.expiresAt, audience: s.memberships.filter(m => m.roomId === d.roomId && m.active && s.connections.some(c => c.ownerId === m.ownerId && c.active && !c.suspended && s.grants.some(g => g.connectionId === c.id && g.roomId === d.roomId && g.active && g.scopes.includes('room:read')))).map(m => this.config.owners.find(owner => owner.id === m.ownerId)?.label ?? m.ownerId), request: JSON.parse(this.secrets.open(d.encryptedInput!)) })) };
    });
  }
  async decide(h: Human, id: string, hash: string, contextHash: string, action: 'approve' | 'reject') {
    const o = this.owner(h);
    await this.store.transact(s => {
      this.owner(h); // Recheck after waiting for the state lock.
      this.ready(s); const d = s.moderation.find(d => d.id === id && d.reviewerOwnerId === o.id && d.source === 'human-only');
      if (!d) throw new Fault('NOT_FOUND', 404);
      const c = s.connections.find(c => c.id === d.connectionId)!; const room = s.rooms.find(r => r.id === d.roomId)!;
      if (!c.active || c.suspended || room.session.state !== 'active' || room.session.expiresAt <= this.now()) throw new Fault('REVIEW_UNAVAILABLE', 409);
      if (d.outcome !== 'human_review' || !d.encryptedInput || d.hash !== hash || d.contextHash !== contextHash || d.contextHash !== moderationContext(s, room.id) || d.policyVersion !== MODERATION_POLICY || d.expiresAt <= this.now()) throw new Fault('MODERATION_APPROVAL_STALE', 409);
      d.outcome = action === 'approve' ? 'approved' : 'rejected'; d.reviewedBy = o.id;
      if (action === 'reject') {
        delete d.encryptedInput; c.blockCount = (c.blockCount ?? 0) + 1;
        if (c.blockCount >= BLOCK_LIMIT) { suspendConnection(s, c.id, this.now()); pauseForModeration(s, room.id, 'REPEATED_BLOCKS', this.now()); }
      }
      s.audit.push({ action: 'pilot.human.' + action, target: d.id, at: this.now() });
    });
  }
  async publish(h: Human, id: string) {
    const o = this.owner(h);
    const proposal = await this.store.transact(s => {
      this.ready(s); const d = s.moderation.find(d => d.id === id && d.reviewerOwnerId === o.id && d.reviewedBy === o.id && d.outcome === 'approved' && d.source === 'human-only');
      if (!d?.encryptedInput || !d.submittedPrincipal) throw new Fault('APPROVED_PROPOSAL_REQUIRED', 409);
      return { input: JSON.parse(this.secrets.open(d.encryptedInput)), principal: d.submittedPrincipal };
    });
    // Separate explicit publication action, replaying the exact dot-authored
    // proposal with its original validated token expiry/scopes. Domain checks
    // run again atomically. No human-written substitute or stored raw token.
    return this.service.send(proposal.principal, proposal.input);
  }
  async evidence(h: Human) {
    const owner = this.owner(h);
    return this.store.transact(s => {
      this.ready(s); const rooms = [this.config.roomId, this.config.privateRoomId].filter(id => s.memberships.some(m => m.roomId === id && m.ownerId === owner.id && m.active));
      const ids = this.config.owners.map(o => o.connectionId);
      const decisions = s.moderation.filter(d => rooms.includes(d.roomId));
      const subscriptions = s.subscriptions.filter(x => rooms.includes(x.roomId));
      const messages = s.messages.filter(m => rooms.includes(m.room_id));
      const targets = new Set([...rooms, ...ids, ...decisions.map(d => d.id), ...messages.map(m => m.id), ...subscriptions.map(x => x.id)]);
      return { stage: '0B', status: 'NOT_PASSED_REQUIRES_PLATFORM_EVIDENCE', exportedAt: new Date(this.now()).toISOString(), configHash: this.configHash,
        controls: {deliveryHold:s.pilot!.deliveryHold === true,consents:s.pilot!.consents.length,rooms:s.rooms.filter(r=>rooms.includes(r.id)).map(r=>({id:r.id,session:r.session}))},
        messages: messages.map(m => ({ id: m.id, room: m.room_id, session: m.session_id, author: m.author_connection_id, event: m.event_id, cause: m.causation_event_id, at: m.occurred_at, moderation: m.moderation })),
        moderation: decisions.map(d => ({ id: d.id, connection: d.connectionId, outcome: d.outcome, source: d.source, at: d.createdAt, expiresAt: d.expiresAt, reviewedBy: d.reviewedBy })),
        subscriptions: subscriptions.map(x => ({ id: x.id, connection: x.connectionId, active: x.active, expiresAt: x.expiresAt })),
        deliveries: s.outbox.filter(x => subscriptions.some(sub => sub.id === x.subscriptionId)).map(x => ({ ...x })),
        audit: s.audit.filter(a => targets.has(a.target)) };
    });
  }
}
