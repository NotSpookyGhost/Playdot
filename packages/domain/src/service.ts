import { createHash, randomUUID } from 'node:crypto';
import { eventIdentity, readInput, roomInput, sendInput, subscribeInput, type SendInput } from '../../contracts/src/index.js';
import { Fault, type Connection, type Message, type Principal, type Room, type Scope, type State, type Store, type Subscription } from './model.js';
import { BLOCK_LIMIT, MODERATION_POLICY, REVIEW_QUEUE_LIMIT, REVIEW_TTL_MS, evaluateModeration, humanOnlyModeration, moderationContext, pauseForModeration, suspendConnection, type ModerationAdapter } from './moderation.js';

export interface Callback {
  verify(url: string, secret: string, subscriptionId: string): Promise<void>;
  send(subscription: Subscription, event: unknown): Promise<number>;
}
export interface Secrets { seal(value: string): string; open(value: string): string }
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class Playdot {
  constructor(public store: Store, private callback: Callback, private secrets: Secrets, public now: () => number = Date.now, private moderator: ModerationAdapter = humanOnlyModeration, private runtime: { roomsEnabled: boolean; eventsEnabled: boolean } = { roomsEnabled: true, eventsEnabled: true }) {}

  get eventsEnabled() { return this.runtime.roomsEnabled && this.runtime.eventsEnabled; }
  private requireRooms() { if (!this.runtime.roomsEnabled) throw new Fault('REAL_ROOMS_DISABLED', 403); }
  authorizeDiscovery(p: Principal, clients: string[]) {
    return this.run(s => {
      if (p.expiresAt <= this.now()) throw new Fault('UNAUTHORIZED', 401);
      if (!clients.includes(p.clientId) || !p.scopes.includes('room:read')) throw new Fault('FORBIDDEN');
      // Discovery never enrolls an identity or restores a revoked/old-issuer binding.
      if (s.connections.some(c => c.subject === p.subject && c.clientId === p.clientId)) this.connection(s, p);
    });
  }

  private approved(message: Message) {
    return message.moderation?.approved === true && (message.moderation.source === 'human' || (this.moderator.source === 'mock' && message.moderation.source === 'mock'));
  }

  private async moderate(s: State, c: Connection, room: Room, input: SendInput, payloadHash: string, principal: Principal): Promise<Message['moderation']> {
    const contextHash = moderationContext(s, room.id);
    let decision = s.moderation.find(x => x.connectionId === c.id && x.key === input.idempotency_key);
    if (decision && decision.hash !== payloadHash) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
    if (!decision) {
      // Bound the private review queue; expired ciphertext is discarded.
      for (const prior of s.moderation) if (prior.expiresAt <= this.now()) delete prior.encryptedInput;
      if (s.moderation.filter(x => x.connectionId === c.id && x.outcome === 'human_review' && x.expiresAt > this.now()).length >= REVIEW_QUEUE_LIMIT) throw new Fault('REVIEW_QUEUE_LIMIT', 429);
      const outcome = await evaluateModeration(this.moderator, input);
      decision = { id: randomUUID(), connectionId: c.id, roomId: room.id, key: input.idempotency_key, hash: payloadHash, contextHash, policyVersion: MODERATION_POLICY, source: this.moderator.source, outcome, createdAt: this.now(), expiresAt: this.now() + REVIEW_TTL_MS,
        ...(outcome === 'human_review' ? { encryptedInput: this.secrets.seal(JSON.stringify(input)) } : {}) };
      if (room.stage0b) { decision.reviewerOwnerId = c.ownerId; decision.submittedPrincipal = { ...principal, scopes: [...principal.scopes] }; }
      s.moderation.push(decision);
      s.audit.push({ action: `moderation.${decision.source}.${outcome}`, target: decision.id, at: this.now() });
      if (outcome === 'block') {
        c.blockCount = (c.blockCount ?? 0) + 1;
        if (c.blockCount >= BLOCK_LIMIT) { suspendConnection(s, c.id, this.now()); pauseForModeration(s, room.id, 'REPEATED_BLOCKS', this.now()); }
      }
      if (outcome === 'filter_error') pauseForModeration(s, room.id, 'FILTER_ERROR', this.now());
    }
    const details = { moderation_id: decision.id, moderation_source: decision.source, outcome: decision.outcome };
    if (decision.contextHash !== contextHash || decision.policyVersion !== MODERATION_POLICY || decision.expiresAt <= this.now()) throw new Fault('MODERATION_APPROVAL_STALE', 409, details);
    if (decision.outcome === 'approved') {
      const reviewer = s.memberships.find(m => m.ownerId === decision.reviewedBy && m.roomId === room.id && m.active && m.role === 'member');
      if (decision.reviewedBy !== (decision.reviewerOwnerId ?? room.ownerId) || !reviewer) throw new Fault('MODERATION_APPROVAL_STALE', 409, details);
      return { approved: true, decisionId: decision.id, source: 'human', policyVersion: MODERATION_POLICY };
    }
    if (decision.outcome === 'allow' && decision.source === 'mock' && this.moderator.source === 'mock') return { approved: true, decisionId: decision.id, source: 'mock', policyVersion: MODERATION_POLICY };
    const code = { block: 'MODERATION_BLOCKED', human_review: 'MODERATION_REVIEW_REQUIRED', filter_error: 'MODERATION_FILTER_ERROR', rejected: 'MODERATION_REJECTED', allow: 'MODERATION_REVIEW_REQUIRED' }[decision.outcome];
    throw new Fault(code, decision.outcome === 'filter_error' ? 503 : 403, details);
  }

  private run<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    // Policy exhaustion must persist a pause even when the attempted write fails.
    return this.store.transact(async s => {
      try { return { value: await fn(s) }; }
      catch (error) { if (error instanceof Fault) return { error }; throw error; }
    }).then(result => { if ('error' in result) throw result.error; return result.value; });
  }
  connection(s: State, p: Principal): Connection {
    if (p.expiresAt <= this.now()) throw new Fault('UNAUTHORIZED', 401);
    const matches = s.connections.filter(c => c.issuer === p.issuer && c.subject === p.subject && c.clientId === p.clientId && c.active);
    if (matches.length !== 1) throw new Fault('CONNECTION_NOT_AUTHORIZED');
    if (matches[0]!.suspended) throw new Fault('CONNECTION_SUSPENDED');
    return matches[0]!;
  }
  private access(s: State, p: Principal, roomId: string, scope: Scope) {
    const c = this.connection(s, p);
    const room = s.rooms.find(r => r.id === roomId);
    const member = s.memberships.find(m => m.ownerId === c.ownerId && m.roomId === roomId && m.active);
    const grant = s.grants.find(g => g.connectionId === c.id && g.roomId === roomId && g.active);
    if (!room || !member || !grant) throw new Fault('NOT_FOUND', 404);
    if (!p.scopes.includes(scope) || !c.scopes.includes(scope) || !grant.scopes.includes(scope) || (scope !== 'room:read' && member.role === 'spectator')) throw new Fault('FORBIDDEN');
    return { c, room, member };
  }
  private active(s: State, room: Room) {
    if (room.session.state === 'active' && room.session.expiresAt <= this.now()) {
      room.session.state = 'paused'; room.session.reason = 'TIME_LIMIT';
      this.cancelRoom(s, room.id);
    }
    if (room.session.state !== 'active') throw new Fault('SESSION_PAUSED', 409);
  }
  private cancelRoom(s: State, roomId: string) {
    const ids = s.subscriptions.filter(x => x.roomId === roomId).map(x => x.id);
    s.outbox.filter(x => ids.includes(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; });
  }
  status(p: Principal) { return this.run(s => { const c = this.connection(s, p); return { owner_user_id: c.ownerId, connection_id: c.id, verified_level: 'owner_authorized', scopes: c.scopes.filter(x => p.scopes.includes(x)) }; }); }
  room(p: Principal, input: unknown) {
    this.requireRooms();
    const a = roomInput.parse(input);
    return this.run(s => { const { room, member } = this.access(s, p, a.room_id, 'room:read');
      if (room.session.state === 'active' && room.session.expiresAt <= this.now()) { room.session.state = 'paused'; room.session.reason = 'TIME_LIMIT'; this.cancelRoom(s, room.id); }
      return { room_id: room.id, brief: room.brief, history_from_seq: member.historyFrom, session: room.session };
    });
  }
  read(p: Principal, input: unknown) {
    this.requireRooms();
    const a = readInput.parse(input);
    return this.run(s => { const { member } = this.access(s, p, a.room_id, 'room:read');
      const messages = s.messages.filter(m => this.approved(m) && m.room_id === a.room_id && m.room_seq > a.after_seq && m.room_seq >= member.historyFrom).slice(0, a.limit);
      return { messages, next_cursor: messages.at(-1)?.room_seq ?? a.after_seq };
    });
  }
  send(p: Principal, input: unknown) {
    this.requireRooms();
    const a = sendInput.parse(input);
    return this.run(async s => {
      const { c, room, member } = this.access(s, p, a.room_id, 'message:write');
      // Authorization precedes idempotency lookup: replay never restores revoked access.
      const payloadHash = hash(JSON.stringify(a));
      const replay = s.idempotency.find(x => x.connectionId === c.id && x.key === a.idempotency_key);
      if (replay) {
        if (replay.hash !== payloadHash) throw new Fault('IDEMPOTENCY_CONFLICT', 409);
        const message = s.messages.find(m => m.id === replay.messageId)!;
        if (!message || !this.approved(message) || message.room_seq < member.historyFrom) throw new Fault('NOT_FOUND', 404);
        return message;
      }
      this.active(s, room);
      const session = room.session;
      if (session.id !== a.session_id) throw new Fault('SESSION_MISMATCH', 409);
      if ((session.counts[c.id] ?? 0) >= session.perConnectionLimit) throw new Fault('CONNECTION_MESSAGE_LIMIT', 429);
      if (session.total >= session.totalLimit) throw new Fault('SESSION_MESSAGE_LIMIT', 429);
      if (session.lastAt[c.id] !== undefined && this.now() - session.lastAt[c.id]! < session.cooldownMs) throw new Fault('COOLDOWN', 429);
      const cause = a.causation_event_id ? s.messages.find(m => this.approved(m) && m.event_id === a.causation_event_id && m.room_id === room.id && m.session_id === session.id && m.room_seq >= member.historyFrom) : undefined;
      if (a.causation_event_id && (!cause || cause.author_connection_id === c.id)) throw new Fault('INVALID_CAUSE', 422);
      if (!cause && (session.total !== 0 || session.starter !== c.id)) throw new Fault('CAUSE_REQUIRED', 422);
      const claim = `${c.id}:${a.causation_event_id}`;
      if (cause && session.claims.includes(claim)) throw new Fault('ALREADY_RESPONDED', 409);
      const depth = cause ? cause.depth + 1 : 0;
      if (depth >= session.chainLimit) throw new Fault('CHAIN_LIMIT', 429);
      const moderation = await this.moderate(s, c, room, a, payloadHash, p);
      // Filter evaluation is bounded but asynchronous: recheck token/session time.
      this.access(s, p, a.room_id, 'message:write'); this.active(s, room);
      const message = { id: randomUUID(), room_id: room.id, room_seq: ++room.seq, body: a.body,
        author_connection_id: c.id, owner_user_id: c.ownerId, session_id: session.id, event_id: randomUUID(),
        ...(cause ? { causation_event_id: cause.event_id } : {}), correlation_id: cause?.correlation_id ?? randomUUID(), depth,
        occurred_at: new Date(this.now()).toISOString(), moderation };
      s.messages.push(message);
      const decision = s.moderation.find(x => x.id === moderation.decisionId)!; delete decision.encryptedInput;
      s.idempotency.push({ connectionId: c.id, key: a.idempotency_key, hash: payloadHash, messageId: message.id });
      session.total++; session.counts[c.id] = (session.counts[c.id] ?? 0) + 1; session.lastAt[c.id] = this.now();
      if (cause) {
        session.claims.push(claim);
        s.outbox.filter(o => o.eventId === cause.event_id && s.subscriptions.some(sub => sub.id === o.subscriptionId && sub.connectionId === c.id)).forEach(o => { o.repliedMessageId = message.id; });
      }
      for (const sub of s.subscriptions) if (sub.roomId === room.id && sub.connectionId !== c.id && this.deliverable(s, sub)) {
        s.outbox.push({ id: randomUUID(), eventId: message.event_id, subscriptionId: sub.id, state: 'queued', attempts: 0, nextAt: this.now() });
      }
      const participants = s.grants.filter(g => g.roomId === room.id && g.active && g.scopes.includes('message:write') && s.connections.some(cn => cn.id === g.connectionId && cn.active && !cn.suspended) && s.memberships.some(m => m.roomId === room.id && m.active && m.role === 'member' && s.connections.some(cn => cn.id === g.connectionId && cn.ownerId === m.ownerId)));
      if (session.total >= session.totalLimit || participants.every(g => (session.counts[g.connectionId] ?? 0) >= session.perConnectionLimit)) {
        session.state = 'paused'; session.reason = 'MESSAGE_LIMIT'; this.cancelRoom(s, room.id);
      }
      s.audit.push({ action: 'message.accepted', target: message.id, at: this.now() });
      return message;
    });
  }
  async canSubscribe(p: Principal) {
    if (!this.eventsEnabled) return false;
    return this.run(s => { this.connection(s, p); return s.rooms.some(r => { try { this.access(s, p, r.id, 'events:subscribe'); return true; } catch { return false; } }); });
  }
  private subscriptionId(connectionId: string, roomId: string, url: string) { return hash(JSON.stringify([connectionId, 'room.message.created', roomId, true, url])); }
  async subscribe(p: Principal, input: unknown) {
    if (!this.eventsEnabled) throw new Fault('EVENTS_DISABLED');
    const a = subscribeInput.parse(input);
    const c = await this.run(s => { const { c, room } = this.access(s, p, a.arguments.room_id, 'events:subscribe'); this.active(s, room); return c; });
    const id = this.subscriptionId(c.id, a.arguments.room_id, a.delivery.url);
    await this.callback.verify(a.delivery.url, a.delivery.secret, id);
    // Verification is external I/O; recheck all authorization after it completes.
    return this.run(s => {
      const { c: current, room } = this.access(s, p, a.arguments.room_id, 'events:subscribe'); this.active(s, room);
      if (c.id !== current.id) throw new Fault('CONNECTION_NOT_AUTHORIZED');
      const previous = s.subscriptions.find(x => x.id === id);
      const expiresAt = Math.min(this.now() + Math.min(a.ttlMs ?? 3600000, 3600000), p.expiresAt);
      const sub: Subscription = { id, connectionId: c.id, roomId: room.id, url: a.delivery.url,
        secret: this.secrets.seal(a.delivery.secret), expiresAt, tokenExpiresAt: p.expiresAt, active: true };
      if (previous && this.secrets.open(previous.secret) !== a.delivery.secret) { sub.oldSecret = previous.secret; sub.rotationUntil = this.now() + 60000; }
      s.subscriptions = s.subscriptions.filter(x => x.id !== id); s.subscriptions.push(sub);
      s.audit.push({ action: previous ? 'subscription.refreshed' : 'subscription.created', target: id, at: this.now() });
      return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
    });
  }
  unsubscribe(p: Principal, input: unknown) {
    const a = eventIdentity.parse(input);
    return this.run(s => {
      const c = this.connection(s, p);
      const id = this.subscriptionId(c.id, a.arguments.room_id, a.delivery.url);
      const sub = s.subscriptions.find(x => x.id === id);
      if (sub) sub.active = false;
      s.outbox.filter(x => x.subscriptionId === id && x.state === 'queued').forEach(x => { x.state = 'cancelled'; });
      return {};
    });
  }
  private deliverable(s: State, sub: Subscription) {
    if (!this.eventsEnabled) return false;
    if (!sub.active || sub.expiresAt <= this.now() || sub.tokenExpiresAt <= this.now()) return false;
    const c = s.connections.find(x => x.id === sub.connectionId);
    if (!c) return false;
    try {
      const { room } = this.access(s, { issuer: c.issuer, subject: c.subject, clientId: c.clientId, scopes: ['room:read', 'events:subscribe'], expiresAt: sub.tokenExpiresAt }, sub.roomId, 'events:subscribe');
      return room.session.state === 'active' && room.session.expiresAt > this.now();
    } catch { return false; }
  }
  async dispatchOne() {
    if (!this.eventsEnabled) return false;
    // Minimal serial worker: hold the aggregate lock through bounded HTTP I/O.
    // Revocation and dispatch have one ordering; no cached grants escape the lock.
    return this.store.transact(async s => {
      if (s.pilot?.deliveryHold) return false;
      const item = s.outbox.find(x => x.state === 'queued' && x.nextAt <= this.now());
      if (!item) return false;
      const sub = s.subscriptions.find(x => x.id === item.subscriptionId);
      const message = s.messages.find(x => x.event_id === item.eventId);
      const c = s.connections.find(x => x.id === sub?.connectionId);
      const member = s.memberships.find(x => x.ownerId === c?.ownerId && x.roomId === sub?.roomId && x.active);
      if (!sub || !message || !this.approved(message) || !member || message.room_seq < member.historyFrom || !this.deliverable(s, sub)) { item.state = 'cancelled'; return true; }
      const event = { eventId: message.event_id, name: 'room.message.created', timestamp: message.occurred_at,
        data: { room_id: message.room_id, message_id: message.id, session_id: message.session_id, room_seq: message.room_seq, correlation_id: message.correlation_id }, cursor: null };
      item.attempts++;
      let status = 0;
      try { status = await this.callback.send({ ...sub, secret: this.secrets.open(sub.secret), oldSecret: sub.oldSecret && (sub.rotationUntil ?? 0) > this.now() ? this.secrets.open(sub.oldSecret) : undefined }, event); } catch { /* no sensitive diagnostics */ }
      if (status >= 200 && status < 300) item.state = 'received';
      else if (status === 410 || status === 413 || (status >= 400 && status < 500 && status !== 429) || item.attempts >= 5) item.state = 'failed';
      else item.nextAt = this.now() + Math.min(60000, 1000 * 2 ** item.attempts);
      s.audit.push({ action: 'delivery.' + item.state, target: sub.id, at: this.now() });
      return true;
    });
  }
}
