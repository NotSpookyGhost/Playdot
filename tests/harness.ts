import { PGlite } from '@electric-sql/pglite';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Webhook } from 'standardwebhooks';
import { createStore } from '../packages/db/src/store.js';
import { Playdot } from '../packages/domain/src/service.js';
import { callbacks, secretBox, type Post } from '../apps/server/src/callback.js';
import { jwtAuthenticator } from '../apps/server/src/auth.js';
import { buildApp } from '../apps/server/src/app.js';
import { fixtureClient, fixtureIssuer, fixtureResource, localControls } from '../scripts/local-controls.js';
import { scopes } from '../packages/contracts/src/index.js';
import { MockModeration } from './mock-moderation.js';
import type { ModerationAdapter } from '../packages/domain/src/moderation.js';

export const fixtureSecret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
// This known-public signing fixture is accepted ONLY by the injected test receiver.
export async function harness(options: { moderator?: ModerationAdapter } = {}) {
  const db = new PGlite();
  const store = await createStore({ transaction: fn => db.transaction(sql => fn(sql)), close: () => db.close() });
  let time = Date.now(); const now = () => time;
  const secrets = secretBox(Buffer.alloc(32, 11));
  const controls = localControls(store, now, secrets); await controls.seed();
  // Ephemeral test keypair: never saved or used for any account/provider.
  const keys = await generateKeyPair('RS256'); const jwk = await exportJWK(keys.publicKey); jwk.kid = 'local-test';
  const authenticate = jwtAuthenticator({ issuer: fixtureIssuer, audience: fixtureResource, keys: createLocalJWKSet({ keys: [jwk] }), now });
  const events: { url: string; data: Record<string, any>; headers: Record<string, string> }[] = [];
  let responseStatus = 204; let challengeMatches = true;
  const post: Post = async (url, body, headers) => {
    const data = new Webhook(fixtureSecret).verify(body, headers) as Record<string, any>;
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: challengeMatches ? data.challenge : 'wrong' }) };
    events.push({ url, data, headers }); return { status: responseStatus, body: '' };
  };
  const moderation = new MockModeration();
  const service = new Playdot(store, callbacks(post), secrets, now, options.moderator ?? moderation);
  const app = buildApp({ service, authenticate, resource: fixtureResource, issuer: fixtureIssuer });
  async function token(subject = 'subject-a', overrides: Record<string, unknown> = {}) {
    return new SignJWT({ azp: fixtureClient, scope: scopes.join(' '), iss: fixtureIssuer, aud: fixtureResource, sub: subject, iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'local-test' }).sign(keys.privateKey);
  }
  const tokenA = await token(); const tokenB = await token('subject-b');
  const a = await authenticate(`Bearer ${tokenA}`); const b = await authenticate(`Bearer ${tokenB}`);
  async function rpc(token: string, method: string, params: unknown = {}) {
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method, params } });
    return { status: response.statusCode, body: response.json(), headers: response.headers };
  }
  const subscribe = (roomId = 'shared') => ({ name: 'room.message.created', arguments: { room_id: roomId, exclude_self: true }, delivery: { mode: 'webhook', url: 'https://receiver.playdot.invalid/events', secret: fixtureSecret }, cursor: null });
  return { store, service, controls, app, a, b, token, tokenA, tokenB, authenticate, rpc, subscribe, events, moderation, advance: (ms: number) => { time += ms; }, setStatus: (status: number) => { responseStatus = status; }, wrongChallenge: () => { challengeMatches = false; }, now,
    close: async () => { await app.close(); await store.close(); } };
}
