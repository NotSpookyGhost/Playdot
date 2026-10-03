import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { harness, fixtureSecret } from './harness.js';
import { Playdot } from '../packages/domain/src/service.js';
import { callbacks, secretBox } from '../apps/server/src/callback.js';

let h: Awaited<ReturnType<typeof harness>>;
const opening = (key = 'opening') => ({ room_id: 'shared', session_id: 'session-shared', body: 'Blue', idempotency_key: key });
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h?.close(); });

describe(`local contracts: simulated principals, ${process.env.PLAYDOT_TEST_NETWORK === 'yes' ? 'network' : 'embedded'} PostgreSQL`, () => {
  it('advertises MCP event discovery and four narrow tools', async () => {
    const discover = await h.rpc(h.tokenA, 'server/discover');
    expect(discover.body.result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    const tools = await h.rpc(h.tokenA, 'tools/list');
    expect(tools.body.result.tools).toHaveLength(4);
    expect(tools.body.result.tools.some((x: { name: string }) => /pause|grant|approve|revoke/.test(x.name))).toBe(false);
    expect((await h.rpc(h.tokenA, 'events/list')).body.result.events[0].delivery).toEqual(['webhook']);
    expect((await h.rpc(h.tokenA, 'tools/call', { name: 'playdot_connection_status', arguments: {} })).body.result.structuredContent).toMatchObject({ owner_user_id: 'owner-a', connection_id: 'dot-a', verified_level: 'owner_authorized' });
  });
  it('requires bearer authorization and advertises protected resource metadata', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401); expect(r.headers['www-authenticate']).toContain('oauth-protected-resource');
    expect((await h.app.inject('/.well-known/oauth-protected-resource')).json().resource).toBe('https://playdot.invalid/mcp');
  });
  it.each([
    ['wrong audience', { aud: 'another-service' }], ['wrong issuer', { iss: 'https://untrusted.invalid' }],
    ['expired', { exp: 1 }], ['future not-before', { nbf: 9999999999 }], ['missing expiration', { exp: undefined }], ['missing client', { azp: undefined }], ['ambiguous client', { client_id: 'different' }]
  ])('rejects %s tokens', async (_label, overrides) => {
    const r = await h.rpc(await h.token('subject-a', overrides), 'tools/list'); expect(r.status).toBe(401);
  });
  it('rejects a tampered signature', async () => {
    const parts = h.tokenA.split('.'); parts[2] = `${parts[2]![0] === 'a' ? 'b' : 'a'}${parts[2]!.slice(1)}`;
    expect((await h.rpc(parts.join('.'), 'tools/list')).status).toBe(401);
  });
  it('rejects unapproved subjects and client bindings instead of auto-enrolling them', async () => {
    expect((await h.rpc(await h.token('stranger'), 'tools/list')).body.error.message).toBe('CONNECTION_NOT_AUTHORIZED');
    expect((await h.rpc(await h.token('subject-a', { azp: 'different' }), 'tools/list')).body.error.message).toBe('CONNECTION_NOT_AUTHORIZED');
  });
  it('fails closed when two stored connections have the same authenticated binding', async () => {
    await h.store.transact(s => { s.connections.push({ ...s.connections[0]!, id: 'ambiguous' }); });
    await expect(h.service.status(h.a)).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
  });
  it('ignores asserted owner claims and rejects forged tool arguments', async () => {
    const token = await h.token('subject-a', { owner_id: 'owner-b', connection_id: 'dot-b' });
    expect((await h.rpc(token, 'tools/call', { name: 'playdot_connection_status', arguments: {} })).body.result.structuredContent.owner_user_id).toBe('owner-a');
    const forged = await h.rpc(token, 'tools/call', { name: 'playdot_send_message', arguments: { ...opening(), owner_id: 'owner-b' } });
    expect(forged.body.result.structuredContent.code).toBe('INVALID_ARGUMENTS');
    const result = await h.service.send(h.a, opening()); expect(result.owner_user_id).toBe('owner-a'); expect(result.author_connection_id).toBe('dot-a');
  });
  it('denies cross-room reads, writes and subscriptions', async () => {
    await expect(h.service.read(h.b, { room_id: 'private-a' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.send(h.b, { ...opening(), room_id: 'private-a', session_id: 'session-private-a' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.service.subscribe(h.b, h.subscribe('private-a'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('intersects token scopes, connection scopes, grants and spectator roles', async () => {
    await expect(h.service.send({ ...h.a, scopes: ['room:read'] }, opening())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.store.transact(s => { s.connections[0]!.scopes = ['room:read']; });
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.controls.seed(); await h.store.transact(s => { s.grants[0]!.scopes = ['room:read']; });
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.controls.seed(); await h.store.transact(s => { s.memberships[0]!.role = 'spectator'; });
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.service.read(h.a, { room_id: 'shared' })).resolves.toMatchObject({ messages: [] });
  });
  it('deduplicates concurrent identical writes without spending another budget unit', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => h.service.send(h.a, opening())));
    expect(new Set(results.map(x => x.id)).size).toBe(1);
    await h.store.transact(s => { expect(s.messages).toHaveLength(1); expect(s.rooms[0]!.session.total).toBe(1); expect(s.rooms[0]!.seq).toBe(1); });
    await expect(h.service.send(h.a, { ...opening(), body: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('scopes idempotency per connection', async () => {
    const first = await h.service.send(h.a, opening());
    const second = await h.service.send(h.b, { ...opening(), body: 'Green', causation_event_id: first.event_id });
    expect(second.id).not.toBe(first.id);
  });
  it('enforces cooldown, causation, no self-replies and one reply per event', async () => {
    const first = await h.service.send(h.a, opening());
    const second = await h.service.send(h.b, { ...opening('b'), causation_event_id: first.event_id });
    await expect(h.service.send(h.a, { ...opening('a2'), causation_event_id: second.event_id })).rejects.toMatchObject({ code: 'COOLDOWN' });
    h.advance(10000);
    await expect(h.service.send(h.a, opening('a2'))).rejects.toMatchObject({ code: 'CAUSE_REQUIRED' });
    await expect(h.service.send(h.a, { ...opening('a2'), causation_event_id: first.event_id })).rejects.toMatchObject({ code: 'INVALID_CAUSE' });
    await expect(h.service.send(h.b, { ...opening('b2'), causation_event_id: first.event_id })).rejects.toMatchObject({ code: 'ALREADY_RESPONDED' });
  });
  it('allows exactly five messages each / ten total for two simulated connections', async () => {
    let previous: string | undefined;
    for (let index = 0; index < 10; index++) {
      const message = await h.service.send(index % 2 === 0 ? h.a : h.b, { ...opening(`message-${index}`), ...(previous ? { causation_event_id: previous } : {}) });
      previous = message.event_id; h.advance(10000);
    }
    const room = await h.service.room(h.a, { room_id: 'shared' });
    expect(room.session.counts).toEqual({ 'dot-a': 5, 'dot-b': 5 });
    expect(room.session.total).toBe(10); expect(room.session.totalLimit).toBe(20); expect(room.session.state).toBe('paused');
    await expect(h.service.send(h.b, { ...opening('eleventh'), causation_event_id: previous })).rejects.toMatchObject({ code: 'SESSION_PAUSED' });
  });
  it('does not let concurrent distinct replies exceed the per-connection cap', async () => {
    let last: string | undefined;
    for (let i = 0; i < 8; i++) { const m = await h.service.send(i % 2 === 0 ? h.a : h.b, { ...opening(`${i}`), ...(last ? { causation_event_id: last } : {}) }); last = m.event_id; h.advance(10000); }
    const results = await Promise.allSettled([h.service.send(h.a, { ...opening('race-a'), causation_event_id: last }), h.service.send(h.a, { ...opening('race-b'), causation_event_id: last })]);
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('CONNECTION_MESSAGE_LIMIT');
    expect((await h.service.room(h.a, { room_id: 'shared' })).session.state).toBe('active');
  });
  it('enforces the independent total ceiling and time expiry', async () => {
    await h.store.transact(s => { s.rooms[0]!.session.totalLimit = 1; });
    await h.service.send(h.a, opening());
    expect((await h.service.room(h.a, { room_id: 'shared' })).session.reason).toBe('MESSAGE_LIMIT');
    await h.controls.seed(); h.advance(15 * 60000);
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'SESSION_PAUSED' });
    expect((await h.service.room(h.a, { room_id: 'shared' })).session.reason).toBe('TIME_LIMIT');
  });
  it('rejects stale sessions and a chain beyond the configured bound', async () => {
    await expect(h.service.send(h.a, { ...opening(), session_id: 'stale-session' })).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    await h.store.transact(s => { s.rooms[0]!.session.chainLimit = 1; });
    const first = await h.service.send(h.a, opening());
    await expect(h.service.send(h.b, { ...opening('b'), causation_event_id: first.event_id })).rejects.toMatchObject({ code: 'CHAIN_LIMIT' });
  });
  it('pause stops new messages and queued delivery but retains authorized reads', async () => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, opening()); await h.controls.pause('shared');
    await expect(h.service.send(h.b, opening('b'))).rejects.toMatchObject({ code: 'SESSION_PAUSED' });
    expect((await h.service.read(h.b, { room_id: 'shared' })).messages).toHaveLength(1);
    expect(await h.service.dispatchOne()).toBe(false); expect(h.events).toHaveLength(0);
  });
  it('revocation blocks cached tokens, all MCP discovery, reads, writes and queued delivery', async () => {
    await h.service.subscribe(h.b, h.subscribe()); const m = await h.service.send(h.a, opening()); await h.controls.revoke('dot-b');
    await expect(h.service.read(h.b, { room_id: 'shared' })).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
    await expect(h.service.send(h.b, { ...opening('b'), causation_event_id: m.event_id })).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
    await expect(h.service.subscribe(h.b, h.subscribe())).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
    expect((await h.rpc(h.tokenB, 'tools/list')).body.error.message).toBe('CONNECTION_NOT_AUTHORIZED');
    expect(await h.service.dispatchOne()).toBe(false); expect(h.events).toHaveLength(0);
    await h.controls.revoke('dot-a');
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
  });
  it('rechecks membership and grants before dispatch even without explicit cancellation', async () => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, opening());
    await h.store.transact(s => { s.memberships.find(x => x.ownerId === 'owner-b')!.active = false; });
    await h.service.dispatchOne(); expect(h.events).toHaveLength(0);
    await h.store.transact(s => { expect(s.outbox[0]!.state).toBe('cancelled'); });
  });
  it('enforces history boundaries, including idempotent response lookup', async () => {
    await h.service.send(h.a, opening());
    await h.store.transact(s => { s.memberships.forEach(m => { m.historyFrom = 2; }); });
    expect((await h.service.read(h.b, { room_id: 'shared' })).messages).toHaveLength(0);
    await expect(h.service.send(h.a, opening())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('tests local invitation expiry, replay and separate Dot grants', async () => {
    const expired = await h.controls.invite('private-a', 1); h.advance(2);
    await expect(h.controls.accept(expired, 'owner-b')).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    const good = await h.controls.invite('private-a'); await h.controls.accept(good, 'owner-b');
    await expect(h.controls.accept(good, 'owner-b')).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    await expect(h.service.read(h.b, { room_id: 'private-a' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await h.store.transact(s => { expect(JSON.stringify(s.invitations)).not.toContain(good); });
  });
  it('rolls back failed storage operations', async () => {
    await expect(h.store.transact(s => { s.rooms[0]!.seq = 99; throw new Error('rollback'); })).rejects.toThrow('rollback');
    await h.store.transact(s => { expect(s.rooms[0]!.seq).toBe(0); });
  });
  it('handles real loopback HTTP with signed test JWTs (still no real Dot)', async () => {
    const url = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${h.tokenA}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'playdot_send_message', arguments: opening() } }) });
    expect(response.status).toBe(200); const body = await response.json() as any; expect(body.result.structuredContent.author_connection_id).toBe('dot-a');
    expect((await h.app.inject({ method: 'POST', url: '/mcp', headers: { origin: 'https://hostile.invalid' }, payload: {} })).statusCode).toBe(403);
    expect((await h.app.inject('/admin')).statusCode).toBe(404);
  });
});

describe('event adapter: signed webhook verifier fixture, not ChatGPT', () => {
  it('verifies callback, stores encrypted secret, and separates receipt from reply', async () => {
    const sub = await h.service.subscribe(h.b, h.subscribe());
    expect(sub.cursor).toBeNull();
    await h.store.transact(s => { expect(s.subscriptions[0]!.secret).not.toContain(fixtureSecret); });
    const m = await h.service.send(h.a, opening()); await h.service.dispatchOne();
    expect(h.events).toHaveLength(1); expect(h.events[0]!.data.eventId).toBe(m.event_id);
    expect(h.events[0]!.data.data.message_id).toBe(m.id);
    await h.store.transact(s => { expect(s.outbox[0]!.state).toBe('received'); expect(s.outbox[0]!.repliedMessageId).toBeUndefined(); });
    const reply = await h.service.send(h.b, { ...opening('b'), causation_event_id: m.event_id });
    await h.store.transact(s => { expect(s.outbox[0]!.repliedMessageId).toBe(reply.id); });
  });
  it('never activates a failed challenge or revoked-during-verification subscription', async () => {
    h.wrongChallenge(); await expect(h.service.subscribe(h.b, h.subscribe())).rejects.toMatchObject({ code: 'CALLBACK_VERIFICATION_FAILED' });
    await h.store.transact(s => { expect(s.subscriptions).toHaveLength(0); });
    const service = new Playdot(h.store, { verify: async () => { await h.controls.revoke('dot-b'); }, send: async () => 204 }, secretBox(Buffer.alloc(32, 11)), h.now);
    await expect(service.subscribe(h.b, h.subscribe())).rejects.toMatchObject({ code: 'CONNECTION_NOT_AUTHORIZED' });
    await h.store.transact(s => { expect(s.subscriptions).toHaveLength(0); });
  });
  it('excludes self-events and nonmatching rooms', async () => {
    await h.service.subscribe(h.a, h.subscribe()); await h.service.subscribe(h.b, h.subscribe());
    await h.service.send(h.a, { ...opening(), room_id: 'private-a', session_id: 'session-private-a' });
    expect(await h.service.dispatchOne()).toBe(false);
    await h.service.send(h.a, opening('shared')); await h.service.dispatchOne();
    expect(h.events).toHaveLength(1); expect(await h.service.dispatchOne()).toBe(false);
  });
  it('refresh is idempotent and unsubscribe uses name, arguments and callback URL', async () => {
    const first = await h.service.subscribe(h.b, { ...h.subscribe(), ttlMs: 60000 }); h.advance(1000);
    const second = await h.service.subscribe(h.b, { ...h.subscribe(), ttlMs: 60000 }); expect(second.id).toBe(first.id); expect(second.refreshBefore > first.refreshBefore).toBe(true);
    await h.store.transact(s => { expect(s.subscriptions).toHaveLength(1); });
    await h.service.send(h.a, opening());
    const { secret: _secret, ...delivery } = h.subscribe().delivery;
    const params = { name: 'room.message.created', arguments: h.subscribe().arguments, delivery };
    await h.service.unsubscribe(h.a, params); // Cannot stop B's subscription.
    await h.store.transact(s => { expect(s.subscriptions[0]!.active).toBe(true); });
    await h.service.unsubscribe(h.b, params); await h.service.unsubscribe(h.b, params);
    expect(await h.service.dispatchOne()).toBe(false);
  });
  it('refresh preserves the original secret-rotation deadline and stops old signatures at expiry', async () => {
    const nextSecret = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
    const deliveries: { body: string; headers: Record<string, string> }[] = [];
    const service = new Playdot(h.store, callbacks(async (_url, body, headers) => {
      const data = JSON.parse(body);
      if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
      deliveries.push({ body, headers }); return { status: 204, body: '' };
    }, h.now), secretBox(Buffer.alloc(32, 11)), h.now, h.moderation);
    const initial = await service.subscribe(h.b, h.subscribe());
    h.advance(1000);
    const rotated = { ...h.subscribe(), delivery: { ...h.subscribe().delivery, secret: nextSecret } };
    expect((await service.subscribe(h.b, rotated)).id).toBe(initial.id);
    const rotationUntil = h.now() + 60000;
    h.advance(1000);
    expect((await service.subscribe(h.b, rotated)).id).toBe(initial.id);
    const first = await h.service.send(h.a, opening());
    await service.dispatchOne();
    expect(deliveries).toHaveLength(1);
    expect(new Webhook(fixtureSecret).verify(deliveries[0]!.body, deliveries[0]!.headers)).toMatchObject({ eventId: first.event_id });
    expect(new Webhook(nextSecret).verify(deliveries[0]!.body, deliveries[0]!.headers)).toMatchObject({ eventId: first.event_id });

    h.advance(rotationUntil - h.now()); // Refresh must not extend the original overlap.
    await service.subscribe(h.b, rotated);
    const reply = await h.service.send(h.b, { ...opening('rotation-reply'), causation_event_id: first.event_id });
    const second = await h.service.send(h.a, { ...opening('rotation-after-expiry'), causation_event_id: reply.event_id });
    await service.dispatchOne();
    expect(deliveries).toHaveLength(2);
    expect(new Webhook(nextSecret).verify(deliveries[1]!.body, deliveries[1]!.headers)).toMatchObject({ eventId: second.event_id });
    expect(() => new Webhook(fixtureSecret).verify(deliveries[1]!.body, deliveries[1]!.headers)).toThrow();
  });
  it('expires subscriptions and returns no unsupported replay cursor', async () => {
    await h.service.subscribe(h.b, { ...h.subscribe(), ttlMs: 1000 }); await h.service.send(h.a, opening()); h.advance(1001);
    await h.service.dispatchOne(); expect(h.events).toHaveLength(0);
    await expect(h.service.subscribe(h.b, { ...h.subscribe(), cursor: 'invented' })).rejects.toThrow();
  });
  it('retries with stable event ID; receipt alone cannot create a reply', async () => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, opening()); h.setStatus(503);
    await h.service.dispatchOne(); expect(await h.service.dispatchOne()).toBe(false);
    h.advance(5000); h.setStatus(204); await h.service.dispatchOne();
    expect(h.events).toHaveLength(2); expect(h.events[0]!.data.eventId).toBe(h.events[1]!.data.eventId);
    expect((await h.service.read(h.a, { room_id: 'shared' })).messages).toHaveLength(1);
  });
  it.each([410, 413])('does not retry terminal HTTP %i', async status => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, opening()); h.setStatus(status); await h.service.dispatchOne(); h.advance(60000);
    expect(await h.service.dispatchOne()).toBe(false); expect(h.events).toHaveLength(1);
    await h.store.transact(s => { expect(s.outbox[0]!.state).toBe('failed'); });
  });
});
