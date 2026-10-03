import { it, expect } from 'vitest';
import * as oidc from 'openid-client';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { configuredOwnerLogin } from '../apps/server/src/owner.js';

it('validates signed OIDC responses, PKCE, issuer, audience, nonce, expiry and state',async()=>{
  const issuer='https://oidc.fixture.invalid';const clientId='owner-client';
  const pair=await generateKeyPair('RS256');const other=await generateKeyPair('RS256');
  const jwk={...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
  let overrides:Record<string,unknown>={};let wrongKey=false;let requests=0;
  const config=new oidc.Configuration({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],code_challenge_methods_supported:['S256']},clientId,{token_endpoint_auth_method:'none',id_token_signed_response_alg:'RS256'},oidc.None());
  config[oidc.customFetch]=async(url,init)=>{
    if(String(url).endsWith('/jwks'))return Response.json({keys:[jwk]});
    requests++;expect(String(init?.body)).toContain('code_verifier=');
    const now=Math.floor(Date.now()/1000);
    const jwt=await new SignJWT({iss:issuer,aud:clientId,sub:'owner-subject',iat:now,exp:now+300,nonce:'nonce',...overrides}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(wrongKey?other.privateKey:pair.privateKey);
    return Response.json({token_type:'Bearer',access_token:'ephemeral-fixture-only',id_token:jwt});
  };
  const login=configuredOwnerLogin(config,issuer,clientId,'https://playdot.fixture.invalid');
  const a={state:'state',nonce:'nonce',verifier:oidc.randomPKCECodeVerifier(),expiresAt:Date.now()+300000};
  const start=new URL(await login.begin(a));expect(start.searchParams.get('code_challenge_method')).toBe('S256');expect(start.searchParams.get('nonce')).toBe('nonce');
  const callback=()=>new URL('https://playdot.fixture.invalid/owner/callback?code=fixture&state=state');
  expect((await login.finish(callback(),a)).subject).toBe('owner-subject');
  for(const bad of [{iss:'https://wrong.invalid'},{aud:'mcp-client'},{nonce:'other'},{exp:1}]){overrides=bad;await expect(login.finish(callback(),a)).rejects.toThrow();}
  overrides={};wrongKey=true;await expect(login.finish(callback(),a)).rejects.toThrow();wrongKey=false;
  const before=requests;await expect(login.finish(new URL('https://playdot.fixture.invalid/owner/callback?code=fixture&state=wrong'),a)).rejects.toThrow();expect(requests).toBe(before);
});
