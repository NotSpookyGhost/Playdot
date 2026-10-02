import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Fault, type Principal } from '../../../packages/domain/src/model.js';

export type Authenticate = (authorization: string | undefined) => Promise<Principal>;
export function jwtAuthenticator(options: { issuer: string; audience: string; keys: JWTVerifyGetKey; now?: () => number }): Authenticate {
  return async header => {
    if (!header?.startsWith('Bearer ')) throw new Fault('UNAUTHORIZED', 401);
    try {
      const { payload } = await jwtVerify(header.slice(7), options.keys, {
        issuer: options.issuer, audience: options.audience, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat'], currentDate: new Date((options.now ?? Date.now)())
      });
      // Both subject and OAuth client are validated claims, never request arguments.
      const clientId = payload.azp ?? payload.client_id;
      if (typeof payload.sub !== 'string' || typeof clientId !== 'string' || !clientId || typeof payload.scope !== 'string') throw new Error('Missing claims');
      if (payload.azp && payload.client_id && payload.azp !== payload.client_id) throw new Error('Ambiguous client');
      return { issuer: options.issuer, subject: payload.sub, clientId, scopes: payload.scope.split(' '), expiresAt: payload.exp! * 1000 };
    } catch { throw new Fault('UNAUTHORIZED', 401); }
  };
}
export function remoteAuthenticator(issuer: string, audience: string, jwks: string): Authenticate {
  for (const value of [issuer, audience, jwks]) if (new URL(value).protocol !== 'https:') throw new Error('OIDC URLs must use HTTPS');
  return jwtAuthenticator({ issuer, audience, keys: createRemoteJWKSet(new URL(jwks)) });
}
