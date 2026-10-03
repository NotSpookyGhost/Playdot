import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from 'jose';
import { Fault, type Principal } from '../../../packages/domain/src/model.js';
import type { Phase, Reason } from './diagnostics.js';

export class AuthenticationFailure extends Fault {
  constructor(public phase: Phase, public reason: Reason) { super('UNAUTHORIZED', 401); }
}
export type Authenticate = (authorization: string | undefined) => Promise<Principal>;
export function jwtAuthenticator(options: { issuer: string; audience: string; keys: JWTVerifyGetKey; now?: () => number }): Authenticate {
  return async header => {
    if (!header?.startsWith('Bearer ')) throw new AuthenticationFailure('token', 'BEARER_REQUIRED');
    try {
      const { payload } = await jwtVerify(header.slice(7), async (...args) => {
        try { return await options.keys(...args); }
        catch (error) {
          throw new AuthenticationFailure('jwks', error instanceof errors.JWKSTimeout ? 'JWKS_TIMEOUT'
            : error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys || error instanceof errors.JWKSInvalid || error instanceof errors.JWKInvalid ? 'JWKS_KEY_UNAVAILABLE' : 'JWKS_FETCH_FAILED');
        }
      }, {
        issuer: options.issuer, audience: options.audience, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat'], currentDate: new Date((options.now ?? Date.now)())
      });
      const clientId = payload.azp ?? payload.client_id;
      if (typeof payload.sub !== 'string') throw new AuthenticationFailure('token', 'TOKEN_SUBJECT_INVALID');
      if (typeof clientId !== 'string' || !clientId) throw new AuthenticationFailure('token', 'TOKEN_CLIENT_INVALID');
      if (typeof payload.scope !== 'string') throw new AuthenticationFailure('token', 'TOKEN_SCOPE_INVALID');
      if (payload.azp && payload.client_id && payload.azp !== payload.client_id) throw new AuthenticationFailure('token', 'TOKEN_CLIENT_AMBIGUOUS');
      return { issuer: options.issuer, subject: payload.sub, clientId, scopes: payload.scope.split(' '), expiresAt: payload.exp! * 1000 };
    } catch (error) {
      if (error instanceof AuthenticationFailure) throw error;
      const reason = error instanceof errors.JWTExpired ? 'TOKEN_EXPIRED'
        : error instanceof errors.JWTClaimValidationFailed ? (error.claim === 'aud' ? 'TOKEN_AUDIENCE' : error.claim === 'iss' ? 'TOKEN_ISSUER' : error.claim === 'sub' ? 'TOKEN_SUBJECT_INVALID' : error.claim === 'iat' ? 'TOKEN_IAT_INVALID' : error.claim === 'exp' ? 'TOKEN_EXP_INVALID' : error.claim === 'nbf' ? 'TOKEN_NBF_INVALID' : 'TOKEN_CLAIMS')
        : error instanceof errors.JWSSignatureVerificationFailed ? 'TOKEN_SIGNATURE'
        : error instanceof errors.JOSEAlgNotAllowed ? 'TOKEN_ALGORITHM' : 'TOKEN_INVALID';
      throw new AuthenticationFailure('token', reason);
    }
  };
}
export function remoteAuthenticator(issuer: string, audience: string, jwks: string): Authenticate {
  for (const value of [issuer, audience, jwks]) if (new URL(value).protocol !== 'https:') throw new Error('OIDC URLs must use HTTPS');
  return jwtAuthenticator({ issuer, audience, keys: createRemoteJWKSet(new URL(jwks)) });
}
