import { randomBytes, createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Fault } from '../../../packages/domain/src/model.js';
import type { Human, Pilot } from '../../../packages/domain/src/pilot.js';

export type LoginAttempt = { state: string; nonce: string; verifier: string; expiresAt: number };
export interface OwnerLogin {
  begin(attempt: LoginAttempt): Promise<string>;
  finish(url: URL, attempt: LoginAttempt): Promise<Human>;
}
export async function ownerLogin(issuer: string, clientId: string, origin: string): Promise<OwnerLogin> {
  if (new URL(issuer).protocol !== 'https:' || new URL(origin).protocol !== 'https:') throw new Error('Owner login requires HTTPS');
  const config = await oidc.discovery(new URL(issuer), clientId, { token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'RS256' }, oidc.None(), { timeout: 10 });
  return configuredOwnerLogin(config, issuer, clientId, origin);
}
export function configuredOwnerLogin(config: oidc.Configuration, issuer: string, clientId: string, origin: string): OwnerLogin {
  if (!config.serverMetadata().supportsPKCE()) throw new Error('OIDC provider must advertise S256');
  oidc.enableNonRepudiationChecks(config);
  return {
    async begin(a) {
      return oidc.buildAuthorizationUrl(config, { redirect_uri: origin + '/owner/callback', scope: 'openid', response_type: 'code', code_challenge: await oidc.calculatePKCECodeChallenge(a.verifier), code_challenge_method: 'S256', state: a.state, nonce: a.nonce, prompt: 'login', max_age: '0' }).href;
    },
    async finish(url, a) {
      const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: a.verifier, expectedState: a.state, expectedNonce: a.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub || !claims.exp || claims.iss !== issuer) throw new Fault('HUMAN_AUTH_REQUIRED', 401);
      return { issuer, clientId, subject: claims.sub, expiresAt: Math.min(claims.exp * 1000, Date.now() + 10 * 60000) };
    }
  };
}
const esc = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cookie = (name: string, value: string, age: number) => name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age;
function cookieValue(header: string | undefined, name: string) {
  const values = (header ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : '';
}
export function registerOwner(app: FastifyInstance, options: { pilot: Pilot; login: OwnerLogin; origin: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, LoginAttempt>();
  const sessions = new Map<string, { human: Human; csrf: string }>();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    const params = new URLSearchParams(body as string);
    if (new Set(params.keys()).size !== [...params.keys()].length) return done(new Error('Duplicate fields'));
    done(null, Object.fromEntries(params));
  });
  function session(header?: string) {
    const s = sessions.get(digest(cookieValue(header, '__Host-playdot-owner')));
    if (!s || s.human.expiresAt <= now()) throw new Fault('HUMAN_AUTH_REQUIRED', 401);
    options.pilot.owner(s.human); return s;
  }
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/owner')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('Referrer-Policy', 'no-referrer'); reply.header('X-Content-Type-Options', 'nosniff');
    for (const [key, a] of attempts) if (a.expiresAt <= now()) attempts.delete(key);
    for (const [key, s] of sessions) if (s.human.expiresAt <= now()) sessions.delete(key);
  });
  app.get('/owner/login', async (_req, reply) => {
    if (attempts.size >= 128) return reply.code(429).send({ code: 'LOGIN_CAPACITY' });
    const id = token(); const a = { state: token(), nonce: token(), verifier: oidc.randomPKCECodeVerifier(), expiresAt: now() + 5 * 60000 };
    attempts.set(digest(id), a);
    try { return reply.header('Set-Cookie', cookie('__Host-playdot-login', id, 300)).redirect(await options.login.begin(a)); }
    catch { attempts.delete(digest(id)); return reply.code(503).send({ code: 'LOGIN_UNAVAILABLE' }); }
  });
  app.get('/owner/callback', async (req, reply) => {
    const key = digest(cookieValue(req.headers.cookie, '__Host-playdot-login')); const a = attempts.get(key); attempts.delete(key);
    reply.header('Set-Cookie', cookie('__Host-playdot-login', '', 0));
    try {
      const url = new URL(req.url, options.origin);
      if (!a || a.expiresAt <= now() || url.searchParams.get('state') !== a.state || sessions.size >= 32) throw new Error('Invalid login');
      const human = await options.login.finish(url, a); options.pilot.owner(human);
      const id = token(); sessions.set(digest(id), { human, csrf: token() });
      reply.header('Set-Cookie', [cookie('__Host-playdot-login', '', 0), cookie('__Host-playdot-owner', id, Math.max(0, Math.floor((human.expiresAt - now()) / 1000)))]);
      return reply.redirect('/owner');
    } catch { return reply.code(401).send({ code: 'HUMAN_AUTH_REQUIRED' }); }
  });
  app.get('/owner', async (req, reply) => {
    try {
      const s = session(req.headers.cookie); const d = await options.pilot.dashboard(s.human);
      const form = (action: string, label: string, fields: Record<string, string> = {}) => '<form method="post" action="/owner/action"><input type="hidden" name="csrf" value="' + esc(s.csrf) + '"><input type="hidden" name="action" value="' + esc(action) + '">' + Object.entries(fields).map(([k,v]) => '<input type="hidden" name="' + esc(k) + '" value="' + esc(v) + '">').join('') + '<button>' + esc(label) + '</button></form>';
      const reviews = d.reviews.map(r => '<section><h2>Untrusted proposal: ' + esc(r.outcome) + '</h2><p>Audience: ' + esc(r.audience.join(', ')) + '</p><pre>' + esc(JSON.stringify(r.request, null, 2)) + '</pre><p>Expires: ' + esc(new Date(r.expiresAt).toISOString()) + '</p>' + (r.outcome === 'human_review' ? form('approve', 'Approve this exact proposal', { id:r.id, hash:r.hash, contextHash:r.contextHash }) + form('reject', 'Reject', { id:r.id, hash:r.hash, contextHash:r.contextHash }) : form('publish', 'Publish the approved dot proposal', { id:r.id })) + '</section>').join('');
      return reply.type('text/html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Playdot owner controls</title><h1>Stage 0B owner controls</h1><p>Signed in as ' + esc(d.owner) + '. Human approval is required for every message. Treat proposals as untrusted text.</p><p>Topic: ' + esc(d.topic) + '</p><p>Audience: ' + esc(d.audience.join(', ')) + '</p><p>15 minutes; 5 messages per dot; 10 total; 10-second cooldown. Review expiry: 10 minutes. Shared content cannot be recalled.</p><pre>' + esc(JSON.stringify(d.room?.session, null, 2)) + '</pre><p>Owner consents: ' + d.consents + '/2</p>' + form('consent', 'Approve my connection, audience and this bounded session', { configHash: d.configHash, sessionId: d.room!.session.id }) + form('pause', 'Pause both test rooms') + '<p>Delivery hold: ' + d.deliveryHold + '</p>' + form('hold-delivery', 'Hold delivery for the approved revocation check') + form('release-delivery', 'Release delivery (all permissions rechecked)') + form('revoke', 'Permanently revoke my dot connection') + form('new-session', 'Prepare a fresh session (requires pause and both owners to consent again)') + '<h2>Approved shared context (untrusted)</h2><pre>' + esc(JSON.stringify(d.context,null,2)) + '</pre>' + reviews + '<p><a href="/owner/evidence">Download sanitized server evidence</a></p>' + form('logout', 'Sign out') + '</html>');
    } catch (e) { return reply.code(e instanceof Fault ? e.status : 500).send({ code: e instanceof Fault ? e.code : 'OWNER_UNAVAILABLE' }); }
  });
  app.post('/owner/action', async (req, reply) => {
    try {
      if (req.headers.origin !== options.origin) throw new Fault('ORIGIN_NOT_ALLOWED');
      const s = session(req.headers.cookie);
      const b = z.strictObject({ csrf: z.string(), action: z.enum(['consent','pause','revoke','new-session','approve','reject','publish','logout','hold-delivery','release-delivery']), configHash:z.string().optional(), sessionId:z.string().optional(), id:z.string().optional(), hash:z.string().optional(), contextHash:z.string().optional() }).parse(req.body);
      if (b.csrf !== s.csrf) throw new Fault('CSRF_REJECTED');
      switch (b.action) {
        case 'consent': await options.pilot.consent(s.human, b.configHash ?? '', b.sessionId ?? ''); break;
        case 'hold-delivery': await options.pilot.deliveryHold(s.human,true); break;
        case 'release-delivery': await options.pilot.deliveryHold(s.human,false); break;
        case 'pause': await options.pilot.pause(s.human); break;
        case 'revoke': await options.pilot.revoke(s.human); break;
        case 'new-session': await options.pilot.newSession(s.human); break;
        case 'approve': case 'reject': await options.pilot.decide(s.human,b.id ?? '',b.hash ?? '',b.contextHash ?? '',b.action); break;
        case 'publish': await options.pilot.publish(s.human,b.id ?? ''); break;
        case 'logout': sessions.delete(digest(cookieValue(req.headers.cookie,'__Host-playdot-owner'))); return reply.header('Set-Cookie',cookie('__Host-playdot-owner','',0)).code(303).redirect('/owner/login');
      }
      return reply.code(303).redirect('/owner');
    } catch (e) { return reply.code(e instanceof Fault ? e.status : 400).send({ code: e instanceof Fault ? e.code : 'INVALID_OWNER_ACTION' }); }
  });
  app.get('/owner/evidence', async (req,reply) => {
    try { const s=session(req.headers.cookie); return reply.header('Content-Disposition','attachment; filename="playdot-server-evidence.json"').send(await options.pilot.evidence(s.human)); }
    catch { return reply.code(401).send({ code:'HUMAN_AUTH_REQUIRED' }); }
  });
}
