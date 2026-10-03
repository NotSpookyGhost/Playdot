import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, errors } from 'jose';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.js';
import { buildApp } from '../apps/server/src/app.js';
import { jwtAuthenticator, type Authenticate } from '../apps/server/src/auth.js';
import { diagnostic, sanitizedDiagnostic, diagnosticReasons, type Phase } from '../apps/server/src/diagnostics.js';
import { Playdot } from '../packages/domain/src/service.js';
import { PROTOCOL, SUPPORTED_PROTOCOLS } from '../packages/contracts/src/index.js';
const issuer = 'https://playdot-auth.bytedev.app/realms/playdot', resource = 'https://playdot.bytedev.app/mcp';
const marker = 'PRIVATE_SENTINEL_NEVER_LOG';
let h: Awaited<ReturnType<typeof harness>>, app: ReturnType<typeof buildApp>, logs: string[];
let token: (overrides?: Record<string, unknown>) => Promise<string>;
let authenticate: Authenticate;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
function makeApp(auth = authenticate) {
  const service = new Playdot(h.store, { verify: async () => { throw Error(marker); }, send: async () => { throw Error(marker); } }, { seal: () => { throw Error(marker); }, open: () => { throw Error(marker); } }, Date.now, undefined, { roomsEnabled: false, eventsEnabled: false });
  return buildApp({ service, authenticate: auth, resource, issuer, mode: 'oidc', realRooms: false, discoveryClientIds: ['playdot-gary'], diagnosticSink: line => logs.push(line) });
}
beforeEach(async () => {
  h = await harness(); logs = [];
  keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test' };
  token = async (overrides = {}) => new SignJWT({ iss: issuer, aud: resource, sub: marker, azp: 'playdot-gary', scope: 'room:read', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(keys.privateKey);
  authenticate = jwtAuthenticator({ issuer, audience: resource, keys: createLocalJWKSet({ keys: [jwk] }) });
  app = makeApp();
});
afterEach(async () => { await app?.close(); await h?.close(); vi.restoreAllMocks(); });
async function rpc(method: string, params: object = {}, version?: string, bearer?: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/mcp?private='+marker, headers: { authorization: 'Bearer '+(bearer ?? await token()), 'x-request-id': marker, cookie: marker, ...(version ? { 'mcp-protocol-version': version } : {}), ...headers }, payload: { jsonrpc: '2.0', id: marker, method, params } });
}
function modernMeta() { return { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: marker, version: marker }, 'io.modelcontextprotocol/clientCapabilities': {} }; }
function checkRedaction() {
  expect(logs.length).toBeGreaterThan(0);
  for (const line of logs) {
    expect(line).not.toContain(marker);
    const entry = JSON.parse(line);
    expect(Object.keys(entry).sort()).toEqual(['correlation_id', 'phase', 'reason']);
    expect(entry.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(diagnosticReasons[entry.phase as Phase]).toContain(entry.reason);
  }
}
it.each(SUPPORTED_PROTOCOLS.slice(1))('discovers tools for an unbound user using legacy %s without state changes', async version => {
  const before = await h.store.transact(s => JSON.stringify(s));
  const init = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: marker, version: marker } });
  expect(init.json().result.protocolVersion).toBe(version);
  const notified = await app.inject({ method:'POST', url:'/mcp', headers:{authorization:'Bearer '+await token(),'mcp-protocol-version':version}, payload:{jsonrpc:'2.0',method:'notifications/initialized'} });
  expect(notified.statusCode).toBe(202); expect(notified.body).toBe('');
  const result = await rpc('tools/list', { _meta: { progressToken: marker } }, version);
  expect(result.statusCode).toBe(200); expect(result.json().result.tools).toHaveLength(4);
  for (const tool of result.json().result.tools) expect(tool.inputSchema.type).toBe('object');
  expect(await h.store.transact(s => JSON.stringify(s))).toBe(before);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain('TOOLS_LIST_OK'); checkRedaction();
});
it('negotiates a supported legacy fallback rather than rejecting initialize', async () => {
  expect((await rpc('initialize', {protocolVersion: 'unknown-'+marker})).json().result.protocolVersion).toBe('2025-11-25');
  checkRedaction();
});
it('returns complete modern discovery and tool results with identity and standard metadata', async () => {
  const before = await h.store.transact(s=>JSON.stringify(s));
  for (const method of ['server/discover','tools/list']) {
    const r = await rpc(method, {_meta: modernMeta()}, PROTOCOL, undefined, {'mcp-method':method});
    expect(r.statusCode).toBe(200);expect(r.json().result.resultType).toBe('complete');
    if (method==='server/discover') expect(r.json().result).toMatchObject({supportedVersions:SUPPORTED_PROTOCOLS,capabilities:{tools:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'playdot',version:'0.0.1'}}});
    else expect(r.json().result.tools).toHaveLength(4);
  }
  const blocked = await rpc('tools/call',{_meta:modernMeta(),name:'playdot_get_room',arguments:{room_id:marker}},PROTOCOL,undefined,{'mcp-method':'tools/call','mcp-name':'playdot_get_room'});
  expect(blocked.json().result).toMatchObject({resultType:'complete',isError:true,structuredContent:{code:'REAL_ROOMS_DISABLED'}});
  expect(await h.store.transact(s=>JSON.stringify(s))).toBe(before);checkRedaction();
});
it('returns actionable version and header errors without logging client input',async()=>{
  const bad = await rpc('tools/list',{},'unknown-'+marker);
  expect(bad.statusCode).toBe(400);expect(bad.json().error).toMatchObject({code:-32022,data:{supported:SUPPORTED_PROTOCOLS}});
  const mismatch=await rpc('tools/list',{_meta:modernMeta()},PROTOCOL,undefined,{'mcp-method':marker});
  expect(mismatch.statusCode).toBe(400);expect(mismatch.json().error.code).toBe(-32020);
  expect((await rpc('tools/list',{_meta:modernMeta()})).statusCode).toBe(400);
  const unknown=await rpc(marker,{_meta:modernMeta()},PROTOCOL,undefined,{'mcp-method':marker});
  expect(unknown.statusCode).toBe(404);expect(unknown.json().error.code).toBe(-32601);checkRedaction();
});
it.each([
  [{aud:'playdot-resource'},'TOKEN_AUDIENCE'], [{iss:marker},'TOKEN_ISSUER'], [{exp:1},'TOKEN_EXPIRED'],
  [{azp:undefined},'TOKEN_CLIENT_INVALID'], [{scope:undefined},'TOKEN_SCOPE_INVALID'], [{scope:123},'TOKEN_SCOPE_INVALID'], [{client_id:'different'},'TOKEN_CLIENT_AMBIGUOUS'], [{sub:undefined},'TOKEN_SUBJECT_INVALID'], [{sub:null},'TOKEN_SUBJECT_INVALID'], [{sub:123},'TOKEN_SUBJECT_INVALID'], [{iat:undefined},'TOKEN_IAT_INVALID'], [{exp:undefined},'TOKEN_EXP_INVALID'], [{nbf:9999999999},'TOKEN_NBF_INVALID'],[{azp:marker},'CLIENT_DENIED'],[{scope:'message:write'},'SCOPE_DENIED']
] as const)('classifies token and authorization failures safely: %s',async(overrides,reason)=>{
  const bearer=await token(overrides);const r=await rpc('tools/list',{},undefined,bearer);
  expect(r.json().error).toBeDefined();expect(logs.map(x=>JSON.parse(x).reason)).toContain(reason);
  expect(logs.join('')).not.toContain(bearer);checkRedaction();
});
it('accepts the exact resource in an audience array but still blocks known revoked bindings',async()=>{
  const bearer=await token({aud:['playdot-resource',resource]});
  expect((await rpc('tools/list',{},undefined,bearer)).json().result.tools).toHaveLength(4);
  await h.store.transact(s=>{s.connections.push({id:'fixture',issuer,subject:marker,clientId:'playdot-gary',ownerId:marker,active:false,scopes:['room:read']});});
  expect((await rpc('tools/list',{},undefined,bearer)).json().error.message).toBe('CONNECTION_NOT_AUTHORIZED');
  expect(logs.map(x=>JSON.parse(x).reason)).toContain('CONNECTION_DENIED');checkRedaction();
});
it.each([['timeout','JWKS_TIMEOUT'],['missing','JWKS_KEY_UNAVAILABLE'],['network','JWKS_FETCH_FAILED']])('distinguishes JWKS %s without raw errors',async(kind,reason)=>{
  await app.close(); app=makeApp(jwtAuthenticator({issuer,audience:resource,keys:async()=>{throw kind==='timeout'?new errors.JWKSTimeout(marker):kind==='missing'?new errors.JWKSNoMatchingKey(marker):new Error(marker);}}));
  expect((await rpc('tools/list')).statusCode).toBe(401);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain(reason);checkRedaction();
});
it('redacts signatures, malformed JSON, origin, invalid params, internal failures and spoofed IDs',async()=>{
  const stdout=vi.spyOn(console,'log').mockImplementation(()=>{}),stderr=vi.spyOn(console,'error').mockImplementation(()=>{});
  const bearer=await token(); const parts=bearer.split('.');parts[2]=(parts[2]![0]==='a'?'b':'a')+parts[2]!.slice(1);
  expect((await rpc('tools/list',{},undefined,parts.join('.'))).statusCode).toBe(401);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain('TOKEN_SIGNATURE');
  await rpc('tools/list',{unexpected:marker});
  await rpc('tools/list',{},undefined,undefined,{origin:'https://'+marker+'.invalid'});
  const r=await app.inject({method:'POST',url:'/mcp?'+marker,headers:{'content-type':'application/json','x-request-id':marker,cookie:marker},payload:'{"'+marker});
  expect(r.statusCode).toBe(400);expect(r.body).not.toContain(marker);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain('HTTP_JSON_INVALID');
  await app.close();app=makeApp();vi.spyOn(h.store,'transact').mockRejectedValueOnce(new Error(marker));
  expect((await rpc('tools/list')).statusCode).toBe(500);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain('INTERNAL_FAILURE');
  expect(stdout).not.toHaveBeenCalled();expect(stderr).not.toHaveBeenCalled();checkRedaction();
});
it('only emits predefined phase/reason pairs and survives sink failure',()=>{
  const d=diagnostic(line=>logs.push(line));
  d.emit('token','TOKEN_OK');d.emit('token',marker as never);d.emit(marker as never,'TOKEN_OK');
  expect(logs).toHaveLength(1);checkRedaction();
  expect(()=>diagnostic(()=>{throw Error(marker);}).emit('token','TOKEN_OK')).not.toThrow();
});
it('templates map the literal resource audience for both MCP clients, preserving owner client',async()=>{
  const realm=JSON.parse(await readFile('config/keycloak-realm.example.json','utf8'));
  for(const id of ['playdot-gary','playdot-friend']) {
    const client=realm.clients.find((x:{clientId:string})=>x.clientId===id);
    const mapper=client.protocolMappers.find((x:{name:string})=>x.name==='playdot-audience');
    expect(mapper.config).toEqual({'included.custom.audience':resource,'access.token.claim':'true','id.token.claim':'false'});
    expect(client.attributes['pkce.code.challenge.method']).toBe('S256');
    const subject=client.protocolMappers.filter((x:{protocolMapper:string})=>x.protocolMapper==='oidc-sub-mapper');
    expect(subject).toHaveLength(1);
    expect(subject[0].config).toEqual({'access.token.claim':'true','lightweight.claim':'true','introspection.token.claim':'true'});
    expect(client.protocolMappers.some((x:{protocolMapper:string})=>x.protocolMapper==='oidc-hardcoded-claim-mapper')).toBe(false);
  }
  expect(realm.clients.find((x:{clientId:string})=>x.clientId==='playdot-owner').protocolMappers).toBeUndefined();
});

it('collector rejects forged fields, arbitrary codes, raw errors and injected identifiers',()=>{
  const good = JSON.stringify({phase:'token',reason:'TOKEN_OK',correlation_id:'12345678-1234-4234-8234-123456789abc'});
  expect(sanitizedDiagnostic(good)).toBe(good);
  for(const value of [marker,JSON.stringify({...JSON.parse(good),token:marker}),JSON.stringify({...JSON.parse(good),reason:marker}),JSON.stringify({...JSON.parse(good),correlation_id:marker}),JSON.stringify({...JSON.parse(good),phase:'toString'}),JSON.stringify({...JSON.parse(good),phase:['token']}),'null']) expect(sanitizedDiagnostic(value)).toBeUndefined();
});

it('uses a fresh server correlation ID per request, never the supplied RPC/header IDs',async()=>{
  const first=await rpc('tools/list'); const second=await rpc('tools/list');
  const firstId=first.headers['x-playdot-correlation-id'],secondId=second.headers['x-playdot-correlation-id'];
  expect(firstId).not.toBe(secondId);expect(firstId).not.toBe(marker);
  expect(logs.slice(0,3).map(x=>JSON.parse(x).correlation_id)).toEqual([firstId,firstId,firstId]);
  checkRedaction();
});

it.each([
  ['application/xml', 'private body', 'HTTP_CONTENT_TYPE_REJECTED'],
  ['application/json', '', 'HTTP_BODY_EMPTY'],
  ['application/json', 'x'.repeat(33000), 'HTTP_BODY_TOO_LARGE']
])('classifies parser rejections without printing content: %s',async(contentType,payload,reason)=>{
  const r=await app.inject({method:'POST',url:'/mcp',headers:{'content-type':contentType},payload});
  expect(r.statusCode).toBeGreaterThanOrEqual(400);
  expect(logs.map(x=>JSON.parse(x).reason)).toContain(reason);
  checkRedaction();
});
