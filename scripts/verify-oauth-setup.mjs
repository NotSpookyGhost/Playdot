// Operator-run public verification. Never invoked by local tests/build.
const origin = 'https://playdot.bytedev.app';
const issuer = 'https://playdot-auth.bytedev.app/realms/playdot';
const resource = origin + '/mcp';
const metadata = origin + '/.well-known/oauth-protected-resource';
async function request(path, options={}) {
  return fetch(origin+path,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
}
try {
  let r=await request('/health'); if(!r.ok)throw Error('health HTTP status');
  const h=await r.json();
  if(h.mode!=='oidc'||h.stage!=='0B-oauth-setup'||h.real_rooms_enabled!==false||h.events_enabled!==false||h.worker_enabled!==false||h.real_dot_verified!==false)throw Error('health is not safe OAuth setup mode');
  console.log('PASS: public health is OIDC setup, rooms/events/worker disabled, real-dot unverified');
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
    r=await request(path);if(!r.ok)throw Error('metadata HTTP status');const m=await r.json();
    if(m.resource!==resource||m.authorization_servers?.length!==1||m.authorization_servers[0]!==issuer)throw Error('metadata issuer/resource mismatch');
    console.log('PASS: '+path+' advertises the correct issuer and resource');
  }
  for(const method of ['GET','POST']){
    r=await request('/mcp',{method,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}:{})});
    if(r.status!==401||!r.headers.get('www-authenticate')?.includes('resource_metadata="'+metadata+'"'))throw Error('missing OAuth discovery challenge');
    console.log('PASS: unauthenticated '+method+' /mcp returns 401 and OAuth discovery challenge');
  }
}catch(e){console.error('FAIL: '+(e instanceof Error?e.message:'verification failed'));process.exitCode=1;}
