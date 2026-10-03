import { beforeEach, afterEach, it, expect } from 'vitest';
import { harness } from './harness.js';
import { Pilot, type Human, type PilotConfig } from '../packages/domain/src/pilot.js';
import { secretBox } from '../apps/server/src/callback.js';
import { Playdot } from '../packages/domain/src/service.js';
import { buildApp } from '../apps/server/src/app.js';
import { Fault, type Principal } from '../packages/domain/src/model.js';
import type { LoginAttempt } from '../apps/server/src/owner.js';
let h: Awaited<ReturnType<typeof harness>>;
let pilot: Pilot; let service: Playdot;
let a: Human, b: Human, pa: Principal, pb: Principal;
let sent = 0;
const config: PilotConfig = { issuer:'https://real-provider.invalid/realms/playdot',ownerClientId:'playdot-owner',roomId:'pilot',privateRoomId:'pilot-private',topic:'Invent a friendly name and one-sentence description for a fictional garden robot. No links, personal data or external actions.',owners:[{id:'owner-gary',subject:'person-a',connectionId:'gary',mcpClientId:'mcp-a',label:'Gary owner'},{id:'owner-friend',subject:'person-b',connectionId:'friend',mcpClientId:'mcp-b',label:'Friend owner'}] };
const request = (key='opener', cause?:string) => ({ room_id:'pilot',session_id:'',body:'<script>Untrusted fixture</script>',idempotency_key:key,...(cause?{causation_event_id:cause}:{}) });
async function input(key='opener',cause?:string) { return { ...request(key,cause),session_id:await h.store.transact(s=>s.rooms.find(r=>r.id==='pilot')!.session.id) }; }
async function ready() { await pilot.consent(a,pilot.configHash,(await input()).session_id); await pilot.consent(b,pilot.configHash,(await input()).session_id); }
async function propose(p=pa,key='opener',cause?:string) {
  await expect(service.send(p,await input(key,cause))).rejects.toMatchObject({code:'MODERATION_REVIEW_REQUIRED'});
  return h.store.transact(s=>s.moderation.at(-1)!);
}
beforeEach(async()=>{
  h=await harness(); sent=0;
  const secrets=secretBox(Buffer.alloc(32,11));
  service=new Playdot(h.store,{verify:async()=>{},send:async()=>{sent++;return 204;}},secrets,h.now);
  pilot=new Pilot(h.store,config,secrets,service,h.now); await pilot.initialize();
  a={issuer:config.issuer,subject:'person-a',clientId:config.ownerClientId,expiresAt:h.now()+600000};b={...a,subject:'person-b'};
  pa={...a,clientId:'mcp-a',scopes:['room:read','message:write','events:subscribe']};pb={...b,clientId:'mcp-b',scopes:[...pa.scopes]};
});
afterEach(async()=>{await h?.close();});
it('requires two distinct owner consents and does not enroll an MCP caller',async()=>{
  await expect(service.status(pa)).rejects.toMatchObject({code:'CONNECTION_NOT_AUTHORIZED'});
  await expect(pilot.consent(pa,pilot.configHash,(await input()).session_id)).rejects.toMatchObject({code:'HUMAN_AUTH_REQUIRED'});
  await pilot.consent(a,pilot.configHash,(await input()).session_id); await expect(service.send(pa,await input())).rejects.toMatchObject({code:'SESSION_PAUSED'});
  await pilot.consent(b,pilot.configHash,(await input()).session_id); expect((await service.room(pa,{room_id:'pilot'})).session.state).toBe('active');
  await expect(service.read(pb,{room_id:'pilot-private'})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await pilot.evidence(b)).controls.rooms.map(r=>r.id)).toEqual(['pilot']);
});
it('keeps approval separate from publication and attributes both event-driven proposals to their dot',async()=>{
  await ready(); await service.subscribe(pb,{name:'room.message.created',arguments:{room_id:'pilot'},delivery:{mode:'webhook',url:'https://fixture.invalid',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  const d=await propose(); await expect(pilot.decide(b,d.id,d.hash,d.contextHash,'approve')).rejects.toMatchObject({code:'NOT_FOUND'});
  await pilot.decide(a,d.id,d.hash,d.contextHash,'approve'); expect((await service.read(pb,{room_id:'pilot'})).messages).toHaveLength(0);expect(await service.dispatchOne()).toBe(false);
  const first=await pilot.publish(a,d.id);expect(first.author_connection_id).toBe('gary');await service.dispatchOne();expect(sent).toBe(1);
  const reply=await propose(pb,'reply',first.event_id);await pilot.decide(b,reply.id,reply.hash,reply.contextHash,'approve');const second=await pilot.publish(b,reply.id);expect(second.author_connection_id).toBe('friend');
  const duplicate=await service.send(pb,await input('reply',first.event_id));expect(duplicate.id).toBe(second.id);
  const evidence=await pilot.evidence(a);expect(evidence.deliveries[0]?.repliedMessageId).toBe(second.id);expect(JSON.stringify(evidence)).not.toContain('Untrusted fixture');expect(JSON.stringify(evidence)).not.toContain('person-a');expect(evidence.status).toContain('NOT_PASSED');
});
it('revocation invalidates old tokens and approved proposals and cancels queued delivery',async()=>{
  await ready();await service.subscribe(pb,{name:'room.message.created',arguments:{room_id:'pilot'},delivery:{mode:'webhook',url:'https://fixture.invalid',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  await pilot.deliveryHold(a,true);
  const d=await propose();await pilot.decide(a,d.id,d.hash,d.contextHash,'approve');await pilot.publish(a,d.id);
  expect(await service.dispatchOne()).toBe(false);expect(await h.store.transact(s=>s.outbox.some(x=>x.state==='queued'))).toBe(true);
  const r=await propose(pb,'reply',(await service.read(pa,{room_id:'pilot'})).messages[0]!.event_id);await pilot.decide(b,r.id,r.hash,r.contextHash,'approve');await pilot.revoke(b);await pilot.deliveryHold(a,false);
  await expect(pilot.publish(b,r.id)).rejects.toMatchObject({code:'CONNECTION_NOT_AUTHORIZED'});
  await expect(service.read(pb,{room_id:'pilot'})).rejects.toMatchObject({code:'CONNECTION_NOT_AUTHORIZED'});await expect(service.canSubscribe(pb)).rejects.toMatchObject({code:'CONNECTION_NOT_AUTHORIZED'});
  await expect(pilot.consent(b,pilot.configHash,(await input()).session_id)).rejects.toMatchObject({code:'CONNECTION_REVOKED_OR_SUSPENDED'});expect(await service.dispatchOne()).toBe(false);expect(sent).toBe(0);
});
it('rejects stale context, changed content, pause at publication',async()=>{
  await ready();const d=await propose();await expect(pilot.decide(a,d.id,d.hash,'wrong','approve')).rejects.toMatchObject({code:'MODERATION_APPROVAL_STALE'});
  await pilot.decide(a,d.id,d.hash,d.contextHash,'approve');await expect(service.send(pa,{...await input(),body:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await pilot.pause(a);await expect(pilot.publish(a,d.id)).rejects.toMatchObject({code:'SESSION_PAUSED'});expect(sent).toBe(0);
});
it('a fresh session requires both owners again and never resets suspension or revocation',async()=>{
  await ready();const oldSession=(await input()).session_id;await pilot.pause(a);await pilot.newSession(a);await expect(pilot.consent(a,pilot.configHash,oldSession)).rejects.toMatchObject({code:'CONSENT_STALE'});await pilot.consent(a,pilot.configHash,(await input()).session_id);expect((await service.room(pa,{room_id:'pilot'})).session.state).toBe('paused');await pilot.consent(b,pilot.configHash,(await input()).session_id);expect((await service.room(pa,{room_id:'pilot'})).session.state).toBe('active');
});
it('rejecting exact proposals creates no message or delivery and persists three strikes',async()=>{
  await ready();for(let n=0;n<3;n++){const d=await propose(pa,'reject-'+n);await pilot.decide(a,d.id,d.hash,d.contextHash,'reject');}
  await expect(service.status(pa)).rejects.toMatchObject({code:'CONNECTION_SUSPENDED'});expect((await service.read(pb,{room_id:'pilot'})).messages).toHaveLength(0);expect(sent).toBe(0);
});
it('owner HTTP flow rejects bearer impersonation, wrong state and CSRF, and escapes proposal text',async()=>{
  await ready();await propose();let attempt:LoginAttempt|undefined;
  const app=buildApp({service,authenticate:async()=>{throw new Fault('UNAUTHORIZED',401);},resource:'https://playdot.bytedev.app/mcp',issuer:config.issuer,owner:{pilot,origin:'https://playdot.bytedev.app',now:h.now,login:{begin:async x=>{attempt=x;return 'https://provider.invalid/login';},finish:async()=>a}}});
  try{
    expect((await app.inject({url:'/owner',headers:{authorization:'Bearer fake'}})).statusCode).toBe(401);
    const start=await app.inject('/owner/login');const loginCookie=String(start.headers['set-cookie']).split(';')[0]!;
    const bad=await app.inject({url:'/owner/callback?state=wrong',headers:{cookie:loginCookie}});expect(bad.statusCode).toBe(401);
    const start2=await app.inject('/owner/login');const finish=await app.inject({url:'/owner/callback?code=fixture&state='+attempt!.state,headers:{cookie:String(start2.headers['set-cookie']).split(';')[0]!}});
    const cookies=finish.headers['set-cookie'] as string[];const ownerCookie=cookies.find(x=>x.startsWith('__Host-playdot-owner='))!.split(';')[0]!;
    const page=await app.inject({url:'/owner',headers:{cookie:ownerCookie}});expect(page.statusCode).toBe(200);expect(page.body).toContain('&lt;script&gt;');expect(page.body).not.toContain('<script>');
    const csrf=page.body.match(/name="csrf" value="([^"]+)"/)![1]!;
    expect((await app.inject({method:'POST',url:'/owner/action',headers:{cookie:ownerCookie,origin:'https://evil.invalid'},payload:{csrf,action:'pause'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/owner/action',headers:{cookie:ownerCookie,origin:'https://playdot.bytedev.app'},payload:{csrf:'wrong',action:'pause'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/owner/action',headers:{cookie:ownerCookie,origin:'https://playdot.bytedev.app'},payload:{csrf,action:'pause'}})).statusCode).toBe(303);
    expect((await service.room(pa,{room_id:'pilot'})).session.state).toBe('paused');
  }finally{await app.close();}
});

it('rejects expired original authorization even while the reviewer remains signed in',async()=>{
  await ready();pa.expiresAt=h.now()+1000;const d=await propose();await pilot.decide(a,d.id,d.hash,d.contextHash,'approve');h.advance(2000);
  await expect(pilot.publish(a,d.id)).rejects.toMatchObject({code:'UNAUTHORIZED'});
  expect((await service.read(pb,{room_id:'pilot'})).messages).toHaveLength(0);expect(await service.dispatchOne()).toBe(false);
});
it('keeps consent and revocation when services are reconstructed from stored state',async()=>{
  await ready();await pilot.revoke(b);
  const secrets=secretBox(Buffer.alloc(32,11));const restarted=new Playdot(h.store,{verify:async()=>{},send:async()=>204},secrets,h.now);
  const controls=new Pilot(h.store,config,secrets,restarted,h.now);await controls.initialize();
  expect((await controls.dashboard(a)).consents).toBe(2);
  await expect(restarted.read(pb,{room_id:'pilot'})).rejects.toMatchObject({code:'CONNECTION_NOT_AUTHORIZED'});
  await expect(controls.consent(b,controls.configHash,(await input()).session_id)).rejects.toMatchObject({code:'CONNECTION_REVOKED_OR_SUSPENDED'});
});
