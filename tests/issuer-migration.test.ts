import { randomUUID } from 'node:crypto';
import { readFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { it,expect } from 'vitest';
import { Pilot,pilotSchema } from '../packages/domain/src/pilot.js';
import { emptyState } from '../packages/domain/src/model.js';
import { oldIssuer,newIssuer,migrateIssuer,stateDigest,applyIssuerMigration,rollbackIssuerMigration } from '../packages/domain/src/issuer-migration.js';
import { secretBox } from '../apps/server/src/callback.js';
import { Playdot } from '../packages/domain/src/service.js';
async function fixture(){
  const state=emptyState();const store={transact:async<T>(fn:(s:typeof state)=>T|Promise<T>)=>fn(state),close:async()=>{}};
  const config=pilotSchema.parse({issuer:oldIssuer,ownerClientId:'owner',roomId:'shared',privateRoomId:'private',topic:'Invent a friendly name and one-sentence description for a fictional garden robot. No links, personal data or external actions.',owners:[{id:'a',subject:'a',connectionId:'a',mcpClientId:'playdot-gary',label:'A'},{id:'b',subject:'b',connectionId:'b',mcpClientId:'playdot-friend',label:'B'}]});
  const secrets=secretBox(Buffer.alloc(32,11));const service=new Playdot(store,{verify:async()=>{},send:async()=>204},secrets);const pilot=new Pilot(store,config,secrets,service);await pilot.initialize();
  for(const o of config.owners)await pilot.consent({issuer:oldIssuer,subject:o.subject,clientId:'owner',expiresAt:Date.now()+10000},pilot.configHash,state.rooms[0]!.session.id);
  state.connections[1]!.active=false;state.connections[1]!.suspended=true;
  state.subscriptions.push({id:'sub',connectionId:'a',roomId:'shared',url:'https://fixture.invalid',secret:'encrypted-fixture',expiresAt:9999999999999,tokenExpiresAt:9999999999999,active:true});
  state.outbox.push({id:'delivery',eventId:'event',subscriptionId:'sub',state:'queued',attempts:0,nextAt:0});
  return {state,config,store};
}
it('migrates only the issuer, retaining revoked/suspended state and closing consent and delivery gates',async()=>{
  const {state,config}=await fixture();const prior=structuredClone(state);
  expect(migrateIssuer(state,{...config,issuer:newIssuer})).toBe('MIGRATED_PAUSED');
  expect(state.connections.map(c=>c.issuer)).toEqual([newIssuer,newIssuer]);expect(state.connections[1]).toMatchObject({active:false,suspended:true});
  expect(state.grants).toEqual(prior.grants);expect(state.memberships).toEqual(prior.memberships);expect(state.messages).toEqual(prior.messages);
  expect(state.pilot?.consents).toEqual([]);expect(state.pilot?.deliveryHold).toBe(true);expect(state.rooms.every(r=>r.session.state==='paused')).toBe(true);
  expect(state.subscriptions[0]?.active).toBe(false);expect(state.outbox[0]?.state).toBe('cancelled');
  expect(migrateIssuer(state,{...config,issuer:newIssuer})).toBe('ALREADY_CURRENT');
});
it('refuses unrelated owner/config changes and does not initialize an absent pilot',async()=>{
  const {state,config}=await fixture();const next={...config,issuer:newIssuer};
  expect(()=>migrateIssuer(structuredClone(state),{...next,roomId:'other'})).toThrow();
  expect(migrateIssuer(emptyState(),next)).toBe('NO_PILOT');
});
it('rollback fingerprints ignore database JSON object key ordering but detect state changes',()=>{
  expect(stateDigest({a:1,b:{c:2,d:3}})).toBe(stateDigest({b:{d:3,c:2},a:1}));
  expect(stateDigest({a:1})).not.toBe(stateDigest({a:2}));
});

it('writes a backup before applying and permits rollback only before further state changes',async()=>{
  const {state,store,config}=await fixture();const before=structuredClone(state);const next={...config,issuer:newIssuer};
  const path=resolve(tmpdir(),'playdot-issuer-test-'+randomUUID()+'.json');
  try {
    expect(await applyIssuerMigration(store,next,undefined,true)).toBe('MIGRATED_PAUSED');expect(state).toEqual(before);
    expect(await applyIssuerMigration(store,next,path)).toBe('MIGRATED_PAUSED');
    const raw=await readFile(path,'utf8');const backup=JSON.parse(raw);expect(backup.before).toEqual(before);
    const fresh=await fixture();await expect(applyIssuerMigration(fresh.store,next,path)).rejects.toThrow();expect(await readFile(path,'utf8')).toBe(raw);expect(fresh.state.pilot?.configHash).toBe(before.pilot?.configHash);
    state.audit.push({action:'later-change',target:'shared',at:1});await expect(rollbackIssuerMigration(store,backup)).rejects.toThrow();state.audit.pop();
    expect(await rollbackIssuerMigration(store,backup)).toBe('ROLLED_BACK');expect(state).toEqual(before);
  }finally{await unlink(path).catch(()=>{});}
});
