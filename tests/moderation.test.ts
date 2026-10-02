import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './harness.js';
import { Playdot } from '../packages/domain/src/service.js';
import { secretBox } from '../apps/server/src/callback.js';
import { BLOCK_LIMIT, REVIEW_TTL_MS, humanOnlyModeration } from '../packages/domain/src/moderation.js';

let h: Awaited<ReturnType<typeof harness>>;
const input = (key = 'moderation-case') => ({ room_id: 'shared', session_id: 'session-shared', body: 'Harmless test content, not a real moderation sample.', idempotency_key: key });
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h?.close(); });
async function decision() { return h.store.transact(s => s.moderation.at(-1)!); }
async function assertUnpublished() {
  expect((await h.service.read(h.b, { room_id: 'shared' })).messages).toEqual([]);
  await h.store.transact(s => {
    expect(s.messages).toHaveLength(0); expect(s.outbox).toHaveLength(0); expect(s.idempotency).toHaveLength(0);
    expect(s.rooms[0]!.seq).toBe(0); expect(s.rooms[0]!.session.total).toBe(0); expect(s.rooms[0]!.session.claims).toEqual([]);
    expect(JSON.stringify(s.audit)).not.toContain(input().body);
    expect(JSON.stringify(s.moderation)).not.toContain(input().body);
  });
  expect(await h.service.dispatchOne()).toBe(false); expect(h.events).toHaveLength(0);
}

describe('MOCK moderation outcomes — local contracts, NOT real classification', () => {
  it('MOCK allow commits message and event once, with an explicit mock label', async () => {
    await h.service.subscribe(h.b, h.subscribe());
    const a = await h.service.send(h.a, input()); const b = await h.service.send(h.a, input());
    expect(a.id).toBe(b.id); expect(a.moderation).toMatchObject({ approved: true, source: 'mock' }); expect(h.moderation.calls).toBe(1);
    await h.service.dispatchOne(); expect(h.events).toHaveLength(1);
    expect((await decision()).source).toBe('mock');
  });
  it.each([
    ['block', 'MODERATION_BLOCKED'], ['human_review', 'MODERATION_REVIEW_REQUIRED'], ['filter_error', 'MODERATION_FILTER_ERROR']
  ])('MOCK %s never creates shared history, sequence, budget charge or an event', async (outcome, code) => {
    h.moderation.result = outcome; await h.service.subscribe(h.b, h.subscribe());
    const response = await h.rpc(h.tokenA, 'tools/call', { name: 'playdot_send_message', arguments: input() });
    expect(response.body.result).toMatchObject({ isError: true, structuredContent: { code, moderation_source: 'mock', outcome } });
    expect(JSON.stringify(response.body)).not.toContain(input().body);
    await assertUnpublished();
  });
  it.each(['exception', 'malformed', 'timeout'])('MOCK filter %s fails closed and pauses the room', async kind => {
    if (kind === 'exception') h.moderation.fail = true;
    if (kind === 'malformed') h.moderation.result = { outcome: 'allow' }; // Wrong provider contract.
    if (kind === 'timeout') h.moderation.hang = true;
    await expect(h.service.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_FILTER_ERROR' });
    expect((await h.service.room(h.b, { room_id: 'shared' })).session).toMatchObject({ state: 'paused', reason: 'FILTER_ERROR' });
    await assertUnpublished();
    await h.store.transact(s => { expect(s.connections[0]!.blockCount ?? 0).toBe(0); });
  });
  it('counts distinct blocked attempts once, then suspends the connection and pauses the room', async () => {
    h.moderation.result = 'block';
    await Promise.all(Array.from({ length: 4 }, () => expect(h.service.send(h.a, input('same'))).rejects.toMatchObject({ code: 'MODERATION_BLOCKED' })));
    await h.store.transact(s => { expect(s.connections[0]!.blockCount).toBe(1); });
    expect(h.moderation.calls).toBe(1);
    await expect(h.service.send(h.a, { ...input('same'), body: 'Changed content' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    for (let n = 1; n < BLOCK_LIMIT; n++) await expect(h.service.send(h.a, input(`distinct-${n}`))).rejects.toMatchObject({ code: 'MODERATION_BLOCKED' });
    await h.store.transact(s => { expect(s.connections[0]).toMatchObject({ suspended: true, blockCount: BLOCK_LIMIT }); });
    expect((await h.service.room(h.b, { room_id: 'shared' })).session.reason).toBe('REPEATED_BLOCKS');
    await expect(h.service.read(h.a, { room_id: 'private-a' })).rejects.toMatchObject({ code: 'CONNECTION_SUSPENDED' });
    await expect(h.service.send(h.a, input('extra'))).rejects.toMatchObject({ code: 'CONNECTION_SUSPENDED' });
    expect((await h.rpc(h.tokenA, 'events/list')).body.error.message).toBe('CONNECTION_SUSPENDED');
    await assertUnpublished();
  });
  it('filter failure cancels already queued wake-ups without deleting approved history', async () => {
    await h.service.subscribe(h.b, h.subscribe()); const first = await h.service.send(h.a, input());
    h.moderation.result = 'filter_error';
    await expect(h.service.send(h.b, { ...input('reply'), causation_event_id: first.event_id })).rejects.toMatchObject({ code: 'MODERATION_FILTER_ERROR' });
    await h.store.transact(s => { expect(s.messages).toHaveLength(1); expect(s.outbox[0]!.state).toBe('cancelled'); });
    expect(await h.service.dispatchOne()).toBe(false); expect(h.events).toHaveLength(0);
  });
  it('owner-only local suspension stops its pending delivery without revoking the other connection', async () => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, input());
    await expect(h.controls.suspend('dot-b', 'owner-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.controls.suspend('dot-b', 'owner-b');
    await expect(h.service.subscribe(h.b, h.subscribe())).rejects.toMatchObject({ code: 'CONNECTION_SUSPENDED' });
    await expect(h.service.read(h.b, { room_id: 'shared' })).rejects.toMatchObject({ code: 'CONNECTION_SUSPENDED' });
    expect((await h.service.read(h.a, { room_id: 'shared' })).messages).toHaveLength(1);
    expect(await h.service.dispatchOne()).toBe(false);
  });
  it('a suspended participant cannot leave an exhausted room falsely active', async () => {
    await h.controls.suspend('dot-b', 'owner-b');
    await h.store.transact(s => { s.rooms[0]!.session.perConnectionLimit = 1; });
    await h.service.send(h.a, input());
    expect((await h.service.room(h.a, { room_id: 'shared' })).session).toMatchObject({ state: 'paused', reason: 'MESSAGE_LIMIT' });
  });
  it('block strikes cannot be reset by choosing another room or idempotency key', async () => {
    h.moderation.result = 'block';
    await expect(h.service.send(h.a, input('one'))).rejects.toMatchObject({ code: 'MODERATION_BLOCKED' });
    await expect(h.service.send(h.a, { ...input('two'), room_id: 'private-a', session_id: 'session-private-a' })).rejects.toMatchObject({ code: 'MODERATION_BLOCKED' });
    await expect(h.service.send(h.a, input('three'))).rejects.toMatchObject({ code: 'MODERATION_BLOCKED' });
    await h.store.transact(s => { expect(s.connections[0]!.blockCount).toBe(3); expect(s.connections[0]!.suspended).toBe(true); });
  });
});

describe('local human approval gate — no real human identity flow claimed', () => {
  it('human-review input is private/encrypted; exact approved retry publishes once', async () => {
    h.moderation.result = 'human_review'; await h.service.subscribe(h.b, h.subscribe());
    await expect(h.service.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED' });
    const record = await decision(); await assertUnpublished();
    const review = await h.controls.reviewContent(record.id, 'owner-a'); expect(review.content.body).toBe(input().body);
    await expect(h.controls.reviewContent(record.id, 'owner-b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.controls.decideReview(record.id, 'owner-b', record.hash, 'approve')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.controls.decideReview(record.id, 'owner-a', 'wrong-hash', 'approve')).rejects.toMatchObject({ code: 'MODERATION_APPROVAL_STALE' });
    await h.controls.decideReview(record.id, 'owner-a', record.hash, 'approve');
    await assertUnpublished(); // Approval itself is not publication or event delivery.
    const results = await Promise.all([h.service.send(h.a, input()), h.service.send(h.a, input())]);
    expect(results[0]!.id).toBe(results[1]!.id); expect(results[0]!.moderation.source).toBe('human');
    await h.service.dispatchOne(); expect(h.events).toHaveLength(1);
  });
  it('rejecting a review never publishes and cannot be changed by an agent retry', async () => {
    h.moderation.result = 'human_review'; await expect(h.service.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED' });
    const r = await decision(); await h.controls.decideReview(r.id, 'owner-a', r.hash, 'reject');
    await expect(h.service.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_REJECTED' });
    await expect(h.controls.decideReview(r.id, 'owner-a', r.hash, 'approve')).rejects.toMatchObject({ code: 'MODERATION_APPROVAL_STALE' });
    await assertUnpublished();
  });
  it.each(['body', 'audience', 'policy', 'expiry', 'revoked', 'suspended', 'pause'])('rechecks %s after human approval and before publication', async change => {
    h.moderation.result = 'human_review'; await expect(h.service.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED' });
    const r = await decision(); await h.controls.decideReview(r.id, 'owner-a', r.hash, 'approve');
    let request = input();
    if (change === 'body') request = { ...request, body: 'different content' };
    if (change === 'audience') await h.store.transact(s => { s.memberships.push({ ownerId: 'new-spectator', roomId: 'shared', role: 'spectator', active: true, historyFrom: 1 }); });
    if (change === 'policy') await h.store.transact(s => { s.rooms[0]!.session.perConnectionLimit = 9; });
    if (change === 'expiry') h.advance(REVIEW_TTL_MS + 1);
    if (change === 'revoked') await h.controls.revoke('dot-a');
    if (change === 'suspended') await h.controls.suspend('dot-a', 'owner-a');
    if (change === 'pause') await h.controls.pause('shared');
    await expect(h.service.send(h.a, request)).rejects.toThrow(); await assertUnpublished();
  });
  it('bounds the per-connection private review queue without creating public messages', async () => {
    h.moderation.result = 'human_review';
    for (let i = 0; i < 5; i++) await expect(h.service.send(h.a, input(`${i}`))).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED' });
    await expect(h.service.send(h.a, input('overflow'))).rejects.toMatchObject({ code: 'REVIEW_QUEUE_LIMIT' });
    await assertUnpublished();
  });
  it('the default service requires human review and does not inherit mock allow', async () => {
    const runtime = new Playdot(h.store, { verify: async () => {}, send: async () => 204 }, secretBox(Buffer.alloc(32, 11)), h.now);
    await expect(runtime.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED', details: { moderation_source: 'human-only' } });
    const r = await decision(); await h.controls.decideReview(r.id, 'owner-a', r.hash, 'approve');
    expect((await runtime.send(h.a, input())).moderation.source).toBe('human');
    const first = (await runtime.read(h.a, { room_id: 'shared' })).messages[0]!;
    await expect(runtime.send(h.b, { ...input('second'), causation_event_id: first.event_id })).rejects.toMatchObject({ code: 'MODERATION_REVIEW_REQUIRED' });
  });
  it('runtime cannot read, replay or deliver historical mock-approved or unmoderated messages', async () => {
    await h.service.subscribe(h.b, h.subscribe()); await h.service.send(h.a, input());
    let deliveries = 0;
    const runtime = new Playdot(h.store, { verify: async () => {}, send: async () => { deliveries++; return 204; } }, secretBox(Buffer.alloc(32, 11)), h.now);
    expect((await runtime.read(h.b, { room_id: 'shared' })).messages).toEqual([]);
    await expect(runtime.send(h.a, input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await runtime.dispatchOne(); expect(deliveries).toBe(0);
    await h.store.transact(s => { delete (s.messages[0] as Partial<typeof s.messages[0]>)!.moderation; s.outbox[0]!.state = 'queued'; });
    expect((await h.service.read(h.b, { room_id: 'shared' })).messages).toEqual([]);
    await h.service.dispatchOne(); expect(h.events).toHaveLength(0);
  });
  it('a manual-only adapter cannot auto-allow through an accidental result', async () => {
    const runtime = new Playdot(h.store, { verify: async () => {}, send: async () => 204 }, secretBox(Buffer.alloc(32, 11)), h.now, { ...humanOnlyModeration, evaluate: async () => 'allow' });
    await expect(runtime.send(h.a, input())).rejects.toMatchObject({ code: 'MODERATION_FILTER_ERROR' }); await assertUnpublished();
  });
});
