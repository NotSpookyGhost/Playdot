import assert from 'node:assert/strict';
import { secretBox } from '../apps/server/src/callback.js';
import { Playdot } from '../packages/domain/src/service.js';
import type { Principal, Store } from '../packages/domain/src/model.js';
import { fixtureState, fixtureIssuer, fixtureClient, localControls } from '../scripts/local-controls.js';
import { scopes } from '../packages/contracts/src/index.js';
import { Pilot, type PilotConfig } from '../packages/domain/src/pilot.js';
import { MockModeration } from './mock-moderation.js';

// Synthetic, fixed-clock fixtures only. This key is public test data, never a
// runtime key. No real token, reviewer identity, callback or network delivery.
const secrets = secretBox(Buffer.alloc(32, 11));
const principal = (suffix: string, now: number): Principal => ({ issuer: fixtureIssuer, subject: `subject-${suffix}`, clientId: fixtureClient, scopes: [...scopes], expiresAt: now + 3600000 });
const input = (room: string, key: string) => ({ room_id: room, session_id: `session-${room}`, body: `Synthetic restart verification ${key}`, idempotency_key: key });
const callback = { verify: async () => {}, send: async () => { throw new Error('No outbound callbacks in restart proof'); } };

const pilotConfig: PilotConfig = {issuer:'https://restart.fixture.invalid',ownerClientId:'owner-client',roomId:'pilot-restart',privateRoomId:'pilot-private',topic:'Invent a friendly name and one-sentence description for a fictional garden robot. No links, personal data or external actions.',owners:[{id:'pilot-owner-a',subject:'pilot-a',connectionId:'pilot-a',mcpClientId:'mcp-a',label:'A'},{id:'pilot-owner-b',subject:'pilot-b',connectionId:'pilot-b',mcpClientId:'mcp-b',label:'B'}]};
const humanIdentity=(subject:string,now:number)=>({issuer:pilotConfig.issuer,subject,clientId:'owner-client',expiresAt:now+600000});

export async function prepareRestart(store: Store, now: number) {
  await store.transact(s => {
    for (const value of Object.values(s)) assert.ok(Array.isArray(value) && value.length === 0, 'Refuse to seed nonempty state');
    Object.assign(s, fixtureState(now));
    for (const name of ['review', 'error']) {
      const room = structuredClone(s.rooms[0]!); room.id = name; room.session.id = `session-${name}`;
      if (name === 'error') room.session.starter = 'dot-b';
      s.rooms.push(room);
      s.memberships.push(...s.memberships.filter(m => m.roomId === 'shared').map(m => ({ ...m, roomId: name })));
      s.grants.push(...s.grants.filter(g => g.roomId === 'shared').map(g => ({ ...g, roomId: name })));
    }
    s.connections.push({ ...s.connections[0]!, id: 'dot-c', ownerId: 'owner-c', subject: 'subject-c' });
    const block = structuredClone(s.rooms[0]!); block.id = 'block'; block.ownerId = 'owner-c'; block.session.id = 'session-block'; block.session.starter = 'dot-c';
    s.rooms.push(block);
    s.memberships.push({ ownerId: 'owner-c', roomId: 'block', role: 'member', active: true, historyFrom: 1 });
    s.grants.push({ connectionId: 'dot-c', roomId: 'block', active: true, scopes: [...scopes] });
  });
  const human = new Playdot(store, callback, secrets, () => now);
  const controls = localControls(store, () => now, secrets);
  const a = principal('a', now), b = principal('b', now), c = principal('c', now);
  await human.subscribe(b, { name: 'room.message.created', arguments: { room_id: 'shared' }, delivery: { mode: 'webhook', url: 'https://fixture.invalid/events', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` } });
  const propose = async (room: string, key: string) => {
    await assert.rejects(human.send(a, input(room, key)), { code: 'MODERATION_REVIEW_REQUIRED' });
    return store.transact(s => s.moderation.at(-1)!);
  };
  const first = await propose('shared', 'accepted');
  await controls.decideReview(first.id, 'owner-a', first.hash, 'approve');
  await human.send(a, input('shared', 'accepted'));
  await propose('review', 'pending');
  const approved = await propose('review', 'approved-unpublished');
  await controls.decideReview(approved.id, 'owner-a', approved.hash, 'approve');
  const rejected = await propose('review', 'rejected');
  await controls.decideReview(rejected.id, 'owner-a', rejected.hash, 'reject');
  const moderator = new MockModeration(); moderator.result = 'block';
  const mock = new Playdot(store, callback, secrets, () => now, moderator);
  for (let i = 0; i < 3; i++) await assert.rejects(mock.send(c, input('block', `blocked-${i}`)), { code: 'MODERATION_BLOCKED' });
  moderator.result = 'filter_error';
  await assert.rejects(mock.send(b, input('error', 'error')), { code: 'MODERATION_FILTER_ERROR' });
  await controls.revoke('dot-b');
  const pilot = new Pilot(store,pilotConfig,secrets,human,()=>now); await pilot.initialize();
  const ownerA=humanIdentity('pilot-a',now),ownerB=humanIdentity('pilot-b',now);
  const session=await store.transact(s=>s.rooms.find(r=>r.id==='pilot-restart')!.session.id);
  await pilot.consent(ownerA,pilot.configHash,session);await pilot.consent(ownerB,pilot.configHash,session);
  await assert.rejects(human.send({...ownerA,clientId:'mcp-a',scopes:[...scopes]},{room_id:'pilot-restart',session_id:session,body:'Synthetic pilot restart proposal',idempotency_key:'pilot-pending'}),{code:'MODERATION_REVIEW_REQUIRED'});
  const review=await store.transact(s=>s.moderation.at(-1)!);await pilot.decide(ownerA,review.id,review.hash,review.contextHash,'approve');await pilot.revoke(ownerB);
  await verifyRestart(store, now);
}

export async function verifyRestart(store: Store, now: number, includePilot = true) {
  let deliveries = 0;
  const service = new Playdot(store, { ...callback, send: async () => { deliveries++; return 204; } }, secrets, () => now);
  const a = principal('a', now), b = principal('b', now), c = principal('c', now);
  assert.equal((await service.read(a, { room_id: 'shared' })).messages.length, 1);
  assert.equal((await service.read(a, { room_id: 'review' })).messages.length, 0);
  await assert.rejects(service.read(a, { room_id: 'block' }), { code: 'NOT_FOUND' });
  await assert.rejects(service.read(b, { room_id: 'shared' }), { code: 'CONNECTION_NOT_AUTHORIZED' });
  await assert.rejects(service.send(b, input('shared', 'revoked')), { code: 'CONNECTION_NOT_AUTHORIZED' });
  await assert.rejects(service.canSubscribe(b), { code: 'CONNECTION_NOT_AUTHORIZED' });
  await assert.rejects(service.read(c, { room_id: 'block' }), { code: 'CONNECTION_SUSPENDED' });
  await assert.rejects(service.send(a, input('review', 'pending')), { code: 'MODERATION_APPROVAL_STALE' });
  // Revoked audience invalidates a previously approved but unpublished proposal.
  await assert.rejects(service.send(a, input('review', 'approved-unpublished')), { code: 'MODERATION_APPROVAL_STALE' });
  const before = await store.transact(s => s.messages[0]!.id);
  assert.equal((await service.send(a, input('shared', 'accepted'))).id, before);
  assert.equal(await service.dispatchOne(), false); assert.equal(deliveries, 0);
  if (includePilot) {
  const pilot=new Pilot(store,pilotConfig,secrets,service,()=>now);await pilot.initialize();
  assert.equal((await pilot.dashboard(humanIdentity('pilot-a',now))).consents,2);
  await assert.rejects(service.read({...humanIdentity('pilot-b',now),clientId:'mcp-b',scopes:[...scopes]},{room_id:'pilot-restart'}),{code:'CONNECTION_NOT_AUTHORIZED'});
  const review=await store.transact(s=>s.moderation.find(d=>d.key==='pilot-pending')!);
  assert.equal(review.outcome,'approved');assert.ok(review.encryptedInput);assert.equal(review.reviewerOwnerId,'pilot-owner-a');
  await assert.rejects(pilot.publish(humanIdentity('pilot-a',now),review.id),{code:'MODERATION_APPROVAL_STALE'});
  }
  await store.transact(s => {
    assert.equal(s.messages.length, 1); assert.equal(s.idempotency.length, 1);
    assert.equal(s.messages[0]!.moderation.source, 'human');
    assert.equal(s.outbox.length, 1); assert.equal(s.outbox[0]!.state, 'cancelled');
    assert.equal(s.subscriptions[0]!.active, false);
    assert.equal(s.connections.find(cn => cn.id === 'dot-c')!.blockCount, 3);
    assert.equal(s.connections.find(cn => cn.id === 'dot-c')!.suspended, true);
    const pending = s.moderation.find(m => m.key === 'pending')!;
    assert.equal(pending.outcome, 'human_review');
    assert.equal(JSON.parse(secrets.open(pending.encryptedInput!)).body, input('review', 'pending').body);
    assert.equal(s.moderation.find(m => m.key === 'approved-unpublished')!.outcome, 'approved');
    assert.equal(s.moderation.find(m => m.key === 'rejected')!.outcome, 'rejected');
    assert.equal(s.moderation.find(m => m.key === 'error')!.outcome, 'filter_error');
    for (const room of s.rooms.filter(r => ['block', 'review', 'error'].includes(r.id))) { assert.equal(room.seq, 0); assert.equal(room.session.total, 0); }
    assert.equal(s.rooms.find(r => r.id === 'block')!.session.reason, 'REPEATED_BLOCKS');
    assert.equal(s.rooms.find(r => r.id === 'error')!.session.reason, 'FILTER_ERROR');
  });
}
