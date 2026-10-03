import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { harness } from './harness.js';
import { createRuntime } from '../apps/server/src/runtime.js';
import { runtimeSettings } from '../apps/server/src/config.js';
import { jwtAuthenticator } from '../apps/server/src/auth.js';
import { Playdot } from '../packages/domain/src/service.js';
import { secretBox } from '../apps/server/src/callback.js';
import { PROTOCOL } from '../packages/contracts/src/index.js';
const issuer='https://playdot-auth.bytedev.app/realms/playdot',resource='https://playdot.bytedev.app/mcp';
let h:Awaited<ReturnType<typeof harness>>, runtime:Awaited<ReturnType<typeof createRuntime>>;
let token:(overrides?:Record<string,unknown>)=>Promise<string>;
beforeEach(async()=>{
  h=await harness();
  for(const [key,value] of Object.entries({PLAYDOT_MODE:'oidc',PLAYDOT_ENABLE_REAL_ROOMS:'no',PLAYDOT_ENABLE_EVENTS:'no',CALLBACK_ALLOWED_HOSTS:'',OIDC_ISSUER:issuer,OIDC_JWKS_URL:issuer+'/protocol/openid-connect/certs',MCP_RESOURCE:resource,OIDC_SETUP_CLIENT_IDS:'playdot-gary,playdot-friend',SUBSCRIPTION_KEY_BASE64_FILE:'/does-not-exist',PLAYDOT_PILOT_CONFIG_FILE:'/does-not-exist'}))vi.stubEnv(key,value);
  const keys=await generateKeyPair('RS256');const jwk={...await exportJWK(keys.publicKey),kid:'test'};
  token=async(overrides={})=>new SignJWT({iss:issuer,aud:resource,sub:'new-owner',azp:'playdot-gary',scope:'room:read message:write events:subscribe',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(keys.privateKey);
  runtime=await createRuntime(h.store,async()=>{},jwtAuthenticator({issuer,audience:resource,keys:createLocalJWKSet({keys:[jwk]})}));
});
afterEach(async()=>{await runtime?.app.close();await h?.close();vi.unstubAllEnvs();});
async function rpc(method:string,params:unknown={},bearer?:string){const r=await runtime.app.inject({method:'POST',url:'/mcp',headers:bearer?{authorization:'Bearer '+bearer}:{},payload:{jsonrpc:'2.0',id:1,method,params}});return {response:r,body:r.json()};}
it('starts the production runtime assembly without pilot configuration, encryption key or callback allowlist',async()=>{
  expect((await runtime.app.inject('/health')).json()).toMatchObject({mode:'oidc',stage:'0B-oauth-setup',real_rooms_enabled:false,events_enabled:false,worker_enabled:false,real_dot_verified:false});
  expect((await runtime.app.inject('/ready')).statusCode).toBe(200);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'])expect((await runtime.app.inject(path)).json()).toMatchObject({resource,authorization_servers:[issuer]});
  expect((await runtime.app.inject('/owner/login')).statusCode).toBe(404);
});
it('returns the OAuth challenge for unauthenticated GET and POST and rejects invalid token claims',async()=>{
  for(const method of ['GET','POST'] as const){const r=await runtime.app.inject({method,url:'/mcp',...(method==='POST'?{payload:{jsonrpc:'2.0',id:1,method:'tools/list'}}:{})});expect(r.statusCode).toBe(401);expect(r.headers['www-authenticate']).toBe('Bearer resource_metadata="https://playdot.bytedev.app/.well-known/oauth-protected-resource"');}
  for(const override of [{iss:'https://wrong.invalid'},{aud:'wrong'},{exp:1}])expect((await rpc('tools/list',{},await token(override))).response.statusCode).toBe(401);
  for(const override of [{azp:'unapproved-client'},{scope:'message:write'}])expect((await rpc('tools/list',{},await token(override))).body.error.data.code).toBe('FORBIDDEN');
});
it('allows authenticated MCP metadata before consent without enrolling an owner or granting room access',async()=>{
  const before=await h.store.transact(s=>JSON.stringify(s));const bearer=await token();
  expect((await rpc('initialize',{protocolVersion:PROTOCOL},bearer)).body.result.capabilities).toEqual({tools:{}});
  expect((await rpc('tools/list',{},bearer)).body.result.tools).toHaveLength(4);
  expect((await rpc('events/list',{},bearer)).body.result.events).toEqual([]);
  for(const name of ['playdot_get_room','playdot_read_messages','playdot_send_message'])expect((await rpc('tools/call',{name,arguments:{room_id:'shared'}},bearer)).body.result.structuredContent.code).toBe('REAL_ROOMS_DISABLED');
  expect((await rpc('events/subscribe',h.subscribe(),bearer)).body.error.data.code).toBe('EVENTS_DISABLED');
  expect(await h.store.transact(s=>JSON.stringify(s))).toBe(before);
});
it('continues to reject a known revoked binding during setup discovery',async()=>{
  await h.store.transact(s=>{s.connections.push({id:'real-test',ownerId:'owner-test',issuer,subject:'new-owner',clientId:'playdot-gary',active:false,scopes:['room:read']});});
  expect((await rpc('tools/list',{},await token())).body.error.data.code).toBe('CONNECTION_NOT_AUTHORIZED');
});
it('disables existing queued dispatch and callback verification in both setup and events-disabled real-room policy',async()=>{
  await h.service.subscribe(h.b,h.subscribe());
  await h.service.send(h.a,{room_id:'shared',session_id:'session-shared',body:'Fixture',idempotency_key:'queued'});
  const before=await h.store.transact(s=>JSON.stringify(s.outbox));expect(JSON.parse(before)).toHaveLength(1);
  const callback={verify:vi.fn(async()=>{}),send:vi.fn(async()=>204)};
  const service=new Playdot(h.store,callback,secretBox(Buffer.alloc(32,11)),h.now,undefined,{roomsEnabled:true,eventsEnabled:false});
  await expect(service.subscribe(h.b,h.subscribe())).rejects.toMatchObject({code:'EVENTS_DISABLED'});
  expect(await service.canSubscribe(h.b)).toBe(false);expect(await service.dispatchOne()).toBe(false);expect(await runtime.service.dispatchOne()).toBe(false);
  expect(callback.verify).not.toHaveBeenCalled();expect(callback.send).not.toHaveBeenCalled();expect(await h.store.transact(s=>JSON.stringify(s.outbox))).toBe(before);
  await h.controls.revoke('dot-b');expect(await service.dispatchOne()).toBe(false);expect(callback.send).not.toHaveBeenCalled();
});
it('requires real-room approval, an explicit event flag and a nonempty valid allowlist together',async()=>{
  vi.stubEnv('PLAYDOT_ENABLE_EVENTS','yes');expect((await runtimeSettings()).eventsEnabled).toBe(false);
  vi.stubEnv('PLAYDOT_ENABLE_REAL_ROOMS','yes');expect((await runtimeSettings()).eventsEnabled).toBe(false);
  vi.stubEnv('CALLBACK_ALLOWED_HOSTS','receiver.fixture.invalid');expect((await runtimeSettings()).eventsEnabled).toBe(true);
  vi.stubEnv('PLAYDOT_ENABLE_EVENTS','no');expect((await runtimeSettings()).eventsEnabled).toBe(false);
  vi.stubEnv('CALLBACK_ALLOWED_HOSTS','*.fixture.invalid');await expect(runtimeSettings()).rejects.toThrow();
});
