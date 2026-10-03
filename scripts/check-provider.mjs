// Read-only metadata check. No login, token issuance or credential creation.
const issuer=process.env.OIDC_ISSUER;
const resource=process.env.MCP_RESOURCE ?? 'https://playdot.bytedev.app/mcp';
async function get(url){if(new URL(url).protocol!=='https:')throw Error();const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();return r.json();}
try{
  if(!issuer||new URL(issuer).protocol!=='https:')throw Error();
  const d=await get(issuer.replace(/\/$/,'')+'/.well-known/openid-configuration');
  if(d.issuer!==issuer||!d.code_challenge_methods_supported?.includes('S256')||!d.id_token_signing_alg_values_supported?.includes('RS256'))throw Error();
  for(const field of ['authorization_endpoint','token_endpoint','jwks_uri'])if(new URL(d[field]).protocol!=='https:')throw Error();
  const keys=await get(d.jwks_uri);if(!keys.keys?.some(k=>k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256')))throw Error();
  const m=await get(new URL('/.well-known/oauth-protected-resource',resource));
  if(m.resource!==resource||!m.authorization_servers?.includes(issuer))throw Error();
  for(const scope of ['room:read','message:write','events:subscribe'])if(!m.scopes_supported?.includes(scope))throw Error();
  console.log('PASS: HTTPS metadata, issuer, S256, RS256 keys and protected resource. Issued-token audience/client/scopes, authenticated MCP discovery, account login and event support remain unverified.');
}catch{console.error('FAIL: provider/resource metadata unavailable or incompatible. No credentials were requested or printed.');process.exitCode=1;}
